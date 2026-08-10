//! Skill management module
//!
//! Provides Skill registry, loading, and configuration management functionality

pub mod builtin;
pub mod embedding_provider;
pub mod hybrid_search;
pub mod keyword_index;
pub mod registry;
pub mod rrf;
pub mod types;
pub mod vector_index;

pub use registry::SkillRegistry;
pub use types::{SkillData, SkillInfo, SkillLocation};

/// Get global Skill registry instance
pub fn get_skill_registry() -> &'static SkillRegistry {
    SkillRegistry::global()
}
