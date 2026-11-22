/**
 * Thin overlay shell — transparent click-through window.
 *
 * Contains only: initMouseThrough + SettingsOverlayDialog.
 * All workspace functionality is in ChatWindowApp (chat.html).
 */
import React, { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { initMouseThrough } from '@/infrastructure/overlay';
import { WindowAPI } from '@/infrastructure/windows/WindowAPI';
import {
  WORKBENCH_SETTINGS_SCENE_ID,
  requestWorkbenchScene,
} from '@/infrastructure/plugins/workbenchSession';
import SettingsOverlayDialog from '../scenes/settings/SettingsOverlayDialog';
import './AppLayout.scss';

interface AppLayoutProps {
  className?: string;
}

const AppLayout: React.FC<AppLayoutProps> = ({ className = '' }) => {
  useEffect(() => {
    const cleanup = initMouseThrough();
    return cleanup;
  }, []);

  // 托盘双击「设置」：Rust 无法写 localStorage 的 pending 意图，改为发到常驻
  // overlay，由这里落意图 + 开窗。工作台已开则广播即时切页，没开则冷启动取回。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('tray://open-settings', () => {
      requestWorkbenchScene(WORKBENCH_SETTINGS_SCENE_ID);
      WindowAPI.open('workbench').catch(() => undefined);
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const containerClassName = [
    'ai00-x-app-layout',
    'ai00-x-app-layout--overlay',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={containerClassName} data-testid="app-layout">
      <div
        className="ai00-x-overlay-dialogs no-penetrate"
        data-no-penetrate="true"
      >
        <SettingsOverlayDialog />
      </div>
    </div>
  );
};

export default AppLayout;
