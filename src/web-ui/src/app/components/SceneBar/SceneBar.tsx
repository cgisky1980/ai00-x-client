/**
 * SceneBar — horizontal scene-level tab bar.
 *
 * Sits at the top of the scene-area (right content column).
 * AI Agent tab shows the current session title as a subtitle.
 * Window controls are in the NavBar (title-bar-row).
 */

import React from 'react';
import SceneTab from './SceneTab';
import { useSceneManager } from '../../hooks/useSceneManager';
import { useCurrentSessionTitle } from '../../hooks/useCurrentSessionTitle';
import { useCurrentSettingsTabTitle } from '../../hooks/useCurrentSettingsTabTitle';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import './SceneBar.scss';

interface SceneBarProps {
  className?: string;
  onClose?: () => void;
  onDrag?: (e: React.MouseEvent) => void;
}

const SceneBar: React.FC<SceneBarProps> = ({
  className = '',
  onClose: _onClose,
  onDrag: _onDrag,
}) => {
  const { openTabs, activeTabId, tabDefs, activateScene, closeScene } = useSceneManager();
  const sessionTitle = useCurrentSessionTitle();
  const settingsTabTitle = useCurrentSettingsTabTitle();
  const { t } = useI18n('common');
  const sceneBarClassName = `ai00-x-scene-bar ${className}`.trim();
  const tabCount = Math.max(openTabs.length, 1);
  const tabsStyle = {
    ['--scene-tab-count' as string]: tabCount,
  } as React.CSSProperties;

  return (
    <div
      className={sceneBarClassName}
      role="tablist"
      aria-label="Scene tabs"
    >
      <div className="ai00-x-scene-bar__tabs" style={tabsStyle}>
        {openTabs.map(tab => {
          const def = tabDefs.find(d => d.id === tab.id);
          if (!def) return null;
          const translatedLabel = def.labelKey ? t(def.labelKey) : def.label;
          const subtitle =
            (tab.id === 'session' && sessionTitle ? sessionTitle : undefined)
            ?? (tab.id === 'settings' && settingsTabTitle ? settingsTabTitle : undefined);
          return (
            <SceneTab
              key={tab.id}
              tab={tab}
              def={{ ...def, label: translatedLabel }}
              isActive={tab.id === activeTabId}
              subtitle={subtitle}
              onActivate={activateScene}
              onClose={closeScene}
            />
          );
        })}
      </div>
    </div>
  );
};

export default SceneBar;
