//! MCP tool adapter
//!
//! Wraps MCP tools as implementations of Ai00-X's `Tool` trait.

use crate::agent::tools::framework::{
    Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::service::mcp::protocol::{MCPTool, MCPToolResult};
use crate::service::mcp::server::MCPConnection;
use crate::util::errors::{Ai00XError, Ai00XResult};
use async_trait::async_trait;
use log::{debug, error, info, warn};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::RwLock;

/// Cached MCP tools for a server, not yet registered in ToolRegistry.
pub struct MCPCachedTools {
    pub server_name: String,
    pub server_id: String,
    pub tools: Vec<Arc<dyn Tool>>,
    pub activated_in_sessions: HashSet<String>,
}

static MCP_TOOL_CACHE: OnceLock<Arc<RwLock<Vec<MCPCachedTools>>>> = OnceLock::new();

fn get_mcp_tool_cache() -> Arc<RwLock<Vec<MCPCachedTools>>> {
    MCP_TOOL_CACHE
        .get_or_init(|| Arc::new(RwLock::new(Vec::new())))
        .clone()
}

pub async fn cache_mcp_tools(server_id: &str, server_name: &str, tools: Vec<Arc<dyn Tool>>) {
    let cache = get_mcp_tool_cache();
    let tool_count = tools.len();
    let mut guard = cache.write().await;
    if let Some(existing) = guard.iter_mut().find(|c| c.server_id == server_id) {
        existing.tools = tools;
        info!(
            "Updated MCP tool cache: server_id={} server_name={} tool_count={}",
            server_id, server_name, tool_count
        );
    } else {
        guard.push(MCPCachedTools {
            server_name: server_name.to_string(),
            server_id: server_id.to_string(),
            tools,
            activated_in_sessions: HashSet::new(),
        });
        info!(
            "Cached MCP tools: server_id={} server_name={} tool_count={}",
            server_id, server_name, tool_count
        );
    }
}

pub async fn activate_mcp_tools(
    server_id: &str,
    session_id: Option<&str>,
) -> Ai00XResult<Vec<String>> {
    let cache = get_mcp_tool_cache();
    let mut guard = cache.write().await;
    let entry = guard
        .iter_mut()
        .find(|c| c.server_id == server_id)
        .ok_or_else(|| {
            Ai00XError::tool(format!("MCP server '{}' not found in cache", server_id))
        })?;

    let registry = crate::agent::tools::registry::get_global_tool_registry();
    let mut registry_lock = registry.write().await;

    let mut tool_names = Vec::new();
    for tool in &entry.tools {
        let name = tool.name().to_string();
        if registry_lock.get_tool(&name).is_none() {
            registry_lock.register_tool(tool.clone());
            tool_names.push(name.clone());
            debug!("Activated MCP tool: name={} server_id={}", name, server_id);
        } else {
            tool_names.push(name.clone());
            debug!(
                "MCP tool already registered: name={} server_id={}",
                name, server_id
            );
        }
    }

    if let Some(sid) = session_id {
        entry.activated_in_sessions.insert(sid.to_string());
    }

    info!(
        "Activated {} MCP tools for server '{}' (session={:?})",
        tool_names.len(),
        server_id,
        session_id
    );
    Ok(tool_names)
}

pub async fn deactivate_mcp_tools(server_id: &str, session_id: Option<&str>) {
    let cache = get_mcp_tool_cache();
    let mut guard = cache.write().await;
    if let Some(entry) = guard.iter_mut().find(|c| c.server_id == server_id) {
        if let Some(sid) = session_id {
            entry.activated_in_sessions.remove(sid);
        }
        if session_id.is_none() || entry.activated_in_sessions.is_empty() {
            let registry = crate::agent::tools::registry::get_global_tool_registry();
            let mut registry_lock = registry.write().await;
            registry_lock.unregister_mcp_server_tools(server_id);
            entry.activated_in_sessions.clear();
            info!("Deactivated all MCP tools for server '{}'", server_id);
        }
    }
}

pub async fn get_cached_mcp_servers() -> Vec<MCPCachedInfo> {
    let cache = get_mcp_tool_cache();
    let guard = cache.read().await;
    guard
        .iter()
        .map(|c| MCPCachedInfo {
            server_id: c.server_id.clone(),
            server_name: c.server_name.clone(),
            tool_count: c.tools.len(),
            tool_names: c.tools.iter().map(|t| t.name().to_string()).collect(),
            is_activated: !c.activated_in_sessions.is_empty(),
        })
        .collect()
}

pub async fn remove_cached_server(server_id: &str) {
    let cache = get_mcp_tool_cache();
    let mut guard = cache.write().await;
    guard.retain(|c| c.server_id != server_id);
    info!("Removed MCP cache entry: server_id={}", server_id);
}

pub async fn cleanup_session_mcp_tools(session_id: &str) {
    let cache = get_mcp_tool_cache();
    let mut guard = cache.write().await;
    for entry in guard.iter_mut() {
        if entry.activated_in_sessions.remove(session_id) {
            info!(
                "Session '{}' deactivated from MCP server '{}'",
                session_id, entry.server_id
            );
        }
        if entry.activated_in_sessions.is_empty() && !entry.tools.is_empty() {
            let registry = crate::agent::tools::registry::get_global_tool_registry();
            let mut registry_lock = registry.write().await;
            registry_lock.unregister_mcp_server_tools(&entry.server_id);
            debug!(
                "All sessions deactivated, unregistered tools for server '{}'",
                entry.server_id
            );
        }
    }
}

pub struct MCPCachedInfo {
    pub server_id: String,
    pub server_name: String,
    pub tool_count: usize,
    pub tool_names: Vec<String>,
    pub is_activated: bool,
}

/// MCP tool wrapper that adapts an MCP tool to Ai00-X's `Tool`.
pub struct MCPToolWrapper {
    mcp_tool: MCPTool,
    connection: Arc<MCPConnection>,
    server_name: String,
    full_name: String,
}

impl MCPToolWrapper {
    const MAX_RESULT_TEXT_CHARS: usize = 12_000;

    /// Creates a new MCP tool wrapper.
    pub fn new(
        mcp_tool: MCPTool,
        connection: Arc<MCPConnection>,
        server_id: String,
        server_name: String,
    ) -> Self {
        let full_name = format!("mcp__{}__{}", server_id, mcp_tool.name);
        Self {
            mcp_tool,
            connection,
            server_name,
            full_name,
        }
    }

    fn annotations(&self) -> crate::service::mcp::protocol::MCPToolAnnotations {
        self.mcp_tool.annotations.clone().unwrap_or_default()
    }

    fn tool_title(&self) -> String {
        self.mcp_tool
            .annotations
            .as_ref()
            .and_then(|annotations| annotations.title.clone())
            .or_else(|| self.mcp_tool.title.clone())
            .unwrap_or_else(|| self.mcp_tool.name.clone())
    }

    fn behavior_hints(&self) -> Vec<&'static str> {
        let annotations = self.annotations();
        let mut hints = Vec::new();
        if annotations.read_only_hint.unwrap_or(false) {
            hints.push("read-only");
        }
        if annotations.destructive_hint.unwrap_or(false) {
            hints.push("destructive");
        }
        if annotations.open_world_hint.unwrap_or(false) {
            hints.push("open-world");
        }
        hints
    }

    pub fn mcp_tool(&self) -> &MCPTool {
        &self.mcp_tool
    }

    fn truncate_for_assistant(text: String) -> String {
        let char_count = text.chars().count();
        if char_count <= Self::MAX_RESULT_TEXT_CHARS {
            return text;
        }

        let truncated: String = text.chars().take(Self::MAX_RESULT_TEXT_CHARS).collect();
        format!(
            "{}\n[Result truncated: {} of {} characters shown]",
            truncated,
            Self::MAX_RESULT_TEXT_CHARS,
            char_count
        )
    }
}

#[async_trait]
impl Tool for MCPToolWrapper {
    fn name(&self) -> &str {
        // Use server_id as a prefix to avoid naming conflicts.
        // Example: mcp__github__search_repos
        &self.full_name
    }

    async fn description(&self) -> Ai00XResult<String> {
        let mut description = format!(
            "Tool '{}' from MCP server '{}': {}",
            self.tool_title(),
            self.server_name,
            self.mcp_tool.description.as_deref().unwrap_or("")
        );

        let hints = self.behavior_hints();
        if !hints.is_empty() {
            description.push_str(&format!(" [Hints: {}]", hints.join(", ")));
        }

        Ok(description)
    }

    fn input_schema(&self) -> Value {
        self.mcp_tool.input_schema.clone()
    }

    fn ui_resource_uri(&self) -> Option<String> {
        self.mcp_tool
            .meta
            .as_ref()
            .and_then(|m| m.ui.as_ref())
            .and_then(|u| u.resource_uri.clone())
    }

    fn user_facing_name(&self) -> String {
        format!("{} ({})", self.tool_title(), self.server_name)
    }

    async fn is_enabled(&self) -> bool {
        true
    }

    fn is_readonly(&self) -> bool {
        self.annotations().read_only_hint.unwrap_or(false)
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        self.is_readonly()
    }

    fn needs_permissions(&self, _input: Option<&Value>) -> bool {
        !self.is_readonly()
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if !input.is_object() {
            return ValidationResult {
                result: false,
                message: Some("Input must be an object".to_string()),
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

    fn render_result_for_assistant(&self, output: &Value) -> String {
        if let Ok(result) = serde_json::from_value::<MCPToolResult>(output.clone()) {
            if result.is_error {
                return format!("Error executing MCP tool '{}'", self.mcp_tool.name);
            }

            if let Some(contents) = result.content {
                let rendered = contents
                    .iter()
                    .map(|c| match c {
                        crate::service::mcp::protocol::MCPToolResultContent::Text { text } => {
                            text.clone()
                        }
                        crate::service::mcp::protocol::MCPToolResultContent::Image {
                            mime_type,
                            ..
                        } => format!("[Image: {}]", mime_type),
                        crate::service::mcp::protocol::MCPToolResultContent::Audio {
                            mime_type,
                            ..
                        } => format!("[Audio: {}]", mime_type),
                        crate::service::mcp::protocol::MCPToolResultContent::ResourceLink {
                            uri,
                            name,
                            ..
                        } => name.as_ref().map_or_else(
                            || uri.clone(),
                            |n| format!("[Resource: {} ({})]", n, uri),
                        ),
                        crate::service::mcp::protocol::MCPToolResultContent::Resource {
                            resource,
                        } => {
                            format!("[Resource: {}]", resource.uri)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                return Self::truncate_for_assistant(rendered);
            }

            if let Some(structured_content) = result.structured_content {
                return Self::truncate_for_assistant(structured_content.to_string());
            }
        }

        "MCP tool execution completed".to_string()
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        format!(
            "Using MCP tool '{}' from '{}' with input: {}",
            self.tool_title(),
            self.server_name,
            input
        )
    }

    fn render_tool_use_rejected_message(&self) -> String {
        format!(
            "MCP tool '{}' from '{}' was rejected by user",
            self.tool_title(),
            self.server_name
        )
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        format!(
            "MCP tool '{}' completed. Result: {}",
            self.tool_title(),
            self.render_result_for_assistant(output)
        )
    }

    async fn call_impl(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        info!(
            "Calling MCP tool: {} from server: {}",
            self.tool_title(),
            self.server_name
        );
        debug!(
            "Input: {}",
            serde_json::to_string_pretty(input).unwrap_or_else(|_| "invalid json".to_string())
        );

        let start = std::time::Instant::now();

        let result = self
            .connection
            .call_tool(&self.mcp_tool.name, Some(input.clone()))
            .await?;

        let elapsed = start.elapsed();
        debug!("MCP tool returned after {:?}", elapsed);

        let result_value = serde_json::to_value(&result)?;

        let result_for_assistant = self.render_result_for_assistant(&result_value);
        Ok(vec![ToolResult::Result {
            data: result_value,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }
}

/// MCP tool adapter that manages multiple MCP tool wrappers.
pub struct MCPToolAdapter {
    tools: Vec<Arc<dyn Tool>>,
    raw_mcp_tools: Vec<MCPTool>,
}

impl MCPToolAdapter {
    /// Creates a new tool adapter.
    pub fn new() -> Self {
        Self {
            tools: Vec::new(),
            raw_mcp_tools: Vec::new(),
        }
    }

    /// Loads tools from an MCP server.
    pub async fn load_tools_from_server(
        &mut self,
        server_id: &str,
        server_name: &str,
        connection: Arc<MCPConnection>,
    ) -> Ai00XResult<()> {
        info!(
            "Loading tools from MCP server: {} (id={})",
            server_name, server_id
        );

        let result = connection.list_tools(None).await.map_err(|e| {
            error!("list_tools call failed: {}", e);
            e
        })?;

        info!(
            "Found {} MCP tool(s) from server {}",
            result.tools.len(),
            server_name
        );

        if result.tools.is_empty() {
            warn!("Server {} provided no tools", server_name);
            return Ok(());
        }

        for mcp_tool in result.tools.into_iter() {
            let wrapper = Arc::new(MCPToolWrapper::new(
                mcp_tool.clone(),
                connection.clone(),
                server_id.to_string(),
                server_name.to_string(),
            ));
            self.raw_mcp_tools.push(mcp_tool);
            self.tools.push(wrapper);
        }

        info!(
            "Tool loading complete, adapter now has {} tool(s)",
            self.tools.len()
        );
        Ok(())
    }

    /// Returns all tools.
    pub fn get_tools(&self) -> &[Arc<dyn Tool>] {
        &self.tools
    }

    /// Returns raw MCP tool metadata (for skill generation etc.)
    pub fn get_raw_mcp_tools(&self) -> &[MCPTool] {
        &self.raw_mcp_tools
    }

    /// Clears all tools.
    pub fn clear(&mut self) {
        self.tools.clear();
        self.raw_mcp_tools.clear();
    }
}

impl Default for MCPToolAdapter {
    fn default() -> Self {
        Self::new()
    }
}
