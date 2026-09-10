import { useState, useCallback, useEffect, useMemo } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useWorkspaceContext } from '../../infrastructure/contexts/WorkspaceContext';
import { workspaceAPI } from '@/infrastructure/api';
import { createLogger } from '@/shared/utils/logger';
import { useI18n } from '@/infrastructure/i18n';
import { useApp } from './useApp';

const log = createLogger('CoreLayoutInit');

export interface CoreLayoutInitResult {
  showNewProjectDialog: boolean;
  setShowNewProjectDialog: (v: boolean) => void;
  showAboutDialog: boolean;
  setShowAboutDialog: (v: boolean) => void;
  showWorkspaceStatus: boolean;
  setShowWorkspaceStatus: (v: boolean) => void;
  handleOpenProject: () => Promise<void>;
  handleNewProject: () => void;
  handleShowAbout: () => void;
  handleConfirmNewProject: (parentPath: string, projectName: string) => Promise<void>;
  hasWorkspace: boolean;
  currentWorkspace: ReturnType<typeof useWorkspaceContext>['currentWorkspace'];
  showSplash: boolean;
  setShowSplash: (v: boolean) => void;
  splashVisible: boolean;
  setSplashVisible: (v: boolean) => void;
  splashExiting: boolean;
  setSplashExiting: (v: boolean) => void;
}

export function useCoreLayoutInit(): CoreLayoutInitResult {
  const { t } = useI18n('components');
  const {
    currentWorkspace,
    hasWorkspace,
    openWorkspace,
  } = useWorkspaceContext();


  const { state, switchLeftPanelTab, toggleLeftPanel, toggleRightPanel } = useApp();


  // No longer auto-open recent workspace on startup.
  // Each mode (Code/Task/Wallpaper) shows its own welcome page.

  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [showAboutDialog, setShowAboutDialog] = useState(false);
  const [showWorkspaceStatus, setShowWorkspaceStatus] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashExiting, setSplashExiting] = useState(false);

  const handleOpenProject = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('header.selectProjectDirectory'),
      });
      if (selected && typeof selected === 'string') {
        await openWorkspace(selected);
      }
    } catch (error) {
      log.error('Failed to open project', error);
    }
  }, [openWorkspace, t]);

  const handleNewProject = useCallback(() => setShowNewProjectDialog(true), []);
  const handleShowAbout = useCallback(() => setShowAboutDialog(true), []);

  const handleConfirmNewProject = useCallback(async (parentPath: string, projectName: string) => {
    const normalized = parentPath.replace(/\\/g, '/');
    const newProjectPath = `${normalized}/${projectName}`;
    try {
      await workspaceAPI.createDirectory(newProjectPath);
      await openWorkspace(newProjectPath);
    } catch (error) {
      log.error('Failed to create project', error);
      throw error;
    }
  }, [openWorkspace]);

  useEffect(() => {
    const onOpenProject = () => { void handleOpenProject(); };
    const onNewProject = () => handleNewProject();
    window.addEventListener('nav:open-project', onOpenProject);
    window.addEventListener('nav:new-project', onNewProject);
    return () => {
      window.removeEventListener('nav:open-project', onOpenProject);
      window.removeEventListener('nav:new-project', onNewProject);
    };
  }, [handleNewProject, handleOpenProject]);

  const isMacOS = useMemo(() => {
    const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
    return isTauri && typeof navigator?.platform === 'string' && navigator.platform.toUpperCase().includes('MAC');
  }, []);

  useEffect(() => {
    if (!isMacOS) return;
    let unlistenFns: Array<() => void> = [];
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { open } = await import('@tauri-apps/plugin-dialog');
        unlistenFns.push(await listen('ai00-x_menu_open_project', async () => {
          try {
            const selected = await open({ directory: true, multiple: false }) as string;
            if (selected) await openWorkspace(selected);
          } catch {}
        }));
        unlistenFns.push(await listen('ai00-x_menu_new_project', () => handleNewProject()));
        unlistenFns.push(await listen('ai00-x_menu_about', () => handleShowAbout()));
      } catch {}
    })();
    return () => { unlistenFns.forEach(fn => fn()); unlistenFns = []; };
  }, [isMacOS, openWorkspace, handleNewProject, handleShowAbout]);


  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let saveCompleted = false;
    const setupWindowCloseListener = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        unlistenFn = await currentWindow.onCloseRequested(async (event: { preventDefault: () => void }) => {
          if (saveCompleted) return;
          event.preventDefault();
          saveCompleted = true;
          await currentWindow.close();
        });
      } catch (error) {
        log.error('Failed to setup window close listener', error);
      }
    };
    setupWindowCloseListener();
    return () => { if (unlistenFn) unlistenFn(); };
  }, []);

  useEffect(() => {
    const handleSwitchToFilesPanel = () => {
      switchLeftPanelTab('files');
      if (state.layout.leftPanelCollapsed) toggleLeftPanel();
      if (state.layout.rightPanelCollapsed) {
        setTimeout(() => toggleRightPanel(), 100);
      }
    };
    window.addEventListener('switch-to-files-panel', handleSwitchToFilesPanel);
    return () => window.removeEventListener('switch-to-files-panel', handleSwitchToFilesPanel);
  }, [state.layout.leftPanelCollapsed, state.layout.rightPanelCollapsed, switchLeftPanelTab, toggleLeftPanel, toggleRightPanel]);

  useEffect(() => {
    const handleToolbarSendMessage = async (event: Event) => {
      const customEvent = event as CustomEvent<{ message: string; sessionId: string }>;
      const { message, sessionId } = customEvent.detail;
      if (message && sessionId) {
        try {
          const { dshSession } = await import('@/infrastructure/api/service-api/DshAPI');
          await dshSession.prompt(sessionId, message);
        } catch (error) {
          log.error('Failed to send toolbar message', error);
        }
      }
    };
    window.addEventListener('toolbar-send-message', handleToolbarSendMessage);
    return () => window.removeEventListener('toolbar-send-message', handleToolbarSendMessage);
  }, []);

  useEffect(() => {
    const handleToolbarCancelTask = async () => {
      try {
        const { dshSession } = await import('@/infrastructure/api/service-api/DshAPI');
        // 取消当前活跃 dsh 会话（工具条只关心最近一个）
        const { items } = await dshSession.list();
        const running = items.find(it => it.running);
        if (running) await dshSession.cancel(running.sessionId);
      } catch (error) {
        log.error('Failed to cancel toolbar task', error);
      }
    };
    window.addEventListener('toolbar-cancel-task', handleToolbarCancelTask);
    return () => window.removeEventListener('toolbar-cancel-task', handleToolbarCancelTask);
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let unlistenAceStepFn: (() => void) | null = null;
    let unlistenDshFn: (() => void) | null = null;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { useSceneStore } = await import('@/app/stores/sceneStore');
        const { useModeStore } = await import('@/app/stores/modeStore');
        unlistenFn = await listen('open-settings-scene', () => {
          useSceneStore.getState().openScene('settings');
        });
        unlistenAceStepFn = await listen('open-acestep-scene', () => {
          useModeStore.getState().setActiveMode('music');
          useSceneStore.getState().openScene('acestep');
        });
        // dsh Agent 场景唤起（策窗口委托交付链路）
        unlistenDshFn = await listen('open-dsh-scene', () => {
          useSceneStore.getState().openScene('dsh');
        });
      } catch {}
    })();
    return () => {
      if (unlistenFn) unlistenFn();
      if (unlistenAceStepFn) unlistenAceStepFn();
      if (unlistenDshFn) unlistenDshFn();
    };
  }, []);

  const handleCreateFlowChatSession = useCallback(async () => {
    // 会话创建收敛到 dsh 场景
    window.dispatchEvent(new CustomEvent('scene:open', { detail: { sceneId: 'dsh' } }));
  }, []);

  useEffect(() => {
    const handler = () => {
      void handleCreateFlowChatSession();
    };
    window.addEventListener('toolbar-create-session', handler);
    return () => window.removeEventListener('toolbar-create-session', handler);
  }, [handleCreateFlowChatSession]);

  useEffect(() => {
    const handleDragStart = (e: DragEvent) => {
      if (e.dataTransfer) {
        if (e.dataTransfer.types.length === 0) e.dataTransfer.setData('text/plain', 'dragging');
        e.dataTransfer.effectAllowed = 'copy';
      }
    };
    const handleDragOver = (e: DragEvent) => e.preventDefault();
    const handleDragEnter = (_e: DragEvent) => {};
    const handleDrop = (e: DragEvent) => { if (!e.defaultPrevented) e.preventDefault(); };

    document.addEventListener('dragstart', handleDragStart, true);
    document.addEventListener('dragover', handleDragOver, true);
    document.addEventListener('dragenter', handleDragEnter, true);
    document.addEventListener('drop', handleDrop, true);

    return () => {
      document.removeEventListener('dragstart', handleDragStart, true);
      document.removeEventListener('dragover', handleDragOver, true);
      document.removeEventListener('dragenter', handleDragEnter, true);
      document.removeEventListener('drop', handleDrop, true);
    };
  }, []);

  return {
    showNewProjectDialog,
    setShowNewProjectDialog,
    showAboutDialog,
    setShowAboutDialog,
    showWorkspaceStatus,
    setShowWorkspaceStatus,
    handleOpenProject,
    handleNewProject,
    handleShowAbout,
    handleConfirmNewProject,
    hasWorkspace,
    currentWorkspace,
    showSplash,
    setShowSplash,
    splashVisible,
    setSplashVisible,
    splashExiting,
    setSplashExiting,
  };
}
