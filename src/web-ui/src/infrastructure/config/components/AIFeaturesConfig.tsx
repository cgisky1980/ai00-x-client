 

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch, ConfigPageLoading } from '@/component-library';
import { ConfigPageHeader, ConfigPageLayout, ConfigPageContent, ConfigPageSection, ConfigPageRow } from './common';
import { aiExperienceConfigService, type AIExperienceSettings } from '../services/AIExperienceConfigService';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import './AIFeaturesConfig.scss';

const log = createLogger('AIFeaturesConfig');

interface FeatureConfig {
  id: string;
  settingKey?: keyof AIExperienceSettings;
}


const FEATURE_CONFIGS: FeatureConfig[] = [
  {
    id: 'sessionTitle',
    settingKey: 'enable_session_title_generation',
  },
];

const AIFeaturesConfig: React.FC = () => {
  const { t } = useTranslation('settings/ai-features');
  const notification = useNotification();


  const [settings, setSettings] = useState<AIExperienceSettings>(() =>
    aiExperienceConfigService.getSettings()
  );
  const [isLoading, setIsLoading] = useState(true);

  const loadAllData = useCallback(async () => {
    setIsLoading(true);
    try {
      const loadedSettings = await aiExperienceConfigService.getSettingsAsync();

      setSettings(loadedSettings);
    } catch (error) {
      log.error('Failed to load data', error);
      setSettings(aiExperienceConfigService.getSettings());
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAllData();
  }, [loadAllData]);


  const updateSetting = async <K extends keyof AIExperienceSettings>(
    key: K,
    value: AIExperienceSettings[K]
  ) => {
    
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);

    
    try {
      await aiExperienceConfigService.saveSettings(newSettings);
      notification.success(t('messages.saveSuccess'));
    } catch (error) {
      log.error('Failed to save AI features settings', error);
      notification.error(`${t('messages.saveFailed')}: ` + (error instanceof Error ? error.message : String(error)));
      
      setSettings(settings);
    }
  };

  if (isLoading) {
    return (
      <ConfigPageLayout className="ai00-x-func-agent-config">
        <ConfigPageHeader
          title={t('title')}
          subtitle={t('subtitle')}
        />
        <ConfigPageContent className="ai00-x-func-agent-config__content">
          <ConfigPageLoading text={t('loading.text')} />
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }

  return (
    <ConfigPageLayout className="ai00-x-func-agent-config">
      <ConfigPageHeader
        title={t('title')}
        subtitle={t('subtitle')}
      />
      
      <ConfigPageContent className="ai00-x-func-agent-config__content">
        {FEATURE_CONFIGS.map((feature) => {
          const hasSwitch = !!feature.settingKey;
          const isEnabled = hasSwitch ? settings[feature.settingKey!] : true;
          const warning = t(`features.${feature.id}.warning`, '');

          return (
            <ConfigPageSection
              key={feature.id}
              title={t(`features.${feature.id}.title`)}
              description={t(`features.${feature.id}.subtitle`)}
            >
              {hasSwitch && (
                <ConfigPageRow
                  label={t('common.enable')}
                  description={warning && !isEnabled ? warning : undefined}
                  align="center"
                >
                  <div className="ai00-x-func-agent-config__row-control">
                    <Switch
                      checked={isEnabled}
                      onChange={(e) => updateSetting(feature.settingKey!, e.target.checked)}
                      size="small"
                    />
                  </div>
                </ConfigPageRow>
              )}
            </ConfigPageSection>
          );
        })}
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default AIFeaturesConfig;
