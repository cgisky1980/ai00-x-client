/**
 * AiUsageAPI — 网关用量账本的会话级查询（本地 / 云端分项）。
 *
 * 数据来源：`{data}/Ai00-X/ai_usage/records-YYYY-MM.json`，由 ai_gateway
 * 在本地、远端、混合工具循环与回退路径各记一条。按 sessionId + sinceMs
 * 过滤即可得到「本轮消耗」的增量。
 *
 * 积分核算走**按会话账单**（`GET /api/v1/me/billing/session`），口径为
 * 「request_id 精确匹配优先、会话内时间窗兜底」，不再全局扫描最近账单
 * ——后者会把其他会话的消费算进本轮。
 */
import { invoke } from '@tauri-apps/api/core';
import { getSessionBilling } from '@/infrastructure/account/api';

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
  /** 窗口内远端调用的请求 id（与服务端计费账本 request_id 同值）。 */
  remoteRequestIds: string[];
}

/**
 * 读取某会话自 sinceMs（毫秒）以来的本地 / 云端用量。
 *
 * `extraSessionIds` = 本轮派发的子会话（子代理）：它们的消耗也算本轮成本，
 * 否则云端积分会少算一大截。
 */
export async function getSessionUsage(
  sessionId: string,
  sinceMs?: number,
  extraSessionIds: string[] = [],
): Promise<AiUsageSessionUsage> {
  return invoke<AiUsageSessionUsage>('ai_usage_session_usage', {
    request: {
      sessionId,
      ...(sinceMs ? { sinceMs } : {}),
      extraSessionIds,
    },
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

/**
 * 汇总本轮远端的积分消耗（服务端账单口径，按会话核算）。
 *
 * 会话范围 = 主会话 + 本轮派发的子会话（子代理），逐个拉会话账单后合并明细：
 * 1. 优先按请求 id 精确匹配（`ai_billing_ledger.request_id` = 网关 `X-Request-Id`）；
 * 2. 老记录 / 混合工具循环等没有 request id 的调用，退回**各会话自己**的时间窗
 *    （`created_at >= 回合开始 - 2s`）汇总——范围已由入参会话限定，不跨会话。
 *
 * 服务端结算异步落账，未命中时最多重试 3 次（每次 1.2s）。
 * 账本全部不可用（未登录 / 网络）返回 null（未知，不是 0）；
 * 账本可用但本轮确实没扣费（免费模型 / 未结算）返回 0。
 */
export async function resolveRemoteCredits(params: {
  sessionId: string;
  childSessionIds: string[];
  requestIds: string[];
  sinceMs?: number;
}): Promise<number | null> {
  const { sessionId, childSessionIds, requestIds, sinceMs } = params;
  const sessionIds = Array.from(
    new Set([sessionId, ...childSessionIds].filter(id => id.length > 0)),
  );
  if (sessionIds.length === 0) return null;
  if (requestIds.length === 0 && !sinceMs) return null;
  const wanted = new Set(requestIds);
  const sum = (entries: { cost_credits: number }[]): number =>
    entries.reduce((total, entry) => total + (entry.cost_credits || 0), 0);
  const cutoff = sinceMs ? sinceMs - 2_000 : null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const billings = await Promise.all(sessionIds.map(id => getSessionBilling(id)));
    // 账本读不到（未登录 / 网络）：语义是"未知"，不能报 0
    if (billings.every(billing => billing === null)) return null;
    const items = billings.flatMap(billing => billing?.items ?? []);
    if (wanted.size > 0) {
      const matched = items.filter(item => item.request_id && wanted.has(item.request_id));
      if (matched.length > 0) return sum(matched);
    }
    if (cutoff !== null) {
      const inWindow = items.filter(item => {
        const at = Date.parse(item.created_at);
        return Number.isFinite(at) && at >= cutoff;
      });
      if (inWindow.length > 0) return sum(inWindow);
    }
    // 两条口径都没命中：给异步结算留一次机会，最后一次直接按 0 收
    if (attempt === 2) return 0;
    await new Promise(resolve => setTimeout(resolve, 1_200));
  }
  return null;
}
