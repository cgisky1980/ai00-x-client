/**
 * GraphView — Wraps GitGraphView for the Git scene graph tab.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { GitGraphView } from '@/tools/git/components/GitGraphView';
import './GraphView.scss';

interface GraphViewProps {
  workspacePath?: string;
}

const GraphView: React.FC<GraphViewProps> = ({ workspacePath = '' }) => {
  const { t } = useTranslation('panels/git');

  if (!workspacePath) {
    return (
      <div className="ai00-x-git-scene-graph ai00-x-git-scene-graph--empty">
        <p>{t('empty.openWorkspaceForGraph')}</p>
      </div>
    );
  }

  return (
    <div className="ai00-x-git-scene-graph">
      <GitGraphView repositoryPath={workspacePath} />
    </div>
  );
};

export default GraphView;
