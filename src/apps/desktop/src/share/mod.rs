//! Phase E: 客户端分享业务逻辑模块
//!
//! 承接 Phase D（Ai00-Salvo Share API 后端），提供桌面端完整的分享消费链路：
//! - [`client`] — Ai00-Salvo HTTP 客户端（封装 /api/v1/share/* 端点）
//! - [`downloader`] — A00M 容器下载器 + 解密器（Phase E.2）
//! - [`config`] — Ai00-Salvo 基地址配置
//!
//! # 认证模型
//!
//! 所有需鉴权的请求自动从 [`crate::auth::ensure_auth_synced`] 读取 member JWT，
//! 设置 `Authorization: Bearer <token>` 头；同时注入 `X-Ai00-Internal-Token`
//! 头豁免 Ai00-Salvo 的 CSRF 中间件（reqwest 不发送 `Origin` 头）。
//!
//! # DTO 对齐与命名约定
//!
//! 客户端 DTO 的 **Rust 字段名** 与 Phase D 后端 `ai00_storage::models`
//! 中的 `SharedSong` / `SharedSongListItem` / `ShareComment` 等结构对齐
//! （snake_case），方便反序列化服务端响应。
//!
//! **序列化输出 camelCase**：所有服务端响应 DTO 都加了
//! `#[serde(rename_all = "camelCase")]`，序列化输出 camelCase 字段名
//! （如 `shareId`、`authorMemberId`），与前端 TS 接口约定一致。
//!
//! **反序列化兼容 snake_case**：服务端响应是 snake_case，但 DTO 期望
//! camelCase（rename_all）。[`client::parse_api_response`] 在反序列化
//! 前递归把 JSON key 从 snake_case 转为 camelCase，填平差异。
//! 这样 Rust 字段名（snake_case）+ 序列化输出（camelCase）+ 反序列化
//! 输入（camelCase，由 parse_api_response 转换）三者一致。
//!
//! **请求 DTO**（如 `AddCommentRequest`）由 Rust 内部构造，不经过
//! `parse_api_response`，保持 snake_case 字段名，无需 rename_all。

pub mod client;
pub mod config;
pub mod downloader;
pub mod p2p;

pub use client::{RecommendRequest, RecommendResponse, ShareClient, UploadShareInput};
pub use downloader::{DownloadedShare, ShareDownloader};
pub use p2p::{P2pDownloadOptions, P2pDownloadResult, P2pDownloader, P2pStatus};

use serde::{Deserialize, Serialize};

// ============================================================================
// 共享 DTO 类型（与 Phase D 后端响应对齐，snake_case）
// ============================================================================

/// 服务端响应外层信封：`{ "code": 0, "data": <T> }`
///
/// Phase D 所有端点统一返回此格式。`code != 0` 表示业务错误。
#[derive(Debug, Clone, Deserialize)]
pub struct ApiResponse<T> {
    pub code: i32,
    pub data: Option<T>,
    /// 错误消息（code != 0 时存在）
    pub message: Option<String>,
}

impl<T> ApiResponse<T> {
    /// 提取 data 字段，若 code != 0 或 data 为空则返回错误。
    pub fn into_data(self) -> anyhow::Result<T> {
        if self.code != 0 {
            anyhow::bail!(
                "server error code={}: {}",
                self.code,
                self.message.unwrap_or_else(|| "(no message)".into())
            );
        }
        self.data
            .ok_or_else(|| anyhow::anyhow!("server returned code=0 but data is null"))
    }
}

/// 上传分享响应（`POST /api/v1/share/upload` 的 `data` 字段）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareUploadResult {
    pub share_id: String,
    /// 相对路径：`/api/v1/share/{id}`
    pub share_url: String,
    pub content_hash: String,
    pub file_size_bytes: u64,
    pub password_version: i64,
    /// RFC3339 时间字符串
    pub created_at: String,
}

/// 分享列表项（`GET /api/v1/share/mine` 和 `/recent` 的列表元素）
///
/// 与 `ai00_storage::models::SharedSongListItem` 对齐。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSongListItem {
    pub share_id: String,
    pub author_member_id: i64,
    pub author_name: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub duration_seconds: f64,
    pub preview_duration_secs: f64,
    /// 相对路径：`/api/v1/share/{id}/cover`（有封面时）
    pub cover_url: Option<String>,
    pub cover_mime: Option<String>,
    pub cover_width: Option<i32>,
    pub cover_height: Option<i32>,
    pub play_count: i64,
    /// RFC3339 时间字符串
    pub created_at: String,
}

/// 分页结果（`PaginatedResult<T>`）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedResult<T> {
    pub items: Vec<T>,
    pub total: u64,
    pub page: u32,
    pub per_page: u32,
    pub total_pages: u32,
}

/// 分享元数据（`GET /api/v1/share/{id}` 的 `data` 字段）
///
/// 与服务端 `get_share_meta` handler 的响应结构对齐。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareMeta {
    pub share_id: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub duration_seconds: f64,
    pub preview_duration_secs: f64,
    pub file_size_bytes: i64,
    pub play_count: i64,
    pub password_version: i64,
    pub has_cover: bool,
    /// 相对路径：`/api/v1/share/{id}/cover`（has_cover=true 时）
    pub cover_url: Option<String>,
    pub author_member_id: i64,
    pub created_at: String,
    /// 磁力链接（仅 WebTorrent 后端有值，供前端 P2P 客户端使用）
    #[serde(default)]
    pub magnet_link: Option<String>,
}

/// 删除（吊销）分享响应（`DELETE /api/v1/share/{id}` 的 `data` 字段）
///
/// 与 Phase D 后端 `delete_share` handler 的 `json!({ "share_id": ..., "revoked": true })` 对齐。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareDeleteResult {
    pub share_id: String,
    pub revoked: bool,
}

// ============================================================================
// Phase E.2 DTO（浏览 / 下载 / 播放上报 / 统计）
// ============================================================================

/// 最近分享列表响应（`GET /api/v1/share/recent` 的 `data` 字段）
///
/// 与 Phase D 后端 `list_recent` handler 的 `json!({ "songs": [...] })` 对齐。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSharesResult {
    pub songs: Vec<SharedSongListItem>,
}

/// 播放上报响应（`POST /api/v1/share/{id}/play` 的 `data` 字段）
///
/// 与 Phase D 后端 `record_play` handler 的响应对齐。
/// `counted` 表示是否计入播放计数（同一 client_id 短时间内重复播放会去重）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePlayResult {
    pub counted: bool,
    pub play_count: i64,
}

/// 分享统计（`GET /api/v1/share/{id}/stats` 的 `data` 字段）
///
/// 与 Phase D 后端 `get_stats` handler 的响应对齐。
/// `comment_count` 当前为 null（后端简化实现，前端单独调 /comments 拿 length）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStats {
    pub play_count: i64,
    pub comment_count: Option<i64>,
}

// ============================================================================
// Phase E.3 DTO（评论系统）
// ============================================================================

/// 单条评论（`GET /api/v1/share/{id}/comments` 的列表元素）
///
/// 与 `ai00_storage::models::ShareComment` 对齐（Rust 字段名 snake_case，
/// 序列化输出 camelCase）。前端通过对比 `memberId` 和当前用户的 member_id
/// （`get_auth_info` 命令返回）判断是否显示编辑/删除按钮。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareComment {
    pub id: i64,
    pub share_id: String,
    pub member_id: i64,
    pub member_name: String,
    pub parent_id: Option<i64>,
    pub content: String,
    /// RFC3339 时间字符串
    pub created_at: String,
    /// 编辑时间（首次创建时为 None）
    pub edited_at: Option<String>,
}

/// 评论列表响应（`GET /api/v1/share/{id}/comments` 的 `data` 字段）
///
/// `total` 用于前端判断是否还有更多评论可加载（"加载更多"按钮）。
/// `sort` 表示当前排序方向（`"asc"` 或 `"desc"`），前端切换排序时传入。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentListResult {
    pub comments: Vec<ShareComment>,
    pub limit: i64,
    pub offset: i64,
    /// 评论总数（用于分页"加载更多"判断）
    pub total: i64,
    /// 当前排序方向（"asc" 或 "desc"）
    pub sort: String,
}

/// 添加评论请求（`POST /api/v1/share/{id}/comments` 请求体）
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AddCommentRequest {
    pub share_id: String,
    pub content: String,
    /// 回复的父评论 ID；None 表示顶级评论
    pub parent_id: Option<i64>,
}

/// 评论操作响应（POST/PUT/DELETE 共用）
///
/// - POST：`{ comment_id }`（edited/deleted 都为 None）
/// - PUT：`{ comment_id, edited: true }`
/// - DELETE：`{ comment_id, deleted: true }`
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentActionResult {
    pub comment_id: i64,
    pub edited: Option<bool>,
    pub deleted: Option<bool>,
}
