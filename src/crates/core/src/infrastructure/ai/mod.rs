//! AI infrastructure
//!
//! Provides AI clients and related services

pub mod client_factory;
pub mod tool_call_accumulator;

pub use ai00_x_ai_adapters::providers;
pub use ai00_x_ai_adapters::stream as ai_stream_handlers;

pub use ai00_x_ai_adapters::{AIClient, StreamResponse};
pub use client_factory::{
    ai00_s_internal_token, get_global_ai_client_factory, initialize_global_ai_client_factory,
    set_ai00s_auth_token, AIClientFactory,
};
