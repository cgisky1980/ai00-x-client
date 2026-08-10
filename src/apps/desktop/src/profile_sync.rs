//! Profile sync module — cross-device user profile synchronization.
//!
//! Syncs plaintext profile data (ui_prefs, ssh connections, ai rules) between
//! the local `<exe_dir>/data/profile/` directory and the Ai00-Salvo server's
//! `user_profile_sync` table.
//!
//! ## Sync flow
//!
//! - **Upload** (before unbind): read local profile files → POST to server
//! - **Download** (after login on new device): GET all from server → write local
//!
//! ## What gets synced
//!
//! | Key | Local path | Content |
//! |-----|-----------|---------|
//! | `ui_prefs` | `profile/ui_prefs.json` | UI preferences JSON |
//! | `ssh_connections` | `profile/ssh/ssh_connections.json` | SSH connections (no passwords) |
//! | `ssh_known_hosts` | `profile/ssh/known_hosts` | SSH known hosts |
//! | `ssh_remote_workspace` | `profile/ssh/remote_workspace.json` | SSH workspace mirrors |
//! | `ai_rules` | `profile/rules/` | AI rules directory (JSON map {filename: content}) |
//!
//! ## What does NOT sync
//!
//! - `auth_vault/` — device-local AES key, cannot sync
//! - `kv_vault/` — device-local AES key, cannot sync
//! - `ssh_secrets/` — SSH password vault, sensitive

use std::collections::HashMap;
use std::path::PathBuf;

use ai00_x_core::infrastructure::get_path_manager_arc;
use serde::{Deserialize, Serialize};

/// Profile sync key — matches server-side whitelist.
const SYNC_KEYS: &[&str] = &[
    "ui_prefs",
    "ssh_connections",
    "ssh_known_hosts",
    "ssh_remote_workspace",
    "ai_rules",
];

/// Server response wrapper.
#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    code: i64,
    message: String,
    data: Option<T>,
}

/// Download-all response data.
#[derive(Debug, Deserialize)]
struct DownloadAllData {
    items: HashMap<String, DownloadItem>,
}

#[derive(Debug, Deserialize)]
struct DownloadItem {
    value: String,
    #[allow(dead_code)]
    updated_at: String,
}

/// Upload response data.
#[derive(Debug, Deserialize)]
struct UploadData {
    #[allow(dead_code)]
    key: String,
    #[allow(dead_code)]
    updated_at: String,
}

/// Sync result summary.
#[derive(Debug, Clone, Serialize)]
pub struct SyncResult {
    pub uploaded: usize,
    pub downloaded: usize,
    pub errors: Vec<String>,
}

/// Get auth token from AUTH_STORE (in auth.rs).
fn get_auth_token() -> Option<String> {
    crate::auth::get_auth_info_sync().map(|info| info.token)
}

/// Get Ai00-S base URL from global config.
async fn get_base_url() -> String {
    use ai00_x_core::service::config::server_endpoints::ai00_s_base_url;
    match ai00_x_core::service::config::global::get_global_config_service() {
        Ok(service) => service
            .get_config(None)
            .await
            .map(|c: ai00_x_core::service::config::types::GlobalConfig| {
                c.app.ai00_s_base_url.clone()
            })
            .unwrap_or_else(|_| ai00_s_base_url()),
        Err(_) => ai00_s_base_url(),
    }
}

/// Read a file as string, return None if file doesn't exist.
fn read_file_opt(path: &PathBuf) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Read ai_rules directory as JSON map {filename: content}.
fn read_ai_rules_dir(dir: &PathBuf) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut map: HashMap<String, String> = HashMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let filename = path.file_name()?.to_string_lossy().to_string();
        // Only sync .md files
        if !filename.ends_with(".md") {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            map.insert(filename, content);
        }
    }
    if map.is_empty() {
        None
    } else {
        serde_json::to_string(&map).ok()
    }
}

/// Collect all local profile data into a map {key: value_string}.
pub fn collect_local_profile() -> HashMap<String, String> {
    let pm = get_path_manager_arc();
    let profile = pm.profile_dir();
    let ssh_dir = pm.ssh_connections_dir();
    let rules_dir = pm.user_rules_dir();

    let mut map = HashMap::new();

    // ui_prefs.json
    if let Some(content) = read_file_opt(&profile.join("ui_prefs.json")) {
        map.insert("ui_prefs".to_string(), content);
    }

    // ssh/ssh_connections.json
    if let Some(content) = read_file_opt(&ssh_dir.join("ssh_connections.json")) {
        map.insert("ssh_connections".to_string(), content);
    }

    // ssh/known_hosts
    if let Some(content) = read_file_opt(&ssh_dir.join("known_hosts")) {
        map.insert("ssh_known_hosts".to_string(), content);
    }

    // ssh/remote_workspace.json
    if let Some(content) = read_file_opt(&ssh_dir.join("remote_workspace.json")) {
        map.insert("ssh_remote_workspace".to_string(), content);
    }

    // rules/ directory → JSON map
    if let Some(content) = read_ai_rules_dir(&rules_dir) {
        map.insert("ai_rules".to_string(), content);
    }

    map
}

/// Upload all local profile data to server.
///
/// Non-fatal: individual key failures are collected into errors array.
pub async fn upload_profile() -> Result<SyncResult, String> {
    let token = get_auth_token().ok_or_else(|| "not logged in".to_string())?;
    let base_url = get_base_url().await;
    let url = format!(
        "{}/ai00-s/api/ai/profile_sync",
        base_url.trim_end_matches('/')
    );

    let local_data = collect_local_profile();
    let client = reqwest::Client::new();
    let mut uploaded = 0usize;
    let mut errors = Vec::new();

    for key in SYNC_KEYS {
        let value = match local_data.get(*key) {
            Some(v) => v.clone(),
            None => {
                // Local file doesn't exist — skip this key
                log::debug!("[profile_sync] skip upload {}: local file missing", key);
                continue;
            }
        };

        let body = serde_json::json!({ "key": key, "value": value });
        match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        {
            Ok(resp) => match resp.json::<ApiResponse<UploadData>>().await {
                Ok(parsed) if parsed.code == 0 => {
                    uploaded += 1;
                    log::info!("[profile_sync] uploaded key: {}", key);
                }
                Ok(parsed) => {
                    let err = format!(
                        "upload {} failed: {} (code {})",
                        key, parsed.message, parsed.code
                    );
                    log::warn!("[profile_sync] {}", err);
                    errors.push(err);
                }
                Err(e) => {
                    let err = format!("upload {} parse response failed: {}", key, e);
                    log::warn!("[profile_sync] {}", err);
                    errors.push(err);
                }
            },
            Err(e) => {
                let err = format!("upload {} request failed: {}", key, e);
                log::warn!("[profile_sync] {}", err);
                errors.push(err);
            }
        }
    }

    Ok(SyncResult {
        uploaded,
        downloaded: 0,
        errors,
    })
}

/// Write ai_rules JSON map to rules/ directory.
fn write_ai_rules_dir(dir: &PathBuf, value: &str) -> Result<(), String> {
    let map: HashMap<String, String> =
        serde_json::from_str(value).map_err(|e| format!("parse ai_rules json failed: {}", e))?;

    std::fs::create_dir_all(dir).map_err(|e| format!("create rules dir failed: {}", e))?;

    for (filename, content) in &map {
        let path = dir.join(filename);
        std::fs::write(&path, content)
            .map_err(|e| format!("write rule file {} failed: {}", filename, e))?;
    }

    Ok(())
}

/// Download all profile data from server and apply to local files.
///
/// Non-fatal: individual key failures are collected into errors array.
/// Files that don't exist on server are skipped (not an error).
pub async fn download_profile() -> Result<SyncResult, String> {
    let token = get_auth_token().ok_or_else(|| "not logged in".to_string())?;
    let base_url = get_base_url().await;
    let url = format!(
        "{}/ai00-s/api/ai/profile_sync?all=1",
        base_url.trim_end_matches('/')
    );

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("download request failed: {}", e))?;

    let parsed: ApiResponse<DownloadAllData> = resp
        .json()
        .await
        .map_err(|e| format!("parse download response failed: {}", e))?;

    if parsed.code != 0 {
        return Err(format!(
            "server error: {} (code {})",
            parsed.message, parsed.code
        ));
    }

    let items = parsed.data.map(|d| d.items).unwrap_or_default();
    let pm = get_path_manager_arc();
    let profile = pm.profile_dir();
    let ssh_dir = pm.ssh_connections_dir();
    let rules_dir = pm.user_rules_dir();

    // Ensure directories exist
    std::fs::create_dir_all(&profile).map_err(|e| format!("create profile dir failed: {}", e))?;
    std::fs::create_dir_all(&ssh_dir).map_err(|e| format!("create ssh dir failed: {}", e))?;

    let mut downloaded = 0usize;
    let mut errors = Vec::new();

    for key in SYNC_KEYS {
        let item = match items.get(*key) {
            Some(item) if !item.value.is_empty() => item,
            _ => {
                log::debug!("[profile_sync] skip download {}: server has no data", key);
                continue;
            }
        };

        let result = match *key {
            "ui_prefs" => std::fs::write(profile.join("ui_prefs.json"), &item.value),
            "ssh_connections" => {
                std::fs::create_dir_all(&ssh_dir).ok();
                std::fs::write(ssh_dir.join("ssh_connections.json"), &item.value)
            }
            "ssh_known_hosts" => {
                std::fs::create_dir_all(&ssh_dir).ok();
                std::fs::write(ssh_dir.join("known_hosts"), &item.value)
            }
            "ssh_remote_workspace" => {
                std::fs::create_dir_all(&ssh_dir).ok();
                std::fs::write(ssh_dir.join("remote_workspace.json"), &item.value)
            }
            "ai_rules" => {
                std::fs::create_dir_all(&rules_dir).ok();
                match write_ai_rules_dir(&rules_dir, &item.value) {
                    Ok(_) => Ok(()),
                    Err(e) => Err(std::io::Error::other(e)),
                }
            }
            _ => continue,
        };

        match result {
            Ok(_) => {
                downloaded += 1;
                log::info!("[profile_sync] downloaded key: {}", key);
            }
            Err(e) => {
                let err = format!("download {} write failed: {}", key, e);
                log::warn!("[profile_sync] {}", err);
                errors.push(err);
            }
        }
    }

    Ok(SyncResult {
        uploaded: 0,
        downloaded,
        errors,
    })
}

/// Clear all local profile data (called after unbind, before logout).
///
/// Removes: ui_prefs.json, ssh/ connections, rules/, but keeps auth_vault/ and
/// kv_vault/ (those are cleared by auth_vault::clear_auth).
pub fn clear_local_profile() -> Result<(), String> {
    let pm = get_path_manager_arc();
    let profile = pm.profile_dir();
    let ssh_dir = pm.ssh_connections_dir();
    let rules_dir = pm.user_rules_dir();

    let mut errors = Vec::new();

    // Remove ui_prefs.json
    let ui_prefs = profile.join("ui_prefs.json");
    if ui_prefs.exists() {
        if let Err(e) = std::fs::remove_file(&ui_prefs) {
            errors.push(format!("remove ui_prefs.json: {}", e));
        }
    }

    // Remove ssh/ directory (connections only, not secrets)
    if ssh_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&ssh_dir) {
            errors.push(format!("remove ssh connections dir: {}", e));
        }
    }

    // Remove rules/ directory
    if rules_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&rules_dir) {
            errors.push(format!("remove rules dir: {}", e));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("partial clear: {}", errors.join("; ")))
    }
}

// === Tauri commands ===

/// Upload local profile to server (called before unbind or manually).
#[tauri::command]
pub async fn sync_profile_upload() -> Result<SyncResult, String> {
    upload_profile().await
}

/// Download profile from server and apply to local (called after login).
#[tauri::command]
pub async fn sync_profile_download() -> Result<SyncResult, String> {
    download_profile().await
}

/// Clear local profile data (called after unbind).
#[tauri::command]
pub fn sync_profile_clear_local() -> Result<(), String> {
    clear_local_profile()
}
