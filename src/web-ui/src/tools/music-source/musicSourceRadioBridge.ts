/**
 * musicSourceRadioBridge — 歌曲电台会话权威端桥（常驻 overlay webview）。
 *
 * 电台会话（radioActive/池/当前曲）随播放权威（playerStore/PlayerEngine）驻留在
 * 常驻 overlay webview；音乐窗口（可关可开）只是遥控。本桥：
 *   1. 监听 `music-source://radio-command`（start/stop/skip/get-state）
 *   2. 电台状态变化时广播 `music-source://radio-state` 快照
 *   3. start 时在权威端补 requestActive('acestep') bgm 仲裁
 *
 * 窗口关闭期间电台照常自动连播（PlayerEngine 在同一常驻 webview 轮询推进）。
 */
import { emit, listen } from '@tauri-apps/api/event';
import { useMusicSourceStore } from './musicSourceStore';
import { usePlayerStore } from '../acestep/store/playerStore';
import { useBgmPlayerStore } from '../island/store/bgmPlayer';
import type { OnlineSong, OnlineTrack } from './types';

const EVENT_COMMAND = 'music-source://radio-command';
const EVENT_STATE = 'music-source://radio-state';

/** 电台状态快照 schema（权威端 → 遥控端） */
export interface MusicSourceRadioState {
  radioActive: boolean;
  radioCurrent: OnlineTrack | null;
  radioCurrentSong: OnlineSong | null;
  /** 一次性错误（start 失败原因 / 'radio-end' 池尽），遥控端 toast 后自行清除 */
  error?: string | null;
}

type RadioCommand =
  | { action: 'start' }
  | { action: 'stop' }
  | { action: 'skip' }
  | { action: 'get-state' };

function snapshotState(error: string | null = null): MusicSourceRadioState {
  const s = useMusicSourceStore.getState();
  return {
    radioActive: s.radioActive,
    radioCurrent: s.radioCurrent,
    radioCurrentSong: s.radioCurrentSong,
    error,
  };
}

function emitState(error: string | null = null): void {
  emit(EVENT_STATE, snapshotState(error)).catch(() => {});
}

let started = false;
let unlistenCommand: (() => void) | null = null;

/** 挂载电台权威端桥（幂等；由 AceStepPlaybackHost 在 overlay 调用） */
export function startMusicSourceRadioBridge(): () => void {
  if (started) return () => {};
  started = true;

  // 状态变化 → 广播快照
  const unsubscribe = useMusicSourceStore.subscribe((state, prev) => {
    if (
      state.radioActive !== prev.radioActive ||
      state.radioCurrent !== prev.radioCurrent ||
      state.radioCurrentSong !== prev.radioCurrentSong
    ) {
      emitState();
    }
  });

  void listen<RadioCommand>(EVENT_COMMAND, (event) => {
    const cmd = event.payload;
    const ms = useMusicSourceStore.getState();
    switch (cmd.action) {
      case 'start':
        void (async () => {
          await useBgmPlayerStore.getState().requestActive('acestep').catch(() => {});
          try {
            const song = await ms.startRadio();
            if (song) await usePlayerStore.getState().playOnline(song);
          } catch (e) {
            // 启动失败：带错误文本广播一次（radioActive 已被 startRadio 复位 false）
            emitState(e instanceof Error ? e.message : String(e));
          }
        })();
        break;
      case 'stop':
        ms.stopRadio();
        // 停电台同时停播放（否则当前歌继续响、状态与听觉不一致——旧 handleRadioToggle 行为）
        {
          const ps = usePlayerStore.getState();
          if (ps.isPlaying && ps.currentOnlineId) ps.togglePlay();
        }
        break;
      case 'skip':
        void (async () => {
          const song = await ms.radioNext();
          if (song) {
            await usePlayerStore.getState().playOnline(song);
          } else {
            emitState('radio-end');
          }
        })();
        break;
      case 'get-state':
        emitState();
        break;
    }
  }).then((fn) => {
    unlistenCommand = fn;
  });

  emitState(); // 首帧快照

  return () => {
    unsubscribe();
    unlistenCommand?.();
    unlistenCommand = null;
    started = false;
  };
}
