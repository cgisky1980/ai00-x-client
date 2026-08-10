//! MCP Deactivate tool
//!
//! Lets the LLM manually deactivate an MCP server to free context window space.
//! When deactivated, the server's tools are unregistered from ToolRegistry.

use crate::agent::tools::framework::{
    Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::util::errors::Ai00XResult;
use async_trait::async_trait;
use log::{debug, info};
use serde_json::{json, Value};

pub struct MCPDeactivateTool;

impl MCPDeactivateTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for MCPDeactivateTool {
    fn name(&self) -> &str {
        "MCPDeactivate"
    }

    async fn description(&self) -> Ai00XResult<String> {
        Ok(r#"Deactivate an MCP server and unregister its tools.
Use this when you no longer need tools from a specific MCP server to free context window space.
Parameters:
- server_id: The MCP server ID to deactivate (e.g., "github", "filesystem")"#
            .to_string())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server_id": {
                    "type": "string",
                    "description": "The MCP server ID to deactivate (e.g., the name after 'mcp--' prefix)"
                }
            },
            "required": ["server_id"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn needs_permissions(&self, _input: Option<&Value>) -> bool {
        false
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if input
            .get("server_id")
            .and_then(|v| v.as_str())
            .is_none_or(|s| s.is_empty())
        {
            return ValidationResult {
                result: false,
                message: Some("server_id is required and cannot be empty".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let server_id = input
            .get("server_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        format!("Deactivating MCP server '{}'", server_id)
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        let server_id = input
            .get("server_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                crate::util::errors::Ai00XError::tool("server_id is required".to_string())
            })?;

        debug!("Deactivating MCP server: {}", server_id);

        let session_id = context.session_id.as_deref();
        crate::service::mcp::adapter::tool::deactivate_mcp_tools(server_id, session_id).await;

        info!(
            "MCP server '{}' deactivated (session={:?})",
            server_id, session_id
        );

        Ok(vec![ToolResult::Result {
            data: json!({
                "server_id": server_id,
                "success": true,
                "message": format!("MCP server '{}' deactivated. Its tools are no longer available.", server_id)
            }),
            result_for_assistant: Some(format!(
                "MCP server '{}' deactivated successfully. Its tools have been unregistered to free context window space.",
                server_id
            )),
            image_attachments: None,
        }])
    }
}

impl Default for MCPDeactivateTool {
    fn default() -> Self {
        Self::new()
    }
}
