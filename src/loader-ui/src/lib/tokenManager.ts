/**
 * TokenManager 单例：管理 access + refresh token 对
 *
 * 统一实现见 packages/shared/src/TokenManager.ts（@ai00-x/shared）。
 * 此处 re-export 以保持既有导入路径（@/lib/tokenManager）不变。
 */
export { tokenManager, type AuthInfo } from '@ai00-x/shared';