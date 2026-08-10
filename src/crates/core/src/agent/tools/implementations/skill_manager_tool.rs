//! Skill Manager Tool — Agent-Managed Skill Creation & Editing
//!
//! Allows the agent to create, update, and delete skills in the user skills directory
//! (~/.ai00-x/skills/), turning successful approaches into reusable procedural knowledge.
//!
//! Actions:
//!   create — Create a new skill (SKILL.md + directory)
//!   edit   — Replace the SKILL.md content of a user skill
//!   delete — Remove a user skill entirely

use crate::agent::tools::framework::{
    Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::infrastructure::get_path_manager_arc;
use crate::util::errors::Ai00XResult;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::fs;

const MAX_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 1024;

pub struct SkillManagerTool;

impl SkillManagerTool {
    pub fn new() -> Self {
        Self
    }

    fn user_skills_dir() -> PathBuf {
        get_path_manager_arc().user_skills_dir()
    }
}

#[async_trait]
impl Tool for SkillManagerTool {
    fn name(&self) -> &str {
        "SkillManager"
    }

    async fn description(&self) -> Ai00XResult<String> {
        Ok(r#"Manage skills: create, edit, or delete skills in your personal skills directory.
Skills capture HOW to do specific types of tasks based on proven experience.
Use this after successfully completing a reusable task to encode the approach for future sessions.

Commands:
  create <name> <description> <content> [--keywords k1,k2] [--when_to_use "when"] [--group group-dir]
  edit <name> <description> <content> [--keywords k1,k2] [--when_to_use "when"]
  delete <name>

Arguments:
  name:        Short skill name (max 64 chars), used as the directory name
  description: Brief description of what the skill does (max 1024 chars)
  content:     Full markdown body of the skill (instructions, examples, references)
  --keywords:  Comma-separated search keywords (optional, auto-generated if omitted)
  --when_to_use: Trigger conditions describing when to load this skill
  --group:     Subdirectory group for organization (create only)

Only user-level skills (~/.ai00-x/skills/) can be managed. Built-in and project skills are read-only."#
            .to_string())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "enum": ["create", "edit", "delete"],
                    "description": "Action: create a new skill, edit an existing one, or delete one"
                },
                "name": {
                    "type": "string",
                    "description": "Skill name (max 64 chars). Used as directory name for the skill."
                },
                "description": {
                    "type": "string",
                    "description": "Brief description of what the skill does (max 1024 chars). Required for create and edit."
                },
                "content": {
                    "type": "string",
                    "description": "Full markdown body of the skill — instructions, examples, references. Required for create and edit."
                },
                "keywords": {
                    "type": "string",
                    "description": "Comma-separated keywords for search. Optional — auto-generated from name+description if omitted."
                },
                "when_to_use": {
                    "type": "string",
                    "description": "Conditions describing when the agent should load this skill. Optional."
                },
                "group": {
                    "type": "string",
                    "description": "Subdirectory group for organizing skills (create only). Optional."
                }
            },
            "required": ["command"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    fn needs_permissions(&self, input: Option<&Value>) -> bool {
        input
            .and_then(|v| v.get("command"))
            .and_then(|v| v.as_str())
            .map(|c| c == "delete")
            .unwrap_or(false)
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let command = input.get("command").and_then(|v| v.as_str()).unwrap_or("");

        if !matches!(command, "create" | "edit" | "delete") {
            return ValidationResult {
                result: false,
                message: Some("command must be one of: create, edit, delete".to_string()),
                error_code: Some(1),
                meta: None,
            };
        }

        if command == "create" || command == "edit" {
            let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                return ValidationResult {
                    result: false,
                    message: Some("name is required for create and edit".to_string()),
                    error_code: Some(2),
                    meta: None,
                };
            }
            if name.len() > MAX_NAME_LENGTH {
                return ValidationResult {
                    result: false,
                    message: Some(format!("name must be <= {} characters", MAX_NAME_LENGTH)),
                    error_code: Some(3),
                    meta: None,
                };
            }

            let desc = input
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if desc.is_empty() {
                return ValidationResult {
                    result: false,
                    message: Some("description is required for create and edit".to_string()),
                    error_code: Some(4),
                    meta: None,
                };
            }
            if desc.len() > MAX_DESCRIPTION_LENGTH {
                return ValidationResult {
                    result: false,
                    message: Some(format!(
                        "description must be <= {} characters",
                        MAX_DESCRIPTION_LENGTH
                    )),
                    error_code: Some(5),
                    meta: None,
                };
            }

            let content = input.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if content.is_empty() {
                return ValidationResult {
                    result: false,
                    message: Some("content is required for create and edit".to_string()),
                    error_code: Some(6),
                    meta: None,
                };
            }
        }

        if command == "delete" {
            let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                return ValidationResult {
                    result: false,
                    message: Some("name is required for delete".to_string()),
                    error_code: Some(2),
                    meta: None,
                };
            }
        }

        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let command = input.get("command").and_then(|v| v.as_str()).unwrap_or("?");
        let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        match command {
            "create" => format!("Creating skill '{}'...", name),
            "edit" => format!("Editing skill '{}'...", name),
            "delete" => format!("Deleting skill '{}'...", name),
            _ => format!("SkillManager: {}", command),
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        let command = input.get("command").and_then(|v| v.as_str()).unwrap_or("");

        match command {
            "create" => self.create_skill(input).await,
            "edit" => self.edit_skill(input).await,
            "delete" => self.delete_skill(input).await,
            _ => Ok(vec![ToolResult::Result {
                data: json!({"success": false, "error": format!("Unknown command: {}", command)}),
                result_for_assistant: Some(format!("Unknown command: {}", command)),
                image_attachments: None,
            }]),
        }
    }
}

impl SkillManagerTool {
    fn sanitize_dir_name(name: &str) -> String {
        name.to_lowercase()
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect::<String>()
            .trim_matches('-')
            .to_string()
    }

    fn build_frontmatter(
        name: &str,
        description: &str,
        keywords: Option<&str>,
        when_to_use: Option<&str>,
    ) -> String {
        let mut fm = String::from("---\n");
        fm.push_str(&format!("name: {}\n", name));
        fm.push_str(&format!("description: {}\n", description));

        if let Some(kw) = keywords {
            let trimmed = kw.trim();
            if !trimmed.is_empty() {
                let kw_list: Vec<&str> = trimmed
                    .split(',')
                    .map(|k| k.trim())
                    .filter(|k| !k.is_empty())
                    .collect();
                if !kw_list.is_empty() {
                    fm.push_str("keywords:\n");
                    for k in kw_list {
                        fm.push_str(&format!("  - {}\n", k));
                    }
                }
            }
        }

        if let Some(wtu) = when_to_use {
            let trimmed = wtu.trim();
            if !trimmed.is_empty() {
                fm.push_str(&format!("when_to_use: {}\n", trimmed));
            }
        }

        fm.push_str("---\n\n");
        fm
    }

    async fn create_skill(&self, input: &Value) -> Ai00XResult<Vec<ToolResult>> {
        let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let description = input
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let content = input.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let keywords = input.get("keywords").and_then(|v| v.as_str());
        let when_to_use = input.get("when_to_use").and_then(|v| v.as_str());
        let group = input.get("group").and_then(|v| v.as_str());

        let dir_name = Self::sanitize_dir_name(name);
        let skills_root = Self::user_skills_dir();

        let skill_dir = if let Some(group_dir) = group {
            let g = Self::sanitize_dir_name(group_dir);
            if g.is_empty() {
                skills_root.join(&dir_name)
            } else {
                skills_root.join(&g).join(&dir_name)
            }
        } else {
            skills_root.join(&dir_name)
        };

        if fs::try_exists(&skill_dir).await.unwrap_or(false) {
            return Ok(vec![ToolResult::Result {
                data: json!({"success": false, "error": format!("Skill directory already exists: {}", skill_dir.display())}),
                result_for_assistant: Some(format!(
                    "Skill '{}' already exists at {}. Use 'edit' to update it or 'delete' first to recreate.",
                    name, skill_dir.display()
                )),
                image_attachments: None,
            }]);
        }

        fs::create_dir_all(&skill_dir).await.map_err(|e| {
            crate::util::errors::Ai00XError::tool(format!(
                "Failed to create skill directory: {}",
                e
            ))
        })?;

        let frontmatter = Self::build_frontmatter(name, description, keywords, when_to_use);
        let skill_md = format!("{}{}", frontmatter, content);
        let skill_md_path = skill_dir.join("SKILL.md");

        fs::write(&skill_md_path, &skill_md).await.map_err(|e| {
            crate::util::errors::Ai00XError::tool(format!("Failed to write SKILL.md: {}", e))
        })?;

        Ok(vec![ToolResult::Result {
            data: json!({
                "success": true,
                "name": name,
                "path": skill_dir.to_string_lossy(),
                "action": "created"
            }),
            result_for_assistant: Some(format!(
                "Skill '{}' created successfully at {}. It will be available in the next session (or after Skill tool list refreshes).",
                name, skill_dir.display()
            )),
            image_attachments: None,
        }])
    }

    async fn edit_skill(&self, input: &Value) -> Ai00XResult<Vec<ToolResult>> {
        let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let description = input
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let content = input.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let keywords = input.get("keywords").and_then(|v| v.as_str());
        let when_to_use = input.get("when_to_use").and_then(|v| v.as_str());

        let dir_name = Self::sanitize_dir_name(name);
        let skills_root = Self::user_skills_dir();

        let skill_dirs = Self::find_skill_dir(&skills_root, &dir_name).await;

        if skill_dirs.is_empty() {
            return Ok(vec![ToolResult::Result {
                data: json!({"success": false, "error": format!("Skill '{}' not found in user skills directory", name)}),
                result_for_assistant: Some(format!(
                    "Skill '{}' not found in {}. Only user-level skills can be edited.",
                    name,
                    skills_root.display()
                )),
                image_attachments: None,
            }]);
        }

        let skill_dir = &skill_dirs[0];
        let frontmatter = Self::build_frontmatter(name, description, keywords, when_to_use);
        let skill_md = format!("{}{}", frontmatter, content);
        let skill_md_path = skill_dir.join("SKILL.md");

        fs::write(&skill_md_path, &skill_md).await.map_err(|e| {
            crate::util::errors::Ai00XError::tool(format!("Failed to write SKILL.md: {}", e))
        })?;

        Ok(vec![ToolResult::Result {
            data: json!({
                "success": true,
                "name": name,
                "path": skill_dir.to_string_lossy(),
                "action": "edited"
            }),
            result_for_assistant: Some(format!(
                "Skill '{}' updated successfully at {}.",
                name,
                skill_dir.display()
            )),
            image_attachments: None,
        }])
    }

    async fn delete_skill(&self, input: &Value) -> Ai00XResult<Vec<ToolResult>> {
        let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let dir_name = Self::sanitize_dir_name(name);
        let skills_root = Self::user_skills_dir();

        let skill_dirs = Self::find_skill_dir(&skills_root, &dir_name).await;

        if skill_dirs.is_empty() {
            return Ok(vec![ToolResult::Result {
                data: json!({"success": false, "error": format!("Skill '{}' not found in user skills directory", name)}),
                result_for_assistant: Some(format!(
                    "Skill '{}' not found in {}. Only user-level skills can be deleted.",
                    name,
                    skills_root.display()
                )),
                image_attachments: None,
            }]);
        }

        let skill_dir = &skill_dirs[0];
        fs::remove_dir_all(skill_dir).await.map_err(|e| {
            crate::util::errors::Ai00XError::tool(format!("Failed to delete skill: {}", e))
        })?;

        Ok(vec![ToolResult::Result {
            data: json!({
                "success": true,
                "name": name,
                "path": skill_dir.to_string_lossy(),
                "action": "deleted"
            }),
            result_for_assistant: Some(format!(
                "Skill '{}' deleted successfully from {}.",
                name,
                skill_dir.display()
            )),
            image_attachments: None,
        }])
    }

    async fn find_skill_dir(skills_root: &PathBuf, dir_name: &str) -> Vec<PathBuf> {
        let mut results = Vec::new();

        let direct_path = skills_root.join(dir_name);
        if fs::try_exists(&direct_path).await.unwrap_or(false) {
            if let Ok(md) = fs::metadata(&direct_path).await {
                if md.is_dir() {
                    let skill_md = direct_path.join("SKILL.md");
                    if fs::try_exists(&skill_md).await.unwrap_or(false) {
                        results.push(direct_path);
                        return results;
                    }
                }
            }
        }

        if let Ok(mut entries) = fs::read_dir(skills_root).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Ok(ft) = entry.file_type().await {
                    if ft.is_dir() {
                        let sub_path = entry.path().join(dir_name);
                        if fs::try_exists(&sub_path).await.unwrap_or(false) {
                            if let Ok(md) = fs::metadata(&sub_path).await {
                                if md.is_dir() {
                                    let skill_md = sub_path.join("SKILL.md");
                                    if fs::try_exists(&skill_md).await.unwrap_or(false) {
                                        results.push(sub_path);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        results
    }
}

impl Default for SkillManagerTool {
    fn default() -> Self {
        Self::new()
    }
}
