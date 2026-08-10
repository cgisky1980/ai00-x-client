use super::{Message, ToolCall, ToolResult};
use serde::{Deserialize, Serialize};
use std::time::SystemTime;

// ============ Model Round ModelRound ============

/// Model round: one AI call + tool execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRound {
    pub round_id: String,
    pub dialog_turn_id: String,
    pub round_index: usize,

    /// Resolved model ID used for this round (e.g. "claude-3.5-sonnet", "rwkv-7-world")
    pub model_id: Option<String>,

    /// Input messages
    pub input_messages: Vec<Message>,

    /// AI response
    pub ai_text: String,
    pub tool_calls: Vec<ToolCall>,

    /// Tool execution results
    pub tool_results: Vec<ToolResult>,

    /// State
    pub state: ModelRoundState,

    /// Statistics
    pub tokens_used: Option<usize>,
    pub duration_ms: u64,

    /// Lifecycle
    pub started_at: SystemTime,
    pub completed_at: Option<SystemTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ModelRoundState {
    Thinking,
    Streaming,
    ToolsExecuting,
    Completed,
}
