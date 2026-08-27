import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Trash2, RefreshCw, Plus, Github, FolderOpen } from 'lucide-react';
import { Button, IconButton, Input, Switch, ConfirmDialog } from '@/component-library';
import { ConfigPageHeader, ConfigPageLayout, ConfigPageContent, ConfigPageSection, ConfigCollectionItem } from './common';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { isModuleHook, type PluginInfo } from '@ai00-x/shared';
import './PluginsConfig.scss';

const log = createLogger('PluginsConfig');

const PluginsConfig: React.FC = () => {
  const { t } = useTranslation('settings/plugins');
  const notification = useNotification();

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);
  const [githubSource, setGithubSource] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{ show: boolean; plugin: PluginInfo | null }>({
    show: false,
    plugin: null,
  });

  const loadPlugins = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await invoke<PluginInfo[]>('get_plugins');
      setPlugins(list);
    } catch (err) {
      log.error('Failed to load plugins', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPlugins(); }, [loadPlugins]);

  const handleInstallLocal = async () => {
    try {
      const selected = await open({
        multiple: false,
        title: t('install.selectPackage'),
        filters: [{ name: 'Ai00-X Plugin Package', extensions: ['a00pkg'] }],
      });
      if (!selected) return;
      setInstalling(true);
      await invoke('install_plugin', { packagePath: selected as string });
      notification.success(t('messages.installSuccess'));
      await loadPlugins();
    } catch (err) {
      notification.error(t('messages.installFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setInstalling(false);
    }
  };

  const handleInstallGithub = async () => {
    const source = githubSource.trim();
    if (!source) return;
    try {
      setInstalling(true);
      await invoke('install_plugin_from_github', { source });
      notification.success(t('messages.installSuccess'));
      setGithubSource('');
      await loadPlugins();
    } catch (err) {
      notification.error(t('messages.installFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setInstalling(false);
    }
  };

  const handleSetEnabled = async (plugin: PluginInfo, enabled: boolean) => {
    try {
      await invoke('set_plugin_enabled', { pluginId: plugin.manifest.id, enabled });
      setPlugins((prev) =>
        prev.map((p) => (p.manifest.id === plugin.manifest.id ? { ...p, enabled } : p)),
      );
    } catch (err) {
      notification.error(t('messages.toggleFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const confirmUninstall = async () => {
    const plugin = deleteConfirm.plugin;
    if (!plugin) return;
    try {
      await invoke('uninstall_plugin', { pluginId: plugin.manifest.id });
      notification.success(t('messages.uninstallSuccess', { name: plugin.manifest.name }));
      await loadPlugins();
    } catch (err) {
      notification.error(t('messages.uninstallFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setDeleteConfirm({ show: false, plugin: null });
    }
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hasInjectedHook = (plugin: PluginInfo) =>
    Object.values(plugin.manifest.hooks ?? {}).some((h) => isModuleHook(h));

  const renderPluginRow = (plugin: PluginInfo) => {
    const { manifest } = plugin;
    const badge = (
      <span className="ai00-x-collection-item__badge">v{manifest.version}</span>
    );
    const control = (
      <>
        <Switch
          size="small"
          checked={plugin.enabled}
          disabled={installing}
          onChange={(e) => handleSetEnabled(plugin, e.target.checked)}
          aria-label={t('list.item.enabledLabel', { name: manifest.name })}
        />
        <button
          type="button"
          className="ai00-x-collection-btn ai00-x-collection-btn--danger"
          onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ show: true, plugin }); }}
          title={t('list.item.uninstallTooltip')}
        >
          <Trash2 size={14} />
        </button>
      </>
    );
    const details = (
      <>
        <div className="ai00-x-collection-details__field">{manifest.description}</div>
        <div className="ai00-x-collection-details__meta">
          <span className="ai00-x-collection-details__label">{t('list.item.hooksLabel')}</span>
          <code>{Object.keys(manifest.hooks ?? {}).join(', ')}</code>
        </div>
        {manifest.repository && (
          <div className="ai00-x-collection-details__meta">
            <span className="ai00-x-collection-details__label">{t('list.item.repositoryLabel')}</span>
            <code>{manifest.repository}</code>
          </div>
        )}
      </>
    );
    return (
      <ConfigCollectionItem
        key={manifest.id}
        label={`${manifest.name}${manifest.author ? ` — ${manifest.author}` : ''}`}
        badge={badge}
        control={control}
        details={details}
        expanded={expandedIds.has(manifest.id)}
        onToggle={() => toggleExpanded(manifest.id)}
      />
    );
  };

  return (
    <ConfigPageLayout className="ai00-x-plugins-config">
      <ConfigPageHeader
        title={t('title')}
        subtitle={t('subtitle')}
      />

      <ConfigPageContent>
        <ConfigPageSection
          title={t('install.title')}
          description={t('install.description')}
          extra={(
            <IconButton
              variant="ghost"
              size="small"
              onClick={() => loadPlugins()}
              tooltip={t('install.refreshTooltip')}
            >
              <RefreshCw size={16} />
            </IconButton>
          )}
        >
          <div className="ai00-x-plugins-config__install-row">
            <Button
              variant="secondary"
              size="small"
              onClick={handleInstallLocal}
              disabled={installing}
            >
              <FolderOpen size={14} />
              {t('install.localButton')}
            </Button>
            <div className="ai00-x-plugins-config__github-input">
              <Input
                placeholder={t('install.githubPlaceholder')}
                value={githubSource}
                onChange={(e) => setGithubSource(e.target.value)}
                variant="outlined"
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
          </div>
          <div className="ai00-x-plugins-config__install-hint">{t('install.hint')}</div>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('list.title')}
          description={t('list.description')}
        >
          {loading ? (
            <div className="ai00-x-collection-empty"><p>{t('list.loading')}</p></div>
          ) : error ? (
            <div className="ai00-x-collection-empty"><p>{t('list.errorPrefix')}{error}</p></div>
          ) : plugins.length === 0 ? (
            <div className="ai00-x-collection-empty">
              <p>{t('list.empty')}</p>
              <Button variant="dashed" size="small" onClick={handleInstallLocal} disabled={installing}>
                <Plus size={14} />
                {t('install.localButton')}
              </Button>
            </div>
          ) : (
            plugins.map(renderPluginRow)
          )}
        </ConfigPageSection>
      </ConfigPageContent>

      <ConfirmDialog
        isOpen={deleteConfirm.show && !!deleteConfirm.plugin}
        onClose={() => setDeleteConfirm({ show: false, plugin: null })}
        onConfirm={confirmUninstall}
        title={t('deleteModal.title')}
        message={
          <>
            <p>{t('deleteModal.message', { name: deleteConfirm.plugin?.manifest.name })}</p>
            {deleteConfirm.plugin && hasInjectedHook(deleteConfirm.plugin) && (
              <p style={{ marginTop: '8px', color: 'var(--color-warning)' }}>
                {t('deleteModal.warning')}
              </p>
            )}
          </>
        }
        type="warning"
        confirmDanger
        confirmText={t('deleteModal.delete')}
        cancelText={t('deleteModal.cancel')}
      />
    </ConfigPageLayout>
  );
};

export default PluginsConfig;
