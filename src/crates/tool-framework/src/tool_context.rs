//! Tool execution context.
//!
//! `ToolUseContext` carries metadata passed from the execution engine to each tool invocation.
//! Workspace-specific fields (`workspace`, `workspace_services`, `computer_use_host`) are
//! provided via a type-erased extension slot — core and downstream crates access them
//! through extension methods.

use serde_json::Value;
use std::any::Any;
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;

/// Context passed to each tool invocation by the execution engine.
///
/// Contains session metadata, cancellation support, and an extension slot
/// for domain-specific fields (workspace binding, services, computer use host, etc.)
/// that are provided by downstream crates.
#[derive(Default)]
pub struct ToolUseContext {
    /// The tool call ID, if this invocation corresponds to a specific model tool call.
    pub tool_call_id: Option<String>,
    /// The agent type that initiated this tool call (e.g., "Core", "Router").
    pub agent_type: Option<String>,
    /// The session ID for the current conversation.
    pub session_id: Option<String>,
    /// The dialog turn ID for the current turn.
    pub dialog_turn_id: Option<String>,
    /// Arbitrary custom data that tools can read/write.
    pub custom_data: HashMap<String, Value>,
    /// Cancellation token — tools should check this to support early termination.
    pub cancellation_token: Option<CancellationToken>,
    /// Extension slot for domain-specific fields.
    /// Core populates this with `CoreToolContextExtension` for workspace, services, host, etc.
    #[doc(hidden)]
    pub extension: Option<Box<dyn Any + Send + Sync>>,
}

// Manual Debug impl to avoid requiring Any: Debug
impl std::fmt::Debug for ToolUseContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolUseContext")
            .field("tool_call_id", &self.tool_call_id)
            .field("agent_type", &self.agent_type)
            .field("session_id", &self.session_id)
            .field("dialog_turn_id", &self.dialog_turn_id)
            .field("custom_data", &self.custom_data)
            .field("cancellation_token", &self.cancellation_token)
            .field(
                "extension",
                &self.extension.as_ref().map(|_| "<extension present>"),
            )
            .finish()
    }
}

// Manual Clone impl — extension is shallow-cloned (not supported)
impl Clone for ToolUseContext {
    fn clone(&self) -> Self {
        Self {
            tool_call_id: self.tool_call_id.clone(),
            agent_type: self.agent_type.clone(),
            session_id: self.session_id.clone(),
            dialog_turn_id: self.dialog_turn_id.clone(),
            custom_data: self.custom_data.clone(),
            cancellation_token: self.cancellation_token.clone(),
            // Extensions cannot be cloned — downstream must re-set after cloning
            extension: None,
        }
    }
}

impl ToolUseContext {
    /// Create a new empty context.
    pub fn new() -> Self {
        Self::default()
    }
}
