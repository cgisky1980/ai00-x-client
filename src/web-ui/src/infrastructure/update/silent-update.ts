/**
 * 静默自动更新（P0-4.2）：启动 60s 后首查 + 每 6 小时周期查，
 * 托盘「检查更新」（tray://check-update 事件）立即触发同一流程。
 * 发现新版出非阻断提示条；安装复用 install_app_update（passive 安装 + 自动重启）。
 * 所有检查失败静默吞掉（网络瞬断是常态，不打扰）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('SilentUpdate');

/** 与 Rust update_api.rs 的 AppUpdateStatus 对齐 */
interface AppUpdateInfo {
  version: string;
  current_version: string;
  notes: string | null;
}

interface AppUpdateStatus {
  update_available: boolean;
  info: AppUpdateInfo | null;
}

export interface SilentUpdateState {
  version: string;
  currentVersion: string;
  notes: string | null;
  installing: boolean;
}

const FIRST_CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DISMISSED_KEY = 'ai00-x-update-dismissed-version';

export function useSilentUpdate() {
  const [state, setState] = useState<SilentUpdateState | null>(null);
  const checkingRef = useRef(false);

  const runCheck = useCallback(async () => {
    if (checkingRef.current) return;
    if (typeof window === 'undefined' || !('__TAURI__' in window)) return;
    checkingRef.current = true;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<AppUpdateStatus>('check_app_update');
      if (!status.update_available || !status.info) return;
      try {
        if (localStorage.getItem(DISMISSED_KEY) === status.info.version) return;
      } catch {
        /* localStorage 不可用则每次都提示 */
      }
      logger.info('update available', { version: status.info.version });
      setState({
        version: status.info.version,
        currentVersion: status.info.current_version,
        notes: status.info.notes,
        installing: false,
      });
    } catch (e) {
      logger.debug('check failed (silent)', { error: String(e) });
    } finally {
      checkingRef.current = false;
    }
  }, []);

  const install = useCallback(async () => {
    setState((s) => (s ? { ...s, installing: true } : s));
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // 成功路径：下载 + passive 安装 + 引擎自动重启（Rust 侧实现）
      await invoke('install_app_update');
    } catch (e) {
      logger.error('install failed', { error: String(e) });
      setState((s) => (s ? { ...s, installing: false } : s));
    }
  }, []);

  const dismiss = useCallback(() => {
    setState((s) => {
      if (s?.version) {
        try {
          localStorage.setItem(DISMISSED_KEY, s.version);
        } catch {
          /* ignore */
        }
      }
      return null;
    });
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => {
      void runCheck();
    }, FIRST_CHECK_DELAY_MS);
    const interval = window.setInterval(() => {
      void runCheck();
    }, CHECK_INTERVAL_MS);
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const un = await listen('tray://check-update', () => {
          void runCheck();
        });
        unlisten = un;
      } catch {
        /* 事件桥不可用时仅靠定时器 */
      }
    })();
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
      unlisten?.();
    };
  }, [runCheck]);

  return { state, install, dismiss };
}
