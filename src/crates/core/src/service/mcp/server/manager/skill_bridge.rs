//! MCP <-> Skill bridge
//!
//! Generates and manages Skill files for MCP servers, enabling progressive tool disclosure
//! where MCP tools are only activated when the LLM explicitly calls the corresponding Skill.

use crate::service::mcp::protocol::MCPTool;
use crate::util::errors::Ai00XResult;
use log::{error, info, warn};
use std::path::PathBuf;

pub const MCP_SKILL_PREFIX: &str = "mcp--";

pub struct MCPSkillBridge;

impl MCPSkillBridge {
    pub fn generate_mcp_skill(server_id: &str, server_name: &str, tools: &[MCPTool]) -> String {
        let tool_list = tools
            .iter()
            .map(|t| {
                format!(
                    "- `mcp__{}__{}` — {}",
                    server_id,
                    t.name,
                    t.description.as_deref().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        format!(
            r#"---
name: mcp--{server_id}
description: MCP server '{server_name}' — {tool_count} tools available
mode: Core
mcp_server_id: {server_id}
---
# {server_name} MCP Server

This skill provides access to the `{server_name}` MCP server.

## Available Tools

{tool_list}

## Usage

When you need to interact with `{server_name}`, activate this skill first by calling the `Skill` tool with `command: "mcp--{server_id}"`.
Once activated, the tools listed above become available for use.

## Activation

- To activate: Use the `Skill` tool with `command: "mcp--{server_id}"`
- To deactivate: Use the `MCPDeactivate` tool with `server_id: "{server_id}"`
"#,
            server_id = server_id,
            server_name = server_name,
            tool_count = tools.len(),
            tool_list = tool_list,
        )
    }

    pub async fn install_mcp_skill(
        workspace_root: &str,
        server_id: &str,
        server_name: &str,
        tools: &[MCPTool],
    ) -> Ai00XResult<()> {
        let skill_content = Self::generate_mcp_skill(server_id, server_name, tools);

        let skill_dir = PathBuf::from(workspace_root)
            .join(".ai00-x")
            .join("skills")
            .join(format!("{}{}", MCP_SKILL_PREFIX, server_id));

        tokio::fs::create_dir_all(&skill_dir).await.map_err(|e| {
            error!(
                "Failed to create MCP skill directory: path={} error={}",
                skill_dir.display(),
                e
            );
            crate::util::errors::Ai00XError::tool(format!(
                "Failed to create MCP skill directory: {}",
                e
            ))
        })?;

        let skill_path = skill_dir.join("SKILL.md");

        let existing = if skill_path.exists() {
            Some(
                tokio::fs::read_to_string(&skill_path)
                    .await
                    .unwrap_or_default(),
            )
        } else {
            None
        };

        if existing.as_deref() == Some(&skill_content) {
            info!(
                "MCP skill already up-to-date: server_id={} path={}",
                server_id,
                skill_path.display()
            );
            return Ok(());
        }

        tokio::fs::write(&skill_path, &skill_content)
            .await
            .map_err(|e| {
                error!(
                    "Failed to write MCP skill file: path={} error={}",
                    skill_path.display(),
                    e
                );
                crate::util::errors::Ai00XError::tool(format!(
                    "Failed to write MCP skill file: {}",
                    e
                ))
            })?;

        info!(
            "Installed MCP skill: server_id={} path={} {}",
            server_id,
            skill_path.display(),
            if existing.is_some() {
                "(updated)"
            } else {
                "(new)"
            }
        );

        Ok(())
    }

    pub async fn remove_mcp_skill(workspace_root: &str, server_id: &str) {
        let skill_dir = PathBuf::from(workspace_root)
            .join(".ai00-x")
            .join("skills")
            .join(format!("{}{}", MCP_SKILL_PREFIX, server_id));

        if skill_dir.exists() {
            match tokio::fs::remove_dir_all(&skill_dir).await {
                Ok(()) => {
                    info!("Removed MCP skill directory: path={}", skill_dir.display());
                }
                Err(e) => {
                    warn!(
                        "Failed to remove MCP skill directory: path={} error={}",
                        skill_dir.display(),
                        e
                    );
                }
            }
        }
    }
}
