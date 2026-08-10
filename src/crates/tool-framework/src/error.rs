//! Tool error type — simple string-based error for tool operations.
//!
//! Convertible to/from common error types used in tool implementations.

use std::fmt;

/// Error type for tool operations.
///
/// Simple string-based error that avoids depending on `ai00-x-core`'s `Ai00XError`.
/// Core provides `From<ToolError> for Ai00XError` for seamless conversion.
#[derive(Debug, Clone)]
pub struct ToolError(pub String);

impl ToolError {
    /// Create a new tool error from a string.
    pub fn tool(msg: impl Into<String>) -> Self {
        Self(msg.into())
    }

    /// Create a cancelled error.
    pub fn cancelled(msg: impl Into<String>) -> Self {
        Self(msg.into())
    }

    /// Get the error message.
    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Tool error: {}", self.0)
    }
}

impl std::error::Error for ToolError {}

impl From<String> for ToolError {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for ToolError {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl From<anyhow::Error> for ToolError {
    fn from(e: anyhow::Error) -> Self {
        Self(e.to_string())
    }
}

impl From<std::io::Error> for ToolError {
    fn from(e: std::io::Error) -> Self {
        Self(e.to_string())
    }
}

impl From<serde_json::Error> for ToolError {
    fn from(e: serde_json::Error) -> Self {
        Self(e.to_string())
    }
}
