use serde::{Deserialize, Serialize};
use std::time::SystemTime;
use uuid::Uuid;

// ============ Dialog Turn DialogTurn ============

/// Dialog turn: from user input to final AI response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DialogTurn {
    pub turn_id: String,
    pub session_id: String,
    pub turn_index: usize,

    /// User input
    pub user_input: String,

    /// Model round ID list
    pub model_round_ids: Vec<String>,

    /// State
    pub state: DialogTurnState,

    /// Statistics
    pub stats: TurnStats,

    /// Lifecycle
    pub started_at: SystemTime,
    pub completed_at: Option<SystemTime>,
}

impl DialogTurn {
    /// Create a new dialog turn
    /// turn_id: Optional frontend-specified ID, if None then backend generates it
    pub fn new(
        session_id: String,
        turn_index: usize,
        user_input: String,
        turn_id: Option<String>,
    ) -> Self {
        Self {
            turn_id: turn_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            session_id,
            turn_index,
            user_input,
            model_round_ids: vec![],
            state: DialogTurnState::Active {
                current_round_index: 0,
                pending_tool_count: 0,
            },
            stats: TurnStats::default(),
            started_at: SystemTime::now(),
            completed_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DialogTurnState {
    Active {
        current_round_index: usize,
        pending_tool_count: usize,
    },
    Completed {
        final_response: String,
        total_rounds: usize,
    },
    Cancelled,
    Failed {
        error: String,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TurnStats {
    pub total_rounds: usize,
    pub total_tools: usize,
    pub total_tokens: usize,
    pub duration_ms: u64,
}
