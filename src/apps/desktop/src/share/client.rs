//! Ai00-Salvo Share API HTTP 客户端
//!
//! 封装对 `/api/v1/share/*` 端点的 HTTP 调用。自动从 [`crate::auth`]
//! 读取 member JWT 设置 `Authorization: Bearer <token>` 头，并注入
//! `X-Ai00-Internal-Token` 头豁免 CSRF 中间件。
//!
//! # 401 重试
//!
//! 收到 401 时调用 [`crate::auth::refresh_auth_token_impl`] 刷新 token 后
//! 重试一次；仍失败则返回错误提示重新登录。
//!
//! # 方法清单
//!
//! ## Phase E.1
//!
//! | 方法 | HTTP | 端点 | 鉴权 |
//! |------|------|------|------|
//! | [`upload`] | POST | `/api/v1/share/upload` (multipart) | 会员 |
//! | [`list_mine`] | GET | `/api/v1/share/mine` | 会员 |
//! | [`get_meta`] | GET | `/api/v1/share/{id}` | 公开 |
//! | [`delete`] | DELETE | `/api/v1/share/{id}` | 会员 |
//!
//! ## Phase E.2
//!
//! | 方法 | HTTP | 端点 | 鉴权 |
//! |------|------|------|------|
//! | [`list_recent`] | GET | `/api/v1/share/recent` | 公开 |
//! | [`download_to_file`] | GET | `/api/v1/share/{id}/file` | 会员 |
//! | [`record_play`] | POST | `/api/v1/share/{id}/play` | 公开 |
//! | [`get_stats`] | GET | `/api/v1/share/{id}/stats` | 公开 |
//! | [`get_cover`] | GET | `/api/v1/share/{id}/cover` | 公开 |
//!
//! ## Phase E.3
//!
//! | 方法 | HTTP | 端点 | 鉴权 |
//! |------|------|------|------|
//! | [`list_comments`] | GET | `/api/v1/share/{id}/comments` | 公开 |
//! | [`add_comment`] | POST | `/api/v1/share/{id}/comments` | 会员 |
//! | [`edit_comment`] | PUT | `/api/v1/share/{id}/comments/{cid}` | 会员 |
//! | [`delete_comment`] | DELETE | `/api/v1/share/{id}/comments/{cid}` | 会员 |

use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures::StreamExt;
use reqwest::{header, Client, Method, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::io::AsyncWriteExt;

use super::config;
use super::{
    AddCommentRequest, ApiResponse, CommentActionResult, CommentListResult, PaginatedResult,
    RecentSharesResult, ShareDeleteResult, ShareMeta, SharePlayResult, ShareStats,
    ShareUploadResult, SharedSongListItem,
};

/// 上传分享的元数据（对应服务端 multipart 表单字段）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadShareInput {
    /// .a00m 文件绝对路径
    pub file_path: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub duration_seconds: f64,
    pub preview_duration_secs: f64,
    /// 原始文件名（默认用 file_path 的文件名）
    pub original_filename: Option<String>,
    /// 封面图绝对路径（可选；png/jpg/webp/gif）
    pub cover_path: Option<String>,
    /// v1.3.0+: 多语言分类标签 JSON 字符串（e.g. `["zh:快节奏","en:fast"]`）。
    /// None 时不发送该字段，服务端默认存 "[]"。
    pub tags: Option<String>,
    /// v1.3.0+: 256 维 f32 向量嵌入，base64 编码的 little-endian bytes。
    /// None 时不发送该字段，服务端存 NULL。
    pub embedding: Option<String>,
}

/// v1.3.0+: 推荐请求（客户端用户画像参数，发送给服务端计算推荐列表）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendRequest {
    /// 喜欢的歌 share_id（最多 5 个，客户端裁剪）
    pub liked_ids: Vec<String>,
    /// 不喜欢的歌 share_id（服务端排除）
    #[serde(default)]
    pub disliked_ids: Vec<String>,
    /// 已听过的歌 share_id（服务端排除）
    #[serde(default)]
    pub played_ids: Vec<String>,
    /// 偏好标签权重（top 20，正负都保留）
    #[serde(default)]
    pub tag_weights: HashMap<String, f32>,
    /// 返回数量，默认 20，上限 50
    #[serde(default = "default_recommend_limit")]
    pub limit: i64,
}

fn default_recommend_limit() -> i64 {
    20
}

/// v1.3.0+: 推荐响应（服务端返回的推荐列表 + 来源标记）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendResponse {
    /// 推荐列表（已混合排序）
    pub items: Vec<SharedSongListItem>,
    /// 推荐来源："profile"（基于画像） | "cold-start"（无 liked_ids，纯时间序）
    pub source: String,
}

/// Ai00-Salvo Share API 客户端
pub struct ShareClient {
    http: Client,
}

impl Default for ShareClient {
    fn default() -> Self {
        Self::new()
    }
}

impl ShareClient {
    /// 创建新客户端（10s 连接超时，300s 请求超时以容纳大文件上传）
    pub fn new() -> Self {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(300))
            .build()
            .expect("failed to build reqwest client");
        Self { http }
    }

    /// 构造 `/api/v1/share{path}` 形式的 URL（path 应已含前导 `/`）。
    ///
    /// 示例：`share_url("/api/v1/share/upload")` → `https://host/api/v1/share/upload`
    ///
    /// 集中管理 base URL trim 逻辑，避免每个方法重复 `base.trim_end_matches('/')`。
    async fn share_url(&self, path: &str) -> String {
        let base = config::salvo_base_url().await;
        format!("{}{}", base.trim_end_matches('/'), path)
    }

    /// 构造 `/api/v1/share/{id}{suffix}` 形式的 URL（自动 URL 编码 id）。
    ///
    /// 示例：
    /// - `share_url_with_id(sid, "")` → `https://host/api/v1/share/{sid}`
    /// - `share_url_with_id(sid, "/file")` → `https://host/api/v1/share/{sid}/file`
    /// - `share_url_with_id(sid, "/comments?limit=50")` → `https://host/api/v1/share/{sid}/comments?limit=50`
    async fn share_url_with_id(&self, id: &str, suffix: &str) -> String {
        let base = config::salvo_base_url().await;
        format!(
            "{}/api/v1/share/{}{}",
            base.trim_end_matches('/'),
            urlencoding_encode(id),
            suffix,
        )
    }

    /// 上传 .a00m 文件到服务器。
    ///
    /// 构造 multipart/form-data 表单（file + title + 元数据字段 + 可选 cover），
    /// POST 到 `/api/v1/share/upload`。服务端回填 share_id 后返回 `ShareUploadResult`。
    ///
    /// # 401 重试说明
    ///
    /// `reqwest::multipart::Form` 不实现 `Clone`，无法在 `Fn` 闭包中直接复用。
    /// 解决方案：提前读取所有字节到 `Vec<u8>`/`String`（均可 `Clone`），
    /// 闭包内部每次重建 `Form`。这样 `send_with_auth_retry` 仍可在 401 时重试。
    pub async fn upload(&self, input: &UploadShareInput) -> Result<ShareUploadResult> {
        let file_path = Path::new(&input.file_path);
        if !file_path.exists() {
            bail!("upload file not found: {}", file_path.display());
        }

        // 1. 一次性读取所有字节（后续在闭包内 clone 重建 Form）
        let file_bytes = tokio::fs::read(file_path)
            .await
            .with_context(|| format!("read upload file: {}", file_path.display()))?;
        let original_filename = input
            .original_filename
            .clone()
            .or_else(|| {
                file_path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
            })
            .unwrap_or_else(|| "share.a00m".into());

        // 2. 读取可选封面字节（提前读取，避免闭包内 await）
        let cover_bytes: Option<(Vec<u8>, String)> = if let Some(cover_path) = &input.cover_path {
            let cover = Path::new(cover_path);
            if cover.exists() {
                match tokio::fs::read(cover).await {
                    Ok(bytes) => {
                        let cover_name = cover
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_else(|| "cover".into());
                        Some((bytes, cover_name))
                    }
                    Err(e) => {
                        log::warn!("[share] failed to read cover {}: {}", cover.display(), e);
                        None
                    }
                }
            } else {
                log::warn!("[share] cover path not found: {}", cover.display());
                None
            }
        } else {
            None
        };

        // 3. 捕获所有 Cloneable 数据（闭包内每次重建 Form）
        let title = input.title.clone();
        let duration_seconds = input.duration_seconds;
        let preview_duration_secs = input.preview_duration_secs;
        let artist_name = input.artist_name.clone();
        let album = input.album.clone();
        let genre = input.genre.clone();
        let tags = input.tags.clone();
        let embedding = input.embedding.clone();

        let url = self.share_url("/api/v1/share/upload").await;

        // 4. 闭包内重建 Form（Fn 兼容，可多次调用以支持 401 重试）
        //    file_bytes / original_filename / cover_bytes 均为 Cloneable 类型，
        //    闭包通过 `move` 捕获所有权，每次调用时 clone 出新副本供 Form 消费。
        let resp = self
            .send_with_auth_retry(Method::POST, &url, move |req| {
                let mime_str = mime_for_a00m();
                let file_part = reqwest::multipart::Part::bytes(file_bytes.clone())
                    .file_name(original_filename.clone())
                    .mime_str(mime_str)
                    .expect("mime_str is a valid static mime");

                let mut form = reqwest::multipart::Form::new()
                    .text("title", title.clone())
                    .text("duration_seconds", duration_seconds.to_string())
                    .text("preview_duration_secs", preview_duration_secs.to_string())
                    .text("original_filename", original_filename.clone())
                    .part("file", file_part);

                if let Some(artist) = &artist_name {
                    form = form.text("artist_name", artist.clone());
                }
                if let Some(album) = &album {
                    form = form.text("album", album.clone());
                }
                if let Some(genre) = &genre {
                    form = form.text("genre", genre.clone());
                }
                // v1.3.0+: tags JSON 字符串 + embedding base64 字符串
                if let Some(tags) = &tags {
                    form = form.text("tags", tags.clone());
                }
                if let Some(embedding) = &embedding {
                    form = form.text("embedding", embedding.clone());
                }
                if let Some((cover_bytes, cover_name)) = &cover_bytes {
                    let cover_mime = mime_for_image(cover_name);
                    let cover_part = reqwest::multipart::Part::bytes(cover_bytes.clone())
                        .file_name(cover_name.clone())
                        .mime_str(cover_mime)
                        .unwrap_or_else(|_| {
                            reqwest::multipart::Part::bytes(Vec::new())
                                .file_name("cover")
                                .mime_str("application/octet-stream")
                                .expect("octet-stream is valid mime")
                        });
                    form = form.part("cover", cover_part);
                }

                req.multipart(form)
            })
            .await?;
        parse_api_response::<ShareUploadResult>(resp).await
    }

    /// 列出当前会员的分享（分页）。
    pub async fn list_mine(
        &self,
        page: u32,
        per_page: u32,
    ) -> Result<PaginatedResult<SharedSongListItem>> {
        let url = self
            .share_url(&format!(
                "/api/v1/share/mine?page={}&per_page={}",
                page.max(1),
                per_page.clamp(1, 100)
            ))
            .await;
        let resp = self
            .send_with_auth_retry(Method::GET, &url, |req| req)
            .await?;
        parse_api_response::<PaginatedResult<SharedSongListItem>>(resp).await
    }

    /// 获取分享元数据（公开端点，但带 auth 头以便后续 /file 调用）。
    pub async fn get_meta(&self, share_id: &str) -> Result<ShareMeta> {
        let url = self.share_url_with_id(share_id, "").await;
        let resp = self
            .send_with_auth_retry(Method::GET, &url, |req| req)
            .await?;
        parse_api_response::<ShareMeta>(resp).await
    }

    /// 吊销（删除）分享。仅作者可操作。
    pub async fn delete(&self, share_id: &str) -> Result<ShareDeleteResult> {
        let url = self.share_url_with_id(share_id, "").await;
        let resp = self
            .send_with_auth_retry(Method::DELETE, &url, |req| req)
            .await?;
        parse_api_response::<ShareDeleteResult>(resp).await
    }

    // ========================================================================
    // Phase E.2: 浏览 / 下载 / 播放上报 / 统计
    // ========================================================================

    /// 列出最近的公开分享（浏览广场）。
    ///
    /// 公开端点，但仍带 auth 头以便后续 /file 调用。
    /// `limit` 会 clamp 到 [1, 50]。
    pub async fn list_recent(&self, limit: u32) -> Result<RecentSharesResult> {
        let url = self
            .share_url(&format!(
                "/api/v1/share/recent?limit={}",
                limit.clamp(1, 50)
            ))
            .await;
        let resp = self
            .send_with_auth_retry(Method::GET, &url, |req| req)
            .await?;
        parse_api_response::<RecentSharesResult>(resp).await
    }

    /// v1.3.0+: 个性化推荐（基于客户端用户画像，服务端计算 embedding + tags 匹配）。
    ///
    /// 客户端发送画像参数（likedIds / dislikedIds / playedIds / tagWeights），
    /// 服务端一次性返回推荐列表。单次请求，避免 N 次 similar 调用压垮服务器。
    pub async fn get_recommendations(&self, req: &RecommendRequest) -> Result<RecommendResponse> {
        let url = self.share_url("/api/v1/share/recommend").await;
        let resp = self
            .send_with_auth_retry(Method::POST, &url, move |rb| rb.json(req))
            .await?;
        parse_api_response::<RecommendResponse>(resp).await
    }

    /// 下载完整 .a00m 文件到指定路径（会员端点，流式写入磁盘）。
    ///
    /// 内部使用 `reqwest::Response::bytes_stream()` 流式写入，避免大文件
    /// 全量加载到内存。目录不存在时自动创建。
    ///
    /// 若服务器返回 401，会自动刷新 token 重试一次。
    pub async fn download_to_file(&self, share_id: &str, dest: &Path) -> Result<u64> {
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("create download dir: {}", parent.display()))?;
        }

        let url = self.share_url_with_id(share_id, "/file").await;

        let resp = self
            .send_with_auth_retry(Method::GET, &url, |req| req)
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            bail!(
                "download failed (HTTP {}): {}",
                status,
                truncate_body(&body, 300)
            );
        }

        // 流式写入文件
        let mut file = tokio::fs::File::create(dest)
            .await
            .with_context(|| format!("create download file: {}", dest.display()))?;

        let mut stream = resp.bytes_stream();
        let mut total: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("read chunk from download stream")?;
            file.write_all(&chunk)
                .await
                .with_context(|| format!("write chunk to {}", dest.display()))?;
            total += chunk.len() as u64;
        }
        file.flush()
            .await
            .with_context(|| format!("flush {}", dest.display()))?;
        Ok(total)
    }

    /// 上报播放（公开端点，member JWT 可选）。
    ///
    /// `client_id` 用于去重（同一 client_id 短时间内重复播放只计一次）。
    /// 传 `None` 时服务端默认为 "anonymous"。
    pub async fn record_play(
        &self,
        share_id: &str,
        client_id: Option<&str>,
    ) -> Result<SharePlayResult> {
        let url = self.share_url_with_id(share_id, "/play").await;
        let body = serde_json::json!({
            "client_id": client_id.unwrap_or("anonymous")
        });
        let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
        let resp = self
            .send_with_auth_retry(Method::POST, &url, move |req| {
                req.header(header::CONTENT_TYPE, "application/json")
                    .body(body_bytes.clone())
            })
            .await?;
        parse_api_response::<SharePlayResult>(resp).await
    }

    /// 获取分享统计（播放数 + 评论数）。
    ///
    /// 公开端点。`comment_count` 当前为 null（后端简化实现）。
    pub async fn get_stats(&self, share_id: &str) -> Result<ShareStats> {
        let url = self.share_url_with_id(share_id, "/stats").await;
        let resp = self
            .send_with_auth_retry(Method::GET, &url, |req| req)
            .await?;
        parse_api_response::<ShareStats>(resp).await
    }

    /// 下载分享的封面图字节 + MIME 类型（公开端点）。
    ///
    /// 对应服务端 `GET /api/v1/share/{id}/cover`。返回 `Ok(None)` 表示该分享
    /// 无封面（服务端返回 404）；`Ok(Some((bytes, mime)))` 表示成功获取封面字节。
    /// 其他非 2xx 状态码（如 410 已吊销、500 内部错误）作为 `Err` 返回。
    ///
    /// `mime` 来自响应头 `Content-Type`（已规范化为小写、去 `;` 参数），
    /// 兜底值为 `"image/jpeg"`。调用方通常根据 mime 决定缓存文件扩展名，
    /// 将字节写入本地缓存文件后再用 `convertFileSrc` 在前端展示。
    pub async fn get_cover(&self, share_id: &str) -> Result<Option<(Vec<u8>, String)>> {
        let url = self.share_url_with_id(share_id, "/cover").await;
        let resp = self
            .send_with_auth_retry(Method::GET, &url, |req| req)
            .await?;

        let status = resp.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            bail!(
                "get cover failed (HTTP {}): {}",
                status,
                truncate_body(&body, 300)
            );
        }

        // 读取 Content-Type 并规范化（"image/webp; charset=utf-8" → "image/webp"）
        let mime = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(';').next().unwrap_or(s).trim().to_lowercase())
            .filter(|s| s.starts_with("image/"))
            .unwrap_or_else(|| "image/jpeg".to_string());

        let bytes = resp.bytes().await.with_context(|| "read cover bytes")?;
        Ok(Some((bytes.to_vec(), mime)))
    }

    // ========================================================================
    // Phase E.3: 评论系统（list / add / edit / delete）
    // ========================================================================

    /// 列出某分享下的评论（按时间排序）。
    ///
    /// 公开端点。`limit` 默认 50（后端 clamp 到 [1, 200]），`offset` 默认 0。
    /// `sort` 控制排序方向：`Some("asc")` 或 `None` 按时间正序（旧→新），
    /// `Some("desc")` 按时间倒序（新→旧，最新优先）。
    pub async fn list_comments(
        &self,
        share_id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
        sort: Option<&str>,
    ) -> Result<CommentListResult> {
        let lim = limit.unwrap_or(50).clamp(1, 200);
        let off = offset.unwrap_or(0).max(0);
        let srt = sort.unwrap_or("asc");
        let url = self
            .share_url_with_id(
                share_id,
                &format!("/comments?limit={}&offset={}&sort={}", lim, off, srt),
            )
            .await;
        let resp = self
            .send_with_auth_retry(Method::GET, &url, |req| req)
            .await?;
        parse_api_response::<CommentListResult>(resp).await
    }

    /// 添加评论（可嵌套回复）。
    ///
    /// 会员端点（需 unified_auth）。`parent_id` 为 None 表示顶级评论。
    /// 服务端校验 share 未吊销 + content 长度 1..=2000。
    pub async fn add_comment(&self, req: &AddCommentRequest) -> Result<CommentActionResult> {
        let url = self.share_url_with_id(&req.share_id, "/comments").await;
        // 构造请求体（与服务端 `parse_json` 期望的结构对齐）
        let body = serde_json::json!({
            "content": req.content,
            "parent_id": req.parent_id,
        });
        let body_bytes = serde_json::to_vec(&body)?;
        let resp = self
            .send_with_auth_retry(Method::POST, &url, move |rb| {
                rb.header(header::CONTENT_TYPE, "application/json")
                    .body(body_bytes.clone())
            })
            .await?;
        parse_api_response::<CommentActionResult>(resp).await
    }

    /// 编辑评论（仅作者本人）。
    ///
    /// 会员端点。服务端通过 `WHERE id = ? AND member_id = ?` 校验作者身份，
    /// 0 行受影响时返回 404（避免泄漏存在性）。
    ///
    /// 注：服务端 PUT handler 仅读取 `cid` path param，不使用 `share_id`。
    /// 但 URL 路由结构为 `/share/{id}/comments/{cid}`，所以仍需传入 share_id
    /// 以构造合法 URL。
    pub async fn edit_comment(
        &self,
        share_id: &str,
        comment_id: i64,
        content: &str,
    ) -> Result<CommentActionResult> {
        let url = self
            .share_url_with_id(share_id, &format!("/comments/{}", comment_id))
            .await;
        let body = serde_json::json!({ "content": content });
        let body_bytes = serde_json::to_vec(&body)?;
        let resp = self
            .send_with_auth_retry(Method::PUT, &url, move |rb| {
                rb.header(header::CONTENT_TYPE, "application/json")
                    .body(body_bytes.clone())
            })
            .await?;
        parse_api_response::<CommentActionResult>(resp).await
    }

    /// 删除评论（仅作者本人）。
    ///
    /// 会员端点。与 `edit_comment` 一样的作者校验机制。
    pub async fn delete_comment(
        &self,
        share_id: &str,
        comment_id: i64,
    ) -> Result<CommentActionResult> {
        let url = self
            .share_url_with_id(share_id, &format!("/comments/{}", comment_id))
            .await;
        let resp = self
            .send_with_auth_retry(Method::DELETE, &url, |req| req)
            .await?;
        parse_api_response::<CommentActionResult>(resp).await
    }

    // ========================================================================
    // 内部：带 401 重试的请求发送
    // ========================================================================

    /// 发送请求，自动注入 auth + CSRF 头。收到 401 时刷新 token 重试一次。
    async fn send_with_auth_retry<F>(
        &self,
        method: Method,
        url: &str,
        build: F,
    ) -> Result<reqwest::Response>
    where
        F: Fn(RequestBuilder) -> RequestBuilder,
    {
        let resp = match self.send_once(method.clone(), url, &build).await {
            Ok(r) => r,
            Err(e) => {
                // 连接错误：multipart 上传时，服务器可能在读取 body 前返回 401
                // 并关闭连接，客户端收到连接错误而非 401。尝试刷新 token 重试。
                let is_conn_err = e
                    .downcast_ref::<reqwest::Error>()
                    .map(|re| re.is_connect() || re.is_timeout())
                    .unwrap_or(false);
                if is_conn_err {
                    log::info!(
                        "[share] connection error, refreshing token and retrying once: {}",
                        e
                    );
                    match crate::auth::refresh_auth_token_impl().await {
                        Ok(_) => {
                            return self.send_once(method, url, &build).await;
                        }
                        Err(refresh_err) => {
                            bail!(
                                "connection error and token refresh failed: {} | {}",
                                e,
                                refresh_err
                            );
                        }
                    }
                }
                return Err(e);
            }
        };

        if resp.status() != StatusCode::UNAUTHORIZED {
            return Ok(resp);
        }

        // 401：丢弃响应体，尝试刷新 token 后重试一次
        log::info!("[share] got 401, refreshing token and retrying once");
        match crate::auth::refresh_auth_token_impl().await {
            Ok(_) => {
                let resp2 = self.send_once(method, url, &build).await?;
                if resp2.status() == StatusCode::UNAUTHORIZED {
                    let status = resp2.status();
                    let body = resp2.text().await.unwrap_or_default();
                    bail!(
                        "authentication failed after token refresh ({}): {}",
                        status,
                        truncate_body(&body, 200)
                    );
                }
                Ok(resp2)
            }
            Err(e) => {
                bail!("token refresh failed, please re-login: {}", e);
            }
        }
    }

    /// 单次发送请求（注入 auth + CSRF 头）
    async fn send_once<F>(&self, method: Method, url: &str, build: &F) -> Result<reqwest::Response>
    where
        F: Fn(RequestBuilder) -> RequestBuilder,
    {
        let req = self.http.request(method, url);
        let req = build(req);
        let req = self.with_auth_headers(req).await?;
        let resp = req
            .send()
            .await
            .with_context(|| format!("send request to {}", url))?;
        Ok(resp)
    }

    /// 注入 `Authorization: Bearer <token>` + `X-Ai00-Internal-Token` 头
    ///
    /// 发送前检查 access token 是否即将过期（留 60 秒缓冲），过期则先刷新。
    /// 这样避免发送过期 token 导致服务器返回 401 并关闭连接（multipart 上传时
    /// 客户端可能收到连接错误而非 401，导致 401 重试逻辑不触发）。
    async fn with_auth_headers(&self, req: RequestBuilder) -> Result<RequestBuilder> {
        let auth = crate::auth::ensure_auth_synced()
            .await
            .map_err(|e| anyhow::anyhow!("failed to read auth info: {e}"))?;
        let mut req = req.header("X-Ai00-Internal-Token", config::internal_token());
        if let Some(auth) = &auth {
            // 检查 access token 是否即将过期（留 60 秒缓冲）
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            const ACCESS_EXPIRES_SECS: u64 = 900; // 15 分钟（与 server.toml 一致）
            const BUFFER_SECS: u64 = 60; // 60 秒缓冲
            if now >= auth.logged_at + ACCESS_EXPIRES_SECS - BUFFER_SECS {
                // token 已过期或即将过期，尝试刷新
                log::info!("[share] access token expired or expiring, refreshing before request");
                match crate::auth::refresh_auth_token_impl().await {
                    Ok(_) => {
                        // 刷新成功，重新读取 auth info
                        if let Some(new_auth) =
                            crate::auth::ensure_auth_synced().await.map_err(|e| {
                                anyhow::anyhow!("failed to read auth info after refresh: {e}")
                            })?
                        {
                            req = req.header(
                                header::AUTHORIZATION,
                                format!("Bearer {}", new_auth.token),
                            );
                            return Ok(req);
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "[share] pre-request token refresh failed: {}, using old token",
                            e
                        );
                    }
                }
            }
            req = req.header(header::AUTHORIZATION, format!("Bearer {}", auth.token));
        }
        Ok(req)
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 解析 `{ "code": 0, "data": <T> }` 响应。HTTP 非 2xx 时提取错误信息。
///
/// **snake_case → camelCase 转换**：服务端响应的 JSON key 是 snake_case
/// （如 `share_id`、`author_member_id`），但客户端 DTO 加了
/// `#[serde(rename_all = "camelCase")]`，期望 camelCase key。这里在
/// 反序列化前递归把所有 JSON object 的 key 从 snake_case 转为 camelCase，
/// 填平差异。详见 [`super`] 模块文档的"DTO 对齐与命名约定"。
async fn parse_api_response<T: for<'de> Deserialize<'de>>(resp: reqwest::Response) -> Result<T> {
    let status = resp.status();
    // 读取响应体：失败时记录根因，避免后续 serde_json::from_str("") 报 "EOF" 误导排查方向
    let body = resp
        .text()
        .await
        .with_context(|| format!("read response body (HTTP {})", status))
        .unwrap_or_else(|e| {
            log::warn!("[share] failed to read response body: {}", e);
            String::new()
        });
    if !status.is_success() {
        bail!("HTTP {}: {}", status, truncate_body(&body, 300));
    }
    // 先解析为 Value，转换 key case，再反序列化为目标类型。
    // 转换是必要的：DTO 的 rename_all="camelCase" 让 serde 期望 camelCase key，
    // 但服务端返回 snake_case，不转换会反序列化失败（Option 字段变 None，必填字段报错）。
    let value: serde_json::Value = serde_json::from_str(&body)
        .with_context(|| format!("parse API response as JSON: {}", truncate_body(&body, 300)))?;
    let value = convert_keys_to_camel(value);
    let api: ApiResponse<T> = serde_json::from_value(value)
        .with_context(|| format!("parse API response: {}", truncate_body(&body, 300)))?;
    api.into_data()
}

/// 把 snake_case 字符串转为 camelCase（如 `share_id` → `shareId`）。
///
/// 规则：下划线后第一个字符大写，下划线移除。无下划线的字符串原样返回
/// （如 `code`、`data`、`message` 不变）。
fn snake_to_camel(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut upper_next = false;
    for c in s.chars() {
        if c == '_' {
            upper_next = true;
        } else if upper_next {
            result.extend(c.to_uppercase());
            upper_next = false;
        } else {
            result.push(c);
        }
    }
    result
}

/// 递归把 JSON Value 中所有 object 的 key 从 snake_case 转为 camelCase。
///
/// 数组会递归处理每个元素；其他类型（string/number/bool/null）原样返回。
/// 仅转换 object 的 key，不转换 string value 的内容。
fn convert_keys_to_camel(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (k, v) in map {
                let new_key = snake_to_camel(&k);
                new_map.insert(new_key, convert_keys_to_camel(v));
            }
            serde_json::Value::Object(new_map)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(convert_keys_to_camel).collect())
        }
        other => other,
    }
}

/// .a00m 文件的 MIME 类型（A00M 加密容器格式）
fn mime_for_a00m() -> &'static str {
    "application/octet-stream"
}

/// 根据文件扩展名推断图片 MIME
fn mime_for_image(filename: &str) -> &'static str {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

/// 截断响应体到指定字符数（用于错误日志，避免超长输出）
fn truncate_body(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{}...(truncated)", truncated)
    }
}

/// URL 编码（仅 path segment，不编码 /）
fn urlencoding_encode(s: &str) -> String {
    // share_id 是 UUID v4 字符串（含连字符），只需编码 % 等特殊字符
    // UUID v4 不含特殊字符，但保守起见做 percent-encoding
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}
