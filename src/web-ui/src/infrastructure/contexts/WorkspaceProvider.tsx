import React, { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workspaceManager } from '../services/business/workspaceManager';
import { WorkspaceInfo } from '../../shared/types';
import { createLogger } from '@/shared/utils/logger';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
  getWorkspaceDisplayName,
} from './WorkspaceContext';

const log = createLogger('WorkspaceProvider');

interface WorkspaceProviderProps {
  children: ReactNode;
}

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({ children }) => {
  const [state, setState] = useState<WorkspaceContextValue>(() => {
    try {
      const initialState = workspaceManager.getState();
      const activeWorkspace = initialState.currentWorkspace;
      const openedWorkspacesList = Array.from(initialState.openedWorkspaces.values());

      return {
        ...initialState,
        activeWorkspace,
        openedWorkspacesList,
        normalWorkspacesList: openedWorkspacesList,
        openWorkspace: async (path: string) => workspaceManager.openWorkspace(path),
        closeWorkspace: async () => workspaceManager.closeWorkspace(),
        closeWorkspaceById: async (workspaceId: string) => workspaceManager.closeWorkspaceById(workspaceId),
        switchWorkspace: async (workspace: WorkspaceInfo) => workspaceManager.switchWorkspace(workspace),
        setActiveWorkspace: async (workspaceId: string) => workspaceManager.setActiveWorkspace(workspaceId),
        reorderOpenedWorkspacesInSection: async (
          section: 'projects',
          sourceWorkspaceId: string,
          targetWorkspaceId: string,
          position: 'before' | 'after'
        ) =>
          workspaceManager.reorderOpenedWorkspacesInSection(
            section,
            sourceWorkspaceId,
            targetWorkspaceId,
            position
          ),
        scanWorkspaceInfo: async () => workspaceManager.scanWorkspaceInfo(),
        refreshRecentWorkspaces: async () => workspaceManager.refreshRecentWorkspaces(),
        removeWorkspaceFromRecent: async (workspaceId: string) =>
          workspaceManager.removeWorkspaceFromRecent(workspaceId),
        hasWorkspace: !!activeWorkspace,
        workspaceName: getWorkspaceDisplayName(activeWorkspace),
        workspacePath: activeWorkspace?.rootPath || '',
      };
    } catch (error) {
      log.warn('WorkspaceManager not initialized, using default state', error);
      return {
        currentWorkspace: null,
        openedWorkspaces: new Map(),
        activeWorkspaceId: null,
        lastUsedWorkspaceId: null,
        recentWorkspaces: [],
        loading: false,
        error: null,
        activeWorkspace: null,
        openedWorkspacesList: [],
        normalWorkspacesList: [],
        openWorkspace: async (path: string) => workspaceManager.openWorkspace(path),
        closeWorkspace: async () => workspaceManager.closeWorkspace(),
        closeWorkspaceById: async (workspaceId: string) => workspaceManager.closeWorkspaceById(workspaceId),
        switchWorkspace: async (workspace: WorkspaceInfo) => workspaceManager.switchWorkspace(workspace),
        setActiveWorkspace: async (workspaceId: string) => workspaceManager.setActiveWorkspace(workspaceId),
        reorderOpenedWorkspacesInSection: async (
          section: 'projects',
          sourceWorkspaceId: string,
          targetWorkspaceId: string,
          position: 'before' | 'after'
        ) =>
          workspaceManager.reorderOpenedWorkspacesInSection(
            section,
            sourceWorkspaceId,
            targetWorkspaceId,
            position
          ),
        scanWorkspaceInfo: async () => workspaceManager.scanWorkspaceInfo(),
        refreshRecentWorkspaces: async () => workspaceManager.refreshRecentWorkspaces(),
        removeWorkspaceFromRecent: async (workspaceId: string) =>
          workspaceManager.removeWorkspaceFromRecent(workspaceId),
        hasWorkspace: false,
        workspaceName: '',
        workspacePath: '',
      };
    }
  });

  const isInitializedRef = useRef(false);

  useEffect(() => {
    const removeListener = workspaceManager.addEventListener(() => {
      setState((prev) => {
        const nextState = workspaceManager.getState();
        const activeWorkspace = nextState.currentWorkspace;
        const openedWorkspacesList = Array.from(nextState.openedWorkspaces.values());

        return {
          ...prev,
          ...nextState,
          activeWorkspace,
          openedWorkspacesList,
          normalWorkspacesList: openedWorkspacesList,
          hasWorkspace: !!activeWorkspace,
          workspaceName: getWorkspaceDisplayName(activeWorkspace),
          workspacePath: activeWorkspace?.rootPath || '',
        };
      });
    });

    return () => {
      removeListener();
    };
  }, []);

  useEffect(() => {
    const initializeWorkspace = async () => {
      if (isInitializedRef.current) {
        return;
      }

      try {
        isInitializedRef.current = true;
        setState((prev) => ({ ...prev, loading: true }));
        await workspaceManager.initialize();
        const nextState = workspaceManager.getState();
        const activeWorkspace = nextState.currentWorkspace;
        const openedWorkspacesList = Array.from(nextState.openedWorkspaces.values());

        setState((prev) => ({
          ...prev,
          ...nextState,
          activeWorkspace,
          openedWorkspacesList,
          normalWorkspacesList: openedWorkspacesList,
          hasWorkspace: !!activeWorkspace,
          workspaceName: getWorkspaceDisplayName(activeWorkspace),
          workspacePath: activeWorkspace?.rootPath || '',
        }));
      } catch (error) {
        log.error('Failed to initialize workspace state', error);
        isInitializedRef.current = false;
        setState((prev) => ({ ...prev, loading: false, error: String(error) }));
      }
    };

    void initializeWorkspace();
  }, []);

  const openWorkspace = useCallback(async (path: string): Promise<WorkspaceInfo> => {
    return await workspaceManager.openWorkspace(path);
  }, []);

  const closeWorkspace = useCallback(async (): Promise<void> => {
    return await workspaceManager.closeWorkspace();
  }, []);

  const closeWorkspaceById = useCallback(async (workspaceId: string): Promise<void> => {
    return await workspaceManager.closeWorkspaceById(workspaceId);
  }, []);

  const switchWorkspace = useCallback(async (workspace: WorkspaceInfo): Promise<WorkspaceInfo> => {
    return await workspaceManager.switchWorkspace(workspace);
  }, []);

  const setActiveWorkspace = useCallback(async (workspaceId: string): Promise<WorkspaceInfo> => {
    return await workspaceManager.setActiveWorkspace(workspaceId);
  }, []);

  const reorderOpenedWorkspacesInSection = useCallback(async (
    section: 'projects',
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
    position: 'before' | 'after'
  ): Promise<void> => {
    return await workspaceManager.reorderOpenedWorkspacesInSection(
      section,
      sourceWorkspaceId,
      targetWorkspaceId,
      position
    );
  }, []);

  const scanWorkspaceInfo = useCallback(async (): Promise<WorkspaceInfo | null> => {
    return await workspaceManager.scanWorkspaceInfo();
  }, []);

  const refreshRecentWorkspaces = useCallback(async (): Promise<void> => {
    return await workspaceManager.refreshRecentWorkspaces();
  }, []);

  const removeWorkspaceFromRecent = useCallback(async (workspaceId: string): Promise<void> => {
    return await workspaceManager.removeWorkspaceFromRecent(workspaceId);
  }, []);

  const contextValue = useMemo<WorkspaceContextValue>(() => {
    const activeWorkspace = state.currentWorkspace;
    const openedWorkspacesList = Array.from(state.openedWorkspaces.values());

    return {
      ...state,
      activeWorkspace,
      openedWorkspacesList,
      normalWorkspacesList: openedWorkspacesList,
      openWorkspace,
      closeWorkspace,
      closeWorkspaceById,
      switchWorkspace,
      setActiveWorkspace,
      reorderOpenedWorkspacesInSection,
      scanWorkspaceInfo,
      refreshRecentWorkspaces,
      removeWorkspaceFromRecent,
      hasWorkspace: !!activeWorkspace,
      workspaceName: getWorkspaceDisplayName(activeWorkspace),
      workspacePath: activeWorkspace?.rootPath || '',
    };
  }, [
    state,
    openWorkspace,
    closeWorkspace,
    closeWorkspaceById,
    switchWorkspace,
    setActiveWorkspace,
    reorderOpenedWorkspacesInSection,
    scanWorkspaceInfo,
    refreshRecentWorkspaces,
    removeWorkspaceFromRecent,
  ]);

  return <WorkspaceContext.Provider value={contextValue}>{children}</WorkspaceContext.Provider>;
};