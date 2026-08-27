/**
 * Todo 用量统计 API — 客户端本地 ledger + 服务端账单双源。
 *
 * - 本地：`ai_usage_query`（Rust 命令）聚合 plugin AI 调用（含本地 RWKV，
 *   token 为启发式估算口径），按日/按 tag（todo:kind:{goalId}）分桶。
 * - 服务端：GET /api/v1/me/ai/usage 聚合远程调用真实扣费（credits，
 *   经 ai00s 代理落 ai_request_logs + ai_billing_ledger）。
 * 双源对齐：本地 remoteTokens（估算）与 totals.credits（真实）供 UI 换算均价。
 */
import { invoke } from '@tauri-apps/api/core';
import { fetchWithAuth } from '../../../infrastructure/auth/fetchWithAuth';

// ===== 本地 ledger（plugin AI 全量调用）=====

export interface LocalUsageTotals {
  calls: number;
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

// ===== 服务端账单（远程调用真实扣费）=====

export interface ServerUsageDay {
  date: string;
  promptTokens: number;
  completionTokens: number;
  credits: number;
  calls: number;
}

export interface ServerUsage {
  days: ServerUsageDay[];
  totals: {
    promptTokens: number;
    completionTokens: number;
    credits: number;
    calls: number;
  };
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
    const resp = await fetchWithAuth<ApiResp<ServerUsage>>(
      `/api/v1/me/ai/usage?days=${days}`
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
