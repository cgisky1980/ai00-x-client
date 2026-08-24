/**
 * TaskWelcomeScene — landing page for Task mode.
 *
 * Shows mode description, fixed workspace path, and quick actions
 * for creating new tasks or resuming recent ones.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Plus, FolderOpen } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { FlowChatManager } from '@/flow_chat/services/FlowChatManager';
import { globalAPI } from '@/infrastructure/api/service-api/GlobalAPI';
import { createLogger } from '@/shared/utils/logger';
import { BrandMark } from '@ai00-x/design-system/react';
import './TaskWelcomeScene.scss';

const log = createLogger('TaskWelcomeScene');

const TaskWelcomeScene: React.FC = () => {
  const { t } = useI18n('common');
  const openScene = useSceneStore(s => s.openScene);
  const { openWorkspace } = useWorkspaceContext();
  const [taskWorkspacePath, setTaskWorkspacePath] = useState<string>('');
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    globalAPI.getTaskWorkspacePath().then(setTaskWorkspacePath).catch(() => {});
  }, []);

  const handleNewTask = useCallback(async () => {
    setIsCreating(true);
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
    } finally {
      setIsCreating(false);
    }
  }, [taskWorkspacePath, openScene, openWorkspace]);

  return (
    <div className="task-welcome-scene">
      <div className="task-welcome-scene__content">
        {/* Hero */}
        <div className="task-welcome-scene__hero ds-brush-reveal">
          <BrandMark variant="seal" size={56} />
          <h1 className="task-welcome-scene__title">{t('welcomeScene.task.title')}</h1>
          <p className="task-welcome-scene__description">
            {t('welcomeScene.task.description')}
          </p>
        </div>

        {/* Workspace path */}
        {taskWorkspacePath && (
          <div className="task-welcome-scene__workspace">
            <span className="task-welcome-scene__workspace-label">
              <FolderOpen size={12} />
              {t('welcomeScene.task.workspacePath')}
            </span>
            <span className="task-welcome-scene__workspace-path">{taskWorkspacePath}</span>
          </div>
        )}

        <div className="task-welcome-scene__divider" />

        {/* Actions */}
        <div className="task-welcome-scene__actions">
          <button
            className="task-welcome-scene__action-btn task-welcome-scene__action-btn--primary"
            onClick={handleNewTask}
            disabled={isCreating}
          >
            <Plus size={16} />
            {t('welcomeScene.task.newTask')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TaskWelcomeScene;
