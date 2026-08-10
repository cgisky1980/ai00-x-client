use ai00_x_core::service::config::server_endpoints::local_web_origin;
use tauri::Manager;

const PREVIEW_WINDOW_LABEL: &str = "preview";

fn get_preview_url(query: &str) -> String {
    format!("{}/main/preview.html{}", local_web_origin(), query)
}

#[tauri::command]
pub async fn open_preview_window(app: tauri::AppHandle, url: Option<String>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let webview_url = if let Some(custom_url) = url {
        tauri::WebviewUrl::External(
            custom_url
                .parse()
                .map_err(|e| format!("Invalid URL: {}", e))?,
        )
    } else {
        let query = String::new();
        let url = get_preview_url(&query);
        tauri::WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?)
    };

    tauri::WebviewWindowBuilder::new(&app, PREVIEW_WINDOW_LABEL, webview_url)
        .title("Ai00-X Preview")
        .inner_size(960.0, 640.0)
        .center()
        .decorations(false)
        .resizable(false)
        .build()
        .map_err(|e| format!("Failed to create preview window: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn close_preview_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
        window
            .close()
            .map_err(|e| format!("Failed to close preview window: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn focus_preview_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn is_preview_window_open(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(app.get_webview_window(PREVIEW_WINDOW_LABEL).is_some())
}

pub fn close_all_preview_windows(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
        let _ = window.close();
    }
}
