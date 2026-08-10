//! Agent API

use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::api::app_state::AppState;
use crate::api::session_storage_path::desktop_effective_session_storage_path;
use ai00_x_core::agent::coordination::{
    ConversationCoordinator, DialogScheduler, DialogSubmissionPolicy, DialogTriggerSource,
};
use ai00_x_core::agent::core::*;
use ai00_x_core::agent::image_analysis::ImageContextData;
use ai00_x_core::agent::persistence::PersistenceManager;
use ai00_x_core::agent::tools::image_context::get_image_context;
use ai00_x_core::infrastructure::PathManager;
use ai00_x_git::git_types::{GitAddParams, GitCommitParams};
use ai00_x_git::GitService;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub session_id: Option<String>,
    pub session_name: String,
    pub agent_type: String,
    pub workspace_path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
    pub config: Option<SessionConfigDTO>,
    #[serde(default)]
    pub creation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigDTO {
    pub max_context_tokens: Option<usize>,
    pub auto_compact: Option<bool>,
    pub enable_tools: Option<bool>,
    pub safe_mode: Option<bool>,
    pub max_turns: Option<usize>,
    pub enable_context_compression: Option<bool>,
    pub compression_threshold: Option<f32>,
    pub model_name: Option<String>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub session_name: String,
    pub agent_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionModelRequest {
    pub session_id: String,
    pub model_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionTitleRequest {
    pub session_id: String,
    pub title: String,
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDialogTurnRequest {
    pub session_id: String,
    pub user_input: String,
    pub original_user_input: Option<String>,
    pub agent_type: String,
    pub workspace_path: Option<String>,
    pub turn_id: Option<String>,
    #[serde(default)]
    pub image_contexts: Option<Vec<ImageContextData>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDialogTurnResponse {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactSessionRequest {
    pub session_id: String,
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureCoordinatorSessionRequest {
    pub session_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub session_id: String,
    pub session_name: String,
    pub agent_type: String,
    pub state: String,
    pub turn_count: usize,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelDialogTurnRequest {
    pub session_id: String,
    pub dialog_turn_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelToolRequest {
    pub tool_use_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionRequest {
    pub session_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSessionRequest {
    pub session_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsRequest {
    pub workspace_path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmToolRequest {
    pub session_id: String,
    pub tool_id: String,
    pub updated_input: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectToolRequest {
    pub session_id: String,
    pub tool_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanConfirmationRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviseRequest {
    pub session_id: String,
    pub feedback: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSessionTitleRequest {
    pub session_id: String,
    pub user_message: String,
    pub max_length: Option<usize>,
}

async fn cleanup_sandbox_branch(repo_path: &str, branch: &str) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    let worktree_dir = std::path::Path::new(repo_path)
        .join(".tasks")
        .join(branch.replace('/', "-"));
    let worktree_str = worktree_dir.to_string_lossy().to_string();

    if worktree_dir.exists() {
        match GitService::remove_worktree(repo_path, &worktree_str, true).await {
            Ok(_) => info!(
                "Removed worktree '{}' for branch '{}'",
                worktree_str, branch
            ),
            Err(e) => {
                let msg = format!("Failed to remove worktree for branch '{}': {}", branch, e);
                warn!("{}", msg);
                errors.push(msg);
            }
        }
    }

    match GitService::delete_branch(repo_path, branch, true).await {
        Ok(_) => info!("Deleted branch '{}'", branch),
        Err(e) => {
            let msg = format!("Failed to delete branch '{}': {}", branch, e);
            warn!("{}", msg);
            errors.push(msg);
        }
    }

    errors
}

async fn load_sandbox_branch_from_metadata(request: &DeleteSessionRequest) -> Option<String> {
    let path_manager = match PathManager::new() {
        Ok(pm) => std::sync::Arc::new(pm),
        Err(_) => return None,
    };
    let persistence = match PersistenceManager::new(path_manager) {
        Ok(pm) => pm,
        Err(_) => return None,
    };
    let workspace_buf = std::path::PathBuf::from(&request.workspace_path);
    match persistence
        .load_session_metadata(&workspace_buf, &request.session_id)
        .await
    {
        Ok(Some(metadata)) => metadata.sandbox_branch,
        _ => None,
    }
}

fn check_repo_dirty(repo_path: &str) -> bool {
    use ai00_x_core::util::process_manager;
    match process_manager::create_command("git")
        .args(["status", "--porcelain"])
        .current_dir(repo_path)
        .output()
    {
        Ok(out) => !String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        Err(e) => {
            warn!(
                "Failed to check repo dirty status at '{}': {}",
                repo_path, e
            );
            true
        }
    }
}

async fn get_abort_merge_if_needed(repo_path: &str) {
    match GitService::has_conflicts(repo_path).await {
        Ok(true) => {
            warn!(
                "Repository at '{}' has unmerged conflicts, attempting abort",
                repo_path
            );
            let _ = GitService::abort_merge(repo_path).await;
        }
        Ok(false) => {}
        Err(e) => warn!(
            "Failed to check conflicts for abort at '{}': {}",
            repo_path, e
        ),
    }
}

async fn update_session_status_to_archived(session_id: &str, workspace_path: &str) {
    let path_manager = match PathManager::new() {
        Ok(pm) => std::sync::Arc::new(pm),
        Err(e) => {
            warn!("Failed to create path manager for archive update: {}", e);
            return;
        }
    };
    let persistence = match PersistenceManager::new(path_manager) {
        Ok(pm) => pm,
        Err(e) => {
            warn!(
                "Failed to create persistence manager for archive update: {}",
                e
            );
            return;
        }
    };

    let workspace_buf = std::path::PathBuf::from(workspace_path);
    match persistence
        .load_session_metadata(&workspace_buf, session_id)
        .await
    {
        Ok(Some(mut metadata)) => {
            metadata.status = ai00_x_core::service::session::SessionStatus::Archived;
            metadata.last_active_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            match persistence
                .save_session_metadata(&workspace_buf, &metadata)
                .await
            {
                Ok(_) => info!("Session {} status updated to Archived", session_id),
                Err(e) => warn!(
                    "Failed to save archived status for session {}: {}",
                    session_id, e
                ),
            }
        }
        Ok(None) => {
            warn!(
                "No metadata found for session {} when updating archive status",
                session_id
            );
        }
        Err(e) => {
            warn!(
                "Failed to load metadata for archive update on session {}: {}",
                session_id, e
            );
        }
    }
}

async fn resolve_merge_conflicts_with_llm(
    repo_path: &str,
    branch: &str,
    _app_state: &AppState,
) -> Result<bool, String> {
    use ai00_x_core::util::process_manager;

    let output = process_manager::create_command("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to list conflict files: {}", e))?;

    let conflict_files: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    if conflict_files.is_empty() {
        return Err("No conflict files found".to_string());
    }

    let mut conflict_preview = String::new();
    for file in &conflict_files {
        if let Ok(content) = std::fs::read_to_string(std::path::Path::new(repo_path).join(file)) {
            let lines: Vec<&str> = content.lines().collect();
            let preview: Vec<&str> = lines.iter().take(80).copied().collect();
            conflict_preview.push_str(&format!(
                "--- {} ({} lines total) ---\n{}\n",
                file,
                lines.len(),
                preview.join("\n")
            ));
        }
    }

    warn!(
        "Merge conflict for branch '{}': {} files conflicted:\n{}",
        branch,
        conflict_files.len(),
        conflict_preview
    );

    Err(format!(
        "Merge conflicts in {} file(s): {}. Auto-resolution not yet available; please resolve manually or retry with AI assistance enabled.",
        conflict_files.len(),
        conflict_files.join(", ")
    ))
}

async fn detect_default_branch(repo_path: &str) -> String {
    match GitService::get_branches(repo_path, false).await {
        Ok(branches) => {
            let branch_names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
            for candidate in &["main", "master", "trunk"] {
                if branch_names.contains(candidate) {
                    return candidate.to_string();
                }
            }
            for b in &branches {
                if b.current && !b.remote {
                    return b.name.clone();
                }
            }
            for b in &branches {
                if !b.remote {
                    return b.name.clone();
                }
            }
            "main".to_string()
        }
        Err(e) => {
            warn!(
                "Failed to list branches for repo '{}': {}, will try to resolve current branch",
                repo_path, e
            );
            match GitService::get_branches(repo_path, false).await {
                Ok(branches) => {
                    for b in &branches {
                        if b.current && !b.remote {
                            return b.name.clone();
                        }
                    }
                    branches
                        .first()
                        .map(|b| b.name.clone())
                        .unwrap_or_else(|| "main".to_string())
                }
                Err(_) => "main".to_string(),
            }
        }
    }
}

#[tauri::command]
pub async fn create_session(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    request: CreateSessionRequest,
) -> Result<CreateSessionResponse, String> {
    fn norm_conn(s: Option<String>) -> Option<String> {
        s.map(|x| x.trim().to_string()).filter(|x| !x.is_empty())
    }
    let remote_conn = norm_conn(request.remote_connection_id.clone()).or_else(|| {
        request
            .config
            .as_ref()
            .and_then(|c| norm_conn(c.remote_connection_id.clone()))
    });
    let remote_ssh_host = norm_conn(request.remote_ssh_host.clone()).or_else(|| {
        request
            .config
            .as_ref()
            .and_then(|c| norm_conn(c.remote_ssh_host.clone()))
    });

    let creation_id = request.creation_id.clone().unwrap_or_else(|| {
        format!(
            "{:?}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        )
    });
    app_state
        .session_creation_cancellations
        .remove(&creation_id);

    let check_cancelled = || -> bool {
        app_state
            .session_creation_cancellations
            .contains(&creation_id)
    };

    let effective_workspace_path = request.workspace_path.clone();
    let mut sandbox_branch: Option<String> = None;
    let mut sandbox_error: Option<String> = None;

    let needs_sandbox = matches!(
        request.agent_type.to_lowercase().as_str(),
        "code" | "cowork"
    );
    let is_repo = needs_sandbox
        && GitService::is_repository(&request.workspace_path)
            .await
            .unwrap_or(false);
    if is_repo && !check_cancelled() {
        let base_branch = detect_default_branch(&request.workspace_path).await;
        info!(
            "Detected default branch '{}' for repo at {}",
            base_branch, request.workspace_path
        );

        if check_cancelled() {
            return Err("Session creation cancelled".to_string());
        }

        let add_result = GitService::add_files(
            &request.workspace_path,
            GitAddParams {
                files: vec![],
                all: Some(true),
                update: None,
            },
        )
        .await;
        if let Err(ref e) = add_result {
            warn!("Failed to stage files before worktree creation: {}", e);
        }

        if check_cancelled() {
            return Err("Session creation cancelled".to_string());
        }

        let commit_result = GitService::commit(
            &request.workspace_path,
            GitCommitParams {
                message: "auto: stage workspace files".to_string(),
                all: None,
                amend: None,
                no_verify: Some(true),
                author: None,
            },
        )
        .await;
        if let Err(ref e) = commit_result {
            warn!("Failed to commit before worktree creation: {}", e);
        }

        if check_cancelled() {
            return Err("Session creation cancelled".to_string());
        }

        let duration_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let branch = format!("task/{:08x}", (duration_ns >> 20) as u64);

        match GitService::add_worktree(&request.workspace_path, &branch, true, Some(&base_branch))
            .await
        {
            Ok(_wt) => {
                sandbox_branch = Some(branch);
                info!(
                    "Created worktree branch '{}' based on '{}'",
                    sandbox_branch.as_deref().unwrap_or(""),
                    base_branch,
                );
            }
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("already exists") {
                    warn!(
                        "Worktree branch '{}' already exists, retrying with timestamp: {}",
                        branch, e
                    );
                    let retry_branch = format!("task/{:016x}", duration_ns as u64);
                    match GitService::add_worktree(
                        &request.workspace_path,
                        &retry_branch,
                        true,
                        Some(&base_branch),
                    )
                    .await
                    {
                        Ok(_wt) => {
                            sandbox_branch = Some(retry_branch);
                            info!("Created worktree branch on retry");
                        }
                        Err(e2) => {
                            let msg = format!(
                                "Failed to create sandbox worktree (retry): base_branch={}, error={}",
                                base_branch, e2
                            );
                            warn!("{}", msg);
                            sandbox_error = Some(msg);
                        }
                    }
                } else {
                    let msg = format!(
                        "Failed to create sandbox worktree: base_branch={}, error={}",
                        base_branch, e
                    );
                    warn!("{}", msg);
                    sandbox_error = Some(msg);
                }
            }
        }

        if check_cancelled() {
            if let Some(branch) = &sandbox_branch {
                let _ = cleanup_sandbox_branch(&request.workspace_path, branch).await;
            }
            return Err("Session creation cancelled".to_string());
        }
    } else if !needs_sandbox {
        info!(
            "Skipping sandbox branch creation for agent type '{}'",
            request.agent_type
        );
    } else {
        info!(
            "Workspace path '{}' is not a git repository, skipping worktree creation",
            request.workspace_path
        );
    }

    if check_cancelled() {
        if let Some(branch) = &sandbox_branch {
            let _ = cleanup_sandbox_branch(&request.workspace_path, branch).await;
        }
        return Err("Session creation cancelled".to_string());
    }

    let config = request
        .config
        .map(|c| SessionConfig {
            max_context_tokens: c.max_context_tokens.unwrap_or(128128),
            auto_compact: c.auto_compact.unwrap_or(true),
            enable_tools: c.enable_tools.unwrap_or(true),
            safe_mode: c.safe_mode.unwrap_or(true),
            max_turns: c.max_turns.unwrap_or(200),
            enable_context_compression: c.enable_context_compression.unwrap_or(true),
            compression_threshold: c.compression_threshold.unwrap_or(0.8),
            workspace_path: Some(effective_workspace_path.clone()),
            remote_connection_id: remote_conn.clone(),
            remote_ssh_host: remote_ssh_host.clone(),
            model_id: c.model_name,
            sandbox_branch: sandbox_branch.clone(),
        })
        .unwrap_or(SessionConfig {
            workspace_path: Some(effective_workspace_path.clone()),
            remote_connection_id: remote_conn.clone(),
            remote_ssh_host: remote_ssh_host.clone(),
            sandbox_branch: sandbox_branch.clone(),
            ..Default::default()
        });

    let session = coordinator
        .create_session_with_workspace(
            request.session_id,
            request.session_name.clone(),
            request.agent_type.clone(),
            config,
            effective_workspace_path,
        )
        .await
        .map_err(|e| format!("Failed to create session: {}", e))?;

    Ok(CreateSessionResponse {
        session_id: session.session_id,
        session_name: session.session_name,
        agent_type: session.agent_type,
        sandbox_branch: sandbox_branch.clone(),
        sandbox_error,
    })
}

#[tauri::command]
pub async fn update_session_model(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: UpdateSessionModelRequest,
) -> Result<(), String> {
    coordinator
        .update_session_model(&request.session_id, &request.model_name)
        .await
        .map_err(|e| format!("Failed to update session model: {}", e))
}

#[tauri::command]
pub async fn update_session_title(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    request: UpdateSessionTitleRequest,
) -> Result<String, String> {
    let session_id = request.session_id.trim();
    if session_id.is_empty() {
        return Err("session_id is required".to_string());
    }

    if coordinator
        .get_session_manager()
        .get_session(session_id)
        .is_none()
    {
        let workspace_path = request
            .workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "workspace_path is required when the session is not loaded".to_string()
            })?;

        let effective = desktop_effective_session_storage_path(
            &app_state,
            workspace_path,
            request.remote_connection_id.as_deref(),
            request.remote_ssh_host.as_deref(),
        )
        .await;

        coordinator
            .restore_session(&effective, session_id)
            .await
            .map_err(|e| format!("Failed to restore session before renaming: {}", e))?;
    }

    coordinator
        .update_session_title(session_id, &request.title)
        .await
        .map_err(|e| format!("Failed to update session title: {}", e))
}

/// Load the session into the coordinator process when it exists on disk but is not in memory.
/// Uses the same remote→local session path mapping as `restore_session`.
#[tauri::command]
pub async fn ensure_coordinator_session(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    request: EnsureCoordinatorSessionRequest,
) -> Result<(), String> {
    let session_id = request.session_id.trim();
    if session_id.is_empty() {
        return Err("session_id is required".to_string());
    }
    if coordinator
        .get_session_manager()
        .get_session(session_id)
        .is_some()
    {
        return Ok(());
    }

    let wp = request.workspace_path.trim();
    if wp.is_empty() {
        return Err("workspace_path is required when the session is not loaded".to_string());
    }

    let effective = desktop_effective_session_storage_path(
        &app_state,
        wp,
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await;
    coordinator
        .restore_session(&effective, session_id)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_dialog_turn(
    _app: AppHandle,
    _coordinator: State<'_, Arc<ConversationCoordinator>>,
    scheduler: State<'_, Arc<DialogScheduler>>,
    request: StartDialogTurnRequest,
) -> Result<StartDialogTurnResponse, String> {
    let StartDialogTurnRequest {
        session_id,
        user_input,
        original_user_input,
        agent_type,
        workspace_path,
        turn_id,
        image_contexts,
    } = request;

    let policy = DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi);
    let resolved_images = if let Some(image_contexts) = image_contexts
        .as_ref()
        .filter(|images| !images.is_empty())
        .cloned()
    {
        Some(resolve_missing_image_payloads(image_contexts)?)
    } else {
        None
    };

    scheduler
        .submit(
            session_id,
            user_input,
            original_user_input,
            turn_id,
            agent_type,
            workspace_path,
            policy,
            None,
            resolved_images,
        )
        .await
        .map_err(|e| format!("Failed to start dialog turn: {}", e))?;

    Ok(StartDialogTurnResponse {
        success: true,
        message: "Dialog turn started".to_string(),
    })
}

#[tauri::command]
pub async fn compact_session(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    request: CompactSessionRequest,
) -> Result<StartDialogTurnResponse, String> {
    let session_id = request.session_id.trim();
    if session_id.is_empty() {
        return Err("session_id is required".to_string());
    }

    if coordinator
        .get_session_manager()
        .get_session(session_id)
        .is_none()
    {
        let workspace_path = request
            .workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "workspace_path is required when the session is not loaded".to_string()
            })?;
        let effective = desktop_effective_session_storage_path(
            &app_state,
            workspace_path,
            request.remote_connection_id.as_deref(),
            request.remote_ssh_host.as_deref(),
        )
        .await;
        coordinator
            .restore_session(&effective, session_id)
            .await
            .map_err(|e| format!("Failed to restore session before compacting: {}", e))?;
    }

    coordinator
        .compact_session_manually(session_id.to_string())
        .await
        .map_err(|e| format!("Failed to compact session: {}", e))?;

    Ok(StartDialogTurnResponse {
        success: true,
        message: "Session compaction started".to_string(),
    })
}

fn is_blank_text(value: Option<&String>) -> bool {
    value.map(|s| s.trim().is_empty()).unwrap_or(true)
}

fn resolve_missing_image_payloads(
    image_contexts: Vec<ImageContextData>,
) -> Result<Vec<ImageContextData>, String> {
    let mut resolved = Vec::with_capacity(image_contexts.len());

    for mut image in image_contexts {
        let missing_payload =
            is_blank_text(image.image_path.as_ref()) && is_blank_text(image.data_url.as_ref());
        if !missing_payload {
            resolved.push(image);
            continue;
        }

        let stored = get_image_context(&image.id).ok_or_else(|| {
            format!(
                "Image context not found for image_id={}. It may have expired. Please re-attach the image and retry.",
                image.id
            )
        })?;

        if is_blank_text(image.image_path.as_ref()) {
            image.image_path = stored
                .image_path
                .clone()
                .filter(|s: &String| !s.trim().is_empty());
        }
        if is_blank_text(image.data_url.as_ref()) {
            image.data_url = stored
                .data_url
                .clone()
                .filter(|s: &String| !s.trim().is_empty());
        }
        if image.mime_type.trim().is_empty() {
            image.mime_type = stored.mime_type.clone();
        }

        let mut metadata = image
            .metadata
            .take()
            .unwrap_or_else(|| serde_json::json!({}));
        if !metadata.is_object() {
            metadata = serde_json::json!({ "raw_metadata": metadata });
        }
        if let Some(obj) = metadata.as_object_mut() {
            if !obj.contains_key("name") {
                obj.insert("name".to_string(), serde_json::json!(stored.image_name));
            }
            if !obj.contains_key("width") {
                obj.insert("width".to_string(), serde_json::json!(stored.width));
            }
            if !obj.contains_key("height") {
                obj.insert("height".to_string(), serde_json::json!(stored.height));
            }
            if !obj.contains_key("file_size") {
                obj.insert("file_size".to_string(), serde_json::json!(stored.file_size));
            }
            if !obj.contains_key("source") {
                obj.insert("source".to_string(), serde_json::json!(stored.source));
            }
            obj.insert(
                "resolved_from_upload_cache".to_string(),
                serde_json::json!(true),
            );
        }
        image.metadata = Some(metadata);

        let still_missing =
            is_blank_text(image.image_path.as_ref()) && is_blank_text(image.data_url.as_ref());
        if still_missing {
            return Err(format!(
                "Image context {} is missing image_path/data_url after cache resolution",
                image.id
            ));
        }

        resolved.push(image);
    }

    Ok(resolved)
}

#[tauri::command]
pub async fn cancel_dialog_turn(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: CancelDialogTurnRequest,
) -> Result<(), String> {
    coordinator
        .cancel_dialog_turn(&request.session_id, &request.dialog_turn_id)
        .await
        .map_err(|e| {
            log::error!(
                "Failed to cancel dialog turn: session_id={}, dialog_turn_id={}, error={}",
                request.session_id,
                request.dialog_turn_id,
                e
            );
            format!("Failed to cancel dialog turn: {}", e)
        })
}

#[tauri::command]
pub async fn cancel_tool(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: CancelToolRequest,
) -> Result<(), String> {
    let reason = request
        .reason
        .unwrap_or_else(|| "User cancelled".to_string());

    coordinator
        .cancel_tool(&request.tool_use_id, reason)
        .await
        .map_err(|e| {
            log::error!(
                "Failed to cancel tool execution: tool_use_id={}, error={}",
                request.tool_use_id,
                e
            );
            format!("Failed to cancel tool execution: {}", e)
        })
}

#[tauri::command]
pub async fn delete_session(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    request: DeleteSessionRequest,
) -> Result<(), String> {
    let effective_path = desktop_effective_session_storage_path(
        &app_state,
        &request.workspace_path,
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await;

    if let Ok(session) = coordinator
        .restore_session(&effective_path, &request.session_id)
        .await
    {
        if let Some(branch) = session.config.sandbox_branch.as_deref() {
            let repo_path = session
                .config
                .workspace_path
                .as_deref()
                .unwrap_or(&request.workspace_path);
            warn!(
                "Deleting session '{}' with sandbox branch '{}' — unmerged work will be permanently lost",
                request.session_id, branch
            );
            let _ = cleanup_sandbox_branch(repo_path, branch).await;
        }
    } else if let Some(branch) = load_sandbox_branch_from_metadata(&request).await {
        let repo_path = request.workspace_path.as_str();
        warn!(
            "Deleting session '{}' from metadata: sandbox branch '{}' — unmerged work will be permanently lost",
            request.session_id, branch
        );
        let _ = cleanup_sandbox_branch(repo_path, &branch).await;
    }

    coordinator
        .delete_session(&effective_path, &request.session_id)
        .await
        .map_err(|e| format!("Failed to delete session: {}", e))
}

#[tauri::command]
pub async fn restore_session(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    request: RestoreSessionRequest,
) -> Result<SessionResponse, String> {
    let effective_path = desktop_effective_session_storage_path(
        &app_state,
        &request.workspace_path,
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await;
    let session = coordinator
        .restore_session(&effective_path, &request.session_id)
        .await
        .map_err(|e| format!("Failed to restore session: {}", e))?;

    Ok(session_to_response(session))
}

#[tauri::command]
pub async fn list_sessions(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    request: ListSessionsRequest,
) -> Result<Vec<SessionResponse>, String> {
    let effective_path = desktop_effective_session_storage_path(
        &app_state,
        &request.workspace_path,
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await;
    let summaries = coordinator
        .list_sessions(&effective_path)
        .await
        .map_err(|e| format!("Failed to list sessions: {}", e))?;

    let responses = summaries
        .into_iter()
        .map(|summary| SessionResponse {
            session_id: summary.session_id,
            session_name: summary.session_name,
            agent_type: summary.agent_type,
            state: format!("{:?}", summary.state),
            turn_count: summary.turn_count,
            created_at: system_time_to_unix_secs(summary.created_at),
            workspace_path: summary.workspace_path.clone(),
            sandbox_branch: summary.sandbox_branch.clone(),
            plan_file_path: None,
            status: summary.status.map(|s| format!("{:?}", s).to_lowercase()),
        })
        .collect();

    Ok(responses)
}

#[tauri::command]
pub async fn confirm_tool_execution(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: ConfirmToolRequest,
) -> Result<(), String> {
    coordinator
        .confirm_tool(&request.tool_id, request.updated_input)
        .await
        .map_err(|e| format!("Confirm tool failed: {}", e))
}

#[tauri::command]
pub async fn reject_tool_execution(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: RejectToolRequest,
) -> Result<(), String> {
    let reason = request
        .reason
        .unwrap_or_else(|| "User rejected".to_string());

    coordinator
        .reject_tool(&request.tool_id, reason)
        .await
        .map_err(|e| format!("Reject tool failed: {}", e))
}

#[tauri::command]
pub async fn confirm_plan(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: PlanConfirmationRequest,
) -> Result<(), String> {
    info!("User confirmed plan for session: {}", request.session_id);
    coordinator
        .confirm_plan()
        .map_err(|e| format!("Failed to confirm plan: {}", e))
}

#[tauri::command]
pub async fn reject_plan(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: PlanConfirmationRequest,
) -> Result<(), String> {
    info!("User rejected plan for session: {}", request.session_id);
    coordinator
        .reject_plan()
        .map_err(|e| format!("Failed to reject plan: {}", e))
}

#[tauri::command]
pub async fn revise_plan(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: PlanReviseRequest,
) -> Result<(), String> {
    info!(
        "User requested plan revision for session: {}",
        request.session_id
    );
    coordinator
        .revise_plan(request.feedback)
        .map_err(|e| format!("Failed to revise plan: {}", e))
}

#[tauri::command]
pub async fn auto_review_plan(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: PlanConfirmationRequest,
) -> Result<(), String> {
    info!(
        "User requested auto review for session: {}",
        request.session_id
    );
    coordinator
        .auto_review_plan()
        .map_err(|e| format!("Failed to auto-review plan: {}", e))
}

#[tauri::command]
pub async fn generate_session_title(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: GenerateSessionTitleRequest,
) -> Result<String, String> {
    coordinator
        .generate_session_title(
            &request.session_id,
            &request.user_message,
            request.max_length,
        )
        .await
        .map_err(|e| format!("Failed to generate session title: {}", e))
}

#[tauri::command]
pub async fn get_available_modes(state: State<'_, AppState>) -> Result<Vec<ModeInfoDTO>, String> {
    let mode_infos = state.agent_registry.get_modes_info().await;

    let dtos: Vec<ModeInfoDTO> = mode_infos
        .into_iter()
        .map(|info| ModeInfoDTO {
            id: info.id,
            name: info.name,
            description: info.description,
            is_readonly: info.is_readonly,
            tool_count: info.tool_count,
            default_tools: info.default_tools,
            enabled: info.enabled,
        })
        .collect();

    Ok(dtos)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeInfoDTO {
    pub id: String,
    pub name: String,
    pub description: String,
    pub is_readonly: bool,
    pub tool_count: usize,
    pub default_tools: Vec<String>,
    pub enabled: bool,
}

fn session_to_response(session: Session) -> SessionResponse {
    SessionResponse {
        session_id: session.session_id,
        session_name: session.session_name,
        agent_type: session.agent_type,
        state: format!("{:?}", session.state),
        turn_count: session.dialog_turn_ids.len(),
        created_at: system_time_to_unix_secs(session.created_at),
        workspace_path: session.config.workspace_path.clone(),
        sandbox_branch: session.config.sandbox_branch.clone(),
        plan_file_path: session
            .workflow_phase
            .as_ref()
            .and_then(|wp| wp.plan_file_path.clone()),
        status: None,
    }
}

fn system_time_to_unix_secs(time: std::time::SystemTime) -> u64 {
    match time.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_secs(),
        Err(err) => {
            warn!("Failed to convert SystemTime to unix timestamp: {}", err);
            0
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRatingRequest {
    pub session_id: String,
    pub plan_rating: u8,
    pub plan_feedback: String,
    pub complete_rating: u8,
    pub complete_feedback: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRatingResponse {
    pub success: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveAndMergeRequest {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveAndMergeResponse {
    pub success: bool,
    pub merged: bool,
    pub conflict: bool,
    pub message: String,
}

#[tauri::command]
pub async fn submit_rating(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    _app_state: State<'_, AppState>,
    request: SubmitRatingRequest,
) -> Result<SubmitRatingResponse, String> {
    if request.plan_rating > 5 || request.complete_rating > 5 {
        return Err("Rating must be 0-5".to_string());
    }

    let session = match coordinator
        .get_session_manager()
        .get_session(&request.session_id)
    {
        Some(s) => s,
        None => {
            let path_manager = PathManager::new().map_err(|e| e.to_string())?;
            let persistence = PersistenceManager::new(std::sync::Arc::new(path_manager))
                .map_err(|e| e.to_string())?;
            let projects_dir = dirs::data_dir()
                .unwrap_or_default()
                .join("ai00-x")
                .join("projects");
            if projects_dir.exists() {
                let mut found = None;
                if let Ok(entries) = std::fs::read_dir(&projects_dir) {
                    for entry in entries.flatten() {
                        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            let ws_path = entry.path();
                            if let Ok(Some(_)) = persistence
                                .load_session_metadata(&ws_path, &request.session_id)
                                .await
                            {
                                match persistence
                                    .load_session(&ws_path, &request.session_id)
                                    .await
                                {
                                    Ok(s) => {
                                        found = Some(s);
                                        break;
                                    }
                                    Err(e) => {
                                        warn!(
                                            "Failed to load session {} from {}: {}",
                                            request.session_id,
                                            ws_path.display(),
                                            e
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                found.ok_or_else(|| format!("Session not found: {}", request.session_id))?
            } else {
                return Err(format!("Session not found: {}", request.session_id));
            }
        }
    };

    let workspace_path = session.config.workspace_path.as_deref().unwrap_or("");

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let path_manager = std::sync::Arc::new(
        PathManager::new().map_err(|e| format!("Failed to create path manager: {}", e))?,
    );
    let persistence = PersistenceManager::new(path_manager)
        .map_err(|e| format!("Failed to create persistence manager: {}", e))?;

    let workspace_buf = std::path::PathBuf::from(workspace_path);
    let mut metadata = persistence
        .load_session_metadata(&workspace_buf, &request.session_id)
        .await
        .map_err(|e| format!("Failed to load session metadata: {}", e))?
        .unwrap_or_else(|| {
            use ai00_x_core::service::session::{SessionMetadata, SessionStatus};
            SessionMetadata {
                session_id: request.session_id.clone(),
                session_name: session.session_name.clone(),
                agent_type: session.agent_type.clone(),
                created_by: session.created_by.clone(),
                session_kind: session.kind,
                model_name: session
                    .config
                    .model_id
                    .clone()
                    .unwrap_or_else(|| "default".to_string()),
                created_at: now_secs * 1000,
                last_active_at: now_secs * 1000,
                turn_count: session.dialog_turn_ids.len(),
                message_count: 0,
                tool_call_count: 0,
                status: SessionStatus::Active,
                terminal_session_id: None,
                snapshot_session_id: session.snapshot_session_id.clone(),
                tags: Vec::new(),
                custom_metadata: None,
                todos: None,
                plan_rating: None,
                plan_feedback: None,
                complete_rating: None,
                complete_feedback: None,
                rated_at: None,
                workspace_path: Some(workspace_path.to_string()),
                workspace_hostname: None,
                sandbox_branch: session.config.sandbox_branch.clone(),
            }
        });

    metadata.plan_rating = Some(request.plan_rating);
    metadata.plan_feedback = if request.plan_feedback.is_empty() {
        None
    } else {
        Some(request.plan_feedback)
    };
    metadata.complete_rating = Some(request.complete_rating);
    metadata.complete_feedback = if request.complete_feedback.is_empty() {
        None
    } else {
        Some(request.complete_feedback)
    };
    metadata.rated_at = Some(now_secs);

    persistence
        .save_session_metadata(&workspace_buf, &metadata)
        .await
        .map_err(|e| format!("Failed to save session metadata: {}", e))?;

    info!(
        "Rating saved to metadata for session: {}",
        request.session_id
    );
    Ok(SubmitRatingResponse { success: true })
}

#[tauri::command]
pub async fn archive_and_merge(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    request: ArchiveAndMergeRequest,
) -> Result<ArchiveAndMergeResponse, String> {
    use std::path::Path;

    let session = coordinator
        .get_session_manager()
        .get_session(&request.session_id)
        .ok_or_else(|| format!("Session not found: {}", request.session_id))?;

    let sandbox_branch = session.config.sandbox_branch.clone();
    let repo_path = session
        .config
        .workspace_path
        .as_deref()
        .unwrap_or("")
        .to_string();
    let mut merged = false;
    let mut conflict = false;
    let mut message = String::from("Session archived");

    if let Some(branch) = &sandbox_branch {
        if !repo_path.is_empty() {
            let worktree_dir = Path::new(&repo_path)
                .join(".tasks")
                .join(branch.replace('/', "-"));

            if worktree_dir.exists() {
                let worktree_str = worktree_dir.to_string_lossy();
                match GitService::add_files(
                    &*worktree_str,
                    GitAddParams {
                        all: Some(true),
                        update: None,
                        files: vec![],
                    },
                )
                .await
                {
                    Ok(_) => {}
                    Err(e) => {
                        let err_str = e.to_string();
                        if err_str.contains("nothing to add") || err_str.contains("did not match") {
                            info!("No pending changes to add for branch '{}'", branch);
                        } else {
                            warn!("Failed to add files for branch '{}': {}", branch, e);
                        }
                    }
                }
                match GitService::commit(
                    &*worktree_str,
                    GitCommitParams {
                        message: "archive: auto-commit pending changes before merge".to_string(),
                        amend: None,
                        all: None,
                        no_verify: None,
                        author: None,
                    },
                )
                .await
                {
                    Ok(_) => {
                        info!("Committed pending changes for branch '{}'", branch);
                    }
                    Err(e) => {
                        let err_str = e.to_string();
                        if err_str.contains("nothing to commit") {
                            info!("No pending changes to commit for branch '{}'", branch);
                        } else {
                            warn!("Failed to commit for branch '{}': {}", branch, e);
                        }
                    }
                }
            }

            let target_branch = detect_default_branch(&repo_path).await;
            info!("Merging branch '{}' into '{}'", branch, target_branch);

            let previous_branch = GitService::get_branches(&repo_path, false)
                .await
                .ok()
                .and_then(|branches| {
                    branches
                        .iter()
                        .find(|b| b.current && !b.remote)
                        .map(|b| b.name.clone())
                });

            let has_pending = check_repo_dirty(&repo_path);
            if has_pending {
                warn!(
                    "Main repo at '{}' has uncommitted changes; stashing before merge",
                    repo_path
                );
                match GitService::stash(
                    &repo_path,
                    Some("graphify: auto-stash before archive merge"),
                )
                .await
                {
                    Ok(_) => {
                        info!("Stashed uncommitted changes before merge");
                    }
                    Err(e) => {
                        warn!("Failed to stash changes: {}", e);
                        message = format!(
                            "Cannot merge branch '{}': repository has uncommitted changes and stash failed. Please commit or stash them manually.",
                            branch
                        );
                        update_session_status_to_archived(&request.session_id, &repo_path).await;
                        return Ok(ArchiveAndMergeResponse {
                            success: false,
                            merged: false,
                            conflict: false,
                            message,
                        });
                    }
                }
            }

            match GitService::merge_branch(&repo_path, branch, Some(&target_branch)).await {
                Ok(_) => {
                    merged = true;
                    message = format!(
                        "Branch '{}' merged to '{}' successfully",
                        branch, target_branch
                    );
                    info!("{}", message);

                    update_session_status_to_archived(&request.session_id, &repo_path).await;

                    let cleanup_errors = cleanup_sandbox_branch(&repo_path, branch).await;
                    if !cleanup_errors.is_empty() {
                        message.push_str(&format!(
                            " (cleanup warnings: {})",
                            cleanup_errors.join("; ")
                        ));
                    }

                    if has_pending {
                        match GitService::stash_pop(&repo_path).await {
                            Ok(_) => {
                                info!("Restored stashed changes after merge");
                            }
                            Err(e) => {
                                warn!("Failed to pop stash after merge: {}", e);
                                message.push_str(" (warning: failed to restore stashed changes, use 'git stash pop' manually)");
                            }
                        }
                    }

                    if let Some(prev) = previous_branch {
                        let prev_normalized = prev.replace("refs/heads/", "");
                        if prev_normalized != target_branch {
                            match GitService::checkout_branch(&repo_path, &prev_normalized).await {
                                Ok(_) => {
                                    info!(
                                        "Restored previous branch '{}' after merge",
                                        prev_normalized
                                    );
                                }
                                Err(e) => {
                                    warn!(
                                        "Failed to restore previous branch '{}': {}",
                                        prev_normalized, e
                                    );
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    let err_str = e.to_string();
                    if err_str.contains("conflict") || err_str.contains("CONFLICT") {
                        info!("Merge conflict detected, attempting LLM resolution...");
                        match resolve_merge_conflicts_with_llm(&repo_path, branch, &app_state).await
                        {
                            Ok(true) => {
                                merged = true;
                                message = format!(
                                    "Merge conflict for branch '{}' resolved by LLM and merged to '{}'",
                                    branch, target_branch
                                );
                                info!("{}", message);

                                update_session_status_to_archived(&request.session_id, &repo_path)
                                    .await;

                                let cleanup_errors =
                                    cleanup_sandbox_branch(&repo_path, branch).await;
                                if !cleanup_errors.is_empty() {
                                    message.push_str(&format!(
                                        " (cleanup warnings: {})",
                                        cleanup_errors.join("; ")
                                    ));
                                }

                                if has_pending {
                                    let _ = GitService::stash_pop(&repo_path).await;
                                }

                                if let Some(prev) = previous_branch {
                                    let prev_normalized = prev.replace("refs/heads/", "");
                                    if prev_normalized != target_branch {
                                        let _ = GitService::checkout_branch(
                                            &repo_path,
                                            &prev_normalized,
                                        )
                                        .await;
                                    }
                                }
                            }
                            _ => {
                                let _ = GitService::abort_merge(&repo_path).await;
                                info!(
                                    "Aborted merge after failed conflict resolution for '{}'",
                                    branch
                                );

                                if has_pending {
                                    let _ = GitService::stash_pop(&repo_path).await;
                                }

                                if let Some(prev) = previous_branch {
                                    let prev_normalized = prev.replace("refs/heads/", "");
                                    if prev_normalized != target_branch {
                                        let _ = GitService::checkout_branch(
                                            &repo_path,
                                            &prev_normalized,
                                        )
                                        .await;
                                    }
                                }

                                conflict = true;
                                message = format!(
                                    "Merge conflict for branch '{}': could not auto-resolve. Merge aborted, repository restored. Manual conflict resolution needed.",
                                    branch
                                );
                                warn!("{}", message);
                            }
                        }
                    } else {
                        let _ = get_abort_merge_if_needed(&repo_path).await;

                        if has_pending {
                            let _ = GitService::stash_pop(&repo_path).await;
                        }

                        if let Some(prev) = previous_branch {
                            let prev_normalized = prev.replace("refs/heads/", "");
                            if prev_normalized != target_branch {
                                let _ =
                                    GitService::checkout_branch(&repo_path, &prev_normalized).await;
                            }
                        }

                        let err_msg = format!("Failed to merge branch '{}': {}", branch, err_str);
                        warn!("{}", err_msg);
                        return Err(err_msg);
                    }
                }
            }
        }
    } else {
        info!(
            "No task branch for session '{}', archiving without merge",
            request.session_id
        );
        if !repo_path.is_empty() {
            update_session_status_to_archived(&request.session_id, &repo_path).await;
        }
    }

    Ok(ArchiveAndMergeResponse {
        success: true,
        merged,
        conflict,
        message,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSessionCreationRequest {
    pub creation_id: String,
}

#[tauri::command]
pub async fn cancel_session_creation(
    app_state: State<'_, AppState>,
    request: CancelSessionCreationRequest,
) -> Result<(), String> {
    app_state
        .session_creation_cancellations
        .insert(request.creation_id.clone());
    info!(
        "Session creation cancellation requested: {}",
        request.creation_id
    );
    Ok(())
}
