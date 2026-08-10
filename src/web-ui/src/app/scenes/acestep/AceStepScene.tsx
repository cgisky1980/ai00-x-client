/**
 * AceStepScene — ACE-Step music generation scene.
 *
 * Renders the AceStepWorkspace (Chat Create view) directly — the workspace
 * NavBar provides the title bar, and the NavPanel (left sidebar) hosts the
 * SessionSwitcher in music mode.
 */

import React from 'react';
import AceStepWorkspace from '@/tools/acestep/components/AceStepWorkspace';
import './AceStepScene.scss';

const AceStepScene: React.FC = () => {
  return (
    <div className="ai00-x-acestep-scene">
      <AceStepWorkspace />
    </div>
  );
};

export default AceStepScene;
