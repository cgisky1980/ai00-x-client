/**
 * 部位导向的 Avatar 配置类型定义（web-ui 版，从 loader-ui 移植）
 *
 * 统一实现见 packages/shared/src/avatar-config.ts（@ai00-x/shared）。
 * 此处仅为兼容旧导入路径的重导出。
 */

export {
  type PartDef,
  type PartVariant,
  type AvatarConfigFile,
  type AvatarSelection,
  getPartDef,
  hslToHex,
  createDefaultSelection,
} from '@ai00-x/shared';