/**
 * 用户音乐画像 store（v1.3.0+ 个性化推荐）
 *
 * ## 设计目标
 *
 * 在客户端本地（localStorage）维护用户音乐偏好画像，用于驱动服务端
 * `POST /api/v1/share/recommend` 推荐计算。画像跨会话保留，但不跨设备
 * 同步（与 ai00-x 的「本地优先」隐私策略一致）。
 *
 * ## 画像结构（localStorage key: `acestep.musicProfile.v1`）
 *
 * - `tagWeights`: 偏好标签累计权重（可负），key = "zh:快节奏" / "en:fast"
 * - `likedIds` / `dislikedIds`: 喜欢/不喜欢的 share_id 列表
 * - `playedHistory`: 已听过的歌（key = share_id，含播放时长/是否播完）
 * - `updatedAt`: 画像最后更新时间
 *
 * ## 信号采集权重
 *
 * | 信号   | 触发条件                  | tag 权重变化 | 列表变化                          |
 * |------|-----------------------|----------|--------------------------------|
 * | 完整播放 | 播放时长 > 30s 或 > 50%  | +1       | playedHistory[shareId].completed = true  |
 * | 跳过   | 播放时长 < 10s 切换下一首    | -1       | playedHistory[shareId].completed = false |
 * | 点赞   | 用户点击 ♥ 按钮           | +3       | likedIds.push(shareId)         |
 * | 取消点赞 | 再次点击 ♥              | -3       | likedIds.remove(shareId)       |
 * | 评论   | 评论成功（hook shareStore） | +2       | —                              |
 * | 不喜欢  | 用户点击 ⊘ 按钮           | -5       | dislikedIds.push(shareId)      |
 *
 * ## 淘汰策略
 *
 * - `playedHistory` 超过 1000 条：按 `playedAt` 升序删除最旧
 * - `likedIds` / `dislikedIds` 各上限 500：按加入顺序淘汰
 * - `tagWeights` 不淘汰（长期偏好保留）
 *
 * 遵循 shareStore.ts 的 create + set/get 模式。
 */

import { create } from 'zustand';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ProfileStore');

/** localStorage key（带版本号，便于未来 schema 迁移） */
const PROFILE_STORAGE_KEY = 'acestep.musicProfile.v1';

/** playedHistory 上限（LRU 淘汰） */
const MAX_PLAYED_HISTORY = 1000;
/** likedIds / dislikedIds 上限 */
const MAX_LIKED_DISLIKED = 500;

/** 信号权重常量（与文档表格对齐） */
const WEIGHT_PLAY_COMPLETE = 1;
const WEIGHT_PLAY_SKIP = -1;
const WEIGHT_LIKE = 3;
const WEIGHT_UNLIKE = -3;
const WEIGHT_COMMENT = 2;
const WEIGHT_DISLIKE = -5;

/** 判断完整播放的阈值 */
const COMPLETE_DURATION_THRESHOLD_SEC = 30;
const COMPLETE_RATIO_THRESHOLD = 0.5;
/** 判断跳过的阈值 */
const SKIP_DURATION_THRESHOLD_SEC = 10;

/**
 * 单条播放历史记录。
 * 用于 playedHistory[shareId]。
 */
export interface PlayedHistoryEntry {
  /** RFC3339 时间字符串 */
  playedAt: string;
  /** 实际播放时长（秒） */
  durationSec: number;
  /** 是否播完（>50% 或 >30s） */
  completed: boolean;
}

/**
 * 用户音乐画像（持久化到 localStorage）。
 */
export interface MusicProfile {
  /** 偏好 tags 权重（累计信号）。
   * key = "zh:快节奏" / "en:fast"，value = 加权分数（可负）。
   * 正向信号 +，负向信号 -。 */
  tagWeights: Record<string, number>;
  /** 喜欢的歌 share_id 列表（用于调 similar API） */
  likedIds: string[];
  /** 不喜欢的歌 share_id 列表（推荐时排除） */
  dislikedIds: string[];
  /** 已听过的歌（推荐时排除，避免重复推）。
   * key = share_id, value = { playedAt, durationSec, completed } */
  playedHistory: Record<string, PlayedHistoryEntry>;
  /** 画像最后更新时间（RFC3339） */
  updatedAt: string;
}

/** 空画像（新用户冷启动） */
function emptyProfile(): MusicProfile {
  return {
    tagWeights: {},
    likedIds: [],
    dislikedIds: [],
    playedHistory: {},
    updatedAt: new Date().toISOString(),
  };
}

/** 从 localStorage 读取画像（损坏时回退为空画像） */
function loadProfile(): MusicProfile {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return emptyProfile();
    const parsed = JSON.parse(raw) as Partial<MusicProfile>;
    // 防御性回填：保证所有字段存在（避免旧版本 schema 缺字段）
    return {
      tagWeights: parsed.tagWeights ?? {},
      likedIds: parsed.likedIds ?? [],
      dislikedIds: parsed.dislikedIds ?? [],
      playedHistory: parsed.playedHistory ?? {},
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch (e) {
    log.warn('loadProfile: failed to parse localStorage, resetting', e);
    return emptyProfile();
  }
}

/** 持久化画像到 localStorage（配额满静默忽略） */
function saveProfile(profile: MusicProfile): void {
  try {
    profile.updatedAt = new Date().toISOString();
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch (e) {
    log.warn('saveProfile: failed to write localStorage', e);
  }
}

/**
 * 解析 SharedSongListItem.tags（JSON 字符串）为 string[]。
 *
 * 服务端 tags 字段格式为 `["zh:快节奏","en:fast"]` 的 JSON 字符串，
 * 可能缺失或损坏，本函数统一返回空数组。
 */
export function parseSongTags(tagsJson: string | undefined | null): string[] {
  if (!tagsJson) return [];
  try {
    const parsed = JSON.parse(tagsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
  } catch {
    return [];
  }
}

/**
 * playedHistory LRU 淘汰：超过上限时删除最旧的（按 playedAt 升序）。
 */
function evictPlayedHistory(profile: MusicProfile): void {
  const ids = Object.keys(profile.playedHistory);
  if (ids.length <= MAX_PLAYED_HISTORY) return;
  // 按 playedAt 升序排序，删除最旧的
  const sorted = ids.sort((a, b) => {
    const ta = profile.playedHistory[a]?.playedAt ?? '';
    const tb = profile.playedHistory[b]?.playedAt ?? '';
    return ta.localeCompare(tb);
  });
  const toRemove = sorted.length - MAX_PLAYED_HISTORY;
  for (let i = 0; i < toRemove; i++) {
    delete profile.playedHistory[sorted[i]];
  }
}

/**
 * 列表 LRU 淘汰：likedIds/dislikedIds 超过上限时删除最旧的（FIFO）。
 */
function evictList(list: string[], max: number): string[] {
  if (list.length <= max) return list;
  return list.slice(list.length - max);
}

/** 应用 tag 权重变化（批量） */
function applyTagWeights(
  tagWeights: Record<string, number>,
  tags: string[],
  delta: number,
): void {
  for (const tag of tags) {
    tagWeights[tag] = (tagWeights[tag] ?? 0) + delta;
    // 权重归零时删除 key，避免 tagWeights 无限增长
    if (tagWeights[tag] === 0) {
      delete tagWeights[tag];
    }
  }
}

/** 判断是否为完整播放 */
export function isCompletePlay(durationSec: number, songDurationSec: number): boolean {
  if (durationSec >= COMPLETE_DURATION_THRESHOLD_SEC) return true;
  if (songDurationSec > 0 && durationSec / songDurationSec >= COMPLETE_RATIO_THRESHOLD) {
    return true;
  }
  return false;
}

/** 判断是否为跳过 */
export function isSkipPlay(durationSec: number): boolean {
  return durationSec < SKIP_DURATION_THRESHOLD_SEC;
}

// ============================================================================
// Store 定义
// ============================================================================

interface ProfileState {
  /** 用户音乐画像（持久化镜像） */
  profile: MusicProfile;

  // ---- 信号采集 actions ----

  /**
   * 记录播放信号（在切换下一首/上一首/关闭播放器时调用）。
   *
   * @param shareId 分享 ID（仅对 kind === 'share' 的歌曲采集）
   * @param durationSec 实际播放时长（秒）
   * @param songDurationSec 歌曲总时长（秒，用于完整播放判断）
   * @param songTags 歌曲标签数组（已从 JSON 字符串解析）
   */
  recordPlaySignal: (
    shareId: string,
    durationSec: number,
    songDurationSec: number,
    songTags: string[],
  ) => void;

  /**
   * 切换点赞状态（再次点击取消点赞）。
   *
   * @param shareId 分享 ID
   * @param songTags 歌曲标签数组
   * @returns 新的点赞状态（true = 已点赞）
   */
  toggleLike: (shareId: string, songTags: string[]) => boolean;

  /**
   * 记录评论信号（在 addComment 成功后调用）。
   * 仅 +2 权重，不加 likedIds（评论 ≠ 喜欢）。
   *
   * @param shareId 分享 ID
   * @param songTags 歌曲标签数组
   */
  recordComment: (shareId: string, songTags: string[]) => void;

  /**
   * 切换不喜欢状态（再次点击取消）。
   *
   * @param shareId 分享 ID
   * @param songTags 歌曲标签数组
   * @returns 新的不喜欢状态（true = 已不喜欢）
   */
  toggleDislike: (shareId: string, songTags: string[]) => boolean;

  /** 判断 shareId 是否已点赞 */
  isLiked: (shareId: string) => boolean;
  /** 判断 shareId 是否已不喜欢 */
  isDisliked: (shareId: string) => boolean;

  /** 清空画像（重置） */
  resetProfile: () => void;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profile: loadProfile(),

  recordPlaySignal: (shareId, durationSec, songDurationSec, songTags) => {
    if (!shareId || songTags.length === 0) {
      // 即使无 tags，仍记录 playedHistory（用于推荐时排除）
      if (!shareId) return;
    }

    const completed = isCompletePlay(durationSec, songDurationSec);
    const skipped = isSkipPlay(durationSec);
    const weight = completed
      ? WEIGHT_PLAY_COMPLETE
      : skipped
        ? WEIGHT_PLAY_SKIP
        : 0; // 中间状态（10s~30s 且未到 50%）不计权重

    set((state) => {
      const profile: MusicProfile = {
        ...state.profile,
        tagWeights: { ...state.profile.tagWeights },
        likedIds: [...state.profile.likedIds],
        dislikedIds: [...state.profile.dislikedIds],
        playedHistory: { ...state.profile.playedHistory },
      };

      // 更新 playedHistory
      profile.playedHistory[shareId] = {
        playedAt: new Date().toISOString(),
        durationSec,
        completed,
      };
      evictPlayedHistory(profile);

      // 应用 tag 权重
      if (weight !== 0 && songTags.length > 0) {
        applyTagWeights(profile.tagWeights, songTags, weight);
      }

      saveProfile(profile);
      return { profile };
    });
  },

  toggleLike: (shareId, songTags) => {
    let nowLiked = false;
    set((state) => {
      const profile: MusicProfile = {
        ...state.profile,
        tagWeights: { ...state.profile.tagWeights },
        likedIds: [...state.profile.likedIds],
        dislikedIds: [...state.profile.dislikedIds],
        playedHistory: state.profile.playedHistory,
      };

      const idx = profile.likedIds.indexOf(shareId);
      if (idx >= 0) {
        // 取消点赞：权重 -3，移出列表
        profile.likedIds.splice(idx, 1);
        if (songTags.length > 0) {
          applyTagWeights(profile.tagWeights, songTags, WEIGHT_UNLIKE);
        }
        nowLiked = false;
      } else {
        // 点赞：权重 +3，加入列表
        profile.likedIds.push(shareId);
        profile.likedIds = evictList(profile.likedIds, MAX_LIKED_DISLIKED);
        if (songTags.length > 0) {
          applyTagWeights(profile.tagWeights, songTags, WEIGHT_LIKE);
        }
        // 点赞时自动移除 dislike（互斥）
        const dIdx = profile.dislikedIds.indexOf(shareId);
        if (dIdx >= 0) {
          profile.dislikedIds.splice(dIdx, 1);
          if (songTags.length > 0) {
            // 回补 dislike 扣的权重
            applyTagWeights(profile.tagWeights, songTags, -WEIGHT_DISLIKE);
          }
        }
        nowLiked = true;
      }

      saveProfile(profile);
      return { profile };
    });
    return nowLiked;
  },

  recordComment: (shareId, songTags) => {
    if (!shareId) return;
    set((state) => {
      const profile: MusicProfile = {
        ...state.profile,
        tagWeights: { ...state.profile.tagWeights },
        likedIds: state.profile.likedIds,
        dislikedIds: state.profile.dislikedIds,
        playedHistory: state.profile.playedHistory,
      };

      if (songTags.length > 0) {
        applyTagWeights(profile.tagWeights, songTags, WEIGHT_COMMENT);
      }

      saveProfile(profile);
      return { profile };
    });
  },

  toggleDislike: (shareId, songTags) => {
    let nowDisliked = false;
    set((state) => {
      const profile: MusicProfile = {
        ...state.profile,
        tagWeights: { ...state.profile.tagWeights },
        likedIds: [...state.profile.likedIds],
        dislikedIds: [...state.profile.dislikedIds],
        playedHistory: state.profile.playedHistory,
      };

      const idx = profile.dislikedIds.indexOf(shareId);
      if (idx >= 0) {
        // 取消不喜欢：回补权重
        profile.dislikedIds.splice(idx, 1);
        if (songTags.length > 0) {
          applyTagWeights(profile.tagWeights, songTags, -WEIGHT_DISLIKE);
        }
        nowDisliked = false;
      } else {
        // 不喜欢：权重 -5，加入列表
        profile.dislikedIds.push(shareId);
        profile.dislikedIds = evictList(profile.dislikedIds, MAX_LIKED_DISLIKED);
        if (songTags.length > 0) {
          applyTagWeights(profile.tagWeights, songTags, WEIGHT_DISLIKE);
        }
        // 不喜欢时自动移除 like（互斥）
        const lIdx = profile.likedIds.indexOf(shareId);
        if (lIdx >= 0) {
          profile.likedIds.splice(lIdx, 1);
          if (songTags.length > 0) {
            applyTagWeights(profile.tagWeights, songTags, WEIGHT_UNLIKE);
          }
        }
        nowDisliked = true;
      }

      saveProfile(profile);
      return { profile };
    });
    return nowDisliked;
  },

  isLiked: (shareId) => get().profile.likedIds.includes(shareId),

  isDisliked: (shareId) => get().profile.dislikedIds.includes(shareId),

  resetProfile: () => {
    const fresh = emptyProfile();
    saveProfile(fresh);
    set({ profile: fresh });
    log.info('profile reset');
  },
}));

// ============================================================================
// 非 React 访问入口（供 playerStore/shareStore 直接调用，无需 useProfileStore）
// ============================================================================

/** 非 React 上下文下直接读取当前画像（如 playerStore/playNext 中调用） */
export function getProfile(): MusicProfile {
  return useProfileStore.getState().profile;
}

/** 非 React 上下文下调用 recordPlaySignal */
export function recordPlaySignal(
  shareId: string,
  durationSec: number,
  songDurationSec: number,
  songTags: string[],
): void {
  useProfileStore.getState().recordPlaySignal(shareId, durationSec, songDurationSec, songTags);
}

/** 非 React 上下文下调用 toggleLike */
export function toggleLike(shareId: string, songTags: string[]): boolean {
  return useProfileStore.getState().toggleLike(shareId, songTags);
}

/** 非 React 上下文下调用 recordComment */
export function recordComment(shareId: string, songTags: string[]): void {
  useProfileStore.getState().recordComment(shareId, songTags);
}

/** 非 React 上下文下调用 toggleDislike */
export function toggleDislike(shareId: string, songTags: string[]): boolean {
  return useProfileStore.getState().toggleDislike(shareId, songTags);
}
