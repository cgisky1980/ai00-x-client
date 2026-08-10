import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ConfigPageLayout,
  ConfigPageContent,
  ConfigPageHeader,
} from './common';
import { VoiceEngineStatusSection } from './VoiceConfig';
import './VoiceConfig.scss';

const VoiceModelsConfig: React.FC = () => {
  const { t } = useTranslation('settings/voice');

  return (
    <ConfigPageLayout>
      <ConfigPageHeader
        title={t('voiceModels.title', { defaultValue: 'Voice Models' })}
        subtitle={t('voiceModels.subtitle', { defaultValue: 'ASR and TTS engine management' })}
      />
      <ConfigPageContent>
        <VoiceEngineStatusSection />
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default VoiceModelsConfig;