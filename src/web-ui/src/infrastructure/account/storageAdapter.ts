/**
 * localStorage 版 storage shim（替代 loader-ui 的 Tauri KV 存储）
 *
 * 用途：avatar 配置本地持久化（avatarStorage.ts）+ ResourceManager manifest 版本记录
 * web-ui 无统一 storage 模块，用 localStorage 封装同 API（异步签名保持兼容）
 */

export const storage = {
  async get(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async set(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn('[storageAdapter] set failed:', e);
    }
  },

  async setJson(key: string, value: unknown): Promise<void> {
    await this.set(key, JSON.stringify(value));
  },

  async remove(key: string): Promise<void> {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn('[storageAdapter] remove failed:', e);
    }
  },
};
