import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { Puzzle, Trash2, RefreshCw, Plus, Github, FolderOpen, BookOpen } from 'lucide-react';
import { Badge, Button, ConfirmDialog, IconButton, Input, Switch } from '@/component-library';
import { isModuleHook, type PluginInfo } from '@ai00-x/shared';
import { useNotification } from '@/shared/notification-system';
import { useInstalledPlugins } from './hooks/useInstalledPlugins';
import './PluginsScene.scss';

const PluginsScene: React.FC = () => {
  const { t } = useTranslation('scenes/plugins');
  const notification = useNotification();
  const {
    plugins,
    loading,
    error,
    installing,
    loadPlugins,
    installLocal,
    installFromGithub,
    uninstallPlugin,
    setPluginEnabled,
  } = useInstalledPlugins();

  const [githubSource, setGithubSource] = useState('');
  const [uninstallTarget, setUninstallTarget] = useState<PluginInfo | null>(null);

  const handleInstallLocal = async () => {
    try {
      const selected = await open({
        multiple: false,
        title: t('install.selectPackage'),
        filters: [{ name: 'Ai00-X Plugin Package', extensions: ['a00pkg'] }],
      });
      if (!selected) return;
      await installLocal(selected as string);
      notification.success(t('messages.installSuccess'));
    } catch (err) {
      notification.error(t('messages.installFailed', {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const handleInstallGithub = async () => {
    const source = githubSource.trim();
    if (!source) return;
    try {
      await installFromGithub(source);
      notification.success(t('messages.installSuccess'));
      setGithubSource('');
    } catch (err) {
      notification.error(t('messages.installFailed', {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const handleToggle = async (plugin: PluginInfo, enabled: boolean) => {
    try {
      await setPluginEnabled(plugin.manifest.id, enabled);
    } catch (err) {
      notification.error(t('messages.toggleFailed', {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const confirmUninstall = async () => {
    if (!uninstallTarget) return;
    const target = uninstallTarget;
    setUninstallTarget(null);
    try {
      await uninstallPlugin(target.manifest.id);
      notification.success(t('messages.uninstallSuccess', { name: target.manifest.name }));
    } catch (err) {
      notification.error(t('messages.uninstallFailed', {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const hasInjected = (plugin: PluginInfo) =>
    Object.values(plugin.manifest.hooks ?? {}).some(h => isModuleHook(h));

  const enabledCount = useMemo(
    () => plugins.filter(p => p.enabled).length,
    [plugins],
  );

  return (
    <div className="ai00-x-plugins-scene">
      <div className="ai00-x-plugins-scene__header">
        <div className="ai00-x-plugins-scene__title">
          <Puzzle size={18} />
          <h2>{t('title')}</h2>
          {!loading && !error && (
            <span className="ai00-x-plugins-scene__count">
              {t('count', { total: plugins.length, enabled: enabledCount })}
            </span>
          )}
        </div>
        <div className="ai00-x-plugins-scene__install">
          <Button
            variant="secondary"
            size="small"
            onClick={handleInstallLocal}
            disabled={installing}
          >
            <FolderOpen size={14} />
            {t('install.localButton')}
          </Button>
          <div className="ai00-x-plugins-scene__github">
            <Input
              placeholder={t('install.githubPlaceholder')}
              value={githubSource}
              onChange={(e) => setGithubSource(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleInstallGithub(); }}
              disabled={installing}
            />
            <Button
              variant="primary"
              size="small"
              onClick={handleInstallGithub}
              disabled={installing || !githubSource.trim()}
            >
              <Github size={14} />
              {installing ? t('install.installing') : t('install.githubButton')}
            </Button>
          </div>
          <IconButton
            variant="ghost"
            size="small"
            onClick={() => loadPlugins()}
            tooltip={t('install.refreshTooltip')}
          >
            <RefreshCw size={14} />
          </IconButton>
        </div>
      </div>

      <div className="ai00-x-plugins-scene__body">
        {loading ? (
          <div className="ai00-x-plugins-scene__empty">{t('list.loading')}</div>
        ) : error ? (
          <div className="ai00-x-plugins-scene__empty ai00-x-plugins-scene__empty--error">
            {t('list.errorPrefix')}{error}
          </div>
        ) : plugins.length === 0 ? (
          <div className="ai00-x-plugins-scene__empty">
            <p>{t('list.empty')}</p>
            <Button variant="dashed" size="small" onClick={handleInstallLocal} disabled={installing}>
              <Plus size={14} />
              {t('install.localButton')}
            </Button>
          </div>
        ) : (
          <div className="ai00-x-plugins-scene__grid">
            {plugins.map(plugin => {
              const { manifest } = plugin;
              const hooks = Object.keys(manifest.hooks ?? {});
              return (
                <div
                  key={manifest.id}
                  className={`ai00-x-plugins-scene__card${plugin.enabled ? '' : ' is-disabled'}`}
                >
                  <div className="ai00-x-plugins-scene__card-head">
                    <div className="ai00-x-plugins-scene__card-name">{manifest.name}</div>
                    <Badge variant="info">v{manifest.version}</Badge>
                    {!plugin.enabled && <Badge variant="neutral">{t('list.disabled')}</Badge>}
                  </div>
                  <div className="ai00-x-plugins-scene__card-desc">
                    {manifest.description || manifest.id}
                  </div>
                  <div className="ai00-x-plugins-scene__card-hooks">
                    {hooks.map(h => (
                      <code key={h} className="ai00-x-plugins-scene__hook-tag">{h}</code>
                    ))}
                  </div>
                  <div className="ai00-x-plugins-scene__card-meta">
                    {manifest.author && <span>{manifest.author}</span>}
                  </div>
                  <div className="ai00-x-plugins-scene__card-actions">
                    <Switch
                      size="small"
                      checked={plugin.enabled}
                      onChange={(e) => handleToggle(plugin, e.target.checked)}
                      aria-label={t('list.enabledLabel', { name: manifest.name })}
                    />
                    <IconButton
                      variant="ghost"
                      size="small"
                      className="ai00-x-plugins-scene__uninstall"
                      onClick={() => setUninstallTarget(plugin)}
                      tooltip={t('list.uninstallTooltip')}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="ai00-x-plugins-scene__footer">
        <BookOpen size={13} />
        <span>{t('footer.devGuide')}</span>
      </div>

      <ConfirmDialog
        isOpen={!!uninstallTarget}
        onClose={() => setUninstallTarget(null)}
        onConfirm={confirmUninstall}
        title={t('uninstallModal.title')}
        message={
          <>
            <p>{t('uninstallModal.message', { name: uninstallTarget?.manifest.name })}</p>
            <p className="ai00-x-plugins-scene__modal-hint">{t('uninstallModal.dataHint')}</p>
            {uninstallTarget && hasInjected(uninstallTarget) && (
              <p className="ai00-x-plugins-scene__modal-hint ai00-x-plugins-scene__modal-hint--warn">
                {t('uninstallModal.injectedWarning')}
              </p>
            )}
          </>
        }
        type="warning"
        confirmDanger
        confirmText={t('uninstallModal.confirm')}
        cancelText={t('uninstallModal.cancel')}
      />
    </div>
  );
};

export default PluginsScene;
