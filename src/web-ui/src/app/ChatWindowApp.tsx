import React, { useEffect } from 'react';
import { useWorkspaceContext } from '../infrastructure/contexts/WorkspaceContext';
import { useSceneStore } from './stores/sceneStore';
import { useModeStore } from './stores/modeStore';
import { useCoreLayoutInit } from './hooks/useCoreLayoutInit';
import WorkspaceBody from './layout/WorkspaceBody';
import DialogOverlay from './layout/DialogOverlay';
import { NotificationContainer, NotificationCenter } from '../shared/notification-system';
import './ChatWindowApp.scss';

interface ChatWindowAppProps {
  sessionId?: string;
  openSettings?: boolean;
  openMusic?: boolean;
  openDsh?: boolean;
}

const ChatWindowApp: React.FC<ChatWindowAppProps> = (props) => {
  const { openSettings, openMusic, openDsh } = props;
  void props.sessionId; // 老会话路由已随 flow_chat 移除
  const { activeWorkspace } = useWorkspaceContext();
  const openScene = useSceneStore((s) => s.openScene);
  const init = useCoreLayoutInit(false);

  useEffect(() => {
    if (activeWorkspace) {
      openScene('dsh');
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

  // dsh Agent 场景直开（策窗口委托交付唤起）
  useEffect(() => {
    if (!openDsh) return;
    const timer = setTimeout(() => {
      openScene('dsh');
    }, 300);
    return () => clearTimeout(timer);
  }, [openDsh, openScene]);

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
