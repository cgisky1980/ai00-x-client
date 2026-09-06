/**
 * SettingsView — 策窗口「设」视图：系统设置（自 task 窗口设置中心迁移）。
 *
 * 竖列二级导航（分组：模型/咒法/基础）+ 右侧内容区；内容组件与 task 窗口
 * SettingsScene 同源（getSettingsTabContent），选中态为本视图本地 UI 态，
 * 不写 settingsStore（与 task 窗口设置页互不干扰，数据本体同源全局生效）。
 * ui（主题外观）归「美」视图，不在此处。
 */
import React, { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Cpu,
  Hand,
  Info,
  Layers,
  Mic,
  Settings2,
  Terminal,
  User,
  Volume2,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import type { ConfigTab } from '@/app/scenes/settings/settingsConfig';
import { getSettingsTabContent } from '@/app/scenes/settings/settingsContent';
import './settings-view.scss';

/** 二级导航分组定义（label 走 settings 命名空间既有 i18n key）。 */
export interface SecondaryNavGroup {
  id: string;
  nameKey: string;
  items: { tab: ConfigTab; labelKey: string; Icon: LucideIcon }[];
}

/** 设/美两视图共用的二级导航 + 内容区外壳（竖列第二栏）。 */
export const SecondaryNavLayout: React.FC<{
  groups: SecondaryNavGroup[];
  active: ConfigTab;
  onSelect: (tab: ConfigTab) => void;
}> = ({ groups, active, onSelect }) => {
  const { t } = useI18n('settings');
  const Content = getSettingsTabContent(active);

  return (
    <div className="td-settings">
      <nav className="td-settings__nav" aria-label="设置分类">
        {groups.map(group => (
          <div key={group.id} className="td-settings__nav-group">
            <div className="td-settings__nav-group-label">{t(group.nameKey)}</div>
            {group.items.map(({ tab, labelKey, Icon }) => (
              <button
                key={tab}
                type="button"
                className={`td-settings__nav-item${active === tab ? ' is-active' : ''}`}
                onClick={() => onSelect(tab)}
                title={t(labelKey)}
              >
                <Icon size={14} className="td-settings__nav-item-icon" />
                <span className="td-settings__nav-item-label">{t(labelKey)}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="td-settings__content">
        {Content && (
          <div key={active} className="td-settings__content-inner">
            <Content />
          </div>
        )}
      </div>
    </div>
  );
};

/** 「设」二级导航分组：模型 / 咒法 / 基础（ui 归美）。 */
const SETTINGS_GROUPS: SecondaryNavGroup[] = [
  {
    id: 'models',
    nameKey: 'configCenter.categories.models',
    items: [
      { tab: 'models', labelKey: 'configCenter.tabs.taskModels', Icon: Cpu },
      { tab: 'voice', labelKey: 'configCenter.tabs.voiceModels', Icon: Mic },
      { tab: 'dsh-plugins', labelKey: 'configCenter.tabs.dshPlugins', Icon: Bot },
    ],
  },
  {
    id: 'spells',
    nameKey: 'configCenter.categories.spells',
    items: [
      { tab: 'gesture-config', labelKey: 'configCenter.tabs.gestureConfig', Icon: Hand },
      { tab: 'gesture-templates', labelKey: 'configCenter.tabs.gestureTemplates', Icon: Layers },
      { tab: 'gesture-actions', labelKey: 'configCenter.tabs.gestureActions', Icon: Settings2 },
    ],
  },
  {
    id: 'basic',
    nameKey: 'configCenter.categories.basic',
    items: [
      { tab: 'system', labelKey: 'configCenter.tabs.system', Icon: Terminal },
      { tab: 'voice-settings', labelKey: 'configCenter.tabs.voiceSettings', Icon: Volume2 },
      { tab: 'account', labelKey: 'configCenter.tabs.account', Icon: User },
      { tab: 'about', labelKey: 'configCenter.tabs.about', Icon: Info },
    ],
  },
];

export const SettingsView: React.FC = () => {
  const [active, setActive] = useState<ConfigTab>('models');
  return <SecondaryNavLayout groups={SETTINGS_GROUPS} active={active} onSelect={setActive} />;
};
