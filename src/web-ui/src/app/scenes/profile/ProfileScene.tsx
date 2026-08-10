import React from 'react';
import { NurseryView } from './views';
import './ProfileScene.scss';

interface ProfileSceneProps {
  /** Legacy prop – preserved for compatibility; nursery manages its own navigation */
  workspacePath?: string;
}

const ProfileScene: React.FC<ProfileSceneProps> = () => (
  <div className="ai00-x-profile-scene">
    <NurseryView />
  </div>
);

export default ProfileScene;
