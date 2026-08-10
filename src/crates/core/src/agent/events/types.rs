//! Unified event model
//!
//! Uses ai00-x-events layer event definitions, extending core-specific functionality here

use crate::agent::core::SessionState;

pub use ai00_x_events::{
    AgentEvent, AgentEventEnvelope as EventEnvelope, AgentEventPriority as EventPriority,
    SubagentParentInfo, ToolEventData,
};

#[allow(deprecated)]
pub use ai00_x_events::{AgenticEvent, AgenticEventEnvelope, AgenticEventPriority};

pub fn session_state_to_string(state: &SessionState) -> String {
    match state {
        SessionState::Idle => "idle".to_string(),
        SessionState::Processing { .. } => "processing".to_string(),
        SessionState::Error { .. } => "error".to_string(),
    }
}
