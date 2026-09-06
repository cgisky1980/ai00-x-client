import React from 'react';
import { useSettingsStore } from './settingsStore';
import SettingsNav from './SettingsNav';
import { getSettingsTabContent } from './settingsContent';
import './SettingsScene.scss';

interface SettingsSceneProps {
  showNav?: boolean;
}

const SettingsScene: React.FC<SettingsSceneProps> = ({ showNav = true }) => {
  const activeTab = useSettingsStore(s => s.activeTab);

  const Content = getSettingsTabContent(activeTab);

  return (
    <div className="ai00-x-settings-scene">
      {showNav && (
        <div className="ai00-x-settings-scene__nav">
          <SettingsNav />
        </div>
      )}
      {Content && (
        <div key={activeTab} className="ai00-x-settings-scene__content-wrapper">
          <Content />
        </div>
      )}
    </div>
  );
};

export default SettingsScene;
