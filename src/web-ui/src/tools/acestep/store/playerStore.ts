/**
 * Player store — Zustand store for the .a00m player.
 *
 * Holds the currently-playing song's metadata, audio/cover/lrc paths, and
 * transport state (play/pause/seek/volume). The store is intentionally kept
 * separate from `acestepStore.ts` (which manages creation sessions) so that
 * playback persists across view switches (chatCreate <-> library) without
 * being tied to a specific session.
 *
 * The `<audio>` element lives inside the headless `PlayerEngine` component,
 * which calls back into the store on `onPlay` / `onPause` / `onTimeUpdate` /
 * `onLoadedMetadata`. The store is the single source of truth for
 * `isPlaying` / `currentTime` / `duration`; `PlayerBridge` syncs it to the
 * main window (MusicActivity / LyricsOverlay) via Tauri events.
 */

import { create } from 'zustand';
import { convertFileSrc } from '@tauri-apps/api/core';
import { aceStepService } from '../services/AceStepService';
import { shareService } from '../services/ShareService';
import { p2pClient } from '../services/P2PClient';
import { audioPlaybackApi } from '../../vrm/lib/audioPlaybackApi';
import type { P2PStatus, P2pProgress } from '../services/P2PClient';
import type { SharedSongListItem, ShareMeta } from '../services/ShareService';
import type { SongEntry, SongMeta } from '../types';
import { recordPlaySignal, parseSongTags } from './profileStore';

/** 播放模式 */
export type PlayMode = 'sequential' | 'repeat-one' | 'repeat-all' | 'shuffle';

/**
 * 播放状态机 — 显式状态取代模糊的 isPlaying: boolean。
 *
 * States:
 *   idle    — 无歌曲加载
 *   loading — 正在解包/加载
 *   playing — 正在播放
 *   paused  — 用户暂停，位置保留
 *   ended   — 歌曲播放结束，位置在末尾
 *
 * Key transitions:
 *   playing → paused   : 用户 togglePlay
 *   paused  → playing  : 用户 togglePlay（恢复）
 *   playing → ended    : PlayerEngine 检测到 channel Stopped
 *   ended   → playing  : 用户 togglePlay（从头重播）
 *   ended   → loading  : playNext 加载下一首
 */
export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended';

/** 播放列表条目：本地 SongEntry 或远端 shareId */
export type PlaylistItem =
  | { kind: 'local'; entry: SongEntry }
  | { kind: 'share'; shareId: string; meta?: SharedSongListItem };

/**
 * Derive the cache directory for a .a00m file.
 *
 * Cache layout: `{songs_dir}/.cache/{filename-without-extension}/`. The
 * unpacked FLAC, LRC, and cover image live inside this directory.
 */
function cacheDirFor(songsDir: string, entryPath: string): string {
  const filename = entryPath.split(/[\\/]/).pop() ?? '';
  const stem = filename.replace(/\.a00m$/i, '');
  // Replace any path separators in the stem with underscores to avoid
  // creating nested directories.
  const safeStem = stem.replace(/[\\/]/g, '_');
  return `${songsDir}/.cache/${safeStem}`;
}

/**
 * Detect whether the code is running inside Tauri (dev or production).
 * Tauri injects `window.__TAURI__` in both environments.
 */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/**
 * Build a SongMeta from a ShareMeta for player display.
 *
 * Share meta lacks some fields (audio details, creation context) — fill with
 * sensible defaults so the player bar can render without null checks.
 */
function buildSongMetaFromShare(shareId: string, meta: ShareMeta): SongMeta {
  return {
    title: meta.title,
    artist: meta.artistName ?? '',
    album: meta.album ?? '',
    genre: meta.genre ?? '',
    durationSeconds: meta.durationSeconds,
    createdAt: Date.parse(meta.createdAt) || Date.now(),
    formatVersion: 'v5.1',
    audio: {
      filename: `${shareId}.flac`,
      format: 'flac',
      sampleRate: 44100,
      channels: 2,
      bitsPerSample: 16,
      durationSeconds: meta.durationSeconds,
    },
    creation: {
      mode: 'text2music',
      hasPlan: false,
      hasLegoState: false,
      hasChat: false,
    },
  };
}

/**
 * Read a local text file via the Tauri asset protocol. Returns null if the
 * fetch fails (e.g. file does not exist or browser dev environment).
 */
async function readLocalTextFile(filePath: string): Promise<string | null> {
  if (!isTauriEnv()) return null;
  try {
    const url = convertFileSrc(filePath);
    const resp = await fetch(url);
    if (!resp.ok) {
      return null;
    }
    return await resp.text();
  } catch (_e) {
    return null;
  }
}

export interface PlayerStoreState {
  // ---- Currently loaded song ----
  /** The SongEntry currently loaded into the player (null when no song). */
  currentEntry: SongEntry | null;
  /** Parsed song.json metadata for the current song. */
  currentSong: SongMeta | null;
  /** Absolute path to the unpacked FLAC file (for convertFileSrc). */
  audioPath: string | null;
  /** Rust AudioMixer channel ID for the current playback (null when idle). */
  channelId: number | null;
  /** Absolute path to the unpacked cover image (null when no cover). */
  coverPath: string | null;
  /** LRC text content (null when no lyrics). */
  lrcText: string | null;

  // ---- Transport state ----
  isPlaying: boolean;
  /** 显式播放状态（isPlaying = playbackState === 'playing'） */
  playbackState: PlaybackState;
  currentTime: number;
  duration: number;
  volume: number;

  // ---- UI state ----
  /** When non-null, the lyrics side panel is shown. */
  showLyricsPanel: boolean;
  /** Path of the file currently being unpacked (shows loading state). */
  unpackingPath: string | null;
  /** Last error message (null when no error). */
  error: string | null;
  /**
   * Stage 5.13: 当前通过 P2P 下载的 share_id（用于 destroyP2P 取消下载）。
   * 仅 P2P 路径设置；HTTP 路径或未播放时为 null。
   */
  currentP2PShareId: string | null;
  /**
   * 当前正在播放的分享 ID。分享播放（playShare）时设为 shareId；
   * 本地作品播放（playSong）或关闭时为 null。用于区分"分享播放"与
   * "本地 .a00m 作品播放"，避免列表高亮误判。
   */
  currentShareId: string | null;

  // ---- Playlist state ----
  /** 当前播放列表（空表示无列表，仅单首播放） */
  playlist: PlaylistItem[];
  /** 当前播放条目在 playlist 中的索引（-1 表示不在列表中） */
  currentIndex: number;
  /** 播放模式 */
  playMode: PlayMode;
  /** 随机模式下的历史记录（用于"回到上一首"） */
  shuffleHistory: number[];

  // ---- P2P state (share playback only) ----
  /** 当前 P2P 下载状态（null 表示非 share 播放或已清理） */
  p2pStatus: P2PStatus | null;
  /** 当前 P2P 连接的 peer 数量 */
  p2pPeerCount: number;
  /** P2P 下载进度（0-1） */
  p2pProgress: number;
  /** 当前正在 P2P 下载的 share_id（null 表示无下载任务）。用于卡片/底部显示进度。 */
  p2pDownloadingShareId: string | null;

  // ---- Actions ----
  /** Start playing a song from a library entry. Rust auto-detects encryption
   * and tries the fixed version passwords from the embedded table — no
   * password prompt is needed on the frontend.
   */
  playSong: (entry: SongEntry) => Promise<void>;
  /**
   * Download and play a shared song. Calls `share_download_and_decrypt` to
   * fetch the .a00m file and decrypt it to a single audio.flac, then loads
   * it into the player.
   *
   * @param shareId 分享 ID
   * @param songTags 歌曲标签数组（可选，用于画像信号采集；从 SharedSongListItem.tags 解析）
   */
  playShare: (shareId: string, songTags?: string[]) => Promise<void>;
  /** Toggle play/pause. The audio element calls `setPlaying` on actual state
   * changes; this method triggers the element via a store-side flag. */
  togglePlay: () => void;
  /** Seek to a specific time (seconds). The audio element reads this. */
  seek: (time: number) => void;
  /** Set volume (0-1). Persisted for the session. */
  setVolume: (v: number) => void;
  /** Called by the audio element on timeupdate. */
  setCurrentTime: (t: number) => void;
  /** Called by the audio element on loadedmetadata. */
  setDuration: (d: number) => void;
  /** Called by the audio element on play/pause events. */
  setPlaying: (playing: boolean) => void;
  /** Called by PlayerEngine when the channel reaches the end (state → Stopped). */
  setEnded: () => void;
  /** 设置播放列表并从指定索引开始播放 */
  setPlaylist: (items: PlaylistItem[], startIndex?: number) => Promise<void>;
  /** 设置分享列表并从指定索引开始播放 */
  setSharePlaylist: (shares: SharedSongListItem[], startIndex?: number) => Promise<void>;
  /** 播放下一首（根据 playMode）；auto=true 表示自动触发（onEnded），false 表示用户手动 */
  playNext: (auto?: boolean) => Promise<void>;
  /** 播放上一首（shuffle 模式从 shuffleHistory 弹出） */
  playPrev: () => Promise<void>;
  /** 切换播放模式：sequential → repeat-all → repeat-one → shuffle → sequential */
  togglePlayMode: () => void;
  /** 跳转到列表中指定索引 */
  jumpTo: (index: number) => Promise<void>;
  /** 追加到列表末尾（不切换当前播放） */
  appendToPlaylist: (items: PlaylistItem[]) => void;
  /** 清空播放列表（不停止当前播放） */
  clearPlaylist: () => void;
  /**
   * Destroy the P2P service instance (cleans up WebTorrent client, revokes
   * blob URL, clears p2p* state). Called on song switch and closePlayer.
   */
  destroyP2P: () => void;
  /** Stop playback and clear the loaded song. */
  closePlayer: () => void;
  /** Toggle the lyrics side panel visibility. */
  toggleLyrics: () => void;
  /** Clear the last error message. */
  clearError: () => void;
}

/**
 * Internal seek counter — incremented on each `seek()` call. The audio
 * element subscribes to this via a useEffect on `seekCounter` (returned by a
 * separate selector) and sets `audio.currentTime` accordingly.
 *
 * Using a counter instead of storing the seek time directly avoids redundant
 * seeks when `currentTime` updates from `onTimeUpdate` (which would otherwise
 * create a feedback loop).
 */
let seekCounter = 0;
let lastSeekTime = 0;

// ============================================================================
// Profile signal collection tracking (v1.3.0+ 个性化推荐)
// ============================================================================
//
// 模块级跟踪当前 share 播放的起始时间和元数据，用于在切换/关闭/结束时
// 计算 actualPlayDurationSec 并调用 profileStore.recordPlaySignal。
//
// 仅对 kind === 'share' 的播放采集信号（本地歌曲不参与服务端推荐）。

interface PlaybackTrack {
  /** 当前播放的 share_id */
  shareId: string;
  /** 歌曲标签（已从 JSON 字符串解析，可能为空数组） */
  tags: string[];
  /** 播放开始时间（ms timestamp） */
  startTime: number;
  /** 歌曲总时长（秒，用于完整播放判断） */
  songDurationSec: number;
}

let currentPlaybackTrack: PlaybackTrack | null = null;

/**
 * 刷新（记录）当前 share 播放信号到 profileStore。
 *
 * 调用时机：
 * - playShare 开始前（刷新上一首的信号）
 * - playNext / playPrev 切换前（刷新当前首的信号）
 * - closePlayer 关闭前（刷新当前首的信号）
 * - setEnded 自然播放结束（标记为完整播放）
 *
 * @param forceCompleted true = 强制标记为完整播放（用于 setEnded）
 */
function flushPlaySignal(forceCompleted = false): void {
  if (!currentPlaybackTrack) return;
  const elapsedSec = (Date.now() - currentPlaybackTrack.startTime) / 1000;
  // 自然结束 → 用歌曲总时长；否则用实际经过时间
  const durationSec = forceCompleted ? currentPlaybackTrack.songDurationSec : elapsedSec;
  recordPlaySignal(
    currentPlaybackTrack.shareId,
    durationSec,
    currentPlaybackTrack.songDurationSec,
    currentPlaybackTrack.tags,
  );
  currentPlaybackTrack = null;
}

export const usePlayerStore = create<PlayerStoreState>((set, get) => ({
  currentEntry: null,
  currentSong: null,
  audioPath: null,
  channelId: null,
  coverPath: null,
  lrcText: null,

  isPlaying: false,
  playbackState: 'idle' as PlaybackState,
  currentTime: 0,
  duration: 0,
  volume: 0.8,

  showLyricsPanel: false,
  unpackingPath: null,
  error: null,
  currentP2PShareId: null,
  currentShareId: null,

  playlist: [],
  currentIndex: -1,
  playMode: 'sequential',
  shuffleHistory: [],

  p2pStatus: null,
  p2pPeerCount: 0,
  p2pProgress: 0,
  p2pDownloadingShareId: null,

  playSong: async (entry) => {
    // v1.3.0+: Flush current share's play signal before switching to local.
    flushPlaySignal();

    const state = get();
    // If the same song is already loaded:
    if (state.currentEntry?.path === entry.path && state.audioPath) {
      if (state.playbackState === 'playing') {
        // Already playing — no action needed.
        return;
      }
      if (state.playbackState === 'paused' && state.channelId !== null) {
        // Paused — resume from current position.
        audioPlaybackApi.audioResumeChannel(state.channelId).catch(() => {});
        set({ playbackState: 'playing', isPlaying: true, error: null });
        return;
      }
      // ended or idle — fall through to reload.
    }

    // Clean up any previous P2P session (share → local switch).
    get().destroyP2P();

    // Load directly — Rust auto-detects encryption and tries fixed version
    // passwords from the embedded password table (passwords.rs).
    try {
      await loadAndPlay(entry, set, get);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ error: msg, unpackingPath: null });
    }
  },

  playShare: async (shareId, songTags) => {
    // Flush previous share's play signal before starting new playback.
    // (Direct playShare calls; playItem already flushes before calling.)
    flushPlaySignal();

    // Clean up any previous P2P session (share → share switch).
    get().destroyP2P();

    // Reuse unpackingPath to signal "loading" to the UI.
    set({ unpackingPath: shareId, error: null });

    // Stage 5.13: P2P 优先路径（v9 重构）
    //
    // 1. 取 meta 拿 magnetLink
    // 2. magnetLink 存在 → 走 P2P（fx-torrent BT 下载，省服务器流量）
    //    P2P 失败时回退 HTTP（保证可用性，仅此场景允许 HTTP 兜底）
    // 3. magnetLink 为空 → 直接走 HTTP（非 webtorrent 后端）
    let audioPath: string;
    let meta: ShareMeta;
    let lyricsPath: string | null = null;

    try {
      meta = await shareService.getMeta(shareId);
    } catch (e) {
      set({ unpackingPath: null });
      const msg = e instanceof Error ? e.message : String(e);
      set({ error: `Failed to load share meta: ${msg}` });
      return;
    }

    const usedP2P = !!meta.magnetLink;
    if (usedP2P) {
      set({ p2pStatus: 'connecting' });
      startP2pPoll(shareId);
      try {
        const result = await p2pClient.downloadShare({
          shareId,
          magnetLink: meta.magnetLink!,
          // P2P 下载的是完整加密 .a00m（留档做种），需本地解包才能播放。
          filename: `${shareId}.a00m`,
        });
        // P2P 下载完成后本地离线解密：与本地作品 / HTTP 路径一致的解包逻辑，
        // 一次性拿到可播放音频 + 歌词（覆盖即播放，无需再开 HTTP 补下）。
        try {
          const ext = await shareService.extractLocal(shareId, result.filePath);
          audioPath = ext.audioPath;
          lyricsPath = ext.lyricsPath;
        } catch (extErr) {
          // P2P 拿到 .a00m 但本地解包失败（罕见）：HTTP 兜底下载 + 解密
          console.warn('[player] P2P extract failed, falling back to HTTP:', extErr);
          const downloaded = await shareService.downloadAndDecrypt(shareId);
          audioPath = downloaded.audioPath;
          lyricsPath = downloaded.lyricsPath;
          meta = downloaded.meta;
        }
        stopP2pPoll();
        set({
          p2pStatus: 'seeding',
          p2pDownloadingShareId: null,
          p2pProgress: 1,
          currentP2PShareId: shareId,
        });
      } catch (e) {
        // P2P 失败：回退 HTTP（保证可用性）
        console.warn('[player] P2P download failed, falling back to HTTP:', e);
        stopP2pPoll();
        set({ p2pStatus: 'error', p2pDownloadingShareId: null });
        try {
          const downloaded = await shareService.downloadAndDecrypt(shareId);
          audioPath = downloaded.audioPath;
          meta = downloaded.meta;
          lyricsPath = downloaded.lyricsPath;
        } catch (e2) {
          set({ unpackingPath: null, p2pStatus: null, p2pDownloadingShareId: null });
          const msg = e2 instanceof Error ? e2.message : String(e2);
          set({ error: `Failed to play share (P2P + HTTP both failed): ${msg}` });
          return;
        }
      }
    } else {
      // 无 magnetLink：直接 HTTP
      try {
        const downloaded = await shareService.downloadAndDecrypt(shareId);
        audioPath = downloaded.audioPath;
        meta = downloaded.meta;
        lyricsPath = downloaded.lyricsPath;
      } catch (e) {
        set({ unpackingPath: null });
        const msg = e instanceof Error ? e.message : String(e);
        set({ error: `Failed to play share: ${msg}` });
        return;
      }
    }

    const song = buildSongMetaFromShare(shareId, meta);
    // Stop any existing channel before starting the share playback.
    const prevChannelId = get().channelId;
    if (prevChannelId !== null) {
      try { await audioPlaybackApi.audioStopChannel(prevChannelId, 0); } catch { /* ignore */ }
    }

    const shareChannelId = await audioPlaybackApi.audioPlayBgm(
      audioPath, get().volume, 0, false,
    );

    // 歌词：P2P 与 HTTP 两路在下载阶段均已通过解包一次性提取（统一走 .a00m
    // 解密封装逻辑，与本地作品一致），这里直接读取即可，无需额外 HTTP 补下。
    let lrcText: string | null = null;
    if (lyricsPath) {
      lrcText = await readLocalTextFile(lyricsPath);
    }

    // 封面：由服务器提供，本地磁盘缓存（share_get_cover 返回本地路径）。
    let coverPath: string | null = null;
    try {
      coverPath = await shareService.getCoverPath(shareId);
    } catch {
      coverPath = null;
    }

    set({
      currentEntry: {
        path: audioPath,
        filename: `${shareId}.a00m`,
        fileSize: meta.fileSizeBytes,
        modifiedAt: Date.parse(meta.createdAt) || Date.now(),
        isEncrypted: false,
        meta: song,
      },
      currentSong: song,
      audioPath,
      channelId: shareChannelId,
      coverPath,
      lrcText,
      // 分享开始播放且本首有歌词时，自动拉起桌面歌词浮层（LyricsOverlay）。
      // 无歌词则保持关闭，避免展示空白的"暂无歌词"浮层。
      showLyricsPanel: lrcText ? true : false,
      isPlaying: true,
      playbackState: 'playing',
      currentTime: 0,
      duration: 0,
      unpackingPath: null,
      error: null,
      currentShareId: shareId,
    });

    // v1.3.0+: Set up profile signal tracking for this share playback.
    // songTags comes from the caller (playItem passes item.meta.tags;
    // direct playShare calls default to empty array — still records
    // playedHistory for exclusion, just no tag weight update).
    currentPlaybackTrack = {
      shareId,
      tags: songTags ?? [],
      startTime: Date.now(),
      songDurationSec: song.durationSeconds,
    };

    shareService
      .recordPlay(shareId, 'desktop')
      .catch((e) => console.warn('[player] recordPlay failed:', e));
  },

  togglePlay: () => {
    const { audioPath, channelId, playbackState } = get();
    if (!audioPath || channelId === null) return;

    switch (playbackState) {
      case 'playing':
        audioPlaybackApi.audioPauseChannel(channelId).catch(() => {});
        set({ playbackState: 'paused', isPlaying: false });
        break;
      case 'paused':
        // Resume from current position — Rust channel is still in PAUSED state.
        audioPlaybackApi.audioResumeChannel(channelId).catch(() => {});
        set({ playbackState: 'playing', isPlaying: true, error: null });
        break;
      case 'ended':
        // Replay from beginning — Rust play() resets play_pos to 0 when
        // the channel was STATE_STOPPED. Also seek(0) as a belt-and-suspenders
        // measure and reset currentTime so the UI is immediately in sync.
        audioPlaybackApi.audioSeekChannel(channelId, 0).catch(() => {});
        audioPlaybackApi.audioResumeChannel(channelId).catch(() => {});
        set({ playbackState: 'playing', isPlaying: true, currentTime: 0, error: null });
        break;
      // idle / loading — no-op
    }
  },

  seek: (time) => {
    const { channelId, playbackState } = get();
    if (channelId !== null) {
      audioPlaybackApi.audioSeekChannel(channelId, time).catch(() => {});
    }
    lastSeekTime = time;
    seekCounter += 1;
    // If the song had ended, seeking transitions back to paused (user can
    // then press play to resume from the seek position).
    set({
      currentTime: time,
      ...(playbackState === 'ended' ? { playbackState: 'paused' as PlaybackState, isPlaying: false } : {}),
    } as Partial<PlayerStoreState>);
  },

  setVolume: (v) => {
    const vol = Math.max(0, Math.min(1, v));
    const { channelId } = get();
    if (channelId !== null) {
      audioPlaybackApi.audioSetChannelVolume(channelId, vol).catch(() => {});
    }
    set({ volume: vol });
  },

  setCurrentTime: (t) => set({ currentTime: t }),

  setDuration: (d) => set({ duration: d }),

  setPlaying: (playing) => set({
    isPlaying: playing,
    playbackState: playing ? 'playing' : 'paused',
  }),

  setEnded: () => {
    // v1.3.0+: Song ended naturally — record as complete play signal.
    // forceCompleted=true uses songDurationSec as the play duration.
    flushPlaySignal(true);
    set({ isPlaying: false, playbackState: 'ended' });
  },

  setPlaylist: async (items, startIndex = 0) => {
    if (items.length === 0) return;
    const idx = Math.max(0, Math.min(startIndex, items.length - 1));
    set({ playlist: items, currentIndex: idx, shuffleHistory: [] });
    await playItem(items[idx], get);
  },

  setSharePlaylist: async (shares, startIndex = 0) => {
    if (shares.length === 0) return;
    const items: PlaylistItem[] = shares.map((s) => ({
      kind: 'share' as const,
      shareId: s.shareId,
      meta: s,
    }));
    await get().setPlaylist(items, startIndex);
  },

  playNext: async (auto = false) => {
    // v1.3.0+: Flush current share's play signal before switching.
    // If auto=true (onEnded), setEnded already flushed; flushPlaySignal
    // is a no-op when currentPlaybackTrack is null.
    flushPlaySignal();

    const { playlist, currentIndex, playMode, shuffleHistory } = get();
    if (playlist.length === 0) return;

    if (playMode === 'repeat-one') {
      // 重播当前曲目：seek to 0 + ensure playing
      get().seek(0);
      set({ isPlaying: true, playbackState: 'playing' });
      return;
    }

    let nextIdx: number;
    if (playMode === 'shuffle') {
      const remaining = playlist
        .map((_, i) => i)
        .filter((i) => i !== currentIndex && !shuffleHistory.includes(i));
      if (remaining.length === 0) {
        if (auto) {
          set({ isPlaying: false, playbackState: 'ended' });
          return; // 全部播完，自动停止
        }
        // 手动 next：重新开始随机
        nextIdx = Math.floor(Math.random() * playlist.length);
      } else {
        nextIdx = remaining[Math.floor(Math.random() * remaining.length)];
      }
    } else {
      // sequential + repeat-all
      nextIdx = currentIndex + 1;
      if (nextIdx >= playlist.length) {
        if (playMode === 'sequential' && auto) {
          set({ isPlaying: false, playbackState: 'ended' });
          return; // 顺序播放到末尾，自动停止
        }
        nextIdx = 0; // repeat-all 或手动 next 回到第一首
      }
    }

    // 记录 shuffle 历史
    const newHistory =
      playMode === 'shuffle' ? [...shuffleHistory, currentIndex] : shuffleHistory;
    set({ currentIndex: nextIdx, shuffleHistory: newHistory });
    await playItem(playlist[nextIdx], get);
  },

  playPrev: async () => {
    // v1.3.0+: Flush current share's play signal before switching.
    flushPlaySignal();

    const { playlist, currentIndex, playMode, shuffleHistory } = get();
    if (playlist.length === 0) return;

    let prevIdx: number;
    if (playMode === 'shuffle' && shuffleHistory.length > 0) {
      prevIdx = shuffleHistory[shuffleHistory.length - 1];
      set({
        currentIndex: prevIdx,
        shuffleHistory: shuffleHistory.slice(0, -1),
      });
    } else {
      prevIdx = currentIndex - 1;
      if (prevIdx < 0) prevIdx = 0; // 到第一首就停住
      set({ currentIndex: prevIdx });
    }
    await playItem(playlist[prevIdx], get);
  },

  togglePlayMode: () => {
    const order: PlayMode[] = ['sequential', 'repeat-all', 'repeat-one', 'shuffle'];
    const current = get().playMode;
    const next = order[(order.indexOf(current) + 1) % order.length];
    set({ playMode: next, shuffleHistory: next === 'shuffle' ? [] : get().shuffleHistory });
  },

  jumpTo: async (index) => {
    const { playlist } = get();
    if (index < 0 || index >= playlist.length) return;
    set({ currentIndex: index });
    await playItem(playlist[index], get);
  },

  appendToPlaylist: (items) =>
    set((s) => ({ playlist: [...s.playlist, ...items] })),

  clearPlaylist: () => set({ playlist: [], currentIndex: -1, shuffleHistory: [] }),

  destroyP2P: () => {
    // Stage 5.13 + 长期做种（遇则弃）：切歌时仅清理瞬态 p2p* UI 状态，
    // **不调用 cancelDownload**——已下载的 .a00m 文件与 torrent 长期留存并
    // 持续做种，供其它 peer 上行；重播同一 share 时由后端复用快路径直接命中。
    // 若需手动停止做种/清理，另行调用 p2pClient.cancelDownload。
    stopP2pPoll();
    set({ p2pStatus: null, p2pPeerCount: 0, p2pProgress: 0, p2pDownloadingShareId: null, currentP2PShareId: null });
  },

  closePlayer: () => {
    // v1.3.0+: Flush current share's play signal before closing.
    flushPlaySignal();
    stopP2pPoll();

    // Stop the Rust AudioMixer channel if one is active.
    const { channelId } = get();
    if (channelId !== null) {
      audioPlaybackApi.audioStopChannel(channelId, 0).catch(() => {});
    }
    set({
      currentEntry: null,
      currentSong: null,
      audioPath: null,
      channelId: null,
      coverPath: null,
      lrcText: null,
      isPlaying: false,
      playbackState: 'idle',
      currentTime: 0,
      duration: 0,
      showLyricsPanel: false,
      unpackingPath: null,
      error: null,
      playlist: [],
      currentIndex: -1,
      shuffleHistory: [],
      p2pStatus: null,
      p2pPeerCount: 0,
      p2pProgress: 0,
      p2pDownloadingShareId: null,
      currentShareId: null,
    });
  },

  toggleLyrics: () =>
    set((s) => ({ showLyricsPanel: !s.showLyricsPanel })),

  clearError: () => set({ error: null }),
}));

// ============================================================================
// P2P 下载进度轮询（v9 全网热门下载进度）
// ============================================================================
//
// 播放触发 P2P 下载后，以 500ms 间隔轮询后端 `p2p_get_progress`，把实时
// 进度（百分比/节点数/状态）写入 store。下载结束（seeding/error）或后端已无
// 该任务（返回 null）时自动停止。
//
// 轮询运行在 AceStep 窗口内、与 UI 组件生命周期解耦；即使切到其它界面，
// PlayerBridge 心跳仍会把最新进度同步到主窗口，保证"切走再回来依然可见"。

let p2pPollTimer: ReturnType<typeof setInterval> | null = null;
let p2pPollingShareId: string | null = null;

/** 停止当前 P2P 进度轮询并复位（幂等）。 */
function stopP2pPoll(): void {
  if (p2pPollTimer) {
    clearInterval(p2pPollTimer);
    p2pPollTimer = null;
  }
  p2pPollingShareId = null;
}

/** 启动对指定 share 的 P2P 下载进度轮询。同一时间仅跟踪一个下载任务。 */
function startP2pPoll(shareId: string): void {
  stopP2pPoll();
  p2pPollingShareId = shareId;
  usePlayerStore.setState({ p2pDownloadingShareId: shareId, p2pProgress: 0 });

  const tick = async () => {
    if (p2pPollingShareId !== shareId) return; // 已被新下载任务覆盖
    let prog: P2pProgress | null = null;
    try {
      prog = await p2pClient.getProgress(shareId);
    } catch (e) {
      console.warn('[player] p2p progress poll failed:', e);
    }
    // 停止条件：后端任务结束（null / seeding / error / idle）
    if (
      !prog ||
      prog.status === 'seeding' ||
      prog.status === 'error' ||
      prog.status === 'idle'
    ) {
      stopP2pPoll();
      usePlayerStore.setState({
        p2pDownloadingShareId: null,
        p2pProgress: prog?.status === 'seeding' ? 1 : 0,
        p2pPeerCount: prog?.peerCount ?? 0,
        p2pStatus: prog ? prog.status : null,
      });
      return;
    }
    usePlayerStore.setState({
      p2pProgress: prog.percent,
      p2pPeerCount: prog.peerCount,
      p2pStatus: prog.status,
    });
  };

  // 立即刷新一次（拿到首帧进度），随后定期轮询。
  void tick();
  p2pPollTimer = setInterval(tick, 500);
}

// ---- Seek request accessor ----
// The audio element calls this in a useEffect to detect new seek requests.
// Returns the latest (counter, time) pair; the effect compares the counter
// to its previous value to decide whether to seek.

export interface SeekRequest {
  counter: number;
  time: number;
}

let lastSeenCounter = 0;

/**
 * Read the latest seek request and return true if it's new since the last
 * call to this function. The audio element calls this on every render and
 * applies `audio.currentTime = request.time` when it returns true.
 */
export function consumeSeekRequest(): SeekRequest | null {
  if (seekCounter !== lastSeenCounter) {
    lastSeenCounter = seekCounter;
    return { counter: seekCounter, time: lastSeekTime };
  }
  return null;
}

// ---- Internal helper: play a PlaylistItem via playSong/playShare ----

/**
 * 根据 PlaylistItem 调用对应的 playSong / playShare。
 * 用于 setPlaylist / playNext / playPrev / jumpTo 等列表操作。
 */
async function playItem(
  item: PlaylistItem,
  get: () => PlayerStoreState,
): Promise<void> {
  // v1.3.0+: Flush previous share's play signal before switching.
  // (Also handled in playNext/playPrev, but playItem is called from
  // setPlaylist/jumpTo too — defensive flush here covers all paths.)
  flushPlaySignal();

  if (item.kind === 'local') {
    await get().playSong(item.entry);
  } else {
    // Pass tags from SharedSongListItem.meta to playShare for profile
    // signal collection. Direct playShare callers (PlayerBridge) don't
    // have tags — they pass undefined, which defaults to [].
    const songTags = item.meta ? parseSongTags(item.meta.tags) : undefined;
    await get().playShare(item.shareId, songTags);
  }
}

// ---- Internal helper: load a song into the player ----

async function loadAndPlay(
  entry: SongEntry,
  set: (partial: Partial<PlayerStoreState>) => void,
  get: () => PlayerStoreState,
): Promise<void> {
  set({ unpackingPath: entry.path, error: null, playbackState: 'loading' });

  try {
    const songsDir = await aceStepService.getSongsDir();
    const cacheDir = cacheDirFor(songsDir, entry.path);

    // Unpack the archive to the cache directory. unpackSong is idempotent —
    // re-unpacking overwrites the existing cache, which is fine (and ensures
    // the cache is in sync if the archive was updated). Rust auto-detects
    // encryption and tries the fixed version passwords from passwords.rs.
    const unpacked = await aceStepService.unpackSong(entry.path, cacheDir);

    // Determine song metadata. Prefer the freshly-unpacked song.json (always
    // available, even for encrypted archives once decrypted). Fall back to
    // the entry's cached meta (for unencrypted archives, this is identical).
    const song: SongMeta = unpacked.song;

    // Read LRC text from the unpacked file.
    let lrcText: string | null = null;
    if (unpacked.lyricsPath) {
      lrcText = await readLocalTextFile(unpacked.lyricsPath);
    }

    // Compute cover path: {cacheDir}/{cover.filename} if the archive has a cover.
    let coverPath: string | null = null;
    if (song.cover?.filename) {
      coverPath = `${cacheDir}/${song.cover.filename}`;
    }

    // Stop any existing channel before starting a new one.
    const prevChannelId = get().channelId;
    if (prevChannelId !== null) {
      try { await audioPlaybackApi.audioStopChannel(prevChannelId, 0); } catch { /* ignore */ }
    }

    // Play through Rust AudioMixer — unified audio pipeline + spectrum.
    const vol = get().volume;
    const newChannelId = await audioPlaybackApi.audioPlayBgm(
      unpacked.audioPath, vol, 0, false, // no fade-in, no loop
    );

    // Reset transport state for the new song.
    set({
      currentEntry: entry,
      currentSong: song,
      audioPath: unpacked.audioPath,
      channelId: newChannelId,
      coverPath,
      lrcText,
      isPlaying: true,
      playbackState: 'playing',
      currentTime: 0,
      duration: 0,
      unpackingPath: null,
      error: null,
      currentShareId: null,
    });
  } catch (e) {
    set({ unpackingPath: null });
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg);
  }
}