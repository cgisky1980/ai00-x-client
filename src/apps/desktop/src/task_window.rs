use ai00_x_core::service::config::server_endpoints::local_web_origin;
use tauri::{Emitter, Manager};

const TASK_WINDOW_LABEL: &str = "task-window";

fn get_task_url(query: &str) -> String {
    format!("{}/main/chat.html{}", local_web_origin(), query)
}

#[tauri::command]
pub async fn open_task_window(
    app: tauri::AppHandle,
    session_id: Option<String>,
    session_title: Option<String>,
    open_settings: Option<bool>,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(TASK_WINDOW_LABEL) {
        let _ = existing.set_focus();
        if open_settings.unwrap_or(false) {
            let _ = app.emit("open-settings-scene", ());
        }
        return Ok(());
    }

    let title = session_title.unwrap_or_else(|| "Ai00-X".to_string());

    let mut params: Vec<String> = Vec::new();
    if let Some(sid) = &session_id {
        params.push(format!("sessionId={}", sid));
    }
    if open_settings.unwrap_or(false) {
        params.push("openSettings=1".to_string());
    }
    let query = if params.is_empty() {
        String::new()
    } else {
        format!("?{}", params.join("&"))
    };

    let url = get_task_url(&query);

    let webview_url =
        tauri::WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?);

    tauri::WebviewWindowBuilder::new(&app, TASK_WINDOW_LABEL, webview_url)
        .title(&title)
        .inner_size(1024.0, 768.0)
        .center()
        .decorations(false)
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to create task window: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn close_task_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(TASK_WINDOW_LABEL) {
        window
            .close()
            .map_err(|e| format!("Failed to close task window: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn focus_task_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(TASK_WINDOW_LABEL) {
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn is_task_window_open(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(app.get_webview_window(TASK_WINDOW_LABEL).is_some())
}

pub fn close_all_task_windows(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(TASK_WINDOW_LABEL) {
        let _ = window.close();
    }
}
