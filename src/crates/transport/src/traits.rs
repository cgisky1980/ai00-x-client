/// Transport Layer - Cross-platform communication traits
///
/// This module defines unified interfaces for cross-platform communication, supports:
/// - Tauri (app.emit events)
use async_trait::async_trait;

/// Transport adapter trait - All platforms must implement this interface
#[async_trait]
pub trait TransportAdapter: Send + Sync + std::fmt::Debug {
    /// Emit generic event (supports any event type)
    async fn emit_generic(
        &self,
        event_name: &str,
        payload: serde_json::Value,
    ) -> anyhow::Result<()>;

    /// Get adapter type name
    fn adapter_type(&self) -> &str;
}
