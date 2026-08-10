pub mod activity;
pub mod agent;
pub mod graph;
pub mod maintenance;
pub mod manager;
pub mod pending;
pub mod prompt;
pub mod sidecar;
pub mod types;

pub use agent::{cleanup_session, ensure_agent, try_get_agent, MemoryAgentHandle};
pub use graph::MemoryGraph;
pub use maintenance::{spawn_retrieval_maintenance, MAINTENANCE_COUNTER};
pub use manager::MemoryManager;
pub use types::{
    Edge, EdgeKind, EmbeddingProviderTrait, GraphMetadata, MemoryCategory, MemoryEntry,
    MemoryEventKind, MemoryScope, MemoryState, Reinforcement, TagEntry, TrustLevel,
};
