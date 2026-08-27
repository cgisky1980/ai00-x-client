/**
 * 在线音源收藏 store — localStorage 持久化的本地收藏。
 *
 * 惯例对齐 acestep 音乐模块（profileStore/shareStore）：手写 localStorage
 * load/save + 版本化 key + 防御性回填 + 静默容错，不用 zustand persist。
 *
 * 数据：完整 OnlineSong 对象（playOnline 重放需要 downloadUrl/dlHeaders/
 * lyric 等字段），songKey 去重，新收藏置顶，上限 500 条 FIFO 淘汰尾部。
 * 本地优先隐私策略：跨会话保留、不跨设备/服务端同步。
 *
 * 注意：在线直链有时效性（CDN 签名过期）——收藏重放失败属预期场景，
 * 由播放层报错提示「删除后重新搜索」，本 store 不做自动 re-resolve。
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { OnlineSong } from './types';
import { songKey } from './types';

const STORAGE_KEY = 'musicSource.favorites.v1';
const MAX_FAVORITES = 500;

/** 防御性加载：损坏/缺字段时回退空列表。 */
function loadFavorites(): OnlineSong[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is OnlineSong =>
        s != null &&
        typeof s.source === 'string' &&
        typeof s.name === 'string' &&
        typeof s.downloadUrl === 'string',
    );
  } catch {
    return [];
  }
}

/** 静默容错保存（配额满等异常不打断播放流程）。 */
function saveFavorites(favorites: OnlineSong[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    /* ignore */
  }
}

export interface FavoritesState {
  favorites: OnlineSong[];
  /** 是否已收藏（按 songKey） */
  isFavored: (key: string) => boolean;
  /**
   * 切换收藏状态。返回操作结果描述（供 UI toast）：
   * 'added' | 'removed' | 'evicted'（已达上限，淘汰了最旧一条后才加入）
   */
  toggleFavorite: (song: OnlineSong) => 'added' | 'removed' | 'evicted';
  /** 按 key 移除单条 */
  removeFavorite: (key: string) => void;
  /** 按 key 查找完整对象（footer 收藏按钮需要） */
  findByKey: (key: string) => OnlineSong | null;
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  favorites: loadFavorites(),

  isFavored: (key) => get().favorites.some((s) => songKey(s) === key),

  toggleFavorite: (song) => {
    const key = songKey(song);
    const current = get().favorites;
    const existingIdx = current.findIndex((s) => songKey(s) === key);
    if (existingIdx >= 0) {
      const next = current.filter((_, i) => i !== existingIdx);
      set({ favorites: next });
      saveFavorites(next);
      return 'removed';
    }
    // 新收藏置顶；超限 FIFO 淘汰尾部
    let next = [song, ...current];
    let result: 'added' | 'evicted' = 'added';
    if (next.length > MAX_FAVORITES) {
      next = next.slice(0, MAX_FAVORITES);
      result = 'evicted';
    }
    set({ favorites: next });
    saveFavorites(next);
    // 收藏含音乐：异步持久下载音频（成功后回填 localPath）
    void persistSongAudio(song, key);
    return result;
  },

  removeFavorite: (key) => {
    const next = get().favorites.filter((s) => songKey(s) !== key);
    set({ favorites: next });
    saveFavorites(next);
  },

  findByKey: (key) => get().favorites.find((s) => songKey(s) === key) ?? null,
}));

/**
 * 收藏即落盘：音频持久下载到 {songs_dir}/favorites/（Rust persist=true），
 * 成功后把 localPath 写进收藏条目——收藏「包括音乐本身」，直链过期后
 * 仍可离线播放。失败静默（元数据收藏仍成立，播放时走在线下载兜底）。
 * 定义在 store 之后（引用 useFavoritesStore，避免 use-before-define）。
 */
async function persistSongAudio(song: OnlineSong, key: string): Promise<void> {
  try {
    const cacheKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const localPath = await invoke<string>('musicfree_download_media', {
      url: song.downloadUrl,
      key: cacheKey,
      headers: song.dlHeaders ?? {},
      persist: true,
    });
    useFavoritesStore.setState((s) => ({
      favorites: s.favorites.map((f) =>
        songKey(f) === key ? { ...f, localPath } : f,
      ),
    }));
    saveFavorites(useFavoritesStore.getState().favorites);
  } catch (e) {
    console.warn('[favorites] persist audio failed (metadata-only kept):', e);
  }
}
