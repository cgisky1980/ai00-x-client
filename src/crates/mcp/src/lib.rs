//! Ai00-X MCP (Model Context Protocol) crate
//!
//! This crate will contain MCP server management, protocol types, and tools.
//! Currently under active development — MCP tools and service infrastructure
//! reside in `ai00-x-core` for dependency simplification.
//!
//! ## Planned contents
//! - MCP protocol types (re-export from rmcp)
//! - MCP server connection management
//! - MCP tool implementations (ListMCPResourcesTool, ReadMCPResourceTool, etc.)
//! - MCP prompt and resource adapters
//!
//! ## Dependency direction
//! - `ai00-x-mcp` → `ai00-x-tool-framework` (Tool trait)
//! - `ai00-x-mcp` → `ai00-x-core` (MCP infrastructure)
//! - `ai00-x-core` does NOT depend on `ai00-x-mcp` (no circular dependency)
//!
//! ## Registration pattern
//! MCP tools are registered externally via `ai00_x_mcp::register_mcp_tools(registry)`.
//! The binary (desktop app, Ai00-S) calls this during initialization.

/// Placeholder: MCP tools will be registered here.
///
/// ```ignore
/// pub fn register_mcp_tools(registry: &ai00_x_core::agent::tools::registry::ToolRegistry) {
///     registry.register_mcp_tools();
/// }
/// ```
pub fn register_mcp_tools() {
    // TODO: Move MCP tool implementations from core here
    log::debug!("ai00-x-mcp: tool registration not yet implemented");
}
