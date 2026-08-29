import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { createLogger } from '@/shared/utils/logger';
import { vramAPI } from '@/infrastructure/api/service-api/VramAPI';
import type { VramEngineStatus, VramEngineStateEvent } from '@/infrastructure/api/service-api/VramAPI';

const log = createLogger('VramStatus');

interface SystemStats {
  cpuUsage: number;
  memUsage: number;
  memTotal: number;
  gpuUsage: number | null;
  gpuMemUsage: number | null;
  gpuMemTotal: number | null;
  netUp: number;
  netDown: number;
}

export interface VramStatusState {
  gpuMemUsage: number | null;
  gpuMemTotal: number | null;
  gpuUsage: number | null;
  engines: VramEngineStatus[];
}

/**
 * VRAM status: subscribes to `system-stats` (GPU memory/util) and
 * `vram-engine-state` (engine residency changes), with the initial engine
 * list fetched on mount. Engine list is dynamic — plugin-registered engines
 * appear automatically.
 */
export function useVramStatus(): VramStatusState & { releaseEngine: (id: string) => Promise<void> } {
  const [gpu, setGpu] = useState<{ usage: number | null; memUsed: number | null; memTotal: number | null }>({
    usage: null,
    memUsed: null,
    memTotal: null,
  });
  const [engines, setEngines] = useState<VramEngineStatus[]>([]);

  const refreshEngines = useCallback(() => {
    vramAPI
      .listEngines()
      .then(setEngines)
      .catch((e) => log.info('listEngines unavailable (engine not started yet)', e));
  }, []);

  useEffect(() => {
    refreshEngines();

    const unlistenStats = listen<SystemStats>('system-stats', (event) => {
      const s = event.payload;
      setGpu({ usage: s.gpuUsage ?? null, memUsed: s.gpuMemUsage ?? null, memTotal: s.gpuMemTotal ?? null });
    });

    const unlistenState = listen<VramEngineStateEvent>('vram-engine-state', (event) => {
      const p = event.payload;
      setEngines((prev) => {
        const idx = prev.findIndex((e) => e.engineId === p.engineId);
        if (idx < 0) return prev; // unknown engine: full refresh on next open
        const next = [...prev];
        next[idx] = { ...next[idx], resident: p.resident };
        return next;
      });
    });

    return () => {
      unlistenStats.then((fn) => fn());
      unlistenState.then((fn) => fn());
    };
  }, [refreshEngines]);

  const releaseEngine = useCallback(
    async (engineId: string) => {
      await vramAPI.evictEngine(engineId);
      refreshEngines();
    },
    [refreshEngines]
  );

  return {
    gpuMemUsage: gpu.memUsed,
    gpuMemTotal: gpu.memTotal,
    gpuUsage: gpu.usage,
    engines,
    releaseEngine,
  };
}

/**
 * Report the current activity context to the VRAM manager while mounted.
 * Mount one instance per tool page (e.g. `useVramContext('music')` in the
 * music workspace); on unmount the context is cleared automatically.
 */
export function useVramContext(context: string): void {
  useEffect(() => {
    vramAPI.setActiveContext(context);
    return () => {
      vramAPI.setActiveContext(null);
    };
  }, [context]);
}
