/**
 * BeautyView — 策窗口「美」视图：界面美化类设置。
 *
 * 竖列二级导航（单组「美化」：主题外观/点击特效/智能桌面/桌面插件）+ 内容区；
 * 复用 SettingsView 的 SecondaryNavLayout 外壳与设置内容组件（getSettingsTabContent）。
 * 壁纸（wallpaper 独立场景）暂不含，属后续迁移步骤。
 */
import React, { useState } from 'react';
import { MousePointerClick, MonitorSmartphone, Palette, Puzzle } from 'lucide-react';
import type { ConfigTab } from '@/app/scenes/settings/settingsConfig';
import { SecondaryNavLayout, type SecondaryNavGroup } from './SettingsView';

/** 「美」二级导航分组：主题外观（ui 自基础组划入）+ 桌面美化三件。 */
const BEAUTY_GROUPS: SecondaryNavGroup[] = [
  {
    id: 'beautify',
    nameKey: 'configCenter.categories.desktopBeautify',
    items: [
      { tab: 'ui', labelKey: 'configCenter.tabs.ui', Icon: Palette },
      { tab: 'click-effect', labelKey: 'configCenter.tabs.clickEffect', Icon: MousePointerClick },
      { tab: 'smart-desktop', labelKey: 'configCenter.tabs.smartDesktop', Icon: MonitorSmartphone },
      { tab: 'plugins', labelKey: 'configCenter.tabs.plugins', Icon: Puzzle },
    ],
  },
];

export const BeautyView: React.FC = () => {
  const [active, setActive] = useState<ConfigTab>('ui');
  return <SecondaryNavLayout groups={BEAUTY_GROUPS} active={active} onSelect={setActive} />;
};
