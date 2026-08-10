import React from 'react';
import { FontPreferencePanel } from '@/infrastructure/font-preference';
import { useTranslation } from 'react-i18next';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
} from './common';
import {
  BasicsAppearanceSection,
  BasicsNotificationsSection,
} from './BasicsConfig';
import './BasicsConfig.scss';

const UiSettingsConfig: React.FC = () => {
  const { t } = useTranslation('settings/basics');

  return (
    <ConfigPageLayout className="ai00-x-basics-config">
      <ConfigPageHeader title={t('uiSettings.title')} subtitle={t('uiSettings.subtitle')} />
      <ConfigPageContent className="ai00-x-basics-config__content">
        <BasicsAppearanceSection />
        <FontPreferencePanel />
        <BasicsNotificationsSection />
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default UiSettingsConfig;