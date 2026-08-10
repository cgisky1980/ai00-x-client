// ========================================================================
// 花园社交系统 API 客户端
// ========================================================================

import type { Neighbor, VisitRequest } from './types';
import { storage } from '../storage';
import { getBaseUrl } from '../config';
import { LOCAL_HOST, EMBEDDED_SERVER_PORT, isApiError, unwrapApiResponse, type ApiResponse } from '@ai00-x/shared';

// Pet 头像资源基础路径。
// - Tauri 桌面端：从本地 pet.zip 读取（Tauri 内嵌服务器 2100，零网络开销）
// - 浏览器开发模式：通过 vite proxy 代理到 Ai00-Salvo(8081)
// 判断依据：Tauri 2.0 webview 的 hostname 是 tauri.localhost
// （不能依赖 __TAURI_INTERNALS__，浏览器引入 @tauri-apps/api 后也会注入）
const isTauriWebview =
    typeof window !== 'undefined' && window.location.hostname === 'tauri.localhost';
export const PET_RESOURCE_BASE = isTauriWebview
    ? `http://${LOCAL_HOST}:${EMBEDDED_SERVER_PORT}/pet`
    : '/pet';

export class GardenApi {
    private baseUrl: string | null;
    private tokenGetter: () => Promise<string | null>;

    /**
     * @param baseUrl API 基础 URL（留空则从统一配置读取）
     * @param tokenGetter 获取认证 token 的异步函数
     */
    constructor(baseUrl?: string, tokenGetter?: () => Promise<string | null>) {
        this.baseUrl = baseUrl ?? null;
        this.tokenGetter = tokenGetter ?? (() => storage.get('ai00-s-token'));
    }

    /** 获取 baseUrl（优先使用构造时传入的，否则从统一配置读取） */
    private async resolveBaseUrl(): Promise<string> {
        if (this.baseUrl) return this.baseUrl;
        return getBaseUrl();
    }

    /** 发起 API 请求 */
    private async request<T>(
        path: string,
        options: RequestInit = {},
    ): Promise<T> {
        const token = await this.tokenGetter();
        const base = await this.resolveBaseUrl();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(options.headers as Record<string, string>),
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const resp = await fetch(`${base}${path}`, {
            ...options,
            headers,
        });

        if (!resp.ok) {
            throw new Error(`API ${path} failed: ${resp.status} ${resp.statusText}`);
        }

        const json: ApiResponse<T> = await resp.json();
        if (isApiError(json)) {
            throw new Error(`API ${path} error: ${json.message}`);
        }
        return unwrapApiResponse<T>(json);
    }

    /** 获取 NPC 邻居列表 */
    async getNeighbors(): Promise<Neighbor[]> {
        const data = await this.request<{ neighbors: Neighbor[] }>(
            '/ai00-s/api/ai/neighbors',
        );
        return data.neighbors;
    }

    /** 请求一个访客（服务器决定派谁来、带什么种子） */
    async requestVisit(): Promise<VisitRequest | null> {
        const data = await this.request<{ visitor: Neighbor | null; broughtSeed?: string }>(
            '/ai00-s/api/ai/visits/request',
            { method: 'POST' },
        );
        if (!data.visitor) return null;
        return {
            visitor: data.visitor,
            broughtSeed: data.broughtSeed ?? 'sunflower',
        };
    }
}

/** 单例实例 */
let _instance: GardenApi | null = null;

export function getGardenApi(): GardenApi {
    if (!_instance) {
        _instance = new GardenApi();
    }
    return _instance;
}

export function initGardenApi(baseUrl: string, tokenGetter?: () => Promise<string | null>): GardenApi {
    _instance = new GardenApi(baseUrl, tokenGetter);
    return _instance;
}
