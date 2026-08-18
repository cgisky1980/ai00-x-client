/**
 * TokenManager 单例：管理 access + refresh token 对
 *
 * loader-ui / underlay-ui 共用的统一实现（浏览器 fetch 方式刷新）。
 * web-ui 因 CORS 约束需走 Rust 后端 invoke('refresh_auth_token')，故保留其独立实现。
 *
 * 职责:
 * - 提供 getAccessToken():本地 exp 预判,即将过期则主动 refresh
 * - 提供 refreshIfNeeded():promise 单飞防并发刷新
 * - 提供 setTokens():login/register 成功后写入新 token 对
 * - 提供 onRefreshFailed():AuthProvider 注册失败监听,触发跳登录页
 * - 提供 clearTokens():logout 时清理本地
 *
 * 依赖:
 * - Tauri invoke('get_auth_info' / 'set_auth_info_pair' / 'clear_auth_info')
 * - 本包 getApiUrl() 拼接 Rust API 路径
 * - 本包 isTokenExpired() 本地 exp 预判
 */

import { invoke } from '@tauri-apps/api/core';
import { getApiUrl } from './config';
import { isTokenExpired } from './auth';
import { getAi00sInternalToken } from './internalToken';

/** access token 即将过期阈值(秒):留 60s 缓冲,避免请求途中过期 */
const ACCESS_EXPIRY_BUFFER_SECS = 60;

/** AuthInfo 结构(与桌面端 auth.rs::AuthInfo 一致) */
export interface AuthInfo {
  username: string;
  token: string;
  logged_at: number;
  plan_tier?: string | null;
  member_id?: number | null;
  refresh_token?: string | null;
}

/** Rust API /api/v1/auth/member/refresh 响应 */
interface RefreshResponse {
  code: number;
  message: string;
  data: {
    access_token: string;
    refresh_token: string;
  } | null;
}

type RefreshFailedListener = (err: Error | null) => void;

class TokenManager {
  private refreshPromise: Promise<string | null> | null = null;
  private refreshFailedListeners: RefreshFailedListener[] = [];

  /**
   * 获取当前 access token。
   * - 若本地 exp 即将过期(剩余时间 < 60s),主动触发 refresh
   * - refresh 失败时返回 null,并由 onRefreshFailed 监听器处理跳转
   */
  async getAccessToken(): Promise<string | null> {
    const info = await this.getAuthInfo();
    if (!info) return null;

    if (!isTokenExpired(info.token, ACCESS_EXPIRY_BUFFER_SECS)) {
      return info.token;
    }

    // access 即将过期,尝试 refresh
    if (!info.refresh_token) {
      // 旧用户(refresh_token 缺失),不能 refresh,触发 logout
      this.notifyRefreshFailed(new Error("no refresh_token available"));
      return null;
    }

    return this.refreshIfNeeded();
  }

  /** 兼容别名:underlay-ui 早期方法名 */
  async getValidAccessToken(): Promise<string | null> {
    return this.getAccessToken();
  }

  /** 获取当前 refresh token(仅供 fetchWithAuth 401 重试用) */
  async getRefreshToken(): Promise<string | null> {
    const info = await this.getAuthInfo();
    return info?.refresh_token ?? null;
  }

  /**
   * 触发刷新:若已在进行则共享 promise(单飞),否则发起新 refresh
   * @returns 新的 access token,失败时返回 null
   */
  refreshIfNeeded(): Promise<string | null> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /**
   * 写入新 token 对(由 login/register 后调用)
   * 同时清空 refresh 状态(让下次请求用新 token)
   */
  async setTokens(
    accessToken: string,
    refreshToken: string,
    username: string,
    planTier?: string | null,
    memberId?: number | null
  ): Promise<void> {
    await invoke("set_auth_info_pair", {
      token: accessToken,
      refreshToken,
      username,
      planTier: planTier ?? null,
      memberId: memberId ?? null,
    });
  }

  /** 清理本地 token(logout 时调用) */
  async clearTokens(): Promise<void> {
    try {
      await invoke("clear_auth_info");
    } catch {
      // 非 Tauri 环境(纯 web dev),无操作
    }
  }

  /**
   * 注册 refresh 失败监听器
   * @returns 取消注册函数
   */
  onRefreshFailed(cb: RefreshFailedListener): () => void {
    this.refreshFailedListeners.push(cb);
    return () => {
      const idx = this.refreshFailedListeners.indexOf(cb);
      if (idx >= 0) this.refreshFailedListeners.splice(idx, 1);
    };
  }

  // === 内部实现 ===

  private async getAuthInfo(): Promise<AuthInfo | null> {
    try {
      return await invoke<AuthInfo | null>("get_auth_info");
    } catch {
      return null;
    }
  }

  /** 内部:调用 Rust API /api/v1/auth/member/refresh,更新本地存储 */
  private async doRefresh(): Promise<string | null> {
    try {
      const info = await this.getAuthInfo();
      if (!info?.refresh_token) {
        this.notifyRefreshFailed(new Error("no refresh_token to refresh"));
        return null;
      }

      const url = await getApiUrl("/api/v1/auth/member/refresh");
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // CSRF 豁免：POST 直达远程服务器，WebView origin 不在其白名单
          "X-Ai00-Internal-Token": await getAi00sInternalToken(),
        },
        body: JSON.stringify({ refresh_token: info.refresh_token }),
      });

      const text = await resp.text();
      let data: RefreshResponse;
      try {
        data = JSON.parse(text);
      } catch {
        this.notifyRefreshFailed(new Error(`refresh response not JSON: ${text.substring(0, 100)}`));
        return null;
      }

      if (data.code !== 0 || !data.data) {
        // refresh 失败(refresh_token 已被吊销或过期),触发 logout
        this.notifyRefreshFailed(new Error(data.message || "refresh failed"));
        return null;
      }

      // 写入新 token 对(保留原 username / plan_tier / member_id)
      await this.setTokens(
        data.data.access_token,
        data.data.refresh_token,
        info.username,
        info.plan_tier,
        info.member_id
      );

      return data.data.access_token;
    } catch (e) {
      // 网络错误等:不立即触发 logout(可能短暂网络问题),由 fetchWithAuth 重试一次后失败抛错
      console.warn("[TokenManager] refresh error:", e);
      return null;
    }
  }

  private notifyRefreshFailed(err: Error): void {
    console.warn("[TokenManager] refresh failed, notifying listeners:", err.message);
    for (const cb of this.refreshFailedListeners) {
      try {
        cb(err);
      } catch (listenerErr) {
        console.error("[TokenManager] refresh failed listener threw:", listenerErr);
      }
    }
  }
}

export const tokenManager = new TokenManager();