/**
 * AiUsageAPI — 网关用量账本的会话级查询（本地 / 云端分项）。
 *
 * 数据来源：`{data}/Ai00-X/ai_usage/records-YYYY-MM.json`，由 ai_gateway
 * 在本地、远端、混合工具循环与回退路径各记一条。按 sessionId + sinceMs
 * 过滤即可得到「本轮消耗」的增量。
 */
import { invoke } from '@tauri-apps/api/core';

export interface AiUsageSplit {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  /** 上游未返回 usage 的调用数（token 不计入上面三项）。 */
  unknownUsageCalls: number;
  /** 本地失败后升级远端的次数。 */
  fallbackCalls: number;
}

export interface AiUsageSessionUsage {
  sessionId: string;
  sinceMs: number;
  local: AiUsageSplit;
  remote: AiUsageSplit;
}

/** 读取某会话自 sinceMs（毫秒）以来的本地 / 云端用量。 */
export async function getSessionUsage(
  sessionId: string,
  sinceMs?: number,
): Promise<AiUsageSessionUsage> {
  return invoke<AiUsageSessionUsage>('ai_usage_session_usage', {
    request: { sessionId, ...(sinceMs ? { sinceMs } : {}) },
  });
}

/** 两个快照相减（用于「本轮」增量）。 */
export function diffUsage(
  current: AiUsageSessionUsage,
  base: AiUsageSessionUsage | null,
): { local: AiUsageSplit; remote: AiUsageSplit } {
  const zero = (): AiUsageSplit => ({
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    unknownUsageCalls: 0,
    fallbackCalls: 0,
  });
  if (!base) return { local: current.local, remote: current.remote };
  const subtract = (a: AiUsageSplit, b: AiUsageSplit): AiUsageSplit => ({
    calls: Math.max(0, a.calls - b.calls),
    promptTokens: Math.max(0, a.promptTokens - b.promptTokens),
    completionTokens: Math.max(0, a.completionTokens - b.completionTokens),
    cachedPromptTokens: Math.max(0, a.cachedPromptTokens - b.cachedPromptTokens),
    unknownUsageCalls: Math.max(0, a.unknownUsageCalls - b.unknownUsageCalls),
    fallbackCalls: Math.max(0, a.fallbackCalls - b.fallbackCalls),
  });
  return {
    local: subtract(current.local, base.local ?? zero()),
    remote: subtract(current.remote, base.remote ?? zero()),
  };
}
