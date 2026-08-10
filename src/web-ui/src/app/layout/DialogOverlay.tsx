import React, { useEffect, useState } from 'react';
import { NewProjectDialog } from '../components/NewProjectDialog';
import { AboutDialog } from '../components/AboutDialog';
import { MCPInteractionDialog } from '../components/MCPInteractionDialog/MCPInteractionDialog';
import { WorkspaceManager } from '../../tools/workspace';
import { globalAPI } from '@/infrastructure/api/service-api/GlobalAPI';
import { SandboxCreationModal } from '@/flow_chat/components/SandboxCreationModal/SandboxCreationModal';
import type { WorkspaceInfo } from '@/shared/types';

interface DialogOverlayProps {
  showNewProjectDialog: boolean;
  setShowNewProjectDialog: (v: boolean) => void;
  showAboutDialog: boolean;
  setShowAboutDialog: (v: boolean) => void;
  showWorkspaceStatus: boolean;
  setShowWorkspaceStatus: (v: boolean) => void;
  handleConfirmNewProject: (parentPath: string, projectName: string) => Promise<void>;
  currentWorkspace: WorkspaceInfo | null | undefined;
  includeMCP?: boolean;
}

const DialogOverlay: React.FC<DialogOverlayProps> = ({
  showNewProjectDialog,
  setShowNewProjectDialog,
  showAboutDialog,
  setShowAboutDialog,
  showWorkspaceStatus,
  setShowWorkspaceStatus,
  handleConfirmNewProject,
  currentWorkspace,
  includeMCP = true,
}) => {
  const [codeWorkspacePath, setCodeWorkspacePath] = useState<string>('');

  useEffect(() => {
    globalAPI.getCodeWorkspacePath().then(setCodeWorkspacePath).catch(() => {});
  }, []);

  return (
    <>
      <NewProjectDialog
        isOpen={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
        onConfirm={handleConfirmNewProject}
        defaultParentPath={codeWorkspacePath || currentWorkspace?.rootPath || undefined}
      />
      <AboutDialog
        isOpen={showAboutDialog}
        onClose={() => setShowAboutDialog(false)}
      />
      <WorkspaceManager
        isVisible={showWorkspaceStatus}
        onClose={() => setShowWorkspaceStatus(false)}
        onWorkspaceSelect={() => {}}
      />
      {includeMCP && <MCPInteractionDialog />}
      <SandboxCreationModal />
    </>
  );
};

export default DialogOverlay;
