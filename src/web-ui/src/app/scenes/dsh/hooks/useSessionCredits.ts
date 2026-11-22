/**
 * useSessionCredits — 会话积分消耗（服务端账单口径）。
 *
 * 数据来源：`GET /api/v1/me/billing/session?session_id=xxx`（按
 * `ai_billing_ledger.session_id` 聚合）。客户端在每回合结束后拉一次，
 * 用「本次累计 − 上次累计」得到本回合消耗，逐条挂到对应的助手消息上。
 *
 * 两个稳定性要点（2026-11-23 修）：
 * 1. **结算有延迟且可能分批**：服务端异步落账，回合刚结束时累计可能还没变
 *    （甚至只落了前几次调用）。以前拉一次就入账，0 增量会让下一回合把两回
 *    合的量都算到自己头上（每个会话的统计看起来就是错的）。现在有界轮询
 *    （最多 3 次，间隔 1.2s），**连续两次累计相同才认为结算完成**；一直
 *    在涨就取最后一次的值，追不上才按当前值记。
 * 2. **并发/乱序**：快速连发时多次拉取可能乱序返回；用序号作废过期响应，
 *    避免旧快照把新基线覆盖回去。
 */

import { useEffect, useRef, useState } from 'react';
import type { DshMessage } from '@/infrastructure/api/service-api/DshAPI';
import { getSessionBilling } from '@/infrastructure/account/api';

export interface SessionCreditsState {
  /** 会话累计积分 */
  total: number;
  /** 调用次数 */
  calls: number;
  /** messageId -> 该回合消耗积分 */
  perMessage: Record<string, number>;
}

const EMPTY: SessionCreditsState = { total: 0, calls: 0, perMessage: {} };

const SETTLE_POLLS = 3;
const SETTLE_RETRY_MS = 1_200;

export function useSessionCredits(
  sessionId: string | null,
  messages: DshMessage[],
): SessionCreditsState {
  const [state, setState] = useState<SessionCreditsState>(EMPTY);
  /** 上次成功拉取的累计值（用于算增量） */
  const lastTotalRef = useRef<number | null>(null);
  /** 已归属过的助手消息 id（避免重复计入） */
  const attributedRef = useRef<Set<string>>(new Set());
  /** 拉取序号：会话切换 / 新一轮拉取时作废旧响应 */
  const seqRef = useRef(0);

  // 切换会话：清空基线并作废在途请求
  useEffect(() => {
    seqRef.current += 1;
    lastTotalRef.current = null;
    attributedRef.current = new Set();
    setState(EMPTY);
  }, [sessionId]);

  // 最近一条已完成的助手消息（回合结束的判定点）
  const lastCompleted = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === 'assistant' && !m.streaming) return m.id;
    }
    return null;
  })();

  useEffect(() => {
    if (!sessionId || !lastCompleted) return;
    if (attributedRef.current.has(lastCompleted)) return;

    const seq = (seqRef.current += 1);
    let cancelled = false;
    const wait = (ms: number): Promise<void> =>
      new Promise(resolve => {
        setTimeout(resolve, ms);
      });

    const settle = async (): Promise<void> => {
      /** 上一轮看到的总量（判定「已稳定」） */
      let previous: number | null = null;
      for (let attempt = 0; attempt < SETTLE_POLLS; attempt += 1) {
        const billing = await getSessionBilling(sessionId);
        if (cancelled || seq !== seqRef.current) return;
        if (!billing) {
          // 账单读不到（未登录/网络）：保持现状，等下次消息触发
          return;
        }
        const total = billing.total_credits;

        // 首次拉取只做基线（历史完成的消息不回填消耗）
        if (lastTotalRef.current === null) {
          lastTotalRef.current = total;
          setState(prev => ({ ...prev, total, calls: billing.calls }));
          return;
        }

        // 连续两次累计相同 = 结算完成；一直涨就等最后一次（有界）
        const stable = attempt > 0 && total === previous;
        if (!stable && attempt < SETTLE_POLLS - 1) {
          previous = total;
          await wait(SETTLE_RETRY_MS);
          if (cancelled || seq !== seqRef.current) return;
          continue;
        }

        const delta = Math.max(0, total - lastTotalRef.current);
        lastTotalRef.current = total;
        attributedRef.current.add(lastCompleted);
        setState(prev => ({
          total,
          calls: billing.calls,
          perMessage: { ...prev.perMessage, [lastCompleted]: delta },
        }));
        return;
      }
    };

    void settle();

    return () => {
      cancelled = true;
    };
  }, [sessionId, lastCompleted]);

  return state;
}
