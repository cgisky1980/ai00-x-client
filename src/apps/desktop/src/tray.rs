//! 系统托盘（P0-4.1）：引擎状态灯 + 快捷开窗 + 显式退出。
//!
//! 定位（见 参考/dsh桌面客户端对标-dsh-desktop对比与吸纳路线-20261001.md §4.1）：
//! 增值件而非缺陷修复。overlay 常驻桌面且不隐藏（用户口径，2026-10-01 定），
//! 所以托盘没有"呼出主界面"——双击/菜单直达策窗口；引擎状态灯 + 显式退出补控制面。

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// 创建托盘并启动状态轮询（setup 阶段调用一次）。
pub fn init_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "tray-status", "引擎：初始化…", false, None::<&str>)?;
    let open_tasks = MenuItem::with_id(app, "open-tasks", "策窗口", true, None::<&str>)?;
    let open_community = MenuItem::with_id(app, "open-community", "社区", true, None::<&str>)?;
    let engine_terminal =
        MenuItem::with_id(app, "engine-terminal", "引擎终端", true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Ai00-X", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open_tasks,
            &open_community,
            &engine_terminal,
            &PredefinedMenuItem::separator(app)?,
            &check_update,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let status_handle = status.clone();
    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?
        .clone();
    TrayIconBuilder::with_id("ai00-x-tray")
        .icon(icon)
        .tooltip("Ai00-X")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-tasks" | "open-community" => {
                let id = event.id().as_ref().trim_start_matches("open-").to_string();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::window_template::open_app_window(app.clone(), id).await {
                        log::warn!("[tray] open app window failed: {e}");
                    }
                });
            }
            // P2-B：引擎隔离终端（<DSH_HOME>/bin shim + wt/powershell）
            "engine-terminal" => {
                tauri::async_runtime::spawn(async {
                    if let Err(e) = crate::dsh_manager::open_engine_terminal().await {
                        log::warn!("[tray] open engine terminal failed: {e}");
                    }
                });
            }
            // 前端更新调度器（overlay）监听后复用其检查/安装流
            "check-update" => {
                if let Some(overlay) = app.get_webview_window("overlay") {
                    let _ = overlay.emit("tray://check-update", ());
                }
            }
            "quit" => crate::shutdown::shutdown_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 双击 = 策窗口（overlay 常驻可见，双击呼它无感知；策窗口有实感）
            if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                let app = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) =
                        crate::window_template::open_app_window(app.clone(), "tasks".into()).await
                    {
                        log::warn!("[tray] open tasks window failed: {e}");
                    }
                });
            }
        })
        .build(app)?;

    // 状态轮询：菜单首行文本每 10s 刷新（dsh phase → 人话）
    let status_for_poll = status_handle.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let text = engine_status_text().await;
            if let Err(e) = status_for_poll.set_text(text) {
                log::debug!("[tray] set status text failed: {e}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    });

    log::info!("System tray initialized");
    Ok(())
}

/// 引擎状态一行话（菜单首行，disabled 只读）。
async fn engine_status_text() -> String {
    match crate::dsh_manager::dsh_status().await {
        Ok(status) => match status.phase {
            crate::dsh_manager::DshPhase::Running { .. } => "引擎：运行中".into(),
            crate::dsh_manager::DshPhase::Installing { stage } => format!("引擎：{stage}"),
            crate::dsh_manager::DshPhase::Ready => "引擎：就绪（未运行）".into(),
            crate::dsh_manager::DshPhase::NotReady => "引擎：初始化…".into(),
            crate::dsh_manager::DshPhase::Failed { error } => {
                format!("引擎：异常（{}）", truncate(&error, 40))
            }
        },
        Err(e) => format!("引擎：状态未知（{}）", truncate(&e, 40)),
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max_chars).collect();
        format!("{cut}…")
    }
}
