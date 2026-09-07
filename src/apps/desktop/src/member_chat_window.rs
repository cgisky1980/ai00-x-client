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

    // 首帧背景要跟应用已选主题而非 OS：把主题类型在页面脚本运行前注入，
    // 供 member-chat.html 的内联样式在 tokens.css 加载前就选对背景色。
    // system/未知主题不标注 → 页面回退到 OS media query（此时两者本就一致）。
    let theme_type = {
        let config_service = &app.state::<crate::api::app_state::AppState>().config_service;
        config_service
            .get_config::<serde_json::Value>(Some("themes.current"))
            .await
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
    };
    let init_script = match theme_type.as_deref() {
        Some(id @ ("ai00-x-light" | "ai00-x-dark")) => {
            let resolved = if id == "ai00-x-light" { "light" } else { "dark" };
            format!(
                "document.documentElement.dataset.appThemeType='{}';",
                resolved
            )
        }
        _ => String::new(),
    };

    tauri::WebviewWindowBuilder::new(&app, MEMBER_CHAT_WINDOW_LABEL, webview_url)
        .title("Ai00-X 聊天")
        .inner_size(1100.0, 720.0)
        .min_inner_size(860.0, 540.0)
        .center()
        .resizable(true)
        .initialization_script(&init_script)
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
