//! Smart routing module: classifies each user request into a complexity tier
//! (R0-R3, ported from the rwkv-router project) and resolves the model to use.
//!
//! Pipeline: rule short-circuit (trivial ack) -> RWKV local classification
//! -> post-processing rule stack (safety upgrade / sticky tier) -> tier-to-model
//! mapping from `AIConfig.router`.

pub mod head;
pub mod postprocess;
pub mod rules;
pub mod summary;
pub mod tier;

pub use postprocess::{
    fallback_decision, postprocess, softmax, trivial_ack_decision, DecisionSource, RoutingDecision,
};
pub use rules::{is_short_message, is_trivial_ack};
pub use tier::RouteClass;

use crate::service::config::RouterConfig;
use ai00_x_ai_adapters::providers::rwkv::engine::get_rwkv_engine;
use log::{debug, info, warn};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Upper bound on tracked sticky-tier sessions (oldest evicted when exceeded).
const STICKY_TABLE_LIMIT: usize = 1024;

/// Smart router: per-session sticky tier state + classification pipeline.
pub struct SmartRouter {
    /// session_id -> tier of the previous routed turn.
    sticky_tiers: Mutex<HashMap<String, RouteClass>>,
    /// Insertion order for LRU eviction (oldest first).
    sticky_order: Mutex<VecDeque<String>>,
}

impl Default for SmartRouter {
    fn default() -> Self {
        Self::new()
    }
}

impl SmartRouter {
    pub fn new() -> Self {
        Self {
            sticky_tiers: Mutex::new(HashMap::new()),
            sticky_order: Mutex::new(VecDeque::new()),
        }
    }

    /// Classifies the request and produces a routing decision.
    ///
    /// 1. Trivial-ack short circuit (rules only, zero cost) -> R0.
    /// 2. RWKV local model classification (mean-hidden state embedding +
    ///    trained MLP head, ported from the rwkv-router paper path), with
    ///    the session's rolling summary prepended for context awareness.
    /// 3. Post-processing rule stack (safety upgrade / sticky tier).
    ///
    /// Classification failures (engine/head not loaded, timeout, inference
    /// error) degrade gracefully to a fallback decision.
    pub async fn route(
        &self,
        session_id: &str,
        user_input: &str,
        summary: Option<&str>,
        turn_index: usize,
        config: &RouterConfig,
    ) -> RoutingDecision {
        // 1. Trivial-ack short circuit. Does NOT touch the sticky table:
        // an acknowledgment mid-task must not reset the session's tier
        // floor (e.g. "ok" inside an R3 session, followed by "继续",
        // should stay sticky-lifted to R3).
        if is_trivial_ack(user_input) {
            let decision = trivial_ack_decision();
            info!(
                "[SmartRouter] trivial-ack short circuit: session={}, tier=R0",
                session_id
            );
            return decision;
        }

        // 2. Model classification (state embedding + trained MLP head).
        let raw = match self.classify(user_input, summary, config).await {
            Ok(decision) => decision,
            Err(e) => {
                warn!(
                    "[SmartRouter] classification unavailable, falling back: session={}, error={}",
                    session_id, e
                );
                // Fallback has no tier semantics — leave the sticky table
                // untouched so a transient failure cannot drag the floor down.
                return fallback_decision();
            }
        };

        // 3. Post-processing rule stack (safety upgrade + sticky tier).
        let prev_tier = self.previous_tier(session_id);
        let is_short = is_short_message(user_input);
        let decision = postprocess(&raw.probabilities, prev_tier, is_short, config);
        if decision.source == DecisionSource::Model {
            debug!(
                "[SmartRouter] decision: session={}, turn={}, route={}, confidence={:.3}, \
                 safety_applied={}, sticky_applied={}",
                session_id,
                turn_index,
                decision.route,
                decision.confidence,
                decision.safety_applied,
                decision.sticky_applied
            );
        }

        self.remember_tier(session_id, decision.route);
        decision
    }

    /// Resolves the model reference for a routing decision.
    /// Returns the fallback reference when the decision is not model-backed.
    pub fn resolve_model_ref(decision: &RoutingDecision, config: &RouterConfig) -> String {
        match decision.source {
            DecisionSource::Model => config.tier_models.model_for(&decision.route).to_string(),
            DecisionSource::TrivialAck => config.tier_models.model_for(&decision.route).to_string(),
            DecisionSource::Fallback => config.fallback.clone(),
        }
    }

    /// Stateless preview of the routing pipeline for a single request:
    /// same rules + classification + post-processing as [`route`], but the
    /// sticky table is neither read nor written. Used by the settings-page
    /// test entry so manual tests cannot pollute live session state.
    pub async fn route_preview(
        &self,
        user_input: &str,
        summary: Option<&str>,
        config: &RouterConfig,
    ) -> RoutingDecision {
        if is_trivial_ack(user_input) {
            return trivial_ack_decision();
        }
        let raw = match self.classify(user_input, summary, config).await {
            Ok(decision) => decision,
            Err(e) => {
                warn!("[SmartRouter] preview classification failed: {}", e);
                return fallback_decision();
            }
        };
        postprocess(
            &raw.probabilities,
            None,
            is_short_message(user_input),
            config,
        )
    }

    /// Builds the classifier input: summary + request when a session summary
    /// exists, bare request otherwise (both are trained distributions).
    pub fn build_classify_input(user_input: &str, summary: Option<&str>) -> String {
        match summary {
            Some(s) if !s.trim().is_empty() => {
                format!("Summary: {}\nRequest: {}", s.trim(), user_input)
            }
            _ => user_input.to_string(),
        }
    }

    /// Runs RWKV classification on the request: the desktop engine extracts the
    /// mean-pooled last-layer hidden state (state embedding) and scores it with
    /// the trained MLP head (`router_head.json`), returning four tier
    /// probabilities (R0-R3).
    async fn classify(
        &self,
        user_input: &str,
        summary: Option<&str>,
        config: &RouterConfig,
    ) -> Result<RoutingDecision, String> {
        let engine = get_rwkv_engine().ok_or("rwkv engine not registered")?;
        if !engine.is_initialized() {
            return Err("rwkv engine not initialized".to_string());
        }

        let classify_input = Self::build_classify_input(user_input, summary);
        let probs = tokio::time::timeout(
            Duration::from_millis(config.timeout_ms.max(100)),
            engine.classify(classify_input),
        )
        .await
        .map_err(|_| "classify timed out".to_string())??;

        if probs.len() != 4 {
            return Err(format!(
                "classify returned {} probabilities, expected 4",
                probs.len()
            ));
        }

        let probabilities = [probs[0], probs[1], probs[2], probs[3]];
        Ok(RoutingDecision {
            route: RouteClass::R1, // Placeholder; postprocess computes the final route.
            confidence: 0.0,
            probabilities,
            margin: 0.0,
            sticky_applied: false,
            safety_applied: false,
            source: DecisionSource::Model,
        })
    }

    fn previous_tier(&self, session_id: &str) -> Option<RouteClass> {
        let table = self.sticky_tiers.lock().unwrap_or_else(|e| e.into_inner());
        table.get(session_id).copied()
    }

    fn remember_tier(&self, session_id: &str, tier: RouteClass) {
        let mut table = self.sticky_tiers.lock().unwrap_or_else(|e| e.into_inner());
        let mut order = self.sticky_order.lock().unwrap_or_else(|e| e.into_inner());
        if table.contains_key(session_id) {
            // Refresh recency: move the session to the back (most recent).
            order.retain(|k| k != session_id);
        } else {
            // Evict the oldest sessions (LRU) instead of clearing everything.
            while table.len() >= STICKY_TABLE_LIMIT {
                match order.pop_front() {
                    Some(key) => {
                        table.remove(&key);
                    }
                    None => break,
                }
            }
        }
        order.push_back(session_id.to_string());
        table.insert(session_id.to_string(), tier);
    }
}

static GLOBAL_SMART_ROUTER: OnceLock<SmartRouter> = OnceLock::new();

/// Returns the global smart router singleton.
pub fn get_smart_router() -> &'static SmartRouter {
    GLOBAL_SMART_ROUTER.get_or_init(SmartRouter::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> RouterConfig {
        RouterConfig::default()
    }

    #[tokio::test]
    async fn trivial_ack_routes_to_r0_without_model() {
        let router = SmartRouter::new();
        let decision = router.route("s1", "thanks", None, 0, &config()).await;
        assert_eq!(decision.route, RouteClass::R0);
        assert_eq!(decision.source, DecisionSource::TrivialAck);
    }

    #[tokio::test]
    async fn non_trivial_falls_back_when_engine_unavailable() {
        // No engine registered in unit tests -> classification must degrade
        // to the fallback decision instead of panicking.
        let router = SmartRouter::new();
        let decision = router
            .route(
                "s1",
                "help me debug this traceback: ...",
                None,
                0,
                &config(),
            )
            .await;
        assert_eq!(decision.source, DecisionSource::Fallback);
    }

    #[tokio::test]
    async fn trivial_ack_does_not_pollute_sticky_table() {
        let router = SmartRouter::new();
        // Trivial ack routes to R0 but must NOT be remembered — otherwise an
        // "ok" mid-task resets the sticky floor and later short messages
        // ("继续") would no longer be lifted back to the task's tier.
        router.route("s1", "ok", None, 0, &config()).await;
        assert_eq!(router.previous_tier("s1"), None);
    }

    #[tokio::test]
    async fn fallback_does_not_pollute_sticky_table() {
        let router = SmartRouter::new();
        // Engine unavailable -> fallback decision; sticky table stays empty.
        let d1 = router
            .route("s1", "help me debug this", None, 0, &config())
            .await;
        assert_eq!(d1.source, DecisionSource::Fallback);
        let d2 = router
            .route("s1", "another request", None, 1, &config())
            .await;
        assert_eq!(d2.source, DecisionSource::Fallback);
        assert_eq!(router.previous_tier("s1"), None);
    }

    #[tokio::test]
    async fn trivial_ack_keeps_existing_sticky_tier() {
        let router = SmartRouter::new();
        // Simulate a remembered R3 tier, then a trivial ack: the floor must
        // survive the acknowledgment.
        router.remember_tier("s3", RouteClass::R3);
        let decision = router.route("s3", "ok", None, 1, &config()).await;
        assert_eq!(decision.route, RouteClass::R0);
        assert_eq!(decision.source, DecisionSource::TrivialAck);
        assert_eq!(router.previous_tier("s3"), Some(RouteClass::R3));
    }

    #[tokio::test]
    async fn sticky_tier_remembered_across_turns() {
        let router = SmartRouter::new();
        // Turn 1: trivial ack -> R0 remembered.
        router.route("s2", "ok", None, 0, &config()).await;
        assert_eq!(router.previous_tier("s2"), None);
        // Different session is independent.
        assert_eq!(router.previous_tier("other"), None);
    }

    #[test]
    fn classify_input_formats() {
        // Bare request (no summary) matches the legacy distribution.
        assert_eq!(
            SmartRouter::build_classify_input("fix this bug", None),
            "fix this bug"
        );
        assert_eq!(
            SmartRouter::build_classify_input("fix this bug", Some("   ")),
            "fix this bug"
        );
        // Summary + request uses the trained two-segment format.
        assert_eq!(
            SmartRouter::build_classify_input("改成中文", Some("Translating docs to English")),
            "Summary: Translating docs to English\nRequest: 改成中文"
        );
    }

    #[test]
    fn sticky_table_evicts_oldest_not_all() {
        let router = SmartRouter::new();
        // Fill to the limit: s0..s1023 (s0 is the oldest).
        for i in 0..STICKY_TABLE_LIMIT {
            router.remember_tier(&format!("s{i}"), RouteClass::R1);
        }
        // One more session evicts only the oldest (s0), not everything.
        router.remember_tier("s_new", RouteClass::R2);
        assert_eq!(router.previous_tier("s0"), None);
        assert_eq!(router.previous_tier("s1"), Some(RouteClass::R1));
        assert_eq!(router.previous_tier("s1023"), Some(RouteClass::R1));
        assert_eq!(router.previous_tier("s_new"), Some(RouteClass::R2));
    }

    #[test]
    fn sticky_table_refreshes_recency_on_update() {
        let router = SmartRouter::new();
        // Fill exactly to the limit: s0..s1023 (no eviction yet).
        for i in 0..STICKY_TABLE_LIMIT {
            router.remember_tier(&format!("s{i}"), RouteClass::R1);
        }
        // Touch s0 again — it becomes most recent and must survive eviction.
        router.remember_tier("s0", RouteClass::R3);
        router.remember_tier("s_extra", RouteClass::R2);
        assert_eq!(router.previous_tier("s0"), Some(RouteClass::R3));
        assert_eq!(router.previous_tier("s1"), None); // oldest evicted instead
        assert_eq!(router.previous_tier("s_extra"), Some(RouteClass::R2));
    }

    #[test]
    fn resolve_model_ref_uses_tier_mapping() {
        let decision = RoutingDecision {
            route: RouteClass::R3,
            confidence: 0.9,
            probabilities: [0.0, 0.05, 0.05, 0.9],
            margin: 0.85,
            sticky_applied: false,
            safety_applied: false,
            source: DecisionSource::Model,
        };
        let cfg = config();
        assert_eq!(SmartRouter::resolve_model_ref(&decision, &cfg), "primary");

        let fb = fallback_decision();
        assert_eq!(SmartRouter::resolve_model_ref(&fb, &cfg), "primary");
    }
}
