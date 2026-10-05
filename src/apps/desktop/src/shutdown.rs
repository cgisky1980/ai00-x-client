//! 全量退出清理（P0-4.1）：托盘「退出」与 overlay/loader 关窗共用的唯一退出路径。
//!
//! 抽取自 lib.rs on_window_event 的 overlay 关闭序列；抽取目的：两条退出路径
//! 的清理语义永久一致，新增清理步骤只改这一处。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

/// 全量退出：使用统计落盘 → 级联关标准窗口 → underlay 清理 →
/// 子进程清理（含 dsh sidecar Job Object）→ exit(0)。
/// 幂等：CLEANUP_DONE 保证只执行一次，重复调用（双路径竞态）静默返回。
pub fn shutdown_app(app: &tauri::AppHandle) {
    static CLEANUP_DONE: AtomicBool = AtomicBool::new(false);
    if CLEANUP_DONE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        log::debug!("shutdown_app: cleanup already in progress, ignore");
        return;
    }
    log::info!("App shutdown requested, cleaning up");
    crate::shutdown_usage_stats(app);
    crate::window_template::close_all_app_windows(app);
    crate::underlay::cleanup(app);
    if let Some(win) = app.get_webview_window("underlays") {
        let _ = win.close();
    }
    ai00_x_core::util::process_manager::cleanup_all_processes();
    app.exit(0);
}
