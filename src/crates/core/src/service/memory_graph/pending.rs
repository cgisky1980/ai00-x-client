//! Pending memory inject queue — delay-one-turn async injection.
//!
//! The main Agent at turn N takes the pending memory computed at turn N-1,
//! so the memory retrieval never blocks the main conversation loop.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Instant;

/// A pending memory result from async relevance checking.
#[derive(Debug, Clone)]
pub struct PendingMemory {
    /// The formatted memory prompt ready for injection.
    pub prompt: String,
    /// Optional UI-focused rendering with extra display metadata.
    pub display_prompt: Option<String>,
    /// When this was computed.
    pub computed_at: Instant,
    /// Number of relevant memories found.
    pub count: usize,
    /// IDs of memories included in this prompt.
    pub memory_ids: Vec<String>,
}

impl PendingMemory {
    pub fn is_fresh(&self) -> bool {
        self.computed_at.elapsed().as_secs() < 120
    }
}

/// Pending memory prompt from background check — ready to inject on next turn.
/// Keyed by session ID so each session gets its own pending memory.
static PENDING_MEMORY: Mutex<Option<HashMap<String, PendingMemory>>> = Mutex::new(None);

/// Signature of the last injected prompt to suppress near-immediate duplicates.
static LAST_INJECTED_PROMPT_SIGNATURE: Mutex<Option<HashMap<String, (String, Instant)>>> =
    Mutex::new(None);

/// Recently injected memory ID sets per session.
type MemorySetMap = HashMap<String, (HashSet<String>, Instant)>;
static LAST_INJECTED_MEMORY_SET: Mutex<Option<MemorySetMap>> = Mutex::new(None);

/// Memory IDs that have already been injected into the conversation.
/// Prevents the same memory from being re-injected on subsequent turns.
static INJECTED_MEMORY_IDS: Mutex<Option<HashMap<String, HashSet<String>>>> = Mutex::new(None);

/// Guard to ensure only one memory check runs at a time, per session.
static MEMORY_CHECK_IN_PROGRESS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Last taken pending memory metadata for event emission by execution_engine.
static LAST_TAKEN_INFO: Mutex<Option<(String, usize, Option<String>)>> = Mutex::new(None);

/// Suppress repeated identical memory payloads within this many seconds.
const MEMORY_REPEAT_SUPPRESSION_SECS: u64 = 90;
/// Suppress substantially overlapping memory sets for a bit longer.
const MEMORY_SET_REPEAT_SUPPRESSION_SECS: u64 = 180;
/// Overlap ratio threshold for suppression.
const MEMORY_SET_OVERLAP_SUPPRESSION_RATIO: f32 = 0.8;

// ==================== Public API ====================

pub fn take_pending_memory(session_id: &str) -> Option<PendingMemory> {
    let mut guard = PENDING_MEMORY.lock().ok()?;
    let map = guard.get_or_insert_with(HashMap::new);
    let pending = map.remove(session_id)?;

    if !pending.is_fresh() {
        log::debug!(
            "[memory] Pending memory for {} discarded (stale)",
            session_id
        );
        return None;
    }

    let sig = prompt_signature(&pending.prompt);

    // Check prompt signature duplicate
    if let Ok(mut last_guard) = LAST_INJECTED_PROMPT_SIGNATURE.lock() {
        let sig_map = last_guard.get_or_insert_with(HashMap::new);
        if let Some((last_sig, last_at)) = sig_map.get(session_id) {
            if *last_sig == sig && last_at.elapsed().as_secs() < MEMORY_REPEAT_SUPPRESSION_SECS {
                log::debug!(
                    "[memory] Pending memory for {} suppressed (duplicate signature)",
                    session_id
                );
                return None;
            }
        }
        sig_map.insert(session_id.to_string(), (sig, Instant::now()));
    }

    // Check memory set overlap
    if !pending.memory_ids.is_empty() {
        let pending_set = memory_set(&pending.memory_ids);
        if let Ok(mut last_guard) = LAST_INJECTED_MEMORY_SET.lock() {
            let set_map = last_guard.get_or_insert_with(HashMap::new);
            if let Some((last_set, last_at)) = set_map.get(session_id) {
                let overlap = memory_overlap_ratio(last_set, &pending_set);
                if overlap >= MEMORY_SET_OVERLAP_SUPPRESSION_RATIO
                    && last_at.elapsed().as_secs() < MEMORY_SET_REPEAT_SUPPRESSION_SECS
                {
                    log::debug!(
                        "[memory] Pending memory for {} suppressed (overlap {:.2})",
                        session_id,
                        overlap
                    );
                    return None;
                }
            }
            set_map.insert(session_id.to_string(), (pending_set, Instant::now()));
        }
    }

    // Mark as injected
    if !pending.memory_ids.is_empty() {
        mark_memories_injected(session_id, &pending.memory_ids);
    }

    log::debug!(
        "[memory] Pending memory taken for {}: {} entries",
        session_id,
        pending.count
    );

    // Save metadata for execution_engine event emission
    if let Ok(mut guard) = LAST_TAKEN_INFO.lock() {
        *guard = Some((
            session_id.to_string(),
            pending.count,
            pending.display_prompt.clone(),
        ));
    }

    Some(pending)
}

/// Read the metadata of the last taken pending memory. Returns (session_id, count, display_prompt).
/// Consumes the data so each call reads it once.
pub fn last_taken_metadata() -> Option<(String, usize, Option<String>)> {
    LAST_TAKEN_INFO.lock().ok().and_then(|mut g| g.take())
}

pub fn set_pending_memory(session_id: &str, prompt: String, count: usize) {
    set_pending_memory_with_ids(session_id, prompt, count, Vec::new());
}

pub fn set_pending_memory_with_ids(
    session_id: &str,
    prompt: String,
    count: usize,
    memory_ids: Vec<String>,
) {
    set_pending_memory_with_ids_and_display(session_id, prompt, count, memory_ids, None);
}

pub fn set_pending_memory_with_ids_and_display(
    session_id: &str,
    prompt: String,
    count: usize,
    memory_ids: Vec<String>,
    display_prompt: Option<String>,
) {
    if let Ok(mut guard) = PENDING_MEMORY.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        let new_sig = prompt_signature(&prompt);
        let new_memory_set = memory_set(&memory_ids);

        if let Some(existing) = map.get(session_id) {
            if existing.is_fresh() {
                let existing_sig = prompt_signature(&existing.prompt);
                let overlap =
                    memory_overlap_ratio(&memory_set(&existing.memory_ids), &new_memory_set);
                if existing_sig == new_sig || overlap >= MEMORY_SET_OVERLAP_SUPPRESSION_RATIO {
                    return;
                }
            }
        }

        map.insert(
            session_id.to_string(),
            PendingMemory {
                prompt,
                display_prompt,
                computed_at: Instant::now(),
                count,
                memory_ids,
            },
        );
    }
}

pub fn mark_memories_injected(session_id: &str, ids: &[String]) {
    if let Ok(mut guard) = INJECTED_MEMORY_IDS.lock() {
        let outer = guard.get_or_insert_with(HashMap::new);
        let set = outer
            .entry(session_id.to_string())
            .or_insert_with(HashSet::new);
        for id in ids {
            set.insert(id.clone());
        }
    }
}

pub fn is_memory_injected(session_id: &str, id: &str) -> bool {
    if let Ok(guard) = INJECTED_MEMORY_IDS.lock() {
        if let Some(outer) = guard.as_ref() {
            if let Some(set) = outer.get(session_id) {
                return set.contains(id);
            }
        }
    }
    false
}

pub fn clear_injected_memories(session_id: &str) {
    if let Ok(mut guard) = LAST_INJECTED_PROMPT_SIGNATURE.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(session_id);
        }
    }
    if let Ok(mut guard) = LAST_INJECTED_MEMORY_SET.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(session_id);
        }
    }
    if let Ok(mut guard) = INJECTED_MEMORY_IDS.lock() {
        if let Some(outer) = guard.as_mut() {
            outer.remove(session_id);
        }
    }
}

pub fn clear_all_pending_memory() {
    if let Ok(mut guard) = PENDING_MEMORY.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = LAST_INJECTED_PROMPT_SIGNATURE.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = LAST_INJECTED_MEMORY_SET.lock() {
        *guard = None;
    }
    clear_all_injected_memories();
}

pub fn has_pending_memory(session_id: &str) -> bool {
    PENDING_MEMORY
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|m| m.contains_key(session_id)))
        .unwrap_or(false)
}

pub fn has_any_pending_memory() -> bool {
    PENDING_MEMORY
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|m| !m.is_empty()))
        .unwrap_or(false)
}

/// Clean up all per-session state. Call when a session is deleted or closed.
pub fn cleanup_session(session_id: &str) {
    clear_injected_memories(session_id);
    if let Ok(mut guard) = PENDING_MEMORY.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(session_id);
        }
    }
    if let Ok(mut guard) = LAST_INJECTED_PROMPT_SIGNATURE.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(session_id);
        }
    }
    if let Ok(mut guard) = LAST_INJECTED_MEMORY_SET.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(session_id);
        }
    }
}

pub(super) fn begin_memory_check(session_id: &str) -> bool {
    if let Ok(mut guard) = MEMORY_CHECK_IN_PROGRESS.lock() {
        let set = guard.get_or_insert_with(HashSet::new);
        return set.insert(session_id.to_string());
    }
    false
}

pub(super) fn finish_memory_check(session_id: &str) {
    if let Ok(mut guard) = MEMORY_CHECK_IN_PROGRESS.lock() {
        if let Some(set) = guard.as_mut() {
            set.remove(session_id);
        }
    }
}

// ==================== Internal Helpers ====================

fn clear_all_injected_memories() {
    if let Ok(mut guard) = INJECTED_MEMORY_IDS.lock() {
        *guard = None;
    }
}

fn prompt_signature(prompt: &str) -> String {
    prompt
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase()
}

fn memory_set(ids: &[String]) -> HashSet<String> {
    ids.iter().cloned().collect()
}

fn memory_overlap_ratio(left: &HashSet<String>, right: &HashSet<String>) -> f32 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(right).count() as f32;
    let baseline = left.len().max(right.len()) as f32;
    intersection / baseline
}
