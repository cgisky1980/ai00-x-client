/**
 * 分享相关 Tauri 命令包装（Phase E.1 + E.2）
 *
 * ## Phase E.1（归档上传 + 我的分享管理）
 *
 * - `share_upload_archive` — 上传加密归档（.a00m）到 Ai00-Salvo
 * - `share_list_mine` — 列出当前会员的分享（分页）
 * - `share_get_meta` — 获取分享元数据
 * - `share_delete` — 吊销分享
 *
 * ## Phase E.2（浏览 / 下载解密 / 播放上报 / 统计）
 *
 * - `share_list_recent` — 列出最近公开分享（浏览广场）
 * - `share_download_and_decrypt` — 下载 .a00m 并解密提取 audio.flac
 * - `share_record_play` — 上报播放（用于播放计数）
 * - `share_get_stats` — 获取分享统计（播放数 + 评论数）
 *
 * 遵循 AceStepService.ts 的模式（api.invoke + createTauriCommandError）。
 *
 * DTO 字段使用 camelCase（Tauri 约定），与 Rust 端 `#[serde(rename_all = "camelCase")]` 对齐。
 * 服务端响应外层信封 `{ code, data }` 由 Rust 端 ShareClient 解析，前端直接收 data。
 */

import { api } from '@/infrastructure/api/service-api/ApiClient';
import { createTauriCommandError } from '@/infrastructure/api/errors/TauriCommandError';

// ============================================================================
// 请求/响应 DTO（camelCase，与服务端响应对齐）
// ============================================================================

/** 归档分享上传请求（`share_upload_archive`，作品库「分享」操作）
 *
 * 直接上传完整 .a00m 文件（包含音频、歌词、创作上下文、评分、封面等全部
 * 内容）。元数据由后端从 song.json 读取，前端无需填写。文件保持 master
 * password 加密格式，只有 Ai00-X 自己的播放器能解密播放。 */
export interface ShareUploadArchiveRequest {
  /** 本地 `.a00m` 归档绝对路径 */
  archivePath: string;
}

/** 上传分享响应 */
export interface ShareUploadResult {
  shareId: string;
  /** 相对路径：`/api/v1/share/{id}` */
  shareUrl: string;
  contentHash: string;
  fileSizeBytes: number;
  passwordVersion: number;
  /** RFC3339 时间字符串 */
  createdAt: string;
}

/** 分享列表项（`share_list_mine` 的列表元素） */
export interface SharedSongListItem {
  shareId: string;
  authorMemberId: number;
  authorName: string;
  title: string;
  artistName?: string;
  album?: string;
  genre?: string;
  durationSeconds: number;
  previewDurationSecs: number;
  /** 相对路径：`/api/v1/share/{id}/cover`（有封面时） */
  coverUrl?: string;
  coverMime?: string;
  coverWidth?: number;
  coverHeight?: number;
  playCount: number;
  /** v1.3.0+: 多语言分类标签 JSON 字符串 (e.g. `["zh:快节奏","en:fast"]`) */
  tags?: string;
  /** RFC3339 时间字符串 */
  createdAt: string;
}

/** 分页结果 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

// ============================================================================
// v1.3.0+: 个性化推荐（基于客户端用户画像，服务端计算）
// ============================================================================

/** 推荐请求（客户端用户画像参数） */
export interface RecommendRequest {
  /** 喜欢的歌 share_id（最多 5 个，客户端裁剪） */
  likedIds: string[];
  /** 不喜欢的歌 share_id（服务端排除） */
  dislikedIds: string[];
  /** 已听过的歌 share_id（服务端排除） */
  playedIds: string[];
  /** 偏好标签权重（top 20，正负都保留） */
  tagWeights: Record<string, number>;
  /** 返回数量，默认 20，上限 50 */
  limit?: number;
}

/** 推荐响应（服务端返回的推荐列表 + 来源标记） */
export interface RecommendResponse {
  /** 推荐列表（已混合排序：70% 画像匹配 + 30% 最新上传） */
  items: SharedSongListItem[];
  /** 推荐来源："profile"（基于画像） | "cold-start"（无 likedIds，纯时间序） */
  source: 'profile' | 'cold-start';
}

/** 分享元数据（`share_get_meta` 的响应） */
export interface ShareMeta {
  shareId: string;
  title: string;
  artistName?: string;
  album?: string;
  genre?: string;
  durationSeconds: number;
  previewDurationSecs: number;
  fileSizeBytes: number;
  playCount: number;
  passwordVersion: number;
  hasCover: boolean;
  /** 相对路径：`/api/v1/share/{id}/cover`（hasCover=true 时） */
  coverUrl?: string;
  authorMemberId: number;
  createdAt: string;
  /** 磁力链接（BitTorrent 后端有值，供 Stage 5.13 P2PClient 调用 Tauri 命令使用） */
  magnetLink?: string;
}

/** 删除分享响应 */
export interface ShareDeleteResult {
  shareId: string;
  revoked: boolean;
}

// ============================================================================
// Phase E.2 DTO（浏览 / 下载 / 播放上报 / 统计）
// ============================================================================

/** 最近分享列表响应（`share_list_recent` 的响应） */
export interface RecentSharesResult {
  songs: SharedSongListItem[];
}

/** 下载并解密后的分享（`share_download_and_decrypt` 的响应） */
export interface DownloadedShare {
  /** 解密后提取的 audio.flac 路径（完整歌曲，可直接播放） */
  audioPath: string;
  /** 解密后提取的歌词文件路径（.lrc，无歌词时为 null） */
  lyricsPath: string | null;
  /** 分享元数据 */
  meta: ShareMeta;
}

/** 本地离线解包结果（`share_extract_from_local` 的响应，P2P 路径） */
export interface ExtractedShare {
  /** 解密后提取的 audio.flac 路径（可直接播放） */
  audioPath: string;
  /** 解密后提取的歌词文件路径（.lrc，无歌词时为 null） */
  lyricsPath: string | null;
}

/** 播放上报响应（`share_record_play` 的响应） */
export interface SharePlayResult {
  /** 是否计入播放计数（同一 client_id 短时间内重复播放会去重） */
  counted: boolean;
  playCount: number;
}

/** 分享统计（`share_get_stats` 的响应） */
export interface ShareStats {
  playCount: number;
  /** 评论数（当前为 null，后端简化实现） */
  commentCount: number | null;
}

// ============================================================================
// Phase E.3 DTO（评论系统）
// ============================================================================

/**
 * 单条评论（`share_list_comments` 的列表元素）。
 *
 * 字段名使用 camelCase（Rust DTO 加了 `#[serde(rename_all = "camelCase")]`，
 * ShareClient.parse_api_response 在反序列化前把服务端 snake_case key 转为
 * camelCase）。前端通过对比 `memberId` 和当前用户的 member_id（`get_auth_info`
 * 命令返回）判断是否显示编辑/删除按钮。
 */
export interface ShareComment {
  id: number;
  shareId: string;
  memberId: number;
  memberName: string;
  parentId: number | null;
  content: string;
  /** RFC3339 时间字符串 */
  createdAt: string;
  /** 编辑时间（首次创建时为 null） */
  editedAt: string | null;
}

/** 评论列表响应（`share_list_comments` 的响应） */
export interface CommentListResult {
  comments: ShareComment[];
  limit: number;
  offset: number;
  /** 评论总数（用于分页"加载更多"判断） */
  total: number;
  /** 当前排序方向（"asc" 或 "desc"） */
  sort: string;
}

/** 评论操作响应（add/edit/delete 共用） */
export interface CommentActionResult {
  commentId: number;
  /** 编辑操作返回 true，其他为 undefined */
  edited?: boolean;
  /** 删除操作返回 true，其他为 undefined */
  deleted?: boolean;
}

// ============================================================================
// Service 方法
// ============================================================================

export const shareService = {
  /**
   * 上传本地 `.a00m` 加密归档到 Ai00-Salvo 服务器。
   *
   * 流程：后端解包归档（加密需密码）→ 直接上传完整加密文件 →
   * ShareClient.upload（multipart）→ 返回 ShareUploadResult。
   */
  async uploadArchive(req: ShareUploadArchiveRequest): Promise<ShareUploadResult> {
    try {
      return await api.invoke<ShareUploadResult>('share_upload_archive', { request: req });
    } catch (error) {
      throw createTauriCommandError('share_upload_archive', error, req);
    }
  },

  /**
   * 列出当前会员的分享（分页）。
   *
   * @param page 页码（从 1 开始，默认 1）
   * @param perPage 每页数量（1-100，默认 20）
   */
  async listMine(page = 1, perPage = 20): Promise<PaginatedResult<SharedSongListItem>> {
    try {
      return await api.invoke<PaginatedResult<SharedSongListItem>>('share_list_mine', {
        page,
        perPage,
      });
    } catch (error) {
      throw createTauriCommandError('share_list_mine', error, { page, perPage });
    }
  },

  /**
   * 获取分享元数据（公开端点，但带 auth 头以便后续 /file 调用）。
   *
   * @param shareId UUID v4 字符串
   */
  async getMeta(shareId: string): Promise<ShareMeta> {
    try {
      return await api.invoke<ShareMeta>('share_get_meta', { shareId });
    } catch (error) {
      throw createTauriCommandError('share_get_meta', error, { shareId });
    }
  },

  /**
   * 吊销（删除）分享。仅作者可操作。
   *
   * @param shareId UUID v4 字符串
   */
  async delete(shareId: string): Promise<ShareDeleteResult> {
    try {
      return await api.invoke<ShareDeleteResult>('share_delete', { shareId });
    } catch (error) {
      throw createTauriCommandError('share_delete', error, { shareId });
    }
  },

  // ==========================================================================
  // Phase E.2: 浏览 / 下载解密 / 播放上报 / 统计
  // ==========================================================================

  /**
   * 列出最近的公开分享（浏览广场）。
   *
   * 公开端点。`limit` 默认 20，后端会 clamp 到 [1, 50]。
   *
   * @param limit 返回的最大分享数量
   */
  async listRecent(limit = 20): Promise<RecentSharesResult> {
    try {
      return await api.invoke<RecentSharesResult>('share_list_recent', { limit });
    } catch (error) {
      throw createTauriCommandError('share_list_recent', error, { limit });
    }
  },

  /**
   * 下载分享的 .a00m 文件并解密提取 audio.flac。
   *
   * 流程：后端读取 auth → 构造缓存目录 `{songs_dir}/.cache/{share_id}/` →
   * ShareDownloader.download_and_decrypt（下载 + 解密 + 写临时文件）→
   * 返回 DownloadedShare。
   *
   * **缓存复用**：若缓存已有文件，跳过下载直接返回。
   *
   * @param shareId UUID v4 字符串
   */
  async downloadAndDecrypt(shareId: string): Promise<DownloadedShare> {
    try {
      return await api.invoke<DownloadedShare>('share_download_and_decrypt', { shareId });
    } catch (error) {
      throw createTauriCommandError('share_download_and_decrypt', error, { shareId });
    }
  },

  /**
   * 从本地已存在的 `.a00m` 加密容器离线解密，提取 audio.flac + lyrics.lrc。
   *
   * 用于 P2P 路径：fx-torrent 下载的是完整加密 `.a00m`（留档做种），直接
   * 无法播放；需先本地解包得到可播放音频 + 歌词。与前端本地作品 / HTTP
   * 路径使用同一套解密封装逻辑，保证三处行为一致。
   *
   * @param shareId UUID v4 字符串
   * @param localPath P2P 下载到本地的 `.a00m` 文件绝对路径
   */
  async extractLocal(shareId: string, localPath: string): Promise<ExtractedShare> {
    try {
      return await api.invoke<ExtractedShare>('share_extract_from_local', {
        shareId,
        localPath,
      });
    } catch (error) {
      throw createTauriCommandError('share_extract_from_local', error, { shareId, localPath });
    }
  },

  /**
   * 上报播放（用于播放计数）。
   *
   * 公开端点。`clientId` 可选，用于去重（同一 clientId 短时间内重复播放只计一次）。
   *
   * @param shareId UUID v4 字符串
   * @param clientId 客户端标识（可选，默认 "anonymous"）
   */
  async recordPlay(shareId: string, clientId?: string): Promise<SharePlayResult> {
    try {
      return await api.invoke<SharePlayResult>('share_record_play', {
        shareId,
        clientId: clientId ?? null,
      });
    } catch (error) {
      throw createTauriCommandError('share_record_play', error, { shareId, clientId });
    }
  },

  /**
   * 获取分享统计（播放数 + 评论数）。
   *
   * 公开端点。`commentCount` 当前为 null（后端简化实现）。
   *
   * @param shareId UUID v4 字符串
   */
  async getStats(shareId: string): Promise<ShareStats> {
    try {
      return await api.invoke<ShareStats>('share_get_stats', { shareId });
    } catch (error) {
      throw createTauriCommandError('share_get_stats', error, { shareId });
    }
  },

  /**
   * 获取分享封面图的本地文件路径（带磁盘缓存）。
   *
   * 对应后端命令 `share_get_cover`。公开端点。
   *
   * 流程：
   * 1. 后端检查 `{songs_dir}/.cache/{share_id}/cover.bin` 是否存在
   * 2. 若存在，直接返回路径
   * 3. 若不存在，下载封面字节并写入缓存文件，返回路径
   * 4. 若分享无封面（服务端 404），返回 null
   *
   * 前端拿到路径后用 `convertFileSrc(path)` 转为 `<img src>` 可用 URL。
   * 同一 share_id 只会触发一次网络请求，后续均走磁盘缓存。
   *
   * @param shareId UUID v4 字符串
   * @returns 本地文件绝对路径（如 `C:\...\.cache\abc\cover.bin`），或 null（无封面）
   */
  async getCoverPath(shareId: string): Promise<string | null> {
    try {
      return await api.invoke<string | null>('share_get_cover', { shareId });
    } catch (error) {
      throw createTauriCommandError('share_get_cover', error, { shareId });
    }
  },

  // ==========================================================================
  // Phase E.3: 评论系统（list / add / edit / delete）
  // ==========================================================================

  /**
   * 列出某分享下的评论（按时间排序）。
   *
   * 公开端点。`limit` 默认 50（后端 clamp 到 [1, 200]），`offset` 默认 0。
   *
   * @param shareId UUID v4 字符串
   * @param limit 返回条数（1-200，默认 50）
   * @param offset 偏移量（默认 0）
   * @param sort 排序方向：`'asc'`（旧→新，默认）或 `'desc'`（新→旧，最新优先）
   */
  async listComments(
    shareId: string,
    limit?: number,
    offset?: number,
    sort?: 'asc' | 'desc',
  ): Promise<CommentListResult> {
    try {
      return await api.invoke<CommentListResult>('share_list_comments', {
        shareId,
        limit: limit ?? null,
        offset: offset ?? null,
        sort: sort ?? null,
      });
    } catch (error) {
      throw createTauriCommandError('share_list_comments', error, { shareId, limit, offset, sort });
    }
  },

  /**
   * 添加评论（可嵌套回复）。
   *
   * 会员端点。服务端校验 share 未吊销 + content 长度 1..=2000。
   *
   * @param shareId UUID v4 字符串
   * @param content 评论内容（1-2000 字符）
   * @param parentId 回复的父评论 ID（可选，null 表示顶级评论）
   */
  async addComment(
    shareId: string,
    content: string,
    parentId?: number | null,
  ): Promise<CommentActionResult> {
    try {
      return await api.invoke<CommentActionResult>('share_add_comment', {
        shareId,
        content,
        parentId: parentId ?? null,
      });
    } catch (error) {
      throw createTauriCommandError('share_add_comment', error, { shareId, content, parentId });
    }
  },

  /**
   * 编辑评论（仅作者本人）。
   *
   * 会员端点。服务端通过 `WHERE id = ? AND member_id = ?` 校验作者身份，
   * 0 行受影响时返回 404（避免泄漏存在性）。
   *
   * @param shareId UUID v4 字符串（URL 结构需要，服务端不使用）
   * @param commentId 评论 ID
   * @param content 新的评论内容（1-2000 字符）
   */
  async editComment(
    shareId: string,
    commentId: number,
    content: string,
  ): Promise<CommentActionResult> {
    try {
      return await api.invoke<CommentActionResult>('share_edit_comment', {
        shareId,
        commentId,
        content,
      });
    } catch (error) {
      throw createTauriCommandError('share_edit_comment', error, { shareId, commentId, content });
    }
  },

  /**
   * 删除评论（仅作者本人）。
   *
   * 会员端点。与 `editComment` 一样的作者校验机制。
   *
   * @param shareId UUID v4 字符串（URL 结构需要，服务端不使用）
   * @param commentId 评论 ID
   */
  async deleteComment(shareId: string, commentId: number): Promise<CommentActionResult> {
    try {
      return await api.invoke<CommentActionResult>('share_delete_comment', {
        shareId,
        commentId,
      });
    } catch (error) {
      throw createTauriCommandError('share_delete_comment', error, { shareId, commentId });
    }
  },

  // ==========================================================================
  // v1.3.0+: 个性化推荐（基于客户端用户画像，服务端计算）
  // ==========================================================================

  /**
   * 获取个性化推荐列表（服务端一次性批量计算）。
   *
   * 客户端发送用户画像参数（likedIds/dislikedIds/playedIds/tagWeights），
   * 服务端根据画像匹配 + 最新上传混合排序返回推荐列表。
   *
   * - 70% 画像匹配（embedding 余弦 + tags Jaccard + tag 权重匹配）
   * - 30% 最新上传（推新机制）
   * - 冷启动：无 likedIds 时直接返回最近分享
   *
   * @param request 用户画像参数（客户端裁剪后）
   */
  async getRecommendations(request: RecommendRequest): Promise<RecommendResponse> {
    try {
      return await api.invoke<RecommendResponse>('share_get_recommendations', { request });
    } catch (error) {
      throw createTauriCommandError('share_get_recommendations', error, { request });
    }
  },
};