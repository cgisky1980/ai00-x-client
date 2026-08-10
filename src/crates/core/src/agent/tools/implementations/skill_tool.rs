//! Skill tool implementation
//!
//! Progressive skill disclosure: minimal tool description, smart matching on demand.

use crate::agent::tools::framework::{
    Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::util::errors::Ai00XResult;
use async_trait::async_trait;
use log::{debug, info};
use serde_json::{json, Value};

use super::skills::{get_skill_registry, SkillLocation};

pub struct SkillTool;

impl SkillTool {
    pub fn new() -> Self {
        Self
    }

    fn minimal_description(&self) -> String {
        r#"Execute a skill by name to get specialized domain instructions.

<skills_instructions>
Skills provide domain knowledge and procedural guidance. Call with a skill name
to load its full instructions into context, or call with "list" to see all
available skills. Call without arguments to get AI-curated suggestions —
the system will analyze your current task and recommend the most relevant skills.
</skills_instructions>"#
            .to_string()
    }

    fn list_all_skills_xml(catalog: &[(String, String, bool)]) -> String {
        let mut xml = String::from("<available_skills>\n");
        for (name, desc, needs_enhancement) in catalog {
            let tag = if *needs_enhancement {
                " [needs enhancement]"
            } else {
                ""
            };
            xml.push_str(&format!(
                "<skill>\n  <name>{}{}</name>\n  <description>{}</description>\n</skill>\n",
                name, tag, desc
            ));
        }
        xml.push_str("</available_skills>");
        xml
    }
}

#[async_trait]
impl Tool for SkillTool {
    fn name(&self) -> &str {
        "Skill"
    }

    async fn description(&self) -> Ai00XResult<String> {
        Ok(self.minimal_description())
    }

    async fn description_with_context(
        &self,
        _context: Option<&ToolUseContext>,
    ) -> Ai00XResult<String> {
        Ok(self.minimal_description())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Skill name to load, \"list\" to see all, or empty for AI recommendations"
                }
            },
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
        _input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        if let Some(command) = input.get("command").and_then(|v| v.as_str()) {
            if command.is_empty() {
                return "Searching for relevant skills...".to_string();
            }
            if command == "list" {
                return "Listing all available skills...".to_string();
            }
            format!("The \"{}\" skill is loaded.", command)
        } else {
            "Searching for relevant skills...".to_string()
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        let command = input
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        if command.is_empty() {
            return self.smart_recommend(context).await;
        }

        if command == "list" {
            return self.list_skills(context).await;
        }

        if command.starts_with("mcp--") {
            return self.handle_mcp_skill(&command, context).await;
        }

        self.load_skill(&command, context).await
    }
}

impl SkillTool {
    async fn smart_recommend(&self, context: &ToolUseContext) -> Ai00XResult<Vec<ToolResult>> {
        let registry = get_skill_registry();
        let catalog = registry.get_skill_catalog(context.workspace_root()).await;

        if catalog.is_empty() {
            return Ok(vec![ToolResult::Result {
                data: json!({ "skills_found": 0 }),
                result_for_assistant: Some(
                    "No skills are currently available. You can install skills in the user or project skills directory."
                        .to_string(),
                ),
                image_attachments: None,
            }]);
        }

        let query = context
            .custom_data
            .get("original_user_input")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());

        if let Some(query) = query {
            let searcher = registry.get_hybrid_searcher().await;
            let searcher = searcher.read().await;
            let matches = searcher.search(query, 5).await;

            if !matches.is_empty() {
                let mut output = String::from("**Skills that match your task:**\n\n");
                for m in &matches {
                    if let Some((_, desc, _)) = catalog.iter().find(|(n, _, _)| n == &m.name) {
                        output.push_str(&format!("- **{}**: {}\n", m.name, desc));
                    }
                }
                output.push_str("\n---\n**All available skills:**\n\n");
                output.push_str(&SkillTool::list_all_skills_xml(&catalog));
                output.push_str(
                    "\n\nUse the Skill tool with a specific name to load its full instructions.",
                );

                return Ok(vec![ToolResult::Result {
                    data: json!({
                        "matched_skills": matches.iter().map(|m| &m.name).collect::<Vec<_>>(),
                        "total_skills": catalog.len(),
                    }),
                    result_for_assistant: Some(output),
                    image_attachments: None,
                }]);
            }
        }

        let mut output = String::from("**Skills that may help with your task:**\n\n");
        for (name, desc, _) in &catalog {
            output.push_str(&format!("- **{}**: {}\n", name, desc));
        }
        output.push_str("\nUse the Skill tool with a specific name to load its full instructions.");

        Ok(vec![ToolResult::Result {
            data: json!({
                "total_skills": catalog.len(),
            }),
            result_for_assistant: Some(output),
            image_attachments: None,
        }])
    }

    async fn list_skills(&self, context: &ToolUseContext) -> Ai00XResult<Vec<ToolResult>> {
        let registry = get_skill_registry();
        let catalog = registry.get_skill_catalog(context.workspace_root()).await;

        if catalog.is_empty() {
            return Ok(vec![ToolResult::Result {
                data: json!({ "count": 0 }),
                result_for_assistant: Some("No skills available.".to_string()),
                image_attachments: None,
            }]);
        }

        let mut output = String::from("**Available skills:**\n\n");
        output.push_str(&Self::list_all_skills_xml(&catalog));
        output.push_str(
            "\n\nUse the Skill tool with a specific skill name to load its full instructions.",
        );

        Ok(vec![ToolResult::Result {
            data: json!({ "count": catalog.len() }),
            result_for_assistant: Some(output),
            image_attachments: None,
        }])
    }

    async fn load_skill(
        &self,
        skill_name: &str,
        context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        debug!("Skill tool loading skill: {}", skill_name);

        let registry = get_skill_registry();
        let skill_data = if context.is_remote() {
            if let Some(ws_fs) = context.ws_fs() {
                let root = context
                    .workspace
                    .as_ref()
                    .map(|w| w.root_path_string())
                    .unwrap_or_default();
                registry
                    .find_and_load_skill_for_remote_workspace(skill_name, ws_fs, &root, None)
                    .await?
            } else {
                registry
                    .find_and_load_skill_for_workspace(skill_name, context.workspace_root(), None)
                    .await?
            }
        } else {
            registry
                .find_and_load_skill_for_workspace(skill_name, context.workspace_root(), None)
                .await?
        };

        let location_str = match skill_data.location {
            SkillLocation::User => "user",
            SkillLocation::Project => "project",
        };

        let result_for_assistant = format!(
            "Skill '{}' loaded successfully from {}.\n\n{}",
            skill_data.name, skill_data.path, skill_data.content
        );

        Ok(vec![ToolResult::Result {
            data: json!({
                "skill_name": skill_data.name,
                "description": skill_data.description,
                "location": location_str,
                "content": skill_data.content,
                "success": true
            }),
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }

    async fn handle_mcp_skill(
        &self,
        skill_name: &str,
        context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        let server_id = &skill_name[5..];

        let session_id = context.session_id.as_deref();
        let tool_names =
            match crate::service::mcp::adapter::tool::activate_mcp_tools(server_id, session_id)
                .await
            {
                Ok(names) => names,
                Err(e) => {
                    return Ok(vec![ToolResult::Result {
                        data: json!({
                            "success": false,
                            "error": format!("{}", e)
                        }),
                        result_for_assistant: Some(format!(
                        "Failed to activate MCP server '{}': {}. The server may not be connected.",
                        server_id, e
                    )),
                        image_attachments: None,
                    }]);
                }
            };

        let registry = get_skill_registry();
        let skill_body = match registry
            .find_and_load_skill_for_workspace(skill_name, context.workspace_root(), None)
            .await
        {
            Ok(data) => data.content,
            Err(_) => {
                format!(
                    "{} tools activated for MCP server '{}'.",
                    tool_names.len(),
                    server_id
                )
            }
        };

        let tool_list = tool_names
            .iter()
            .map(|n| format!("- `{}`", n))
            .collect::<Vec<_>>()
            .join("\n");

        let result_for_assistant = format!(
            "MCP server '{}' activated. {} tools now available:\n{}\n\nSkill instructions:\n{}",
            server_id,
            tool_names.len(),
            tool_list,
            skill_body
        );

        info!(
            "MCP skill '{}' activated: {} tools",
            skill_name,
            tool_names.len()
        );

        Ok(vec![ToolResult::Result {
            data: json!({
                "mcp_server_id": server_id,
                "activated_tools": tool_names,
                "tool_count": tool_names.len(),
                "success": true
            }),
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }
}

impl Default for SkillTool {
    fn default() -> Self {
        Self::new()
    }
}
