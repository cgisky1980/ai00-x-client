import React, { useCallback, useContext, useEffect, useState } from 'react';
import { FolderOpen, MoreHorizontal, FolderSearch, Plus, ChevronDown, Copy, FileText } from 'lucide-react';
import { DotMatrixArrowRightIcon } from './DotMatrixArrowRightIcon';
import { useI18n } from '@/infrastructure/i18n';
import { i18nService } from '@/infrastructure/i18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { workspaceAPI } from '@/infrastructure/api';
import { globalAPI } from '@/infrastructure/api/service-api/GlobalAPI';
import { notificationService } from '@/shared/notification-system';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { openMainSession } from '@/flow_chat/services/sessionNavigation';
import { findReusableEmptySessionId } from '@/app/utils/projectSessionWorkspace';
import SessionsSection from '../sessions/SessionsSection';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/component-library';
import {
  isRemoteWorkspace,
  type WorkspaceInfo,
} from '@/shared/types';
import { SSHContext } from '@/features/ssh-remote/SSHRemoteContext';

interface WorkspaceItemProps {
  workspace: WorkspaceInfo;
  isActive: boolean;
  isSingle?: boolean;
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: React.DragEventHandler<HTMLDivElement>;
  onDragEnd?: React.DragEventHandler<HTMLDivElement>;
}

const WorkspaceItem: React.FC<WorkspaceItemProps> = ({
  workspace,
  isActive,
  isSingle = false,
  draggable = false,
  isDragging = false,
  onDragStart,
  onDragEnd,
}) => {
  const { t } = useI18n('common');
  const {
    setActiveWorkspace,
    closeWorkspaceById,
  } = useWorkspaceContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [isTaskWs, setIsTaskWs] = useState(false);

  useEffect(() => {
    let cancelled = false;
    globalAPI.isTaskWorkspace(workspace.rootPath).then(result => {
      if (!cancelled) setIsTaskWs(result);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [workspace.rootPath]);

  // Remote connection status — optional: safe if not inside SSHRemoteProvider
  const sshContext = useContext(SSHContext);
  const remoteConnStatus = workspace.connectionId && sshContext
    ? (sshContext.workspaceStatuses[workspace.connectionId] ?? 'connecting')
    : undefined;

  const handleCollapseToggle = useCallback(() => {
    setSessionsCollapsed(prev => !prev);
  }, []);

  const handleCardNameClick = useCallback(async () => {
    if (!isActive) {
      await setActiveWorkspace(workspace.id);
    } else {
      setSessionsCollapsed(prev => !prev);
    }
  }, [isActive, setActiveWorkspace, workspace.id]);

  const handleCloseWorkspace = useCallback(async () => {
    try {
      await closeWorkspaceById(workspace.id);
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.closeFailed'),
        { duration: 4000 }
      );
    }
  }, [closeWorkspaceById, t, workspace.id]);

  const handleReveal = useCallback(async () => {
    if (isRemoteWorkspace(workspace)) return;
    try {
      await workspaceAPI.revealInExplorer(workspace.rootPath);
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.revealFailed'),
        { duration: 4000 }
      );
    }
  }, [t, workspace]);

  const handleCopyWorkspacePath = useCallback(async () => {
    const path = workspace.rootPath;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      notificationService.success(t('contextMenu.status.copyPathSuccess'), { duration: 2000 });
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.copyPathFailed'),
        { duration: 4000 }
      );
    }
  }, [t, workspace.rootPath]);

  const handleCreateSession = useCallback(async (mode?: 'Code') => {
    try {
      const reusableId = findReusableEmptySessionId(workspace, mode);
      if (reusableId) {
        await openMainSession(reusableId, {
          workspaceId: workspace.id,
          activateWorkspace: setActiveWorkspace,
        });
        return;
      }
      await flowChatManager.createChatSession(
        {
          workspacePath: workspace.rootPath,
          ...(isRemoteWorkspace(workspace) && workspace.connectionId
            ? { remoteConnectionId: workspace.connectionId }
            : {}),
        },
        mode
      );
      await setActiveWorkspace(workspace.id);
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.createSessionFailed'),
        { duration: 4000 }
      );
    }
  }, [
    setActiveWorkspace,
    t,
    workspace,
  ]);

  const handleCreateNewSession = useCallback(() => {
    void handleCreateSession('Code');
  }, [handleCreateSession]);

  const handleCreateInitSession = useCallback(async () => {
    try {
      const sessionId = await flowChatManager.createChatSession(
        {
          workspacePath: workspace.rootPath,
          ...(isRemoteWorkspace(workspace) && workspace.connectionId
            ? { remoteConnectionId: workspace.connectionId }
            : {}),
          ...(isRemoteWorkspace(workspace) && workspace.sshHost
            ? { remoteSshHost: workspace.sshHost }
            : {}),
        },
        'Init'
      );

      await openMainSession(sessionId, {
        workspaceId: workspace.id,
        activateWorkspace: setActiveWorkspace,
      });

      const initPrompt = i18nService.t('flow-chat:chatInput.initPrompt', {
        defaultValue: 'Please generate or update AGENTS.md so it matches the current project. Write it in English and keep the English version complete.',
      });

      await flowChatManager.sendMessage(initPrompt, sessionId, initPrompt, 'Init');
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.initSessionFailed'),
        { duration: 4000 }
      );
    }
  }, [setActiveWorkspace, t, workspace]);

  return (
    <div className={[
      'ai00-x-nav-panel__workspace-item',
      isActive && 'is-active',
      isDragging && 'is-dragging',
      menuOpen && 'is-menu-open',
      sessionsCollapsed && 'is-sessions-collapsed',
      isSingle && 'is-single',
    ].filter(Boolean).join(' ')}
    aria-current={isActive ? 'location' : undefined}
    aria-grabbed={draggable ? isDragging : undefined}>
      <div
        className="ai00-x-nav-panel__workspace-item-card"
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <button
          type="button"
          className="ai00-x-nav-panel__workspace-item-collapse-btn"
          onClick={handleCollapseToggle}
          aria-label={sessionsCollapsed ? t('nav.workspaces.expandSessions') : t('nav.workspaces.collapseSessions')}
          aria-expanded={!sessionsCollapsed}
        >
          <span className="ai00-x-nav-panel__workspace-item-icon" aria-hidden="true">
            <span className="ai00-x-nav-panel__workspace-item-icon-default">
              {isActive ? (
                <span className="ai00-x-nav-panel__workspace-item-active-icon">
                  <DotMatrixArrowRightIcon size={14} />
                </span>
              ) : (
                <FolderOpen size={14} />
              )}
            </span>
            <span className={`ai00-x-nav-panel__workspace-item-icon-toggle${sessionsCollapsed ? ' is-collapsed' : ''}`}>
              <ChevronDown size={14} />
            </span>
          </span>
        </button>
        <button
          type="button"
          className="ai00-x-nav-panel__workspace-item-name-btn"
          onClick={() => { void handleCardNameClick(); }}
        >
          <span className={`ai00-x-nav-panel__workspace-item-title${isRemoteWorkspace(workspace) ? ' is-remote' : ''}`}>
            <span className="ai00-x-nav-panel__workspace-item-label">
              {workspace.name}
            </span>
            {isTaskWs && (
              <span className="ai00-x-nav-panel__workspace-item-badge">{t('nav.workspaces.taskBadge')}</span>
            )}
            {isRemoteWorkspace(workspace) && (
              <span className="ai00-x-nav-panel__workspace-item-subtitle">
                <span
                  className={`ai00-x-nav-panel__workspace-item-status-dot is-${remoteConnStatus ?? 'connecting'}`}
                  aria-label={remoteConnStatus ?? 'connecting'}
                />
                <span>{workspace.connectionName}</span>
              </span>
            )}
          </span>
        </button>

        <div className="ai00-x-nav-panel__workspace-item-menu">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`ai00-x-nav-panel__workspace-item-menu-trigger${menuOpen ? ' is-open' : ''}`}
              >
                <MoreHorizontal size={14} />
              </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="start" sideOffset={6} data-no-penetrate>
              <DropdownMenuItem onClick={handleCreateNewSession}>
                <Plus size={13} />
                <span>{t('nav.sessions.newSessionShort')}</span>
              </DropdownMenuItem>
              {!isTaskWs && (
                <DropdownMenuItem onClick={() => { void handleCreateInitSession(); }}>
                  <FileText size={13} />
                  <span>{t('nav.workspaces.actions.initAgents')}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => { void handleCopyWorkspacePath(); }}
                disabled={!workspace.rootPath}
              >
                <Copy size={13} />
                <span>{t('nav.workspaces.actions.copyPath')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => { void handleReveal(); }}
                disabled={isRemoteWorkspace(workspace)}
              >
                <FolderSearch size={13} />
                <span>{t('nav.workspaces.actions.reveal')}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {!isTaskWs && (
                <DropdownMenuItem destructive onClick={() => { void handleCloseWorkspace(); }}>
                  <FolderOpen size={13} />
                  <span>{t('nav.workspaces.actions.close')}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className={`ai00-x-nav-panel__workspace-item-sessions${sessionsCollapsed ? ' is-collapsed' : ''}`}>
        <SessionsSection
          workspaceId={workspace.id}
          workspacePath={workspace.rootPath}
          remoteConnectionId={isRemoteWorkspace(workspace) ? workspace.connectionId : null}
          remoteSshHost={isRemoteWorkspace(workspace) ? workspace.sshHost : null}
          isActiveWorkspace={isActive}
        />
      </div>

    </div>
  );
};

export default WorkspaceItem;
