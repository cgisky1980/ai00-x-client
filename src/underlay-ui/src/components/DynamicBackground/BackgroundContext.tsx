import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { BackgroundConfig, MonitorInfo } from './types';
import { DEFAULT_BACKGROUND_CONFIG } from './types';
import { storage } from '../../lib/storage';

interface BackgroundContextType {
  config: BackgroundConfig;
  monitors: MonitorInfo[];
  setConfig: (config: BackgroundConfig) => void;
}

const Ctx = createContext<BackgroundContextType | null>(null);

const STORAGE_KEY = 'ai00.underlay.background';

async function loadConfig(): Promise<BackgroundConfig> {
  try {
    const raw = await storage.get(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.default?.type) {
        return parsed as BackgroundConfig;
      }
    }
  } catch {
    // fall through
  }
  return DEFAULT_BACKGROUND_CONFIG;
}

function saveConfig(config: BackgroundConfig): void {
  storage.setJson(STORAGE_KEY, config).catch(() => {
    // ignore
  });
}

async function loadMonitors(): Promise<MonitorInfo[]> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    if (!invoke) return [];
    const monitors = await invoke<MonitorInfo[]>('get_monitors');
    return monitors ?? [];
  } catch {
    // Fallback: estimate monitors from window dimensions
    const w = window.innerWidth;
    const h = window.innerHeight;
    return [{ id: 0, x: 0, y: 0, width: w, height: h, isPrimary: true }];
  }
}

export function BackgroundProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfigState] = useState<BackgroundConfig>(DEFAULT_BACKGROUND_CONFIG);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);

  // 初始化：从 storage 异步加载配置（替代 localStorage 同步读取）
  useEffect(() => {
    loadConfig().then(setConfigState);
  }, []);

  useEffect(() => {
    loadMonitors().then(setMonitors);
  }, []);

  const setConfig = useCallback((newConfig: BackgroundConfig) => {
    setConfigState(newConfig);
    saveConfig(newConfig);
  }, []);

  // Listen for Tauri event from settings page
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<BackgroundConfig>('underlay_background_change', (event) => {
        const cfg = event.payload;
        if (cfg && cfg.default && typeof cfg.default.type === 'string') {
          setConfigState(cfg);
          saveConfig(cfg);
        }
      }).then((fn) => {
        unlisten = fn;
      });
    }).catch(() => {
      // not in Tauri context
    });
    return () => { unlisten?.(); };
  }, []);

  // Listen for KV storage changes (cross-webview sync, replaces 'storage' event)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    storage.onChanged((e) => {
      if (e.key === STORAGE_KEY && e.value) {
        try {
          setConfigState(JSON.parse(e.value));
        } catch {
          // ignore
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => { unlisten?.(); };
  }, []);

  const value = useMemo<BackgroundContextType>(
    () => ({ config, monitors, setConfig }),
    [config, monitors, setConfig],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBackground(): BackgroundContextType {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('BackgroundProvider missing');
  return ctx;
}