// ========================================================================
// 花园社交系统 API 客户端
// ========================================================================

import type { Neighbor, VisitRequest } from './types';
import { getBaseUrl } from '../config';
import { tokenManager } from '../tokenManager';
import {
    getAi00sInternalToken,
    getAssetsBaseUrl,
    isApiError,
    unwrapApiResponse,
    type ApiResponse,
} from '@ai00-x/shared';

/**
 * Pet 头像资源根路径（异步解析）。
 * 优先 app.assets_base_url 配置；未配置则沿用 Ai00-S 服务器静态资源（`${ai00_s_base_url}/pet`）。
 * 旧实现硬编码本地内嵌服务器 2100，但内嵌服务器从未提供 /pet 路由 → 404 → 头像降级 emoji。
 */
export async function getPetResourceBase(): Promise<string> {
    return getAssetsBaseUrl();
}

export class GardenApi {
    private baseUrl: string | null;
    private tokenGetter: () => Promise<string | null>;

    /**
     * @param baseUrl API 基础 URL（留空则从统一配置读取）
     * @param tokenGetter 获取认证 token 的异步函数
     */
    constructor(baseUrl?: string, tokenGetter?: () => Promise<string | null>) {
        this.baseUrl = baseUrl ?? null;
        this.tokenGetter = tokenGetter ?? (() => tokenManager.getAccessToken());
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
        // CSRF 豁免：POST 直达远程服务器，WebView origin 不在其白名单（与 web-ui fetchWithAuth 一致）
        headers['X-Ai00-Internal-Token'] = await getAi00sInternalToken();

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
