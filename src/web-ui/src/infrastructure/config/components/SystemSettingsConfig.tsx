import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/component-library';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageSection,
  ConfigPageRow,
} from './common';
import {
  BasicsLaunchAtLoginSection,
  BasicsLoggingSection,
  BasicsTerminalSection,
} from './BasicsConfig';
import { configManager } from '../services/ConfigManager';
import './BasicsConfig.scss';

/** AnySearch API key section — optional, raises rate limits from 10/min to 20/min. */
function WebSearchSection() {
  const { t } = useTranslation('settings/basics');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const showMessage = useCallback((type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const saved = await configManager.getConfig<string>('ai.anysearch_api_key');
        setApiKey(saved ?? '');
      } catch {
        // Key not configured yet — leave empty (anonymous mode).
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const trimmed = apiKey.trim();
      // Empty string → delete the key (use null for anonymous mode).
      if (trimmed) {
        await configManager.setConfig('ai.anysearch_api_key', trimmed);
      } else {
        await configManager.setConfig('ai.anysearch_api_key', null);
      }
      configManager.clearCache();
      showMessage('success', t('webSearch.messages.saveSuccess'));
    } catch (error) {
      showMessage('error', t('webSearch.messages.saveFailed'));
       
      console.error('Failed to save AnySearch API key:', error);
    } finally {
      setSaving(false);
    }
  }, [apiKey, showMessage, t]);

  return (
    <ConfigPageSection title={t('webSearch.title')} description={t('webSearch.description')}>
      <ConfigPageRow label={t('webSearch.apiKeyLabel')} align="center" wide>
        <Input
          type={showKey ? 'text' : 'password'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('webSearch.apiKeyPlaceholder')}
          inputSize="small"
          disabled={loading || saving}
          suffix={
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '4px',
                color: 'var(--color-text-muted)',
                display: 'flex',
                alignItems: 'center',
              }}
              aria-label={showKey ? t('webSearch.hideKey') : t('webSearch.showKey')}
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          }
        />
      </ConfigPageRow>
      <ConfigPageRow label="" align="center">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
          {message && (
            <span style={{ color: message.type === 'success' ? 'var(--color-success, #34d399)' : 'var(--color-error, #ef4444)', fontSize: 12 }}>
              {message.text}
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={loading || saving}
            style={{
              padding: '6px 16px',
              background: 'var(--color-accent-500)',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: loading || saving ? 'not-allowed' : 'pointer',
              fontSize: 13,
              opacity: loading || saving ? 0.6 : 1,
            }}
          >
            {saving ? t('webSearch.saving') : t('webSearch.save')}
          </button>
        </div>
      </ConfigPageRow>
      <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
        {t('webSearch.hint')}
      </p>
    </ConfigPageSection>
  );
}

const SystemSettingsConfig: React.FC = () => {
  const { t } = useTranslation('settings/basics');

  return (
    <ConfigPageLayout className="ai00-x-basics-config">
      <ConfigPageHeader title={t('systemSettings.title')} subtitle={t('systemSettings.subtitle')} />
      <ConfigPageContent className="ai00-x-basics-config__content">
        <BasicsLaunchAtLoginSection />
        <BasicsLoggingSection />
        <BasicsTerminalSection />
        <WebSearchSection />
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default SystemSettingsConfig;
