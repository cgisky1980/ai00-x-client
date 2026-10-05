//! 标准应用窗口模板
//!
//! 统一「开 / 关 / 聚焦 / 是否打开」四件套。窗口属性全部来自 [`crate::window_registry`]
//! （由 `packages/shared/app-windows.json` 生成），新增一个窗口 = JSON 加一条 + 一个
//! html/entry，不再需要手写建窗模块与命令四件套。
//!
//! # 为什么用 id 白名单而不是裸 label
//!
//! 裸 label 建窗意味着前端可以凭任意字符串指定 URL 与窗口属性（尺寸、是否置顶、
//! 是否透明），这是一个注入面。改为 `id → AppWindowSpec` 查表后，前端只能请求
//! 注册表里已声明的窗口，所有属性由 Rust 侧锁死。
//!
//! # 覆盖范围
//!
//! 仅「标准应用窗口」（有边框、可缩放、可居中）。`overlay` / `underlays` /
//! `loader` / `preview` 这类特殊窗口（透明穿透 / 无边框 / 置顶 / 不可缩放）
//! 保留各自实现——但本模板的 spec 已含 `decorations` / `resizable` /
//! `transparent` / `always_on_top` / `skip_taskbar` 开关，将来若要并入
//! preview 之类，只需往 JSON 加一条即可。

use ai00_x_core::service::config::server_endpoints::local_web_origin;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::api::app_state::AppState;
use crate::window_registry::{AppWindowSpec, APP_WINDOWS};

/// 按 id 查窗口描述；未注册的 id 返回 `None`。
pub fn find_spec(id: &str) -> Option<&'static AppWindowSpec> {
    APP_WINDOWS.iter().find(|s| s.id == id)
}

/// 查表或拒绝（统一错误信息）。
fn require_spec(id: &str) -> Result<&'static AppWindowSpec, String> {
    find_spec(id).ok_or_else(|| format!("unknown window id: {id}"))
}

/// 主题首帧注入脚本。
///
/// 首帧背景要跟应用已选主题而非 OS：把主题类型在页面脚本运行前注入，供窗口
/// HTML 的内联样式在 tokens.css 加载前就选对背景色。
/// system / 未知主题不标注 → 页面回退到 OS media query（此时两者本就一致）。
///
/// ⚠️ 该脚本走 `initialization_script`（WebView2 = 每个新文档都注入，含初始的
/// about:blank），在**文档创建时**执行——此时 `document.documentElement` 可能尚不存在
/// （实测为 null），直接 `document.documentElement.dataset…` 会抛
/// `Cannot read properties of null (reading 'dataset')`（报错位置 `<anonymous>:1:26`）。
/// 故：立即尝试一次；失败则用 MutationObserver 盯着 `<html>` 一生效就写入
/// （比 DOMContentLoaded 早，首帧底色不吃亏），DOMContentLoaded 再兜一次；全程 try/catch。
pub async fn theme_init_script(app: &tauri::AppHandle) -> String {
    let theme_type = app
        .state::<AppState>()
        .config_service
        .get_config::<serde_json::Value>(Some("themes.current"))
        .await
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()));

    match theme_type.as_deref() {
        Some(id @ ("ai00-x-light" | "ai00-x-dark")) => {
            let resolved = if id == "ai00-x-light" {
                "light"
            } else {
                "dark"
            };
            format!(
                "(function(){{var t='{resolved}';function s(){{try{{var d=document&&document.documentElement;if(d){{if(d.dataset.appThemeType!==t)d.dataset.appThemeType=t;return true;}}}}catch(e){{}}return false;}}if(s())return;try{{if(typeof document!=='undefined'&&document){{var mo=new MutationObserver(function(){{if(s())mo.disconnect();}});mo.observe(document,{{childList:true,subtree:true}});document.addEventListener('DOMContentLoaded',function(){{s();mo.disconnect();}});}}}}catch(e){{}}}})();",
            )
        }
        _ => String::new(),
    }
}

/// 标准应用窗口统一初始尺寸：屏幕的 1/4（半宽 × 半高，逻辑点），
/// 保证所有窗口初始大小一致，不随注册表静态值漂移；注册表 min 值兜底。
fn quarter_screen_size(app: &tauri::AppHandle) -> (f64, f64) {
    const FALLBACK: (f64, f64) = (960.0, 540.0);
    match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor();
            let logical_w = monitor.size().width as f64 / scale;
            let logical_h = monitor.size().height as f64 / scale;
            (
                (logical_w / 2.0).floor().max(640.0),
                (logical_h / 2.0).floor().max(480.0),
            )
        }
        _ => FALLBACK,
    }
}

/// 打开一个标准应用窗口；已存在则取消最小化 + 聚焦复用（不重复建窗）。
#[tauri::command]
pub async fn open_app_window(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let spec = require_spec(&id)?;

    if let Some(existing) = app.get_webview_window(spec.label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = format!("{}/main/{}.html", local_web_origin(), spec.page);
    let webview_url = WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {e}"))?);

    let init_script = if spec.inject_theme {
        theme_init_script(&app).await
    } else {
        String::new()
    };

    let (init_w, init_h) = quarter_screen_size(&app);
    let mut builder = WebviewWindowBuilder::new(&app, spec.label, webview_url)
        .title(spec.title)
        .inner_size(init_w.max(spec.min_width), init_h.max(spec.min_height))
        .min_inner_size(spec.min_width, spec.min_height)
        .resizable(spec.resizable)
        .decorations(spec.decorations)
        .transparent(spec.transparent)
        .always_on_top(spec.always_on_top)
        .skip_taskbar(spec.skip_taskbar)
        .initialization_script(&init_script);
    if spec.center {
        builder = builder.center();
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create window {}: {e}", spec.label))?;

    log::info!("App window opened: {}", spec.label);
    Ok(())
}

/// 关闭一个标准应用窗口（未打开则静默成功）。
#[tauri::command]
pub async fn close_app_window(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let spec = require_spec(&id)?;
    if let Some(window) = app.get_webview_window(spec.label) {
        window
            .close()
            .map_err(|e| format!("Failed to close window {}: {e}", spec.label))?;
    }
    Ok(())
}

/// 聚焦一个标准应用窗口（未打开则静默成功——需要「没有就开」请用 [`open_app_window`]）。
#[tauri::command]
pub async fn focus_app_window(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let spec = require_spec(&id)?;
    if let Some(window) = app.get_webview_window(spec.label) {
        let _ = window.set_focus();
    }
    Ok(())
}

/// 窗口是否已打开。
#[tauri::command]
pub async fn is_app_window_open(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let spec = require_spec(&id)?;
    Ok(app.get_webview_window(spec.label).is_some())
}

/// 关闭全部标准应用窗口（主壳退出时的级联清理）。
///
/// 由 [`APP_WINDOWS`] 注册表驱动：新增窗口无需再往 `on_window_event` 里加分支。
pub fn close_all_app_windows(app: &tauri::AppHandle) {
    for spec in APP_WINDOWS {
        if let Some(window) = app.get_webview_window(spec.label) {
            let _ = window.close();
        }
    }
}
