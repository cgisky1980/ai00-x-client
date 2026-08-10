//! P2P 下载器（基于 fx-torrent 标准 BitTorrent，v9）
//!
//! 在 [`crate::share::ShareDownloader`] 中作为 HTTP 下载的替代路径。流程：
//! 1. 从 `ShareMeta.magnet_link` 拿到磁力链接
//! 2. fx-torrent session 添加 torrent，下载到 `cache_dir`
//! 3. 监听 `TorrentState::Finished` / `Seeding` 事件，视为下载完成
//! 4. 超时（默认 120s）或进入 Error 状态则返回错误
//!
//! # 关于 WebSeed
//!
//! v9 决策：去掉 WebSeed（BEP 19）。所有 piece 仅从 peer 获取，强制 P2P。
//! 服务器侧 [`ai00_salvo::seeder_state::SeederState`] 作为常驻 seeder 保证
//! swarm 永不死亡，从而无需 HTTP 兜底。
//!
//! # 关于做种
//!
//! 采用「长期做种（遇则弃）」策略：下载完成后 fx-torrent 自动进入 Seeding
//! 状态（除非被 remove），客户端自然成为 seeder 贡献上行。切歌时**不移除**
//! torrent，文件长期留存并持续做种；仅在手动清理时调用 [`P2pDownloader::cancel`]
//! 停止做种。重播同一 share 时通过 [`P2pDownloader::download`] 的复用快路径
//! （状态为 Seeding 且文件存在）直接返回，无需重新下载。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use fx_callback::Callback;
use fx_torrent::{
    FxTorrentSession, Session, SessionConfig, Torrent, TorrentEvent, TorrentFlags, TorrentHandle,
    TorrentState,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// 全局 P2pDownloader 单例（由 [`init_global_p2p_downloader`] 初始化）。
///
/// 采用与 MCP / AI Rules 一致的全局单例模式，避免侵入 `AppState`。
static GLOBAL_P2P_DOWNLOADER: OnceLock<Arc<P2pDownloader>> = OnceLock::new();

/// 全局 base_cache_dir（与 P2pDownloader::new 时传入的路径一致）。
///
/// p2p_api.rs 在构造 `P2pDownloadOptions.cache_dir` 时读取此值，
/// 保证与 fx-torrent session base_path 一致。
static GLOBAL_BASE_CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 初始化全局 P2pDownloader 单例。
///
/// 应在 `AppState::new_async` 中调用一次。重复调用返回 `Err`（已初始化）。
///
/// # Errors
///
/// - `P2pDownloader::new` 失败（fx-torrent session 初始化失败）
/// - 已初始化（OnceLock 已占用）
pub fn init_global_p2p_downloader(base_cache_dir: PathBuf, upload_slots: usize) -> Result<()> {
    let downloader = Arc::new(P2pDownloader::new(base_cache_dir.clone(), upload_slots)?);
    GLOBAL_P2P_DOWNLOADER
        .set(downloader)
        .map_err(|_| anyhow::anyhow!("global P2pDownloader already initialized"))?;
    GLOBAL_BASE_CACHE_DIR
        .set(base_cache_dir)
        .map_err(|_| anyhow::anyhow!("global base_cache_dir already initialized"))?;
    Ok(())
}

/// 获取全局 P2pDownloader 单例。
///
/// 未初始化时返回 `None`（p2p_api.rs 应将此映射为错误响应）。
pub fn get_global_p2p_downloader() -> Option<Arc<P2pDownloader>> {
    GLOBAL_P2P_DOWNLOADER.get().cloned()
}

/// 获取全局 base_cache_dir（用于构造 `P2pDownloadOptions.cache_dir`）。
pub fn get_global_base_cache_dir() -> Option<PathBuf> {
    GLOBAL_BASE_CACHE_DIR.get().cloned()
}

/// P2P 下载选项
#[derive(Debug, Clone)]
pub struct P2pDownloadOptions {
    /// 磁力链接（来自 `ShareMeta.magnet_link`）
    pub magnet_link: String,
    /// 缓存目录（fx-torrent session base_path，下载文件存放位置）
    pub cache_dir: PathBuf,
    /// 期望的文件名（如 `{share_id}.a00m`），用于返回 `file_path`
    pub filename: String,
    /// 总超时（秒，默认 120，最小 30）
    pub timeout_secs: u64,
}

impl Default for P2pDownloadOptions {
    fn default() -> Self {
        Self {
            magnet_link: String::new(),
            cache_dir: PathBuf::new(),
            filename: String::new(),
            timeout_secs: 120,
        }
    }
}

/// P2P 下载结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pDownloadResult {
    /// 下载完成的文件绝对路径
    pub file_path: String,
    /// 是否走了 P2P 路径（v9 始终为 true，保留字段供未来 HTTP 降级使用）
    pub used_p2p: bool,
    /// 下载用时（毫秒）
    pub elapsed_ms: u64,
    /// 下载字节数（文件大小）
    pub downloaded_bytes: u64,
}

/// P2P 状态（供 UI 显示）
///
/// v9 去掉 `Fallback`（无 HTTP 降级）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum P2pStatus {
    /// 空闲（无下载任务）
    Idle,
    /// 正在连接 tracker / DHT 获取 peer
    Connecting,
    /// 已连上 peer，正在下载
    Downloading,
    /// 下载完成，正在做种
    Seeding,
    /// 出错（超时 / torrent 错误 / 取消）
    Error,
}

/// 活跃下载条目
struct ActiveDownload {
    status: P2pStatus,
    /// fx-torrent torrent handle，用于 cancel
    torrent_handle: Option<TorrentHandle>,
    /// 目标文件名（如 `{share_id}.flac`），用于删除缓存
    filename: String,
    /// 已下载字节数（实时进度快照，由下载事件循环刷新）
    downloaded: u64,
    /// 总字节数（实时进度快照）
    total: u64,
    /// 当前连接节点数（实时进度快照）
    peers: u64,
    /// 下载速率（字节/秒，实时进度快照）
    download_rate: u64,
    /// 上传速率（字节/秒，实时进度快照，做种可视化）
    upload_rate: u64,
    /// 累计上传字节数（实时进度快照，做种可视化）
    uploaded: u64,
    /// 最近一次错误原因（如 "timeout" / "no_source" / "torrent_error"）
    last_error: Option<String>,
}

/// P2P 下载实时进度（供 UI 显示）。
///
/// 由 [`p2p_get_progress`] 命令返回；`percent` 为 0.0~1.0。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pProgress {
    /// 分享 ID
    pub share_id: String,
    /// 当前下载状态
    pub status: P2pStatus,
    /// 已下载字节数
    pub downloaded: u64,
    /// 总字节数（未知时为 0）
    pub total: u64,
    /// 下载进度（0.0~1.0）
    pub percent: f32,
    /// 当前连接节点数
    pub peer_count: u64,
    /// 下载速率（字节/秒）
    pub download_rate: u64,
    /// 上传速率（字节/秒，做种可视化）
    pub upload_rate: u64,
    /// 累计上传字节数（做种可视化）
    pub uploaded: u64,
    /// 下载文件名（如 `{share_id}.flac`）
    pub filename: String,
    /// 错误原因（timeout / no_source / torrent_error；无错误时为 null）
    pub error_reason: Option<String>,
}

/// 缓存占用统计（供「缓存管理」UI 显示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pCacheStats {
    /// 缓存总字节数
    pub total_bytes: u64,
    /// 缓存文件数
    pub file_count: u64,
    /// 各分享的占用明细
    pub per_share: Vec<P2pCacheEntry>,
}

/// 单个分享的缓存占用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pCacheEntry {
    /// 分享 ID（取自文件名 stem）
    pub share_id: String,
    /// 该文件占用字节数
    pub bytes: u64,
}

/// P2P 下载器（封装 fx-torrent session）
///
/// 单例使用，由 Tauri `State` 持有。内部维护一个 fx-torrent session，
/// 所有下载共享同一 session（节省资源）。
pub struct P2pDownloader {
    session: Arc<FxTorrentSession>,
    /// fx-torrent session base_path（torrent 文件存放目录），供删除缓存使用
    cache_dir: PathBuf,
    /// 当前活动下载的 share_id → 状态
    active: Arc<Mutex<HashMap<String, ActiveDownload>>>,
}

impl P2pDownloader {
    /// 创建新 P2P 下载器（初始化 fx-torrent session）。
    ///
    /// `base_cache_dir` 是 fx-torrent session 的 base_path，所有 torrent 文件
    /// 都会下载到此目录下。调用方应传入专门的 P2P 缓存目录
    /// （如 `{songs_dir}/.cache/p2p/`），与 HTTP 下载目录隔离避免冲突。
    ///
    /// # Errors
    ///
    /// - fx-torrent session 初始化失败（如 base_path 不可写）
    pub fn new(base_cache_dir: PathBuf, upload_slots: usize) -> Result<Self> {
        let session = FxTorrentSession::builder()
            .config(
                SessionConfig::builder()
                    .path(&base_cache_dir)
                    .client_name("Ai00-X")
                    // 近似限速：限制同时可向你上传的 peer 数（fx-torrent 无字节级限速）。
                    .peers_upload_slots(upload_slots)
                    .build(),
            )
            .default_extensions()
            .build()
            .context("init fx-torrent session")?;
        Ok(Self {
            session: Arc::new(session),
            cache_dir: base_cache_dir,
            active: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// 发起 P2P 下载。
    ///
    /// 返回下载完成的文件路径。若 P2P 失败（超时、torrent 错误），
    /// 调用方负责显示错误（v9 无 HTTP 降级）。
    ///
    /// # Errors
    ///
    /// - 磁力链接解析失败
    /// - fx-torrent 添加 torrent 失败
    /// - 下载超时（默认 120s）
    /// - torrent 进入 Error 状态
    pub async fn download(
        &self,
        share_id: &str,
        opts: P2pDownloadOptions,
    ) -> Result<P2pDownloadResult> {
        let start = Instant::now();
        let timeout_secs = opts.timeout_secs.max(30);
        let timeout = Duration::from_secs(timeout_secs);

        // 0. 复用快路径（长期做种 / 事后重播）：只要磁盘上已有该 share 的完整缓存
        //    文件（无论是否仍被 fx-torrent 管理），直接返回本地文件，无需重新联网
        //    下载。此前仅检查内部 active 表，应用重启或 webseed 残留后命中失败，
        //    现改为基于磁盘文件存在性判断，确保「已缓存即可本地播放」。
        if let Some((cached_path, _)) = self.cached_file_for(share_id).await {
            log::info!(
                "[p2p] reuse existing cached file: share_id={}, path={}",
                share_id,
                cached_path.display()
            );
            return Ok(P2pDownloadResult {
                file_path: cached_path.to_string_lossy().to_string(),
                used_p2p: true,
                elapsed_ms: 0,
                downloaded_bytes: 0,
            });
        }

        // 1. 标记状态为 Connecting
        {
            let mut active = self.active.lock().await;
            active.insert(
                share_id.to_string(),
                ActiveDownload {
                    status: P2pStatus::Connecting,
                    torrent_handle: None,
                    filename: opts.filename.clone(),
                    downloaded: 0,
                    total: 0,
                    peers: 0,
                    download_rate: 0,
                    upload_rate: 0,
                    uploaded: 0,
                    last_error: None,
                },
            );
        }

        // 2. 确保 cache_dir 存在
        if let Err(e) = tokio::fs::create_dir_all(&opts.cache_dir).await {
            self.set_status(share_id, P2pStatus::Error).await;
            return Err(anyhow::anyhow!(
                "create cache_dir {}: {}",
                opts.cache_dir.display(),
                e
            ));
        }

        // 3. 添加 torrent（fx-torrent 会自动 hash check 已存在文件）
        let torrent = match self
            .session
            .add_torrent_from_uri(&opts.magnet_link, TorrentFlags::default())
            .await
        {
            Ok(t) => t,
            Err(e) => {
                self.set_status(share_id, P2pStatus::Error).await;
                return Err(anyhow::anyhow!("add_torrent_from_uri failed: {e:?}"));
            }
        };

        // 4. 保存 torrent handle + 更新状态为 Downloading
        let torrent_handle = torrent.handle();
        {
            let mut active = self.active.lock().await;
            if let Some(entry) = active.get_mut(share_id) {
                entry.status = P2pStatus::Downloading;
                entry.torrent_handle = Some(torrent_handle);
            }
        }
        // 立即刷新一次进度快照（读取 torrent.metrics 到本地值再写入，避免跨 await 持有 Metrics 借用）
        self.refresh_progress_from_metrics(share_id, &torrent).await;

        // 5. 监听事件 + 周期刷新进度，等待下载完成
        let mut rx = torrent.subscribe();
        // 每 500ms 刷新一次进度快照；interval 首个 tick 立即触发，先消费掉以复用初始状态检查
        let mut progress_interval = tokio::time::interval(Duration::from_millis(500));
        progress_interval.tick().await;
        let wait_result = tokio::time::timeout(timeout, async {
            // 先检查一次当前状态（文件可能已完整，fx-torrent 直接进入 Seeding）
            match torrent.state().await {
                TorrentState::Finished | TorrentState::Seeding => return Ok(()),
                TorrentState::Error => anyhow::bail!("torrent entered error state"),
                _ => {}
            }
            // 监听事件与周期刷新进度
            loop {
                tokio::select! {
                    biased;
                    event = rx.recv() => {
                        match event {
                            Ok(ev) => {
                                if let TorrentEvent::StateChanged(new_state) = &*ev {
                                    match new_state {
                                        TorrentState::Finished | TorrentState::Seeding => return Ok(()),
                                        TorrentState::Error => {
                                            anyhow::bail!("torrent entered error state");
                                        }
                                        TorrentState::Downloading => {
                                            self.set_status(share_id, P2pStatus::Downloading).await;
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            Err(e) => anyhow::bail!("event channel closed: {e}"),
                        }
                    }
                    _ = progress_interval.tick() => {
                        self.refresh_progress_from_metrics(share_id, &torrent).await;
                    }
                }
            }
        })
        .await;

        // 6. 处理结果
        match wait_result {
            Ok(Ok(())) => {
                let elapsed_ms = start.elapsed().as_millis() as u64;
                let file_path = opts.cache_dir.join(&opts.filename);
                let downloaded_bytes = tokio::fs::metadata(&file_path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);

                self.set_status(share_id, P2pStatus::Seeding).await;
                log::info!(
                    "[p2p] download completed: share_id={}, path={}, size={}B, elapsed={}ms",
                    share_id,
                    file_path.display(),
                    downloaded_bytes,
                    elapsed_ms
                );

                Ok(P2pDownloadResult {
                    file_path: file_path.to_string_lossy().to_string(),
                    used_p2p: true,
                    elapsed_ms,
                    downloaded_bytes,
                })
            }
            Ok(Err(e)) => {
                self.set_error(share_id, "torrent_error").await;
                self.remove_torrent_by_share_id(share_id).await;
                Err(e.context("P2P download failed"))
            }
            Err(_) => {
                // 区分「未找到可用节点」与「一般超时」
                let peers = {
                    let active = self.active.lock().await;
                    active.get(share_id).map(|e| e.peers).unwrap_or(0)
                };
                let reason = if peers == 0 { "no_source" } else { "timeout" };
                self.set_error(share_id, reason).await;
                self.remove_torrent_by_share_id(share_id).await;
                Err(anyhow::anyhow!(
                    "P2P download timed out after {}s",
                    timeout_secs
                ))
            }
        }
    }

    /// 取消下载（移除 torrent，停止做种）。
    pub async fn cancel(&self, share_id: &str) -> Result<()> {
        self.remove_torrent_by_share_id(share_id).await;
        self.set_status(share_id, P2pStatus::Idle).await;
        Ok(())
    }

    /// 列出全部条目（下载中 / 做种），供做种可视化与队列进度。
    ///
    /// 除活跃表内的条目外，还会扫描缓存目录，把「磁盘上已有完整文件、但当前
    /// 进程未在管理其 torrent」的歌曲补齐为做种条目，从而在应用重启 / 进程
    /// 切换后，「做种管理」面板依然能看到已缓存的歌曲。
    pub async fn list(&self) -> Vec<P2pProgress> {
        let active = self.active.lock().await;
        let mut out = Vec::with_capacity(active.len());
        let mut seen = std::collections::HashSet::with_capacity(active.len());
        for (share_id, entry) in active.iter() {
            seen.insert(share_id.to_string());
            let total = entry.total;
            let percent = if total > 0 {
                (entry.downloaded as f32 / total as f32).min(1.0)
            } else {
                0.0
            };
            out.push(P2pProgress {
                share_id: share_id.clone(),
                status: entry.status,
                downloaded: entry.downloaded,
                total,
                percent,
                peer_count: entry.peers,
                download_rate: entry.download_rate,
                upload_rate: entry.upload_rate,
                uploaded: entry.uploaded,
                filename: entry.filename.clone(),
                error_reason: entry.last_error.clone(),
            });
        }
        drop(active);
        // 扫描缓存目录，补齐磁盘上已存在但不在活跃列表中的歌曲为做种条目。
        if let Ok(mut entries) = tokio::fs::read_dir(&self.cache_dir).await {
            while let Some(entry) = entries.next_entry().await.unwrap_or(None) {
                let path = entry.path();
                if !path.extension().and_then(|s| s.to_str()).is_some_and(|e| {
                    e.eq_ignore_ascii_case("flac") || e.eq_ignore_ascii_case("a00m")
                }) {
                    continue;
                }
                let Some(share_id) = path.file_stem().map(|s| s.to_string_lossy().to_string())
                else {
                    continue;
                };
                if seen.contains(&share_id) {
                    continue;
                }
                let filename = path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let bytes = tokio::fs::metadata(&path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                out.push(P2pProgress {
                    share_id,
                    status: P2pStatus::Seeding,
                    downloaded: bytes,
                    total: bytes,
                    percent: 1.0,
                    peer_count: 0,
                    download_rate: 0,
                    upload_rate: 0,
                    uploaded: 0,
                    filename,
                    error_reason: None,
                });
            }
        }
        out
    }

    /// 停止做种并（可选）删除本地缓存文件，真正将该 share 从活跃列表移除。
    ///
    /// `delete_file == true` 时删除缓存目录中的完整文件（.flac/.a00m，二者其一）。
    /// 同时停止该 share 的活跃 torrent。
    pub async fn remove(&self, share_id: &str, delete_file: bool) -> Result<()> {
        // 停止做种 / 下载
        self.remove_torrent_by_share_id(share_id).await;
        // 真正移除条目
        self.active.lock().await.remove(share_id);
        if delete_file {
            if let Some((path, _)) = self.cached_file_for(share_id).await {
                if let Err(e) = tokio::fs::remove_file(&path).await {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        log::warn!("[p2p] failed to remove cache file {}: {e}", path.display());
                    }
                } else {
                    log::info!("[p2p] removed cache file: {}", path.display());
                }
            }
        }
        Ok(())
    }

    /// 查找某 share 已完整存在于缓存目录中的文件（优先 `.flac`，其次 `.a00m`）。
    ///
    /// 无论该 share 是否仍被 fx-torrent 托管，只要磁盘上有完整缓存即可命中，
    /// 作为「重播直接本地播放」与「做种管理可见性」的可靠依据。
    async fn cached_file_for(&self, share_id: &str) -> Option<(PathBuf, String)> {
        let candidates = [
            (
                format!("{share_id}.flac"),
                self.cache_dir.join(format!("{share_id}.flac")),
            ),
            (
                format!("{share_id}.a00m"),
                self.cache_dir.join(format!("{share_id}.a00m")),
            ),
        ];
        for (name, path) in candidates {
            if tokio::fs::metadata(&path).await.is_ok() {
                return Some((path, name));
            }
        }
        None
    }

    /// 缓存占用统计（`{cache_dir}` 下的 `.flac`/`.a00m` 文件）。
    pub async fn cache_stats(&self) -> P2pCacheStats {
        let mut total_bytes: u64 = 0;
        let mut per_share = Vec::new();
        let mut entries = match tokio::fs::read_dir(&self.cache_dir).await {
            Ok(e) => e,
            Err(_) => {
                return P2pCacheStats {
                    total_bytes: 0,
                    file_count: 0,
                    per_share,
                }
            }
        };
        while let Some(entry) = entries.next_entry().await.unwrap_or(None) {
            let path = entry.path();
            // 仅统计缓存音频文件（跳过 .torrent 元数据等）
            if path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("flac") || e.eq_ignore_ascii_case("a00m"))
            {
                if let Ok(meta) = entry.metadata().await {
                    if meta.is_file() {
                        total_bytes += meta.len();
                        per_share.push(P2pCacheEntry {
                            share_id: path
                                .file_stem()
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_default(),
                            bytes: meta.len(),
                        });
                    }
                }
            }
        }
        P2pCacheStats {
            total_bytes,
            file_count: per_share.len() as u64,
            per_share,
        }
    }

    /// 批量停止做种并（可选）删除缓存。
    ///
    /// `delete` 为 true 时删除文件（用于「清空/清理缓存」）。
    pub async fn clear_cache(&self, share_ids: &[String], delete: bool) -> Result<()> {
        for id in share_ids {
            self.remove(id, delete).await?;
        }
        Ok(())
    }

    /// 查询状态
    pub async fn get_status(&self, share_id: &str) -> P2pStatus {
        self.active
            .lock()
            .await
            .get(share_id)
            .map(|d| d.status)
            .unwrap_or(P2pStatus::Idle)
    }

    /// 查询实时下载进度（供 UI 显示）。无活跃任务时返回 `None`。
    pub async fn get_progress(&self, share_id: &str) -> Option<P2pProgress> {
        let active = self.active.lock().await;
        let entry = active.get(share_id)?;
        let total = entry.total;
        let percent = if total > 0 {
            (entry.downloaded as f32 / total as f32).min(1.0)
        } else {
            0.0
        };
        Some(P2pProgress {
            share_id: share_id.to_string(),
            status: entry.status,
            downloaded: entry.downloaded,
            total,
            percent,
            peer_count: entry.peers,
            download_rate: entry.download_rate,
            upload_rate: entry.upload_rate,
            uploaded: entry.uploaded,
            filename: entry.filename.clone(),
            error_reason: entry.last_error.clone(),
        })
    }

    async fn set_status(&self, share_id: &str, status: P2pStatus) {
        let mut active = self.active.lock().await;
        if let Some(entry) = active.get_mut(share_id) {
            entry.status = status;
        }
    }

    /// 置为 Error 状态并记录错误原因。
    async fn set_error(&self, share_id: &str, reason: &str) {
        let mut active = self.active.lock().await;
        if let Some(entry) = active.get_mut(share_id) {
            entry.status = P2pStatus::Error;
            entry.last_error = Some(reason.to_string());
        }
    }

    /// 从 fx-torrent 指标读取字节/节点/速率，写入活跃条目进度快照。
    ///
    /// 先将 `torrent.metrics()` 的值拷贝到本地再 `.await` 加锁，避免在跨
    /// await 边界持有 `&Metrics`（借用 `torrent`），保证 future 满足 `Send`。
    async fn refresh_progress_from_metrics(&self, share_id: &str, torrent: &Torrent) {
        let (downloaded, total, peers, download_rate, upload_rate, uploaded) = {
            let m = torrent.metrics();
            (
                m.wanted_completed_size.get(),
                m.wanted_size.get(),
                m.peers.get(),
                u64::from(m.download.rate()),
                u64::from(m.upload.rate()),
                m.upload.get(),
            )
        };
        let mut active = self.active.lock().await;
        if let Some(entry) = active.get_mut(share_id) {
            entry.downloaded = downloaded;
            entry.total = total;
            entry.peers = peers;
            entry.download_rate = download_rate;
            entry.upload_rate = upload_rate;
            entry.uploaded = uploaded;
        }
    }

    async fn remove_torrent_by_share_id(&self, share_id: &str) {
        let handle = {
            let mut active = self.active.lock().await;
            active
                .get_mut(share_id)
                .and_then(|d| d.torrent_handle.take())
        };
        if let Some(h) = handle {
            self.session.remove_torrent(&h).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p2p_status_serde_camel_case() {
        let json = serde_json::to_string(&P2pStatus::Idle).unwrap();
        assert_eq!(json, "\"idle\"");
        let json = serde_json::to_string(&P2pStatus::Downloading).unwrap();
        assert_eq!(json, "\"downloading\"");
    }

    #[test]
    fn p2p_download_result_camel_case() {
        let result = P2pDownloadResult {
            file_path: "/tmp/test.a00m".to_string(),
            used_p2p: true,
            elapsed_ms: 1000,
            downloaded_bytes: 1024,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"filePath\""));
        assert!(json.contains("\"usedP2p\""));
        assert!(json.contains("\"elapsedMs\""));
        assert!(json.contains("\"downloadedBytes\""));
    }

    #[test]
    fn p2p_download_options_default_timeout_120s() {
        let opts = P2pDownloadOptions::default();
        assert_eq!(opts.timeout_secs, 120);
    }
}
