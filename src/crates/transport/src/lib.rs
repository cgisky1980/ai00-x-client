pub mod adapters;
pub mod emitter;
pub mod event_bus;
pub mod events;
/// Ai00-X Transport Layer
///
/// Cross-platform communication abstraction layer, supports:
/// - Tauri (app.emit)
pub mod traits;
pub use emitter::TransportEmitter;
pub use event_bus::{EventBus, EventPriority};
pub use events::{
    AgentEventPayload, BackendEventPayload, FileWatchEventPayload, LspEventPayload,
    ProfileEventPayload, SnapshotEventPayload, UnifiedEvent,
};
pub use traits::{StreamEvent, TextChunk, ToolEventPayload, ToolEventType, TransportAdapter};

#[cfg(feature = "tauri-adapter")]
pub use adapters::TauriTransportAdapter;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
