//! Memory pipeline activity state machine.
//!
//! Tracks the current state of the memory retrieval pipeline and keeps
//! a recent event log for UI display and debugging.

use super::types::{MemoryEventKind, MemoryState};
use std::sync::Mutex;
use std::time::Instant;

const MAX_RECENT_EVENTS: usize = 10;
const STALENESS_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone)]
pub struct MemoryEvent {
    pub kind: MemoryEventKind,
    pub timestamp: Instant,
}

#[derive(Debug, Clone)]
pub struct MemoryActivity {
    pub state: MemoryState,
    pub state_since: Instant,
    pub recent_events: Vec<MemoryEvent>,
}

static MEMORY_ACTIVITY: Mutex<Option<MemoryActivity>> = Mutex::new(None);

pub fn get_activity() -> Option<MemoryActivity> {
    MEMORY_ACTIVITY.lock().ok().and_then(|guard| guard.clone())
}

pub fn set_state(state: MemoryState) {
    if let Ok(mut guard) = MEMORY_ACTIVITY.lock() {
        if let Some(activity) = guard.as_mut() {
            activity.state = state;
            activity.state_since = Instant::now();
        } else {
            *guard = Some(MemoryActivity {
                state,
                state_since: Instant::now(),
                recent_events: Vec::new(),
            });
        }
    }
}

pub fn add_event(kind: MemoryEventKind) {
    if let Ok(mut guard) = MEMORY_ACTIVITY.lock() {
        let event = MemoryEvent {
            kind,
            timestamp: Instant::now(),
        };

        if let Some(activity) = guard.as_mut() {
            activity.recent_events.insert(0, event);
            activity.recent_events.truncate(MAX_RECENT_EVENTS);
        } else {
            *guard = Some(MemoryActivity {
                state: MemoryState::Idle,
                state_since: Instant::now(),
                recent_events: vec![event],
            });
        }
    }
}

pub fn check_staleness() -> bool {
    if let Ok(mut guard) = MEMORY_ACTIVITY.lock() {
        if let Some(activity) = guard.as_mut() {
            if !matches!(activity.state, MemoryState::Idle)
                && activity.state_since.elapsed().as_secs() >= STALENESS_TIMEOUT_SECS
            {
                log::debug!(
                    "Memory state stale ({:?} for {}s), auto-resetting to Idle",
                    activity.state,
                    activity.state_since.elapsed().as_secs()
                );
                activity.state = MemoryState::Idle;
                activity.state_since = Instant::now();
                return true;
            }
        }
    }
    false
}

pub fn clear_activity() {
    if let Ok(mut guard) = MEMORY_ACTIVITY.lock() {
        *guard = None;
    }
}
