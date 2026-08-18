//! App self-update via tauri-plugin-updater (exe-level updates).
//!
//! Resource-level updates (frontend zips / runtime) are handled by
//! `crate::resource_manager`; this module only covers the application binary.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Clone, Serialize)]
pub struct AppUpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppUpdateStatus {
    pub update_available: bool,
    pub info: Option<AppUpdateInfo>,
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<AppUpdateStatus, String> {
    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("build updater: {e}"))?;

    match updater.check().await {
        Ok(Some(update)) => Ok(AppUpdateStatus {
            update_available: true,
            info: Some(AppUpdateInfo {
                version: update.version.clone(),
                current_version: update.current_version.clone(),
                notes: update.body.clone(),
            }),
        }),
        Ok(None) => Ok(AppUpdateStatus {
            update_available: false,
            info: None,
        }),
        Err(e) => Err(format!("check update: {e}")),
    }
}

/// Download and install the pending update (signature verified by the
/// updater plugin), then restart the app.
#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<(), String> {
    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("build updater: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("check update: {e}"))?
        .ok_or_else(|| "no update available".to_string())?;

    log::info!(
        "[updater] installing update {} (current {})",
        update.version,
        update.current_version
    );

    update
        .download_and_install(
            |chunk, total| {
                if let Some(total) = total {
                    log::debug!("[updater] progress {}/{} bytes", chunk, total);
                }
            },
            || log::info!("[updater] download finished, installing"),
        )
        .await
        .map_err(|e| format!("download/install: {e}"))?;

    app.restart()
}
