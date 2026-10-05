/**
 * resolveSourceAudio — 把「音频来源选择器」的四种来源统一解析为本地绝对路径。
 *
 * - upload: 用户上传的本机文件，直接可用
 * - record: 录音哼唱产物（acestep_stop_recording 落盘的 wav），直接可用
 * - favorite: 在线收藏（localPath 兜底重下）或社区喜欢（shareId → 下载解密）
 * - library: 我的作品（.a00m → 解包取音频）
 *
 * 结果按 key 缓存（内存），避免重复解包/下载；调用方可在来源变化时清缓存。
 */

import { createLogger } from '@/shared/utils/logger';
import { api } from '@/infrastructure/api';
import { convertFileSrc } from '@tauri-apps/api/core';
import { aceStepService } from '../services/AceStepService';
import { shareService } from '../services/ShareService';
import type { SongEntry } from '../types';
import type { OnlineSong, } from '@/tools/music-source/types';
import { songKey } from '@/tools/music-source/types';

const log = createLogger('ResolveSourceAudio');

export type AudioSourceOrigin = 'upload' | 'record' | 'favorite' | 'library';

export interface AudioSource {
  /** 本地绝对路径（引擎可直接消费；后端会自动归一化为 48kHz 立体声）。 */
  path: string;
  /** 展示名（文件名或歌曲名）。 */
  name: string;
  origin: AudioSourceOrigin;
  /** 时长（秒；0 = 未知）。 */
  durationSeconds: number;
}

/** 选择器条目：解析前（pending）的轻量描述。 */
export interface PendingSource {
  key: string;
  name: string;
  origin: AudioSourceOrigin;
  /** 已知时长（作品/分享有条目元数据；收藏/上传可能未知）。 */
  durationSeconds?: number;
  /** favorite 专用：在线收藏条目。 */
  song?: OnlineSong;
  /** favorite 专用：社区喜欢 shareId。 */
  shareId?: string;
  /** library 专用：曲库条目。 */
  entry?: SongEntry;
  /** 直接可用的本地路径（upload/record）。 */
  localPath?: string;
}

interface CacheEntry {
  path: string;
  resolvedAt: number;
}

const cache = new Map<string, CacheEntry>();

export function clearSourceCache(): void {
  cache.clear();
}

function cached(key: string): string | null {
  return cache.get(key)?.path ?? null;
}

/** Resolve a pending source to a concrete local file. Throws on failure. */
export async function resolveSource(pending: PendingSource): Promise<AudioSource> {
  const hit = cached(pending.key);
  if (hit && (await fileExists(hit))) {
    return {
      path: hit,
      name: pending.name,
      origin: pending.origin,
      durationSeconds: pending.durationSeconds ?? 0,
    };
  }

  let path: string;
  switch (pending.origin) {
    case 'upload':
    case 'record': {
      if (!pending.localPath) throw new Error('SOURCE_MISSING_PATH');
      path = pending.localPath;
      break;
    }
    case 'favorite': {
      path = await resolveFavorite(pending);
      break;
    }
    case 'library': {
      path = await resolveLibraryEntry(pending);
      break;
    }
    default:
      throw new Error('SOURCE_UNKNOWN_ORIGIN');
  }
  cache.set(pending.key, { path, resolvedAt: Date.now() });
  return {
    path,
    name: pending.name,
    origin: pending.origin,
    durationSeconds: pending.durationSeconds ?? 0,
  };
}

/** 收藏解析：localPath → favorites 持久目录 → 播放缓存，三级兜底。 */
async function resolveFavorite(pending: PendingSource): Promise<string> {
  const song = pending.song;
  if (song) {
    if (song.localPath && (await fileExists(song.localPath))) {
      return song.localPath;
    }
    // 缓存键必须与 favoritesStore/playerStore 一致（songKey 过滤安全字符）。
    // 注意不能用 pending.key（带 fav: 前缀），否则永远命中不了已有缓存。
    const cacheKey = songKey(song).replace(/[^a-zA-Z0-9_-]/g, '_');
    const download = (persist: boolean): Promise<string> =>
      api.invoke<string>('musicfree_download_media', {
        url: song.downloadUrl,
        key: cacheKey,
        headers: song.dlHeaders ?? {},
        persist,
      });
    try {
      // 1) favorites/ 持久目录（已有秒回；直链仍有效则顺带补落盘）
      return await download(true);
    } catch (e) {
      log.warn(`favorites persist resolve failed, try play cache: ${pending.key} (${String(e)})`);
    }
    // 2) 播放缓存兜底（.cache/musicfree/，听过的歌基本都有，直链过期也能命中）
    return download(false);
  }
  if (pending.shareId) {
    const result = await shareService.downloadAndDecrypt(pending.shareId);
    return result.audioPath;
  }
  throw new Error('SOURCE_MISSING_DATA');
}

/** 我的作品解析：解包 .a00m 取音频（缓存目录由后端决定，重复解包幂等）。 */
async function resolveLibraryEntry(pending: PendingSource): Promise<string> {
  const entry = pending.entry;
  if (!entry?.path) throw new Error('SOURCE_MISSING_DATA');
  const unpacked = await aceStepService.unpackSong(entry.path, null);
  if (!unpacked.audioPath) throw new Error('SOURCE_NO_AUDIO');
  return unpacked.audioPath;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const { exists } = await import('@tauri-apps/plugin-fs');
    return await exists(path);
  } catch {
    return false;
  }
}

/**
 * 用 <audio> 探测本地音频时长（metadata 级，不解码全部数据）。
 * 失败返回 0（调用方按未知时长处理）。
 */
export function probeAudioDuration(path: string): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement('audio');
    let settled = false;
    const done = (value: number): void => {
      if (settled) return;
      settled = true;
      el.src = '';
      resolve(value);
    };
    const onMeta = (): void => {
      done(Number.isFinite(el.duration) ? el.duration : 0);
    };
    const onError = (): void => {
      log.warn(`probeAudioDuration failed: ${path}`);
      done(0);
    };
    el.preload = 'metadata';
    // once: 两个事件互斥到达，无需交叉移除监听
    el.addEventListener('loadedmetadata', onMeta, { once: true });
    el.addEventListener('error', onError, { once: true });
    el.src = convertFileSrc(path);
  });
}

/** 规范化展示名：去掉扩展名与路径。 */
export function displayNameOfPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[a-zA-Z0-9]{1,5}$/, '');
}
