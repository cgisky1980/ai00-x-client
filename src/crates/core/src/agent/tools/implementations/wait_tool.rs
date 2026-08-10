//! WaitTool — pause execution for a configurable number of seconds.
//!
//! Use cases:
//! - Wait for a rate-limit quota to reset (e.g. 60s before retrying an API)
//! - Wait for a background job to finish
//! - Add a delay between polling attempts

use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::sleep;

use crate::agent::tools::framework::{Tool, ToolRenderOptions, ToolResult, ToolUseContext};
use crate::util::errors::{Ai00XError, Ai00XResult};

/// Maximum wait time: 5 minutes (300s). Prevents the agent from blocking
/// indefinitely on a single wait call.
const MAX_WAIT_SECS: u64 = 300;

pub struct WaitTool;

impl Default for WaitTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WaitTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for WaitTool {
    fn name(&self) -> &str {
        "Wait"
    }

    async fn description(&self) -> Ai00XResult<String> {
        Ok(r#"Pause execution for a specified number of seconds, then resume.

Use this tool when you need to:
- Wait for a rate-limit quota to reset before retrying an API call (e.g. wait 60s when a "429 Too Many Requests" or quota-exceeded error occurs)
- Wait for a background process or task to complete
- Add a delay between polling attempts (e.g. check status every 10s)

Parameters:
- seconds (required): Number of seconds to wait, between 1 and 300 (5 min max)
- reason (optional): A short description of why you are waiting

The tool respects cancellation — if the session is cancelled mid-wait, it
returns immediately with a cancellation error.

Usage examples:
1. Wait 60s for rate-limit reset:
   Wait(seconds=60, reason="AnySearch quota exceeded, waiting for reset")

2. Wait 5s between polling:
   Wait(seconds=5, reason="polling build status")"#.to_string())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "seconds": {
                    "type": "integer",
                    "description": "Number of seconds to wait (1–300)",
                    "minimum": 1,
                    "maximum": MAX_WAIT_SECS
                },
                "reason": {
                    "type": "string",
                    "description": "Optional short reason for the wait (e.g. 'quota reset', 'polling')"
                }
            },
            "required": ["seconds"]
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        let secs = output.get("seconds").and_then(|v| v.as_u64()).unwrap_or(0);
        let reason = output.get("reason").and_then(|v| v.as_str());
        match reason {
            Some(r) => format!("Waited {}s ({}) — ready to continue.", secs, r),
            None => format!("Waited {}s — ready to continue.", secs),
        }
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let secs = input.get("seconds").and_then(|v| v.as_u64()).unwrap_or(0);
        let reason = input.get("reason").and_then(|v| v.as_str());
        match reason {
            Some(r) => format!("Waiting {}s ({})", secs, r),
            None => format!("Waiting {}s", secs),
        }
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        let secs = output.get("seconds").and_then(|v| v.as_u64()).unwrap_or(0);
        format!("Waited {}s — resumed", secs)
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        let secs = input
            .get("seconds")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| Ai00XError::validation("Missing required field: seconds"))?;

        if secs == 0 {
            return Err(Ai00XError::validation("seconds must be at least 1"));
        }
        if secs > MAX_WAIT_SECS {
            return Err(Ai00XError::validation(format!(
                "seconds must be at most {} (5 minutes)",
                MAX_WAIT_SECS
            )));
        }

        let reason = input
            .get("reason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let duration = Duration::from_secs(secs);

        // Sleep, but bail out early if the session is cancelled.
        if let Some(token) = context.cancellation_token.as_ref() {
            tokio::select! {
                _ = sleep(duration) => {}
                _ = token.cancelled() => {
                    return Err(Ai00XError::Cancelled(
                        "Wait was cancelled by the user".to_string(),
                    ));
                }
            }
        } else {
            sleep(duration).await;
        }

        let result = json!({
            "seconds": secs,
            "reason": reason,
            "status": "completed"
        });

        let result_for_assistant = self.render_result_for_assistant(&result);

        Ok(vec![ToolResult::Result {
            data: result,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }
}
