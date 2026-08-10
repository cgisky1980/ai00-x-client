/**
 * web-ui JWT 工具函数
 *
 * 统一实现见 packages/shared/src/auth.ts（@ai00-x/shared）。
 * 此处 re-export 以保持既有导入路径（./authUtils）不变。
 */
export { isTokenExpired } from '@ai00-x/shared'