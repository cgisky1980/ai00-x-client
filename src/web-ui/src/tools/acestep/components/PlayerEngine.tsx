/**
 * PlayerEngine — 无头音频播放引擎（Rust AudioMixer 版本）。
 *
 * 不再渲染 `<audio>` 元素。音频播放完全由 Rust AudioMixer 管理，本组件
 * 通过轮询 `audio_list_channels` 获取播放位置和时长，并检测播放结束
 * （channel state → Stopped）来触发自动下一首。
 *
 * 播放控制（play/pause/seek/volume）由 playerStore 直接调用
 * audioPlaybackApi 的 Tauri 命令完成，本组件仅负责状态同步。
 *
 * UI 已迁出：播放控制显示在主窗口灵动岛 `MusicActivity`（经 PlayerBridge
 * 跨窗口同步），歌词显示在主窗口 `LyricsOverlay`。本组件在
 * `AceStepWorkspace` 根挂载，随视图切换保持常驻。
 */

import React, { useEffect, useRef } from 'react';
import { audioPlaybackApi } from '../../vrm/lib/audioPlaybackApi';
import { usePlayerStore } from '../store/playerStore';
import type { ChannelInfo } from '../../vrm/lib/audioPlaybackApi';

const POLL_INTERVAL_MS = 100; // 10fps position polling

export const PlayerEngine: React.FC = () => {
  const audioPath = usePlayerStore((s) => s.audioPath);
  const channelId = usePlayerStore((s) => s.channelId);
  const playlist = usePlayerStore((s) => s.playlist);

  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setDuration = usePlayerStore((s) => s.setDuration);
  const setEnded = usePlayerStore((s) => s.setEnded);
  const playNext = usePlayerStore((s) => s.playNext);

  // Track previous playing state to detect end-of-song transitions
  const wasPlayingRef = useRef(false);

  // Poll the Rust AudioMixer for position, duration, and end-of-song detection
  useEffect(() => {
    if (!audioPath || channelId === null) return;

    let alive = true;
    wasPlayingRef.current = false;

    const poll = async () => {
      if (!alive) return;
      try {
        const channels = await audioPlaybackApi.audioListChannels();
        if (!alive) return;
        const ch = channels.find((c: ChannelInfo) => c.id === channelId);
        if (!ch) return;

        // Update position and duration.
        // `position_secs` is the decoder position; the audible position lags
        // behind by the output buffer latency. Lyric sync compensation is
        // applied in `LyricsOverlay` via a user-adjustable offset.
        if (ch.position_secs >= 0) {
          setCurrentTime(ch.position_secs);
        }
        if (ch.duration_secs > 0) {
          setDuration(ch.duration_secs);
        }

        // End-of-song detection: state transitioned from Playing to Stopped
        if (wasPlayingRef.current && ch.state === 'Stopped') {
          wasPlayingRef.current = false;
          // Mark the song as ended in the state machine.
          // If playNext loads a new song, it will override this to 'playing'.
          setEnded();
          if (playlist.length > 0) {
            void playNext(true);
          }
        }
        if (ch.state === 'Playing') {
          wasPlayingRef.current = true;
        }
      } catch {
        // Channel may have been removed; ignore
      }
    };

    // Initial poll
    void poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [audioPath, channelId, playlist.length, setCurrentTime, setDuration, setEnded, playNext]);

  if (!audioPath) return null;

  // No DOM element — this component is purely a polling controller
  return null;
};

export default PlayerEngine;
