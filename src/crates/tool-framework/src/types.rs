//! Shared types for the tool framework.

/// Image attachment in a tool result (re-exported from ai-adapters).
pub use ai00_x_ai_adapters::types::ToolImageAttachment;

/// Options controlling how tool messages are rendered in the chat UI.
#[derive(Debug, Clone)]
pub struct ToolRenderOptions {
    /// When true, render verbose descriptions (e.g., full paths). When false, use short form.
    pub verbose: bool,
}
