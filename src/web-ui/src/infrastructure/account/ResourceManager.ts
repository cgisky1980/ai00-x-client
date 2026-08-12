/**
 * 头像资源管理器（web-ui 版：localStorage）
 *
 * 统一实现见 packages/shared/src/avatar-resource.ts（@ai00-x/shared）的 createResourceManager 工厂。
 * 此处通过传入 getAssetsBaseUrl 与 localStorage 版 storageAdapter 生成同名接口，
 * 保持对旧导入路径的兼容。
 */

export type {
  ManifestFileInfo,
  Manifest,
  AvatarResourceManager,
} from '@ai00-x/shared';

import { createResourceManager } from '@ai00-x/shared';
import { getAssetsBaseUrl } from './avatarConfigAdapter';
import { storage } from './storageAdapter';

export const resourceManager = createResourceManager({
  // 优先独立 assets_base_url（本地开发 → 嵌入服务器 /pet），否则回退 ai00_s_base_url
  getAssetsBaseUrl: () => getAssetsBaseUrl(),
  storage,
});