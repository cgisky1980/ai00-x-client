/**
 * MusicWindowApp — 「乐」独立音乐窗口根组件。
 *
 * 播放权威（playerStore/PlayerEngine/PlayerBridge/电台会话）已迁至常驻
 * overlay webview（AceStepPlaybackHost）。本窗口降级为纯遥控：通过
 * `acestep://player-state` / `acestep://lyrics-state` 事件镜像状态，
 * `acestep://player-command` / `music-source://radio-command` 发控制命令。
 * 窗口关闭/重开不再影响播放与电台状态。
 */
import React from 'react';
import { MusicWindowPage } from '../tools/music-window/MusicWindowPage';

const MusicWindowApp: React.FC = () => {
  return <MusicWindowPage />;
};

export default MusicWindowApp;
