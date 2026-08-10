/**
 * getApiUrl 适配器（替代 loader-ui 的 lib/config.ts getApiUrl）
 *
 * loader-ui 的 getApiUrl(path) 同步返回 `${VITE_API_BASE}${path}`；
 * web-ui 通过 ConfigManager 异步获取 baseUrl，提供 setBaseUrlResolver() 注入机制。
 *
 * resolver 未注入时（如 AvatarCustomizer 在 AccountConfig 之前渲染），
 * fallback 到 DEFAULT_AI00_S_BASE_URL，避免 baseUrl 为空导致请求退化到相对路径。
 *
 * 用法：
 *   import { setBaseUrlResolver, getApiUrl, getApiBaseUrl } from './avatarConfigAdapter';
 *
 *   // 在应用启动或组件挂载时注入 resolver（仅一次）：
 *   setBaseUrlResolver(async () => {
 *     const { configManager } = await import('@/infrastructure/config/services/ConfigManager');
 *     return (await configManager.getConfig<string>('app.ai00_s_base_url')) || DEFAULT_AI00_S_BASE_URL;
 *   });
 *
 *   // 后续异步使用：
 *   const url = await getApiUrl('/pet');
 */

import { DEFAULT_AI00_S_BASE_URL } from '@/infrastructure/config/constants';

let baseUrlResolver: (() => Promise<string>) | null = null;
let cachedBaseUrl: string | null = null;

/** 注入 baseUrl 解析器（异步）。重置缓存。 */
export function setBaseUrlResolver(resolver: () => Promise<string>): void {
  baseUrlResolver = resolver;
  cachedBaseUrl = null;
}

/** 获取 baseUrl（异步，首次调用 resolver 后缓存；resolver 未注入时用默认值） */
export async function getApiBaseUrl(): Promise<string> {
  if (cachedBaseUrl === null) {
    cachedBaseUrl = baseUrlResolver ? await baseUrlResolver() : DEFAULT_AI00_S_BASE_URL;
  }
  return cachedBaseUrl;
}

/** 拼接 path 到 baseUrl（异步） */
export async function getApiUrl(path: string): Promise<string> {
  const base = await getApiBaseUrl();
  return `${base}${path}`;
}
