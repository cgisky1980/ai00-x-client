/**
 * TaskNav — left navigation for Task mode.
 *
 * Shows task-specific options: new task button and session list.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { CheckSquare, Plus, MessageSquare } from 'lucide-react';
import { useSceneStore } from '../../stores/sceneStore';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { FlowChatManager } from '@/flow_chat/services/FlowChatManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { useActiveSession } from '@/flow_chat/store/modernFlowChatStore';
import { globalAPI } from '@/infrastructure/api/service-api/GlobalAPI';
import { createLogger } from '@/shared/utils/logger';
import type { Session } from '@/flow_chat/types/flow-chat';
import './TaskNav.scss';

const log = createLogger('TaskNav');

/** Subscribe to flowChatStore.sessions with stable reference comparison */
function useFlowChatSessions(): Map<string, Session> {
  const [sessions, setSessions] = useState<Map<string, Session>>(
    () => flowChatStore.getState().sessions,
  );
  const sessionsRef = useRef(sessions);

  useEffect(() => {
    return flowChatStore.subscribe((state) => {
      if (state.sessions !== sessionsRef.current) {
        sessionsRef.current = state.sessions;
        setSessions(state.sessions);
      }
    });
  }, []);

  return sessions;
}

const TaskNav: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { t } = useI18n('common');
  const openScene = useSceneStore((s) => s.openScene);
  const { openWorkspace } = useWorkspaceContext();
  const activeSession = useActiveSession();
  const activeSessionId = activeSession?.sessionId;
  const sessions = useFlowChatSessions();
  const [taskWorkspacePath, setTaskWorkspacePath] = useState<string>('');

  useEffect(() => {
    globalAPI.getTaskWorkspacePath().then(setTaskWorkspacePath).catch(() => {});
  }, []);

  // Filter sessions that belong to the task workspace
  const taskSessions = useMemo(() =>
    Array.from(sessions.values())
      .filter(s => s.workspacePath === taskWorkspacePath)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [sessions, taskWorkspacePath]
  );

  const handleNewTask = useCallback(async () => {
    try {
      // Ensure we have the task workspace path
      let wsPath = taskWorkspacePath;
      if (!wsPath) {
        wsPath = await globalAPI.getTaskWorkspacePath();
        setTaskWorkspacePath(wsPath);
      }
      // Open the task workspace if not already open
      await openWorkspace(wsPath);
      // Directly create a new task session (agentType = Core, display mode = task)
      const manager = FlowChatManager.getInstance();
      await manager.createChatSession({ workspacePath: wsPath, sessionDisplayMode: 'task' }, 'Task');
      openScene('session');
    } catch (e) {
      log.error('Failed to create task session', e);
    }
  }, [taskWorkspacePath, openScene, openWorkspace]);

  const handleSwitchSession = useCallback(async (sessionId: string) => {
    try {
      const manager = FlowChatManager.getInstance();
      await manager.switchChatSession(sessionId);
      openScene('session');
    } catch (e) {
      log.error('Failed to switch session', e);
    }
  }, [openScene]);

  return (
    <div className={`task-nav ${className}`}>
      <div className="task-nav__header">
        <div className="task-nav__header-icon">
          <CheckSquare size={16} />
        </div>
        <span className="task-nav__header-title">{t('nav.modes.task')}</span>
      </div>

      <button className="task-nav__new-btn" onClick={handleNewTask}>
        <Plus size={14} />
        {t('welcomeScene.task.newTask')}
      </button>

      {taskSessions.length > 0 && (
        <div className="task-nav__sessions">
          <span className="task-nav__sessions-label">
            {t('welcomeScene.task.recentTasks')}
          </span>
          {taskSessions.map(session => (
            <button
              key={session.sessionId}
              className={`task-nav__session-item ${
                session.sessionId === activeSessionId ? 'task-nav__session-item--active' : ''
              }`}
              onClick={() => handleSwitchSession(session.sessionId)}
            >
              <MessageSquare size={13} />
              <span className="task-nav__session-name">
                {session.title || t('welcomeScene.task.untitledTask')}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default TaskNav;
