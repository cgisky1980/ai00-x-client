//! Wallpaper API — Tauri commands for custom wallpaper creation and management.

use log::{error, info};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, State};

use crate::api::app_state::AppState;
use ai00_x_core::agent::coordination::ConversationCoordinator;
use ai00_x_core::service::config::server_endpoints::{LOCAL_EMBEDDED_SERVER_PORT, LOCAL_HOST};
use ai00_x_core::wallpaper::service;
use ai00_x_core::wallpaper::types::{CreateProjectResult, WallpaperProject};

// ============== Request / Response DTOs ==============

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWallpaperRequest {
    pub html: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyWallpaperRequest {
    /// "preview" or project id.
    pub id: String,
    pub monitor_id: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectRequest {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProjectRequest {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateProjectNameRequest {
    pub description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateProjectNameResponse {
    pub name: String,
    #[serde(rename = "dirName")]
    pub dir_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceProjectRequest {
    pub name: String,
    /// Optional directory name. If empty, a UUID will be generated automatically.
    #[serde(rename = "dirName", default)]
    pub dir_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishWorkspaceProjectRequest {
    #[serde(rename = "dirName")]
    pub dir_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorkspaceProjectRequest {
    #[serde(rename = "dirName")]
    pub dir_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishWorkspaceProjectResponse {
    pub zip_path: String,
    pub serve_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperServerInfo {
    pub host: String,
    pub port: u16,
}

// ============== Commands ==============

/// Get wallpaper server info (host + port).
#[tauri::command]
pub fn get_wallpaper_server_info() -> WallpaperServerInfo {
    WallpaperServerInfo {
        host: LOCAL_HOST.into(),
        port: LOCAL_EMBEDDED_SERVER_PORT,
    }
}

/// Write HTML content to the preview directory and return the preview URL.
#[tauri::command]
pub fn preview_wallpaper(request: PreviewWallpaperRequest) -> Result<String, String> {
    service::write_preview_index(&request.html).map_err(|e| e.to_string())?;
    Ok(format!(
        "http://{}:{}/wallpapers/preview/index.html",
        LOCAL_HOST, LOCAL_EMBEDDED_SERVER_PORT
    ))
}

/// Create a new wallpaper project from the current preview content.
#[tauri::command]
pub fn create_project(request: CreateProjectRequest) -> Result<CreateProjectResult, String> {
    service::create_project(&request.name).map_err(|e| e.to_string())
}

/// List all wallpaper projects.
#[tauri::command]
pub fn list_projects() -> Result<Vec<WallpaperProject>, String> {
    service::list_projects().map_err(|e| e.to_string())
}

/// Delete a wallpaper project.
#[tauri::command]
pub fn delete_project(request: DeleteProjectRequest) -> Result<(), String> {
    service::delete_project(&request.id).map_err(|e| e.to_string())
}

/// Export a project as a zip file. Returns the zip path.
#[tauri::command]
pub fn export_project_zip(request: ExportProjectRequest) -> Result<String, String> {
    let dest = dirs::download_dir()
        .or_else(dirs::desktop_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    service::export_project_zip(&request.id, &dest)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Generate a project name using AI (RWKV fast model). Directory name is always a UUID.
/// Falls back to heuristic if AI is not available.
#[tauri::command]
pub async fn generate_wallpaper_project_name(
    state: State<'_, AppState>,
    request: GenerateProjectNameRequest,
) -> Result<GenerateProjectNameResponse, String> {
    use ai00_x_core::util::types::message::Message;

    // Directory name is always a UUID — simple, unique, no collisions
    let dir_name = service::generate_dir_name();

    // Try AI via client_factory (always available, unlike state.ai_client which is Option)
    let name = match state.ai_client_factory.get_client_resolved("fast").await {
        Ok(ai_client) => {
            // Build messages — no tools, messages_to_prompt will auto-append "Assistant: "
            let system_msg = Message::system(
                "You are a project naming assistant. Generate a concise, descriptive project name (1-6 words) for a desktop wallpaper. Reply with ONLY the name, nothing else."
                    .to_string(),
            );
            let user_msg = Message::user(request.description.clone());

            let messages = vec![system_msg, user_msg];
            match ai_client.send_message(messages, None).await {
                Ok(response) => {
                    let text = response.text.trim().to_string();
                    // Take the first line as the project name
                    let cleaned = text
                        .lines()
                        .next()
                        .unwrap_or(&text)
                        .trim()
                        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`')
                        .trim_end_matches('.')
                        .trim()
                        .to_string();
                    if !cleaned.is_empty() && cleaned.len() <= 80 {
                        info!("AI generated wallpaper project name: '{}'", cleaned);
                        cleaned
                    } else {
                        error!("AI returned empty or too-long name, falling back");
                        service::generate_project_name(&request.description).0
                    }
                }
                Err(e) => {
                    error!("AI call failed for project name, falling back: {}", e);
                    service::generate_project_name(&request.description).0
                }
            }
        }
        Err(e) => {
            error!(
                "Failed to get AI client for project name, falling back: {}",
                e
            );
            service::generate_project_name(&request.description).0
        }
    };

    Ok(GenerateProjectNameResponse { name, dir_name })
}

/// Create a wallpaper project under the exe's workspaces directory.
#[tauri::command]
pub async fn create_workspace_wallpaper_project(
    _state: State<'_, AppState>,
    request: CreateWorkspaceProjectRequest,
) -> Result<CreateProjectResult, String> {
    // Use <exe_dir>/workspaces as the base, not the current workspace.
    let workspaces_root = ai00_x_core::infrastructure::PathManager::exe_dir()
        .map_err(|e| e.to_string())?
        .join("workspaces");
    // Auto-generate dir_name if not provided
    let dir_name = if request.dir_name.is_empty() {
        service::generate_dir_name()
    } else {
        request.dir_name.clone()
    };
    service::create_workspace_project(&workspaces_root, &request.name, &dir_name)
        .map_err(|e| e.to_string())
}

/// List all wallpaper projects under the exe's workspaces directory.
#[tauri::command]
pub async fn list_workspace_wallpaper_projects(
    _state: State<'_, AppState>,
) -> Result<Vec<WallpaperProject>, String> {
    let workspaces_root = ai00_x_core::infrastructure::PathManager::exe_dir()
        .map_err(|e| e.to_string())?
        .join("workspaces");
    service::list_workspace_projects(&workspaces_root).map_err(|e| e.to_string())
}

/// Publish a workspace wallpaper project: copy to serve dir + export zip.
#[tauri::command]
pub async fn publish_wallpaper_project(
    _state: State<'_, AppState>,
    request: PublishWorkspaceProjectRequest,
) -> Result<PublishWorkspaceProjectResponse, String> {
    let workspaces_root = ai00_x_core::infrastructure::PathManager::exe_dir()
        .map_err(|e| e.to_string())?
        .join("workspaces");
    let (zip_path, serve_url) =
        service::publish_workspace_project(&workspaces_root, &request.dir_name)
            .map_err(|e| e.to_string())?;
    info!(
        "Published wallpaper project: zip={}, url={}",
        zip_path, serve_url
    );
    Ok(PublishWorkspaceProjectResponse {
        zip_path,
        serve_url,
    })
}

/// Delete a workspace wallpaper project.
#[tauri::command]
pub async fn delete_workspace_wallpaper_project(
    _state: State<'_, AppState>,
    request: DeleteWorkspaceProjectRequest,
) -> Result<(), String> {
    let workspaces_root = ai00_x_core::infrastructure::PathManager::exe_dir()
        .map_err(|e| e.to_string())?
        .join("workspaces");
    service::delete_workspace_project(&workspaces_root, &request.dir_name)
        .map_err(|e| e.to_string())
}

// ============== Apply to Desktop ==============

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyToDesktopRequest {
    /// Absolute path to the wallpaper project directory.
    pub project_path: String,
    /// Background mode: "single" (span all monitors) or "per-monitor".
    /// If not provided, reads from current config.
    pub mode: Option<String>,
    /// Monitor ID to apply to (only used when mode is "per-monitor").
    pub monitor_id: Option<u32>,
}

// ============== Compact Wallpaper Context ==============

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactWallpaperContextRequest {
    pub session_id: String,
    pub workspace_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactWallpaperContextResponse {
    pub compacted: bool,
    pub removed_turns: usize,
}

/// Compact a wallpaper session's context by removing turns before the
/// second-to-last Write/Edit tool call.
#[tauri::command]
pub async fn compact_wallpaper_context(
    _state: State<'_, AppState>,
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: CompactWallpaperContextRequest,
) -> Result<CompactWallpaperContextResponse, String> {
    let workspace_path = PathBuf::from(&request.workspace_path);
    let session_manager = coordinator.get_session_manager();
    let (compacted, removed_turns) = session_manager
        .compact_to_last_file_write(&workspace_path, &request.session_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(CompactWallpaperContextResponse {
        compacted,
        removed_turns,
    })
}

/// Apply a wallpaper project to the desktop underlay.
/// Reads the current underlay config, preserves the user's mode choice,
/// updates the appropriate slot, and persists the change.
#[tauri::command]
pub async fn apply_wallpaper_to_desktop(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: ApplyToDesktopRequest,
) -> Result<(), String> {
    let project_path = PathBuf::from(&request.project_path);
    if !project_path.exists() {
        return Err(format!(
            "Project path does not exist: {}",
            request.project_path
        ));
    }

    // Extract the directory name (UUID) from the project path
    let dir_name = project_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid project path".to_string())?;

    // Build the wallpaper URL
    let url = format!(
        "http://{}:{}/wallpaper/projects/{}/index.html",
        LOCAL_HOST, LOCAL_EMBEDDED_SERVER_PORT, dir_name
    );

    // Read current underlay config to preserve mode and per-monitor settings
    let current_config: serde_json::Value = state
        .config_service
        .get_config(Some("app.underlay"))
        .await
        .unwrap_or(serde_json::json!({}));

    let current_bg = current_config
        .get("background")
        .cloned()
        .unwrap_or(serde_json::json!({
            "mode": "single",
            "default": { "type": "web", "config": { "src": "" } }
        }));

    // Determine the mode: use provided mode, or fall back to current config mode
    let mode = request.mode.as_deref().unwrap_or_else(|| {
        current_bg
            .get("mode")
            .and_then(|m| m.as_str())
            .unwrap_or("single")
    });

    // Build the new background config, preserving existing per-monitor settings
    let mut new_bg = current_bg.clone();

    // Update the slot based on mode and monitor_id
    if mode == "per-monitor" {
        if let Some(monitor_id) = request.monitor_id {
            // Per-monitor mode: update only the specified monitor's slot
            new_bg["mode"] = serde_json::json!("per-monitor");
            let mid = monitor_id.to_string();
            let monitors = new_bg
                .as_object_mut()
                .and_then(|obj| obj.get_mut("monitors"))
                .and_then(|m| m.as_object_mut());
            match monitors {
                Some(monitors_map) => {
                    monitors_map.insert(
                        mid,
                        serde_json::json!({
                            "type": "web",
                            "config": { "src": &url }
                        }),
                    );
                }
                None => {
                    new_bg["monitors"] = serde_json::json!({
                        mid: {
                            "type": "web",
                            "config": { "src": &url }
                        }
                    });
                }
            }
            // Also update default if it's empty
            if new_bg
                .get("default")
                .and_then(|d| d.get("config"))
                .and_then(|c| c.get("src"))
                .and_then(|s| s.as_str())
                .is_none_or(|s| s.is_empty())
            {
                new_bg["default"] = serde_json::json!({
                    "type": "web",
                    "config": { "src": &url }
                });
            }
        } else {
            // Per-monitor mode but no specific monitor: update default
            new_bg["mode"] = serde_json::json!("per-monitor");
            new_bg["default"] = serde_json::json!({
                "type": "web",
                "config": { "src": &url }
            });
        }
    } else {
        // Single mode or per-monitor without specific monitor: update the default slot
        new_bg["mode"] = serde_json::json!(mode);
        new_bg["default"] = serde_json::json!({
            "type": "web",
            "config": { "src": &url }
        });
    }

    // Build the full underlay config
    let is_enabled = current_config
        .get("enabled")
        .and_then(|e| e.as_bool())
        .unwrap_or(true);

    let full_config = serde_json::json!({
        "enabled": is_enabled,
        "background": &new_bg
    });

    // Persist the config
    if let Err(e) = state
        .config_service
        .set_config("app.underlay", full_config.clone())
        .await
    {
        error!("Failed to persist underlay config after apply: {}", e);
    }

    // Emit event to update underlay background
    let _ = app.emit(
        "wallpaper_applied",
        serde_json::json!({
            "url": &url,
            "id": dir_name,
        }),
    );

    // Emit the underlay_background_change event with the full background config
    let _ = app.emit("underlay_background_change", &new_bg);

    info!(
        "Applied wallpaper to desktop: url={}, mode={}, monitor_id={:?}",
        url, mode, request.monitor_id
    );
    Ok(())
}
