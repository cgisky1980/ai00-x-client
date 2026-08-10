/**
 * SessionScene — Session scene layout.
 *
 * Layout (left to right):
 *   ChatPane (flex:1, FlowChat conversation)
 *   Resizer1 (draggable divider between Chat and AuxPane)
 *   AuxPane (variable width, ContentCanvas tabs)
 *   Resizer2 (draggable divider between AuxPane and FileTree)
 *   FileTreePanel (variable width, workspace directory — always rightmost)
 *
 * Drag rules:
 *   Resizer1: changes AuxPane width, Chat auto-fills remaining space
 *   Resizer2: redistributes between AuxPane and FileTree, Chat unchanged
 *
 * Constraints (min only, max is dynamic):
 *   ChatPane >= 300px
 *   AuxPane  >= 300px
 *   FileTree >= 180px
 */

import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../hooks/useApp';
import ChatPane from './ChatPane';
import AuxPane, { type AuxPaneRef } from './AuxPane';
import SessionFileTree from './SessionFileTree';
import ShellNav from '../shell/ShellNav';
import ConnectedTerminal from '@/tools/terminal/components/ConnectedTerminal';
import { useActiveSession } from '@/flow_chat/store/modernFlowChatStore';
import { useModeStore } from '../../stores/modeStore';
import { useTerminalSceneStore } from '../../stores/terminalSceneStore';
import { wallpaperAPI } from '@/infrastructure/api/service-api/WallpaperAPI';
import useResizer from '@/hooks/useResizer';

import {
  RIGHT_PANEL_CONFIG,
  FILE_TREE_PANEL_CONFIG,
  STORAGE_KEYS,
  PanelDisplayMode,
  getPanelDisplayMode,
  getModeWidth,
  getSnappedWidth,
  getNextMode,
  savePanelWidth,
  loadPanelWidth,
} from '../../layout/panelConfig';
import { appManager } from '@/app/services/AppManager';

import './SessionScene.scss';

const CHAT_MIN_WIDTH = 300;
const FILE_TREE_MIN_WIDTH = FILE_TREE_PANEL_CONFIG.MIN_WIDTH;
const AUX_MIN_WIDTH = 300;
const RESIZER_WIDTH = 1;

const FILE_TREE_SPLIT_RATIO_KEY = 'ai00-x-file-tree-split-ratio';
const AUX_PANE_SPLIT_RATIO_KEY = 'ai00-x-aux-pane-split-ratio';

function loadSplitRatio(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0.1 && n < 0.9) return n;
    }
  } catch { /* ignore */ }
  return fallback;
}

function saveSplitRatio(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

interface SessionSceneProps {
  workspacePath?: string;
  isEntering?: boolean;
  isActive?: boolean;
}

const SessionScene: React.FC<SessionSceneProps> = ({
  workspacePath,
  isEntering = false,
  isActive = true,
}) => {
  const { t } = useTranslation('flow-chat');
  const { state, updateRightPanelWidth } = useApp();
  const auxPaneRef = useRef<AuxPaneRef>(null);
  const activeMode = useModeStore(s => s.activeMode);
  const isTaskMode = activeMode === 'task';

  const [fileTreeWidth, setFileTreeWidth] = useState<number>(() =>
    loadPanelWidth(STORAGE_KEYS.FILE_TREE_PANEL_WIDTH, FILE_TREE_PANEL_CONFIG.DEFAULT_WIDTH)
  );

  const activeSession = useActiveSession();
  const isWallpaperSession = activeSession?.mode === 'Wallpaper' || activeSession?.config?.agentType === 'Wallpaper';
  const wallpaperWorkspacePath = activeSession?.workspacePath || activeSession?.config?.workspacePath;

  const sandboxBranch = activeSession?.sandboxBranch;
  const sessionWorkspacePath = activeSession?.workspacePath;
  const sandboxPath = sandboxBranch && sessionWorkspacePath
    ? `${sessionWorkspacePath}/.tasks/${sandboxBranch.replace(/\//g, '-')}`
    : null;

  const effectiveWorkspacePath = isWallpaperSession
    ? (wallpaperWorkspacePath || workspacePath)
    : (sandboxPath || workspacePath);

  const activeTerminalSessionId = useTerminalSceneStore(s => s.activeSessionId);

  const hasFileTree = !!effectiveWorkspacePath;
  const hasTerminal = activeTerminalSessionId !== null;
  const showFileTree = true;
  const needsFileTreeSplit = hasFileTree;

  const needsAuxSplit = hasTerminal;

  useEffect(() => {
    if (hasTerminal && state.layout.rightPanelCollapsed) {
      appManager.updateLayout({ rightPanelCollapsed: false });
    }
  }, [hasTerminal, state.layout.rightPanelCollapsed]);

  const [fileTreeSplitRatio, setFileTreeSplitRatio] = useState<number>(() =>
    loadSplitRatio(FILE_TREE_SPLIT_RATIO_KEY, 0.5)
  );
  const [auxPaneSplitRatio, setAuxPaneSplitRatio] = useState<number>(() =>
    loadSplitRatio(AUX_PANE_SPLIT_RATIO_KEY, 0.5)
  );

  const fileTreeContainerRef = useRef<HTMLDivElement>(null);
  const auxPaneContainerRef = useRef<HTMLDivElement>(null);

  const fileTreeVerticalResizer = useResizer({
    direction: 'vertical',
    currentRatio: fileTreeSplitRatio,
    onRatioChange: useCallback((r: number) => {
      setFileTreeSplitRatio(r);
      saveSplitRatio(FILE_TREE_SPLIT_RATIO_KEY, r);
    }, []),
    containerRef: fileTreeContainerRef,
    minRatio: 0.15,
    maxRatio: 0.85,
    resetRatio: 0.5,
  });

  const auxPaneVerticalResizer = useResizer({
    direction: 'vertical',
    currentRatio: auxPaneSplitRatio,
    onRatioChange: useCallback((r: number) => {
      setAuxPaneSplitRatio(r);
      saveSplitRatio(AUX_PANE_SPLIT_RATIO_KEY, r);
    }, []),
    containerRef: auxPaneContainerRef,
    minRatio: 0.15,
    maxRatio: 0.85,
    resetRatio: 0.5,
  });

  const [isDraggingVertical, setIsDraggingVertical] = useState<'file-tree-vertical' | 'aux-vertical' | null>(null);

  useEffect(() => {
    if (fileTreeVerticalResizer.isDragging) {
      setIsDraggingVertical('file-tree-vertical');
    } else if (auxPaneVerticalResizer.isDragging) {
      setIsDraggingVertical('aux-vertical');
    } else {
      setIsDraggingVertical(null);
    }
  }, [fileTreeVerticalResizer.isDragging, auxPaneVerticalResizer.isDragging]);

  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  useEffect(() => {
    if (isWallpaperSession && wallpaperWorkspacePath) {
      wallpaperAPI.openPreviewWindow(wallpaperWorkspacePath).catch(console.error);
      setIsPreviewOpen(true);
    } else {
      wallpaperAPI.closePreviewWindow().catch(console.error);
      setIsPreviewOpen(false);
    }
  }, [isWallpaperSession, wallpaperWorkspacePath]);

  useEffect(() => {
    const handleToggle = () => {
      setIsPreviewOpen((prev) => {
        if (prev) {
          wallpaperAPI.closePreviewWindow().catch(console.error);
        } else {
          wallpaperAPI.openPreviewWindow(wallpaperWorkspacePath).catch(console.error);
        }
        return !prev;
      });
    };
    const handleApply = () => {
      if (wallpaperWorkspacePath) {
        import('@/infrastructure/api').then(({ configAPI }) => {
          configAPI.getConfig('app.underlay').then((raw) => {
            let mode: string | undefined;
            try {
              const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
              mode = parsed?.background?.mode;
            } catch { /* fallback */ }
            wallpaperAPI.applyToDesktop(wallpaperWorkspacePath, { mode }).catch(console.error);
          }).catch(() => {
            wallpaperAPI.applyToDesktop(wallpaperWorkspacePath).catch(console.error);
          });
        });
      }
    };
    window.addEventListener('wallpaper-preview-toggle', handleToggle);
    window.addEventListener('wallpaper-apply-to-desktop', handleApply);
    return () => {
      window.removeEventListener('wallpaper-preview-toggle', handleToggle);
      window.removeEventListener('wallpaper-apply-to-desktop', handleApply);
    };
  }, [wallpaperWorkspacePath, isPreviewOpen]);

  const [isDragging, setIsDragging] = useState<'file-tree' | 'aux' | 'file-tree-vertical' | 'aux-vertical' | null>(null);
  const [isHovering, setIsHovering] = useState<'file-tree' | 'aux' | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const auxPaneElementRef = useRef<HTMLDivElement>(null);
  const fileTreeElementRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);

  const currentRightWidth = state.layout.rightPanelWidth || RIGHT_PANEL_CONFIG.COMFORTABLE_DEFAULT;

  const rightPanelMode: PanelDisplayMode = useMemo(() => {
    if (state.layout.rightPanelCollapsed) return 'collapsed';
    return getPanelDisplayMode(currentRightWidth, RIGHT_PANEL_CONFIG);
  }, [state.layout.rightPanelCollapsed, currentRightWidth]);

  const saveAndUpdateRightWidth = useCallback((width: number) => {
    updateRightPanelWidth(width);
    savePanelWidth(STORAGE_KEYS.RIGHT_PANEL_LAST_WIDTH, width);
  }, [updateRightPanelWidth]);

  useEffect(() => {
    if (state.layout.chatCollapsed && state.layout.rightPanelCollapsed) {
      appManager.updateLayout({ rightPanelCollapsed: false });
    }
  }, [state.layout.chatCollapsed, state.layout.rightPanelCollapsed]);

  (window as any).__AI00X_LAYOUT_STATE__ = {
    rightPanelCollapsed: state.layout.rightPanelCollapsed,
  };

  // When AuxPane opens (file opened), redistribute: Chat 50%, AuxPane remaining, FileTree default
  const prevAuxCollapsedRef = useRef(state.layout.rightPanelCollapsed);
  useEffect(() => {
    const wasCollapsed = prevAuxCollapsedRef.current;
    const isNowCollapsed = state.layout.rightPanelCollapsed;
    prevAuxCollapsedRef.current = isNowCollapsed;

    if (wasCollapsed && !isNowCollapsed && containerRef.current) {
      const containerWidth = containerRef.current.offsetWidth;
      const defaultFileTreeWidth = FILE_TREE_PANEL_CONFIG.DEFAULT_WIDTH;
      const auxWidth = containerWidth * 0.5 - defaultFileTreeWidth - RESIZER_WIDTH * 2;

      setFileTreeWidth(defaultFileTreeWidth);
      savePanelWidth(STORAGE_KEYS.FILE_TREE_PANEL_WIDTH, defaultFileTreeWidth);

      if (auxWidth >= AUX_MIN_WIDTH) {
        saveAndUpdateRightWidth(auxWidth);
      } else {
        saveAndUpdateRightWidth(AUX_MIN_WIDTH);
      }
    }
  }, [state.layout.rightPanelCollapsed, saveAndUpdateRightWidth]);

  // ── Resizer1: ChatPane ↔ AuxPane ──────────────────────────
  // Drag changes AuxPane width, Chat auto-adjusts
  // When AuxPane is closed and FileTree visible: drag changes FileTree width instead
  const handleMouseDownAuxResizer = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;

    const auxVisible = !state.layout.rightPanelCollapsed;
    const startX = e.clientX;
    const startFileTreeWidth = fileTreeWidth;
    const startAuxWidth = currentRightWidth;
    let lastValidFileTreeWidth = startFileTreeWidth;
    let lastValidAuxWidth = startAuxWidth;

    setIsDragging('aux');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = requestAnimationFrame(() => {
        const containerWidth = containerRef.current!.offsetWidth;
        const delta = startX - ev.clientX;

        if (auxVisible) {
          let newAuxWidth = startAuxWidth + delta;
          const maxAuxWidth = containerWidth - CHAT_MIN_WIDTH - startFileTreeWidth - RESIZER_WIDTH - RESIZER_WIDTH;
          newAuxWidth = Math.max(AUX_MIN_WIDTH, Math.min(maxAuxWidth, newAuxWidth));
          lastValidAuxWidth = newAuxWidth;
          if (auxPaneElementRef.current) {
            auxPaneElementRef.current.style.width = `${newAuxWidth}px`;
          }
        } else if (showFileTree) {
          let newFileTreeWidth = startFileTreeWidth + delta;
          const maxFileTreeWidth = containerWidth - CHAT_MIN_WIDTH - RESIZER_WIDTH;
          newFileTreeWidth = Math.max(FILE_TREE_MIN_WIDTH, Math.min(maxFileTreeWidth, newFileTreeWidth));
          lastValidFileTreeWidth = newFileTreeWidth;
          if (fileTreeElementRef.current) {
            fileTreeElementRef.current.style.width = `${newFileTreeWidth}px`;
          }
        }
        animationFrameRef.current = null;
      });
    };

    const onUp = () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      if (auxVisible) {
        const snappedAux = getSnappedWidth(lastValidAuxWidth, RIGHT_PANEL_CONFIG, false);
        const finalAuxWidth = snappedAux !== lastValidAuxWidth ? snappedAux : lastValidAuxWidth;
        saveAndUpdateRightWidth(finalAuxWidth);
        if (auxPaneElementRef.current) auxPaneElementRef.current.style.width = '';
      } else {
        const snapped = getSnappedWidth(lastValidFileTreeWidth, FILE_TREE_PANEL_CONFIG, false);
        const finalWidth = snapped !== lastValidFileTreeWidth ? snapped : lastValidFileTreeWidth;
        setFileTreeWidth(finalWidth);
        savePanelWidth(STORAGE_KEYS.FILE_TREE_PANEL_WIDTH, finalWidth);
        if (fileTreeElementRef.current) fileTreeElementRef.current.style.width = '';
      }

      requestAnimationFrame(() => requestAnimationFrame(() => setIsDragging(null)));
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [fileTreeWidth, state.layout.rightPanelCollapsed, currentRightWidth, saveAndUpdateRightWidth, showFileTree]);

  // ── Resizer2: AuxPane ↔ FileTree ───────────────────────────
  // Drag right → FileTree shrinks, AuxPane grows (Chat unchanged)
  // Drag left  → FileTree grows, AuxPane shrinks (Chat unchanged)
  const handleMouseDownFileTreeResizer = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;

    const startX = e.clientX;
    const startFileTreeWidth = fileTreeWidth;
    const startAuxWidth = currentRightWidth;
    let lastValidFileTreeWidth = startFileTreeWidth;
    let lastValidAuxWidth = startAuxWidth;

    setIsDragging('file-tree');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = requestAnimationFrame(() => {
        const delta = startX - ev.clientX;
        let newFileTreeWidth = startFileTreeWidth + delta;
        let newAuxWidth = startAuxWidth - delta;

        if (newFileTreeWidth < FILE_TREE_MIN_WIDTH) {
          newAuxWidth += (newFileTreeWidth - FILE_TREE_MIN_WIDTH);
          newFileTreeWidth = FILE_TREE_MIN_WIDTH;
        }
        if (newAuxWidth < AUX_MIN_WIDTH) {
          newFileTreeWidth += (newAuxWidth - AUX_MIN_WIDTH);
          newAuxWidth = AUX_MIN_WIDTH;
        }

        lastValidFileTreeWidth = newFileTreeWidth;
        lastValidAuxWidth = newAuxWidth;

        if (fileTreeElementRef.current) {
          fileTreeElementRef.current.style.width = `${newFileTreeWidth}px`;
        }
        if (auxPaneElementRef.current) {
          auxPaneElementRef.current.style.width = `${newAuxWidth}px`;
        }
        animationFrameRef.current = null;
      });
    };

    const onUp = () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      const snappedAux = getSnappedWidth(lastValidAuxWidth, RIGHT_PANEL_CONFIG, false);
      const finalAuxWidth = snappedAux !== lastValidAuxWidth ? snappedAux : lastValidAuxWidth;
      saveAndUpdateRightWidth(finalAuxWidth);

      const snappedFileTree = getSnappedWidth(lastValidFileTreeWidth, FILE_TREE_PANEL_CONFIG, false);
      const finalFileTreeWidth = snappedFileTree !== lastValidFileTreeWidth ? snappedFileTree : lastValidFileTreeWidth;
      setFileTreeWidth(finalFileTreeWidth);
      savePanelWidth(STORAGE_KEYS.FILE_TREE_PANEL_WIDTH, finalFileTreeWidth);

      if (fileTreeElementRef.current) fileTreeElementRef.current.style.width = '';
      if (auxPaneElementRef.current) auxPaneElementRef.current.style.width = '';

      requestAnimationFrame(() => requestAnimationFrame(() => setIsDragging(null)));
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [fileTreeWidth, currentRightWidth, saveAndUpdateRightWidth]);

  const handleDoubleClickAuxResizer = useCallback(() => {
    const nextMode = getNextMode(rightPanelMode);
    const targetWidth = getModeWidth(nextMode, RIGHT_PANEL_CONFIG);
    saveAndUpdateRightWidth(targetWidth);
  }, [rightPanelMode, saveAndUpdateRightWidth]);

  const [isAuxPaneExpandingImmediate, setIsAuxPaneExpandingImmediate] = useState(false);

  useEffect(() => {
    const handler = (event: CustomEvent) => {
      if (event.detail?.noAnimation && state.layout.rightPanelCollapsed) {
        setIsAuxPaneExpandingImmediate(true);
        setTimeout(() => setIsAuxPaneExpandingImmediate(false), 0);
      }
    };
    window.addEventListener('expand-right-panel-immediate', handler as EventListener);
    return () => window.removeEventListener('expand-right-panel-immediate', handler as EventListener);
  }, [state.layout.rightPanelCollapsed]);

  useEffect(() => {
    const handleExpandRightPanel = () => {
      if (state.layout.rightPanelCollapsed) {
        appManager.updateLayout({ rightPanelCollapsed: false });
      }
    };
    window.addEventListener('expand-right-panel', handleExpandRightPanel);
    return () => window.removeEventListener('expand-right-panel', handleExpandRightPanel);
  }, [state.layout.rightPanelCollapsed]);

  // Validate on mount and resize — only enforce minimums
  useEffect(() => {
    const validate = () => {
      if (!containerRef.current) return;
      const containerWidth = containerRef.current.offsetWidth;

      let validFileTree = fileTreeWidth;
      const auxVisible = !state.layout.rightPanelCollapsed;
      const auxReserved = auxVisible ? currentRightWidth + RESIZER_WIDTH : 0;
      const maxFileTree = containerWidth - CHAT_MIN_WIDTH - auxReserved - RESIZER_WIDTH;
      validFileTree = Math.max(FILE_TREE_MIN_WIDTH, Math.min(maxFileTree, validFileTree));
      if (validFileTree !== fileTreeWidth) {
        setFileTreeWidth(validFileTree);
        savePanelWidth(STORAGE_KEYS.FILE_TREE_PANEL_WIDTH, validFileTree);
      }

      if (auxVisible && currentRightWidth < AUX_MIN_WIDTH) {
        updateRightPanelWidth(AUX_MIN_WIDTH);
      }
    };
    const rafId = requestAnimationFrame(validate);
    window.addEventListener('resize', validate);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', validate);
    };
  }, [fileTreeWidth, currentRightWidth, state.layout.rightPanelCollapsed, updateRightPanelWidth]);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
  }, []);

  const isRightAsMain = state.layout.chatCollapsed;
  const isChatHidden = state.layout.centerPanelCollapsed || isRightAsMain;

  const panelModeLabels = useMemo(() => ({
    collapsed:    t('layout.panelMode.collapsed'),
    compact:      t('layout.panelMode.compact'),
    comfortable:  t('layout.panelMode.comfortable'),
    expanded:     t('layout.panelMode.expanded'),
  }), [t]);

  const panelCollapseHintStyles = useMemo(() => {
    const q = (v: string) => `"${v.replace(/"/g, '\\"')}"`;
    return {
      ['--panel-collapse-hint-right' as any]: q(t('layout.panelCollapseHintRight')),
    } as React.CSSProperties;
  }, [t]);

  const isAnyDragging = isDragging !== null || isDraggingVertical !== null;

  const showAuxPane = !state.layout.rightPanelCollapsed || hasTerminal;
  const auxPaneCollapsed = state.layout.rightPanelCollapsed && !hasTerminal;

  return (
    <div
      ref={containerRef}
      className={[
        'ai00-x-session-scene',
        isAnyDragging && 'ai00-x-session-scene--dragging',
        isDraggingVertical !== null && 'ai00-x-session-scene--dragging-vertical',
        isEntering && 'layout-entering',
        isTaskMode && 'ai00-x-session-scene--task-mode',
      ].filter(Boolean).join(' ')}
      style={panelCollapseHintStyles}
    >
      {/* ChatPane — FlowChat conversation */}
      {!isChatHidden && (
        <div
          className={`ai00-x-session-scene__chat-pane ${isAnyDragging ? 'ai00-x-session-scene__chat-pane--dragging' : ''}`}
        >
          <ChatPane
            width={0}
            isFullscreen={false}
            isDragging={false}
            workspacePath={workspacePath}
            showChatInput
          />
        </div>
      )}

      {/* Resizer1: ChatPane ↔ AuxPane */}
      {!isChatHidden && (
        <div
          className={[
            'ai00-x-pane-resizer',
            auxPaneCollapsed && 'ai00-x-pane-resizer--collapsed',
            isDragging === 'aux' && 'ai00-x-pane-resizer--dragging',
            isHovering === 'aux' && 'ai00-x-pane-resizer--hovering',
          ].filter(Boolean).join(' ')}
          onMouseDown={handleMouseDownAuxResizer}
          onDoubleClick={handleDoubleClickAuxResizer}
          onMouseEnter={() => setIsHovering('aux')}
          onMouseLeave={() => setIsHovering(null)}
          tabIndex={state.layout.rightPanelCollapsed ? -1 : 0}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('layout.resizer.rightAriaLabel')}
          aria-valuenow={currentRightWidth}
          aria-valuemin={AUX_MIN_WIDTH}
          aria-valuemax={9999}
          title={t('layout.resizer.title', { mode: panelModeLabels[rightPanelMode] })}
        >
          <div className="ai00-x-pane-resizer__line" />
          <div className="ai00-x-pane-resizer__handle">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="ai00-x-pane-resizer__icon">
              <circle cx="6" cy="4" r="1" fill="currentColor" />
              <circle cx="6" cy="8" r="1" fill="currentColor" />
              <circle cx="6" cy="12" r="1" fill="currentColor" />
              <circle cx="10" cy="4" r="1" fill="currentColor" />
              <circle cx="10" cy="8" r="1" fill="currentColor" />
              <circle cx="10" cy="12" r="1" fill="currentColor" />
            </svg>
          </div>
        </div>
      )}

      {/* AuxPane — ContentCanvas (with wallpaper preview overlay) */}
      {showAuxPane && (
        <div
          ref={auxPaneElementRef}
          className={[
            'ai00-x-session-scene__aux-pane',
            needsAuxSplit && 'ai00-x-session-scene__aux-pane--split',
            auxPaneCollapsed && 'ai00-x-session-scene__aux-pane--collapsed',
            isAnyDragging                            && 'ai00-x-session-scene__aux-pane--dragging',
            isRightAsMain                            && 'ai00-x-session-scene__aux-pane--editor-mode',
            isAuxPaneExpandingImmediate              && 'ai00-x-session-scene__aux-pane--no-animation',
          ].filter(Boolean).join(' ')}
          style={{
            width: auxPaneCollapsed
              ? undefined
              : isRightAsMain ? undefined : `${currentRightWidth}px`,
            minWidth: auxPaneCollapsed ? 0 : AUX_MIN_WIDTH,
          }}
          data-mode={rightPanelMode}
        >
          {needsAuxSplit ? (
            <div ref={auxPaneContainerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ flex: `${auxPaneSplitRatio} 1 0`, overflow: 'hidden', minHeight: 0 }}>
                <AuxPane
                  ref={auxPaneRef}
                  workspacePath={workspacePath}
                  isSceneActive={isActive}
                  embedded
                />
              </div>
              <div
                className={[
                  'ai00-x-pane-resizer',
                  'ai00-x-pane-resizer--vertical',
                  isDraggingVertical === 'aux-vertical' && 'ai00-x-pane-resizer--dragging',
                ].filter(Boolean).join(' ')}
                onMouseDown={auxPaneVerticalResizer.handleMouseDown}
                onDoubleClick={auxPaneVerticalResizer.handleDoubleClick}
                role="separator"
                aria-orientation="horizontal"
              >
                <div className="ai00-x-pane-resizer__line" />
                <div className="ai00-x-pane-resizer__handle">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="ai00-x-pane-resizer__icon">
                    <circle cx="6" cy="4" r="1" fill="currentColor" />
                    <circle cx="6" cy="8" r="1" fill="currentColor" />
                    <circle cx="6" cy="12" r="1" fill="currentColor" />
                    <circle cx="10" cy="4" r="1" fill="currentColor" />
                    <circle cx="10" cy="8" r="1" fill="currentColor" />
                    <circle cx="10" cy="12" r="1" fill="currentColor" />
                  </svg>
                </div>
              </div>
              <div style={{ flex: `${1 - auxPaneSplitRatio} 1 0`, overflow: 'hidden', minHeight: 0 }}>
                <ConnectedTerminal
                  key={activeTerminalSessionId!}
                  sessionId={activeTerminalSessionId!}
                  autoFocus
                />
              </div>
            </div>
          ) : (
            <AuxPane
              ref={auxPaneRef}
              workspacePath={workspacePath}
              isSceneActive={isActive}
            />
          )}
        </div>
      )}

      {/* Resizer2: AuxPane ↔ FileTree */}
      {showFileTree && !isChatHidden && (
        <div
          className={[
            'ai00-x-pane-resizer',
            isDragging === 'file-tree' && 'ai00-x-pane-resizer--dragging',
            isHovering === 'file-tree' && 'ai00-x-pane-resizer--hovering',
          ].filter(Boolean).join(' ')}
          onMouseDown={handleMouseDownFileTreeResizer}
          onMouseEnter={() => setIsHovering('file-tree')}
          onMouseLeave={() => setIsHovering(null)}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('layout.resizer.fileTreeAriaLabel', { defaultValue: 'File tree resizer' })}
          aria-valuenow={fileTreeWidth}
          aria-valuemin={FILE_TREE_MIN_WIDTH}
          aria-valuemax={9999}
        >
          <div className="ai00-x-pane-resizer__line" />
          <div className="ai00-x-pane-resizer__handle">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="ai00-x-pane-resizer__icon">
              <circle cx="6" cy="4" r="1" fill="currentColor" />
              <circle cx="6" cy="8" r="1" fill="currentColor" />
              <circle cx="6" cy="12" r="1" fill="currentColor" />
              <circle cx="10" cy="4" r="1" fill="currentColor" />
              <circle cx="10" cy="8" r="1" fill="currentColor" />
              <circle cx="10" cy="12" r="1" fill="currentColor" />
            </svg>
          </div>
        </div>
      )}

      {/* FileTreePanel — workspace directory (always rightmost) */}
      {showFileTree && !isChatHidden && (
        <div
          ref={fileTreeElementRef}
          className={[
            'ai00-x-session-scene__file-tree',
            needsFileTreeSplit && 'ai00-x-session-scene__file-tree--split',
          ].filter(Boolean).join(' ')}
          style={{ width: `${fileTreeWidth}px` }}
        >
          {needsFileTreeSplit ? (
            <div ref={fileTreeContainerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ flex: `${fileTreeSplitRatio} 1 0`, overflow: 'hidden', minHeight: 0 }}>
                <SessionFileTree workspacePath={effectiveWorkspacePath} />
              </div>
              <div
                className={[
                  'ai00-x-pane-resizer',
                  'ai00-x-pane-resizer--vertical',
                  isDraggingVertical === 'file-tree-vertical' && 'ai00-x-pane-resizer--dragging',
                ].filter(Boolean).join(' ')}
                onMouseDown={fileTreeVerticalResizer.handleMouseDown}
                onDoubleClick={fileTreeVerticalResizer.handleDoubleClick}
                role="separator"
                aria-orientation="horizontal"
              >
                <div className="ai00-x-pane-resizer__line" />
                <div className="ai00-x-pane-resizer__handle">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="ai00-x-pane-resizer__icon">
                    <circle cx="6" cy="4" r="1" fill="currentColor" />
                    <circle cx="6" cy="8" r="1" fill="currentColor" />
                    <circle cx="6" cy="12" r="1" fill="currentColor" />
                    <circle cx="10" cy="4" r="1" fill="currentColor" />
                    <circle cx="10" cy="8" r="1" fill="currentColor" />
                    <circle cx="10" cy="12" r="1" fill="currentColor" />
                  </svg>
                </div>
              </div>
              <div style={{ flex: `${1 - fileTreeSplitRatio} 1 0`, overflow: 'hidden', minHeight: 0 }}>
                <ShellNav workspacePath={effectiveWorkspacePath} />
              </div>
            </div>
          ) : hasFileTree ? (
            <SessionFileTree workspacePath={effectiveWorkspacePath} />
          ) : (
            <ShellNav workspacePath={effectiveWorkspacePath} />
          )}
        </div>
      )}

    </div>
  );
};

export default SessionScene;
