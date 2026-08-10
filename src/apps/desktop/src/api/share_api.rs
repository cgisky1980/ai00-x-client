//! 分享相关 Tauri 命令（Phase E.1 + E.2 + E.3）
//!
//! ## Phase E.1（上传 + 我的分享管理）
//!
//! - [`share_upload_archive`] — 上传本地加密 .a00m 归档到服务器
//! - [`share_list_mine`] — 列出当前会员的分享（分页）
//! - [`share_get_meta`] — 获取分享元数据
//! - [`share_delete`] — 吊销分享
//!
//! ## Phase E.2（浏览 / 下载解密 / 播放上报 / 统计 / 封面）
//!
//! - [`share_list_recent`] — 列出最近公开分享（浏览广场）
//! - [`share_download_and_decrypt`] — 下载 .a00m 并解密为 audio.flac
//! - [`share_record_play`] — 上报播放（用于播放计数）
//! - [`share_get_stats`] — 获取分享统计（播放数 + 评论数）
//! - [`share_get_cover`] — 获取封面图本地路径（带磁盘缓存，公开端点）
//!
//! ## Phase E.3（评论系统）
//!
//! - [`share_list_comments`] — 列出某分享下的评论（公开）
//! - [`share_add_comment`] — 添加评论（会员，可嵌套回复）
//! - [`share_edit_comment`] — 编辑评论（仅作者本人）
//! - [`share_delete_comment`] — 删除评论（仅作者本人）
//!
//! # 认证
//!
//! 所有命令通过 [`crate::auth::ensure_auth_synced`] 读取 member JWT，
//! 401 时自动刷新 token 重试一次。

use base64::Engine;
use tauri::State;

use crate::api::app_state::AppState;
use crate::share::{
    AddCommentRequest, CommentActionResult, CommentListResult, DownloadedShare, PaginatedResult,
    RecentSharesResult, RecommendRequest, RecommendResponse, ShareClient, ShareDeleteResult,
    ShareDownloader, ShareMeta, SharePlayResult, ShareStats, ShareUploadResult, SharedSongListItem,
    UploadShareInput,
};

// ============================================================================
// 错误格式化辅助
// ============================================================================

/// 将任意可转为 `anyhow::Error` 的错误转为前端可读字符串，保留完整因果链。
///
/// 默认 `{}` 格式只显示顶层错误，根因（如 IO 错误、连接重置等）丢失。
/// 本函数附加 `caused by:` 链，便于前端日志排查。
///
/// 接受 `anyhow::Error` / `std::io::Error` / `tokio::task::JoinError` 等
/// 所有可转换为 `anyhow::Error` 的类型（即实现了 `std::error::Error + Send + Sync + 'static`）。
///
/// **注意**：`anyhow::Error` 本身不实现 `std::error::Error`（设计如此），
/// 但实现了 `Into<anyhow::Error>`（identity），所以也能用本函数。
///
/// 示例输出：
/// ```text
/// Failed to download share: http error
///   caused by: connection reset by peer
/// ```
fn fmt_err<E: Into<anyhow::Error>>(prefix: &str, e: E) -> String {
    let e: anyhow::Error = e.into();
    let mut msg = format!("{prefix}: {e}");
    // chain() 第一个是 e 本身，跳过；后续是 source chain
    for cause in e.chain().skip(1) {
        msg.push_str(&format!("\n  caused by: {cause}"));
    }
    msg
}

/// 自动用 master password 表提取加密归档封面（与 `read_song_meta_auto` 对应）。
/// 遍历 `PASSWORDS` 表中所有版本密码，第一个解密成功的即为正确密码。
fn extract_cover_auto(
    archive_path: &std::path::Path,
    output_dir: &std::path::Path,
) -> std::result::Result<Option<String>, anyhow::Error> {
    for (_, pwd_bytes) in acestep::passwords::PASSWORDS {
        let pw_str = std::str::from_utf8(pwd_bytes).unwrap_or("");
        match acestep::package::extract_cover(archive_path, output_dir, Some(pw_str)) {
            Ok(path) => return Ok(path),
            Err(e) => {
                // 密码不匹配或其他错误，继续尝试下一个密码
                log::debug!("[extract_cover_auto] password attempt failed: {e}");
            }
        }
    }
    Err(anyhow::anyhow!(
        "no matching version password in embedded table"
    ))
}

// ============================================================================
// 命令 1b: share_upload_archive（作品库「分享」操作）
// ============================================================================

/// `share_upload_archive` 的请求参数。
///
/// 前端传入 camelCase 字段（Tauri 自动映射到 Rust snake_case 参数名）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareUploadArchiveRequest {
    /// 本地 `.a00m` 归档绝对路径
    pub archive_path: String,
}

/// 分享准备结果（spawn_blocking 产出，供异步上传使用）
struct PreparedShare {
    /// 待上传的 .a00m 加密归档路径（直接使用原文件）
    upload_file_path: String,
    /// 提取的封面路径（None = 归档无封面）
    cover_path: Option<String>,
    /// 从 song.json 读取的元数据
    title: String,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    duration_seconds: f64,
    /// v1.3.0+: 多语言分类标签 JSON 字符串（None = 未生成）
    tags: Option<String>,
    /// v1.3.0+: 256 维 f32 向量嵌入 base64 字符串（None = 未生成）
    embedding: Option<String>,
    /// 临时目录路径（封面提取目录，需上传后清理）
    cover_tmp_dir: String,
}

/// 将本地 `.a00m` 加密归档直接上传到 Ai00-Salvo 服务器。
///
/// 直接分享完整的加密 .a00m 文件（包含音频、歌词、创作上下文、评分、封面
/// 等全部内容）。文件保持 A00M 容器加密格式，只有 Ai00-X 自己的播放器
/// 能解密播放。
///
/// 流程：
/// 1. 从 auth 读取 member_id
/// 2. `spawn_blocking`：
///    a. 读取归档 song.json 元数据（title/artist/album/genre/duration）
///    b. 提取封面到临时目录
/// 3. 构造 `UploadShareInput` 并调用 `ShareClient::upload`（直接上传原文件）
/// 4. 清理临时封面目录
/// 5. 返回 `ShareUploadResult`
#[tauri::command]
pub async fn share_upload_archive(
    _state: State<'_, AppState>,
    request: ShareUploadArchiveRequest,
) -> Result<ShareUploadResult, String> {
    // 1. 读取 auth 信息获取 member_id
    let auth = crate::auth::ensure_auth_synced()
        .await
        .map_err(|e| format!("Failed to read auth info: {e}"))?
        .ok_or_else(|| "Not logged in — cannot share song".to_string())?;
    let member_id = auth
        .member_id
        .ok_or_else(|| "No member_id in auth — cannot share song".to_string())?;

    // 2. 获取 songs_dir 作为临时输出目录
    let pm = ai00_x_core::infrastructure::get_path_manager_arc();
    let songs_dir = pm.songs_dir();
    tokio::fs::create_dir_all(&songs_dir)
        .await
        .map_err(|e| fmt_err("Failed to create output dir", e))?;

    // 3. spawn_blocking：读取元数据 + 提取封面（自动用 master password）
    let archive_path_str = request.archive_path.clone();
    let ts = chrono::Utc::now().timestamp_millis();
    let cover_tmp_dir = songs_dir.join(format!("share_cover_{}_{}", member_id, ts));

    let prep =
        tokio::task::spawn_blocking(move || -> std::result::Result<PreparedShare, String> {
            let archive_path = std::path::Path::new(&archive_path_str);

            // 3a. 读取归档元数据（自动用 master password 解密）
            let (_manifest, song) = acestep::package::read_song_meta_auto(archive_path)
                .map_err(|e| fmt_err("Failed to read song meta", e))?;

            // 3b. 提取封面到临时目录（遍历 master password 表自动解密）
            let cover_path = extract_cover_auto(archive_path, &cover_tmp_dir)
                .map_err(|e| fmt_err("Failed to extract cover", e))?;

            // 3c. v1.3.0+: 提取 tags + embedding（推荐系统用）
            //     tags: Vec<String> → JSON 字符串
            //     embedding: Vec<f32> → base64(little-endian bytes)
            let tags_json = song
                .tags
                .as_ref()
                .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".into()));

            let embedding_b64 = song.embedding.as_ref().map(|v| {
                let bytes: Vec<u8> = v.iter().flat_map(|f| f.to_le_bytes()).collect();
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            });

            // 3d. 直接使用原加密归档文件上传
            Ok(PreparedShare {
                upload_file_path: archive_path_str,
                cover_path,
                title: song.title,
                artist: if song.artist.is_empty() {
                    None
                } else {
                    Some(song.artist)
                },
                album: if song.album.is_empty() {
                    None
                } else {
                    Some(song.album)
                },
                genre: if song.genre.is_empty() {
                    None
                } else {
                    Some(song.genre)
                },
                duration_seconds: song.duration_seconds as f64,
                tags: tags_json,
                embedding: embedding_b64,
                cover_tmp_dir: cover_tmp_dir.to_string_lossy().to_string(),
            })
        })
        .await
        .map_err(|e| fmt_err("Prepare task panicked", e))??;

    // 4. 上传到服务器
    let upload_input = UploadShareInput {
        file_path: prep.upload_file_path.clone(),
        title: prep.title.clone(),
        artist_name: prep.artist.clone(),
        album: prep.album.clone(),
        genre: prep.genre.clone(),
        duration_seconds: prep.duration_seconds,
        preview_duration_secs: 0.0,
        original_filename: None,
        cover_path: prep.cover_path.clone(),
        tags: prep.tags.clone(),
        embedding: prep.embedding.clone(),
    };

    let client = ShareClient::new();
    let result = client
        .upload(&upload_input)
        .await
        .map_err(|e| fmt_err("Upload failed", e))?;

    // 5. 清理临时封面目录
    if let Err(e) = tokio::fs::remove_dir_all(&prep.cover_tmp_dir).await {
        log::warn!(
            "[share] failed to clean up cover dir {}: {}",
            prep.cover_tmp_dir,
            e
        );
    }

    Ok(result)
}

// ============================================================================
// 命令 2: share_list_mine
// ============================================================================

/// 列出当前会员的分享（分页）。
///
/// 对应服务端 `GET /api/v1/share/mine?page=&per_page=`。
#[tauri::command]
pub async fn share_list_mine(
    _state: State<'_, AppState>,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<PaginatedResult<SharedSongListItem>, String> {
    let client = ShareClient::new();
    client
        .list_mine(page.unwrap_or(1), per_page.unwrap_or(20))
        .await
        .map_err(|e| fmt_err("Failed to list my shares", e))
}

// ============================================================================
// 命令 3: share_get_meta
// ============================================================================

/// 获取分享元数据（公开端点）。
///
/// 对应服务端 `GET /api/v1/share/{id}`。
#[tauri::command]
pub async fn share_get_meta(
    _state: State<'_, AppState>,
    share_id: String,
) -> Result<ShareMeta, String> {
    let client = ShareClient::new();
    client
        .get_meta(&share_id)
        .await
        .map_err(|e| fmt_err("Failed to get share meta", e))
}

// ============================================================================
// 命令 4: share_delete
// ============================================================================

/// 吊销（删除）分享。仅作者可操作。
///
/// 对应服务端 `DELETE /api/v1/share/{id}`。
///
/// 成功后清理本地缓存目录 `{songs_dir}/.cache/{share_id}/`（含 cover.* +
/// 下载的 .a00m + 解密的 .flac）。磁盘清理失败仅记录警告，
/// 不影响删除分享的成功响应（缓存残留不会造成功能问题，仅占磁盘空间）。
#[tauri::command]
pub async fn share_delete(
    _state: State<'_, AppState>,
    share_id: String,
) -> Result<ShareDeleteResult, String> {
    let client = ShareClient::new();
    let result = client
        .delete(&share_id)
        .await
        .map_err(|e| fmt_err("Failed to delete share", e))?;

    // 清理本地缓存目录：{songs_dir}/.cache/{share_id}/
    let pm = ai00_x_core::infrastructure::get_path_manager_arc();
    let cache_dir = pm.songs_dir().join(".cache").join(&share_id);
    if cache_dir.exists() {
        if let Err(e) = tokio::fs::remove_dir_all(&cache_dir).await {
            log::warn!(
                "[share] failed to clean cache dir {}: {}",
                cache_dir.display(),
                e
            );
        }
    }

    Ok(result)
}

// ============================================================================
// Phase E.2 命令
// ============================================================================

// ----------------------------------------------------------------------------
// 命令 5: share_list_recent
// ----------------------------------------------------------------------------

/// 列出最近的公开分享（浏览广场）。
///
/// 对应服务端 `GET /api/v1/share/recent?limit=`。公开端点。
/// `limit` 默认 20，clamp 到 [1, 50]。
#[tauri::command]
pub async fn share_list_recent(
    _state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<RecentSharesResult, String> {
    let client = ShareClient::new();
    client
        .list_recent(limit.unwrap_or(20))
        .await
        .map_err(|e| fmt_err("Failed to list recent shares", e))
}

// ----------------------------------------------------------------------------
// 命令 5b: share_get_recommendations（v1.3.0+ 个性化推荐）
// ----------------------------------------------------------------------------

/// 个性化推荐：基于客户端用户画像，服务端计算 embedding + tags 匹配返回推荐列表。
///
/// 客户端发送画像参数（likedIds / dislikedIds / playedIds / tagWeights），
/// 服务端一次性返回推荐列表（70% 画像匹配 + 30% 最新上传推新）。
#[tauri::command]
pub async fn share_get_recommendations(
    _state: State<'_, AppState>,
    request: RecommendRequest,
) -> Result<RecommendResponse, String> {
    let client = ShareClient::new();
    client
        .get_recommendations(&request)
        .await
        .map_err(|e| fmt_err("Failed to get recommendations", e))
}

// ----------------------------------------------------------------------------
// 命令 6: share_download_and_decrypt
// ----------------------------------------------------------------------------

/// 下载分享的 `.a00m` 文件（A00M 加密容器）并解密为单个 audio.flac 文件。
///
/// 流程：
/// 1. 从 auth 读取 member_id（下载需会员鉴权）
/// 2. 获取 songs_dir 的 `.cache/{share_id}/` 作为缓存目录
/// 3. 调用 [`ShareDownloader::download_and_decrypt`] 下载 + 解密
/// 4. 返回 [`DownloadedShare`]（audio_path / meta）
///
/// **缓存复用**：若缓存目录已有解密后的 .flac 文件，跳过下载直接返回。
/// 调用方可通过 `share_clear_download_cache` 清理缓存强制重新下载。
#[tauri::command]
pub async fn share_download_and_decrypt(
    _state: State<'_, AppState>,
    share_id: String,
) -> Result<DownloadedShare, String> {
    // 1. 确保已登录（下载端点需会员鉴权）
    let _auth = crate::auth::ensure_auth_synced()
        .await
        .map_err(|e| format!("Failed to read auth info: {e}"))?
        .ok_or_else(|| "Not logged in — cannot download share".to_string())?;

    // 2. 构造缓存目录：{songs_dir}/.cache/{share_id}/
    let pm = ai00_x_core::infrastructure::get_path_manager_arc();
    let cache_dir = pm.songs_dir().join(".cache").join(&share_id);

    // 3. 下载 + 解密
    let downloader = ShareDownloader::new(cache_dir);
    downloader
        .download_and_decrypt(&share_id)
        .await
        .map_err(|e| fmt_err("Failed to download and decrypt share", e))
}

// ----------------------------------------------------------------------------
// 命令 6b: share_extract_from_local（P2P 离线解密路径）
// ----------------------------------------------------------------------------

/// P2P 下载完成后的本地离线解包结果。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedShare {
    /// 解密后提取的 audio.flac 绝对路径（可直接播放）
    pub audio_path: String,
    /// 解密后提取的歌词文件路径（.lrc，无歌词时为 null）
    pub lyrics_path: Option<String>,
}

/// 从本地已存在的 `.a00m` 加密容器解密，提取 audio.flac + lyrics.lrc。
///
/// 用于 P2P 路径：P2P（fx-torrent）下载的是完整加密 `.a00m`（留档做种），
/// 直接无法作为音频播放，需先本地解包。此命令复用与本地作品 / HTTP 路径
/// 相同的解密封装逻辑，保证三处行为一致。
///
/// # 参数
///
/// - `share_id`：分享 ID，用于确定解密缓存目录命名
/// - `local_path`：P2P 下载到本地的 `.a00m` 文件绝对路径
#[tauri::command]
pub async fn share_extract_from_local(
    _state: State<'_, AppState>,
    share_id: String,
    local_path: String,
) -> Result<ExtractedShare, String> {
    let pm = ai00_x_core::infrastructure::get_path_manager_arc();
    let cache_dir = pm.songs_dir().join(".cache").join(&share_id);
    let downloader = ShareDownloader::new(cache_dir);
    let (audio_path, lyrics_path) = downloader
        .extract_from_local(std::path::Path::new(&local_path), &share_id)
        .await
        .map_err(|e| fmt_err("Failed to extract share from local", e))?;
    Ok(ExtractedShare {
        audio_path,
        lyrics_path,
    })
}

// ----------------------------------------------------------------------------
// 命令 7: share_record_play
// ----------------------------------------------------------------------------

/// 上报播放（用于播放计数）。
///
/// 对应服务端 `POST /api/v1/share/{id}/play`。公开端点。
/// `client_id` 可选，用于去重（同一 client_id 短时间内重复播放只计一次）。
#[tauri::command]
pub async fn share_record_play(
    _state: State<'_, AppState>,
    share_id: String,
    client_id: Option<String>,
) -> Result<SharePlayResult, String> {
    let client = ShareClient::new();
    client
        .record_play(&share_id, client_id.as_deref())
        .await
        .map_err(|e| fmt_err("Failed to record play", e))
}

// ----------------------------------------------------------------------------
// 命令 8: share_get_stats
// ----------------------------------------------------------------------------

/// 获取分享统计（播放数 + 评论数）。
///
/// 对应服务端 `GET /api/v1/share/{id}/stats`。公开端点。
/// `comment_count` 当前为 null（后端简化实现）。
#[tauri::command]
pub async fn share_get_stats(
    _state: State<'_, AppState>,
    share_id: String,
) -> Result<ShareStats, String> {
    let client = ShareClient::new();
    client
        .get_stats(&share_id)
        .await
        .map_err(|e| fmt_err("Failed to get share stats", e))
}

// ----------------------------------------------------------------------------
// 命令 9: share_get_cover (Phase E.3.4)
// ----------------------------------------------------------------------------

/// 获取分享封面图的本地文件路径（带磁盘缓存）。
///
/// 对应服务端 `GET /api/v1/share/{id}/cover`。公开端点。
///
/// 流程：
/// 1. 计算缓存路径：`{songs_dir}/.cache/{share_id}/cover.bin`
/// 2. 若缓存文件已存在，直接返回其绝对路径
/// 3. 否则调用 [`ShareClient::get_cover`] 下载封面字节
///    - `None`（分享无封面）→ 返回 `None`，不写文件
///    - `Some((bytes, mime))` → 根据 mime 决定扩展名 → 写入缓存文件 → 返回路径
/// 4. 前端拿到路径后用 `convertFileSrc(path)` 转为 `<img src>` 可用 URL
///
/// 缓存复用策略：同一 share_id 只下载一次。缓存文件用正确的扩展名
/// （`cover.webp` / `cover.png` / `cover.jpg` / `cover.gif`），便于 OS 文件
/// 管理器识别。兼容旧版 `cover.bin`（首次访问时若存在则直接返回）。
/// 分享被吊销后封面缓存不会自动失效，但 `share_delete` 命令会清理整个
/// `.cache/{share_id}/` 目录。
#[tauri::command]
pub async fn share_get_cover(
    _state: State<'_, AppState>,
    share_id: String,
) -> Result<Option<String>, String> {
    let pm = ai00_x_core::infrastructure::get_path_manager_arc();
    let cache_dir = pm.songs_dir().join(".cache").join(&share_id);

    // 1. 检查已知扩展名的缓存文件（兼容旧 cover.bin + 新 cover.{ext}）
    for ext in &["webp", "png", "jpg", "gif", "bin"] {
        let path = cache_dir.join(format!("cover.{ext}"));
        if path.exists() {
            return Ok(Some(path.to_string_lossy().to_string()));
        }
    }

    // 2. 缓存未命中：下载封面 + MIME
    let client = ShareClient::new();
    let cover = client
        .get_cover(&share_id)
        .await
        .map_err(|e| fmt_err("Failed to get cover", e))?;

    let (bytes, mime) = match cover {
        Some(b) => b,
        None => return Ok(None), // 分享无封面
    };

    // 3. 根据 MIME 决定扩展名（image/jpeg 和兜底统一用 .jpg）
    let ext = match mime.as_str() {
        "image/webp" => "webp",
        "image/png" => "png",
        "image/gif" => "gif",
        _ => "jpg",
    };

    // 4. 写入缓存文件
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| fmt_err("Failed to create cover cache dir", e))?;
    let cover_path = cache_dir.join(format!("cover.{ext}"));
    tokio::fs::write(&cover_path, &bytes)
        .await
        .map_err(|e| fmt_err("Failed to write cover cache", e))?;

    Ok(Some(cover_path.to_string_lossy().to_string()))
}

// ============================================================================
// Phase E.3: 评论系统（list / add / edit / delete）
// ============================================================================

// ----------------------------------------------------------------------------
// 命令 9: share_list_comments
// ----------------------------------------------------------------------------

/// 列出某分享下的评论（按时间排序）。
///
/// 对应服务端 `GET /api/v1/share/{id}/comments`。公开端点。
/// `limit` 默认 50（后端 clamp 到 [1, 200]），`offset` 默认 0。
/// `sort` 控制排序方向：`Some("asc")` 或 `None` 按时间正序（旧→新），
/// `Some("desc")` 按时间倒序（新→旧，最新优先）。
///
/// 响应包含 `total`（评论总数），前端用于判断是否还有更多可加载。
#[tauri::command]
pub async fn share_list_comments(
    _state: State<'_, AppState>,
    share_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
    sort: Option<String>,
) -> Result<CommentListResult, String> {
    let client = ShareClient::new();
    client
        .list_comments(&share_id, limit, offset, sort.as_deref())
        .await
        .map_err(|e| fmt_err("Failed to list comments", e))
}

// ----------------------------------------------------------------------------
// 命令 10: share_add_comment
// ----------------------------------------------------------------------------

/// 添加评论（可嵌套回复）。
///
/// 对应服务端 `POST /api/v1/share/{id}/comments`。会员端点。
/// 服务端校验 share 未吊销 + content 长度 1..=2000。
///
/// 前端传入 `parentId`（camelCase），Tauri 自动映射到 `parent_id`。
#[tauri::command]
pub async fn share_add_comment(
    _state: State<'_, AppState>,
    share_id: String,
    content: String,
    parent_id: Option<i64>,
) -> Result<CommentActionResult, String> {
    // 确保已登录（添加评论需会员鉴权）
    let _auth = crate::auth::ensure_auth_synced()
        .await
        .map_err(|e| format!("Failed to read auth info: {e}"))?
        .ok_or_else(|| "Not logged in — cannot add comment".to_string())?;

    let client = ShareClient::new();
    let req = AddCommentRequest {
        share_id,
        content,
        parent_id,
    };
    client
        .add_comment(&req)
        .await
        .map_err(|e| fmt_err("Failed to add comment", e))
}

// ----------------------------------------------------------------------------
// 命令 11: share_edit_comment
// ----------------------------------------------------------------------------

/// 编辑评论（仅作者本人）。
///
/// 对应服务端 `PUT /api/v1/share/{id}/comments/{cid}`。会员端点。
/// 服务端通过 `WHERE id = ? AND member_id = ?` 校验作者身份，
/// 0 行受影响时返回 404（避免泄漏存在性）。
#[tauri::command]
pub async fn share_edit_comment(
    _state: State<'_, AppState>,
    share_id: String,
    comment_id: i64,
    content: String,
) -> Result<CommentActionResult, String> {
    // 确保已登录（编辑评论需会员鉴权）
    let _auth = crate::auth::ensure_auth_synced()
        .await
        .map_err(|e| format!("Failed to read auth info: {e}"))?
        .ok_or_else(|| "Not logged in — cannot edit comment".to_string())?;

    let client = ShareClient::new();
    client
        .edit_comment(&share_id, comment_id, &content)
        .await
        .map_err(|e| fmt_err("Failed to edit comment", e))
}

// ----------------------------------------------------------------------------
// 命令 12: share_delete_comment
// ----------------------------------------------------------------------------

/// 删除评论（仅作者本人）。
///
/// 对应服务端 `DELETE /api/v1/share/{id}/comments/{cid}`。会员端点。
#[tauri::command]
pub async fn share_delete_comment(
    _state: State<'_, AppState>,
    share_id: String,
    comment_id: i64,
) -> Result<CommentActionResult, String> {
    // 确保已登录（删除评论需会员鉴权）
    let _auth = crate::auth::ensure_auth_synced()
        .await
        .map_err(|e| format!("Failed to read auth info: {e}"))?
        .ok_or_else(|| "Not logged in — cannot delete comment".to_string())?;

    let client = ShareClient::new();
    client
        .delete_comment(&share_id, comment_id)
        .await
        .map_err(|e| fmt_err("Failed to delete comment", e))
}
