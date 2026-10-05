/**
 * useMusicSourceRadioRemote — 歌曲电台会话（权威在常驻 overlay）的「乐」窗遥控镜像。
 *
 * 镜像 `music-source://radio-state` 快照；start/stop/skip 经
 * `music-source://radio-command` 发往权威端。窗口重开后镜像自动恢复，
 * 电台播放中重开窗口 UI 直接回到播放态。
 */
import { create } from 'zustand';
import { emit, listen } from '@tauri-apps/api/event';
import type { MusicSourceRadioState } from '../music-source/musicSourceRadioBridge';
import type { OnlineSong, OnlineTrack } from '../music-source/types';

const EVENT_COMMAND = 'music-source://radio-command';
const EVENT_STATE = 'music-source://radio-state';

interface RadioRemoteState {
  radioActive: boolean;
  radioCurrent: OnlineTrack | null;
  radioCurrentSong: OnlineSong | null;
  /** 一次性错误（启动失败原因 / 'radio-end' 池尽）；消费方 toast 后调 clearError */
  error: string | null;
  connected: boolean;
  start: () => void;
  stop: () => void;
  skip: () => void;
  clearError: () => void;
}

const useMusicSourceRadioRemoteBase = create<RadioRemoteState>((set) => ({
  radioActive: false,
  radioCurrent: null,
  radioCurrentSong: null,
  error: null,
  connected: false,

  start: () => {
    set({ error: null });
    void emit(EVENT_COMMAND, { action: 'start' }).catch((e) =>
      console.warn('[RadioRemote] emit start failed:', e),
    );
  },
  stop: () => {
    void emit(EVENT_COMMAND, { action: 'stop' }).catch((e) =>
      console.warn('[RadioRemote] emit stop failed:', e),
    );
  },
  skip: () => {
    set({ error: null });
    void emit(EVENT_COMMAND, { action: 'skip' }).catch((e) =>
      console.warn('[RadioRemote] emit skip failed:', e),
    );
  },
  clearError: () => set({ error: null }),
}));

let initStarted = false;

/** 挂载电台镜像监听（模块单例，幂等；MusicWindowPage 挂载时调用） */
export function ensureMusicSourceRadioRemoteInit(): void {
  if (initStarted) return;
  initStarted = true;
  void listen<MusicSourceRadioState>(EVENT_STATE, (event) => {
    const p = event.payload;
    useMusicSourceRadioRemoteBase.setState({
      radioActive: p.radioActive,
      radioCurrent: p.radioCurrent,
      radioCurrentSong: p.radioCurrentSong,
      error: p.error ?? null,
      connected: true,
    });
  });
  // 主动要一帧快照：权威端可能早已在播放（重开窗口场景）
  void emit(EVENT_COMMAND, { action: 'get-state' }).catch(() => {});
}

/** 主 hook：电台镜像状态 + 遥控动作（支持 selector） */
export function useMusicSourceRadioRemote<T>(selector: (s: RadioRemoteState) => T): T {
  return useMusicSourceRadioRemoteBase(selector);
}

export default useMusicSourceRadioRemoteBase;
