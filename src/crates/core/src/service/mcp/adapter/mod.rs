//! MCP adapter module
//!
//! Adapts MCP resources, prompts, and context to Ai00-X's service system.

mod context;
mod prompt;
mod resource;

pub use context::{ContextEnhancer, MCPContextProvider};
pub use prompt::PromptAdapter;
pub use resource::ResourceAdapter;
