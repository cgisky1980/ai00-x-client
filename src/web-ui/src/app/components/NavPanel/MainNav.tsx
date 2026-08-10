/**
 * MainNav — default workspace navigation sidebar.
 *
 * Layout (top to bottom):
 *   1. Workspace
 *   2. Bottom: Extensions (定制) (expand → Agents | Skills | ...)
 *
 * When a scene-nav transition is active (`isDeparting=true`), items receive
 * positional CSS classes for the split-open animation effect.
 */

import React, { useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { usePortalContainer } from '@/infrastructure/contexts/PortalContainerContext';
import { Plus, FolderOpen, FolderPlus, History, Check, CheckSquare, Code } from 'lucide-react';
import { Tooltip } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { SceneTabId } from '../SceneBar/types';
import SectionHeader from './components/SectionHeader';
import WorkspaceListSection from './sections/workspaces/WorkspaceListSection';
import SessionsSection from './sections/sessions/SessionsSection';
import { useModeStore } from '../../stores/modeStore';
import { useSceneStore } from '../../stores/sceneStore';
import { globalAPI } from '@/infrastructure/api/service-api/GlobalAPI';
import { FlowChatManager } from '@/flow_chat/services/FlowChatManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { createLogger } from '@/shared/utils/logger';
import { WorkspaceKind } from '@/shared/types';
import { getRecentWorkspaceLineParts } from '@/shared/utils/recentWorkspaceDisplay';
import { useSSHRemoteContext, SSHConnectionDialog, RemoteFileBrowser } from '@/features/ssh-remote';

import './NavPanel.scss';

const log = createLogger('MainNav');

interface MainNavProps {
  isDeparting?: boolean;
  anchorNavSceneId?: SceneTabId | null;
}

const MainNav: React.FC<MainNavProps> = ({
  isDeparting: _isDeparting = false,
  anchorNavSceneId: _anchorNavSceneId = null,
}) => {
  const sshRemote = useSSHRemoteContext();
  const [isSSHConnectionDialogOpen, setIsSSHConnectionDialogOpen] = useState(false);
  const activeMode = useModeStore(s => s.activeMode);
  const isTaskMode = activeMode === 'task';

  const [taskWorkspacePath, setTaskWorkspacePath] = useState<string>('');
  useEffect(() => {
    globalAPI.getTaskWorkspacePath().then(setTaskWorkspacePath).catch(() => {});
  }, []);

  useEffect(() => {
    if (sshRemote.showFileBrowser) {
      setIsSSHConnectionDialogOpen(false);
    }
  }, [sshRemote.showFileBrowser]);


  const { t } = useI18n('common');
  const {
    currentWorkspace,
    recentWorkspaces: allRecentWorkspaces,
    openedWorkspacesList,
    switchWorkspace,
  } = useWorkspaceContext();

  const recentWorkspaces = useMemo(() => {
    if (isTaskMode) return allRecentWorkspaces;
    return allRecentWorkspaces.filter(ws => {
      if (taskWorkspacePath && ws.rootPath === taskWorkspacePath) return false;
      return true;
    });
  }, [allRecentWorkspaces, isTaskMode, taskWorkspacePath]);

  const portalContainer = usePortalContainer();
  const portalTarget = portalContainer ?? document.body;

  const workspaceMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceMenuClosing, setWorkspaceMenuClosing] = useState(false);
  const [workspaceMenuPos, setWorkspaceMenuPos] = useState({ top: 0, left: 0 });

  const closeWorkspaceMenu = useCallback(() => {
    setWorkspaceMenuClosing(true);
    window.setTimeout(() => {
      setWorkspaceMenuOpen(false);
      setWorkspaceMenuClosing(false);
    }, 150);
  }, []);

  const openWorkspaceMenu = useCallback(async () => {
    try {
      await workspaceManager.cleanupInvalidWorkspaces();
    } catch (error) {
      log.warn('Failed to cleanup invalid workspaces before opening workspace menu', { error });
    }
    const rect = workspaceMenuButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setWorkspaceMenuPos({ top: rect.bottom + 6, left: rect.left });
    setWorkspaceMenuOpen(true);
    setWorkspaceMenuClosing(false);
  }, []);

  const toggleWorkspaceMenu = useCallback(() => {
    if (workspaceMenuOpen) { closeWorkspaceMenu(); return; }
    void openWorkspaceMenu();
  }, [closeWorkspaceMenu, openWorkspaceMenu, workspaceMenuOpen]);

  useEffect(() => {
    openedWorkspacesList.forEach(workspace => {
      if (workspace.workspaceKind === WorkspaceKind.Remote) {
        void flowChatStore.initializeFromDisk(
          workspace.rootPath,
          workspace.connectionId ?? undefined,
          workspace.sshHost ?? undefined
        );
      } else {
        void flowChatStore.initializeFromDisk(workspace.rootPath);
      }
    });
  }, [openedWorkspacesList]);

  const handleOpenProject = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false, title: t('header.selectProjectDirectory') });
      if (selected && typeof selected === 'string') {
        await workspaceManager.openWorkspace(selected);
      }
    } catch (err) {
      log.error('Failed to open project', err);
    }
  }, [t]);

  const handleNewProject = useCallback(() => {
    window.dispatchEvent(new Event('nav:new-project'));
  }, []);

  const handleSwitchWorkspace = useCallback(async (workspaceId: string) => {
    const targetWorkspace = recentWorkspaces.find(item => item.id === workspaceId);
    if (!targetWorkspace) return;
    closeWorkspaceMenu();
    await switchWorkspace(targetWorkspace);
  }, [closeWorkspaceMenu, recentWorkspaces, switchWorkspace]);

  const handleOpenRemoteSSH = useCallback(() => {
    closeWorkspaceMenu();
    setIsSSHConnectionDialogOpen(true);
  }, [closeWorkspaceMenu]);

  const handleSelectRemoteWorkspace = useCallback(async (path: string) => {
    try {
      await sshRemote.openWorkspace(path);
      sshRemote.setShowFileBrowser(false);
      setIsSSHConnectionDialogOpen(false);
    } catch (err) {
      log.error('Failed to open remote workspace', err);
    }
  }, [sshRemote]);

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (workspaceMenuButtonRef.current?.contains(target)) return;
      if (workspaceMenuRef.current?.contains(target)) return;
      closeWorkspaceMenu();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeWorkspaceMenu();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [closeWorkspaceMenu, workspaceMenuOpen]);

  const workspaceMenuPortal = workspaceMenuOpen ? createPortal(
    <div
      ref={workspaceMenuRef}
      className={`ai00-x-nav-panel__workspace-menu${workspaceMenuClosing ? ' is-closing' : ''}`}
      data-no-penetrate
      role="menu"
      style={{ top: workspaceMenuPos.top, left: workspaceMenuPos.left }}
    >
      <button
        type="button"
        className="ai00-x-nav-panel__workspace-menu-item"
        role="menuitem"
        onClick={() => { closeWorkspaceMenu(); void handleOpenProject(); }}
      >
        <FolderOpen size={13} />
        <span>{t('header.openProject')}</span>
      </button>
      <button
        type="button"
        className="ai00-x-nav-panel__workspace-menu-item"
        role="menuitem"
        onClick={() => { closeWorkspaceMenu(); handleNewProject(); }}
      >
        <FolderPlus size={13} />
        <span>{t('header.newProject')}</span>
      </button>
      <button
        type="button"
        className="ai00-x-nav-panel__workspace-menu-item"
        role="menuitem"
        onClick={handleOpenRemoteSSH}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0-6v6" />
        </svg>
        <span>{t('ssh.remote.connect')}</span>
      </button>
      <div className="ai00-x-nav-panel__workspace-menu-divider" role="separator" />
      <div className="ai00-x-nav-panel__workspace-menu-section-title">
        <History size={12} aria-hidden="true" />
        <span>{t('header.recentWorkspaces')}</span>
      </div>
      {recentWorkspaces.length === 0 ? (
        <div className="ai00-x-nav-panel__workspace-menu-empty">
          <span>{t('header.noRecentWorkspaces')}</span>
        </div>
      ) : (
        <div className="ai00-x-nav-panel__workspace-menu-workspaces">
          {recentWorkspaces.map((workspace) => {
            const { hostPrefix, folderLabel, tooltip } = getRecentWorkspaceLineParts(workspace);
            return (
            <button
              key={workspace.id}
              type="button"
              className="ai00-x-nav-panel__workspace-menu-item ai00-x-nav-panel__workspace-menu-item--workspace"
              role="menuitem"
              title={tooltip}
              onClick={() => { void handleSwitchWorkspace(workspace.id); }}
            >
              <FolderOpen size={13} aria-hidden="true" />
              <span className="ai00-x-nav-panel__workspace-menu-item-main">
                {hostPrefix ? (
                  <>
                    <span className="ai00-x-nav-panel__workspace-menu-item-host">{hostPrefix}</span>
                    <span className="ai00-x-nav-panel__workspace-menu-item-host-sep" aria-hidden>
                      ·
                    </span>
                  </>
                ) : null}
                <span className="ai00-x-nav-panel__workspace-menu-item-name">{folderLabel}</span>
              </span>
              {workspace.id === currentWorkspace?.id ? <Check size={12} aria-hidden="true" /> : null}
            </button>
            );
          })}
        </div>
      )}
    </div>,
    portalTarget
  ) : null;

  const addWorkspaceTooltip = t('nav.tooltips.addWorkspace');

  const openScene = useSceneStore(s => s.openScene);

  const handleNewTask = useCallback(async () => {
    try {
      let wsPath = taskWorkspacePath;
      if (!wsPath) {
        wsPath = await globalAPI.getTaskWorkspacePath();
        setTaskWorkspacePath(wsPath);
      }
      const manager = FlowChatManager.getInstance();
      await manager.createChatSession({ workspacePath: wsPath, sessionDisplayMode: 'task' }, 'Task');
      openScene('session');
    } catch (e) {
      log.error('Failed to create task session', e);
    }
  }, [taskWorkspacePath, openScene]);

  return (
    <>
      <div className="ai00-x-nav-panel__sections">

        {isTaskMode ? (
          <div className="ai00-x-nav-panel__section">
            <SectionHeader
              label={t('nav.modes.task')}
              icon={<CheckSquare size={12} />}
              collapsible={false}
              isOpen
              actions={
                <Tooltip content={t('welcomeScene.task.newTask')} placement="right" followCursor>
                  <button
                    type="button"
                    className="ai00-x-nav-panel__section-action"
                    aria-label={t('welcomeScene.task.newTask')}
                    onClick={handleNewTask}
                  >
                    <Plus size={13} />
                  </button>
                </Tooltip>
              }
            />
            <div className="ai00-x-nav-panel__items">
              {taskWorkspacePath && (
                <SessionsSection
                  workspacePath={taskWorkspacePath}
                  isActiveWorkspace
                />
              )}
            </div>
          </div>
        ) : (
          <div className="ai00-x-nav-panel__section">
            <SectionHeader
              label={t('nav.sections.workspace')}
              icon={<Code size={12} />}
              collapsible={false}
              isOpen
              actions={
                <div className="ai00-x-nav-panel__workspace-action-wrap">
                  <Tooltip content={addWorkspaceTooltip} placement="right" followCursor disabled={workspaceMenuOpen}>
                    <button
                      ref={workspaceMenuButtonRef}
                      type="button"
                      className={`ai00-x-nav-panel__section-action${workspaceMenuOpen ? ' is-active' : ''}`}
                      aria-label={addWorkspaceTooltip}
                      aria-expanded={workspaceMenuOpen}
                      onClick={toggleWorkspaceMenu}
                    >
                      <Plus size={13} />
                    </button>
                  </Tooltip>
                </div>
              }
            />
            <div className="ai00-x-nav-panel__items">
              <WorkspaceListSection variant="projects" />
            </div>
          </div>
        )}

      </div>

      {workspaceMenuPortal}

      <SSHConnectionDialog
        open={isSSHConnectionDialogOpen}
        onClose={() => setIsSSHConnectionDialogOpen(false)}
      />
      {sshRemote.showFileBrowser && sshRemote.connectionId && (
        <RemoteFileBrowser
          connectionId={sshRemote.connectionId}
          initialPath={sshRemote.remoteFileBrowserInitialPath}
          homePath={sshRemote.remoteFileBrowserInitialPath}
          onSelect={handleSelectRemoteWorkspace}
          onCancel={() => {
            sshRemote.setShowFileBrowser(false);
            void sshRemote.disconnect();
          }}
        />
      )}
    </>
  );
};

export default MainNav;
