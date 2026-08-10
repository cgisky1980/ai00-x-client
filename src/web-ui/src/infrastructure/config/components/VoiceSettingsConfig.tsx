import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ConfigPageLayout,
  ConfigPageContent,
  ConfigPageHeader,
} from './common';
import { VoiceDeviceSelectionSection, VoiceInputSection } from './VoiceConfig';
import './VoiceConfig.scss';

const VoiceSettingsConfig: React.FC = () => {
  const { t } = useTranslation('settings/voice');

  return (
    <ConfigPageLayout>
      <ConfigPageHeader
        title={t('voiceSettings.title', { defaultValue: 'Voice Settings' })}
        subtitle={t('voiceSettings.subtitle', { defaultValue: 'Audio devices and voice input configuration' })}
      />
      <ConfigPageContent>
        <VoiceDeviceSelectionSection />
        <VoiceInputSection />
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default VoiceSettingsConfig;