//! Application path infrastructure.
//!
//! Centralizes path policy for user data, caches, sessions, and workspace-adjacent storage.
//!
//! ## Modules
//!
//! - `path_manager`: Provides `PathManager` for computing storage paths.
//! - `path_migration`: Auto-migrates legacy data to the unified install-dir layout.

pub mod path_manager;
pub mod path_migration;

pub use path_manager::{get_path_manager_arc, try_get_path_manager_arc, PathManager, StorageLevel};
