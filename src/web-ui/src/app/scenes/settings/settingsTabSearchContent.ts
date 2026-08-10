import type { ConfigTab } from './settingsConfig';

export interface SettingsTabSearchPhrase {
  ns: string;
  key: string;
}

export const SETTINGS_TAB_SEARCH_CONTENT: Record<ConfigTab, readonly SettingsTabSearchPhrase[]> = {
  ui: [
    { ns: 'settings/basics', key: 'uiSettings.title' },
    { ns: 'settings/basics', key: 'uiSettings.subtitle' },
    { ns: 'settings/basics', key: 'appearance.title' },
    { ns: 'settings/basics', key: 'appearance.hint' },
    { ns: 'settings/basics', key: 'appearance.fontSize.title' },
    { ns: 'settings/basics', key: 'notifications.title' },
    { ns: 'settings/basics', key: 'notifications.hint' },
  ],

  system: [
    { ns: 'settings/basics', key: 'systemSettings.title' },
    { ns: 'settings/basics', key: 'systemSettings.subtitle' },
    { ns: 'settings/basics', key: 'launchAtLogin.sections.title' },
    { ns: 'settings/basics', key: 'launchAtLogin.sections.hint' },
    { ns: 'settings/basics', key: 'logging.sections.logging' },
    { ns: 'settings/basics', key: 'logging.sections.loggingHint' },
    { ns: 'settings/basics', key: 'terminal.sections.terminal' },
    { ns: 'settings/basics', key: 'terminal.sections.terminalHint' },
  ],

  basics: [
    { ns: 'settings/basics', key: 'title' },
    { ns: 'settings/basics', key: 'subtitle' },
    { ns: 'settings/basics', key: 'appearance.title' },
    { ns: 'settings/basics', key: 'appearance.hint' },
    { ns: 'settings/basics', key: 'logging.sections.logging' },
    { ns: 'settings/basics', key: 'logging.sections.loggingHint' },
    { ns: 'settings/basics', key: 'terminal.sections.terminal' },
    { ns: 'settings/basics', key: 'terminal.sections.terminalHint' },
  ],

  models: [
    { ns: 'settings/ai-model', key: 'title' },
    { ns: 'settings/ai-model', key: 'subtitle' },
    { ns: 'settings/default-model', key: 'tabs.default' },
    { ns: 'settings/default-model', key: 'subtitle' },
    { ns: 'settings/default-model', key: 'tabs.models' },
    { ns: 'settings/ai-model', key: 'subtitle' },
    { ns: 'settings/default-model', key: 'tabs.proxy' },
    { ns: 'settings/ai-model', key: 'proxy.enableHint' },
  ],

  voice: [
    { ns: 'settings/voice', key: 'voiceModels.title' },
    { ns: 'settings/voice', key: 'voiceModels.subtitle' },
    { ns: 'settings/voice', key: 'engineStatus.title' },
    { ns: 'settings/voice', key: 'engineStatus.description' },
  ],

  'voice-settings': [
    { ns: 'settings/voice', key: 'voiceSettings.title' },
    { ns: 'settings/voice', key: 'voiceSettings.subtitle' },
    { ns: 'settings/voice', key: 'deviceSelection.title' },
    { ns: 'settings/voice', key: 'deviceSelection.inputDevice' },
    { ns: 'settings/voice', key: 'deviceSelection.outputDevice' },
    { ns: 'settings/voice', key: 'voiceInput.title' },
    { ns: 'settings/voice', key: 'voiceInput.enabled' },
    { ns: 'settings/voice', key: 'voiceInput.triggerDuration' },
    { ns: 'settings/voice', key: 'voiceInput.chargeDelay' },
  ],

  gesture: [
    { ns: 'settings', key: 'configCenter.tabs.gesture' },
    { ns: 'settings', key: 'configCenter.tabDescriptions.gesture' },
  ],

  'gesture-config': [
    { ns: 'settings', key: 'configCenter.tabs.gestureConfig' },
    { ns: 'settings', key: 'configCenter.tabDescriptions.gestureConfig' },
    { ns: 'settings', key: 'configCenter.gesture.enabled' },
    { ns: 'settings', key: 'configCenter.gesture.gridSpacing' },
  ],

  'gesture-templates': [
    { ns: 'settings', key: 'configCenter.tabs.gestureTemplates' },
    { ns: 'settings', key: 'configCenter.tabDescriptions.gestureTemplates' },
    { ns: 'settings', key: 'configCenter.gesture.customTemplates' },
    { ns: 'settings', key: 'configCenter.gesture.recordPattern' },
    { ns: 'settings', key: 'configCenter.gesture.edit' },
    { ns: 'settings', key: 'configCenter.gesture.deleteTemplate' },
  ],

  'gesture-actions': [
    { ns: 'settings', key: 'configCenter.tabs.gestureActions' },
    { ns: 'settings', key: 'configCenter.tabDescriptions.gestureActions' },
    { ns: 'settings', key: 'configCenter.gesture.actions.addAction' },
    { ns: 'settings', key: 'configCenter.gesture.actions.savedActions' },
  ],

  'click-effect': [
    { ns: 'settings', key: 'configCenter.tabs.clickEffect' },
    { ns: 'settings', key: 'configCenter.tabDescriptions.clickEffect' },
    { ns: 'settings', key: 'clickEffect.enabled' },
    { ns: 'settings', key: 'clickEffect.blessingWords' },
    { ns: 'settings', key: 'clickEffect.valueRange' },
  ],

  'smart-desktop': [
    { ns: 'settings/basics', key: 'smartDesktop.title' },
    { ns: 'settings/basics', key: 'smartDesktop.subtitle' },
    { ns: 'settings/basics', key: 'smartDesktop.underlay.title' },
    { ns: 'settings/basics', key: 'smartDesktop.underlay.description' },
    { ns: 'settings/basics', key: 'smartDesktop.underlay.enabled' },
    { ns: 'settings/basics', key: 'smartDesktop.underlay.enabledHint' },
  ],

  account: [
    { ns: 'settings/account', key: 'title' },
    { ns: 'settings/account', key: 'username' },
    { ns: 'settings/account', key: 'logout' },
  ],

  about: [
    { ns: 'settings/about', key: 'title' },
    { ns: 'settings/about', key: 'version' },
    { ns: 'settings/about', key: 'checkUpdate' },
    { ns: 'settings/about', key: 'license' },
  ],
};
