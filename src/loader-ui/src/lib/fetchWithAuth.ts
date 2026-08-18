/**
 * fetchWithAuth:统一注入 Bearer token + 401 自动刷新 + 重试一次
 *
 * 与 apiFetchJson/apiFetchJsonNoAuth 接口兼容,作为它们的内部实现
 * 区别:支持 401 自动 refresh + retry 一次
 *
 * 用法:
 * - 普通请求(注入 token):fetchWithAuth(url, init)
 * - 不需 token:fetchWithAuth(url, { ...init, noAuth: true })
 * - refresh 接口本身(不重试):fetchWithAuth(url, { ...init, retryOn401: false })
 */

import { getApiUrl } from "./config";
import { tokenManager } from "./tokenManager";
import { getAi00sInternalToken } from "@ai00-x/shared";

export interface FetchWithAuthInit extends RequestInit {
  /** 不注入 Authorization header(等价 apiFetchJsonNoAuth) */
  noAuth?: boolean;
  /** 401 时不重试(用于 refresh 端点本身) */
  retryOn401?: boolean;
}

/** CSRF 豁免头值获取（shared 实现，供 api.ts 裸 fetch 复用） */
export const getInternalToken = getAi00sInternalToken;

/** 401 错误(可用于上层捕获后跳登录页) */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * 统一的 fetch 封装:
 * 1. 注入 Authorization: Bearer <access_token>(除非 noAuth)
 * 2. fetch 请求
 * 3. 解析 JSON(失败则返回 {raw: text})
 * 4. 若响应 code === 401 或 HTTP 401 → 触发 refresh → 重试一次
 * 5. 重试仍 401 → 抛 AuthError(由调用方或 AuthProvider 处理跳转)
 */
export async function fetchWithAuth<T = unknown>(
  url: string,
  init: FetchWithAuthInit = {}
): Promise<T> {
  const { noAuth, retryOn401 = true, ...requestInit } = init;

  const headers = await normalizeHeaders(requestInit.headers, !noAuth);

  const result = await doFetch<T>(url, { ...requestInit, headers });

  if (!is401(result)) {
    return result.data;
  }

  // 401:决定是否重试
  if (!retryOn401 || noAuth) {
    // 不重试场景(noAuth 的 401 是非法状态,或调用方明确不要重试)
    throw new AuthError("401 Unauthorized (no retry)");
  }

  // 触发 refresh(单飞)
  const newToken = await tokenManager.refreshIfNeeded();
  if (!newToken) {
    throw new AuthError("401 Unauthorized (refresh failed)");
  }

  // 用新 token 重试一次
  headers["Authorization"] = `Bearer ${newToken}`;
  const retryResult = await doFetch<T>(url, { ...requestInit, headers });

  if (is401(retryResult)) {
    // 重试仍 401:抛错让上层处理
    throw new AuthError("401 Unauthorized (retry failed)");
  }

  return retryResult.data;
}

// === 内部工具 ===

type AnyHeaders = HeadersInit | undefined;

async function normalizeHeaders(
  initHeaders: AnyHeaders,
  injectAuth: boolean
): Promise<Record<string, string>> {
  const h: Record<string, string> = {};
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((v, k) => {
        h[k] = v;
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [k, v] of initHeaders) h[k] = String(v);
    } else {
      Object.assign(h, initHeaders as Record<string, string>);
    }
  }
  if (injectAuth) {
    const token = await tokenManager.getAccessToken();
    if (token) h["Authorization"] = `Bearer ${token}`;
  }
  // CSRF 豁免头：服务器对 POST/PUT/PATCH/DELETE 校验 Origin 白名单，
  // WebView 的 127.0.0.1:2100 origin 不在旧版白名单中，需走内部客户端通道
  if (!h["X-Ai00-Internal-Token"] && !h["x-ai00-internal-token"]) {
    h["X-Ai00-Internal-Token"] = await getAi00sInternalToken();
  }
  return h;
}

interface FetchResult<T> {
  data: T;
  /** HTTP 状态码 */
  status: number;
  /** 业务 code(若有) */
  code?: number;
}

/** 实际执行 fetch + 解析响应 */
async function doFetch<T>(url: string, init: RequestInit): Promise<FetchResult<T>> {
  const bodyIsString = typeof init.body === "string";
  const hasContentType =
    typeof init.headers === "object" &&
    init.headers !== null &&
    (("Content-Type" in (init.headers as Record<string, string>)) ||
      ("content-type" in (init.headers as Record<string, string>)));

  if (bodyIsString && !hasContentType) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    if (!("Accept" in (init.headers as Record<string, string>)) &&
        !("accept" in (init.headers as Record<string, string>))) {
      (init.headers as Record<string, string>)["Accept"] = "application/json";
    }
  }

  const fullUrl = await getApiUrl(url);
  const resp = await fetch(fullUrl, init);
  const text = await resp.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  // 提取业务 code(若响应是 {code, ...} 结构)
  const businessCode =
    typeof parsed === "object" && parsed !== null && "code" in parsed
      ? (parsed as { code: unknown }).code
      : undefined;

  return {
    data: parsed as T,
    status: resp.status,
    code: typeof businessCode === "number" ? businessCode : undefined,
  };
}

/** 判断是否为 401(HTTP 状态码或业务 code) */
function is401(result: FetchResult<unknown>): boolean {
  if (result.status === 401) return true;
  if (result.code === 401) return true;
  return false;
}
