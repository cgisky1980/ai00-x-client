/**
 * useDshChat — dsh Agent 场景的数据中枢。
 *
 * 职责：
 * - 引擎生命周期（dsh_ensure_ready + dsh://phase 事件）
 * - 会话列表（session.list，mux 事件驱动刷新）
 * - 当前会话消息（session.history 拉取 + mux session/event 实时流式）
 * - 发送 / 停止
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connectMux,
  dshEngine,
  dshSession,
  foldEvents,
  type DshMessage,
  type DshMuxConnection,
  type DshMuxFrame,
  type DshPhase,
  type DshSessionEvent,
  type DshSessionSummary,
  type DshStatus,
} from '@/infrastructure/api/service-api/DshAPI';

export interface DshChatState {
  status: DshStatus | null;
  phase: DshPhase | null;
  wsConnected: boolean;
  sessions: DshSessionSummary[];
  sessionsLoading: boolean;
  currentSessionId: string | null;
  messages: DshMessage[];
  sending: boolean;
  error: string | null;
}

export function useDshChat() {
  const [state, setState] = useState<DshChatState>({
    status: null,
    phase: null,
    wsConnected: false,
    sessions: [],
    sessionsLoading: true,
    currentSessionId: null,
    messages: [],
    sending: false,
    error: null,
  });
  /** 当前会话的实时事件累积（含 history 拉取的基线）。 */
  const liveEventsRef = useRef<DshSessionEvent[]>([]);
  const currentSessionRef = useRef<string | null>(null);
  const wsRef = useRef<DshMuxConnection | null>(null);

  const patch = useCallback((partial: Partial<DshChatState>) => {
    setState(prev => ({ ...prev, ...partial }));
  }, []);

  // ---- 消息折叠（事件 → UI 消息） ----
  const recomputeMessages = useCallback(() => {
    setState(prev => ({ ...prev, messages: foldEvents(liveEventsRef.current) }));
  }, []);

  // ---- 会话切换：拉取 history 基线 ----
  const openSession = useCallback(
    async (sessionId: string) => {
      currentSessionRef.current = sessionId;
      liveEventsRef.current = [];
      patch({ currentSessionId: sessionId, messages: [], error: null });
      try {
        const { events } = await dshSession.history(sessionId);
        if (currentSessionRef.current !== sessionId) return;
        liveEventsRef.current = events.map(e => e.event);
        recomputeMessages();
      } catch (err) {
        if (currentSessionRef.current === sessionId) {
          patch({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    },
    [patch, recomputeMessages],
  );

  const refreshSessions = useCallback(async () => {
    try {
      const { items } = await dshSession.list();
      patch({ sessions: items.filter(s => !s.blank), sessionsLoading: false });
    } catch {
      patch({ sessionsLoading: false });
    }
  }, [patch]);

  // ---- 新建会话 ----
  const newSession = useCallback(async () => {
    try {
      // 不传 cwd：使用引擎侧 Host cwd（DSH_HOME，会话文件工具以此为工作区）
      const { sessionId } = await dshSession.create('');
      await refreshSessions();
      await openSession(sessionId);
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [openSession, patch, refreshSessions]);

  // ---- 发送 ----
  const send = useCallback(
    async (text: string) => {
      const sessionId = currentSessionRef.current;
      if (!sessionId || !text.trim()) return;
      patch({ sending: true, error: null });
      try {
        await dshSession.prompt(sessionId, text);
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        patch({ sending: false });
      }
    },
    [patch],
  );

  // ---- 停止 ----
  const stop = useCallback(async () => {
    const sessionId = currentSessionRef.current;
    if (!sessionId) return;
    try {
      await dshSession.cancel(sessionId);
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [patch]);

  // ---- 引擎就绪 + mux 订阅 + 会话列表 ----
  useEffect(() => {
    let cancelled = false;
    let unlistenPhase: (() => void) | null = null;

    const boot = async () => {
      // 阶段事件（安装进度 → 前端状态卡）
      dshEngine.onPhase(phase => {
        if (!cancelled) patch({ phase });
      }).then(un => {
        if (cancelled) un();
        else unlistenPhase = un;
      }).catch(() => undefined);

      try {
        const status = await dshEngine.ensureReady();
        if (!cancelled) patch({ status });
      } catch {
        // ensure 失败也继续尝试直连（引擎可能已被外部拉起）
      }

      // mux WS：实时事件流（session/event → 折叠；session/subscribed → 刷新列表）
      const conn = connectMux(
        (frame: DshMuxFrame) => {
          if (cancelled) return;
          if (frame.type === 'session/event') {
            if (frame.sessionId === currentSessionRef.current) {
              liveEventsRef.current = [...liveEventsRef.current, frame.event];
              recomputeMessages();
            }
            // turn 结束时刷新列表（running 状态/时间戳变化）
            if (frame.event.type === 'turn/end') {
              refreshSessions();
            }
          } else if (frame.type === 'session/subscribed') {
            refreshSessions();
          }
        },
        wsConnected => {
          if (!cancelled) patch({ wsConnected });
        },
      );
      wsRef.current = conn;

      await refreshSessions();
    };
    boot();

    return () => {
      cancelled = true;
      wsRef.current?.close();
      unlistenPhase?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ...state, openSession, newSession, send, stop, refreshSessions };
}
