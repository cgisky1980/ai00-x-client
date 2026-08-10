/**
 * TokenManager：管理 access + refresh token，自动刷新过期 token
 *
 * 统一实现见 packages/shared/src/TokenManager.ts（@ai00-x/shared）。
 * 此处 re-export 以保持既有导入路径（@/lib/tokenManager）不变。
 */
export { tokenManager, type AuthInfo } from '@ai00-x/shared';