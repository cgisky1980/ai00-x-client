/**
 * 统一 KV 存储 Adapter（替代 localStorage/sessionStorage）
 *
 * 三个前端包（loader-ui / underlay-ui）共用的存储层。
 * 所有缓存走 Rust 侧存储，不依赖浏览器 localStorage。
 * - 敏感数据（token、avatar selection）→ EncryptedVault（AES-256-GCM）
 * - 非敏感数据（UI 偏好、locale）→ 明文 JSON KV
 *
 * 跨 webview 同步：通过 Tauri `kv_changed` 事件替代 `storage` 事件。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type KvStore = 'vault' | 'pref';

export interface KvChangedEvent {
  store: KvStore;
  key: string;
  /** None 表示已删除 */
  value: string | null;
}

/**
 * 敏感 key 集合 —— 自动路由到 vault（加密存储）。
 * 其他 key 自动路由到 pref（明文 KV）。
 */
const SENSITIVE_KEYS = new Set<string>([
  'ai00-s-token', // 花园社交 API token
  'ai00-x-avatar', // 用户 avatar selection（含自定义颜色/部位）
  'ai00_dev_token', // 开发模式 token
  'ai00_dev_username', // 开发模式用户名
  'login_passed', // 会话标志
]);

/** 按 key 自动路由到 vault 或 pref */
function autoRoute(key: string): KvStore {
  return SENSITIVE_KEYS.has(key) ? 'vault' : 'pref';
}

/**
 * 统一 KV 存储 API。
 *
 * 用法：
 * ```ts
 * import { storage } from '@ai00-x/shared';
 *
 * const token = await storage.get('ai00_dev_token');
 * await storage.set('ai00-x-locale', 'zh');
 * const unlisten = await storage.onChanged((e) => { ... });
 * ```
 */
export const storage = {
  async get(key: string, store?: KvStore): Promise<string | null> {
    const s = store ?? autoRoute(key);
    return invoke<string | null>(s === 'vault' ? 'vault_get' : 'pref_get', { key });
  },

  async getJson<T>(key: string, store?: KvStore): Promise<T | null> {
    const raw = await this.get(key, store);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async set(key: string, value: string, store?: KvStore): Promise<void> {
    const s = store ?? autoRoute(key);
    await invoke(s === 'vault' ? 'vault_set' : 'pref_set', { key, value });
  },

  async setJson(key: string, value: unknown, store?: KvStore): Promise<void> {
    await this.set(key, JSON.stringify(value), store);
  },

  async remove(key: string, store?: KvStore): Promise<void> {
    const s = store ?? autoRoute(key);
    await invoke(s === 'vault' ? 'vault_remove' : 'pref_remove', { key });
  },

  onChanged(callback: (e: KvChangedEvent) => void): Promise<UnlistenFn> {
    return listen<KvChangedEvent>('kv_changed', (event) => {
      callback(event.payload);
    });
  },
};