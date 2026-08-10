/**
 * P2P store — Zustand store for P2P 下载队列 / 进度 / 做种 / 缓存管理。
 *
 * 作为「所有活跃下载 + 做种 + 缓存占用」的**单一进度来源**：
 * - 全局 1s 轮询 `p2p_list`（运行于顶层，跨视图持续），刷新 `progressMap`
 *   与 `seeding`（全网热门卡片进度、做种面板均从这里读数）。
 * - 队列 worker 顺序下载「批量收藏/离线缓存」的歌曲（一次一首，控制带宽）。
 * - 缓存磁盘占用统计 + 批量清理。
 *
 * 对「当前正在播放的歌曲」，播放器（playerStore）会直接调用
 * `p2p_download_share`；其进度同样反映在本 store 的 `progressMap` 中，
 * 因此卡片/底部条可统一从 `progressMap` 读取，消除两套进度状态的隐患。
 */

import { create } from 'zustand';
import { p2pClient, type P2pProgress, type P2pCacheStats } from '../services/P2PClient';
import { shareService } from '../services/ShareService';

/** 队列条目状态 */
export type P2pQueueStatus = 'queued' | 'downloading' | 'done' | 'error';

/** 队列中的一首歌曲（用于「批量离线缓存」） */
export interface P2pQueueItem {
  shareId: string;
  title: string;
  artist: string;
  status: P2pQueueStatus;
  /** 错误原因（timeout / noSource / torrentError / noMagnet / metaFailed / httpFailed） */
  errorReason?: string;
}

/** 是否为 Tauri 环境（非 Tauri 时不启动轮询） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

interface P2pStoreState {
  // ---- 队列 ----
  /** 离线缓存/收藏的下载队列 */
  queue: P2pQueueItem[];
  /** 队列 worker 是否正在运行（有排队的正在处理中） */
  active: boolean;

  // ---- 全局进度/做种 ----
  /** shareId → 实时进度（覆盖所有活跃下载/做种条目） */
  progressMap: Record<string, P2pProgress>;
  /** 正在做种的条目（progressMap 中 status === 'seeding' 的子集） */
  seeding: P2pProgress[];
  /** 全局轮询是否已启动 */
  pollRunning: boolean;

  // ---- 缓存 ----
  /** 缓存磁盘占用统计（null 表示尚未拉取） */
  cacheStats: P2pCacheStats | null;

  // ---- Actions ----
  /** 把若干首歌曲加入队列并启动顺序下载 worker */
  enqueue: (shares: Array<{ shareId: string; title: string; artist: string }>) => void;
  /**
   * 停止做种/下载（可删除缓存文件），将 share 从活跃状态移除。
   * @param shareId 目标分享
   * @param deleteFile true = 删除本地缓存文件（彻底移除）
   */
  removeShare: (shareId: string, deleteFile: boolean) => Promise<void>;
  /** 刷新缓存磁盘占用统计 */
  refreshCacheStats: () => Promise<void>;
  /**
   * 批量清理缓存。
   * @param shareIds 目标分享 ID 列表
   * @param delete_ true = 删除文件（清空缓存）；false = 仅停止做种
   */
  clearCache: (shareIds: string[], delete_: boolean) => Promise<void>;
  /** 从 queue 中移除某条记录（UI 操作，不影响后端做种） */
  removeQueueItem: (shareId: string) => void;
  /** 清空全部队列记录（不停止后端做种） */
  clearQueue: () => void;
}

export const useP2pStore = create<P2pStoreState>((set, get) => ({
  queue: [],
  active: false,
  progressMap: {},
  seeding: [],
  pollRunning: false,
  cacheStats: null,

  enqueue: (shares) => {
    const { queue } = get();
    const existing = new Set(queue.map((q) => q.shareId));
    const fresh = shares
      .filter((s) => !existing.has(s.shareId))
      .map((s) => ({ shareId: s.shareId, title: s.title, artist: s.artist, status: 'queued' as const }));
    if (fresh.length === 0) return;
    set({ queue: [...queue, ...fresh], active: true });
    // 确保全局轮询在跑（做种/进度可见）
    ensurePoll();
    // 启动/续跑 worker（幂等）
    void runWorker();
  },

  removeShare: async (shareId, deleteFile) => {
    await p2pClient.remove(shareId, deleteFile);
    // 从队列记录与进度里移除
    set((s) => ({
      queue: s.queue.filter((q) => q.shareId !== shareId),
      progressMap: Object.fromEntries(
        Object.entries(s.progressMap).filter(([id]) => id !== shareId),
      ),
    }));
    refreshList().catch(() => {});
    get().refreshCacheStats().catch(() => {});
  },

  removeQueueItem: (shareId) =>
    set((s) => ({ queue: s.queue.filter((q) => q.shareId !== shareId) })),

  clearQueue: () => set({ queue: [] }),

  refreshCacheStats: async () => {
    try {
      const stats = await p2pClient.cacheStats();
      set({ cacheStats: stats });
    } catch (e) {
      console.warn('[p2p] refresh cache stats failed:', e);
    }
  },

  clearCache: async (shareIds, delete_) => {
    await p2pClient.clearCache(shareIds, delete_);
    if (shareIds.length > 0) {
      set((s) => ({
        progressMap: Object.fromEntries(
          Object.entries(s.progressMap).filter(([id]) => !shareIds.includes(id)),
        ),
      }));
    }
    refreshList().catch(() => {});
    get().refreshCacheStats().catch(() => {});
  },
}));

// ============================================================================
// 全局进度/做种轮询
// ============================================================================

let globalPollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 刷新 `progressMap` + `seeding`（一次）。供轮询与队列/移除后手动刷新调用。
 */
async function refreshList(): Promise<void> {
  try {
    const list = await p2pClient.list();
    const progressMap: Record<string, P2pProgress> = {};
    const seeding: P2pProgress[] = [];
    for (const p of list) {
      progressMap[p.shareId] = p;
      if (p.status === 'seeding') seeding.push(p);
    }
    // 清除已不在活跃列表中的进度残留
    for (const id of Object.keys(useP2pStore.getState().progressMap)) {
      if (!progressMap[id]) delete progressMap[id];
    }
    // 队列调和：若某项已在做种（已缓存完成），置为 done，避免按钮一直停留在排队/下载中。
    const st = useP2pStore.getState();
    let queueChanged = false;
    const queue = st.queue.map((q) => {
      const p = progressMap[q.shareId];
      if ((q.status === 'queued' || q.status === 'downloading') && p && p.status === 'seeding') {
        queueChanged = true;
        return { ...q, status: 'done' as const };
      }
      return q;
    });
    useP2pStore.setState(queueChanged ? { progressMap, seeding, queue } : { progressMap, seeding });
  } catch (e) {
    console.warn('[p2p] list poll failed:', e);
  }
}

/** 启动全局轮询（1s 刷新列表 + 5s 刷新缓存统计）。幂等，仅 Tauri 环境下生效。 */
function ensurePoll(): void {
  if (!isTauriEnv()) return;
  if (globalPollTimer) return;
  useP2pStore.setState({ pollRunning: true });
  let pollCount = 0;
  globalPollTimer = setInterval(() => {
    void refreshList();
    pollCount += 1;
    // 缓存统计不必每次都刷新，每 5 次（约 5s）刷新一次即可
    if (pollCount % 5 === 0) {
      useP2pStore.getState().refreshCacheStats().catch(() => {});
    }
  }, 1000);
  // 立即刷新一次首帧
  void refreshList();
}

// ============================================================================
// 队列 worker（顺序下载，一次一首）
// ============================================================================

/** 是否正在处理某 share（避免与后台播放下载冲突） */
function isBeingProcessed(shareId: string): boolean {
  const p = useP2pStore.getState().progressMap[shareId];
  return !!p && (p.status === 'downloading' || p.status === 'connecting');
}

/**
 * 处理队首若干首歌曲，直到队列为空或遇到正在后台下载的歌曲。
 * 每首歌曲：取 meta → 有磁力走 P2P，无磁力走 HTTP 兜底 → 标记 done/error → 继续下一首。
 */
async function runWorker(): Promise<void> {
  while (true) {
    const state = useP2pStore.getState();
    // 队首第一个「未完成」项
    const idx = state.queue.findIndex(
      (q) => q.status === 'queued' || q.status === 'error',
    );
    if (idx === -1) {
      // 没有待处理项
      const hasPending = state.queue.some((q) => q.status === 'downloading');
      if (!hasPending) {
        useP2pStore.setState({ active: false });
      }
      return;
    }
    const item = state.queue[idx];
    if (isBeingProcessed(item.shareId)) {
      // 该首正由播放器后台下载并会自落到缓存做种，无需 worker 再下。
      // 置为 downloading（进度经轮询可见），待其开始做种后由队列调和置为 done，
      // 避免队列项永久停留在排队中导致按钮无限转圈。
      useP2pStore.setState((s) => ({
        queue: s.queue.map((q, i) => (i === idx ? { ...q, status: 'downloading' as const } : q)),
      }));
      void refreshList().catch(() => {});
      continue;
    }

    // 标记 downloading
    useP2pStore.setState((s) => ({
      queue: s.queue.map((q, i) =>
        i === idx ? { ...q, status: 'downloading' as const } : q,
      ),
    }));
    ensurePoll();

    let errorReason: string | undefined;
    try {
      const meta = await shareService.getMeta(item.shareId);
      if (meta.magnetLink) {
        // P2P 优先；失败时回退 HTTP（保证可用性）
        try {
          await p2pClient.downloadShare({
            shareId: item.shareId,
            magnetLink: meta.magnetLink,
            filename: `${item.shareId}.flac`,
          });
        } catch (p2pErr) {
          console.warn('[p2p] queue P2P failed, falling back to HTTP:', p2pErr);
          errorReason = undefined; // HTTP 兜底成功则不算错误
          // 兜底下载会落到 HTTP 缓存目录；P2P 残留文件由 fx-torrent 保留续传
          await shareService.downloadAndDecrypt(item.shareId);
        }
      } else {
        // 无磁力：直接 HTTP 兜底
        await shareService.downloadAndDecrypt(item.shareId);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 推断错误原因
      errorReason = inferErrorReason(msg);
      console.warn('[p2p] queue item failed:', item.shareId, msg);
    }

    useP2pStore.setState((s) => ({
      queue: s.queue.map((q, i) =>
        i === idx
          ? { ...q, status: errorReason ? ('error' as const) : ('done' as const), errorReason }
          : q,
      ),
    }));
    void refreshList().catch(() => {});
  }
}

/** 根据报错片段推断错误原因，供前端映射文案。 */
function inferErrorReason(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('no_source') || m.includes('tracker') || m.includes('未找到节点')) {
    return 'noSource';
  }
  if (m.includes('timeout') || m.includes('timed out') || m.includes('超时')) {
    return 'timeout';
  }
  if (m.includes('cancelled') || m.includes('cancel')) {
    return 'cancelled';
  }
  if (m.includes('magnet') || m.includes('磁力')) {
    return 'noMagnet';
  }
  if (m.includes('meta')) return 'metaFailed';
  return 'httpFailed';
}

// 应用加载（Tauri 环境）即启动全局轮询，保证「切走再回来进度依然可见」。
if (isTauriEnv()) {
  ensurePoll();
}