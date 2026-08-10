/**
 * Avatar 配置类型定义（underlay-ui 版，从 loader-ui 复用）
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