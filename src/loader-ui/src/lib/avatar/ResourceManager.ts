/**
 * 头像资源管理器（loader-ui 版：Rust KV 存储）
 *
 * 统一实现见 packages/shared/src/avatar-resource.ts（@ai00-x/shared）的 createResourceManager 工厂。
 * 此处通过传入 getAssetsBaseUrl 与共享 storage 生成同名接口，保持对旧导入路径的兼容。
 */

export type {
  ManifestFileInfo,
  Manifest,
  AvatarResourceManager,
} from '@ai00-x/shared';

import { createResourceManager } from '@ai00-x/shared';
import { getApiUrl } from '../config';
import { storage } from '../storage';

const ASSETS_PATH = '/pet';

export const resourceManager = createResourceManager({
  // getApiUrl('/pet') 返回 `${base}/pet`（含资源根路径）
  getAssetsBaseUrl: () => getApiUrl(ASSETS_PATH),
  storage,
});