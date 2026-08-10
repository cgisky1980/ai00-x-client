/**
 * PlayerBridge — AceStep 窗口与主窗口之间的播放器状态桥接。
 *
 * 职责：
 *   1. 订阅 playerStore 变化，通过 Tauri Event 同步到主窗口
 *   2. 监听主窗口发来的播放控制命令，转发给 playerStore
 *   3. 心跳机制：每 1s 发送一次完整状态（仅当有歌曲时）
 *
 * 事件：
 *   - `acestep://player-state`   AceStep → Main（状态同步）
 *   - `acestep://player-command` Main → AceStep（控制命令）
 *   - `acestep://lyrics-state`   AceStep → Main（歌词状态）
 */

import { emit, listen } from '@tauri-apps/api/event';
import { usePlayerStore } from '../store/playerStore';
import type { PlayMode } from '../store/playerStore';
import type { SongEntry } from '../types';

// ---- Event names ----
const EVENT_PLAYER_STATE = 'acestep://player-state';
const EVENT_PLAYER_COMMAND = 'acestep://player-command';
const EVENT_LYRICS_STATE = 'acestep://lyrics-state';

// ---- State schema (AceStep → Main) ----
export interface AceStepPlayerState {
  currentSong: {
    title: string;
    artist: string;
    durationSeconds: number;
  } | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  playMode: PlayMode;
  playlistLength: number;
  playlistIndex: number;
  p2pStatus: 'connecting' | 'downloading' | 'seeding' | 'error' | null;
  p2pPeerCount: number;
  /** 最近一次播放/下载失败的错误信息（null 表示无错）。用于主窗口（MusicPopup）展示调试信息。 */
  error: string | null;
  /** 当前正在 P2P 下载的 share_id（null 表示无下载任务）。 */
  p2pDownloadingShareId: string | null;
  /** P2P 下载进度（0-1）。无下载任务时为 null。 */
  p2pDownloadPercent: number | null;
  source: 'local' | 'share';
  showLyrics: boolean;
  /** Absolute path to the unpacked cover image (null when no cover). */
  coverPath: string | null;
  /** 当前正在播放的分享 ID（source === 'share' 时有效，否则 null）。 */
  currentShareId: string | null;
  /** 当前正在播放的歌曲绝对路径（null 表示无播放）。用于本地作品组高亮。 */
  currentEntryPath: string | null;
}

// ---- Command schema (Main → AceStep) ----
export interface AceStepPlayerCommand {
  action:
    | 'togglePlay'
    | 'next'
    | 'prev'
    | 'seek'
    | 'setVolume'
    | 'togglePlayMode'
    | 'toggleLyrics'
    | 'playSong'
    | 'playShare';
  payload?: { time?: number; volume?: number; entry?: SongEntry; shareId?: string };
}

// ---- Lyrics state schema (AceStep → Main) ----
export interface AceStepLyricsState {
  lrcText: string | null;
  currentTime: number;
  title: string | null;
  showLyrics: boolean;
}

// ---- Module state ----
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let unlistenCommand: (() => void) | null = null;
let unlistenBgmRelease: (() => void) | null = null;
let lastEmittedState: string | null = null;

// ---- BgmPlayer 仲裁事件 ----
// 主窗口通过此事件通知 AceStep 释放 BGM 源（关闭/切换源时）
const EVENT_BGM_RELEASE = 'bgm://release';

/**
 * Serialize the current playerStore state into the bridge state schema.
 */
function serializeState(): AceStepPlayerState {
  const s = usePlayerStore.getState();
  return {
    currentSong: s.currentSong
      ? {
          title: s.currentSong.title,
          artist: s.currentSong.artist,
          durationSeconds: s.currentSong.durationSeconds,
        }
      : null,
    isPlaying: s.isPlaying,
    currentTime: s.currentTime,
    duration: s.duration,
    volume: s.volume,
    playMode: s.playMode,
    playlistLength: s.playlist.length,
    playlistIndex: s.currentIndex,
    p2pStatus: s.p2pStatus === 'idle' ? null : s.p2pStatus,
    p2pPeerCount: s.p2pPeerCount,
    error: s.error,
    p2pDownloadingShareId: s.p2pDownloadingShareId,
    p2pDownloadPercent: s.p2pDownloadingShareId ? s.p2pProgress : null,
    source: s.currentShareId ? 'share' : 'local',
    showLyrics: s.showLyricsPanel,
    coverPath: s.coverPath,
    currentShareId: s.currentShareId,
    currentEntryPath: s.currentEntry?.path ?? null,
  };
}

/**
 * Emit state to main window if changed since last emit.
 */
function emitStateIfChanged(force = false): void {
  const state = serializeState();
  const json = JSON.stringify(state);
  if (force || json !== lastEmittedState) {
    lastEmittedState = json;
    emit(EVENT_PLAYER_STATE, state).catch((e) =>
      console.warn('[PlayerBridge] emit player-state failed:', e),
    );
  }
}

/**
 * Emit lyrics state to main window.
 *
 * `currentTime` from playerStore is the raw decoder position (Rust returns
 * `position_secs` without any latency compensation). The audible position
 * lags behind by the output buffer latency; `LyricsOverlay` applies a
 * user-adjustable offset (`lyricsOffset`, default 2.5s) for lyric sync.
 */
function emitLyricsState(): void {
  const s = usePlayerStore.getState();
  const state: AceStepLyricsState = {
    lrcText: s.lrcText,
    currentTime: s.currentTime,
    title: s.currentSong?.title ?? null,
    showLyrics: s.showLyricsPanel,
  };
  emit(EVENT_LYRICS_STATE, state).catch((e) =>
    console.warn('[PlayerBridge] emit lyrics-state failed:', e),
  );
}

/**
 * Handle a command from the main window.
 */
function handleCommand(cmd: AceStepPlayerCommand): void {
  const store = usePlayerStore.getState();
  switch (cmd.action) {
    case 'togglePlay':
      store.togglePlay();
      break;
    case 'next':
      void store.playNext(false);
      break;
    case 'prev':
      void store.playPrev();
      break;
    case 'seek':
      if (cmd.payload?.time !== undefined) {
        store.seek(cmd.payload.time);
      }
      break;
    case 'setVolume':
      if (cmd.payload?.volume !== undefined) {
        store.setVolume(cmd.payload.volume);
      }
      break;
    case 'togglePlayMode':
      store.togglePlayMode();
      break;
    case 'toggleLyrics':
      store.toggleLyrics();
      break;
    case 'playSong':
      if (cmd.payload?.entry) {
        void store.playSong(cmd.payload.entry);
      }
      break;
    case 'playShare':
      if (cmd.payload?.shareId) {
        void store.playShare(cmd.payload.shareId);
      }
      break;
  }
}

/**
 * Start the PlayerBridge. Call once at AceStep workspace mount.
 *
 * Sets up:
 *   1. playerStore subscription → emit state changes
 *   2. listen for commands from main window
 *   3. heartbeat timer (1s)
 */
export function startPlayerBridge(): () => void {
  // 1. Subscribe to playerStore changes
  const unsubscribeStore = usePlayerStore.subscribe((state, prevState) => {
    // Emit on any meaningful change
    const meaningfulChange =
      state.currentSong !== prevState.currentSong ||
      state.isPlaying !== prevState.isPlaying ||
      state.currentTime !== prevState.currentTime ||
      state.duration !== prevState.duration ||
      state.volume !== prevState.volume ||
      state.playMode !== prevState.playMode ||
      state.playlist.length !== prevState.playlist.length ||
      state.currentIndex !== prevState.currentIndex ||
      state.p2pStatus !== prevState.p2pStatus ||
      state.p2pPeerCount !== prevState.p2pPeerCount ||
      state.error !== prevState.error ||
      state.p2pDownloadingShareId !== prevState.p2pDownloadingShareId ||
      state.p2pProgress !== prevState.p2pProgress ||
      state.showLyricsPanel !== prevState.showLyricsPanel;

    if (meaningfulChange) {
      emitStateIfChanged();
    }

    // Emit lyrics state when lyrics-related fields change
    const lyricsChange =
      state.lrcText !== prevState.lrcText ||
      state.currentTime !== prevState.currentTime ||
      state.showLyricsPanel !== prevState.showLyricsPanel ||
      state.currentSong !== prevState.currentSong;

    if (lyricsChange) {
      emitLyricsState();
    }
  });

  // 2. Listen for commands from main window
  listen<AceStepPlayerCommand>(EVENT_PLAYER_COMMAND, (event) => {
    handleCommand(event.payload);
  }).then((unlisten) => {
    unlistenCommand = unlisten;
  });

  // 2b. Listen for BGM release events (主窗口切换/关闭 AceStep 源时通知)
  // 不直接 closePlayer（避免影响 UI），仅暂停播放，让主窗口管理 activeSource 状态
  listen<{ source: string }>(EVENT_BGM_RELEASE, (event) => {
    if (event.payload.source === 'acestep') {
      const store = usePlayerStore.getState();
      // 仅暂停播放（不 closePlayer），让用户可恢复
      if (store.playbackState === 'playing') {
        store.togglePlay();
      }
    }
  }).then((unlisten) => {
    unlistenBgmRelease = unlisten;
  });

  // 3. Heartbeat: emit full state every 1s (always, even without a song,
  //    so the main window knows AceStep is alive and can show the song list).
  //    Also emit lyrics state so currentTime stays fresh for the overlay.
  heartbeatTimer = setInterval(() => {
    emitStateIfChanged(true); // force emit for heartbeat
    emitLyricsState();
  }, 1000);

  // Return cleanup function
  return () => {
    unsubscribeStore();
    if (unlistenCommand) {
      unlistenCommand();
      unlistenCommand = null;
    }
    if (unlistenBgmRelease) {
      unlistenBgmRelease();
      unlistenBgmRelease = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    lastEmittedState = null;
  };
}
