use ai00_x_core::service::config::server_endpoints::local_web_origin;
use tauri::Manager;

const MEMBER_CHAT_WINDOW_LABEL: &str = "member-chat";

fn get_member_chat_url() -> String {
    format!("{}/main/member-chat.html", local_web_origin())
}

/// 打开独立会员聊天窗口。已存在则聚焦。
#[tauri::command]
pub async fn open_member_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(MEMBER_CHAT_WINDOW_LABEL) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = get_member_chat_url();
    let webview_url =
        tauri::WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {e}"))?);

    tauri::WebviewWindowBuilder::new(&app, MEMBER_CHAT_WINDOW_LABEL, webview_url)
        .title("Ai00-X 聊天")
        .inner_size(1100.0, 720.0)
        .center()
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to create member chat window: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn close_member_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MEMBER_CHAT_WINDOW_LABEL) {
        window
            .close()
            .map_err(|e| format!("Failed to close member chat window: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn focus_member_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MEMBER_CHAT_WINDOW_LABEL) {
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn is_member_chat_window_open(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(app.get_webview_window(MEMBER_CHAT_WINDOW_LABEL).is_some())
}

pub fn close_member_chat_window_all(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MEMBER_CHAT_WINDOW_LABEL) {
        let _ = window.close();
    }
}
