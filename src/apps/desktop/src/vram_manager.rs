//! VRAM Manager — registry-based coordinator for model engine lifecycle.
//!
//! Engines implement [`ManagedEngine`] and register themselves; the manager
//! provides keep_alive policy resolution, LRU/context-aware eviction, VRAM
//! budget checks, and state events. It never touches engine internals —
//! eviction commands are executed by each engine's own worker/owner thread.
//!
//! Extensible: plugin hosts can register proxy engines for plugin models
//! (future: topic/video models) with zero coordinator changes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;

// ---------------------------------------------------------------------------
// ManagedEngine trait
// ---------------------------------------------------------------------------

/// Anything that can be governed by the VRAM manager. Built-in engines
/// register at startup; plugin hosts may register proxy engines later.
pub trait ManagedEngine: Send + Sync {
    /// Stable engine id, e.g. "rwkv-llm", "llama-gguf", "plugin:<id>:<engine>".
    fn id(&self) -> &str;
    /// Human-readable (Chinese) name for frontend badges.
    fn display_name(&self) -> String;
    /// Lower = evicted later. LLM class 0, auxiliary 1-2, plugins may choose.
    fn priority(&self) -> i32;
    /// Activity contexts this engine serves, e.g. ["music"]. Empty = global.
    fn contexts(&self) -> &[&str] {
        &[]
    }
    /// Whether the model is currently loaded.
    fn is_resident(&self) -> bool;
    /// Inference/generation in progress (busy engines are never evicted).
    fn is_busy(&self) -> bool {
        false
    }
    /// Estimated VRAM footprint (None = no GPU or unknown).
    fn estimate_vram_bytes(&self) -> Option<u64> {
        None
    }
    /// Last-use timestamp (ms since epoch); updated by the engine itself.
    fn last_used_ms(&self) -> u64;
    /// Eviction command. Must block until the engine confirmed unload
    /// (10s timeout) so budget re-checks see freed memory.
    fn evict(&self) -> Result<(), String>;
    /// Predictive warmup (optional): load the engine ahead of user demand.
    /// Default: unsupported.
    fn warmup(&self) -> Result<(), String> {
        Err("warmup not supported".to_string())
    }
}

// ---------------------------------------------------------------------------
// Registry & global state
// ---------------------------------------------------------------------------

static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<dyn ManagedEngine>>>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static ACTIVE_CONTEXT: RwLock<Option<String>> = RwLock::new(None);
static COOLDOWNS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
static CONFIG: RwLock<Option<ai00_x_core::service::config::types::VramManagerConfig>> =
    RwLock::new(None);

/// VRAM tier: 0 = Normal, 1 = High (aggressive residency), 2 = Low (aggressive release).
static VRAM_TIER: AtomicU8 = AtomicU8::new(0);
#[cfg(target_os = "linux")]
static LOW_TIER_SINCE: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Arc<dyn ManagedEngine>>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cooldowns() -> &'static Mutex<HashMap<String, Instant>> {
    COOLDOWNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn config() -> ai00_x_core::service::config::types::VramManagerConfig {
    CONFIG
        .read()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default()
}

/// Global eviction switch (pressure eviction / LRU), for call sites that
/// only need the flag.
pub fn config_enabled() -> bool {
    config().enabled
}

/// Inject the Tauri handle used for `vram-engine-state` events. Call once in setup.
pub fn set_app_handle(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

/// Reload the manager config from the global config service (async context).
pub async fn refresh_config_from_service() {
    use ai00_x_core::service::config::get_global_config_service;
    if let Ok(service) = get_global_config_service() {
        if let Ok(cfg) = service
            .get_config::<ai00_x_core::service::config::types::GlobalConfig>(None)
            .await
        {
            if let Some(vcfg) = cfg.vram_manager {
                if let Ok(mut guard) = CONFIG.write() {
                    *guard = Some(vcfg);
                }
            }
        }
    }
}

/// Register an engine (idempotent: re-registration replaces the old entry).
pub fn register_engine(engine: Arc<dyn ManagedEngine>) {
    let id = engine.id().to_string();
    let display = engine.display_name();
    let resident = engine.is_resident();
    if let Ok(mut reg) = registry().lock() {
        reg.insert(id.clone(), engine);
    }
    log::info!("[vram_manager] engine registered: {id} ({display})");
    emit_state(&id, &display, resident, "registered");
}

/// Remove an engine from governance (e.g. plugin host shutdown).
pub fn unregister_engine(id: &str) {
    if let Ok(mut reg) = registry().lock() {
        reg.remove(id);
    }
    log::info!("[vram_manager] engine unregistered: {id}");
}

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

/// Built-in defaults: (priority, keep_alive_secs). Engines missing from this
/// table get generic defaults. Per-engine values come from config overrides.
fn default_policy(engine_id: &str) -> (i32, i64) {
    match engine_id {
        "rwkv-llm" => (0, -1),
        "llama-gguf" => (0, 300),
        "tts" => (1, 180),
        "asr" => (1, 180),
        "acestep" => (2, 600),
        "audio-gen" => (2, 180),
        _ => (5, 180),
    }
}

/// A fully resolved policy (defaults <- config overrides <- tier scaling).
#[derive(Debug, Clone, Copy)]
pub struct ResolvedPolicy {
    /// Idle residency seconds: -1 forever / 0 unload-after-use / >0 timeout.
    pub keep_alive_secs: i64,
    pub priority: i32,
    pub enabled: bool,
}

/// Effective VRAM tier for policy scaling.
fn current_tier() -> u8 {
    if config().enable_vram_tiers {
        VRAM_TIER.load(Ordering::Relaxed)
    } else {
        0
    }
}

/// Resolve the effective policy for an engine.
pub fn resolve_policy(engine_id: &str, built_in_priority: i32) -> ResolvedPolicy {
    let cfg = config();
    let (_dp, dk) = default_policy(engine_id);
    let override_entry = cfg
        .engine_policies
        .get(engine_id)
        .cloned()
        .unwrap_or_default();

    let mut keep_alive = if override_entry.keep_alive_secs == 180 {
        // Sentinel: EnginePolicy::default() — treat as "use built-in default".
        dk
    } else {
        override_entry.keep_alive_secs
    };
    let priority = override_entry.priority.unwrap_or(built_in_priority);
    let enabled = override_entry.enabled.unwrap_or(cfg.enabled);

    // Tier scaling only applies to finite timeouts (never to -1 / 0 semantics).
    if keep_alive > 0 {
        keep_alive = match current_tier() {
            1 => keep_alive.saturating_mul(2),
            2 => (keep_alive / 2).max(1),
            _ => keep_alive,
        };
    }

    ResolvedPolicy {
        keep_alive_secs: keep_alive,
        priority,
        enabled,
    }
}

// ---------------------------------------------------------------------------
// VRAM tier (High / Normal / Low) — driven by system_monitor sampling
// ---------------------------------------------------------------------------

/// Feed the current free/total ratio into the tier state machine.
/// Hysteresis prevents flapping: enter High at >=40%, leave at <35%;
/// enter Low after staying <15% for 30s, leave at >=20%.
pub fn update_vram_state(free_bytes: u64, total_bytes: u64) {
    if total_bytes == 0 {
        return;
    }
    let ratio = free_bytes as f64 / total_bytes as f64;
    let prev = VRAM_TIER.load(Ordering::Relaxed);

    let next = match prev {
        1 => {
            if ratio < 0.35 {
                0
            } else {
                1
            }
        }
        2 => {
            if ratio >= 0.20 {
                0
            } else {
                2
            }
        }
        _ => {
            if ratio >= 0.40 {
                1
            } else {
                low_tier_pending(ratio)
            }
        }
    };
    if next != prev {
        VRAM_TIER.store(next, Ordering::Relaxed);
        log::info!("[vram_manager] VRAM tier -> {next} (free ratio {ratio:.2})");
    }
}

#[cfg(target_os = "linux")]
fn low_tier_pending(ratio: f64) -> u8 {
    let slot = LOW_TIER_SINCE.get_or_init(|| Mutex::new(None));
    let mut since = slot.lock().ok()?.take();
    if ratio < 0.15 {
        let since = *since.get_or_insert_with(Instant::now);
        if since.elapsed() >= Duration::from_secs(30) {
            return 2;
        }
        *slot.lock().ok()? = Some(since);
        0
    } else {
        0
    }
}

#[cfg(not(target_os = "linux"))]
fn low_tier_pending(ratio: f64) -> u8 {
    if ratio < 0.15 {
        2
    } else {
        0
    }
}

/// Free VRAM after subtracting the configured reserve (tier-scaled), no eviction.
/// 供部分卸载决策使用：当前可用、且未来仍要留给系统的显存预算。
pub fn free_after_reserve(gpu_hint: Option<usize>) -> Option<u64> {
    let cfg = config();
    let mem = crate::vram_monitor::query_vram(gpu_hint)?;
    let base = cfg.vram_reserve_mb as f64 * 1024.0 * 1024.0;
    let scaled = match current_tier() {
        1 => base * 0.5,
        2 => base * 2.0,
        _ => base,
    };
    Some(mem.free_bytes.saturating_sub(scaled as u64))
}

// ---------------------------------------------------------------------------
// Budget check & eviction
// ---------------------------------------------------------------------------

/// Context match: engine is protected when it serves the active context.
fn context_protected(engine: &dyn ManagedEngine, active: Option<&str>) -> bool {
    match active {
        Some(ctx) if !ctx.is_empty() => engine.contexts().contains(&ctx),
        _ => false,
    }
}

fn in_cooldown(id: &str) -> bool {
    let cooldown_secs = config().eviction_cooldown_secs;
    if cooldown_secs == 0 {
        return false;
    }
    cooldowns()
        .lock()
        .ok()
        .and_then(|map| {
            map.get(id)
                .map(|t| t.elapsed() < Duration::from_secs(cooldown_secs))
        })
        .unwrap_or(false)
}

fn mark_cooldown(id: &str) {
    if let Ok(mut map) = cooldowns().lock() {
        map.insert(id.to_string(), Instant::now());
    }
}

/// Select the next eviction victim, ordered by:
/// 1. context-mismatched engines first (current-activity engines protected)
/// 2. higher priority value first (lower priority value = protected)
/// 3. LRU (oldest last_used first)
fn pick_victim(exclude_ids: &[String]) -> Option<Arc<dyn ManagedEngine>> {
    let active = ACTIVE_CONTEXT.read().ok().and_then(|g| g.clone());
    let reg = registry().lock().ok()?;
    let mut candidates: Vec<Arc<dyn ManagedEngine>> = reg
        .values()
        .filter(|e| e.is_resident() && !e.is_busy() && !in_cooldown(e.id()))
        .filter(|e| !exclude_ids.iter().any(|x| x == e.id()))
        .cloned()
        .collect();
    drop(reg);

    candidates.sort_by(|a, b| {
        let a_prot = context_protected(a.as_ref(), active.as_deref());
        let b_prot = context_protected(b.as_ref(), active.as_deref());
        b_prot
            .cmp(&a_prot) // unprotected first
            .then(b.priority().cmp(&a.priority())) // higher priority value first
            .then(a.last_used_ms().cmp(&b.last_used_ms())) // LRU first
    });
    candidates.into_iter().next()
}

/// Evict the LRU/context-mismatched engine (excluding `exclude_id`).
/// Returns the evicted engine id, or None when no candidate exists.
/// 单个候选驱逐失败时继续尝试下一个（此前首个失败即整体放弃，
/// 一个不可驱逐的注册引擎会阻塞整个预算腾退链路）。
pub fn evict_lru(exclude_id: Option<&str>) -> Option<String> {
    let mut tried: Vec<String> = Vec::new();
    loop {
        let mut exclude: Vec<String> = tried.clone();
        if let Some(x) = exclude_id {
            exclude.push(x.to_string());
        }
        let victim = pick_victim(&exclude)?;
        let id = victim.id().to_string();
        let display = victim.display_name();
        log::info!("[vram_manager] evicting {id} ({display}) to free VRAM");
        match victim.evict() {
            Ok(()) => {
                mark_cooldown(&id);
                emit_state(&id, &display, false, "evicted-pressure");
                return Some(id);
            }
            Err(e) => {
                log::warn!("[vram_manager] evict {id} failed: {e}");
                tried.push(id);
            }
        }
    }
}

/// Ensure `need_bytes` of VRAM is available before a load, evicting other
/// engines when necessary. Synchronous: `evict` blocks until the engine
/// confirmed unload — call from `spawn_blocking` in async contexts.
pub fn ensure_capacity(need_bytes: u64, gpu_hint: Option<usize>) -> Result<(), String> {
    let cfg = config();
    if !cfg.enabled {
        return Ok(());
    }
    let Some(mem) = crate::vram_monitor::query_vram(gpu_hint) else {
        // No monitor backend: skip budget checks gracefully.
        return Ok(());
    };

    let reserve = {
        let base = cfg.vram_reserve_mb as f64 * 1024.0 * 1024.0;
        let scaled = match current_tier() {
            1 => base * 0.5,
            2 => base * 2.0,
            _ => base,
        };
        scaled as u64
    };

    if mem.free_bytes.saturating_sub(reserve) >= need_bytes {
        return Ok(());
    }
    if !cfg.enable_pressure_eviction {
        return Err(format!(
            "insufficient VRAM: need {:.0} MB, free {:.0} MB (pressure eviction disabled)",
            need_bytes as f64 / 1048576.0,
            mem.free_bytes as f64 / 1048576.0
        ));
    }

    log::info!(
        "[vram_manager] budget check: need {:.0} MB, free {:.0} MB — evicting candidates",
        need_bytes as f64 / 1048576.0,
        mem.free_bytes as f64 / 1048576.0
    );

    // Evict until the budget is satisfied or no candidate remains.
    for _ in 0..8 {
        if evict_lru(None).is_none() {
            break;
        }
        if let Some(cur) = crate::vram_monitor::query_vram(gpu_hint) {
            if cur.free_bytes.saturating_sub(reserve) >= need_bytes {
                return Ok(());
            }
        }
    }

    Err(format!(
        "insufficient VRAM even after eviction: need {:.0} MB, free {:.0} MB",
        need_bytes as f64 / 1048576.0,
        mem.free_bytes as f64 / 1048576.0
    ))
}

// ---------------------------------------------------------------------------
// State events & queries
// ---------------------------------------------------------------------------

/// Engine status snapshot for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VramEngineStatus {
    pub engine_id: String,
    pub display_name: String,
    pub priority: i32,
    pub contexts: Vec<String>,
    pub resident: bool,
    pub busy: bool,
    pub last_used_ms: u64,
    pub estimate_vram_mb: Option<u64>,
    pub keep_alive_secs: i64,
}

/// List all registered engines (dynamic — plugin engines appear automatically).
pub fn list_engines() -> Vec<VramEngineStatus> {
    let reg = registry().lock().map(|reg| {
        let mut out: Vec<VramEngineStatus> = reg
            .values()
            .map(|e| {
                let policy = resolve_policy(e.id(), e.priority());
                VramEngineStatus {
                    engine_id: e.id().to_string(),
                    display_name: e.display_name(),
                    priority: policy.priority,
                    contexts: e.contexts().iter().map(|s| s.to_string()).collect(),
                    resident: e.is_resident(),
                    busy: e.is_busy(),
                    last_used_ms: e.last_used_ms(),
                    estimate_vram_mb: e.estimate_vram_bytes().map(|b| b / (1024 * 1024)),
                    keep_alive_secs: policy.keep_alive_secs,
                }
            })
            .collect();
        out.sort_by(|a, b| {
            a.priority
                .cmp(&b.priority)
                .then(a.engine_id.cmp(&b.engine_id))
        });
        out
    });
    reg.unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineStatePayload {
    engine_id: String,
    display_name: String,
    resident: bool,
    reason: String,
}

fn emit_state(engine_id: &str, display: &str, resident: bool, reason: &str) {
    if let Some(app) = APP.get() {
        let payload = EngineStatePayload {
            engine_id: engine_id.to_string(),
            display_name: display.to_string(),
            resident,
            reason: reason.to_string(),
        };
        if let Err(e) = app.emit("vram-engine-state", &payload) {
            log::warn!("[vram_manager] emit vram-engine-state failed: {e}");
        }
    }
}

/// Engines call this after their residency changed (idle unload / reload).
pub fn notify_state(engine_id: &str, display: &str, resident: bool, reason: &str) {
    emit_state(engine_id, display, resident, reason);
    if !resident {
        // Idle unload also enters cooldown to avoid evict-reload ping-pong.
        mark_cooldown(engine_id);
    }
}

/// Set the current activity context (frontend tool page switching).
pub fn set_active_context(context: Option<String>) {
    let mut guard = match ACTIVE_CONTEXT.write() {
        Ok(g) => g,
        Err(_) => return,
    };
    let normalized = context.filter(|s| !s.is_empty());
    if *guard == normalized {
        return;
    }
    log::info!(
        "[vram_manager] active context -> {:?}",
        normalized.as_deref().unwrap_or("(none)")
    );
    *guard = normalized;
    drop(guard);
    maybe_warmup();
}

/// Current activity context, for warmup & diagnostics.
pub fn active_context() -> Option<String> {
    ACTIVE_CONTEXT.read().ok().and_then(|g| g.clone())
}

/// Predictive warmup: load context-bound engines before the user clicks.
fn maybe_warmup() {
    let cfg = config();
    if !cfg.enable_predictive_warmup {
        return;
    }
    let Some(ctx) = active_context() else {
        return;
    };
    let targets: Vec<Arc<dyn ManagedEngine>> = registry()
        .lock()
        .ok()
        .map(|reg| {
            reg.values()
                .filter(|e| {
                    e.contexts().contains(&ctx.as_str())
                        && !e.is_resident()
                        && !e.is_busy()
                        && resolve_policy(e.id(), e.priority()).keep_alive_secs != 0
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    for engine in targets {
        let id = engine.id().to_string();
        // Warmup failure is silent — never blocks the foreground page.
        std::thread::Builder::new()
            .name(format!("vram-warmup-{id}"))
            .spawn(move || {
                if let Err(e) = engine.warmup() {
                    log::info!("[vram_manager] warmup {id} skipped: {e}");
                }
            })
            .ok();
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// List governed engines (dynamic — includes plugin-registered engines).
#[tauri::command]
pub async fn vram_list_engines() -> Result<Vec<VramEngineStatus>, String> {
    refresh_config_from_service().await;
    Ok(list_engines())
}

/// Manually unload one engine ("release now" button).
#[tauri::command]
pub async fn vram_evict_engine(engine_id: String) -> Result<(), String> {
    let engine = registry()
        .lock()
        .ok()
        .and_then(|reg| reg.get(&engine_id).cloned());
    let Some(engine) = engine else {
        return Err(format!("unknown engine: {engine_id}"));
    };
    if engine.is_busy() {
        return Err(format!("engine {engine_id} is busy; try later"));
    }
    // Evict can block up to 10s — run off the async runtime.
    let id = engine.id().to_string();
    let display = engine.display_name();
    tokio::task::spawn_blocking(move || engine.evict())
        .await
        .map_err(|e| format!("evict task failed: {e}"))??;
    mark_cooldown(&id);
    emit_state(&id, &display, false, "evicted-manual");
    Ok(())
}

/// Report the current activity context from the frontend (tool page switch).
#[tauri::command]
pub async fn vram_set_active_context(context: Option<String>) -> Result<(), String> {
    refresh_config_from_service().await;
    set_active_context(context);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests (pure logic; registry-dependent paths use local registries)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_table() {
        assert_eq!(default_policy("rwkv-llm"), (0, -1));
        assert_eq!(default_policy("llama-gguf"), (0, 300));
        assert_eq!(default_policy("asr"), (1, 180));
        assert_eq!(default_policy("unknown-engine"), (5, 180));
    }

    #[test]
    fn tier_scaling_financial_timeout_only() {
        // -1 (keep forever) must never be scaled.
        let cfg = ai00_x_core::service::config::types::VramManagerConfig {
            enable_vram_tiers: true,
            ..ai00_x_core::service::config::types::VramManagerConfig::default()
        };
        *CONFIG.write().unwrap() = Some(cfg);
        VRAM_TIER.store(2, Ordering::Relaxed);
        assert_eq!(resolve_policy("rwkv-llm", 0).keep_alive_secs, -1);
        VRAM_TIER.store(0, Ordering::Relaxed);
        assert_eq!(resolve_policy("rwkv-llm", 0).keep_alive_secs, -1);
        // Finite timeout: High doubles, Low halves.
        VRAM_TIER.store(1, Ordering::Relaxed);
        assert_eq!(resolve_policy("llama-gguf", 0).keep_alive_secs, 600);
        VRAM_TIER.store(2, Ordering::Relaxed);
        assert_eq!(resolve_policy("llama-gguf", 0).keep_alive_secs, 150);
        VRAM_TIER.store(0, Ordering::Relaxed);
        *CONFIG.write().unwrap() = None;
    }

    #[test]
    fn tier_state_machine_hysteresis() {
        let total = 22_000u64;
        // Normal -> High at >= 40%
        update_vram_state(total * 45 / 100, total);
        assert_eq!(VRAM_TIER.load(Ordering::Relaxed), 1);
        // Stay High until < 35%
        update_vram_state(total * 36 / 100, total);
        assert_eq!(VRAM_TIER.load(Ordering::Relaxed), 1);
        update_vram_state(total * 30 / 100, total);
        assert_eq!(VRAM_TIER.load(Ordering::Relaxed), 0);
        // Normal -> Low immediately under 15% (hysteresis exit at >= 20%)
        update_vram_state(total * 10 / 100, total);
        assert_eq!(VRAM_TIER.load(Ordering::Relaxed), 2);
        update_vram_state(total * 21 / 100, total);
        assert_eq!(VRAM_TIER.load(Ordering::Relaxed), 0);
    }
}
