//! 应用窗口注册表（唯一来源）
//!
//! 由 `scripts/generate-app-windows.cjs` 从 `packages/shared/app-windows.json` 自动生成。
//! 禁止手动修改本文件；新增/调整窗口请编辑 JSON 源文件后运行
//! `pnpm run generate-app-windows`。
//! 前端 TS 侧对应 `src/web-ui/src/infrastructure/windows/windowRegistry.ts`。
//!
//! 只覆盖「标准应用窗口」。overlay / underlays / loader / preview 这类特殊窗口
//! （透明穿透 / 无边框 / 置顶 / 不可缩放）保留各自实现，不进本表。

/// 一个标准应用窗口的静态描述。
///
/// 窗口属性全部由本表锁死：前端只能凭 `id` 请求开窗，无法指定 URL、尺寸或
/// 是否置顶，避免任意字符串建窗带来的注入面。
#[derive(Debug, Clone, Copy)]
pub struct AppWindowSpec {
    /// 前端使用的白名单 id（`open_app_window` 的参数）
    pub id: &'static str,
    /// Tauri 窗口 label
    pub label: &'static str,
    /// 原生标题栏标题
    pub title: &'static str,
    /// `dist/main` 下的页面名，对应 `<page>.html`
    pub page: &'static str,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
    pub resizable: bool,
    pub center: bool,
    pub decorations: bool,
    pub transparent: bool,
    pub always_on_top: bool,
    pub skip_taskbar: bool,
    /// 建窗时注入主题首帧脚本（避免首帧闪白）
    pub inject_theme: bool,
}

/// 全部标准应用窗口
pub const APP_WINDOWS: &[AppWindowSpec] = &[
    AppWindowSpec {
        id: "community",
        label: "community",
        title: "社区",
        page: "community",
        width: 1100.0,
        height: 720.0,
        min_width: 860.0,
        min_height: 540.0,
        resizable: true,
        center: true,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        inject_theme: true,
    },
    AppWindowSpec {
        id: "music",
        label: "music",
        title: "乐",
        page: "music",
        width: 1000.0,
        height: 680.0,
        min_width: 860.0,
        min_height: 560.0,
        resizable: true,
        center: true,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        inject_theme: true,
    },
    AppWindowSpec {
        id: "tasks",
        label: "tasks",
        title: "策",
        page: "tasks",
        width: 900.0,
        height: 640.0,
        min_width: 640.0,
        min_height: 480.0,
        resizable: true,
        center: true,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        inject_theme: true,
    },
];
