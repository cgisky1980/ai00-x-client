/**
 * settingsContent — 设置 tab → 内容组件映射（单一事实来源）。
 *
 * SettingsScene（task 窗口）与策窗口 SettingsView/BeautyView 共用：
 * 两处入口渲染同一批内容组件，设置数据本体（config API）同源，任一处修改全局生效。
 */
import type { ComponentType } from 'react';
import type { ConfigTab } from './settingsConfig';
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
import DshPluginsConfig from '../../../infrastructure/config/components/DshPluginsConfig';

const SETTINGS_TAB_CONTENT: Partial<Record<ConfigTab, ComponentType>> = {
  ui: UiSettingsConfig,
  system: SystemSettingsConfig,
  'voice-settings': VoiceSettingsConfig,
  basics: BasicsConfig,
  models: AIModelConfig,
  voice: VoiceModelsConfig,
  'dsh-plugins': DshPluginsConfig,
  gesture: GestureSettings,
  'gesture-config': GestureConfigSettings,
  'gesture-templates': GestureTemplateSettings,
  'gesture-actions': GestureActionSettings,
  'click-effect': ClickEffectSettings,
  'smart-desktop': SmartDesktopConfig,
  plugins: PluginsConfig,
  account: AccountConfig,
  about: AboutConfig,
};

/** 取设置 tab 对应的内容组件（未知 tab 返回 null）。 */
export function getSettingsTabContent(tab: ConfigTab): ComponentType | null {
  return SETTINGS_TAB_CONTENT[tab] ?? null;
}
