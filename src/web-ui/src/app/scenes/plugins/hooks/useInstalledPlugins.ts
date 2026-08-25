import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PluginInfo } from '@ai00-x/shared';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('useInstalledPlugins');

/**
 * Installed plugins data hook: load / install / uninstall / enable / disable.
 * Race-guarded by a monotonic request id (stale responses are dropped).
 */
export function useInstalledPlugins() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const loadRequestIdRef = useRef(0);

  const loadPlugins = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    try {
      setLoading(true);
      setError(null);
      const list = await invoke<PluginInfo[]>('get_plugins');
      if (requestId !== loadRequestIdRef.current) return;
      setPlugins(list);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      log.error('Failed to load plugins', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => { loadPlugins(); }, [loadPlugins]);

  const installLocal = useCallback(async (packagePath: string) => {
    setInstalling(true);
    try {
      await invoke('install_plugin', { packagePath });
      await loadPlugins();
    } finally {
      setInstalling(false);
    }
  }, [loadPlugins]);

  const installFromGithub = useCallback(async (source: string) => {
    setInstalling(true);
    try {
      await invoke('install_plugin_from_github', { source });
      await loadPlugins();
    } finally {
      setInstalling(false);
    }
  }, [loadPlugins]);

  const uninstallPlugin = useCallback(async (pluginId: string) => {
    await invoke('uninstall_plugin', { pluginId });
    await loadPlugins();
  }, [loadPlugins]);

  const setPluginEnabled = useCallback(async (pluginId: string, enabled: boolean) => {
    // Optimistic toggle; revert on failure.
    setPlugins(prev =>
      prev.map(p => (p.manifest.id === pluginId ? { ...p, enabled } : p)),
    );
    try {
      await invoke('set_plugin_enabled', { pluginId, enabled });
    } catch (err) {
      setPlugins(prev =>
        prev.map(p => (p.manifest.id === pluginId ? { ...p, enabled: !enabled } : p)),
      );
      throw err;
    }
  }, []);

  return {
    plugins,
    loading,
    error,
    installing,
    loadPlugins,
    installLocal,
    installFromGithub,
    uninstallPlugin,
    setPluginEnabled,
  };
}
