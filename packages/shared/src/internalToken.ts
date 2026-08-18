/**
 * X-Ai00-Internal-Token 头值获取（CSRF 豁免，所有 UI 共用）。
 *
 * WebView origin 为 http://127.0.0.1:2100，远程 Ai00-S 服务器 CSRF Origin
 * 白名单不含该 origin 时，POST/PUT/PATCH/DELETE 会被 403 拦截（浏览器误报
 * 为 CORS 错误）。桌面客户端属于程序化客户端，按设计携带此头即可豁免
 * （见 ai00-salvo csrf.rs）。值通过 Rust 命令 `get_ai00_s_internal_token`
 * 读取（环境变量 AI00_S_INTERNAL_TOKEN 可覆盖），非 Tauri 环境回退到与
 * 服务器端 default_internal_token 一致的硬编码值。
 */

/** 与服务器端 default_internal_token 一致的兜底值（非 Tauri 环境使用） */
export const FALLBACK_AI00_S_INTERNAL_TOKEN =
  '7f3a9b2e8c1d4a6f5b0e9c2d7a4f1b8e6c3a9d2f7b4e1c8a5d0f3b6e9c2a7d4f1';

let internalTokenCache: string | null = null;

/** 获取 X-Ai00-Internal-Token 头值（带缓存） */
export async function getAi00sInternalToken(): Promise<string> {
  if (internalTokenCache) return internalTokenCache;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    internalTokenCache = await invoke<string>('get_ai00_s_internal_token');
  } catch {
    internalTokenCache = FALLBACK_AI00_S_INTERNAL_TOKEN;
  }
  return internalTokenCache;
}
