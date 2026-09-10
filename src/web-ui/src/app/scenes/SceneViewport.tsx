/**
 * SceneViewport — renders the active scene component.
 *
 * All tabs are mounted but only the active one is visible,
 * preserving state across tab switches.
 *
 * 'welcome' is a proper scene tab; it auto-closes when any other
 * scene is explicitly opened.
 */

import React, { Suspense, lazy } from 'react';
import type { SceneTabId } from '../components/SceneBar/types';
import { useSceneManager } from '../hooks/useSceneManager';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { ProcessingIndicator } from '@/shared/components/ProcessingIndicator/ProcessingIndicator';
import SettingsScene from './settings/SettingsScene';
import './settings/SettingsScene.scss';
import SessionConfig from '@/infrastructure/config/components/SessionConfig';
import AIRulesMemoryConfig from '@/infrastructure/config/components/AIRulesMemoryConfig';
import McpToolsConfig from '@/infrastructure/config/components/McpToolsConfig';
import EditorConfig from '@/infrastructure/config/components/EditorConfig';
import './SceneViewport.scss';

// Session is the primary interaction path. Keep it in the main scene bundle so
// first open does not stall on a lazy chunk fetch/parse before FlowChat mounts.
const TerminalScene   = lazy(() => import('./terminal/TerminalScene'));
const GitScene        = lazy(() => import('./git/GitScene'));
const FileViewerScene = lazy(() => import('./file-viewer/FileViewerScene'));
const SkillsScene     = lazy(() => import('./skills/SkillsScene'));
const PluginsScene    = lazy(() => import('./plugins/PluginsScene'));
const MiniAppGalleryScene = lazy(() => import('./miniapps/MiniAppGalleryScene'));
const BrowserScene    = lazy(() => import('./browser/BrowserScene'));
const MermaidEditorScene = lazy(() => import('./mermaid/MermaidEditorScene'));
const ShellScene      = lazy(() => import('./shell/ShellScene'));
const WelcomeScene    = lazy(() => import('./welcome/WelcomeScene'));
const MiniAppScene    = lazy(() => import('./miniapps/MiniAppScene'));
const WallpaperDesignScene = lazy(() => import('./wallpaper/WallpaperDesignView'));
const PanelViewScene  = lazy(() => import('./panel-view/PanelViewScene'));
const UsageStatsScene = lazy(() => import('./usage-stats/UsageStatsScene'));
const AceStepScene     = lazy(() => import('./acestep/AceStepScene'));
const DshScene         = lazy(() => import('./dsh/DshScene'));
const CreditsScene     = lazy(() => import('./credits/CreditsScene'));


interface SceneViewportProps {
  workspacePath?: string;
  isEntering?: boolean;
}

const SceneViewport: React.FC<SceneViewportProps> = ({ workspacePath, isEntering = false }) => {
  const { openTabs, activeTabId } = useSceneManager();
  const { t } = useI18n('common');

  // All tabs closed — show empty state
  if (openTabs.length === 0) {
    return (
      <div className="ai00-x-scene-viewport">
        <div className="ai00-x-scene-viewport__clip ai00-x-scene-viewport__clip--empty">
          <p className="ai00-x-scene-viewport__empty-hint">{t('welcomeScene.emptyHint')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ai00-x-scene-viewport">
      <div className="ai00-x-scene-viewport__clip">
        {openTabs.map(tab => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={[
                'ai00-x-scene-viewport__scene',
                isActive && 'ai00-x-scene-viewport__scene--active',
              ].filter(Boolean).join(' ')}
              aria-hidden={!isActive}
            >
              <Suspense
                fallback={
                  isActive ? (
                    <div
                      className="ai00-x-scene-viewport__lazy-fallback"
                      role="status"
                      aria-busy="true"
                      aria-label={t('loading.scenes')}
                    >
                      <ProcessingIndicator visible />
                    </div>
                  ) : null
                }
              >
                {renderScene(tab.id, workspacePath, isEntering, isActive)}
              </Suspense>
            </div>
          );
        })}
      </div>
    </div>
  );
};

function renderScene(
  id: SceneTabId,
  workspacePath?: string,
  isEntering?: boolean,
  isActive: boolean = false
) {
  switch (id) {
    case 'welcome':
      void isEntering; // 保留参数兼容调用方（session 场景已删）
      return <WelcomeScene />;
    case 'terminal':
      return <TerminalScene isActive={isActive} />;
    case 'git':
      return <GitScene workspacePath={workspacePath} isActive={isActive} />;
    case 'settings':
      return <SettingsScene />;
    case 'file-viewer':
      return <FileViewerScene workspacePath={workspacePath} />;
    case 'skills':
      return <SkillsScene />;
    case 'plugins':
      return <PluginsScene />;
    case 'session-config':
      return <div className="ai00-x-settings-scene"><div className="ai00-x-settings-scene__content-wrapper"><SessionConfig /></div></div>;
    case 'ai-context':
      return <div className="ai00-x-settings-scene"><div className="ai00-x-settings-scene__content-wrapper"><AIRulesMemoryConfig /></div></div>;
    case 'mcp-tools':
      return <div className="ai00-x-settings-scene"><div className="ai00-x-settings-scene__content-wrapper"><McpToolsConfig /></div></div>;
    case 'editor-config':
      return <div className="ai00-x-settings-scene"><div className="ai00-x-settings-scene__content-wrapper"><EditorConfig /></div></div>;
    case 'miniapps':
      return <MiniAppGalleryScene />;
    case 'browser':
      return <BrowserScene />;
    case 'mermaid':
      return <MermaidEditorScene />;
    case 'shell':
      return <ShellScene isActive={isActive} />;
    case 'panel-view':
      return <PanelViewScene workspacePath={workspacePath} />;
    case 'usage-stats':
      return <UsageStatsScene />;
    case 'acestep':
      return <AceStepScene />;
    case 'dsh':
      return <DshScene />;
    case 'credits':
      return <CreditsScene />;
    case 'wallpaper':
      return <WallpaperDesignScene />;
    default:
      if (typeof id === 'string' && id.startsWith('miniapp:')) {
        return <MiniAppScene appId={id.slice('miniapp:'.length)} />;
      }
      return null;
  }
}

export default SceneViewport;
