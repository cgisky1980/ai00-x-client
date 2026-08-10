//! P2P 下载相关 Tauri 命令（Stage 5.12，v9 P2P 重构）
//!
//! 暴露三个命令给前端：
//!
//! - [`p2p_download_share`] — 通过 BT 下载 share 文件
//! - [`p2p_cancel_download`] — 取消下载（切歌时调用）
//! - [`p2p_get_status`] — 查询下载状态（供 UI 显示）
//!
//! # 全局单例
//!
//! P2pDownloader 通过 [`crate::share::p2p::init_global_p2p_downloader`] 在
//! `AppState::new_async` 中初始化为全局单例，本模块命令通过
//! [`crate::share::p2p::get_global_p2p_downloader`] 获取。
//!
//! # 调用流程
//!
//! 前端播放 share 时：
//! 1. 调 `share_get_meta` 拿到 `magnet_link`
//! 2. 调 `p2p_download_share` 下载（超时默认 120s）
//! 3. 轮询 `p2p_get_status` 显示进度（或监听 Tauri event，未来扩展）
//! 4. 下载完成 → 拿 `file_path` 播放
//! 5. 切歌时调 `p2p_cancel_download` 释放资源

use crate::share::p2p::{
    get_global_base_cache_dir, get_global_p2p_downloader, P2pCacheStats, P2pDownloadOptions,
    P2pDownloadResult, P2pProgress, P2pStatus,
};

/// 通过 BT 下载 share 文件。
///
/// # Parameters
///
/// - `share_id`：分享 ID（用于追踪下载状态）
/// - `magnet_link`：磁力链接（来自 `share_get_meta` 的 `magnetLink` 字段）
/// - `filename`：期望的文件名（如 `{share_id}.flac`），用于返回 `filePath`
/// - `timeout_secs`：超时秒数（可选，默认 120，最小 30）
///
/// # Returns
///
/// [`P2pDownloadResult`]，包含下载完成的文件绝对路径、用时、字节数。
///
/// # Errors
///
/// - P2pDownloader 未初始化（服务端未启用 webtorrent 后端）
/// - 磁力链接解析失败
/// - 下载超时
/// - torrent 进入 Error 状态
#[tauri::command]
pub async fn p2p_download_share(
    share_id: String,
    magnet_link: String,
    filename: String,
    timeout_secs: Option<u64>,
) -> Result<P2pDownloadResult, String> {
    let downloader = get_global_p2p_downloader().ok_or_else(|| {
        "P2P downloader not initialized (server may not use webtorrent backend)".to_string()
    })?;
    let cache_dir = get_global_base_cache_dir()
        .ok_or_else(|| "P2P base cache dir not initialized (internal error)".to_string())?;

    let opts = P2pDownloadOptions {
        magnet_link,
        cache_dir,
        filename,
        timeout_secs: timeout_secs.unwrap_or(120),
    };

    downloader
        .download(&share_id, opts)
        .await
        .map_err(|e| format!("P2P download failed: {e}"))
}

/// 取消指定 share 的 P2P 下载并释放资源。
///
/// 切歌或用户主动停止时调用。若 `share_id` 不在活跃下载中则静默返回 Ok（幂等）。
#[tauri::command]
pub async fn p2p_cancel_download(share_id: String) -> Result<(), String> {
    let downloader = get_global_p2p_downloader().ok_or_else(|| {
        "P2P downloader not initialized (server may not use webtorrent backend)".to_string()
    })?;
    downloader
        .cancel(&share_id)
        .await
        .map_err(|e| format!("Failed to cancel P2P download: {e}"))
}

/// 查询指定 share 的 P2P 下载状态（供 UI 显示进度）。
///
/// 若 `share_id` 不在活跃下载中则返回 [`P2pStatus::Idle`]。
#[tauri::command]
pub async fn p2p_get_status(share_id: String) -> Result<P2pStatus, String> {
    let downloader = get_global_p2p_downloader().ok_or_else(|| {
        "P2P downloader not initialized (server may not use webtorrent backend)".to_string()
    })?;
    Ok(downloader.get_status(&share_id).await)
}

/// 查询指定 share 的 P2P 下载实时进度（字节/百分比/节点数/速率）。
///
/// 若 `share_id` 不在活跃下载中则返回 `null`。
#[tauri::command]
pub async fn p2p_get_progress(share_id: String) -> Result<Option<P2pProgress>, String> {
    let downloader = get_global_p2p_downloader().ok_or_else(|| {
        "P2P downloader not initialized (server may not use webtorrent backend)".to_string()
    })?;
    Ok(downloader.get_progress(&share_id).await)
}

/// 列出全部活跃下载/做种条目，供「下载队列进度 + 做种可视化」。
///
/// P2P 未初始化（非 webtorrent 后端）时返回空数组而非报错。
#[tauri::command]
pub async fn p2p_list() -> Result<Vec<P2pProgress>, String> {
    let downloader = get_global_p2p_downloader().ok_or_else(|| {
        "P2P downloader not initialized (server may not use webtorrent backend)".to_string()
    })?;
    Ok(downloader.list().await)
}

/// 停止做种/下载并（可选）删除本地缓存文件，将该 share 从活跃列表移除。
///
/// # Parameters
///
/// - `share_id`：目标分享 ID
/// - `delete_file`：为 true 时删除 `{cache_dir}/{filename}`；为 false 则仅停止做种、保留文件（可重播续传）
#[tauri::command]
pub async fn p2p_remove(share_id: String, delete_file: bool) -> Result<(), String> {
    let downloader = get_global_p2p_downloader().ok_or_else(|| {
        "P2P downloader not initialized (server may not use webtorrent backend)".to_string()
    })?;
    downloader
        .remove(&share_id, delete_file)
        .await
        .map_err(|e| format!("Failed to remove P2P seeding: {e}"))
}

/// 缓存占用统计（`{cache_dir}` 下的 `.flac`/`.a00m` 文件）。
#[tauri::command]
pub async fn p2p_cache_stats() -> Result<P2pCacheStats, String> {
    let downloader = get_global_p2p_downloader().ok_or_else(|| {
        "P2P downloader not initialized (server may not use webtorrent backend)".to_string()
    })?;
    Ok(downloader.cache_stats().await)
}

/// 批量停止做种并（可选）删除本地缓存文件。
///
/// # Parameters
///
/// - `share_ids`：目标分享 ID 列表
/// - `delete`：为 true 时删除文件（用于清空/清理缓存）；为 false 时仅停止做种
#[tauri::command]
pub async fn p2p_clear_cache(share_ids: Vec<String>, delete: bool) -> Result<(), String> {
    let downloader = get_global_p2p_downloader().ok_or_else(|| {
        "P2P downloader not initialized (server may not use webtorrent backend)".to_string()
    })?;
    downloader
        .clear_cache(&share_ids, delete)
        .await
        .map_err(|e| format!("Failed to clear P2P cache: {e}"))
}
