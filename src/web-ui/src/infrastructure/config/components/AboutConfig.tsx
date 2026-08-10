import React from 'react';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import { getVersionInfo, formatVersion } from '@/shared/utils/version';
import {
  ConfigPageLayout,
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageSection,
  ConfigPageRow,
} from './common';
import './AboutConfig.scss';

const AboutConfig: React.FC = () => {
  const { t } = useTranslation('settings/about');
  const versionInfo = getVersionInfo();
  const displayVersion = formatVersion(versionInfo.version, versionInfo.isDev);

  return (
    <ConfigPageLayout>
      <ConfigPageHeader
        title={t('title', { defaultValue: 'About' })}
        subtitle={t('subtitle', { defaultValue: 'Application information' })}
      />
      <ConfigPageContent>
        <div className="ai00-x-about-config__hero">
          <div className="ai00-x-about-config__logo">
            <Bot size={48} />
          </div>
          <h2 className="ai00-x-about-config__app-name">Ai00-X</h2>
          <p className="ai00-x-about-config__version">
            v{displayVersion}
          </p>
          <p className="ai00-x-about-config__description">
            {t('description', { defaultValue: 'AI Assistant Desktop Application' })}
          </p>
        </div>

        <ConfigPageSection title={t('updates.title', { defaultValue: 'Updates' })}>
          <ConfigPageRow
            label={t('checkUpdate', { defaultValue: 'Check for Updates' })}
            description={t('checkUpdateDesc', { defaultValue: 'Check if a newer version is available' })}
            align="center"
          >
            <button
              type="button"
              className="ai00-x-about-config__check-btn"
            >
              {t('checkNow', { defaultValue: 'Check Now' })}
            </button>
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection title={t('legal.title', { defaultValue: 'Legal' })}>
          <ConfigPageRow
            label={t('license', { defaultValue: 'License' })}
            align="center"
          >
            <span className="ai00-x-about-config__value">MIT License</span>
          </ConfigPageRow>
        </ConfigPageSection>
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default AboutConfig;