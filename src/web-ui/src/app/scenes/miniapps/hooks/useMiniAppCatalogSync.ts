/**
 * useMiniAppCatalogSync — keeps Mini App catalog and runtime state in sync.
 */
import { useCallback, useEffect } from 'react';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { miniAppAPI } from '@/infrastructure/api/service-api/MiniAppAPI';
import { createLogger } from '@/shared/utils/logger';
import { useMiniAppStore } from '../miniAppStore';

const log = createLogger('useMiniAppCatalogSync');

export function useMiniAppCatalogSync() {
  const setApps = useMiniAppStore((state) => state.setApps);
  const setLoading = useMiniAppStore((state) => state.setLoading);
  const setRunningWorkerIds = useMiniAppStore((state) => state.setRunningWorkerIds);
  const markWorkerRunning = useMiniAppStore((state) => state.markWorkerRunning);
  const markWorkerStopped = useMiniAppStore((state) => state.markWorkerStopped);

  const refreshApps = useCallback(async () => {
    setLoading(true);
    try {
      const apps = await miniAppAPI.listMiniApps();
      setApps(apps);
    } catch (error) {
      log.error('Failed to load miniapps', error);
    } finally {
      setLoading(false);
    }
  }, [setApps, setLoading]);

  const refreshRunningWorkers = useCallback(async () => {
    try {
      const running = await miniAppAPI.workerListRunning();
      setRunningWorkerIds(running);
    } catch (error) {
      log.error('Failed to load running miniapp workers', error);
    }
  }, [setRunningWorkerIds]);

  useEffect(() => {
    void refreshApps();
    void refreshRunningWorkers();

    const unlistenCreated = api.listen('miniapp-created', () => {
      void refreshApps();
    });
    const unlistenUpdated = api.listen('miniapp-updated', () => {
      void refreshApps();
    });
    const unlistenDeleted = api.listen<{ id?: string }>('miniapp-deleted', (payload) => {
      if (payload?.id) {
        markWorkerStopped(payload.id);
      }
      void refreshApps();
    });
    const unlistenRestarted = api.listen<{ id?: string }>('miniapp-worker-restarted', (payload) => {
      if (payload?.id) {
        markWorkerRunning(payload.id);
      }
    });
    const unlistenStopped = api.listen<{ id?: string }>('miniapp-worker-stopped', (payload) => {
      if (payload?.id) {
        markWorkerStopped(payload.id);
      }
    });

    return () => {
      unlistenCreated();
      unlistenUpdated();
      unlistenDeleted();
      unlistenRestarted();
      unlistenStopped();
    };
  }, [markWorkerRunning, markWorkerStopped, refreshApps, refreshRunningWorkers]);

  return {
    refreshApps,
    refreshRunningWorkers,
  };
}
