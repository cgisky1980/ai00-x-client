#![allow(non_snake_case)]
// Ai00-X Core Library - Platform-agnostic business logic
// Layers: Util -> Infrastructure -> Service (+ Routing / WebSearch)

pub mod infrastructure;
pub mod miniapp;
pub mod routing;
pub mod service;
pub mod util;
pub mod wallpaper;
pub mod websearch;
pub use infrastructure::debug_log as debug;

pub use util::errors::*;
pub use util::types::*;

pub use service::{
    config::{ConfigManager, ConfigService},
    workspace::{WorkspaceManager, WorkspaceProvider, WorkspaceService},
};

pub use infrastructure::{ai::set_ai00s_auth_token, ai::AIClient, events::BackendEventManager};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const CORE_NAME: &str = "Ai00-X Core";
