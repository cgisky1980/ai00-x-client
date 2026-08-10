import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FontPreferencePanel } from '@/infrastructure/font-preference';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Sun, Moon } from 'lucide-react';
import {
  Alert,
  Select,
  Switch,
  Tooltip,
  ConfigPageLoading,
  ConfigPageMessage,
} from '@/component-library';
import { configAPI, workspaceAPI } from '@/infrastructure/api';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { getTerminalService } from '@/tools/terminal';
import type { ShellInfo } from '@/tools/terminal/types/session';
import {
  useTheme,
  HueSlider,
} from '@/infrastructure/theme';
import { useLanguageSelector } from '@/infrastructure/i18n';
import type { LocaleId } from '@/infrastructure/i18n/types';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageSection,
  ConfigPageRow,
} from './common';
import { configManager } from '../services/ConfigManager';
import { createLogger } from '@/shared/utils/logger';
import type { BackendLogLevel, RuntimeLoggingInfo, TerminalConfig as TerminalSettings } from '../types';
import './BasicsConfig.scss';

const log = createLogger('BasicsConfig');

export function BasicsAppearanceSection() {
  const { t } = useTranslation('settings/basics');
  const { isDark, isLight, accentHue, setAccentHue, themes, setTheme, loading } = useTheme();
  const { currentLanguage, supportedLocales, selectLanguage, isChanging } = useLanguageSelector();

  const handleThemeTypeToggle = useCallback(async () => {
    const targetType = isDark ? 'light' : 'dark';
    const targetTheme = themes.find(t => t.type === targetType);
    if (targetTheme) {
      await setTheme(targetTheme.id);
    }
  }, [isDark, themes, setTheme]);

  const handleHueChange = useCallback(async (hue: number) => {
    await setAccentHue(hue);
  }, [setAccentHue]);

  return (
    <div className="theme-config">
      <div className="theme-config__content">
        <ConfigPageSection title={t('appearance.title')} description={t('appearance.hint')}>
          <ConfigPageRow
            label={t('appearance.language')}
            description={t('appearance.languageRowHint', {
              defaultValue: 'Choose one language pack as the active UI language.',
            })}
            align="center"
          >
            <div className="theme-config__language-select">
              <select
                value={currentLanguage}
                onChange={(e) => selectLanguage(e.target.value as LocaleId)}
                disabled={isChanging}
                className="theme-config__native-select"
              >
                {supportedLocales.map((locale) => (
                  <option key={locale.id} value={locale.id}>
                    {locale.nativeName}
                  </option>
                ))}
              </select>
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={t('appearance.mode', { defaultValue: 'Mode' })}
            description={t('appearance.modeRowHint', {
              defaultValue: 'Switch between light and dark mode.',
            })}
            align="center"
          >
            <div className="theme-config__mode-toggle">
              <button
                className={`theme-config__mode-btn ${isLight ? 'theme-config__mode-btn--active' : ''}`}
                onClick={isDark ? handleThemeTypeToggle : undefined}
                disabled={loading}
                type="button"
              >
                <Sun size={14} />
                <span>{t('appearance.lightMode')}</span>
              </button>
              <button
                className={`theme-config__mode-btn ${isDark ? 'theme-config__mode-btn--active' : ''}`}
                onClick={isLight ? handleThemeTypeToggle : undefined}
                disabled={loading}
                type="button"
              >
                <Moon size={14} />
                <span>{t('appearance.darkMode')}</span>
              </button>
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={t('appearance.accentColor', { defaultValue: 'Accent Color' })}
            description={t('appearance.accentColorRowHint', {
              defaultValue: 'Pick the accent color for the interface.',
            })}
            align="center"
          >
            <div className="theme-config__accent-picker">
              <HueSlider
                hue={accentHue}
                onChange={handleHueChange}
                disabled={loading}
              />
              <div
                className="theme-config__accent-preview"
                style={{ backgroundColor: `hsl(${accentHue}, 72%, ${isDark ? 65 : 45}%)` }}
              />
            </div>
          </ConfigPageRow>
        </ConfigPageSection>
      </div>
    </div>
  );
}

export function BasicsLaunchAtLoginSection() {
  const { t } = useTranslation('settings/basics');
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const showMessage = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  useEffect(() => {
    if (!isTauri) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);
        const v = await systemAPI.getLaunchAtLoginEnabled();
        if (!cancelled) {
          setEnabled(v);
        }
      } catch (error) {
        log.error('Failed to load launch-at-login state', error);
        if (!cancelled) {
          showMessage('error', t('launchAtLogin.messages.loadFailed'));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isTauri, showMessage, t]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      setSaving(true);
      try {
        await systemAPI.setLaunchAtLoginEnabled(next);
      } catch (error) {
        setEnabled(previous);
        log.error('Failed to set launch-at-login', { next, error });
        showMessage('error', t('launchAtLogin.messages.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [enabled, showMessage, t]
  );

  if (!isTauri) {
    return null;
  }

  if (loading) {
    return <ConfigPageLoading text={t('launchAtLogin.messages.loading')} />;
  }

  return (
    <div className="ai00-x-launch-at-login-config">
      <div className="ai00-x-launch-at-login-config__content">
        <ConfigPageMessage message={message} />
        <ConfigPageSection
          title={t('launchAtLogin.sections.title')}
          description={t('launchAtLogin.sections.hint')}
        >
          <ConfigPageRow
            label={t('launchAtLogin.toggleLabel')}
            description={t('launchAtLogin.toggleDescription')}
            align="center"
          >
            <Switch
              checked={enabled}
              onChange={(e) => {
                void handleToggle(e.target.checked);
              }}
              disabled={saving}
            />
          </ConfigPageRow>
        </ConfigPageSection>
      </div>
    </div>
  );
}

export function BasicsLoggingSection() {
  const { t } = useTranslation('settings/basics');
  const [configLevel, setConfigLevel] = useState<BackendLogLevel>('info');
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeLoggingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const levelOptions = useMemo(
    () => [
      { value: 'trace', label: t('logging.levels.trace') },
      { value: 'debug', label: t('logging.levels.debug') },
      { value: 'info', label: t('logging.levels.info') },
      { value: 'warn', label: t('logging.levels.warn') },
      { value: 'error', label: t('logging.levels.error') },
      { value: 'off', label: t('logging.levels.off') },
    ],
    [t]
  );

  const showMessage = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      const [savedLevel, info] = await Promise.all([
        configManager.getConfig<BackendLogLevel>('app.logging.level'),
        configAPI.getRuntimeLoggingInfo(),
      ]);

      setConfigLevel(savedLevel || info.effectiveLevel || 'info');
      setRuntimeInfo(info);
    } catch (error) {
      log.error('Failed to load logging config', error);
      showMessage('error', t('logging.messages.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [showMessage, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleLevelChange = useCallback(
    async (value: string) => {
      const nextLevel = value as BackendLogLevel;
      const previousLevel = configLevel;
      setConfigLevel(nextLevel);
      setSaving(true);

      try {
        await configManager.setConfig('app.logging.level', nextLevel);
        configManager.clearCache();

        const info = await configAPI.getRuntimeLoggingInfo();
        setRuntimeInfo(info);
        showMessage('success', t('logging.messages.levelUpdated'));
      } catch (error) {
        setConfigLevel(previousLevel);
        log.error('Failed to update logging level', { nextLevel, error });
        showMessage('error', t('logging.messages.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [configLevel, showMessage, t]
  );

  const handleOpenFolder = useCallback(async () => {
    const folder = runtimeInfo?.sessionLogDir;
    if (!folder) {
      showMessage('error', t('logging.messages.pathUnavailable'));
      return;
    }

    try {
      setOpeningFolder(true);
      await workspaceAPI.revealInExplorer(folder);
    } catch (error) {
      log.error('Failed to open log folder', { folder, error });
      showMessage('error', t('logging.messages.openFailed'));
    } finally {
      setOpeningFolder(false);
    }
  }, [runtimeInfo?.sessionLogDir, showMessage, t]);

  if (loading) {
    return <ConfigPageLoading text={t('logging.messages.loading')} />;
  }

  return (
    <div className="ai00-x-logging-config">
      <div className="ai00-x-logging-config__content">
        <ConfigPageMessage message={message} />

        <ConfigPageSection
          title={t('logging.sections.logging')}
          description={t('logging.sections.loggingHint')}
        >
          <ConfigPageRow
            label={t('logging.sections.level')}
            description={t('logging.level.description')}
            align="center"
          >
            <div className="ai00-x-logging-config__select-wrapper">
              <Select
                value={configLevel}
                onChange={(v) => handleLevelChange(v as string)}
                options={levelOptions}
                disabled={saving}
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={t('logging.sections.path')}
            description={t('logging.path.description')}
            multiline
          >
            <div className="ai00-x-logging-config__path-row">
              <div className="ai00-x-logging-config__path-box">
                {runtimeInfo?.sessionLogDir || '-'}
              </div>
              <Tooltip content={t('logging.actions.openFolderTooltip')} placement="top">
                <button
                  type="button"
                  className="ai00-x-logging-config__open-btn"
                  onClick={handleOpenFolder}
                  disabled={openingFolder || !runtimeInfo?.sessionLogDir}
                >
                  <FolderOpen size={14} />
                </button>
              </Tooltip>
            </div>
          </ConfigPageRow>
        </ConfigPageSection>
      </div>
    </div>
  );
}

export function BasicsTerminalSection() {
  const { t } = useTranslation('settings/basics');
  const [defaultShell, setDefaultShell] = useState<string>('');
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [platform, setPlatform] = useState<string>('');

  const showMessage = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      const [terminalConfig, shells, systemInfo] = await Promise.all([
        configManager.getConfig<TerminalSettings>('terminal'),
        getTerminalService().getAvailableShells(),
        systemAPI.getSystemInfo().catch(() => ({ platform: '' })),
      ]);

      setDefaultShell(terminalConfig?.default_shell || '');

      const availableOnly = shells.filter((s) => s.available);
      setAvailableShells(availableOnly);

      setPlatform(systemInfo.platform || '');
    } catch (error) {
      log.error('Failed to load terminal config data', error);
      showMessage('error', t('terminal.messages.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [showMessage, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleShellChange = useCallback(
    async (value: string) => {
      try {
        setSaving(true);
        setDefaultShell(value);

        await configManager.setConfig('terminal.default_shell', value);

        configManager.clearCache();

        showMessage('success', t('terminal.messages.updated'));
      } catch (error) {
        log.error('Failed to save terminal config', { shell: value, error });
        showMessage('error', t('terminal.messages.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [showMessage, t]
  );

  const shouldShowPowerShellCoreRecommendation = useMemo(() => {
    const isWindows = platform === 'windows';
    if (!isWindows) return false;

    const hasPowerShellCore = availableShells.some((shell) => shell.shellType === 'PowerShellCore');

    return !hasPowerShellCore;
  }, [availableShells, platform]);

  const shellOptions = useMemo(
    () => [
      { value: '', label: t('terminal.controls.autoDetect') },
      ...availableShells.map((shell) => ({
        value: shell.shellType,
        label: `${shell.name}${shell.version ? ` (${shell.version})` : ''}`,
      })),
    ],
    [availableShells, t]
  );

  const terminalSectionDescription = useMemo(() => {
    const hint = t('terminal.sections.terminalHint');
    if (!shouldShowPowerShellCoreRecommendation) {
      return hint;
    }
    return (
      <>
        {hint}
        <span className="ai00-x-terminal-config__section-hint-sep"> · </span>
        <span className="ai00-x-terminal-config__section-hint-extra">
          {t('terminal.recommendations.pwsh.prefix')}{' '}
          <span className="ai00-x-terminal-config__section-hint-extra-name">
            {t('terminal.recommendations.pwsh.name')}
          </span>
          {t('terminal.recommendations.pwsh.suffix')}{' '}
          <a
            href="https://aka.ms/PSWindows"
            target="_blank"
            rel="noopener noreferrer"
            className="ai00-x-terminal-config__section-hint-link"
          >
            {t('terminal.recommendations.pwsh.link')}
          </a>
        </span>
      </>
    );
  }, [shouldShowPowerShellCoreRecommendation, t]);

  if (loading) {
    return <ConfigPageLoading text={t('terminal.messages.loading')} />;
  }

  return (
    <div className="ai00-x-terminal-config">
      <div className="ai00-x-terminal-config__content">
        <ConfigPageMessage message={message} />

        <ConfigPageSection
          title={t('terminal.sections.terminal')}
          description={terminalSectionDescription}
        >
          <ConfigPageRow
            label={t('terminal.sections.defaultTerminal')}
            description={t('terminal.controls.description')}
            align="center"
          >
            <div className="ai00-x-terminal-config__select-wrapper">
              {availableShells.length > 0 ? (
                <Select
                  value={defaultShell}
                  onChange={(v) => handleShellChange(v as string)}
                  options={shellOptions}
                  placeholder={t('terminal.controls.placeholder')}
                  disabled={saving}
                />
              ) : (
                <div className="ai00-x-terminal-config__no-shells">{t('terminal.controls.noShells')}</div>
              )}
            </div>
          </ConfigPageRow>

          {platform === 'windows' && defaultShell === 'Cmd' && (
            <div className="ai00-x-terminal-config__inline-alert">
              <Alert type="warning" message={t('terminal.warnings.cmd')} />
            </div>
          )}
          {platform === 'windows' && defaultShell === 'Bash' && (
            <div className="ai00-x-terminal-config__inline-alert">
              <Alert type="warning" message={t('terminal.warnings.gitBash')} />
            </div>
          )}
        </ConfigPageSection>
      </div>
    </div>
  );
}

export function BasicsNotificationsSection() {
  const { t } = useTranslation('settings/basics');
  const [dialogNotify, setDialogNotify] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const notify = await configManager.getConfig<boolean>('app.notifications.dialog_completion_notify');
        setDialogNotify(notify !== false);
      } catch {
        setDialogNotify(true);
      }
    })();
  }, []);

  const handleDialogNotifyToggle = async (checked: boolean) => {
    setSaving(true);
    try {
      await configAPI.setConfig('app.notifications.dialog_completion_notify', checked);
      setDialogNotify(checked);
      setMessage({ type: 'success', text: t('notifications.messages.saveSuccess') });
    } catch {
      setMessage({ type: 'error', text: t('notifications.messages.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfigPageSection
      title={t('notifications.title')}
      description={t('notifications.hint')}
    >
      <ConfigPageMessage message={message} />
      <ConfigPageRow
        label={t('notifications.dialogCompletion.label')}
        description={t('notifications.dialogCompletion.description')}
        align="center"
      >
        <Switch
          checked={dialogNotify}
          onChange={(e) => { void handleDialogNotifyToggle(e.target.checked); }}
          disabled={saving}
        />
      </ConfigPageRow>
    </ConfigPageSection>
  );
}

const BasicsConfig: React.FC = () => {
  const { t } = useTranslation('settings/basics');

  return (
    <ConfigPageLayout className="ai00-x-basics-config">
      <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />
      <ConfigPageContent className="ai00-x-basics-config__content">
        <BasicsAppearanceSection />
        <FontPreferencePanel />
        <BasicsLaunchAtLoginSection />
        <BasicsLoggingSection />
        <BasicsTerminalSection />
        <BasicsNotificationsSection />
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default BasicsConfig;
