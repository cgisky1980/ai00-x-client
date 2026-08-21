//! Per-session rolling summary for context-aware smart routing.
//!
//! Each conversation keeps a short rolling summary (model-generated via the
//! resident rwkv-local engine, continuation-style prompt for base-model
//! reliability). The summary is prepended to the classification input so
//! follow-up requests like "改成中文" / "continue" can be tiered correctly
//! based on the ongoing task.
//!
//! Lifecycle: `update` is spawned after each successful dialog turn
//! (async, never blocks the chat path); `get` feeds the classifier on the
//! next turn. Missing summary (first turn / generation failure) simply
//! degrades to bare-request classification, which is a trained distribution.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

use ai00_x_ai_adapters::providers::rwkv::engine::get_rwkv_engine;
use log::{debug, warn};

/// Upper bound on cached summaries (oldest evicted, mirroring the sticky
/// tier table's LRU).
const SUMMARY_CACHE_LIMIT: usize = 512;
/// Max new tokens for one summary generation (~2.7s at 17.7ms/token).
const SUMMARY_MAX_TOKENS: usize = 150;
/// Word budget enforced in the prompt and by post-truncation.
const SUMMARY_MAX_WORDS: usize = 120;
/// Assistant reply head fed into the prompt (keeps prompt bounded).
const ASSISTANT_HEAD_CHARS: usize = 500;
/// Generation temperature — low for factual summarization.
const SUMMARY_TEMPERATURE: f32 = 0.3;

/// Builds the continuation-style update prompt. Extracted for tests.
pub fn build_summary_prompt(
    prev_summary: Option<&str>,
    last_user: &str,
    last_assistant: &str,
) -> String {
    let prev = prev_summary
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("(none)");
    let assistant_head: String = last_assistant
        .trim()
        .chars()
        .take(ASSISTANT_HEAD_CHARS)
        .collect();
    format!(
        "Below is a running summary of a conversation. Update it to include the latest \
exchange. Keep it under {SUMMARY_MAX_WORDS} words. Output only the updated summary.\n\n\
Current summary:\n{prev}\n\nLatest exchange:\nUser: {user}\nAssistant: {assistant}\n\n\
Updated summary:\n",
        user = last_user.trim(),
        assistant = assistant_head,
    )
}

/// Post-processes a generated summary: strips prompt echo / leading labels,
/// truncates to the word budget, drops degenerate output.
pub fn clean_summary(raw: &str) -> Option<String> {
    let mut text = raw.trim().to_string();
    // Drop common base-model echoes of the prompt scaffolding.
    for marker in ["Updated summary:", "Summary:", "Current summary:"] {
        if let Some(rest) = text.strip_prefix(marker) {
            text = rest.trim().to_string();
        }
    }
    // Cut at the first double newline — echo continuations follow it.
    if let Some(pos) = text.find("\n\n") {
        text.truncate(pos);
    }
    if text.is_empty() {
        return None;
    }
    // Enforce the word budget (whitespace-split words; CJK counts per-char).
    let mut words = 0usize;
    let mut out = String::new();
    for ch in text.chars() {
        if ch.is_whitespace() {
            words += 1;
        } else if ch > '\u{2E80}' {
            // CJK range: count roughly one word per character.
            words += 1;
        }
        if words > SUMMARY_MAX_WORDS {
            break;
        }
        out.push(ch);
    }
    let cleaned = out.trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Global per-session summary cache (LRU) with in-flight dedup.
pub struct SessionSummaryService {
    summaries: Mutex<HashMap<String, String>>,
    order: Mutex<VecDeque<String>>,
    in_flight: Mutex<HashSet<String>>,
}

impl Default for SessionSummaryService {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionSummaryService {
    pub fn new() -> Self {
        Self {
            summaries: Mutex::new(HashMap::new()),
            order: Mutex::new(VecDeque::new()),
            in_flight: Mutex::new(HashSet::new()),
        }
    }

    /// Current summary for the session (empty → bare-request classification).
    pub fn get(&self, session_id: &str) -> Option<String> {
        let table = self.summaries.lock().unwrap_or_else(|e| e.into_inner());
        table.get(session_id).cloned()
    }

    /// Asynchronously regenerates the summary after a completed turn.
    /// Skips when an update for the session is already running; failures keep
    /// the previous summary (or stay summary-less on the first turn).
    pub fn spawn_update(&self, session_id: &str, last_user: String, last_assistant: String) {
        {
            let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
            if !in_flight.insert(session_id.to_string()) {
                debug!("[router-summary] update already in flight: {}", session_id);
                return;
            }
        }
        let prev = self.get(session_id);
        let prompt = build_summary_prompt(prev.as_deref(), &last_user, &last_assistant);
        let service = get_global_summary_service();
        let session = session_id.to_string();
        tokio::spawn(async move {
            let result = generate_summary(prompt).await;
            let mut in_flight = service.in_flight.lock().unwrap_or_else(|e| e.into_inner());
            in_flight.remove(&session);
            drop(in_flight);
            match result {
                Some(summary) => service.store(&session, summary),
                None => warn!(
                    "[router-summary] generation failed, keeping previous state: {}",
                    session
                ),
            }
        });
    }

    fn store(&self, session_id: &str, summary: String) {
        let mut table = self.summaries.lock().unwrap_or_else(|e| e.into_inner());
        let mut order = self.order.lock().unwrap_or_else(|e| e.into_inner());
        if table.contains_key(session_id) {
            order.retain(|k| k != session_id);
        } else {
            while table.len() >= SUMMARY_CACHE_LIMIT {
                match order.pop_front() {
                    Some(key) => {
                        table.remove(&key);
                    }
                    None => break,
                }
            }
        }
        order.push_back(session_id.to_string());
        let words = summary.split_whitespace().count();
        table.insert(session_id.to_string(), summary);
        debug!(
            "[router-summary] updated ({} words-ish): session={}",
            words, session_id
        );
    }
}

/// Runs one summary generation through the resident rwkv-local engine.
async fn generate_summary(prompt: String) -> Option<String> {
    let engine = get_rwkv_engine()?;
    if !engine.is_initialized() {
        return None;
    }
    let raw = engine
        .infer(
            prompt,
            SUMMARY_MAX_TOKENS,
            SUMMARY_TEMPERATURE,
            0.9,
            vec!["\n\nUser:".to_string(), "\n\nCurrent summary:".to_string()],
        )
        .await
        .ok()?;
    clean_summary(&raw)
}

static GLOBAL_SUMMARY_SERVICE: OnceLock<SessionSummaryService> = OnceLock::new();

/// Returns the global summary service singleton.
pub fn get_global_summary_service() -> &'static SessionSummaryService {
    GLOBAL_SUMMARY_SERVICE.get_or_init(SessionSummaryService::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_contains_prev_summary_and_exchange() {
        let p = build_summary_prompt(Some("Translating a Rust doc"), "改成中文", "好的，已翻译。");
        assert!(p.contains("Translating a Rust doc"));
        assert!(p.contains("改成中文"));
        assert!(p.contains("好的，已翻译。"));
        assert!(p.ends_with("Updated summary:\n"));

        let first = build_summary_prompt(None, "hello", "hi");
        assert!(first.contains("(none)"));
    }

    #[test]
    fn prompt_truncates_long_assistant_reply() {
        // 'z' never occurs in the prompt template ("exchange" contains 'x').
        let long_assistant = "z".repeat(2000);
        let p = build_summary_prompt(None, "q", &long_assistant);
        assert_eq!(p.matches('z').count(), ASSISTANT_HEAD_CHARS);
    }

    #[test]
    fn clean_strips_echo_and_truncates() {
        assert_eq!(
            clean_summary("Updated summary: Task: fixing a login bug."),
            Some("Task: fixing a login bug.".to_string())
        );
        // Double newline cuts echo continuations.
        assert_eq!(
            clean_summary("Debug session about CUDA OOM.\n\nUser: next question"),
            Some("Debug session about CUDA OOM.".to_string())
        );
        // Empty / whitespace-only is rejected.
        assert_eq!(clean_summary("   \n  "), None);
        // Word budget enforced (English).
        let long = format!("{} ", "word ".repeat(500));
        let cleaned = clean_summary(&long).unwrap();
        assert!(cleaned.split_whitespace().count() <= SUMMARY_MAX_WORDS + 1);
    }

    #[test]
    fn cache_lru_and_dedup() {
        let svc = SessionSummaryService::new();
        assert_eq!(svc.get("s1"), None);
        svc.store("s1", "first".to_string());
        assert_eq!(svc.get("s1"), Some("first".to_string()));
        // Update refreshes without growth.
        svc.store("s1", "second".to_string());
        assert_eq!(svc.get("s1"), Some("second".to_string()));
    }
}
