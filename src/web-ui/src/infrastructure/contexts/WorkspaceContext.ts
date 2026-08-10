 
import { createContext, useContext, useEffect } from 'react';
import { workspaceManager, WorkspaceState, WorkspaceEvent } from '../services/business/workspaceManager';
import { WorkspaceInfo } from '../../shared/types';

export const getWorkspaceDisplayName = (workspace: WorkspaceInfo | null): string => {
  if (!workspace) {
    return '';
  }

  return workspace.name;
};

export interface WorkspaceContextValue extends WorkspaceState {
  activeWorkspace: WorkspaceInfo | null;
  openedWorkspacesList: WorkspaceInfo[];
  normalWorkspacesList: WorkspaceInfo[];
  openWorkspace: (path: string) => Promise<WorkspaceInfo>;
  closeWorkspace: () => Promise<void>;
  closeWorkspaceById: (workspaceId: string) => Promise<void>;
  switchWorkspace: (workspace: WorkspaceInfo) => Promise<WorkspaceInfo>;
  setActiveWorkspace: (workspaceId: string) => Promise<WorkspaceInfo>;
  reorderOpenedWorkspacesInSection: (
    section: 'projects',
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
    position: 'before' | 'after'
  ) => Promise<void>;
  scanWorkspaceInfo: () => Promise<WorkspaceInfo | null>;
  refreshRecentWorkspaces: () => Promise<void>;
  removeWorkspaceFromRecent: (workspaceId: string) => Promise<void>;
  hasWorkspace: boolean;
  workspaceName: string;
  workspacePath: string;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export const useWorkspaceContext = (): WorkspaceContextValue => {
  const context = useContext(WorkspaceContext);

  if (!context) {
    // Return a safe fallback instead of throwing — some scenes (e.g. wallpaper)
    // may render session components without a workspace being open.
    return {
      currentWorkspace: null,
      openedWorkspaces: new Map(),
      recentWorkspaces: [],
      activeWorkspaceId: null,
      lastUsedWorkspaceId: null,
      loading: false,
      error: null,
      activeWorkspace: null,
      openedWorkspacesList: [],
      normalWorkspacesList: [],
      openWorkspace: async () => { throw new Error('No workspace provider'); },
      closeWorkspace: async () => { throw new Error('No workspace provider'); },
      closeWorkspaceById: async () => { throw new Error('No workspace provider'); },
      switchWorkspace: async () => { throw new Error('No workspace provider'); },
      setActiveWorkspace: async () => { throw new Error('No workspace provider'); },
      reorderOpenedWorkspacesInSection: async () => { throw new Error('No workspace provider'); },
      scanWorkspaceInfo: async () => null,
      refreshRecentWorkspaces: async () => {},
      removeWorkspaceFromRecent: async () => {},
      hasWorkspace: false,
      workspaceName: '',
      workspacePath: '',
    };
  }

  return context;
};

export const useCurrentWorkspace = () => {
  const { activeWorkspace, loading, error, hasWorkspace, workspaceName, workspacePath } = useWorkspaceContext();

  return {
    workspace: activeWorkspace,
    loading,
    error,
    hasWorkspace,
    workspaceName,
    workspacePath,
  };
};

export const useWorkspaceEvents = (
  onWorkspaceOpened?: (workspace: WorkspaceInfo) => void,
  onWorkspaceClosed?: (workspaceId: string) => void,
  onWorkspaceSwitched?: (workspace: WorkspaceInfo) => void,
  onWorkspaceUpdated?: (workspace: WorkspaceInfo) => void
) => {
  useEffect(() => {
    const removeListener = workspaceManager.addEventListener((event: WorkspaceEvent) => {
      switch (event.type) {
        case 'workspace:opened':
          onWorkspaceOpened?.(event.workspace);
          break;
        case 'workspace:closed':
          onWorkspaceClosed?.(event.workspaceId);
          break;
        case 'workspace:switched':
          onWorkspaceSwitched?.(event.workspace);
          break;
        case 'workspace:updated':
          onWorkspaceUpdated?.(event.workspace);
          break;
        case 'workspace:recent-updated':
          break;
      }
    });

    return removeListener;
  }, [onWorkspaceOpened, onWorkspaceClosed, onWorkspaceSwitched, onWorkspaceUpdated]);
};

export { WorkspaceContext };
