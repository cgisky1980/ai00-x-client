/**
 * Todo 用量统计 API — 客户端本地 ledger + 服务端账本双源。
 *
 * 两本账互不相加、互不换算：
 * - 本地账：`ai_usage_query`（Rust 命令）聚合 plugin AI 调用（含本地 RWKV，
 *   token 为启发式估算口径），按日/按 tag（todo:kind:{goalId}）分桶。
 * - 远端账：GET /api/v1/me/ai/usage（`source: server_ledger`），tokens/credits
 *   全部为服务端账本聚合值，客户端只读不算。
 */
import { invoke } from '@tauri-apps/api/core';
import { fetchWithAuth } from '../../../infrastructure/auth/fetchWithAuth';

// ===== 本地 ledger（plugin AI 全量调用）=====

export interface LocalUsageTotals {
  calls: number;
  /** 本地推理调用数（calls 含远端）。 */
  localCalls: number;
  localTokens: number;
  remoteTokens: number;
  localPrompt: number;
  localCompletion: number;
  remotePrompt: number;
  remoteCompletion: number;
  latencyMsTotal: number;
}

export interface LocalUsageDay {
  date: string;
  localTokens: number;
  remoteTokens: number;
  calls: number;
}

export interface LocalUsageTagAgg {
  calls: number;
  localTokens: number;
  remoteTokens: number;
}

export interface LocalUsage {
  totals: LocalUsageTotals;
  days: LocalUsageDay[];
  byTag: Record<string, LocalUsageTagAgg>;
}

/** 查询最近 N 天本地 AI 用量（days 1-90；byTag 供前端按 goalId 过滤）。 */
export async function queryLocalUsage(days = 7): Promise<LocalUsage> {
  return invoke<LocalUsage>('ai_usage_query', { request: { days } });
}

// ===== 服务端账本（远程调用真实扣费，服务端唯一权威）=====

export interface ServerUsageDay {
  /** 'YYYY-MM-DD'（服务端按调用方时区折算） */
  date: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  credits: number;
  calls: number;
}

export interface ServerUsageModel {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  credits: number;
  calls: number;
}

export interface ServerUsage {
  /** 按日聚合（仅含有数据的日，升序） */
  days: ServerUsageDay[];
  /** 窗口内按模型聚合（credits 降序） */
  byModel: ServerUsageModel[];
  totals: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    credits: number;
    calls: number;
  };
  /** 数据来源标记（服务端账本） */
  source: 'server_ledger';
  /** 聚合窗口天数 */
  windowDays: number;
  updatedAt?: string;
}

interface ApiResp<T> {
  code: number;
  message?: string;
  data: T;
}

/** 服务端会员 AI 用量聚合（未登录/网络失败 → null，调用方降级）。 */
export async function fetchServerUsage(days = 30): Promise<ServerUsage | null> {
  try {
    // 日期桶按本地时区折算（东八区 = 480）
    const tzOffsetMinutes = -new Date().getTimezoneOffset();
    const resp = await fetchWithAuth<ApiResp<ServerUsage>>(
      `/api/v1/me/ai/usage?days=${days}&tz_offset_minutes=${tzOffsetMinutes}`
    );
    if (resp.code !== 0) return null;
    return resp.data;
  } catch {
    return null;
  }
}

/** 数字格式化：千分位（mono 场景）。 */
export function fmtNum(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US');
}
