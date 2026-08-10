/**
 * Avatar 配置本地持久化（web-ui 版：localStorage）
 *
 * 统一实现见 packages/shared/src/avatarStorage.ts（@ai00-x/shared）的 createAvatarStorage 工厂。
 * 此处通过传入 localStorage 版 storageAdapter 生成同名接口，保持对旧导入路径的兼容。
 */

import { createAvatarStorage } from '@ai00-x/shared';
import { storage } from './storageAdapter';

export const { saveAvatarLocal, loadAvatarLocal, clearAvatarLocal } = createAvatarStorage(storage);