import React, { useEffect } from 'react';
import { useWorkspaceContext } from '../infrastructure/contexts/WorkspaceContext';
import { useSceneStore } from './stores/sceneStore';
import { useModeStore } from './stores/modeStore';
import { FlowChatManager } from '../flow_chat';
import { useCoreLayoutInit } from './hooks/useCoreLayoutInit';
import WorkspaceBody from './layout/WorkspaceBody';
import DialogOverlay from './layout/DialogOverlay';
import { NotificationContainer, NotificationCenter } from '../shared/notification-system';
import './ChatWindowApp.scss';

interface ChatWindowAppProps {
  sessionId?: string;
  openSettings?: boolean;
  openMusic?: boolean;
}

const ChatWindowApp: React.FC<ChatWindowAppProps> = ({ sessionId, openSettings, openMusic }) => {
  const { activeWorkspace } = useWorkspaceContext();
  const openScene = useSceneStore((s) => s.openScene);
  const init = useCoreLayoutInit(false);

  useEffect(() => {
    if (activeWorkspace) {
      openScene('session');
    }
  }, [activeWorkspace, openScene]);

  useEffect(() => {
    if (!openSettings) return;
    const timer = setTimeout(() => {
      openScene('settings');
    }, 300);
    return () => clearTimeout(timer);
  }, [openSettings, openScene]);

  useEffect(() => {
    if (!openMusic) return;
    const timer = setTimeout(() => {
      useModeStore.getState().setActiveMode('music');
      openScene('acestep');
    }, 300);
    return () => clearTimeout(timer);
  }, [openMusic, openScene]);

  useEffect(() => {
    if (!sessionId) return;
    const manager = FlowChatManager.getInstance();
    if (manager) {
      manager.switchChatSession(sessionId);
    }
  }, [sessionId]);

  return (
    <div className="ai00-x-chat-window-app">
      <WorkspaceBody compact />
      <DialogOverlay
        showNewProjectDialog={init.showNewProjectDialog}
        setShowNewProjectDialog={init.setShowNewProjectDialog}
        showAboutDialog={init.showAboutDialog}
        setShowAboutDialog={init.setShowAboutDialog}
        showWorkspaceStatus={init.showWorkspaceStatus}
        setShowWorkspaceStatus={init.setShowWorkspaceStatus}
        handleConfirmNewProject={init.handleConfirmNewProject}
        currentWorkspace={init.currentWorkspace}
        includeMCP={false}
      />
      <NotificationContainer />
      <NotificationCenter />
    </div>
  );
};

export default ChatWindowApp;
