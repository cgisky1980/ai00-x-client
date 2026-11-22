//! 灵动岛「全屏避让」检测。
//!
//! 我们的是全屏置顶 overlay，岛不会被真正遮挡；真正想要的效果是：
//! 当前台应用进入全屏/最大化、占据岛所在的顶部区域时，岛主动收成贴边细线，
//! 避免打扰（借鉴岛仔 Daozai 的窗口遮挡避让，语义按透明 overlay 架构调整）。
//!
//! 实现：独立低频线程检测前台窗口是否覆盖岛区域；状态翻转时 emit
//! `island://occlusion` 事件给 web-ui。
//!
//! 平台支持矩阵：
//! - Windows：完整实现（GetForegroundWindow + GetWindowRect / IsZoomed）。
//! - macOS / Linux / 其他：降级为「永不避让」（检测函数恒 false），
//!   功能缺失但编译与运行不受影响，岛保持常驻展开；
//!   降级平台仍走同一套循环/事件逻辑，仅检测结果恒 false，避免平台特化分支
//!   带来的死代码与 unused 警告。

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

/// 避让检测线程运行标记（避免重复 spawn）。
static THREAD_RUNNING: AtomicBool = AtomicBool::new(false);

/// 检测间隔。Windows 需要及时响应全屏切换；降级平台拉长间隔省电。
#[cfg(target_os = "windows")]
const POLL_INTERVAL: Duration = Duration::from_millis(600);
#[cfg(not(target_os = "windows"))]
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// 启动避让检测线程（各平台均可调用；降级平台恒不避让）。
pub fn spawn_island_occlusion_thread(app_handle: tauri::AppHandle) {
    if THREAD_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    thread::spawn(move || {
        let mut last_occluded = false;
        loop {
            let occluded = detect_foreground_covers_island();
            if occluded != last_occluded {
                let _ = app_handle.emit(
                    "island://occlusion",
                    serde_json::json!({ "occluded": occluded }),
                );
                last_occluded = occluded;
            }
            thread::sleep(POLL_INTERVAL);
        }
        // 常驻循环，进程生命周期内不退出，THREAD_RUNNING 保持 true 是预期行为。
    });
}

/// 判断前台窗口是否覆盖岛所在的顶部区域（全屏/最大化）。
#[cfg(target_os = "windows")]
fn detect_foreground_covers_island() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowThreadProcessId, IsZoomed,
        SM_CXSCREEN, SM_CYSCREEN,
    };

    unsafe {
        let hwnd = match GetForegroundWindow() {
            h if !h.is_invalid() => h,
            _ => return false,
        };

        // 排除我们自己的进程（overlay/underlay/各应用窗都属本进程）。
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() {
            return false;
        }

        // 最大化窗口直接判定为避让（最小化窗口通常已非前台）。
        if IsZoomed(hwnd).as_bool() {
            return true;
        }

        // 非最大化但矩形几乎铺满屏幕且从顶部开始 → 视为全屏应用。
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let screen_w = GetSystemMetrics(SM_CXSCREEN);
        let screen_h = GetSystemMetrics(SM_CYSCREEN);
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        let covers_width = w >= (screen_w as f64 * 0.92) as i32;
        let covers_height = h >= (screen_h as f64 * 0.92) as i32;
        let near_top = rect.top <= 8;

        covers_width && covers_height && near_top
    }
}

/// 非 Windows 平台降级：不做全屏检测，岛保持常驻（功能缺失但可编译运行）。
#[cfg(not(target_os = "windows"))]
fn detect_foreground_covers_island() -> bool {
    false
}
