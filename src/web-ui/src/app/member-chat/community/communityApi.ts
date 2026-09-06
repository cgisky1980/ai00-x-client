/**
 * 社区 API 客户端（迁移 020）
 *
 * 与 chatApi.ts 同模式：复用 fetchWithAuth（自动注入 Bearer + baseUrl + 401 刷新），
 * 响应信封 `{ code, message, data }`，unwrap 取 data。
 *
 * 端点：动态 CRUD / 四路 Feed / 点赞评论 / 关注（互关即好友）/ 主页聚合 / 通知 / 媒体上传。
 */

import { fetchWithAuth } from '@/infrastructure/auth/fetchWithAuth';
import { tokenManager } from '@/infrastructure/auth/TokenManager';

// ---- 类型（与后端 ai00-storage models 对齐）----

export type MediaKind = 'image' | 'video';

export interface CommunityMediaItem {
  type: MediaKind;
  url: string;
  w?: number;
  h?: number;
  /** 视频提供方（bilibili / youtube / qqvideo） */
  provider?: string;
  title?: string;
  thumb?: string;
}

export type PostVisibility = 'public' | 'followers' | 'private';

export interface CommunityPost {
  id: number;
  member_id: number;
  username: string;
  nickname: string;
  avatar?: string | null;
  content: string;
  /** 服务端已校验结构；前端直接消费 */
  media: CommunityMediaItem[];
  visibility: PostVisibility;
  like_count: number;
  comment_count: number;
  created_at: string;
  edited_at?: string | null;
  /** 当前查看者是否已点赞 */
  liked_by_me: boolean;
}

export interface CommunityComment {
  id: number;
  post_id: number;
  member_id: number;
  username: string;
  nickname: string;
  avatar?: string | null;
  content: string;
  reply_to?: number | null;
  /** 被回复者昵称/用户名（服务端派生列；已删时无） */
  reply_to_name?: string | null;
  created_at: string;
  deleted_at?: string | null;
}

export interface CommunityMemberItem {
  member_id: number;
  username: string;
  nickname: string;
  avatar?: string | null;
  /** 查看者是否关注了此人 */
  followed_by_viewer: boolean;
}

export interface CommunityHome {
  member_id: number;
  username: string;
  nickname: string;
  avatar?: string | null;
  bio?: string | null;
  location?: string | null;
  website?: string | null;
  following_count: number;
  followers_count: number;
  post_count: number;
  /** 主页主题模板（xuanzhi/juan/yinzhang） */
  profile_theme: string;
  /** 查看者是否关注了主页主人 */
  viewer_follows: boolean;
  /** 主页主人是否关注了查看者 */
  follows_viewer: boolean;
  /** 双方互关（=好友，可私聊） */
  is_friend: boolean;
}

export interface FollowToggleResult {
  following: boolean;
  followers_count: number;
  is_friend: boolean;
  /** 本次互关达成（好友新建/升级） */
  became_friend: boolean;
}

export type NoticeKind = 'follow' | 'comment' | 'reply' | 'like';

export interface CommunityNotification {
  id: number;
  member_id: number;
  actor_id: number;
  actor_name: string;
  actor_nickname: string;
  actor_avatar?: string | null;
  kind: NoticeKind;
  post_id?: number | null;
  /** 帖子内容摘要（前 60 字符；帖子已删时无） */
  post_excerpt?: string | null;
  comment_id?: number | null;
  created_at: string;
  read_at?: string | null;
}

interface Envelope<T> {
  code: number;
  message?: string;
  data: T;
}

async function unwrap<T>(path: string, init?: RequestInit): Promise<T> {
  const body = await fetchWithAuth<Envelope<T>>(path, init);
  return body.data;
}

// ---- REST 端点 ----

export const communityApi = {
  // ---- 动态 ----

  /** 发布动态（content/media 至少一项非空；媒体 ≤9 项） */
  createPost(input: {
    content: string;
    media: CommunityMediaItem[];
    visibility: PostVisibility;
  }): Promise<{ post_id: number }> {
    return unwrap('/api/v1/community/posts', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  /** 动态详情（可见性判定：private 仅作者，followers 需关注） */
  getPost(postId: number): Promise<CommunityPost> {
    return unwrap(`/api/v1/community/posts/${postId}`);
  },

  /** 编辑文本（仅作者，v1 仅文本） */
  editPost(postId: number, content: string): Promise<unknown> {
    return unwrap(`/api/v1/community/posts/${postId}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  /** 删除动态（作者或 admin） */
  deletePost(postId: number): Promise<unknown> {
    return unwrap(`/api/v1/community/posts/${postId}`, { method: 'DELETE' });
  },

  // ---- Feed ----

  /** 广场流（tab=latest|hot；before 游标分页） */
  feedSquare(
    tab: 'latest' | 'hot',
    opts: { before?: number; limit?: number } = {},
  ): Promise<{ posts: CommunityPost[] }> {
    const params = new URLSearchParams({ tab });
    if (opts.before != null) params.set('before', String(opts.before));
    params.set('limit', String(opts.limit ?? 20));
    return unwrap(`/api/v1/community/feed/square?${params.toString()}`);
  },

  /** 关注流（我关注的人 + 自己） */
  feedFollowing(opts: { before?: number; limit?: number } = {}): Promise<{
    posts: CommunityPost[];
  }> {
    const params = new URLSearchParams();
    if (opts.before != null) params.set('before', String(opts.before));
    params.set('limit', String(opts.limit ?? 20));
    return unwrap(`/api/v1/community/feed/following?${params.toString()}`);
  },

  /** 他人主页动态墙（自己=全部；他人=public + 我关注作者时的 followers） */
  memberPosts(
    memberId: number,
    opts: { before?: number; limit?: number } = {},
  ): Promise<{ posts: CommunityPost[] }> {
    const params = new URLSearchParams();
    if (opts.before != null) params.set('before', String(opts.before));
    params.set('limit', String(opts.limit ?? 20));
    return unwrap(
      `/api/v1/community/members/${memberId}/posts?${params.toString()}`,
    );
  },

  // ---- 互动 ----

  /** 点赞 toggle → { liked, like_count } */
  toggleLike(postId: number): Promise<{ liked: boolean; like_count: number }> {
    return unwrap(`/api/v1/community/posts/${postId}/like`, { method: 'POST' });
  },

  /** 评论列表（after 游标；软删行原样返回供占位） */
  listComments(
    postId: number,
    opts: { after?: number; limit?: number } = {},
  ): Promise<{ comments: CommunityComment[] }> {
    const params = new URLSearchParams();
    if (opts.after != null) params.set('after', String(opts.after));
    params.set('limit', String(opts.limit ?? 50));
    return unwrap(
      `/api/v1/community/posts/${postId}/comments?${params.toString()}`,
    );
  },

  /** 发表评论（replyTo 支持楼中楼） */
  createComment(
    postId: number,
    content: string,
    replyTo?: number,
  ): Promise<CommunityComment> {
    return unwrap(`/api/v1/community/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content, reply_to: replyTo ?? null }),
    });
  },

  /** 删除评论（评论作者/帖主/admin） */
  deleteComment(commentId: number): Promise<unknown> {
    return unwrap(`/api/v1/community/comments/${commentId}`, {
      method: 'DELETE',
    });
  },

  // ---- 关注（互关即好友）----

  /** 主页聚合（资料+计数+查看者视角关系） */
  memberHome(memberId: number): Promise<CommunityHome> {
    return unwrap(`/api/v1/community/members/${memberId}`);
  },

  /** 关注 toggle（互关自动结为好友；返回 became_friend） */
  toggleFollow(memberId: number): Promise<FollowToggleResult> {
    return unwrap(`/api/v1/community/members/${memberId}/follow`, {
      method: 'POST',
    });
  },

  /** 粉丝列表 */
  listFollowers(
    memberId: number,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ followers: CommunityMemberItem[] }> {
    const params = new URLSearchParams();
    params.set('limit', String(opts.limit ?? 50));
    params.set('offset', String(opts.offset ?? 0));
    return unwrap(
      `/api/v1/community/members/${memberId}/followers?${params.toString()}`,
    );
  },

  /** 关注列表 */
  listFollowing(
    memberId: number,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ following: CommunityMemberItem[] }> {
    const params = new URLSearchParams();
    params.set('limit', String(opts.limit ?? 50));
    params.set('offset', String(opts.offset ?? 0));
    return unwrap(
      `/api/v1/community/members/${memberId}/following?${params.toString()}`,
    );
  },

  // ---- 通知 ----

  /** 通知列表（id DESC 游标） */
  listNotifications(
    opts: { before?: number; limit?: number } = {},
  ): Promise<{ notifications: CommunityNotification[] }> {
    const params = new URLSearchParams();
    if (opts.before != null) params.set('before', String(opts.before));
    params.set('limit', String(opts.limit ?? 20));
    return unwrap(`/api/v1/community/notifications?${params.toString()}`);
  },

  /** 未读通知数（红点） */
  unreadNotifications(): Promise<{ unread: number }> {
    return unwrap('/api/v1/community/notifications/unread');
  },

  /** 全部已读 */
  markAllRead(): Promise<{ updated: number }> {
    return unwrap('/api/v1/community/notifications/read_all', {
      method: 'POST',
    });
  },

  // ---- 媒体 ----

  /** 上传图片（multipart；魔数校验 jpg/png/gif/webp；≤10MB）→ 相对 URL */
  async uploadMedia(file: File): Promise<{ url: string }> {
    const fd = new FormData();
    fd.append('file', file);
    return unwrap('/api/v1/community/media/upload', { method: 'POST', body: fd });
  },
};

// ---- 媒体 URL 解析 ----

/**
 * 相对媒体 URL（/api/v1/community/media/...）→ 绝对 URL（服务器 baseUrl 前缀）。
 * WebView 页面源在本地内嵌服务，相对路径 <img src> 会打到本机 → 必须解析到远端服务器。
 * 已是绝对/http(s)/data URL 原样返回。
 */
export async function resolveMediaUrl(url: string): Promise<string> {
  if (/^(https?:|data:)/i.test(url)) return url;
  const base = await tokenManager.getBaseUrl();
  return `${base.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}
