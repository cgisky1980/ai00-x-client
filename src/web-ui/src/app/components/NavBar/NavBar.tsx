/**
 * NavBar — navigation history controls + window controls.
 *
 * Sits in the title-bar-row (full-width draggable bar).
 * Layout: [PanelToggle] [←] [→]  <drag-region>  [_][□][×]
 *
 * - Back/Forward buttons mirror IDE navigation history.
 * - PanelToggle expands/collapses the left NavPanel.
 * - WindowControls (minimize/maximize/close) are at the far right.
 * - The entire title-bar-row is a drag region for moving the window.
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { Pin, PinOff, ArrowLeft } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Tooltip, WindowControls } from '@/component-library';
import { useI18n } from '../../../infrastructure/i18n';
import { LanguageSelector } from '@/infrastructure/i18n/components/LanguageSelector';
import { ThemeSelector } from '@/infrastructure/theme';
import { useWindowControls } from '../../hooks/useWindowControls';
import { useSceneStore } from '../../stores/sceneStore';
import ModeTabs from '../ModeTabs/ModeTabs';
import './NavBar.scss';

interface NavBarProps {
  className?: string;
  isCollapsed?: boolean;
  onExpandNav?: () => void;
  onDrag?: (e: React.MouseEvent) => void;
}

const NavBar: React.FC<NavBarProps> = ({
  className = '',
  isCollapsed: _isCollapsed = false,
  onExpandNav: _onExpandNav,
  onDrag: _onDrag,
}) => {
  const { t } = useI18n('common');
  const { t: tSettings } = useI18n('settings');
  const activeTabId = useSceneStore(s => s.activeTabId);
  const isSettingsScene = activeTabId === 'settings';
  const isUsageStatsScene = activeTabId === 'usage-stats';
  const isFullWindowScene = isSettingsScene || isUsageStatsScene;

  const isMacOS = useMemo(() => {
    const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
    return (
      isTauri &&
      typeof navigator !== 'undefined' &&
      typeof navigator.platform === 'string' &&
      navigator.platform.toUpperCase().includes('MAC')
    );
  }, []);
  const { handleMinimize, handleMaximize, handleClose, isMaximized } = useWindowControls();
  const [isPinned, setIsPinned] = useState(false);

  useEffect(() => {
    getCurrentWindow().isAlwaysOnTop().then(setIsPinned).catch(() => {});
  }, []);

  const handleTogglePin = useCallback(async () => {
    const win = getCurrentWindow();
    const next = !isPinned;
    await win.setAlwaysOnTop(next);
    setIsPinned(next);
  }, [isPinned]);

  const handleExitSettings = useCallback(() => {
    useSceneStore.getState().closeScene('settings');
  }, []);

  const handleExitUsageStats = useCallback(() => {
    useSceneStore.getState().closeScene('usage-stats');
  }, []);

  const rootClassName = `ai00-x-nav-bar${isMacOS ? ' ai00-x-nav-bar--macos' : ''} ${className}`;

  return (
    <div className={rootClassName} role="toolbar" aria-label={t('nav.aria.navControl')}>
      {isFullWindowScene ? (
        <div className="ai00-x-nav-bar__settings-header">
          <button
            className="ai00-x-nav-bar__settings-back"
            onClick={isUsageStatsScene ? handleExitUsageStats : handleExitSettings}
            type="button"
            aria-label={t('nav.back', { defaultValue: 'Back' })}
          >
            <ArrowLeft size={16} />
          </button>
          <span className="ai00-x-nav-bar__settings-title">
            {isUsageStatsScene
              ? t('scenes.usageStats')
              : tSettings('title', { defaultValue: 'Settings' })}
          </span>
        </div>
      ) : (
        <ModeTabs />
      )}

      <div className="ai00-x-nav-bar__spacer" data-tauri-drag-region />

      <div className="ai00-x-nav-bar__quick-controls">
        <ThemeSelector mode="compact" />
        <LanguageSelector mode="icon-only" />
      </div>

      <Tooltip content={isPinned ? t('nav.unpin') : t('nav.pin')} placement="bottom" followCursor>
        <button
          className={`ai00-x-nav-bar__pin-btn${isPinned ? ' is-pinned' : ''}`}
          onClick={handleTogglePin}
          type="button"
          aria-label={isPinned ? t('nav.unpin') : t('nav.pin')}
        >
          {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
      </Tooltip>

      <div className="ai00-x-nav-bar__window-controls">
        <WindowControls
          onMinimize={handleMinimize}
          onMaximize={handleMaximize}
          onClose={handleClose}
          isMaximized={isMaximized}
        />
      </div>
    </div>
  );
};

export default NavBar;
