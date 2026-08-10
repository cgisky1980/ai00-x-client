/**
 * SessionsSection — inline accordion content for the "Sessions" nav item.
 *
 * Rendered inside NavPanel when the Sessions item is expanded.
 * Owns all data fetching / mutation for chat sessions.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalContainer } from '@/infrastructure/contexts/PortalContainerContext';
import { Pencil, Trash2, Check, X, ClipboardList, MoreHorizontal, Loader2, CircleCheck, Bot, FolderSearch } from 'lucide-react';
import { IconButton, Input, Tooltip } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n';
import { flowChatStore } from '../../../../../flow_chat/store/FlowChatStore';
import { flowChatManager } from '../../../../../flow_chat/services/FlowChatManager';
import type { FlowChatState, Session } from '../../../../../flow_chat/types/flow-chat';
import { useSceneStore } from '../../../../stores/sceneStore';
import type { SceneTabId } from '../../../SceneBar/types';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { createLogger } from '@/shared/utils/logger';
import { openMainSession } from '@/flow_chat/services/sessionNavigation';
import {
  compareSessionsForDisplay,
  sessionBelongsToWorkspaceNavRow,
} from '@/flow_chat/utils/sessionOrdering';
import { stateMachineManager } from '@/flow_chat/state-machine';
import { SessionExecutionState } from '@/flow_chat/state-machine/types';
import { workspaceAPI } from '@/infrastructure/api';
import { globalAPI } from '@/infrastructure/api/service-api/GlobalAPI';
import { notificationService } from '@/shared/notification-system';
import { isRemoteWorkspace } from '@/shared/types';
import './SessionsSection.scss';

/** Top-level parent sessions shown at each expand step (children still nest under visible parents). */
const SESSIONS_LEVEL_0 = 5;
const SESSIONS_LEVEL_1 = 10;
const log = createLogger('SessionsSection');
const AGENT_SCENE: SceneTabId = 'session';

type SessionMode = 'code' | 'cowork';

const resolveSessionModeType = (session: Session): SessionMode => {
  const normalizedMode = session.mode?.toLowerCase();
  if (normalizedMode === 'cowork') return 'cowork';
  return 'code';
};

const getTitle = (session: Session): string =>
  session.title?.trim() || `Session ${session.sessionId.slice(0, 6)}`;

interface SessionsSectionProps {
  workspaceId?: string;
  workspacePath?: string;
  /** Remote SSH: same `workspacePath` on different hosts must filter by this (see Session.remoteConnectionId). */
  remoteConnectionId?: string | null;
  /** Remote SSH: disambiguates same path on different hosts; when set with matching session host, connectionId may differ. */
  remoteSshHost?: string | null;
  isActiveWorkspace?: boolean;
  showCreateActions?: boolean;
  showSessionModeIcon?: boolean;
}

const SessionsSection: React.FC<SessionsSectionProps> = ({
  workspaceId,
  workspacePath,
  remoteConnectionId = null,
  remoteSshHost = null,
  isActiveWorkspace: _isActiveWorkspace = true,
  showSessionModeIcon = true,
}) => {
  const { t } = useI18n('common');
  const { setActiveWorkspace, currentWorkspace } = useWorkspaceContext();
  const activeTabId = useSceneStore(s => s.activeTabId);
  const [flowChatState, setFlowChatState] = useState<FlowChatState>(() =>
    flowChatStore.getState()
  );
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [expandLevel, setExpandLevel] = useState<0 | 1 | 2>(0);
  const [openMenuSessionId, setOpenMenuSessionId] = useState<string | null>(null);
  const [sessionMenuPosition, setSessionMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());
  const [isTaskWorkspace, setIsTaskWorkspace] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const sessionMenuPopoverRef = useRef<HTMLDivElement>(null);
  const portalContainer = usePortalContainer();
  const portalTarget = portalContainer ?? document.body;

  // Subscribe to state machine changes for running status
  useEffect(() => {
    const updateRunningSessions = () => {
      const running = new Set<string>();
      for (const session of flowChatState.sessions.values()) {
        const machine = stateMachineManager.get(session.sessionId);
        if (
          machine &&
          (machine.getCurrentState() === SessionExecutionState.PROCESSING ||
            machine.getCurrentState() === SessionExecutionState.FINISHING)
        ) {
          running.add(session.sessionId);
        }
      }
      setRunningSessionIds(running);
    };

    updateRunningSessions();
    const unsubscribe = stateMachineManager.subscribeGlobal(() => {
      updateRunningSessions();
    });
    return () => unsubscribe();
  }, [flowChatState.sessions]);

  useEffect(() => {
    const unsub = flowChatStore.subscribe(s => setFlowChatState(s));
    return () => unsub();
  }, []);

  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  useEffect(() => {
    setExpandLevel(0);
  }, [workspaceId, workspacePath, remoteConnectionId, remoteSshHost]);

  useEffect(() => {
    if (!workspacePath) { setIsTaskWorkspace(false); return; }
    let cancelled = false;
    globalAPI.isTaskWorkspace(workspacePath).then(result => {
      if (!cancelled) setIsTaskWorkspace(result);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [workspacePath]);

  const isRemote = useMemo(() => {
    if (remoteConnectionId) return true;
    if (!currentWorkspace) return false;
    return isRemoteWorkspace(currentWorkspace);
  }, [remoteConnectionId, currentWorkspace]);

  useEffect(() => {
    if (!openMenuSessionId) return;
    const handleOutside = (event: MouseEvent) => {
      if (!sessionMenuPopoverRef.current?.contains(event.target as Node)) {
        setOpenMenuSessionId(null);
        setSessionMenuPosition(null);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [openMenuSessionId]);

  const sessions = useMemo(
    () =>
      Array.from(flowChatState.sessions.values())
        .filter((s: Session) => {
          if (workspacePath) {
            return sessionBelongsToWorkspaceNavRow(s, workspacePath, remoteConnectionId, remoteSshHost);
          }
          return !s.workspacePath;
        })
        .sort(compareSessionsForDisplay),
    [flowChatState.sessions, workspacePath, remoteConnectionId, remoteSshHost]
  );

  const topLevelSessions = useMemo(
    () => [...sessions].sort(compareSessionsForDisplay),
    [sessions]
  );

  const sessionDisplayLimit = useMemo(() => {
    const total = topLevelSessions.length;
    if (expandLevel === 2 || total <= SESSIONS_LEVEL_0) return total;
    if (expandLevel === 1) return Math.min(total, SESSIONS_LEVEL_1);
    return SESSIONS_LEVEL_0;
  }, [topLevelSessions.length, expandLevel]);

  const visibleItems = useMemo(() => {
    const visibleParents = topLevelSessions.slice(0, sessionDisplayLimit);
    return visibleParents.map(session => ({ session, level: 0 as const }));
  }, [sessionDisplayLimit, topLevelSessions]);

  const activeSessionId = flowChatState.activeSessionId;

  const handleSwitch = useCallback(
    async (sessionId: string) => {
      if (editingSessionId) return;
      try {
        const mustActivateWorkspace =
          Boolean(workspaceId) && workspaceId !== currentWorkspace?.id;
        const activateWorkspace = mustActivateWorkspace
          ? async (targetWorkspaceId: string) => {
              await setActiveWorkspace(targetWorkspaceId);
            }
          : undefined;

        await openMainSession(sessionId, {
          workspaceId,
          activateWorkspace,
        });

        if (sessionId !== activeSessionId) {
          window.dispatchEvent(
            new CustomEvent('flowchat:switch-session', { detail: { sessionId } })
          );
        }
      } catch (err) {
        log.error('Failed to switch session', err);
      }
    },
    [
      activeSessionId,
      editingSessionId,
      setActiveWorkspace,
      workspaceId,
      currentWorkspace?.id,
    ]
  );

  const resolveSessionTitle = useCallback(
    (session: Session): string => {
      const rawTitle = getTitle(session);
      const matched = rawTitle.match(new RegExp(`^(?:${t('nav.sessions.newSessionPattern')})\\s*(\\d+)$`, 'i'));
      if (!matched) return rawTitle;

      const mode = resolveSessionModeType(session);
      const label =
        mode === 'cowork'
          ? t('nav.sessions.newCoworkSession')
          : t('nav.sessions.newCodeSession');
      return `${label} ${matched[1]}`;
    },
    [t]
  );

  const handleMenuOpen = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      if (openMenuSessionId === sessionId) {
        setOpenMenuSessionId(null);
        setSessionMenuPosition(null);
        return;
      }
      const btn = e.currentTarget as HTMLElement;
      const rect = btn.getBoundingClientRect();
      const viewportPadding = 8;
      const estimatedWidth = 160;
      const maxLeft = window.innerWidth - estimatedWidth - viewportPadding;
      setSessionMenuPosition({
        top: Math.max(viewportPadding, rect.bottom + 4),
        left: Math.max(viewportPadding, Math.min(rect.left, maxLeft)),
      });
      setOpenMenuSessionId(sessionId);
    },
    [openMenuSessionId]
  );

  const handleDelete = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      try {
        await flowChatManager.deleteChatSession(sessionId);
      } catch (err) {
        log.error('Failed to delete session', err);
      }
    },
    []
  );

  const handleRevealSessionDir = useCallback(
    async (e: React.MouseEvent, session: Session) => {
      e.stopPropagation();
      setOpenMenuSessionId(null);
      if (!workspacePath || isRemote) return;
      try {
        const branch = session.sandboxBranch;
        const targetPath = branch
          ? `${workspacePath}/.tasks/${branch.replace(/\//g, '-')}`
          : workspacePath;
        await workspaceAPI.revealInExplorer(targetPath);
      } catch (error) {
        notificationService.error(
          error instanceof Error ? error.message : t('nav.sessions.revealDir'),
          { duration: 4000 }
        );
      }
    },
    [workspacePath, isRemote, t]
  );

  const handleStartEdit = useCallback(
    (e: React.MouseEvent, session: Session) => {
      e.stopPropagation();
      setEditingSessionId(session.sessionId);
      setEditingTitle(resolveSessionTitle(session));
    },
    [resolveSessionTitle]
  );

  const handleConfirmEdit = useCallback(async () => {
    if (!editingSessionId) return;
    const trimmed = editingTitle.trim();
    if (trimmed) {
      try {
        await flowChatManager.renameChatSessionTitle(editingSessionId, trimmed);
      } catch (err) {
        log.error('Failed to update session title', err);
      }
    }
    setEditingSessionId(null);
    setEditingTitle('');
  }, [editingSessionId, editingTitle]);

  const handleCancelEdit = useCallback(() => {
    setEditingSessionId(null);
    setEditingTitle('');
  }, []);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirmEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancelEdit();
      }
    },
    [handleConfirmEdit, handleCancelEdit]
  );

  if (topLevelSessions.length === 0) {
    return null;
  }

  return (
    <div className="ai00-x-nav-panel__inline-list">
      {visibleItems.map(({ session }) => {
          const isEditing = editingSessionId === session.sessionId;
          const sessionModeKey = resolveSessionModeType(session);
          const sessionTitle = resolveSessionTitle(session);
          const isArchived = session.completionPhase === 'archived';
          const SessionIcon =
            isArchived
              ? CircleCheck
              : sessionModeKey === 'cowork'
                ? ClipboardList
                : Bot;
          const isRunning = runningSessionIds.has(session.sessionId);
          const isRowActive = activeTabId === AGENT_SCENE && session.sessionId === activeSessionId;
          const row = (
            <div
              className={[
                'ai00-x-nav-panel__inline-item',
                isRowActive && 'is-active',
                isEditing && 'is-editing',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => handleSwitch(session.sessionId)}
            >
              {showSessionModeIcon ? (
                isRunning ? (
                  <Loader2
                    size={14}
                    className={[
                      'ai00-x-nav-panel__inline-item-icon',
                      'is-running',
                    ].join(' ')}
                  />
                ) : (
                  <SessionIcon
                    size={14}
                    className={[
                      'ai00-x-nav-panel__inline-item-icon',
                      isArchived
                        ? 'is-archived'
                        : sessionModeKey === 'cowork'
                          ? 'is-cowork'
                          : 'is-agent',
                    ].join(' ')}
                  />
                )
              ) : null}

              {isEditing ? (
                <div className="ai00-x-nav-panel__inline-item-edit" onClick={e => e.stopPropagation()}>
                  <Input
                    ref={editInputRef}
                    className="ai00-x-nav-panel__inline-item-edit-field"
                    variant="default"
                    inputSize="small"
                    value={editingTitle}
                    onChange={e => setEditingTitle(e.target.value)}
                    onKeyDown={handleEditKeyDown}
                    onBlur={handleConfirmEdit}
                  />
                  <IconButton
                    variant="success"
                    size="xs"
                    className="ai00-x-nav-panel__inline-item-edit-btn confirm"
                    onClick={e => { e.stopPropagation(); handleConfirmEdit(); }}
                    tooltip={t('nav.sessions.confirmEdit')}
                    tooltipPlacement="top"
                  >
                    <Check size={11} />
                  </IconButton>
                  <IconButton
                    variant="default"
                    size="xs"
                    className="ai00-x-nav-panel__inline-item-edit-btn cancel"
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); handleCancelEdit(); }}
                    tooltip={t('nav.sessions.cancelEdit')}
                    tooltipPlacement="top"
                  >
                    <X size={11} />
                  </IconButton>
                </div>
              ) : (
                <>
                  <span className="ai00-x-nav-panel__inline-item-main">
                    <span className="ai00-x-nav-panel__inline-item-label">{sessionTitle}</span>
                  </span>
                  <div className="ai00-x-nav-panel__inline-item-actions">
                    <button
                      type="button"
                      className={`ai00-x-nav-panel__inline-item-action-btn${openMenuSessionId === session.sessionId ? ' is-open' : ''}`}
                      onClick={e => handleMenuOpen(e, session.sessionId)}
                    >
                      <MoreHorizontal size={12} />
                    </button>
                  </div>
                  {openMenuSessionId === session.sessionId && sessionMenuPosition && createPortal(
                    <div
                      ref={sessionMenuPopoverRef}
                      className="ai00-x-nav-panel__inline-item-menu-popover"
                      data-no-penetrate
                      role="menu"
                      style={{ top: `${sessionMenuPosition.top}px`, left: `${sessionMenuPosition.left}px` }}
                    >
                      <button
                        type="button"
                        className="ai00-x-nav-panel__inline-item-menu-item"
                        onClick={e => { setOpenMenuSessionId(null); handleStartEdit(e, session); }}
                      >
                        <Pencil size={13} />
                        <span>{t('nav.sessions.rename')}</span>
                      </button>
                      {!isTaskWorkspace && !isArchived && !isRemote && (
                      <button
                        type="button"
                        className="ai00-x-nav-panel__inline-item-menu-item"
                        onClick={e => { void handleRevealSessionDir(e, session); }}
                      >
                        <FolderSearch size={13} />
                        <span>{t('nav.sessions.revealDir')}</span>
                      </button>
                      )}
                      <button
                        type="button"
                        className="ai00-x-nav-panel__inline-item-menu-item is-danger"
                        onClick={e => { setOpenMenuSessionId(null); void handleDelete(e, session.sessionId); }}
                        style={session.mode === 'Wallpaper' ? { display: 'none' } : undefined}
                      >
                        <Trash2 size={13} />
                        <span>{t('nav.sessions.delete')}</span>
                      </button>
                    </div>,
                    portalTarget
                  )}
                </>
              )}
            </div>
          );
          return isEditing || openMenuSessionId !== null ? (
            <React.Fragment key={session.sessionId}>{row}</React.Fragment>
          ) : (
            <Tooltip key={session.sessionId} content={sessionTitle} placement="right" followCursor>
              {row}
            </Tooltip>
          );
        })}

      {topLevelSessions.length > SESSIONS_LEVEL_0 && (
        <button
          type="button"
          className="ai00-x-nav-panel__inline-toggle"
          onClick={() => {
            const total = topLevelSessions.length;
            if (expandLevel === 0) {
              setExpandLevel(1);
              return;
            }
            if (expandLevel === 1 && total > SESSIONS_LEVEL_1) {
              setExpandLevel(2);
              return;
            }
            setExpandLevel(0);
          }}
        >
          {expandLevel === 0 ? (
            <>
              <span className="ai00-x-nav-panel__inline-toggle-dots">···</span>
              <span>
                {t('nav.sessions.showMore', {
                  count: topLevelSessions.length - SESSIONS_LEVEL_0,
                })}
              </span>
            </>
          ) : expandLevel === 1 && topLevelSessions.length > SESSIONS_LEVEL_1 ? (
            <>
              <span className="ai00-x-nav-panel__inline-toggle-dots">···</span>
              <span>
                {t('nav.sessions.showAll', {
                  count: topLevelSessions.length - SESSIONS_LEVEL_1,
                })}
              </span>
            </>
          ) : (
            <span>{t('nav.sessions.showLess')}</span>
          )}
        </button>
      )}
    </div>
  );
};

export default SessionsSection;
