/**
 * 推荐流 store（v1.3.0+ 个性化推荐）
 *
 * ## 设计目标
 *
 * 管理服务端推荐流（`POST /api/v1/share/recommend`），提供：
 * - 30 分钟客户端缓存（`lastRefreshAt`），避免重复请求压垮服务器
 * - 画像裁剪：只发 top 5 likedIds + top 20 tagWeights，减少网络负载
 * - 冷启动支持：无 likedIds 时服务端返回最近分享
 * - 轮播位精选：前 5 首作为顶部轮播展示
 *
 * ## 服务器负担控制策略
 *
 * | 策略     | 说明                                                |
 * | ------ | ------------------------------------------------- |
 * | 单次请求   | 客户端 1 次 POST /share/recommend 拿全量推荐，而非 N 次 similar |
 * | 画像裁剪   | 客户端只发 top 5 likedIds + top 20 tagWeights，不发全量历史   |
 * | 结果缓存   | 客户端 30 分钟内不重复请求（lastRefreshAt）                  |
 * | 排除集预传  | playedIds/dislikedIds 客户端预过滤，减少服务端比较量            |
 * | 冷启动快路径 | 无 likedIds 时服务端跳过向量计算                              |
 *
 * 遵循 shareStore.ts 的 create + set/get 模式。
 */

import { create } from 'zustand';
import { createLogger } from '@/shared/utils/logger';
import { shareService, type RecommendRequest, type SharedSongListItem } from '../services/ShareService';
import { getProfile } from './profileStore';

const log = createLogger('RecommendStore');

/** 推荐流缓存有效期（30 分钟），过期后下次访问自动刷新 */
const RECOMMEND_CACHE_TTL_MS = 30 * 60 * 1000;

/** 请求 likedIds 上限（按最近点赞时间裁剪） */
const MAX_LIKED_IDS = 5;
/** 请求 dislikedIds 上限（服务端排除用） */
const MAX_DISLIKED_IDS = 500;
/** 请求 playedIds 上限（服务端排除用） */
const MAX_PLAYED_IDS = 1000;
/** 请求 tagWeights 上限（按绝对值排序，正负都保留） */
const MAX_TAG_WEIGHTS = 20;
/** 默认请求 limit */
const DEFAULT_LIMIT = 20;
/** 轮播位数量（从 recommendations 取 top） */
const CAROUSEL_COUNT = 5;

interface RecommendState {
  /** 推荐流（服务端返回的混合排序列表） */
  recommendations: SharedSongListItem[];
  /** 轮播位精选（前 5 首，从 recommendations 取 top） */
  carousel: SharedSongListItem[];
  /** 加载中 */
  loading: boolean;
  /** 最近一次错误（null = 无错误） */
  error: string | null;
  /** 最后刷新时间（ms timestamp），null = 从未刷新 */
  lastRefreshAt: number | null;
  /** 推荐来源（冷启动 / 画像） */
  source: 'cold-start' | 'profile' | null;

  /**
   * 刷新推荐流（调用服务端 POST /share/recommend）。
   *
   * 流程：
   * 1. 从 profileStore 读取画像，裁剪为请求参数
   * 2. 调用 shareService.getRecommendations(payload)
   * 3. carousel = items.slice(0, 5)
   * 4. recommendations = items
   * 5. lastRefreshAt = Date.now()
   *
   * @param force true = 强制刷新（忽略缓存有效期）
   */
  refresh: (force?: boolean) => Promise<void>;

  /** 判断缓存是否过期（超过 30 分钟） */
  isStale: () => boolean;

  /** 清空推荐流（用户重置画像后调用） */
  clear: () => void;
}

/**
 * 裁剪画像为推荐请求参数。
 *
 * - likedIds: top 5（按最近加入顺序，即 likedIds 末尾的 5 个）
 * - dislikedIds: 全量（最多 500，服务端排除）
 * - playedIds: 全量 shareId（最多 1000，服务端排除）
 * - tagWeights: top 20（按绝对值排序，正负都保留）
 */
function buildRequestFromProfile(limit: number = DEFAULT_LIMIT): RecommendRequest {
  const profile = getProfile();

  // likedIds: 取最后 5 个（最近点赞的）
  const likedIds = profile.likedIds.slice(-MAX_LIKED_IDS);

  // dislikedIds: 全量，最多 500（FIFO 保留最近的）
  const dislikedIds = profile.dislikedIds.slice(-MAX_DISLIKED_IDS);

  // playedIds: 全量 shareId，最多 1000
  const playedIds = Object.keys(profile.playedHistory).slice(-MAX_PLAYED_IDS);

  // tagWeights: top 20（按绝对值降序，正负都保留）
  const tagWeightsEntries = Object.entries(profile.tagWeights)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, MAX_TAG_WEIGHTS);
  const tagWeights: Record<string, number> = {};
  for (const [tag, weight] of tagWeightsEntries) {
    tagWeights[tag] = weight;
  }

  return {
    likedIds,
    dislikedIds,
    playedIds,
    tagWeights,
    limit,
  };
}

export const useRecommendStore = create<RecommendState>((set, get) => ({
  recommendations: [],
  carousel: [],
  loading: false,
  error: null,
  lastRefreshAt: null,
  source: null,

  refresh: async (force = false) => {
    // 缓存检查：未过期且非强制刷新时跳过
    if (!force && get().lastRefreshAt !== null) {
      const age = Date.now() - get().lastRefreshAt!;
      if (age < RECOMMEND_CACHE_TTL_MS) {
        log.debug('refresh: cache still fresh, skipping');
        return;
      }
    }

    set({ loading: true, error: null });
    try {
      const request = buildRequestFromProfile(DEFAULT_LIMIT);
      log.debug('refresh: calling getRecommendations', {
        likedCount: request.likedIds.length,
        tagCount: Object.keys(request.tagWeights).length,
        playedCount: request.playedIds.length,
      });

      const response = await shareService.getRecommendations(request);

      set({
        recommendations: response.items,
        carousel: response.items.slice(0, CAROUSEL_COUNT),
        loading: false,
        lastRefreshAt: Date.now(),
        source: response.source,
        error: null,
      });
      log.info('refresh: ok', {
        count: response.items.length,
        source: response.source,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('refresh: failed', e);
      set({ loading: false, error: msg });
    }
  },

  isStale: () => {
    const { lastRefreshAt } = get();
    if (lastRefreshAt === null) return true;
    return Date.now() - lastRefreshAt >= RECOMMEND_CACHE_TTL_MS;
  },

  clear: () => {
    set({
      recommendations: [],
      carousel: [],
      loading: false,
      error: null,
      lastRefreshAt: null,
      source: null,
    });
    log.info('cleared');
  },
}));

// ============================================================================
// 非 React 访问入口
// ============================================================================

/** 非 React 上下文下触发刷新 */
export async function refreshRecommendations(force = false): Promise<void> {
  await useRecommendStore.getState().refresh(force);
}
