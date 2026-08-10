/**
 * web-ui TokenManager 单例:管理 access + refresh token 对
 *
 * 与 loader-ui 版差异:
 * - baseUrl 通过 ConfigManager.getConfig('app.ai00_s_base_url') 异步获取,内部缓存
 * - TypeScript strict 模式
 *
 * 职责:
 * - 提供 getAccessToken():本地 exp 预判,即将过期则主动 refresh
 * - 提供 refreshIfNeeded():promise 单飞防并发刷新
 * - 提供 setTokens():login/register 成功后写入新 token 对
 * - 提供 onRefreshFailed():注册失败监听,触发跳登录页
 */

import { invoke } from '@tauri-apps/api/core';
import { isTokenExpired } from './authUtils';
import { DEFAULT_AI00_S_BASE_URL } from '@/infrastructure/config/constants';

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

type RefreshFailedListener = (err: Error | null) => void;

class TokenManager {
  private refreshPromise: Promise<string | null> | null = null;
  private refreshFailedListeners: RefreshFailedListener[] = [];
  private cachedBaseUrl: string | null = null;
  private configChangeSetup = false;

  /**
   * 监听配置变更，当 ai00_s_base_url 变更时清除缓存。
   * 幂等：多次调用安全（用 configChangeSetup 标志守护）。
   */
  private setupConfigChangeListener(): void {
    if (this.configChangeSetup) return;
    this.configChangeSetup = true;
    import('@/infrastructure/config/services/ConfigManager')
      .then(({ configManager }) => {
        configManager.onConfigChange((path) => {
          if (path === 'app.ai00_s_base_url') {
            this.cachedBaseUrl = null;
          }
        });
      })
      .catch(() => {
        // ConfigManager 不可用时静默失败，getBaseUrl 有 fallback
      });
  }

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

    if (!info.refresh_token) {
      this.notifyRefreshFailed(new Error('no refresh_token available'));
      return null;
    }

    return this.refreshIfNeeded();
  }

  /** 获取当前 refresh token */
  async getRefreshToken(): Promise<string | null> {
    const info = await this.getAuthInfo();
    return info?.refresh_token ?? null;
  }

  /** 获取当前 AuthInfo(包含 username/plan_tier 等) */
  async getAuthInfo(): Promise<AuthInfo | null> {
    try {
      return await invoke<AuthInfo | null>('get_auth_info');
    } catch {
      return null;
    }
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
   * 写入新 token 对(由 login 后调用)
   */
  async setTokens(
    accessToken: string,
    refreshToken: string,
    username: string,
    planTier?: string | null,
    memberId?: number | null
  ): Promise<void> {
    await invoke('set_auth_info_pair', {
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
      await invoke('clear_auth_info');
    } catch {
      // 非 Tauri 环境,无操作
    }
  }

  /** 注册 refresh 失败监听器 */
  onRefreshFailed(cb: RefreshFailedListener): () => void {
    this.refreshFailedListeners.push(cb);
    return () => {
      const idx = this.refreshFailedListeners.indexOf(cb);
      if (idx >= 0) this.refreshFailedListeners.splice(idx, 1);
    };
  }

  /**
   * 获取 baseUrl(从 ConfigManager 读取,缓存避免重复 invoke)
   * @returns baseUrl 字符串(如 'https://<host>')
   */
  async getBaseUrl(): Promise<string> {
    if (this.cachedBaseUrl) return this.cachedBaseUrl;
    this.setupConfigChangeListener();
    try {
      const { configManager } = await import('@/infrastructure/config/services/ConfigManager');
      const url = (await configManager.getConfig<string>('app.ai00_s_base_url')) || DEFAULT_AI00_S_BASE_URL;
      this.cachedBaseUrl = url;
      return url;
    } catch {
      return DEFAULT_AI00_S_BASE_URL;
    }
  }

  // === 内部实现 ===

  /**
   * 内部:通过 Tauri invoke 调用后端 refresh_auth_token 命令刷新 token。
   *
   * 必须走 Rust 后端而非浏览器 fetch,否则 CORS 会拦截跨域请求
   * (localhost:1422 → 生产服务器)。后端使用 reqwest 发起请求,
   * 不受浏览器同源策略限制。
   */
  private async doRefresh(): Promise<string | null> {
    try {
      const newToken = await invoke<string>('refresh_auth_token');
      return newToken;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.notifyRefreshFailed(new Error(`refresh_auth_token failed: ${errMsg}`));
      return null;
    }
  }

  private notifyRefreshFailed(err: Error): void {
    console.warn('[TokenManager] refresh failed, notifying listeners:', err.message);
    for (const cb of this.refreshFailedListeners) {
      try {
        cb(err);
      } catch (listenerErr) {
        console.error('[TokenManager] refresh failed listener threw:', listenerErr);
      }
    }
  }
}

export const tokenManager = new TokenManager();
