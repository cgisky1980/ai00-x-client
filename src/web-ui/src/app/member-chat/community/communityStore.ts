/**
 * 社区 Zustand store（迁移 020）
 *
 * 视图状态机：feed（广场/关注流）→ postDetail（详情+评论）/ profile（主页）/
 * notifications（通知中心）。数据动作集中于此，CommunityView 只做组装。
 */

import { create } from 'zustand';

import {
  communityApi,
  type CommunityComment,
  type CommunityHome,
  type CommunityMediaItem,
  type CommunityNotification,
  type CommunityPost,
  type FollowToggleResult,
  type PostVisibility,
} from './communityApi';

export type CommunityViewKind = 'feed' | 'postDetail' | 'profile' | 'notifications';
export type FeedTab = 'latest' | 'hot' | 'following';

interface CommunityState {
  // 视图状态（history 支持详情↔主页逐级返回）
  view: CommunityViewKind;
  history: CommunityViewKind[];
  feedTab: FeedTab;
  /** 详情/主页返回时恢复的视图栈（简单两级：feed ↔ detail/profile） */
  posts: CommunityPost[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;

  // 详情
  detailPost: CommunityPost | null;
  comments: CommunityComment[];
  commentsLoading: boolean;

  // 主页
  home: CommunityHome | null;
  homePosts: CommunityPost[];
  homeHasMore: boolean;

  // 通知
  notifications: CommunityNotification[];
  unreadNotices: number;

  // 动作
  setFeedTab(tab: FeedTab): void;
  loadFeed(reset?: boolean): Promise<void>;
  loadMore(): Promise<void>;
  createPost(input: {
    content: string;
    media: CommunityMediaItem[];
    visibility: PostVisibility;
  }): Promise<boolean>;
  deletePost(postId: number): Promise<void>;
  toggleLike(post: CommunityPost): Promise<void>;
  updatePostContent(postId: number, content: string): void;
  openDetail(post: CommunityPost): void;
  openPostById(postId: number): Promise<void>;
  back(): void;
  closeDetail(): void;
  loadComments(): Promise<void>;
  createComment(content: string, replyTo?: number): Promise<boolean>;
  deleteComment(id: number): Promise<void>;
  openProfile(memberId: number): void;
  closeProfile(): void;
  loadHomePosts(reset?: boolean): Promise<void>;
  toggleFollow(memberId: number): Promise<FollowToggleResult | null>;
  /** 主页资料变更后重拉（编辑资料/关注态同步） */
  reloadHome(): Promise<void>;
  openNotifications(): void;
  loadNotifications(reset?: boolean): Promise<void>;
  markAllRead(): Promise<void>;
  /** WS community_notice 到达：未读 +1（列表打开时顺带刷新） */
  bumpUnread(): void;
  refreshUnread(): Promise<void>;
  clearError(): void;
}

const PAGE_SIZE = 20;

export const useCommunityStore = create<CommunityState>((set, get) => ({
  view: 'feed',
  history: [],
  feedTab: 'latest',
  posts: [],
  hasMore: false,
  loading: false,
  error: null,

  detailPost: null,
  comments: [],
  commentsLoading: false,

  home: null,
  homePosts: [],
  homeHasMore: false,

  notifications: [],
  unreadNotices: 0,

  clearError: () => set({ error: null }),

  setFeedTab: (tab) => {
    set({ feedTab: tab });
    void get().loadFeed(true);
  },

  loadFeed: async (reset = true) => {
    const { feedTab, posts, loading } = get();
    if (loading) return;
    set({ loading: true, error: null });
    try {
      const before = reset ? undefined : posts[posts.length - 1]?.id;
      const res =
        feedTab === 'following'
          ? await communityApi.feedFollowing({ before, limit: PAGE_SIZE })
          : await communityApi.feedSquare(feedTab, { before, limit: PAGE_SIZE });
      set((st) => ({
        posts: reset ? res.posts : [...st.posts, ...res.posts],
        hasMore: res.posts.length >= PAGE_SIZE,
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  loadMore: async () => {
    if (get().loading || !get().hasMore) return;
    await get().loadFeed(false);
  },

  createPost: async (input) => {
    try {
      const { post_id } = await communityApi.createPost(input);
      // 乐观刷新：把新帖取回来插到流首（回退：直接刷新整流）
      try {
        const p = await communityApi.getPost(post_id);
        set((st) => ({ posts: [p, ...st.posts] }));
      } catch {
        void get().loadFeed(true);
      }
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  deletePost: async (postId) => {
    try {
      await communityApi.deletePost(postId);
      set((st) => ({
        posts: st.posts.filter((p) => p.id !== postId),
        homePosts: st.homePosts.filter((p) => p.id !== postId),
        // 详情页删除 → 回退（feed 态删帖停留原地不受影响）
        view: st.detailPost?.id === postId && st.view === 'postDetail' ? 'feed' : st.view,
        history: st.detailPost?.id === postId ? [] : st.history,
        detailPost: st.detailPost?.id === postId ? null : st.detailPost,
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  toggleLike: async (post) => {
    // 乐观点赞（计数 ±1 + 填充态），失败回滚
    const revert = (st: CommunityState): Partial<CommunityState> => {
      const patch = (p: CommunityPost): CommunityPost =>
        p.id === post.id ? { ...p, liked_by_me: post.liked_by_me, like_count: post.like_count } : p;
      return {
        posts: st.posts.map(patch),
        detailPost: st.detailPost ? patch(st.detailPost) : null,
        homePosts: st.homePosts.map(patch),
      };
    };
    const optimistic = (liked: boolean, like_count: number) => {
      set((st) => {
        const patch = (p: CommunityPost): CommunityPost =>
          p.id === post.id ? { ...p, liked_by_me: liked, like_count } : p;
        return {
          posts: st.posts.map(patch),
          detailPost: st.detailPost ? patch(st.detailPost) : null,
          homePosts: st.homePosts.map(patch),
        };
      });
    };
    const nextLiked = !post.liked_by_me;
    optimistic(nextLiked, post.like_count + (nextLiked ? 1 : -1));
    try {
      const r = await communityApi.toggleLike(post.id);
      optimistic(r.liked, r.like_count);
    } catch (e) {
      set(revert);
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** 编辑动态后同步文本到所有缓存的同名帖 */
  updatePostContent: (postId, content) => {
    set((st) => {
      const patch = (p: CommunityPost): CommunityPost =>
        p.id === postId
          ? { ...p, content, edited_at: new Date().toISOString() }
          : p;
      return {
        posts: st.posts.map(patch),
        detailPost: st.detailPost && st.detailPost.id === postId ? patch(st.detailPost) : null,
        homePosts: st.homePosts.map(patch),
      };
    });
  },

  openDetail: (post) => {
    set((st) => ({
      view: 'postDetail',
      history: [...st.history, st.view],
      detailPost: post,
      comments: [],
    }));
    void get().loadComments();
  },

  /** 通过 id 打开详情（通知跳转用） */
  openPostById: async (postId) => {
    try {
      const p = await communityApi.getPost(postId);
      get().openDetail(p);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** 逐级返回（详情↔主页栈）；空栈回 feed */
  back: () => {
    set((st) => {
      const history = [...st.history];
      const prev = history.pop() ?? 'feed';
      return { view: prev, history };
    });
  },

  closeDetail: () => set({ view: 'feed', history: [], detailPost: null, comments: [] }),

  loadComments: async () => {
    const postId = get().detailPost?.id;
    if (postId == null) return;
    set({ commentsLoading: true });
    try {
      const res = await communityApi.listComments(postId, { limit: 100 });
      set({ comments: res.comments });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ commentsLoading: false });
    }
  },

  createComment: async (content, replyTo) => {
    const postId = get().detailPost?.id;
    if (postId == null) return false;
    try {
      const c = await communityApi.createComment(postId, content, replyTo);
      set((st) => ({
        comments: [...st.comments, c],
        detailPost: st.detailPost
          ? { ...st.detailPost, comment_count: st.detailPost.comment_count + 1 }
          : null,
        posts: st.posts.map((p) =>
          p.id === postId ? { ...p, comment_count: p.comment_count + 1 } : p,
        ),
      }));
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  deleteComment: async (id) => {
    const postId = get().detailPost?.id;
    try {
      await communityApi.deleteComment(id);
      set((st) => ({
        comments: st.comments.map((c) =>
          c.id === id ? { ...c, deleted_at: new Date().toISOString() } : c,
        ),
        detailPost:
          postId != null && st.detailPost
            ? { ...st.detailPost, comment_count: Math.max(0, st.detailPost.comment_count - 1) }
            : st.detailPost,
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  openProfile: (memberId) => {
    set((st) => ({
      view: 'profile',
      history: [...st.history, st.view],
      home: null,
      homePosts: [],
      homeHasMore: false,
    }));
    void (async () => {
      try {
        const home = await communityApi.memberHome(memberId);
        set({ home });
        await get().loadHomePosts(true);
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    })();
  },

  closeProfile: () => set({ view: 'feed', history: [], home: null, homePosts: [] }),

  loadHomePosts: async (reset = true) => {
    const home = get().home;
    if (!home) return;
    try {
      const before = reset ? undefined : get().homePosts[get().homePosts.length - 1]?.id;
      const res = await communityApi.memberPosts(home.member_id, {
        before,
        limit: PAGE_SIZE,
      });
      set((st) => ({
        homePosts: reset ? res.posts : [...st.homePosts, ...res.posts],
        homeHasMore: res.posts.length >= PAGE_SIZE,
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  toggleFollow: async (memberId) => {
    try {
      const r = await communityApi.toggleFollow(memberId);
      const home = get().home;
      if (home && home.member_id === memberId) {
        set({
          home: {
            ...home,
            viewer_follows: r.following,
            is_friend: r.is_friend,
            followers_count: r.followers_count,
          },
        });
      }
      // 关注后关注流内容变化 → 下次进 following tab 会重新拉取
      return r;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  reloadHome: async () => {
    const home = get().home;
    if (!home) return;
    try {
      set({ home: await communityApi.memberHome(home.member_id) });
    } catch {
      // 静默（主页刷新失败不打断浏览）
    }
  },

  openNotifications: () => {
    set({ view: 'notifications' });
    void get().loadNotifications(true);
  },

  loadNotifications: async (reset = true) => {
    try {
      const before = reset
        ? undefined
        : get().notifications[get().notifications.length - 1]?.id;
      const res = await communityApi.listNotifications({ before, limit: PAGE_SIZE });
      set((st) => ({
        notifications: reset ? res.notifications : [...st.notifications, ...res.notifications],
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  markAllRead: async () => {
    try {
      await communityApi.markAllRead();
      set((st) => ({
        notifications: st.notifications.map((n) => ({
          ...n,
          read_at: n.read_at ?? new Date().toISOString(),
        })),
        unreadNotices: 0,
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  bumpUnread: () => {
    set((st) => ({ unreadNotices: st.unreadNotices + 1 }));
  },

  refreshUnread: async () => {
    try {
      const { unread } = await communityApi.unreadNotifications();
      set({ unreadNotices: unread });
    } catch {
      // 静默（红点轮询失败不干扰主流程）
    }
  },
}));
