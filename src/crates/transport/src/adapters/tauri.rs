//! Tauri transport adapter
//!
//! Uses Tauri's app.emit() system to send events to frontend
//! Maintains compatibility with current implementation

#[cfg(feature = "tauri-adapter")]
use crate::traits::TransportAdapter;
#[cfg(feature = "tauri-adapter")]
use async_trait::async_trait;
#[cfg(feature = "tauri-adapter")]
use tauri::{AppHandle, Emitter};

/// Tauri transport adapter
#[cfg(feature = "tauri-adapter")]
pub struct TauriTransportAdapter {
    app_handle: AppHandle,
}

#[cfg(feature = "tauri-adapter")]
impl TauriTransportAdapter {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
}

#[cfg(feature = "tauri-adapter")]
impl std::fmt::Debug for TauriTransportAdapter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TauriTransportAdapter")
            .field("adapter_type", &"tauri")
            .finish()
    }
}

#[cfg(feature = "tauri-adapter")]
#[async_trait]
impl TransportAdapter for TauriTransportAdapter {
    async fn emit_generic(
        &self,
        event_name: &str,
        payload: serde_json::Value,
    ) -> anyhow::Result<()> {
        self.app_handle.emit(event_name, payload)?;
        Ok(())
    }

    fn adapter_type(&self) -> &str {
        "tauri"
    }
}
