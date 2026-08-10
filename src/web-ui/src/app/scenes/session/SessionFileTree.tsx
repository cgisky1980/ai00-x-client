import React, { memo } from 'react';
import FilesPanel from '@/app/components/panels/FilesPanel';
import './SessionFileTree.scss';

interface SessionFileTreeProps {
  workspacePath?: string;
}

const SessionFileTree: React.FC<SessionFileTreeProps> = ({ workspacePath }) => {
  if (!workspacePath) return null;

  return (
    <div className="ai00-x-session-file-tree">
      <FilesPanel
        workspacePath={workspacePath}
        hideHeader
        hideExplorerToolbar
      />
    </div>
  );
};

export default memo(SessionFileTree);
