use super::skill_bridge::MCPSkillBridge;
use super::*;
use crate::service::mcp::adapter::tool;

impl MCPServerManager {
    pub(super) async fn refresh_mcp_tools(
        &self,
        server_id: &str,
        server_name: &str,
        connection: Arc<MCPConnection>,
    ) -> Ai00XResult<usize> {
        Self::unregister_mcp_tools(server_id).await;
        Self::register_mcp_tools(server_id, server_name, connection).await
    }

    /// Loads MCP tools from server and caches them (does NOT register to ToolRegistry).
    /// Also generates/updates the corresponding Skill file.
    pub(super) async fn register_mcp_tools(
        server_id: &str,
        server_name: &str,
        connection: Arc<MCPConnection>,
    ) -> Ai00XResult<usize> {
        info!(
            "Loading MCP tools for caching: server_name={} server_id={}",
            server_name, server_id
        );

        let mut adapter = MCPToolAdapter::new();

        adapter
            .load_tools_from_server(server_id, server_name, connection)
            .await
            .map_err(|e| {
                error!(
                    "Failed to load tools from MCP server: server_name={} server_id={} error={}",
                    server_name, server_id, e
                );
                e
            })?;

        let tools = adapter.get_tools();
        let tool_count = tools.len();
        let raw_mcp_tools = adapter.get_raw_mcp_tools().to_vec();

        for tool in tools {
            debug!(
                "Loaded MCP tool: name={} server={}",
                tool.name(),
                server_name
            );
        }

        let tool_arcs = tools.to_vec();
        tool::cache_mcp_tools(server_id, server_name, tool_arcs).await;

        let workspace_root = crate::service::workspace::get_global_workspace_service()
            .and_then(|svc| svc.try_get_current_workspace_path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());
        if let Err(e) = MCPSkillBridge::install_mcp_skill(
            &workspace_root,
            server_id,
            server_name,
            &raw_mcp_tools,
        )
        .await
        {
            warn!(
                "Failed to install MCP skill: server_id={} error={}",
                server_id, e
            );
        }

        info!(
            "Cached {} MCP tools and installed Skill: server_name={} server_id={}",
            tool_count, server_name, server_id
        );

        Ok(tool_count)
    }

    /// Unregisters MCP tools from the global tool registry if activated,
    /// and removes the cached entry and Skill file.
    pub(super) async fn unregister_mcp_tools(server_id: &str) {
        tool::deactivate_mcp_tools(server_id, None).await;
        tool::remove_cached_server(server_id).await;

        let workspace_root = crate::service::workspace::get_global_workspace_service()
            .and_then(|svc| svc.try_get_current_workspace_path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());
        MCPSkillBridge::remove_mcp_skill(&workspace_root, server_id).await;

        info!(
            "Unregistered MCP tools and removed Skill: server_id={}",
            server_id
        );
    }
}
