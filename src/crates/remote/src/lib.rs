//! Ai00-X Remote crate
//!
//! SSH remote workspace management and remote connect relay.
//! Currently under active development — SSH and remote code resides
//! in `ai00-x-core` behind the `ssh-remote` and `remote-connect` feature gates.
//!
//! ## Planned contents
//! - SSH workspace management (russh-based)
//! - Remote connect relay client
//! - Remote workspace state manager
//!
//! ## Dependency direction
//! - `ai00-x-remote` → `ai00-x-tool-framework` (Tool trait)
//! - `ai00-x-remote` → `ai00-x-core` (workspace types)
//! - `ai00-x-core` does NOT depend on `ai00-x-remote` (no circular dependency)
//!
//! ## Feature gates
//! - `ssh-remote`: Enables russh-based SSH workspace support (enabled by default)

/// Placeholder: remote workspace initialization.
pub fn initialize() {
    // TODO: Move remote SSH management from core here
    log::debug!("ai00-x-remote: not yet implemented");
}
