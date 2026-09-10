pub mod adapters;
pub mod emitter;
pub mod events;
/// Ai00-X Transport Layer
///
/// Cross-platform communication abstraction layer, supports:
/// - Tauri (app.emit)
pub mod traits;
pub use emitter::TransportEmitter;
pub use events::{
    BackendEventPayload, FileWatchEventPayload, LspEventPayload, ProfileEventPayload,
    SnapshotEventPayload,
};
pub use traits::TransportAdapter;

#[cfg(feature = "tauri-adapter")]
pub use adapters::TauriTransportAdapter;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
