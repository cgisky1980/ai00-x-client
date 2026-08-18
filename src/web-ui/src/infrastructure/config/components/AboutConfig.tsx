import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getVersionInfo, formatVersion } from '@/shared/utils/version';
import {
  ConfigPageLayout,
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageSection,
  ConfigPageRow,
} from './common';
import './AboutConfig.scss';

interface AppUpdateInfo {
  version: string;
  current_version: string;
  notes: string | null;
}

interface AppUpdateStatus {
  update_available: boolean;
  info: AppUpdateInfo | null;
}

const AboutConfig: React.FC = () => {
  const { t } = useTranslation('settings/about');
  const versionInfo = getVersionInfo();
  const displayVersion = formatVersion(versionInfo.version, versionInfo.isDev);

  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleCheck = async () => {
    setChecking(true);
    setMessage(null);
    setNewVersion(null);
    try {
      const status = await invoke<AppUpdateStatus>('check_app_update');
      if (status.update_available && status.info) {
        setNewVersion(status.info.version);
      } else {
        setMessage(t('upToDate', { defaultValue: 'Already up to date' }));
      }
    } catch (e) {
      setMessage(`${t('updateFailed', { defaultValue: 'Update failed' })}: ${e}`);
    } finally {
      setChecking(false);
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    setMessage(null);
    try {
      // Downloads, verifies and installs, then restarts the app.
      await invoke('install_app_update');
    } catch (e) {
      setMessage(`${t('updateFailed', { defaultValue: 'Update failed' })}: ${e}`);
      setInstalling(false);
    }
  };

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
            {newVersion ? (
              <button
                type="button"
                className="ai00-x-about-config__check-btn"
                onClick={handleInstall}
                disabled={installing}
              >
                {installing
                  ? t('installing', { defaultValue: 'Downloading & installing...' })
                  : `${t('downloadAndInstall', { defaultValue: 'Download & Install' })} v${newVersion}`}
              </button>
            ) : (
              <button
                type="button"
                className="ai00-x-about-config__check-btn"
                onClick={handleCheck}
                disabled={checking || installing}
              >
                {checking
                  ? t('checking', { defaultValue: 'Checking...' })
                  : t('checkNow', { defaultValue: 'Check Now' })}
              </button>
            )}
          </ConfigPageRow>
          {message && (
            <p className="ai00-x-about-config__status">{message}</p>
          )}
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
