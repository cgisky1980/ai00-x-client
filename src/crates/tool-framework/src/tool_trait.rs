//! The `Tool` trait — the core interface all tools must implement.
//!
//! Tools are registered in a `ToolRegistry` and invoked by the execution engine
//! through this trait. The trait is object-safe, enabling `Arc<dyn Tool>` storage.

use crate::error::ToolError;
use crate::permission::PermissionLevel;
use crate::tool_context::ToolUseContext;
use crate::tool_result::{ToolResult, ValidationResult};
use crate::types::ToolRenderOptions;
use async_trait::async_trait;
use serde_json::Value;

/// Core tool trait.
///
/// All tools must implement this trait. Methods have default implementations
/// where sensible, minimizing boilerplate for tool authors.
#[async_trait]
pub trait Tool: Send + Sync {
    /// Unique tool name (e.g., "read", "bash", "web_search").
    async fn name(&self) -> &str;

    /// Human-readable description shown to the agent.
    async fn description(&self) -> String;

    /// The agent/system prompt description for when this tool is available.
    /// Defaults to `description()`.
    async fn prompt_description(&self) -> String {
        self.description().await
    }

    /// JSON Schema of the tool's input parameters.
    async fn input_schema(&self) -> Value;

    /// Permission level required to use this tool.
    async fn permission_level(&self) -> PermissionLevel;

    /// Whether this tool supports the given input (for validation caching / routing).
    async fn is_supported(&self, _input: &Value) -> bool {
        true
    }

    /// Get rendering options for this tool's output in the chat UI.
    async fn render_options(&self) -> ToolRenderOptions {
        ToolRenderOptions { verbose: false }
    }

    /// Validate tool input before execution.
    async fn validate(&self, input: &Value) -> ValidationResult {
        let _ = input;
        ValidationResult::default()
    }

    /// Execute the tool with the given input and context.
    ///
    /// Returns a sequence of `ToolResult` values. Tools that produce streaming
    /// output may return multiple `StreamChunk` variants followed by a final `Result`.
    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> Result<Vec<ToolResult>, ToolError>;

    /// Unified entry point with cancellation support.
    ///
    /// Wraps `call_impl` with cancellation token checking.
    /// Users should call this instead of `call_impl` directly.
    async fn call(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> Result<Vec<ToolResult>, ToolError> {
        if let Some(token) = &context.cancellation_token {
            tokio::select! {
                result = self.call_impl(input, context) => result,
                _ = token.cancelled() => {
                    Err(ToolError::cancelled("Tool execution cancelled"))
                }
            }
        } else {
            self.call_impl(input, context).await
        }
    }
}
