/**
 * useSessionCredits — 会话积分消耗（服务端账单口径）。
 *
 * 数据来源：`GET /api/v1/me/billing/session?session_id=xxx`（按
 * `ai_billing_ledger.session_id` 聚合）。客户端在每回合结束后拉一次，
 * 用「本次累计 − 上次累计」得到本回合消耗，逐条挂到对应的助手消息上。
 *
 * 首次拉取只做基线（历史消息不回填），避免把整段历史消耗算到最后一条上。
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

export function useSessionCredits(
  sessionId: string | null,
  messages: DshMessage[],
): SessionCreditsState {
  const [state, setState] = useState<SessionCreditsState>(EMPTY);
  /** 上次成功拉取的累计值（用于算增量） */
  const lastTotalRef = useRef<number | null>(null);
  /** 已归属过的助手消息 id（避免重复计入） */
  const attributedRef = useRef<Set<string>>(new Set());

  // 切换会话：清空基线
  useEffect(() => {
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

    let cancelled = false;
    void getSessionBilling(sessionId).then(billing => {
      if (cancelled || !billing) return;
      const total = billing.total_credits;

      // 首次拉取：只记基线（历史消耗不归到某一条消息）
      if (lastTotalRef.current === null) {
        lastTotalRef.current = total;
        setState(prev => ({ ...prev, total, calls: billing.calls }));
        return;
      }

      const delta = Math.max(0, total - lastTotalRef.current);
      lastTotalRef.current = total;
      attributedRef.current.add(lastCompleted);

      setState(prev => ({
        total,
        calls: billing.calls,
        perMessage: { ...prev.perMessage, [lastCompleted]: delta },
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId, lastCompleted]);

  return state;
}
