//! DTO Module

use ai00_x_core::service::remote_ssh::{normalize_remote_workspace_path, LOCAL_WORKSPACE_SSH_HOST};
use ai00_x_core::service::workspace::manager::WorkspaceKind;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceTypeDto {
    SingleProject,
    MultiProject,
    Documentation,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKindDto {
    Normal,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatisticsDto {
    pub total_files: usize,
    pub total_lines: usize,
    pub total_size: usize,
    pub files_by_language: HashMap<String, usize>,
    pub files_by_extension: HashMap<String, usize>,
    pub last_updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdentityDto {
    pub name: Option<String>,
    pub creature: Option<String>,
    pub vibe: Option<String>,
    pub emoji: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWorktreeInfoDto {
    pub path: String,
    pub branch: Option<String>,
    pub main_repo_path: String,
    pub is_main: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_repo_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfoDto {
    pub name: String,
    pub worktree_path: String,
    pub is_main: bool,
    pub is_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_changes: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfoDto {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub workspace_type: WorkspaceTypeDto,
    pub workspace_kind: WorkspaceKindDto,
    pub languages: Vec<String>,
    pub opened_at: String,
    pub last_accessed: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub statistics: Option<ProjectStatisticsDto>,
    pub identity: Option<WorkspaceIdentityDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorkspaceWorktreeInfoDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_name: Option<String>,
    #[serde(rename = "sshHost", skip_serializing_if = "Option::is_none")]
    pub ssh_host: Option<String>,
    #[serde(rename = "repoRootPath", skip_serializing_if = "Option::is_none")]
    pub repo_root_path: Option<String>,
    #[serde(rename = "activeBranch", skip_serializing_if = "Option::is_none")]
    pub active_branch: Option<String>,
    #[serde(
        rename = "availableBranches",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub available_branches: Vec<BranchInfoDto>,
}

impl WorkspaceInfoDto {
    pub fn from_workspace_info(
        info: &ai00_x_core::service::workspace::manager::WorkspaceInfo,
    ) -> Self {
        let connection_id = info
            .metadata
            .get("connectionId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let connection_name = info
            .metadata
            .get("connectionName")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let ssh_host = info
            .metadata
            .get("sshHost")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                if matches!(info.workspace_kind, WorkspaceKind::Remote) {
                    None
                } else {
                    Some(LOCAL_WORKSPACE_SSH_HOST.to_string())
                }
            });

        let root_path = if matches!(info.workspace_kind, WorkspaceKind::Remote) {
            normalize_remote_workspace_path(&info.root_path.to_string_lossy())
        } else {
            info.root_path.to_string_lossy().to_string()
        };

        Self {
            id: info.id.clone(),
            name: info.name.clone(),
            root_path,
            workspace_type: WorkspaceTypeDto::from_workspace_type(&info.workspace_type),
            workspace_kind: WorkspaceKindDto::from_workspace_kind(&info.workspace_kind),
            languages: info.languages.clone(),
            opened_at: info.opened_at.to_rfc3339(),
            last_accessed: info.last_accessed.to_rfc3339(),
            description: info.description.clone(),
            tags: info.tags.clone(),
            statistics: info
                .statistics
                .as_ref()
                .map(ProjectStatisticsDto::from_workspace_statistics),
            identity: info
                .identity
                .as_ref()
                .map(WorkspaceIdentityDto::from_workspace_identity),
            worktree: info
                .worktree
                .as_ref()
                .map(WorkspaceWorktreeInfoDto::from_workspace_worktree_info),
            connection_id,
            connection_name,
            ssh_host,
            repo_root_path: info
                .repo_root_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            active_branch: info.active_branch.clone(),
            available_branches: info
                .available_branches
                .iter()
                .map(|b| BranchInfoDto {
                    name: b.name.clone(),
                    worktree_path: b.worktree_path.clone(),
                    is_main: b.is_main,
                    is_active: b.is_active,
                    has_changes: b.has_changes,
                })
                .collect(),
        }
    }
}

impl WorkspaceIdentityDto {
    pub fn from_workspace_identity(
        identity: &ai00_x_core::service::workspace::manager::WorkspaceIdentity,
    ) -> Self {
        Self {
            name: identity.name.clone(),
            creature: identity.creature.clone(),
            vibe: identity.vibe.clone(),
            emoji: identity.emoji.clone(),
        }
    }
}

impl WorkspaceWorktreeInfoDto {
    pub fn from_workspace_worktree_info(
        info: &ai00_x_core::service::workspace::manager::WorkspaceWorktreeInfo,
    ) -> Self {
        Self {
            path: info.path.clone(),
            branch: info.branch.clone(),
            main_repo_path: info.main_repo_path.clone(),
            is_main: info.is_main,
            main_repo_name: info.main_repo_name.clone(),
        }
    }
}

impl WorkspaceTypeDto {
    pub fn from_workspace_type(
        workspace_type: &ai00_x_core::service::workspace::manager::WorkspaceType,
    ) -> Self {
        use ai00_x_core::service::workspace::manager::WorkspaceType;
        match workspace_type {
            WorkspaceType::RustProject
            | WorkspaceType::NodeProject
            | WorkspaceType::PythonProject
            | WorkspaceType::JavaProject
            | WorkspaceType::CppProject
            | WorkspaceType::WebProject
            | WorkspaceType::MobileProject => WorkspaceTypeDto::SingleProject,
            WorkspaceType::Other => WorkspaceTypeDto::Other,
        }
    }
}

impl WorkspaceKindDto {
    pub fn from_workspace_kind(
        workspace_kind: &ai00_x_core::service::workspace::manager::WorkspaceKind,
    ) -> Self {
        use ai00_x_core::service::workspace::manager::WorkspaceKind;
        match workspace_kind {
            WorkspaceKind::Normal => WorkspaceKindDto::Normal,
            WorkspaceKind::Remote => WorkspaceKindDto::Remote,
        }
    }
}

impl ProjectStatisticsDto {
    pub fn from_workspace_statistics(
        stats: &ai00_x_core::service::workspace::manager::WorkspaceStatistics,
    ) -> Self {
        Self {
            total_files: stats.total_files,
            total_lines: 0, // Temporarily set to 0 as the internal structure lacks this field
            total_size: stats.total_size_bytes as usize,
            files_by_language: HashMap::new(), // Temporarily empty, requires future implementation
            files_by_extension: stats.file_extensions.clone(),
            last_updated: stats
                .last_modified
                .map_or_else(|| chrono::Utc::now().to_rfc3339(), |dt| dt.to_rfc3339()),
        }
    }
}
