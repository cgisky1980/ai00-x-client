/**
 * WorkspaceBody — main workspace container.
 *
 * Layout:
 *   .title-bar-row  (full-width, 40px — NavBar with ModeTabs + WindowControls, draggable)
 *   .content-row    (flex:1, flex-row)
 *     .nav-area     (240px, flex-column)
 *       NavPanel    (flex:1 — navigation sidebar, auto-switches MainNav / scene nav)
 *     .scene-area   (flex:1, flex-column)
 *       SceneViewport (flex:1 — active scene content)
 */

import React from 'react';
import { useCurrentWorkspace } from '../../infrastructure/contexts/WorkspaceContext';
import { NavBar } from '../components/NavBar';
import NavPanel from '../components/NavPanel/NavPanel';
import { SceneViewport } from '../scenes';
import { useApp } from '../hooks/useApp';
import { useSceneStore } from '../stores/sceneStore';
import './WorkspaceBody.scss';

interface WorkspaceBodyProps {
  className?: string;
  isEntering?: boolean;
  isExiting?: boolean;
  onClose?: () => void;
  onTitleBarDrag?: (e: React.MouseEvent) => void;
  compact?: boolean;
}

const FULL_WINDOW_SCENES: ReadonlySet<string> = new Set(['settings', 'usage-stats']);

const WorkspaceBody: React.FC<WorkspaceBodyProps> = ({
  className = '',
  isEntering = false,
  isExiting = false,
  onClose: _onClose,
  onTitleBarDrag: _onTitleBarDrag,
  compact = false,
}) => {
  const { workspace: currentWorkspace } = useCurrentWorkspace();
  const { state, toggleLeftPanel } = useApp();
  const isNavCollapsed = state.layout.leftPanelCollapsed;
  const activeTabId = useSceneStore((s) => s.activeTabId);
  const isFullWindow = FULL_WINDOW_SCENES.has(activeTabId);

  return (
    <div className={`ai00-x-workspace-body${isEntering ? ' is-entering' : ''}${isExiting ? ' is-exiting' : ''}${isFullWindow ? ' is-full-window-scene' : ''} ${className}`}>
      <div className="ai00-x-workspace-body__title-bar-row" data-tauri-drag-region>
        <NavBar isCollapsed={isNavCollapsed} onExpandNav={toggleLeftPanel} />
      </div>

      <div className="ai00-x-workspace-body__content-row">
        {!isFullWindow && (
          <div className={`ai00-x-workspace-body__nav-area${isNavCollapsed ? ' is-collapsed' : ''}`}>
            <NavPanel className="ai00-x-workspace-body__nav-panel" compact={compact} />
          </div>
        )}

        <div className="ai00-x-workspace-body__scene-area">
          <SceneViewport
            workspacePath={currentWorkspace?.rootPath}
            isEntering={isEntering}
          />
        </div>
      </div>
    </div>
  );
};

export default WorkspaceBody;
