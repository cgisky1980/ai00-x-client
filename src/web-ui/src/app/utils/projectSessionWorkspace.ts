import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import { isRemoteWorkspace, type WorkspaceInfo } from '@/shared/types';

function normalizePathForComparison(p: string | undefined | null): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').toLowerCase();
}

export function pathsEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  return normalizePathForComparison(a) === normalizePathForComparison(b);
}

function sessionBelongsToWorkspace(session: Session, workspace: WorkspaceInfo): boolean {
  const path = session.workspacePath?.trim();
  const root = workspace.rootPath?.trim();
  if (!path || !root || !pathsEqual(path, root)) {
    return false;
  }
  if (isRemoteWorkspace(workspace)) {
    const wc = workspace.connectionId?.trim() ?? '';
    const sc = session.remoteConnectionId?.trim() ?? '';
    if (wc.length > 0 || sc.length > 0) {
      return wc === sc;
    }
  }
  return true;
}

function isEmptyReusableSession(session: Session, workspace: WorkspaceInfo): boolean {
  if (session.isHistorical) {
    return false;
  }
  if (session.dialogTurns.length > 0) {
    return false;
  }
  return sessionBelongsToWorkspace(session, workspace);
}

export function findReusableEmptySessionId(
  workspace: WorkspaceInfo,
  _requestedMode?: string
): string | null {
  const sessions = flowChatStore.getState().sessions;
  let best: { id: string; lastActiveAt: number } | null = null;
  for (const session of sessions.values()) {
    if (!isEmptyReusableSession(session, workspace)) {
      continue;
    }
    if (!best || session.lastActiveAt > best.lastActiveAt) {
      best = { id: session.sessionId, lastActiveAt: session.lastActiveAt };
    }
  }
  return best?.id ?? null;
}

export function pickWorkspaceForProjectChatSession(
  currentWorkspace: WorkspaceInfo | null | undefined,
  normalWorkspacesList: WorkspaceInfo[]
): WorkspaceInfo | null {
  if (currentWorkspace) {
    return currentWorkspace;
  }
  return normalWorkspacesList[0] ?? null;
}

/**
 * Find the existing Wallpaper session for a wallpaper project.
 * Each wallpaper project should have at most one session.
 */
export function findWallpaperProjectSession(projectPath: string): Session | null {
  const sessions = flowChatStore.getState().sessions;
  for (const session of sessions.values()) {
    if (
      (pathsEqual(session.workspacePath, projectPath) || pathsEqual(session.config?.workspacePath, projectPath))
      && (session.mode === 'Wallpaper' || session.config?.agentType === 'Wallpaper')
    ) {
      return session;
    }
  }
  return null;
}

export function flowChatSessionConfigForWorkspace(workspace: WorkspaceInfo) {
  return {
    workspacePath: workspace.rootPath,
    ...(isRemoteWorkspace(workspace) && workspace.connectionId
      ? { remoteConnectionId: workspace.connectionId }
      : {}),
  };
}
