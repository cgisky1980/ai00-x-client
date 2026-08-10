//! Agent Events Definition
use serde::{Deserialize, Serialize};
use std::time::SystemTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum AgentEventPriority {
    Critical = 0,
    High = 1,
    Normal = 2,
    Low = 3,
}

#[deprecated(since = "0.2.0", note = "Use AgentEventPriority instead")]
pub type AgenticEventPriority = AgentEventPriority;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentParentInfo {
    #[serde(rename = "toolCallId")]
    pub tool_call_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "dialogTurnId")]
    pub dialog_turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    SessionCreated {
        session_id: String,
        session_name: String,
        agent_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_path: Option<String>,
    },

    SessionStateChanged {
        session_id: String,
        new_state: String,
    },

    SessionDeleted {
        session_id: String,
    },

    SessionTitleGenerated {
        session_id: String,
        title: String,
        method: String,
    },
    ImageAnalysisStarted {
        session_id: String,
        image_count: usize,
        user_input: String,
        image_metadata: Option<serde_json::Value>,
    },

    ImageAnalysisCompleted {
        session_id: String,
        success: bool,
        duration_ms: u64,
    },

    DialogTurnStarted {
        session_id: String,
        turn_id: String,
        turn_index: usize,
        user_input: String,
        original_user_input: Option<String>,
        user_message_metadata: Option<serde_json::Value>,
        subagent_parent_info: Option<SubagentParentInfo>,
    },

    DialogTurnCompleted {
        session_id: String,
        turn_id: String,
        total_rounds: usize,
        total_tools: usize,
        duration_ms: u64,
        subagent_parent_info: Option<SubagentParentInfo>,
    },

    DialogTurnCancelled {
        session_id: String,
        turn_id: String,
        subagent_parent_info: Option<SubagentParentInfo>,
    },

    DialogTurnFailed {
        session_id: String,
        turn_id: String,
        error: String,
        subagent_parent_info: Option<SubagentParentInfo>,
    },

    MemoryInjected {
        session_id: String,
        count: usize,
        display_prompt: Option<String>,
    },

    TokenUsageUpdated {
        session_id: String,
        turn_id: String,
        model_id: String,
        input_tokens: usize,
        output_tokens: Option<usize>,
        total_tokens: usize,
        max_context_tokens: Option<usize>,
        is_subagent: bool,
    },

    ContextCompressionStarted {
        session_id: String,
        turn_id: String,
        compression_id: String,
        trigger: String,
        tokens_before: usize,
        context_window: usize,
        threshold: f32,
        subagent_parent_info: Option<SubagentParentInfo>,
    },

    ContextCompressionCompleted {
        session_id: String,
        turn_id: String,
        compression_id: String,
        compression_count: usize,
        tokens_before: usize,
        tokens_after: usize,
        compression_ratio: f64,
        duration_ms: u64,
        has_summary: bool,
        summary_source: String,
        subagent_parent_info: Option<SubagentParentInfo>,
    },

    ContextCompressionFailed {
        session_id: String,
        turn_id: String,
        compression_id: String,
        error: String,
        subagent_parent_info: Option<SubagentParentInfo>,
    },

    ModelRoundStarted {
        session_id: String,
        turn_id: String,
        round_id: String,
        round_index: usize,
        subagent_parent_info: Option<SubagentParentInfo>,
    },

    ModelRoundCompleted {
        session_id: String,
        turn_id: String,
        round_id: String,
        has_tool_calls: bool,
        subagent_parent_info: Option<SubagentParentInfo>,
        model_id: Option<String>,
        input_tokens: Option<usize>,
        output_tokens: Option<usize>,
        total_tokens: Option<usize>,
    },

    TextChunk {
        session_id: String,
        turn_id: String,
        round_id: String,
        text: String,
        subagent_parent_info: Option<SubagentParentInfo>,
    },

    ThinkingChunk {
        session_id: String,
        turn_id: String,
        round_id: String,
        content: String,
        #[serde(default)]
        is_end: bool,
        subagent_parent_info: Option<SubagentParentInfo>,
    },

    ToolEvent {
        session_id: String,
        turn_id: String,
        tool_event: ToolEventData,
        subagent_parent_info: Option<SubagentParentInfo>,
    },

    WorkflowPhaseChanged {
        session_id: String,
        from_phase: String,
        to_phase: String,
    },

    PlanConfirmationNeeded {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        plan_file_path: Option<String>,
    },

    PlanConfirmationResponded {
        session_id: String,
        confirmed: bool,
    },

    PlanAutoReviewStarted {
        session_id: String,
    },

    PlanAutoReviewCompleted {
        session_id: String,
        summary: String,
        issues_found: u32,
        issues_resolved: u32,
    },

    PlanReviseRequested {
        session_id: String,
        feedback: String,
    },

    SystemError {
        session_id: Option<String>,
        error: String,
        recoverable: bool,
    },
}

#[deprecated(since = "0.2.0", note = "Use AgentEvent instead")]
pub type AgenticEvent = AgentEvent;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event_type")]
pub enum ToolEventData {
    EarlyDetected {
        tool_id: String,
        tool_name: String,
    },
    ParamsPartial {
        tool_id: String,
        tool_name: String,
        params: String,
    },
    Queued {
        tool_id: String,
        tool_name: String,
        position: usize,
    },
    Waiting {
        tool_id: String,
        tool_name: String,
        dependencies: Vec<String>,
    },
    Started {
        tool_id: String,
        tool_name: String,
        params: serde_json::Value,
    },
    Progress {
        tool_id: String,
        tool_name: String,
        message: String,
        percentage: f32,
    },
    Streaming {
        tool_id: String,
        tool_name: String,
        chunks_received: usize,
    },
    StreamChunk {
        tool_id: String,
        tool_name: String,
        data: serde_json::Value,
    },
    ConfirmationNeeded {
        tool_id: String,
        tool_name: String,
        params: serde_json::Value,
    },
    Confirmed {
        tool_id: String,
        tool_name: String,
    },
    Rejected {
        tool_id: String,
        tool_name: String,
    },
    Completed {
        tool_id: String,
        tool_name: String,
        result: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        result_for_assistant: Option<String>,
        duration_ms: u64,
    },
    Failed {
        tool_id: String,
        tool_name: String,
        error: String,
    },
    Cancelled {
        tool_id: String,
        tool_name: String,
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEventEnvelope {
    pub id: String,
    pub event: AgentEvent,
    pub priority: AgentEventPriority,
    pub timestamp: SystemTime,
}

#[deprecated(since = "0.2.0", note = "Use AgentEventEnvelope instead")]
pub type AgenticEventEnvelope = AgentEventEnvelope;

impl PartialEq for AgentEventEnvelope {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for AgentEventEnvelope {}

impl PartialOrd for AgentEventEnvelope {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for AgentEventEnvelope {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match self.priority.cmp(&other.priority) {
            std::cmp::Ordering::Equal => self.timestamp.cmp(&other.timestamp),
            other => other,
        }
    }
}

impl AgentEventEnvelope {
    pub fn new(event: AgentEvent, priority: AgentEventPriority) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            event,
            priority,
            timestamp: SystemTime::now(),
        }
    }
}

impl AgentEvent {
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::SessionCreated { session_id, .. }
            | Self::SessionStateChanged { session_id, .. }
            | Self::SessionDeleted { session_id }
            | Self::SessionTitleGenerated { session_id, .. }
            | Self::ImageAnalysisStarted { session_id, .. }
            | Self::ImageAnalysisCompleted { session_id, .. }
            | Self::DialogTurnStarted { session_id, .. }
            | Self::DialogTurnCompleted { session_id, .. }
            | Self::TokenUsageUpdated { session_id, .. }
            | Self::ContextCompressionStarted { session_id, .. }
            | Self::ContextCompressionCompleted { session_id, .. }
            | Self::ContextCompressionFailed { session_id, .. }
            | Self::DialogTurnCancelled { session_id, .. }
            | Self::DialogTurnFailed { session_id, .. }
            | Self::ModelRoundStarted { session_id, .. }
            | Self::TextChunk { session_id, .. }
            | Self::ThinkingChunk { session_id, .. }
            | Self::ModelRoundCompleted { session_id, .. }
            | Self::ToolEvent { session_id, .. }
            | Self::WorkflowPhaseChanged { session_id, .. }
            | Self::PlanConfirmationNeeded { session_id, .. }
            | Self::PlanConfirmationResponded { session_id, .. }
            | Self::PlanAutoReviewStarted { session_id, .. }
            | Self::PlanAutoReviewCompleted { session_id, .. }
            | Self::PlanReviseRequested { session_id, .. }
            | Self::MemoryInjected { session_id, .. } => Some(session_id),
            Self::SystemError { session_id, .. } => session_id.as_deref(),
        }
    }

    pub fn default_priority(&self) -> AgentEventPriority {
        match self {
            Self::SystemError { .. }
            | Self::DialogTurnFailed { .. }
            | Self::DialogTurnCancelled { .. } => AgentEventPriority::Critical,

            Self::SessionStateChanged { .. }
            | Self::SessionTitleGenerated { .. }
            | Self::ContextCompressionFailed { .. }
            | Self::WorkflowPhaseChanged { .. }
            | Self::PlanConfirmationNeeded { .. }
            | Self::PlanConfirmationResponded { .. }
            | Self::PlanAutoReviewStarted { .. }
            | Self::PlanAutoReviewCompleted { .. }
            | Self::PlanReviseRequested { .. } => AgentEventPriority::High,

            Self::ImageAnalysisStarted { .. }
            | Self::ImageAnalysisCompleted { .. }
            | Self::TextChunk { .. }
            | Self::ThinkingChunk { .. }
            | Self::ModelRoundStarted { .. }
            | Self::ModelRoundCompleted { .. }
            | Self::TokenUsageUpdated { .. }
            | Self::DialogTurnCompleted { .. }
            | Self::ContextCompressionStarted { .. }
            | Self::ContextCompressionCompleted { .. } => AgentEventPriority::Normal,

            Self::ToolEvent { tool_event, .. } => tool_event.default_priority(),

            _ => AgentEventPriority::Low,
        }
    }
}

impl ToolEventData {
    pub fn default_priority(&self) -> AgentEventPriority {
        match self {
            Self::Cancelled { .. } => AgentEventPriority::Critical,

            Self::Started { .. }
            | Self::Completed { .. }
            | Self::Failed { .. }
            | Self::ConfirmationNeeded { .. } => AgentEventPriority::High,

            Self::EarlyDetected { .. }
            | Self::ParamsPartial { .. }
            | Self::Queued { .. }
            | Self::Waiting { .. }
            | Self::Progress { .. }
            | Self::Streaming { .. }
            | Self::StreamChunk { .. }
            | Self::Confirmed { .. }
            | Self::Rejected { .. } => AgentEventPriority::Normal,
        }
    }
}
