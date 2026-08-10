/// Ai00-X API Layer
///
/// Platform-agnostic business logic layer, used by:
/// - Tauri Desktop (apps/desktop)
pub mod dto;
pub mod handlers;

pub use dto::*;
pub use handlers::*;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
