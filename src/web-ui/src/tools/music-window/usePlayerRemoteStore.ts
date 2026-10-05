/**
 * usePlayerRemoteStore — 播放权威（常驻 overlay）的「乐」窗遥控镜像。
 *
 * 音乐窗口不再实例化 playerStore（权威随 AceStepPlaybackHost 常驻 overlay）。
 * 本 store 镜像 `acestep://player-state` 快照（含完整队列），动作经
 * `acestep://player-command` 发往权威端执行。窗口重开后 1s 心跳内自动
 * 恢复 UI 状态（正在播的歌/队列/进度）。
 */
import { create } from 'zustand';
import { emit, listen } from '@tauri-apps/api/event';
import type { AceStepPlayerCommand, AceStepPlayerState } from '../acestep/services/PlayerBridge';
import type { PlaylistItem } from '../acestep/store/playerStore';
import type { SongEntry } from '../acestep/types';
import type { OnlineSong } from '../music-source/types';

const EVENT_PLAYER_STATE = 'acestep://player-state';
const EVENT_PLAYER_COMMAND = 'acestep://player-command';

type SendPayload = AceStepPlayerCommand['payload'];

interface PlayerRemoteState extends AceStepPlayerState {
  connected: boolean;
  /** 当前队列下标（镜像 playlistIndex，命名与 playerStore 消费面一致） */
  currentIndex: number;
  send: (action: AceStepPlayerCommand['action'], payload?: SendPayload) => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  togglePlayMode: () => void;
  toggleLyrics: () => void;
  playSong: (entry: SongEntry) => void;
  playShare: (shareId: string) => void;
  playOnline: (song: OnlineSong) => void;
  setPlaylist: (items: PlaylistItem[], index?: number) => void;
  appendToPlaylist: (items: PlaylistItem[]) => void;
  removeFromPlaylist: (index: number) => void;
  clearPlaylist: () => void;
  queueJumpTo: (index: number) => void;
  closePlayer: () => void;
}

const initialState: AceStepPlayerState = {
  currentSong: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 0.8,
  playMode: 'sequential',
  playlistLength: 0,
  playlistIndex: -1,
  p2pStatus: null,
  p2pPeerCount: 0,
  error: null,
  p2pDownloadingShareId: null,
  p2pDownloadPercent: null,
  source: 'local',
  playbackState: 'idle',
  showLyrics: false,
  coverPath: null,
  currentShareId: null,
  currentOnlineId: null,
  currentEntryPath: null,
  playlist: [],
  unpackingPath: null,
  currentEntry: null,
};

const usePlayerRemoteStore = create<PlayerRemoteState>((_set, get) => ({
  ...initialState,
  connected: false,
  currentIndex: -1,

  send: (action, payload) => {
    void emit(EVENT_PLAYER_COMMAND, { action, payload } satisfies AceStepPlayerCommand).catch((e) =>
      console.warn('[PlayerRemote] emit command failed:', e),
    );
  },
  togglePlay: () => get().send('togglePlay'),
  seek: (time) => get().send('seek', { time }),
  setVolume: (volume) => get().send('setVolume', { volume }),
  togglePlayMode: () => get().send('togglePlayMode'),
  toggleLyrics: () => get().send('toggleLyrics'),
  playSong: (entry) => get().send('playSong', { entry }),
  playShare: (shareId) => get().send('playShare', { shareId }),
  playOnline: (song) => get().send('playOnline', { song }),
  setPlaylist: (items, index) => get().send('setPlaylist', { items, index }),
  appendToPlaylist: (items) => get().send('appendToPlaylist', { items }),
  removeFromPlaylist: (index) => get().send('removeFromPlaylist', { index }),
  clearPlaylist: () => get().send('clearPlaylist'),
  queueJumpTo: (index) => get().send('queueJumpTo', { index }),
  closePlayer: () => get().send('closePlayer'),
}));

let initStarted = false;

/** 挂载状态镜像监听（模块单例，幂等；MusicWindowPage 挂载时调用） */
export function ensurePlayerRemoteInit(): void {
  if (initStarted) return;
  initStarted = true;
  void listen<AceStepPlayerState>(EVENT_PLAYER_STATE, (event) => {
    usePlayerRemoteStore.setState({
      ...event.payload,
      currentIndex: event.payload.playlistIndex,
      connected: true,
    });
  });
  // 1s 心跳内自动来帧，无需显式请求快照
}

/** 主 hook：镜像状态 + 遥控动作 */
export function usePlayerRemote(): PlayerRemoteState {
  return usePlayerRemoteStore();
}

export { usePlayerRemoteStore };
export default usePlayerRemoteStore;
