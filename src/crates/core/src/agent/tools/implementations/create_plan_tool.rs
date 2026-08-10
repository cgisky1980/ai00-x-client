//! CreatePlan tool implementation
//!
//! Used to create and store plan files during the planning phase

use crate::agent::tools::framework::{Tool, ToolResult, ToolUseContext};
use crate::util::errors::{Ai00XError, Ai00XResult};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::fs;

#[derive(Serialize)]
struct PlanFrontmatter {
    name: String,
    overview: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    todos: Vec<TodoItem>,
}

#[derive(Serialize)]
struct TodoItem {
    id: String,
    content: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    assignee: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    dependencies: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
}

/// CreatePlan tool - create plan file
pub struct CreatePlanTool;

impl CreatePlanTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CreatePlanTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for CreatePlanTool {
    fn name(&self) -> &str {
        "CreatePlan"
    }

    async fn description(&self) -> Ai00XResult<String> {
        Ok(r###"This tool is the CORE of the planning workflow. The PLAN.md file drives the entire execution.

CRITICAL: Before calling this tool, you MUST:
1. Use AskUserQuestion for ANY unclear, ambiguous, or underspecified requirements
2. Never make assumptions about user intent — always ask first
3. Present the plan to the user for review after creation
4. If the user has feedback → edit the PLAN.md and ask again
5. Only proceed to execution after the user explicitly confirms the plan

The plan file includes:
- Background: Why this work is needed
- Implementation Approach: How to accomplish it
- Execution Strategy: Which steps can run in parallel
- File Change List: Which files will be modified
- Open Questions: Items that were clarified through user communication

The plan should be:
- Properly formatted in markdown, using appropriate sections and headers
- Very concise and actionable, providing the minimum amount of detail for the user to understand and action the plan
- The first line MUST BE A TITLE formatted as a level 1 markdown heading

It may be helpful to identify the most important files you will change and existing code you will leverage.
When mentioning files, use markdown links with the full file path (for example, `[backend/src/foo.ts](backend/src/foo.ts)`).

You should provide a structured list of implementation todos:
- Each todo should be a clear, specific, and actionable task that can be tracked and completed
- If the plan is simple, you should provide just a few high-level todos or none at all
- Each todo needs:
    - A clear, unique ID (e.g., "setup-auth", "implement-ui", "add-tests")
    - A descriptive content explaining what needs to be done
    - An optional assignee (e.g., "CoreAgent" for main agent, "Task(Explore)" for subagent delegation)
    - Optional dependencies (IDs of todos that must complete before this one starts)
    - Todos with no dependencies and assigned to subagents can be executed in PARALLEL

PARALLEL EXECUTION:
- Todos with no dependencies and assigned to subagents (Task type) can run in parallel
- Todos assigned to CoreAgent run sequentially
- Group parallel todos in the Execution Strategy section of the plan

UPDATING THE PLAN:
- This tool creates a NEW plan file each time it is called
- The plan file path returned in the tool result may be an absolute runtime path (local) or a `ai00-x://runtime/...` URI (remote)
- To update an existing plan, read and edit the plan file directly using your file editing tools
- Do NOT call CreatePlan again to update an existing plan

Additional guidelines:
- Avoid asking clarifying questions in the plan itself. Ask them before calling this tool. Present these to the user using the AskUserQuestion tool.
- After calling this tool, you should end the conversation turn. Briefly tell the user where the plan file is. Do NOT repeat the plan content again.
- Todos help break down complex plans into manageable, trackable tasks
- Focus on high-level meaningful decisions rather than low-level implementation details
- A good plan is glanceable, not a wall of text."###
        .to_string())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["name", "overview", "plan"],
            "properties": {
                "name": {
                    "type": "string",
                    "description": "A short 3-4 word name for the plan."
                },
                "overview": {
                    "type": "string",
                    "description": "A 1-2 sentence high-level description of the plan that summarizes what will be accomplished"
                },
                "plan": {
                    "type": "string",
                    "description": "The plan you came up with"
                },
                "todos": {
                    "type": "array",
                    "description": "Array of implementation todos",
                    "items": {
                        "type": "object",
                        "required": ["id", "content"],
                        "properties": {
                            "id": {
                                "type": "string",
                                "description": "Unique identifier for the todo"
                            },
                            "content": {
                                "type": "string",
                                "description": "Description of the todo task"
                            },
                            "assignee": {
                                "type": "string",
                                "description": "Who executes this todo. 'CoreAgent' for main agent (sequential), 'Task(Explore)'/'Task(CodeReview)' for subagent delegation (can be parallel). Default: CoreAgent"
                            },
                            "dependencies": {
                                "type": "array",
                                "description": "Array of todo IDs that must be completed before this todo can start. Empty array = can start immediately (parallel with other no-dependency todos)",
                                "items": {
                                    "type": "string"
                                }
                            }
                        }
                    }
                }
            }
        })
    }

    fn is_readonly(&self) -> bool {
        // Only writes plan file, doesn't modify code
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        // Parse parameters
        let name = input
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or(Ai00XError::validation("Missing required field: name"))?;

        let overview = input
            .get("overview")
            .and_then(|v| v.as_str())
            .ok_or(Ai00XError::validation("Missing required field: overview"))?;

        let plan = input
            .get("plan")
            .and_then(|v| v.as_str())
            .ok_or(Ai00XError::validation("Missing required field: plan"))?;

        let todos = input.get("todos").and_then(|v| v.as_array());

        let plan_file_name = "PLAN.md".to_string();

        let file_content = generate_plan_file_content(name, overview, plan, todos);

        let runtime_context = context.ensure_current_workspace_runtime().await?;
        let session_id = context
            .session_id
            .as_ref()
            .ok_or(Ai00XError::tool("session_id not available in tool context"))?;
        let session_dir = runtime_context.session_dir(session_id);
        fs::create_dir_all(&session_dir)
            .await
            .map_err(|e| Ai00XError::tool(format!("Failed to create session dir: {}", e)))?;
        let plan_file_path = session_dir.join(&plan_file_name);
        fs::write(&plan_file_path, &file_content)
            .await
            .map_err(|e| Ai00XError::tool(format!("Failed to write plan file: {}", e)))?;
        let plan_file_path_str = plan_file_path.to_string_lossy().to_string();

        // Process todos for return result
        let processed_todos: Vec<Value> = if let Some(todos_arr) = todos {
            todos_arr
                .iter()
                .map(|todo| {
                    let mut todo_obj = todo.clone();
                    if let Some(obj) = todo_obj.as_object_mut() {
                        if !obj.contains_key("status") {
                            obj.insert("status".to_string(), json!("pending"));
                        }
                        if !obj.contains_key("assignee") {
                            obj.insert("assignee".to_string(), json!("CoreAgent"));
                        }
                    }
                    todo_obj
                })
                .collect()
        } else {
            vec![]
        };

        // Prefer workspace-relative computer:// links, but fall back to an
        // absolute computer:// path when plans live outside the workspace tree.
        let computer_link = context
            .workspace_root()
            .and_then(|root| {
                std::path::Path::new(&plan_file_path_str)
                    .strip_prefix(root)
                    .ok()
                    .map(|rel| format!("computer://{}", rel.to_string_lossy().replace('\\', "/")))
            })
            .unwrap_or_else(|| format!("computer://{}", plan_file_path_str.replace('\\', "/")));

        let plan_reference = context.build_runtime_artifact_reference(&format!(
            "sessions/{}/{}",
            session_id, plan_file_name
        ))?;

        let result_for_assistant = format!(
            "Plan file created at: {}
Clickable link for user: [{}]({})
The plan is now awaiting user confirmation. Wait for the user to confirm before executing. \
Show the clickable link to the user. If the user confirms, you will be notified to start executing.",
            plan_reference,
            plan_file_name,
            computer_link,
        );

        let result = json!({
            "success": true,
            "plan_file_path": plan_reference,
            "computer_link": computer_link.clone(),
            "plan_file_name": plan_file_name,
            "name": name,
            "overview": overview,
            "todos": processed_todos
        });

        Ok(vec![ToolResult::Result {
            data: result,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }
}

/// Generate plan file content
fn generate_plan_file_content(
    name: &str,
    overview: &str,
    plan: &str,
    todos: Option<&Vec<Value>>,
) -> String {
    let now = chrono::Utc::now().to_rfc3339();

    let todos_vec: Vec<TodoItem> = todos
        .map(|arr| {
            arr.iter()
                .filter_map(|todo| {
                    let id = todo.get("id").and_then(|v| v.as_str())?;
                    let content = todo.get("content").and_then(|v| v.as_str())?;
                    let assignee = todo
                        .get("assignee")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    let dependencies = todo
                        .get("dependencies")
                        .and_then(|v| v.as_array())
                        .map(|deps| {
                            deps.iter()
                                .filter_map(|d| d.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();

                    Some(TodoItem {
                        id: id.to_string(),
                        content: content.to_string(),
                        status: "pending".to_string(),
                        assignee,
                        dependencies,
                        started_at: None,
                        completed_at: None,
                        result: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let frontmatter = PlanFrontmatter {
        name: name.to_string(),
        overview: overview.to_string(),
        status: "planning".to_string(),
        created_at: Some(now.clone()),
        updated_at: Some(now),
        todos: todos_vec,
    };

    let yaml = serde_yaml::to_string(&frontmatter).unwrap_or_default();

    format!("---\n{}---\n\n{}", yaml, plan)
}
