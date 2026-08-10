use crate::TransportAdapter;
use ai00_x_events::EventEmitter;
use async_trait::async_trait;
/// TransportEmitter - EventEmitter implementation based on TransportAdapter
///
/// This is the bridge connecting core layer and transport layer
use std::sync::Arc;

/// TransportEmitter - Implements EventEmitter using TransportAdapter
#[derive(Clone)]
pub struct TransportEmitter {
    adapter: Arc<dyn TransportAdapter>,
}

impl TransportEmitter {
    pub fn new(adapter: Arc<dyn TransportAdapter>) -> Self {
        Self { adapter }
    }
}

#[async_trait]
impl EventEmitter for TransportEmitter {
    async fn emit(&self, event_name: &str, payload: serde_json::Value) -> anyhow::Result<()> {
        self.adapter.emit_generic(event_name, payload).await
    }
}

impl std::fmt::Debug for TransportEmitter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransportEmitter")
            .field("adapter_type", &self.adapter.adapter_type())
            .finish()
    }
}
