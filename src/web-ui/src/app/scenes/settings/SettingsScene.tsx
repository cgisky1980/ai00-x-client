import React from 'react';
import { useSettingsStore } from './settingsStore';
import SettingsNav from './SettingsNav';
import './SettingsScene.scss';
import AIModelConfig from '../../../infrastructure/config/components/AIModelConfig';
import BasicsConfig from '../../../infrastructure/config/components/BasicsConfig';
import UiSettingsConfig from '../../../infrastructure/config/components/UiSettingsConfig';
import SystemSettingsConfig from '../../../infrastructure/config/components/SystemSettingsConfig';
import VoiceModelsConfig from '../../../infrastructure/config/components/VoiceModelsConfig';
import VoiceSettingsConfig from '../../../infrastructure/config/components/VoiceSettingsConfig';
import AccountConfig from '../../../infrastructure/config/components/AccountConfig';
import AboutConfig from '../../../infrastructure/config/components/AboutConfig';
import GestureSettings from './gesture/GestureSettings';
import GestureConfigSettings from './gesture/GestureConfigSettings';
import GestureTemplateSettings from './gesture/GestureTemplateSettings';
import GestureActionSettings from './gesture/GestureActionSettings';
import ClickEffectSettings from './gesture/ClickEffectSettings';
import SmartDesktopConfig from '../../../infrastructure/config/components/SmartDesktopConfig';
import PluginsConfig from '../../../infrastructure/config/components/PluginsConfig';

interface SettingsSceneProps {
  showNav?: boolean;
}

const SettingsScene: React.FC<SettingsSceneProps> = ({ showNav = true }) => {
  const activeTab = useSettingsStore(s => s.activeTab);

  let Content: React.ComponentType | null = null;

  switch (activeTab) {
    case 'ui':               Content = UiSettingsConfig;       break;
    case 'system':           Content = SystemSettingsConfig;   break;
    case 'voice-settings':   Content = VoiceSettingsConfig;    break;
    case 'basics':           Content = BasicsConfig;           break;
    case 'models':           Content = AIModelConfig;          break;
    case 'voice':            Content = VoiceModelsConfig;      break;
    case 'gesture':          Content = GestureSettings;        break;
    case 'gesture-config':   Content = GestureConfigSettings;  break;
    case 'gesture-templates':Content = GestureTemplateSettings;break;
    case 'gesture-actions':  Content = GestureActionSettings;   break;
    case 'click-effect':    Content = ClickEffectSettings;      break;
    case 'smart-desktop':   Content = SmartDesktopConfig;       break;
    case 'plugins':         Content = PluginsConfig;            break;
    case 'account':          Content = AccountConfig;          break;
    case 'about':            Content = AboutConfig;            break;
  }

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
