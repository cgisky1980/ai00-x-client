// Ai00-S 服务器地址：统一配置读取见 packages/shared/src/config.ts（@ai00-x/shared）。
// 此处 re-export 以保持既有导入路径（@/lib/config）不变。
export { getBaseUrl, getCachedBaseUrl, getApiUrl, config } from '@ai00-x/shared';