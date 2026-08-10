//! Ai00-X Tool Framework
//!
//! Core tool trait, types, and execution context shared across all tool implementations.
//! This crate has zero dependency on ai00-x-core, enabling other crates
//! (mcp, remote, etc.) to implement tools without circular dependencies.

pub mod error;
pub mod permission;
pub mod tool_context;
pub mod tool_result;
pub mod tool_trait;
pub mod types;

pub use error::ToolError;
pub use permission::PermissionLevel;
pub use tool_context::ToolUseContext;
pub use tool_result::{ToolResult, ValidationResult};
pub use tool_trait::Tool;
pub use types::{ToolImageAttachment, ToolRenderOptions};
