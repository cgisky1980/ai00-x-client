import React, { Suspense, lazy } from 'react';
import './ShellScene.scss';

const TerminalScene = lazy(() => import('../terminal/TerminalScene'));

interface ShellSceneProps {
  isActive?: boolean;
}

const ShellScene: React.FC<ShellSceneProps> = ({ isActive = true }) => (
  <div className="ai00-x-shell-scene">
    <Suspense fallback={<div className="ai00-x-shell-scene__loading" />}>
      <TerminalScene isActive={isActive} />
    </Suspense>
  </div>
);

export default ShellScene;
