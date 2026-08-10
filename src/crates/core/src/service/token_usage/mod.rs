//! Token usage tracking service
//!
//! Tracks and persists token consumption statistics per model, session, and turn.

mod service;
mod subscriber;
mod types;

pub use service::TokenUsageService;
pub use subscriber::TokenUsageSubscriber;
pub use types::{
    ModelTokenStats, SessionTokenStats, TimeRange, TokenUsageQuery, TokenUsageRecord,
    TokenUsageSummary,
};

use std::sync::{Arc, OnceLock};

static GLOBAL_TOKEN_USAGE_SERVICE: OnceLock<Arc<TokenUsageService>> = OnceLock::new();

pub fn set_global_token_usage_service(service: Arc<TokenUsageService>) {
    let _ = GLOBAL_TOKEN_USAGE_SERVICE.set(service);
}

pub fn get_global_token_usage_service() -> Option<Arc<TokenUsageService>> {
    GLOBAL_TOKEN_USAGE_SERVICE.get().cloned()
}
