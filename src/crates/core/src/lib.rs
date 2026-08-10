#![allow(non_snake_case)]
// Ai00-X Core Library - Platform-agnostic business logic
// Four-layer architecture: Util -> Infrastructure -> Service -> Agent

pub mod agent;
pub mod function_agents;
pub mod infrastructure;
pub mod miniapp;
pub mod service;
pub mod util;
pub mod wallpaper;
pub use infrastructure::debug_log as debug;

pub use util::errors::*;
pub use util::types::*;

pub use service::{
    config::{ConfigManager, ConfigService},
    workspace::{WorkspaceManager, WorkspaceProvider, WorkspaceService},
};

pub use infrastructure::{ai::set_ai00s_auth_token, ai::AIClient, events::BackendEventManager};

pub use agent::{
    core::{DialogTurn, Message, ModelRound, Session},
    events::{AgentEvent, EventQueue, EventRouter},
    execution::{ExecutionEngine, StreamProcessor},
    tools::{Tool, ToolPipeline},
};

pub use agent::tools::registry::ToolRegistry;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const CORE_NAME: &str = "Ai00-X Core";
