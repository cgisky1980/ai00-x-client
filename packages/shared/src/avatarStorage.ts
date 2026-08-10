/**
 * Avatar 配置本地持久化（三包共用，工厂模式）
 *
 * loader-ui / underlay-ui 用 Tauri Rust KV 存储，web-ui 用 localStorage。
 * 三者的存取逻辑完全一致（仅存储后端不同），故抽成工厂函数，
 * 由各包传入自己的 storage adapter 即可。
 *
 * 存储 key: 'ai00-x-avatar'
 * 存储 value: JSON 字符串（AvatarSelection: { parts, colors }）
 *
 * 数据流：
 *   保存：ProfileEditSection/OnboardingPanel.handleSave → 成功后 saveAvatarLocal
 *   读取：页面启动 → loadAvatarLocal（快速回填）→ getMemberProfile（服务端同步覆盖）
 */

import type { AvatarSelection } from './avatar-config';

/** 各包 storage adapter 需满足的最小接口（getJson/setJson/remove） */
export interface StorageLike {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

const STORAGE_KEY = 'ai00-x-avatar';

/**
 * 基于传入存储后端创建 avatar 本地持久化接口。
 * @param storage 满足 StorageLike 的存储 adapter（Tauri KV 或 localStorage）
 */
export function createAvatarStorage(storage: StorageLike) {
  return {
    /** 保存 avatar 配置到本地存储 */
    async saveAvatarLocal(avatar: AvatarSelection): Promise<void> {
      try {
        await storage.setJson(STORAGE_KEY, avatar);
      } catch (e) {
        console.warn('[avatarStorage] save failed:', e);
      }
    },

    /** 从本地存储读取 avatar 配置
     * @returns 解析后的 AvatarSelection，或 null（无缓存/解析失败）
     */
    async loadAvatarLocal(): Promise<AvatarSelection | null> {
      try {
        const parsed = await storage.getJson<AvatarSelection>(STORAGE_KEY);
        if (!parsed || typeof parsed !== 'object') return null;
        // 基本校验：必须有 parts 和 colors 对象
        if (!parsed.parts || typeof parsed.parts !== 'object') return null;
        if (!parsed.colors || typeof parsed.colors !== 'object') return null;
        return parsed;
      } catch (e) {
        console.warn('[avatarStorage] load failed:', e);
        return null;
      }
    },

    /** 清除本地 avatar 配置 */
    async clearAvatarLocal(): Promise<void> {
      try {
        await storage.remove(STORAGE_KEY);
      } catch (e) {
        console.warn('[avatarStorage] clear failed:', e);
      }
    },
  };
}