//! Wallpaper agent tools — for AI-powered wallpaper creation.

use crate::agent::tools::framework::{Tool, ToolResult, ToolUseContext};
use crate::util::errors::{Ai00XError, Ai00XResult};
use crate::wallpaper::service;
use async_trait::async_trait;
use serde_json::{json, Value};

// ============================================================================
// ListMyWallpapersTool
// ============================================================================

pub struct ListMyWallpapersTool;

impl ListMyWallpapersTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ListMyWallpapersTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for ListMyWallpapersTool {
    fn name(&self) -> &str {
        "ListMyWallpapers"
    }

    async fn description(&self) -> Ai00XResult<String> {
        Ok("List all saved wallpaper projects. Returns id, name, description, and timestamps for each project."
            .to_string())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn call_impl(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        let projects = service::list_projects().map_err(|e| Ai00XError::tool(e.to_string()))?;

        let project_list: Vec<Value> = projects
            .iter()
            .map(|p| {
                json!({
                    "id": p.id,
                    "name": p.name,
                    "description": p.description,
                    "tags": p.tags,
                    "createdAt": p.created_at.to_rfc3339(),
                    "updatedAt": p.updated_at.to_rfc3339(),
                })
            })
            .collect();

        Ok(vec![ToolResult::Result {
            data: json!({ "projects": project_list, "count": project_list.len() }),
            result_for_assistant: Some(format!(
                "Found {} saved wallpaper project(s).",
                project_list.len()
            )),
            image_attachments: None,
        }])
    }
}
