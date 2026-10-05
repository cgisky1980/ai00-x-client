/**
 * AceStepPlaybackHost — 播放权威常驻挂载点（仅 overlay 窗口挂载）。
 *
 * playerStore / PlayerEngine / PlayerBridge / 电台会话桥随本组件驻留在常驻
 * overlay webview。音乐窗口（可关可开）通过 `acestep://player-state` /
 * `acestep://lyrics-state` 事件镜像状态、`acestep://player-command` /
 * `music-source://radio-command` 发遥控命令。
 *
 * 解决：音乐窗口关闭曾导致播放状态机与电台会话销毁——音频虽由 Rust
 * AudioMixer 继续输出，但电台不再自动连播、重开窗口后 UI 状态清零、
 * 桌面歌词被空状态广播顶掉。权威常驻后这些全部与音乐窗口生命周期解耦。
 */
import React, { useEffect, useState } from 'react';
import { PlayerEngine } from './PlayerEngine';
import { startPlayerBridge } from '../services/PlayerBridge';
import { startMusicSourceRadioBridge } from '../../music-source/musicSourceRadioBridge';

export const AceStepPlaybackHost: React.FC = () => {
  const [isOverlay, setIsOverlay] = useState(false);

  useEffect(() => {
    let alive = true;
    let stopBridge: (() => void) | null = null;
    let stopRadioBridge: (() => void) | null = null;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (!alive) return;
        // 只在常驻 overlay 窗口挂载（App.tsx 同页还会跑在主窗口，必须门控）
        if (getCurrentWindow().label !== 'overlay') return;
        stopRadioBridge = startMusicSourceRadioBridge();
        stopBridge = startPlayerBridge();
        setIsOverlay(true);
      } catch {
        // 非 Tauri 环境（浏览器预览）：不挂载
      }
    })();
    return () => {
      alive = false;
      stopBridge?.();
      stopRadioBridge?.();
    };
  }, []);

  if (!isOverlay) return null;
  return <PlayerEngine />;
};

export default AceStepPlaybackHost;
