import React, { useState, useCallback, useRef } from 'react';
import {
  Settings,
  Info,
  MoreVertical,
  Smartphone,
  Globe,
  Network,
  Layers,
  PanelsTopLeft,
  BarChart3,
  LineChart,
  Activity,
  ChevronUp,
  Users,
  Puzzle,
  Cog,
  Brain,
  Wrench,
  Code,
} from 'lucide-react';
import { Tooltip, Modal } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useSceneManager } from '../../../hooks/useSceneManager';
import { useSceneStore } from '../../../stores/sceneStore';
import { useCanvasStore } from '@/app/components/panels/content-canvas/stores';
import NotificationButton from '../../TitleBar/NotificationButton';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useNotification } from '@/shared/notification-system';
import { AboutDialog } from '../../AboutDialog';
import { RemoteConnectDialog } from '../../RemoteConnectDialog';
import {
  RemoteConnectDisclaimerContent,
} from '../../RemoteConnectDialog/RemoteConnectDisclaimer';
import {
  getRemoteConnectDisclaimerAgreed,
  setRemoteConnectDisclaimerAgreed,
} from '../../RemoteConnectDialog/remoteConnectDisclaimerStorage';
import { MERMAID_INTERACTIVE_EXAMPLE } from '@/flow_chat/constants/mermaidExamples';

interface PersistentFooterActionsProps {
  /** Compact mode: hide browser, mermaid, and insights buttons (used in task window) */
  compact?: boolean;
}

const PersistentFooterActions: React.FC<PersistentFooterActionsProps> = ({ compact = false }) => {
  const { t } = useI18n('common');
  const { openScene } = useSceneManager();
  const activeTabId = useSceneStore((s) => s.activeTabId);

  const isBrowserPanelActiveInCanvas = useCanvasStore((s) => {
    const activeTab = s.primaryGroup.tabs.find((t) => t.id === s.primaryGroup.activeTabId);
    return activeTab?.content.type === 'browser';
  });
  const isMermaidPanelActiveInCanvas = useCanvasStore((s) => {
    const activeTab = s.primaryGroup.tabs.find((t) => t.id === s.primaryGroup.activeTabId);
    return activeTab?.content.type === 'mermaid-editor';
  });
  const { hasWorkspace } = useCurrentWorkspace();
  const { warning } = useNotification();

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const [multimodalOpen, setMultimodalOpen] = useState(false);
  const multimodalHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showRemoteConnect, setShowRemoteConnect] = useState(false);
  const [showRemoteDisclaimer, setShowRemoteDisclaimer] = useState(false);
  const [hasAgreedRemoteDisclaimer, setHasAgreedRemoteDisclaimer] = useState<boolean>(() => getRemoteConnectDisclaimerAgreed());

  const closeMenu = useCallback(() => {
    setMenuClosing(true);
    setTimeout(() => {
      setMenuOpen(false);
      setMenuClosing(false);
    }, 150);
  }, []);

  const toggleMenu = () => {
    if (menuOpen) {
      closeMenu();
    } else {
      setMenuOpen(true);
    }
  };

  const handleOpenSettings = () => {
    closeMenu();
    openScene('settings');
  };

  const handleOpenBrowser = useCallback(() => {
    if (activeTabId === 'session') {
      // Open browser as a panel in the AuxPane (right side of chat)
      window.dispatchEvent(new CustomEvent('agent-create-tab', {
        detail: {
          type: 'browser',
          title: t('scenes.browser'),
          checkDuplicate: true,
          duplicateCheckKey: 'browser-panel',
          replaceExisting: false,
        },
      }));
    } else {
      openScene('browser');
    }
  }, [activeTabId, openScene, t]);

  const handleOpenMermaidEditor = useCallback(() => {
    const title = t('scenes.mermaidEditor');
    const detail = {
      type: 'mermaid-editor' as const,
      title,
      data: { ...MERMAID_INTERACTIVE_EXAMPLE, title },
      metadata: {
        duplicateCheckKey: 'mermaid-dual-mode-demo',
      },
      checkDuplicate: true,
      duplicateCheckKey: 'mermaid-dual-mode-demo',
      replaceExisting: false,
    };

    if (activeTabId === 'session') {
      window.dispatchEvent(new CustomEvent('agent-create-tab', { detail }));
    } else {
      openScene('mermaid');
    }
  }, [activeTabId, openScene, t]);

  const handleMultimodalEnter = useCallback(() => {
    if (multimodalHoverTimerRef.current) clearTimeout(multimodalHoverTimerRef.current);
    multimodalHoverTimerRef.current = setTimeout(() => setMultimodalOpen(true), 100);
  }, []);

  const handleMultimodalLeave = useCallback(() => {
    if (multimodalHoverTimerRef.current) clearTimeout(multimodalHoverTimerRef.current);
    multimodalHoverTimerRef.current = setTimeout(() => setMultimodalOpen(false), 180);
  }, []);

  const handleOpenInsights = useCallback(() => {
    openScene('insights');
  }, [openScene]);

  const insightsTooltip = t('nav.items.insights');
  const isInsightsActive = activeTabId === 'insights';

  const handleOpenUsageStats = useCallback(() => {
    openScene('usage-stats');
  }, [openScene]);

  const usageStatsTooltip = t('scenes.usageStats');
  const isUsageStatsActive = activeTabId === 'usage-stats';

  const handleShowAbout = () => {
    closeMenu();
    setShowAbout(true);
  };

  const handleRemoteConnect = useCallback(async () => {
    if (!hasWorkspace) {
      warning(t('header.remoteConnectRequiresWorkspace'));
      return;
    }

    closeMenu();

    if (hasAgreedRemoteDisclaimer || getRemoteConnectDisclaimerAgreed()) {
      setHasAgreedRemoteDisclaimer(true);
      setShowRemoteConnect(true);
      return;
    }

    setShowRemoteDisclaimer(true);
  }, [hasWorkspace, warning, t, closeMenu, hasAgreedRemoteDisclaimer]);

  const handleAgreeDisclaimer = useCallback(() => {
    setRemoteConnectDisclaimerAgreed();
    setHasAgreedRemoteDisclaimer(true);
    setShowRemoteDisclaimer(false);
    setShowRemoteConnect(true);
  }, []);

  return (
    <>
      <div className="ai00-x-nav-panel__footer">
        <div className="ai00-x-nav-panel__footer-left">
          <div className="ai00-x-nav-panel__footer-more-wrap">
            <Tooltip content={t('nav.moreOptions')} placement="right" followCursor disabled={menuOpen}>
              <button
                type="button"
                className={`ai00-x-nav-panel__footer-btn ai00-x-nav-panel__footer-btn--icon${menuOpen ? ' is-active' : ''}`}
                aria-label={t('nav.moreOptions')}
                aria-expanded={menuOpen}
                onClick={toggleMenu}
              >
                {menuOpen ? (
                  <MoreVertical size={15} aria-hidden="true" />
                ) : (
                  <span className="ai00-x-nav-panel__footer-btn-icon-swap" aria-hidden="true">
                    <MoreVertical size={15} className="ai00-x-nav-panel__footer-btn-icon-swap-default" />
                    <ChevronUp size={15} className="ai00-x-nav-panel__footer-btn-icon-swap-hover" />
                  </span>
                )}
              </button>
            </Tooltip>

            {menuOpen && (
              <>
                <div
                  className="ai00-x-nav-panel__footer-backdrop"
                  onClick={closeMenu}
                />
                <div
                  className={`ai00-x-nav-panel__footer-menu${menuClosing ? ' is-closing' : ''}`}
                  role="menu"
                >
                  {!compact && (
                    <Tooltip
                      content={t('header.remoteConnectRequiresWorkspace')}
                      placement="right"
                      disabled={hasWorkspace}
                    >
                      <button
                        type="button"
                        className={`ai00-x-nav-panel__footer-menu-item${!hasWorkspace ? ' is-disabled' : ''}`}
                        role="menuitem"
                        aria-disabled={!hasWorkspace}
                        onClick={handleRemoteConnect}
                      >
                        <Smartphone size={14} />
                        <span>{t('header.remoteConnect')}</span>
                      </button>
                    </Tooltip>
                  )}
                  {!compact && <div className="ai00-x-nav-panel__footer-menu-divider" />}

                  {/* Extensions (定制) items */}
                  <button
                    type="button"
                    className={`ai00-x-nav-panel__footer-menu-item${activeTabId === 'agents' ? ' is-active' : ''}`}
                    role="menuitem"
                    onClick={() => { closeMenu(); openScene('agents'); }}
                  >
                    <Users size={14} />
                    <span>{t('nav.items.agents')}</span>
                  </button>
                  <button
                    type="button"
                    className={`ai00-x-nav-panel__footer-menu-item${activeTabId === 'skills' ? ' is-active' : ''}`}
                    role="menuitem"
                    onClick={() => { closeMenu(); openScene('skills'); }}
                  >
                    <Puzzle size={14} />
                    <span>{t('nav.items.skills')}</span>
                  </button>
                  <button
                    type="button"
                    className={`ai00-x-nav-panel__footer-menu-item${activeTabId === 'session-config' ? ' is-active' : ''}`}
                    role="menuitem"
                    onClick={() => { closeMenu(); openScene('session-config'); }}
                  >
                    <Cog size={14} />
                    <span>{t('nav.items.sessionConfig')}</span>
                  </button>
                  <button
                    type="button"
                    className={`ai00-x-nav-panel__footer-menu-item${activeTabId === 'ai-context' ? ' is-active' : ''}`}
                    role="menuitem"
                    onClick={() => { closeMenu(); openScene('ai-context'); }}
                  >
                    <Brain size={14} />
                    <span>{t('nav.items.aiContext')}</span>
                  </button>
                  <button
                    type="button"
                    className={`ai00-x-nav-panel__footer-menu-item${activeTabId === 'mcp-tools' ? ' is-active' : ''}`}
                    role="menuitem"
                    onClick={() => { closeMenu(); openScene('mcp-tools'); }}
                  >
                    <Wrench size={14} />
                    <span>{t('nav.items.mcpTools')}</span>
                  </button>
                  <button
                    type="button"
                    className={`ai00-x-nav-panel__footer-menu-item${activeTabId === 'editor-config' ? ' is-active' : ''}`}
                    role="menuitem"
                    onClick={() => { closeMenu(); openScene('editor-config'); }}
                  >
                    <Code size={14} />
                    <span>{t('nav.items.editorConfig')}</span>
                  </button>

                  <div className="ai00-x-nav-panel__footer-menu-divider" />
                  <button
                    type="button"
                    className="ai00-x-nav-panel__footer-menu-item"
                    role="menuitem"
                    onClick={handleOpenSettings}
                  >
                    <Settings size={14} />
                    <span>{t('tabs.settings')}</span>
                  </button>
                  <button
                    type="button"
                    className="ai00-x-nav-panel__footer-menu-item"
                    role="menuitem"
                    onClick={handleShowAbout}
                  >
                    <Info size={14} />
                    <span>{t('header.about')}</span>
                  </button>
                </div>
              </>
            )}
          </div>

        {!compact && (
          <div
            className="ai00-x-nav-panel__footer-multimodal-wrap"
            onMouseEnter={handleMultimodalEnter}
            onMouseLeave={handleMultimodalLeave}
          >
          {(() => {
            const isBrowserActive = activeTabId === 'browser' || (activeTabId === 'session' && isBrowserPanelActiveInCanvas);
            const isMermaidActive = activeTabId === 'mermaid' || (activeTabId === 'session' && isMermaidPanelActiveInCanvas);
            const isAnyActive = isBrowserActive || isMermaidActive;
            return (
              <>
                <button
                  type="button"
                  className={`ai00-x-nav-panel__footer-btn ai00-x-nav-panel__footer-btn--icon${isAnyActive ? ' is-active' : ''}${multimodalOpen ? ' is-hover-open' : ''}`}
                  aria-label={t('nav.multimodalTools')}
                  aria-expanded={multimodalOpen}
                  aria-haspopup="menu"
                >
                  <span className="ai00-x-nav-panel__footer-btn-icon-swap" aria-hidden="true">
                    <Layers size={15} className="ai00-x-nav-panel__footer-btn-icon-swap-default" />
                    <PanelsTopLeft size={15} className="ai00-x-nav-panel__footer-btn-icon-swap-hover" />
                  </span>
                </button>

                {multimodalOpen && (
                  <div
                    className="ai00-x-nav-panel__footer-multimodal-menu"
                    role="menu"
                    aria-label={t('nav.multimodalTools')}
                  >
                    <button
                      type="button"
                      className={`ai00-x-nav-panel__footer-multimodal-item${isBrowserActive ? ' is-active' : ''}`}
                      role="menuitem"
                      aria-pressed={isBrowserActive}
                      onClick={handleOpenBrowser}
                    >
                      <Globe size={13} className="ai00-x-nav-panel__footer-multimodal-item-icon" />
                      <span className="ai00-x-nav-panel__footer-multimodal-item-label">{t('scenes.browser')}</span>
                    </button>

                    <button
                      type="button"
                      className={`ai00-x-nav-panel__footer-multimodal-item${isMermaidActive ? ' is-active' : ''}`}
                      role="menuitem"
                      aria-pressed={isMermaidActive}
                      onClick={handleOpenMermaidEditor}
                    >
                      <Network size={13} className="ai00-x-nav-panel__footer-multimodal-item-icon" />
                      <span className="ai00-x-nav-panel__footer-multimodal-item-label">{t('scenes.mermaidEditor')}</span>
                    </button>
                  </div>
                )}
              </>
            );
          })()}
        </div>
        )}

          {!compact && (
            <Tooltip content={insightsTooltip} placement="right" followCursor>
              <button
                type="button"
                className={`ai00-x-nav-panel__footer-btn ai00-x-nav-panel__footer-btn--icon${isInsightsActive ? ' is-active' : ''}`}
                onClick={handleOpenInsights}
                aria-label={insightsTooltip}
              >
                <span className="ai00-x-nav-panel__footer-btn-icon-swap" aria-hidden="true">
                  <BarChart3 size={15} className="ai00-x-nav-panel__footer-btn-icon-swap-default" />
                  <LineChart size={15} className="ai00-x-nav-panel__footer-btn-icon-swap-hover" />
                </span>
              </button>
            </Tooltip>
          )}

          {!compact && (
            <Tooltip content={usageStatsTooltip} placement="right" followCursor>
              <button
                type="button"
                className={`ai00-x-nav-panel__footer-btn ai00-x-nav-panel__footer-btn--icon${isUsageStatsActive ? ' is-active' : ''}`}
                onClick={handleOpenUsageStats}
                aria-label={usageStatsTooltip}
              >
                <Activity size={15} />
              </button>
            </Tooltip>
          )}
        </div>

        <div className="ai00-x-nav-panel__footer-right">
          <Tooltip content={usageStatsTooltip} placement="top" followCursor>
            <button
              type="button"
              className={`ai00-x-nav-panel__footer-btn ai00-x-nav-panel__footer-btn--icon${isUsageStatsActive ? ' is-active' : ''}`}
              onClick={handleOpenUsageStats}
              aria-label={usageStatsTooltip}
            >
              <span className="ai00-x-nav-panel__footer-btn-icon-swap" aria-hidden="true">
                <Activity size={15} className="ai00-x-nav-panel__footer-btn-icon-swap-default" />
                <BarChart3 size={15} className="ai00-x-nav-panel__footer-btn-icon-swap-hover" />
              </span>
            </button>
          </Tooltip>
          <NotificationButton className="ai00-x-nav-panel__footer-btn" navFooterHoverIconSwap />
        </div>
      </div>
      <AboutDialog isOpen={showAbout} onClose={() => setShowAbout(false)} />
      <RemoteConnectDialog isOpen={showRemoteConnect} onClose={() => setShowRemoteConnect(false)} />
      <Modal
        isOpen={showRemoteDisclaimer}
        onClose={() => setShowRemoteDisclaimer(false)}
        title={t('remoteConnect.disclaimerTitle')}
        showCloseButton
        size="large"
        contentInset
      >
        <RemoteConnectDisclaimerContent
          agreed={hasAgreedRemoteDisclaimer}
          onClose={() => setShowRemoteDisclaimer(false)}
          onAgree={handleAgreeDisclaimer}
        />
      </Modal>
    </>
  );
};

export default PersistentFooterActions;
