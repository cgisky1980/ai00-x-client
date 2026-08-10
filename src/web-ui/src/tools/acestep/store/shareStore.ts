/**
 * 分享 Zustand store（Phase E.1 + E.2 + E.3）
 *
 * ## Phase E.1
 * 管理"我的分享"列表 + 上传/删除状态。
 *
 * ## Phase E.2
 * 管理"分享广场"（最近公开分享）+ 播放上报。
 *
 * ## Phase E.3
 * 管理评论列表 + 当前用户 member_id（用于判断是否显示编辑/删除按钮）。
 *
 * 遵循 playerStore.ts 的模式（create + set/get）。
 */

import { create } from 'zustand';
import { tokenManager } from '@/infrastructure/auth/TokenManager';
import { createLogger } from '@/shared/utils/logger';
import {
  shareService,
  type ShareComment,
  type SharePlayResult,
  type ShareUploadArchiveRequest,
  type ShareUploadResult,
  type SharedSongListItem,
} from '../services/ShareService';
import { clearShareCoverCache } from '../hooks/useShareCover';
import { recordComment, parseSongTags } from './profileStore';

/**
 * 本地归档（.a00m 文件路径）→ shareId 映射的 localStorage key。
 *
 * 作品库「已分享」标记依赖此映射：上传成功后写入，取消分享/删除本地文件后移除。
 * 仅作 UI 提示用途 —— 服务端 `share_list_mine` 才是分享状态的唯一权威来源。
 */
const ARCHIVE_SHARE_MAP_KEY = 'acestep.archiveShareMap.v1';

/** 从 localStorage 读取归档分享映射（损坏时回退为空对象）。 */
function loadArchiveShareMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ARCHIVE_SHARE_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** 持久化归档分享映射到 localStorage。 */
function saveArchiveShareMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(ARCHIVE_SHARE_MAP_KEY, JSON.stringify(map));
  } catch {
    // 配额满等异常静默忽略 —— 仅影响「已分享」标记展示
  }
}

const log = createLogger('ShareStore');

/**
 * 模块级请求序号：用于 loadComments / loadMoreComments 的 race condition 保护。
 *
 * 用户快速切换分享时，旧请求可能比新请求慢完成，导致旧评论覆盖新评论。
 * 每次发起请求递增此序号，请求完成后检查是否仍是最新序号，否则丢弃结果。
 *
 * 模块级而非 state 字段：避免污染 store 接口 + 避免触发不必要的 re-render。
 */
let latestCommentsRequestId = 0;

interface ShareState {
  /** 当前会员的分享列表 */
  myShares: SharedSongListItem[];
  /** 分享广场：最近公开分享 */
  recentShares: SharedSongListItem[];
  /** 列表加载中（我的分享） */
  loading: boolean;
  /** 广场加载中 */
  galleryLoading: boolean;
  /** 最近一次错误（null = 无错误） */
  error: string | null;
  /** 分页信息（我的分享） */
  total: number;
  page: number;
  perPage: number;

  // ---- 作品库归档分享（Phase F） ----
  /** 本地归档路径（`.a00m` 绝对路径）→ shareId 映射（localStorage 持久化） */
  archiveShareMap: Record<string, string>;
  /** 归档上传中（作品库卡片按钮用） */
  archiveUploading: boolean;
  /** 归档上传结果（成功后保存，用于对话框显示分享链接/文件大小） */
  archiveUploadResult: ShareUploadResult | null;

  // ---- Phase E.3: 评论系统 ----
  /** 当前打开的分享的评论列表（按 commentsSort 排序） */
  comments: ShareComment[];
  /** 评论加载中 */
  commentsLoading: boolean;
  /** 评论操作错误（独立于 error，避免覆盖列表错误） */
  commentsError: string | null;
  /** 当前用户 member_id（用于判断是否显示编辑/删除按钮；null = 未登录） */
  currentMemberId: number | null;
  /** 评论操作进行中（用于禁用提交按钮） */
  commentSubmitting: boolean;
  /** 评论总数（用于判断是否还有更多可加载，"加载更多"按钮显示条件） */
  commentsTotal: number;
  /** 当前评论排序方向（'asc' = 旧→新，'desc' = 新→旧） */
  commentsSort: 'asc' | 'desc';

  /** 加载当前会员的分享列表 */
  loadMine: (page?: number, perPage?: number) => Promise<void>;
  /** 加载分享广场（最近公开分享） */
  loadRecent: (limit?: number) => Promise<void>;
  /** 删除分享（成功后从列表中移除） */
  deleteShare: (shareId: string) => Promise<void>;
  /** 上传本地归档分享（成功后写入 archiveShareMap） */
  uploadArchiveShare: (req: ShareUploadArchiveRequest) => Promise<ShareUploadResult>;
  /** 取消某本地归档的分享（吊销服务端分享 + 移除映射） */
  unshareArchive: (archivePath: string) => Promise<void>;
  /** 本地归档删除后调用：移除映射（若曾分享过，先吊销服务端分享） */
  removeArchiveMapping: (archivePath: string, revokeRemote?: boolean) => Promise<void>;
  /** 上报播放（用于播放计数） */
  recordPlay: (shareId: string, clientId?: string) => Promise<SharePlayResult>;
  /** 清除错误状态 */
  clearError: () => void;

  // ---- Phase E.3: 评论系统 actions ----
  /** 加载某分享的评论列表（公开端点，覆盖式设置） */
  loadComments: (
    shareId: string,
    limit?: number,
    offset?: number,
    sort?: 'asc' | 'desc',
  ) => Promise<void>;
  /** 加载更多评论（offset = comments.length，追加而非覆盖） */
  loadMoreComments: (shareId: string) => Promise<void>;
  /** 切换评论排序（会重置 offset=0 重新加载） */
  setCommentsSort: (sort: 'asc' | 'desc') => void;
  /** 添加评论（成功后重新加载评论列表以获取服务端排序） */
  addComment: (shareId: string, content: string, parentId?: number | null) => Promise<void>;
  /** 编辑评论（仅作者本人；成功后更新本地列表对应项） */
  editComment: (shareId: string, commentId: number, content: string) => Promise<void>;
  /** 删除评论（仅作者本人；成功后从本地列表移除） */
  deleteComment: (shareId: string, commentId: number) => Promise<void>;
  /** 加载当前用户 member_id（从 TokenManager.getAuthInfo） */
  loadCurrentMemberId: () => Promise<void>;
  /** 清空评论状态（切换分享或关闭详情对话框时调用） */
  clearComments: () => void;
  /** 清除评论错误状态 */
  clearCommentsError: () => void;

  // ---- v1.3.0+: 画像信号辅助 ----
  /** 从 recentShares/myShares 中查找指定 shareId 的 tags（已解析） */
  findShareTags: (shareId: string) => string[];
}

export const useShareStore = create<ShareState>((set, get) => ({
  myShares: [],
  recentShares: [],
  loading: false,
  galleryLoading: false,
  error: null,
  total: 0,
  page: 1,
  perPage: 20,

  // ---- 作品库归档分享初始状态 ----
  archiveShareMap: loadArchiveShareMap(),
  archiveUploading: false,
  archiveUploadResult: null,

  // ---- Phase E.3: 评论系统初始状态 ----
  comments: [],
  commentsLoading: false,
  commentsError: null,
  currentMemberId: null,
  commentSubmitting: false,
  commentsTotal: 0,
  commentsSort: 'asc',

  loadMine: async (page = 1, perPage = 20) => {
    set({ loading: true, error: null });
    try {
      const result = await shareService.listMine(page, perPage);
      set({
        myShares: result.items,
        total: result.total,
        page: result.page,
        perPage: result.perPage,
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadRecent: async (limit = 20) => {
    set({ galleryLoading: true, error: null });
    try {
      const result = await shareService.listRecent(limit);
      set({
        recentShares: result.songs,
        galleryLoading: false,
      });
    } catch (e) {
      set({ galleryLoading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  deleteShare: async (shareId) => {
    set({ error: null });
    try {
      await shareService.delete(shareId);
      // 清理内存中的封面 URL 缓存（磁盘缓存由 share_delete 命令清理）
      clearShareCoverCache(shareId);
      // 从列表中移除并更新 total
      set((state) => ({
        myShares: state.myShares.filter((s) => s.shareId !== shareId),
        recentShares: state.recentShares.filter((s) => s.shareId !== shareId),
        total: Math.max(0, state.total - 1),
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  recordPlay: async (shareId, clientId) => {
    try {
      return await shareService.recordPlay(shareId, clientId);
    } catch (e) {
      // 播放上报失败不应阻塞播放流程，只记录错误
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  // ---- 作品库归档分享 actions ----

  uploadArchiveShare: async (req) => {
    // 并发保护：若已有归档上传进行中，直接拒绝
    if (get().archiveUploading) {
      throw new Error('Archive upload already in progress');
    }
    set({ archiveUploading: true, error: null, archiveUploadResult: null });
    try {
      const result = await shareService.uploadArchive(req);
      // 写入映射并持久化（作品库「已分享」标记）
      set((state) => {
        const archiveShareMap = { ...state.archiveShareMap, [req.archivePath]: result.shareId };
        saveArchiveShareMap(archiveShareMap);
        return { archiveShareMap, archiveUploading: false, archiveUploadResult: result };
      });
      return result;
    } catch (e) {
      set({ archiveUploading: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  unshareArchive: async (archivePath) => {
    const shareId = get().archiveShareMap[archivePath];
    if (!shareId) return;
    set({ error: null });
    try {
      await shareService.delete(shareId);
      clearShareCoverCache(shareId);
      set((state) => {
        const archiveShareMap = { ...state.archiveShareMap };
        delete archiveShareMap[archivePath];
        saveArchiveShareMap(archiveShareMap);
        return {
          archiveShareMap,
          myShares: state.myShares.filter((s) => s.shareId !== shareId),
          recentShares: state.recentShares.filter((s) => s.shareId !== shareId),
          total: Math.max(0, state.total - 1),
        };
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  removeArchiveMapping: async (archivePath, revokeRemote = true) => {
    const shareId = get().archiveShareMap[archivePath];
    if (!shareId) return;
    if (revokeRemote) {
      try {
        await shareService.delete(shareId);
        clearShareCoverCache(shareId);
        set((state) => ({
          myShares: state.myShares.filter((s) => s.shareId !== shareId),
          recentShares: state.recentShares.filter((s) => s.shareId !== shareId),
          total: Math.max(0, state.total - 1),
        }));
      } catch (e) {
        // 吊销失败不阻塞本地删除 —— 服务端残留分享可在「我的分享」页手动清理
        log.warn('failed to revoke share on local delete', { shareId, error: String(e) });
      }
    }
    set((state) => {
      const archiveShareMap = { ...state.archiveShareMap };
      delete archiveShareMap[archivePath];
      saveArchiveShareMap(archiveShareMap);
      return { archiveShareMap };
    });
  },

  clearError: () => set({ error: null }),

  // ---- Phase E.3: 评论系统 actions ----

  loadComments: async (shareId, limit = 50, offset = 0, sort) => {
    const effectiveSort = sort ?? get().commentsSort;
    const requestId = ++latestCommentsRequestId;
    set({ commentsLoading: true, commentsError: null, commentsSort: effectiveSort });
    try {
      const result = await shareService.listComments(shareId, limit, offset, effectiveSort);
      // race condition 保护：若期间用户切换了分享或排序，丢弃此旧请求结果
      if (requestId !== latestCommentsRequestId) return;
      set({
        comments: result.comments,
        commentsTotal: result.total,
        commentsSort: result.sort as 'asc' | 'desc',
        commentsLoading: false,
      });
    } catch (e) {
      if (requestId !== latestCommentsRequestId) return;
      set({
        commentsLoading: false,
        commentsError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  loadMoreComments: async (shareId) => {
    const state = get();
    // 已在加载中 / 已加载全部 → 不重复请求
    if (state.commentsLoading || state.comments.length >= state.commentsTotal) return;
    const offset = state.comments.length;
    const limit = 50;
    const requestId = ++latestCommentsRequestId;
    set({ commentsLoading: true, commentsError: null });
    try {
      const result = await shareService.listComments(
        shareId,
        limit,
        offset,
        state.commentsSort,
      );
      // race condition 保护：若期间用户切换了分享或排序，丢弃此旧请求结果
      if (requestId !== latestCommentsRequestId) return;
      // 追加而非覆盖（保持已有评论 + 新评论拼接到末尾）
      set((prev) => ({
        comments: [...prev.comments, ...result.comments],
        commentsTotal: result.total,
        commentsLoading: false,
      }));
    } catch (e) {
      if (requestId !== latestCommentsRequestId) return;
      set({
        commentsLoading: false,
        commentsError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  setCommentsSort: (sort) => {
    // 仅设置 state；调用方应随后调用 loadComments 重新加载（offset=0 覆盖式）
    set({ commentsSort: sort });
  },

  addComment: async (shareId, content, parentId = null) => {
    set({ commentSubmitting: true, commentsError: null });
    try {
      await shareService.addComment(shareId, content, parentId);
      set({ commentSubmitting: false });
      // 重新加载评论列表以获取服务端排序 + 回填的 id/created_at/member_name
      // 保持当前 sort（用户切到 desc 后添加评论应继续看到最新优先）
      await get().loadComments(shareId, 50, 0, get().commentsSort);

      // v1.3.0+: Hook comment signal to profileStore (+2 tag weight).
      // songTags 从 recentShares/myShares 中查找该 shareId 的 tags 字段。
      const songTags = get().findShareTags(shareId);
      recordComment(shareId, songTags);
    } catch (e) {
      set({
        commentSubmitting: false,
        commentsError: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  editComment: async (shareId, commentId, content) => {
    set({ commentSubmitting: true, commentsError: null });
    try {
      await shareService.editComment(shareId, commentId, content);
      // 本地更新 content + editedAt（避免重新加载）
      set((state) => ({
        comments: state.comments.map((c) =>
          c.id === commentId
            ? { ...c, content, editedAt: new Date().toISOString() }
            : c,
        ),
        commentSubmitting: false,
      }));
    } catch (e) {
      set({
        commentSubmitting: false,
        commentsError: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  deleteComment: async (shareId, commentId) => {
    set({ commentSubmitting: true, commentsError: null });
    try {
      await shareService.deleteComment(shareId, commentId);
      // 本地移除该评论及其所有回复（parent_id === commentId 的也移除）
      // 同步减少 commentsTotal（不重新加载列表，避免破坏当前分页位置）
      set((state) => {
        const removed = state.comments.filter((c) => c.id === commentId);
        const removedReplyCount = state.comments.filter(
          (c) => c.parentId === commentId,
        ).length;
        const removedTotal = removed.length + removedReplyCount;
        return {
          comments: state.comments.filter(
            (c) => c.id !== commentId && c.parentId !== commentId,
          ),
          commentsTotal: Math.max(0, state.commentsTotal - removedTotal),
          commentSubmitting: false,
        };
      });
    } catch (e) {
      set({
        commentSubmitting: false,
        commentsError: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  loadCurrentMemberId: async () => {
    try {
      const auth = await tokenManager.getAuthInfo();
      set({ currentMemberId: auth?.member_id ?? null });
    } catch {
      // 静默失败：未登录时 currentMemberId 保持 null，UI 不显示编辑/删除按钮
      set({ currentMemberId: null });
    }
  },

  clearComments: () =>
    set({
      comments: [],
      commentsLoading: false,
      commentsError: null,
      commentSubmitting: false,
      commentsTotal: 0,
      // 保留 commentsSort：用户切换分享时保留上次排序选择
    }),

  clearCommentsError: () => set({ commentsError: null }),

  // ---- v1.3.0+: 画像信号辅助 ----
  findShareTags: (shareId) => {
    const { recentShares, myShares } = get();
    // 优先从 recentShares 查找（分享广场），回退到 myShares
    const song = recentShares.find((s) => s.shareId === shareId)
      ?? myShares.find((s) => s.shareId === shareId);
    return song ? parseSongTags(song.tags) : [];
  },
}));