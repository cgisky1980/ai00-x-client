//! Tool permission levels.
//!
//! Defines the three permission tiers used by the tool system.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Permission level for tool execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum PermissionLevel {
    /// Read-only — no side effects (e.g., Read, Grep, LS).
    ReadOnly,
    /// Workspace write — can modify workspace files (e.g., Write, Edit, Bash).
    WorkspaceWrite,
    /// Danger full access — system-level operations (e.g., Bash with full shell).
    DangerFullAccess,
}

impl fmt::Display for PermissionLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PermissionLevel::ReadOnly => write!(f, "ReadOnly"),
            PermissionLevel::WorkspaceWrite => write!(f, "WorkspaceWrite"),
            PermissionLevel::DangerFullAccess => write!(f, "DangerFullAccess"),
        }
    }
}
