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

export type MediaKind = 'image' | 'video' | 'song';

export interface CommunityMediaItem {
  type: MediaKind;
  url: string;
  w?: number;
  h?: number;
  /** 视频提供方（bilibili / youtube / qqvideo） */
  provider?: string;
  title?: string;
  thumb?: string;
  /** song 项：shared_songs.share_id（迁移 030） */
  share_id?: string;
  /** song 项快照：歌手 */
  artist?: string;
  /** song 项快照：时长秒 */
  duration?: number;
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
  /** 当前查看者是否已收藏（P1.6） */
  bookmarked_by_me?: boolean;
  /** 标题（P2B 可选长文） */
  title?: string;
  /** 博客卡封面（社区媒体相对 URL） */
  cover_url?: string;
  /** 置顶时间（作者主页置顶） */
  pinned_at?: string | null;
  /** 浏览量（P3；详情页 +1） */
  view_count?: number;
  /** 转发源帖 id（P3；null = 原创帖，限一层） */
  repost_of?: number | null;
  /** 转发源帖（P3；列表/详情接口回填） */
  repost_source?: CommunityPost | null;
  /** 话题标签（P1.3；列表接口返回） */
  tags: string[];
  /** 表情回应汇总（迁移 030；每 emoji 一行，count 含 mine 态） */
  reactions?: CommunityReactionSummary[];
  /** 作者等级（迁移 031；feed 回填） */
  author_level?: number;
}

/** 表情回应白名单（与服务端 REACTION_EMOJIS 对齐，key → 灵印表情包） */
export const RESPONSE_EMOJIS = [
  'smile',
  'laugh',
  'love',
  'heart-eyes',
  'surprised',
  'cry',
  'rofl',
  'sparkle',
] as const;

export interface CommunityReactionSummary {
  emoji: string;
  count: number;
  /** 当前查看者是否打了这枚 */
  mine: boolean;
}

/** 歌曲广场列表项（与乐窗 ShareService.SharedSongListItem 对齐；无封面 BLOB 字段） */
export interface SharedSongItem {
  shareId: string;
  authorMemberId: number;
  authorName: string;
  title: string;
  artistName?: string | null;
  album?: string | null;
  genre?: string | null;
  durationSeconds: number;
  previewDurationSecs?: number;
  coverUrl?: string | null;
  playCount: number;
  tags?: string | null;
  createdAt: string;
}

// ---- 增长激励（迁移 031）----

/** 每日任务（服务端 defs 固定；listen/signin 为实时进度型） */
export interface DailyQuest {
  key: string;
  name: string;
  description: string;
  goal: number;
  progress: number;
  claimed: boolean;
  claimable: boolean;
  reward_credits: number;
  reward_xp: number;
}

export interface BadgeDefDTO {
  slug: string;
  name: string;
  description: string;
  icon: string;
  tier: 'bronze' | 'silver' | 'gold' | string;
  owned: boolean;
}

export interface MemberBadgeDTO {
  slug: string;
  name: string;
  description: string;
  icon: string;
  tier: string;
  awarded_at: string;
}

/** XP 等级档案（/me/xp/profile 出参子集） */
export interface XpLevelProfile {
  totalXp: number;
  level: number;
  into: number;
  need: number;
}

/** 今日任务面板 */
export const gamificationApi = {
  /** 我的等级档案（等级进度条用） */
  xpProfile(): Promise<XpLevelProfile> {
    return unwrap('/api/v1/me/xp/profile');
  },

  /** 今日任务列表（含实时进度型 listen/signin） */
  questsToday(): Promise<{ day: string; quests: DailyQuest[] }> {
    return unwrap('/api/v1/me/quests/today');
  },

  /** 领取任务奖励（积分批次 + XP） */
  claimQuest(key: string): Promise<{ claimed: string; reward_credits: number; reward_xp: number }> {
    return unwrap(`/api/v1/me/quests/${encodeURIComponent(key)}/claim`, { method: 'POST' });
  },

  /** 徽章目录（含查看者 owned） */
  badges(): Promise<{ badges: BadgeDefDTO[] }> {
    return unwrap('/api/v1/community/badges');
  },

  /** 主页徽章墙 */
  memberBadges(memberId: number): Promise<{ badges: MemberBadgeDTO[] }> {
    return unwrap(`/api/v1/community/members/${memberId}/badges`);
  },
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
  /** 点赞数（P1.4） */
  like_count: number;
  /** 当前查看者是否已赞该评论 */
  liked_by_me: boolean;
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
  /** 主页 banner 封面（P2B） */
  cover?: string | null;
  following_count: number;
  followers_count: number;
  post_count: number;
  /** 主页主题 slug（profile_themes.slug；默认 'songyan'，迁移 027 后旧的 xuanzhi/juan/yinzhang 已废弃） */
  profile_theme: string;
  /**
   * 主题完整载荷（含 axes 四轴 + 配色种子；服务端 home handler 注入）。
   * 查不到时为 null —— 客户端据此回落默认主题，不要当成错误。
   */
  theme?: ProfileThemeDTO | null;
  /** 查看者是否关注了主页主人 */
  viewer_follows: boolean;
  /** 主页主人是否关注了查看者 */
  follows_viewer: boolean;
  /** 双方互关（=好友，可私聊） */
  is_friend: boolean;
  /** 造物集：歌曲作品数（songs 分库聚合） */
  song_count?: number;
  /** 造物集：歌曲总播放数 */
  total_plays?: number;
  /** 造物集：代表作置顶 JSON 字符串（[{type,id}]，≤3；'[]' = 未设置） */
  pinned_works?: string;
  /** 造物集：Lv 灵印角标（XP 等级；服务端 home handler 注入） */
  author_level?: number | null;
}

/** 创作指纹 · 单日计数（热力图一格） */
export interface FingerprintDay {
  /** YYYY-MM-DD */
  day: string;
  posts: number;
  /** songs 分库；分库不可达时恒 0 */
  songs: number;
}

/** 创作指纹 · 类型分布一项 */
export interface FingerprintGenre {
  name: string;
  count: number;
}

/** 创作指纹 · 里程碑一项（key 稳定，展示文案走客户端 i18n） */
export interface FingerprintMilestone {
  key: 'works' | 'songs' | 'posts' | 'activeDays' | 'streak' | 'minutes' | string;
  value: number;
}

/**
 * 创作指纹（造物集 D）
 *
 * ⚠️ clock 是 **UTC 小时分布**，未按用户时区本地化：
 * member_profiles.timezone 存了但从未被写入（无采集来源），
 * 与其编一个假时区，不如诚实给 UTC。
 */
export interface CommunityFingerprint {
  /** 近 365 天逐日计数（升序；无作品的日子不出现在数组里） */
  days: FingerprintDay[];
  /** 24 小时分布（UTC），长度恒 24 */
  clock: number[];
  /** 类型分布（降序，≤8） */
  genres: FingerprintGenre[];
  first_day: string;
  last_day: string;
  total_seconds: number;
  longest_seconds: number;
  /** 连续创作天数 */
  streak: number;
  /** 里程碑（value > 0 才下发） */
  milestones: FingerprintMilestone[];
}

/** 造物集代表作项（type: song=shareId / post=帖子数字 id 的字符串） */
export interface PinnedWork {
  type: 'song' | 'post';
  id: string;
}

/** 造物集歌曲作品（服务端 /share/by-member 原始 snake_case 出参） */
export interface MemberSongWork {
  share_id: string;
  author_member_id: number;
  author_name: string;
  title: string;
  artist_name?: string | null;
  album?: string | null;
  genre?: string | null;
  duration_seconds: number;
  preview_duration_secs?: number;
  cover_url?: string | null;
  cover_mime?: string | null;
  cover_width?: number | null;
  cover_height?: number | null;
  play_count: number;
  tags?: string | null;
  created_at: string;
  /** 对应社区帖 id（凡歌必有帖；by-member 端点回填） */
  community_post_id?: number | null;
}

export interface FollowToggleResult {
  following: boolean;
  followers_count: number;
  is_friend: boolean;
  /** 本次互关达成（好友新建/升级） */
  became_friend: boolean;
}

export type NoticeKind = 'follow' | 'comment' | 'reply' | 'like' | 'mention' | 'reaction' | 'badge' | 'level_up';

/** 主题 DTO（服务端 profile_themes 行 + 查看者视角） */
export interface ProfileThemeDTO {
  slug: string;
  name: string;
  layout: 'hero' | 'minimal' | 'editorial';
  payload: Record<string, unknown>;
  price_credits: number;
  owned: boolean;
  applied: boolean;
}

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

  /** 发布动态（content/media 至少一项非空；转发帖豁免；媒体 ≤9 项） */
  createPost(input: {
    content: string;
    media: CommunityMediaItem[];
    visibility: PostVisibility;
    title?: string;
    cover_url?: string;
    /** 转发源帖 id（P3） */
    repost_of?: number;
  }): Promise<{ post_id: number }> {
    return unwrap('/api/v1/community/posts', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  /** 提交举报（P3 治理；target 仅 post/comment，目标需存在且未删） */
  createReport(
    targetType: 'post' | 'comment',
    targetId: number,
    reason: string,
    detail?: string,
  ): Promise<{ report_id: number }> {
    return unwrap('/api/v1/community/reports', {
      method: 'POST',
      body: JSON.stringify({
        target_type: targetType,
        target_id: targetId,
        reason,
        detail: detail ?? '',
      }),
    });
  },

  /** 动态详情（可见性判定：private 仅作者，followers 需关注） */
  getPost(postId: number): Promise<CommunityPost> {
    return unwrap(`/api/v1/community/posts/${postId}`);
  },

  /**
   * 编辑动态（仅作者）。media 提供时整体替换媒体数组（迁移 030，可增删图/视频）；
   * cover_url 提供时替换封面（空串=清除）。缺省不改动。
   */
  editPost(
    postId: number,
    content: string,
    opts: { media?: CommunityMediaItem[]; cover_url?: string } = {},
  ): Promise<unknown> {
    return unwrap(`/api/v1/community/posts/${postId}`, {
      method: 'PUT',
      body: JSON.stringify({
        content,
        ...(opts.media ? { media: opts.media } : {}),
        ...(opts.cover_url !== undefined ? { cover_url: opts.cover_url } : {}),
      }),
    });
  },

  /** 删除动态（作者或 admin） */
  deletePost(postId: number): Promise<unknown> {
    return unwrap(`/api/v1/community/posts/${postId}`, { method: 'DELETE' });
  },

  // ---- Feed ----

  /** 广场流（tab=latest|hot；latest 走 before 游标，hot 走 offset 偏移） */
  feedSquare(
    tab: 'latest' | 'hot',
    opts: { before?: number; offset?: number; limit?: number; tag?: string } = {},
  ): Promise<{ posts: CommunityPost[] }> {
    const params = new URLSearchParams({ tab });
    if (opts.before != null) params.set('before', String(opts.before));
    if (opts.offset != null) params.set('offset', String(opts.offset));
    if (opts.tag) params.set('tag', opts.tag);
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

  // ---- 造物集（作品即门面）----

  /** 某会员的歌曲作品列表（公开端点；page 分页，created_at DESC） */
  async memberSongs(memberId: number, page = 1, perPage = 24): Promise<MemberSongWork[]> {
    const data = (await unwrap(
      `/api/v1/share/by-member/${memberId}?page=${page}&per_page=${perPage}`,
    )) as { items?: MemberSongWork[] };
    return data.items ?? [];
  },

  /** 设置造物集代表作（仅本人；works ≤3，服务端校验归属） */
  async updatePinnedWorks(memberId: number, works: PinnedWork[]): Promise<void> {
    await unwrap(`/api/v1/community/members/${memberId}/pinned-works`, {
      method: 'PUT',
      body: JSON.stringify({ works }),
    });
  },

  /** 解析主页 payload 里的 pinned_works JSON（'[]'/脏数据兜底空数组） */
  parsePinnedWorks(raw?: string | null): PinnedWork[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(
        (w): w is PinnedWork =>
          w && typeof w === 'object'
          && (w.type === 'song' || w.type === 'post')
          && typeof w.id === 'string',
      );
    } catch {
      return [];
    }
  },

  // ---- 互动 ----

  /** 点赞 toggle → { liked, like_count } */
  toggleLike(postId: number): Promise<{ liked: boolean; like_count: number }> {
    return unwrap(`/api/v1/community/posts/${postId}/like`, { method: 'POST' });
  },

  /** 表情回应 toggle（同 emoji 再点=取消，不同=替换）→ 全量汇总 */
  toggleReaction(
    postId: number,
    emoji: string,
  ): Promise<{ my_reaction: string | null; reactions: CommunityReactionSummary[] }> {
    return unwrap(`/api/v1/community/posts/${postId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    });
  },

  /** 评论列表（after 游标；软删行原样返回供占位） */
  listComments(
    postId: number,
    opts: { after?: number; limit?: number } = {},
  ): Promise<{ comments: CommunityComment[] }> {
    const params = new URLSearchParams();
    if (opts.after != null) params.set('after', String(opts.after));
    params.set('limit', String(opts.limit ?? 20));
    return unwrap(
      `/api/v1/community/posts/${postId}/comments?${params.toString()}`,
    );
  },

  /** 评论点赞 toggle（P1.4）→ { liked, like_count } */
  toggleCommentLike(commentId: number): Promise<{ liked: boolean; like_count: number }> {
    return unwrap(`/api/v1/community/comments/${commentId}/like`, { method: 'POST' });
  },

  /** 收藏 toggle（P1.6） */
  toggleBookmark(postId: number): Promise<{ bookmarked: boolean }> {
    return unwrap(`/api/v1/community/posts/${postId}/bookmark`, { method: 'POST' });
  },

  /** 我的收藏流（P1.6；id DESC 游标） */
  listBookmarks(opts: { before?: number; limit?: number } = {}): Promise<{ posts: CommunityPost[] }> {
    const params = new URLSearchParams();
    if (opts.before != null) params.set('before', String(opts.before));
    params.set('limit', String(opts.limit ?? 20));
    return unwrap(`/api/v1/community/bookmarks?${params.toString()}`);
  },

  /** 帖子搜索（P1.5；public；q 必填） */
  searchPosts(q: string, opts: { before?: number; limit?: number } = {}): Promise<{ posts: CommunityPost[] }> {
    const params = new URLSearchParams({ q });
    if (opts.before != null) params.set('before', String(opts.before));
    params.set('limit', String(opts.limit ?? 20));
    return unwrap(`/api/v1/community/search?${params.toString()}`);
  },

  /** 近 7 天热门话题（P1.3） */
  hotTags(limit = 10): Promise<{ tags: Array<{ tag: string; post_count: number }> }> {
    return unwrap(`/api/v1/community/tags/hot?limit=${limit}`);
  },

  // ---- 歌曲 × 社区打通（迁移 030）----

  /**
   * 歌曲帖映射（凡歌必有帖）：shareId → 社区帖 id（评论统一/去讨论用）。
   * 无关联帖（未回填）时 404。
   */
  postByShare(shareId: string): Promise<{ post_id: number }> {
    return unwrap(
      `/api/v1/community/posts/by-share/${encodeURIComponent(shareId)}`,
    );
  },

  /** 官方公告位（迁移 032；公开；无公告时 data 为 null） */
  announcement(): Promise<{ title: string; body: string } | null> {
    return unwrap('/api/v1/community/announcement');
  },

  /**
   * 歌曲广场列表（公开端点 /share/recent；sort=latest|hot 热门含播放数时间衰减）。
   * 字段与乐窗 ShareService.SharedSongListItem 对齐（camelCase）。
   */
  listSongs(
    sort: 'latest' | 'hot',
    limit = 50,
  ): Promise<{ songs: SharedSongItem[] }> {
    return unwrap(`/api/v1/share/recent?sort=${sort}&limit=${limit}`);
  },

  // ---- 主题引擎（P2A/P2C）----

  /** 官方主题列表（含查看者 owned/applied） */
  listThemes(): Promise<{ themes: ProfileThemeDTO[] }> {
    return unwrap('/api/v1/community/themes');
  },

  /** 获取主题（免费授予 / 积分购买） */
  acquireTheme(slug: string): Promise<{ owned: boolean; spent: number }> {
    return unwrap(`/api/v1/community/themes/${slug}/acquire`, { method: 'POST' });
  },

  /** 应用主题 */
  applyTheme(slug: string): Promise<{ applied: string }> {
    return unwrap(`/api/v1/community/themes/${slug}/apply`, { method: 'POST' });
  },

  /** 我的主题库存 */
  myThemes(): Promise<{ slugs: string[] }> {
    return unwrap('/api/v1/community/themes/mine');
  },

  // ---- 置顶 / 归档（P2B）----

  /** 作者置顶/取消置顶 */
  setPostPinned(postId: number, pinned: boolean): Promise<{ pinned: boolean }> {
    return unwrap(`/api/v1/community/posts/${postId}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    });
  },

  /** 主页归档（按月聚合） */
  memberArchive(memberId: number): Promise<{ months: Array<{ month: string; post_count: number }> }> {
    return unwrap(`/api/v1/community/members/${memberId}/archive`);
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

  /**
   * 创作指纹（造物集 D）：热力图/时钟/类型/里程碑
   *
   * 独立端点而非并入 memberHome：只在滚到指纹区才拉，零作品用户不产生请求。
   * 失败返回 null（不抛），调用方渲染兜底文案——指纹是锦上添花，
   * 不该因为它让整个主页打不开。
   */
  async memberFingerprint(memberId: number): Promise<CommunityFingerprint | null> {
    try {
      return await unwrap(`/api/v1/community/members/${memberId}/fingerprint`);
    } catch {
      return null;
    }
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

  /**
   * 上传图片（multipart；魔数校验 jpg/png/gif/webp；≤10MB）。
   * 服务端重编码（长边>2048 缩放重编，GIF 保留原图）并生成 480px WebP 缩略图。
   * 返回相对 URL：url=原图，thumb_url=缩略图（GIF 时与 url 相同）。
   */
  async uploadMedia(file: File): Promise<{ url: string; thumb_url: string }> {
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
