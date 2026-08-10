//! MCP server management module
//!
//! Manages MCP server process lifecycles, connections, and registration.

mod config;
mod connection;
mod manager;
mod process;
mod registry;

pub use config::{MCPServerConfig, MCPServerOAuthConfig, MCPServerTransport, MCPServerXaaConfig};
pub use connection::{MCPConnection, MCPConnectionPool};
pub use manager::MCPServerManager;
pub use process::{MCPServerProcess, MCPServerStatus, MCPServerType};
pub use registry::MCPServerRegistry;
