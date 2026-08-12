/**
 * Ai00-S 服务器地址配置（Tauri 后端驱动）
 *
 * 三个前端包（loader-ui / underlay-ui）共用的配置读取层。
 * 统一从 Rust 后端配置读取（app.json: app.ai00_s_base_url），不各自硬编码。
 * 如需覆盖（例如本地开发指向本地服务器），修改 app.json 或在设置界面修改。
 */

import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_AI00_S_BASE_URL } from './serverEndpoints';

const FALLBACK_BASE = DEFAULT_AI00_S_BASE_URL;

let cachedBaseUrl: string | null = null;

/**
 * 获取 Ai00-S 服务器地址（异步，通过 Tauri invoke 从后端配置读取）。
 * 首次调用会 invoke 后端，后续返回缓存值。
 * invoke 失败时回退到 FALLBACK_BASE。
 */
export async function getBaseUrl(): Promise<string> {
  if (cachedBaseUrl) return cachedBaseUrl;
  try {
    cachedBaseUrl = await invoke<string>('get_ai00_s_base_url');
    return cachedBaseUrl || FALLBACK_BASE;
  } catch {
    return FALLBACK_BASE;
  }
}

/** 同步获取缓存的 baseUrl（首次调用前为 null，需先调用 getBaseUrl()） */
export function getCachedBaseUrl(): string {
  return cachedBaseUrl || FALLBACK_BASE;
}

/**
 * 构建 API 完整 URL（异步）。
 * @param path API 路径（如 /api/v1/auth/member/refresh）
 */
export async function getApiUrl(path: string): Promise<string> {
  const base = await getBaseUrl();
  return `${base}${path}`;
}

/**
 * 获取头像/宠物资源根 URL（含 `/pet` 路径）。
 *
 * 优先使用独立的 `app.assets_base_url`（若配置），否则回退到 Ai00-S 服务器地址：
 * - assets_base_url 已配置（如 http://127.0.0.1:2100）→ `${assets_base_url}/pet`
 * - 未配置 → `${ai00_s_base_url}/pet`（沿用服务器资源）
 *
 * 独立配置让本地开发可指向嵌入服务器/后续 CDN，而不影响 AI00-S API 服务器地址。
 */
export async function getAssetsBaseUrl(): Promise<string> {
  let assetsBase = '';
  try {
    assetsBase = (await invoke<string>('get_assets_base_url')) || '';
  } catch {
    assetsBase = '';
  }
  if (assetsBase) return `${assetsBase}/pet`;
  return getApiUrl('/pet');
}

export const config = {
  apiBase: FALLBACK_BASE,
};