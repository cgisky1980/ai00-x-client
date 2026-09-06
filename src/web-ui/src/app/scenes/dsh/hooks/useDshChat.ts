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
import { invoke } from '@tauri-apps/api/core';
import {
  aggregateUsage,
  connectMux,
  dshApproval,
  dshEngine,
  dshQuestion,
  dshSession,
  foldEvents,
  type DshApproval,
  type DshMessage,
  type DshMuxConnection,
  type DshMuxFrame,
  type DshPermissionRequest,
  type DshPhase,
  type DshPluginErrorPayload,
  type DshQuestion,
  type DshQuestionAnswerItem,
  type DshSessionEvent,
  type DshSessionModels,
  type DshSessionSummary,
  type DshStatus,
  type DshUsageSummary,
} from '@/infrastructure/api/service-api/DshAPI';
import { reportRuntimeFailure } from '@/infrastructure/api/service-api/DshMarketApi';

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
  /** 待处理审批（全量，按 rpcId 去重；UI 按当前会话过滤）。 */
  approvals: DshApproval[];
  /** 待处理问题批次（全量，按 rpcId 去重；UI 按当前会话过滤）。 */
  questions: DshQuestion[];
  /** 当前会话的模型目录（session.models）。 */
  models: DshSessionModels | null;
  /** 引擎插件加载错误（stderr 检出 + 模块归因；null = 无）。 */
  pluginError: DshPluginErrorPayload | null;
  /** 待授权的插件 scope 请求（(pluginId, scope) 去重）。 */
  permissionRequests: DshPermissionRequest[];
  /** 当前会话累计用量（assistant/message usage 聚合；null = 无数据）。 */
  usage: DshUsageSummary | null;
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
    approvals: [],
    questions: [],
    models: null,
    pluginError: null,
    permissionRequests: [],
    usage: null,
  });
  /** 当前会话的实时事件累积（含 history 拉取的基线）。 */
  const liveEventsRef = useRef<DshSessionEvent[]>([]);
  const currentSessionRef = useRef<string | null>(null);
  const wsRef = useRef<DshMuxConnection | null>(null);
  /** state 的同步镜像（异步回调里读取最新 approvals）。 */
  const stateRef = useRef<DshChatState>(state);
  stateRef.current = state;

  const patch = useCallback((partial: Partial<DshChatState>) => {
    setState(prev => ({ ...prev, ...partial }));
  }, []);

  // ---- 消息折叠（事件 → UI 消息 + 用量聚合） ----
  const recomputeMessages = useCallback(() => {
    setState(prev => ({
      ...prev,
      messages: foldEvents(liveEventsRef.current),
      usage: aggregateUsage(liveEventsRef.current),
    }));
  }, []);

  // ---- 会话切换：拉取 history 基线 + 模型目录 ----
  const openSession = useCallback(
    async (sessionId: string) => {
      currentSessionRef.current = sessionId;
      liveEventsRef.current = [];
      patch({ currentSessionId: sessionId, messages: [], error: null, models: null });
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
      try {
        const models = await dshSession.models(sessionId);
        if (currentSessionRef.current === sessionId) {
          patch({ models });
        }
      } catch {
        // 模型目录拉取失败不阻塞会话
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
      const { sessionId } = await dshSession.create();
      // M1.4 VRAM 联动：会话创建即上报 agent 活动上下文 → 预测 warmup 本地 RWKV
      await invoke('vram_set_active_context', { context: 'agent' }).catch(() => undefined);
      await refreshSessions();
      await openSession(sessionId);
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [openSession, patch, refreshSessions]);

  // ---- 会话重命名 ----
  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      try {
        await dshSession.rename(sessionId, trimmed);
        await refreshSessions();
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      }
    },
    [patch, refreshSessions],
  );

  // ---- 会话派生（fork：复制历史到新会话，长任务失败重试的兜底） ----
  const forkSession = useCallback(
    async (sessionId: string) => {
      try {
        const { sessionId: childId } = await dshSession.fork(sessionId);
        await refreshSessions();
        await openSession(childId);
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      }
    },
    [openSession, patch, refreshSessions],
  );

  // ---- 手动重启引擎（Failed 态恢复） ----
  const restartEngine = useCallback(async () => {
    try {
      const status = await dshEngine.restart();
      patch({ status, pluginError: null });
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [patch]);

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

  // ---- 审批应答 ----
  const respondApproval = useCallback(
    async (rpcId: string, outcome: 'allowed-once' | 'rejected') => {
      setState(prev => {
        const target = prev.approvals.find(a => a.rpcId === rpcId);
        if (!target) return prev;
        return { ...prev, approvals: prev.approvals.filter(a => a.rpcId !== rpcId) };
      });
      // 乐观移除后再发送；失败（not-pending/bad-response）依赖 approval/resolved 帧收敛
      const current = stateRef.current.approvals.find(a => a.rpcId === rpcId);
      if (!current) return;
      try {
        const receipt = await dshApproval.respond(
          rpcId,
          current.sessionId,
          current.approvalId,
          outcome,
        );
        if (!receipt.accepted) {
          // 引擎侧已不 pending（迟到/重复）：本地同样丢弃即可
          setState(prev => ({ ...prev, approvals: prev.approvals.filter(a => a.rpcId !== rpcId) }));
        }
      } catch {
        // 网络失败：恢复显示，等待 mux 重放（rpcId 稳定）
        setState(prev =>
          prev.approvals.some(a => a.rpcId === rpcId)
            ? prev
            : { ...prev, approvals: [...prev.approvals, current] },
        );
      }
    },
    [],
  );

  // ---- 问题应答 ----
  const respondQuestion = useCallback(
    async (rpcId: string, answers: DshQuestionAnswerItem[]) => {
      const current = stateRef.current.questions.find(q => q.rpcId === rpcId);
      if (!current) return;
      // 乐观移除
      setState(prev => ({ ...prev, questions: prev.questions.filter(q => q.rpcId !== rpcId) }));
      try {
        const receipt = await dshQuestion.respond(rpcId, current.sessionId, answers);
        if (!receipt.accepted) {
          // bad-response：校验失败，恢复显示让用户重答
          setState(prev =>
            prev.questions.some(q => q.rpcId === rpcId)
              ? prev
              : { ...prev, questions: [...prev.questions, current] },
          );
          patch({ error: 'question answer rejected (bad-response)' });
        }
      } catch {
        // 网络失败：恢复显示，等待 mux 重放（rpcId 稳定）
        setState(prev =>
          prev.questions.some(q => q.rpcId === rpcId)
            ? prev
            : { ...prev, questions: [...prev.questions, current] },
        );
      }
    },
    [patch],
  );

  const cancelQuestion = useCallback(async (rpcId: string) => {
    setState(prev => ({ ...prev, questions: prev.questions.filter(q => q.rpcId !== rpcId) }));
    try {
      await dshQuestion.cancel(rpcId);
    } catch {
      // 取消失败无所谓：resolved 帧会收敛
    }
  }, []);

  // ---- 插件 scope 授权（per-plugin 权限模型 v1） ----
  const grantPermission = useCallback(
    async (request: DshPermissionRequest) => {
      setState(prev => ({
        ...prev,
        permissionRequests: prev.permissionRequests.filter(
          r => !(r.pluginId === request.pluginId && r.scope === request.scope),
        ),
      }));
      try {
        await invoke('dsh_plugin_grant', { pluginId: request.pluginId, scope: request.scope });
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      }
    },
    [patch],
  );

  const dismissPermission = useCallback((request: DshPermissionRequest) => {
    setState(prev => ({
      ...prev,
      permissionRequests: prev.permissionRequests.filter(
        r => !(r.pluginId === request.pluginId && r.scope === request.scope),
      ),
    }));
  }, []);

  // ---- 模型切换 ----
  const selectModel = useCallback(
    async (provider: string, model: string) => {
      const sessionId = currentSessionRef.current;
      if (!sessionId) return;
      try {
        const { selected } = await dshSession.selectModel(sessionId, provider, model);
        setState(prev => (prev.models ? { ...prev, models: { ...prev.models, current: selected } } : prev));
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      }
    },
    [patch],
  );

  // ---- 引擎就绪 + mux 订阅 + 会话列表 ----
  useEffect(() => {
    let cancelled = false;
    let unlistenPhase: (() => void) | null = null;
    let unlistenPluginError: (() => void) | null = null;
    let unlistenPermission: (() => void) | null = null;

    const boot = async () => {
      // 阶段事件（安装进度 → 前端状态卡）
      dshEngine.onPhase(phase => {
        if (!cancelled) patch({ phase });
      }).then(un => {
        if (cancelled) un();
        else unlistenPhase = un;
      }).catch(() => undefined);

      // 插件加载错误事件（引擎 stderr 检出 → 场景错误横幅 + 失败反馈上报）
      dshEngine.onPluginError(payload => {
        if (cancelled) return;
        patch({ pluginError: payload });
        // 归因到已上架包时向服务端记一次失败（会话内同键只报一次）
        if (payload.module) {
          void reportRuntimeFailure(payload.module, 'load_failed');
        }
      }).then(un => {
        if (cancelled) un();
        else unlistenPluginError = un;
      }).catch(() => undefined);

      // 插件 scope 授权请求（宿主 403 归因 → 授权卡；(pluginId, scope) 去重）
      dshEngine.onPermissionRequest(request => {
        if (cancelled) return;
        setState(prev =>
          prev.permissionRequests.some(
            r => r.pluginId === request.pluginId && r.scope === request.scope,
          )
            ? prev
            : { ...prev, permissionRequests: [...prev.permissionRequests, request] },
        );
      }).then(un => {
        if (cancelled) un();
        else unlistenPermission = un;
      }).catch(() => undefined);

      try {
        const status = await dshEngine.ensureReady();
        if (!cancelled) patch({ status });
      } catch {
        // ensure 失败也继续尝试直连（引擎可能已被外部拉起）
      }

      // mux WS：实时事件流（session/event → 折叠；approval → 审批状态）
      const conn = connectMux(
        (frame: DshMuxFrame, rpcId: string) => {
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
          } else if (frame.type === 'approval/requested') {
            // mux 重连会以相同 rpcId 重放 pending 帧 → upsert 去重
            setState(prev =>
              prev.approvals.some(a => a.rpcId === rpcId)
                ? prev
                : {
                    ...prev,
                    approvals: [
                      ...prev.approvals,
                      {
                        rpcId,
                        sessionId: frame.sessionId,
                        approvalId: frame.approvalId,
                        toolName: frame.toolName,
                        callId: frame.callId,
                        reason: frame.reason,
                      },
                    ],
                  },
            );
          } else if (frame.type === 'approval/resolved') {
            // 引擎侧已定局（含 turn cancel 触发的 cancelled）：本地同步移除
            setState(prev => ({
              ...prev,
              approvals: prev.approvals.filter(a => a.approvalId !== frame.approvalId),
            }));
          } else if (frame.type === 'question/requested') {
            // mux 重连会以相同 rpcId 重放 pending 帧 → upsert 去重
            setState(prev =>
              prev.questions.some(q => q.rpcId === rpcId)
                ? prev
                : {
                    ...prev,
                    questions: [
                      ...prev.questions,
                      { rpcId, sessionId: frame.sessionId, questions: frame.questions },
                    ],
                  },
            );
          } else if (frame.type === 'question/resolved') {
            // 引擎侧已定局（answered/cancelled）：本地同步移除
            setState(prev => ({
              ...prev,
              questions: prev.questions.filter(q => q.rpcId !== frame.questionRpcId),
            }));
          }
        },
        wsConnected => {
          if (!cancelled) {
            patch({ wsConnected });
            // M0.4：引擎重启（装卸插件/手动重启）后 mux 重连即恢复会话列表，
            // 正在看的会话重拉 history（引擎重启后投影可能变化）
            if (wsConnected) {
              void refreshSessions();
              const sid = currentSessionRef.current;
              if (sid) void openSession(sid);
            }
          }
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
      unlistenPluginError?.();
      unlistenPermission?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    ...state,
    openSession,
    newSession,
    send,
    stop,
    refreshSessions,
    respondApproval,
    respondQuestion,
    cancelQuestion,
    selectModel,
    renameSession,
    forkSession,
    restartEngine,
    grantPermission,
    dismissPermission,
    /** 清空插件错误横幅（用户处理完成后手动关闭）。 */
    clearPluginError: useCallback(() => patch({ pluginError: null }), [patch]),
  };
}
