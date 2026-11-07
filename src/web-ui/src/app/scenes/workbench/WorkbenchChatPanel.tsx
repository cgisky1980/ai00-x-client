/**
 * WorkbenchChatPanel — 工作台窗口的固定对话区（宿主侧 UI）。
 *
 * 《工作台插件规范》§6.2 落地：
 * - 插件经总线 `workbench:active-project{projectId,title?}` 上报当前工程；
 *   宿主据此解析工程根、写入 AGENTS.local.md（system 段注入）、创建/复用
 *   绑定会话（projectId→sessionId 映射由宿主持有，插件不得自存）。
 * - 写类工具越界（审批帧到达时按 callId 反查路径参数判定）自动拒绝并在
 *   头部下方给出 path_out_of_scope 结构化提示。
 * - 写类工具成功落盘 → 总线 `workbench:project-written{projectId,paths}`
 *   回发插件（插件据此刷新预览）。
 *
 * 接线配方与 SessionChatPanel 同源（历史基线 + connectMux 实时流 →
 * foldEvents；审批/提问走 $events waterfall 应答）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, Bot } from 'lucide-react';
import { AgentComposer } from '@/app/components/ai/AgentComposer';
import type { PromptSubmitIntent } from '@/component-library';
import {
  connectMux,
  createDshRequestId,
  dshApproval,
  dshQuestion,
  dshSession,
  foldEvents,
  type DshApproval,
  type DshLiveAssistant,
  type DshMessage,
  type DshMuxConnection,
  type DshMuxFrame,
  type DshQuestion,
  type DshQuestionAnswerItem,
  type DshQueueItem,
  type DshSessionEvent,
} from '@/infrastructure/api/service-api/DshAPI';
import { isApprovalAllowed } from '@/shared/agent-approval-rules';
import { emitBusEvent, onBusEvent } from '@/infrastructure/plugins/runtime';
import { ensureWorkbenchSession, forgetBoundSession } from '@/infrastructure/plugins/workbenchSession';
import { ToolCallTracker, type ScopeViolation } from '@/infrastructure/plugins/workbenchScope';
import type { WorkbenchEntry } from '@/infrastructure/plugins/workbenchRegistry';
import { ApprovalCard, ChatErrorText, MessageBubble, QuestionCard } from '../dsh/DshChatPieces';
import { groupMessagesForDisplay } from '../dsh/messageGroups';
import { WorkbenchQueueDock, type QueueDockRow } from './WorkbenchQueueDock';
// 消息/输入区样式类复用策场景（__msg* / __composer 等 BEM 平级类）
import '../dsh/DshScene.scss';

interface WorkbenchChatPanelProps {
  entry: WorkbenchEntry;
  /** 插件页挂载失败：AI 区显示不可用状态，不建立任何会话。 */
  pluginUnavailable?: boolean;
}

interface ActiveProject {
  projectId: string;
  title?: string;
}

interface BoundState {
  sessionId: string;
  cwd: string;
}

/** 本地提交的落位：transcript=当前对话，queued/steering=待处理队列。 */
type SubmissionPlacement = 'transcript' | 'queued' | 'steering';
type SubmissionStatus = 'sending' | 'accepted' | 'failed';

/**
 * 一条本地提交的即时回显。
 *
 * 只是进程内事实，不是持久队列：Host 的 `inbox` 投影才是队列权威，
 * durable `user/message.source.rpcId` 到达后本项退休。
 */
interface LocalSubmission {
  requestId: string;
  sessionId: string;
  text: string;
  mode: 'queue' | 'steer';
  placement: SubmissionPlacement;
  status: SubmissionStatus;
  error?: string;
}

export const WorkbenchChatPanel: React.FC<WorkbenchChatPanelProps> = ({
  entry,
  pluginUnavailable = false,
}) => {
  const { t } = useTranslation('common');
  const tDsh = useTranslation('scenes/dsh').t;

  const [project, setProject] = useState<ActiveProject | null>(null);
  const [bound, setBound] = useState<BoundState | null>(null);
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);

  const [messages, setMessages] = useState<DshMessage[]>([]);
  /** 进程内实时流（逐字刷新）；落盘消息到达后清空，避免与历史重复。 */
  const [live, setLive] = useState<DshLiveAssistant | null>(null);
  /** 已发出、助手还没吐出第一个字（显示生成中提示，避免像卡死）。 */
  const [awaitingAgent, setAwaitingAgent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [agentRunning, setAgentRunning] = useState(false);
  /** 正在停止当前回合（防重入；回合闭合后复位）。 */
  const [stopping, setStopping] = useState(false);
  /** 本地提交即时回显（按 requestId 与 Host 对账后退休）。 */
  const [submissions, setSubmissions] = useState<LocalSubmission[]>([]);
  /** Host 权威待处理队列（inbox 投影：next-turn + next-step）。 */
  const [hostInbox, setHostInbox] = useState<DshQueueItem[]>([]);
  /** 最近一次失败、可一键重试的提交文本（回合失败时给出明确下一步）。 */
  const [retryableText, setRetryableText] = useState<string | null>(null);
  /** 队列操作（编辑/删除/插话/清空）的可见错误。 */
  const [dockError, setDockError] = useState<string | null>(null);
  /** 用户向上阅读时出现「有新内容」提示。 */
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const [approvals, setApprovals] = useState<DshApproval[]>([]);
  const [questions, setQuestions] = useState<DshQuestion[]>([]);
  const [violations, setViolations] = useState<ScopeViolation[]>([]);
  /** mux 连接已中断（引擎重启/网络抖动）：重连前显式告知，不让界面假装还在运行。 */
  const [linkDown, setLinkDown] = useState(false);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** 展示用消息：逐条落盘的助手消息按回合合并成一个气泡（Trae 形态）。 */
  const displayMessages = useMemo(() => groupMessagesForDisplay(messages), [messages]);
  const eventsRef = useRef<DshSessionEvent[]>([]);
  const trackerRef = useRef(new ToolCallTracker());
  /** 当前绑定会话（mux 回调闭包里读最新值用）。 */
  const boundRef = useRef<BoundState | null>(null);
  boundRef.current = bound;
  const projectRef = useRef<ActiveProject | null>(null);
  projectRef.current = project;
  /** 绑定序号：快速切换工程时，只有最后一次 active-project 的异步结果允许落地。 */
  const bindTokenRef = useRef(0);
  /** 同一会话的 prompt 按提交顺序串行发出（保证成功提交的 FIFO）。 */
  const sendChainRef = useRef<Promise<void>>(Promise.resolve());
  /** 滚动跟随：用户向上阅读时不再强制拉到底。 */
  const stickToBottomRef = useRef(true);
  /** 停止兜底复位（引擎未回 turn/end 时不至于永久卡在「正在停止」）。 */
  const stoppingTimerRef = useRef<number | null>(null);
  /** 当前 Host 队列的最新值（快照对账时读，避免闭包过期）。 */
  const hostInboxRef = useRef<DshQueueItem[]>([]);
  /** 当前 running 的最新值（mux 断线回调里读，避免闭包过期）。 */
  const runningRef = useRef(false);
  /** 断线时回合仍在跑：重连后据此判断「回合被断线带走」并显式报错。 */
  const interruptedRef = useRef(false);
  /** 当前 mux 连接句柄（静默检测需要读 lastActivity / 触发 restart）。 */
  const muxRef = useRef<DshMuxConnection | null>(null);
  /** 上次强制重连 mux 的时间（防抖，避免反复断开重连）。 */
  const lastMuxRestartRef = useRef(0);

  const sessionId = bound?.sessionId ?? null;

  /** 当前回合是否在运行：本地等待 + 实时流 + running 查询三者取并集。 */
  const running = agentRunning || awaitingAgent || Boolean(live?.active);
  runningRef.current = running;
  hostInboxRef.current = hostInbox;

  /** 实时流是否已有可见文本；没有就显示动态等待提示。 */
  const liveHasText = Boolean(live && (live.text || live.reasoning));
  const showPendingDots = !liveHasText && running;

  const sessionSubs = useMemo(
    () => submissions.filter(s => s.sessionId === sessionId),
    [submissions, sessionId],
  );

  /** 当前 transcript 的即时用户气泡（只含未落盘的 transcript 落位提交）。 */
  const transcriptEchoes = sessionSubs.filter(
    s => s.placement === 'transcript' && s.status !== 'failed',
  );

  /** Queue Dock 行：Host 权威行在前，本地未对账行在后；失败项始终可见可处理。 */
  const queueRows = useMemo<QueueDockRow[]>(() => {
    const hostRequestIds = new Set(
      hostInbox.map(i => i.requestId).filter((v): v is string => Boolean(v)),
    );
    const hostRows: QueueDockRow[] = hostInbox.map(i => ({
      key: i.itemId,
      text: i.text,
      placement: i.placement,
      status: 'accepted',
      itemId: i.itemId,
    }));
    const localRows: QueueDockRow[] = sessionSubs
      .filter(s => s.placement !== 'transcript' || s.status === 'failed')
      .filter(s => !(s.requestId && hostRequestIds.has(s.requestId)))
      .map(s => ({
        key: s.requestId,
        text: s.text,
        placement: s.mode === 'steer' ? ('steering' as const) : ('queued' as const),
        status: s.status,
        ...(s.error ? { error: s.error } : {}),
      }));
    return [...hostRows, ...localRows];
  }, [hostInbox, sessionSubs]);

  const hasPendingSubmission = sessionSubs.some(s => s.status === 'sending');

  /** 退休与 Host 已对齐的本地回显（同一 rpcId 不重复显示）。 */
  const retireSubmissions = useCallback((predicate: (s: LocalSubmission) => boolean): void => {
    setSubmissions(prev => {
      const next = prev.filter(s => !predicate(s));
      return next.length === prev.length ? prev : next;
    });
  }, []);

  const clearStopping = useCallback((): void => {
    setStopping(false);
    if (stoppingTimerRef.current !== null) {
      window.clearTimeout(stoppingTimerRef.current);
      stoppingTimerRef.current = null;
    }
  }, []);

  /**
   * 队列兜底快照：`session/state.queue` 是 live Agent 的权威待处理列表
   * （含 itemId / placement / rpcId）。
   *
   * 正常情况下以 `inbox` 投影为准；但事件流可能静默断掉（引擎重启后 WS 不报
   * close），此时投影永远停在旧值——Dock 会出现「有排队项却没清空按钮」。
   * 所以只要快照与当前显示的 Host 行不一致就以此为准（增/删都能纠正）。
   */
  const refreshQueueSnapshot = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const state = await dshSession.state(sessionId);
      if (!state.queue) return; // 引擎无 live Agent：保留现状
      const current = hostInboxRef.current;
      const same =
        current.length === state.queue.length &&
        current.every((it, i) => it.itemId === state.queue?.[i]?.itemId);
      if (same) return;
      setHostInbox(state.queue);
      const rpcIds = new Set(
        state.queue.map(i => i.requestId).filter((v): v is string => Boolean(v)),
      );
      if (rpcIds.size > 0) {
        retireSubmissions(
          s => s.sessionId === sessionId && Boolean(s.requestId) && rpcIds.has(s.requestId as string),
        );
      }
    } catch {
      // 取不到就维持现状（inbox 帧到达后会自然纠正）
    }
  }, [sessionId, retireSubmissions]);

  /** 绑定（或重试绑定）指定工程：准备目录/会话/模型；失败保留可重试状态。 */
  const bindProject = useCallback(
    (projectId: string, title?: string): void => {
      const token = ++bindTokenRef.current;
      setProject({ projectId, title });
      setBinding(true);
      setBindError(null);
      void ensureWorkbenchSession(entry, projectId, title)
        .then((ensured) => {
          if (token !== bindTokenRef.current) return; // 已被更新的选择取代
          setBound({ sessionId: ensured.sessionId, cwd: ensured.cwd });
        })
        .catch((err) => {
          if (token !== bindTokenRef.current) return;
          setBound(null);
          setBindError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (token === bindTokenRef.current) setBinding(false);
        });
    },
    [entry],
  );

  // 插件上报当前工程 → 解析工程根 + 写 AGENTS.local.md + 建/复用会话
  useEffect(() => {
    const off = onBusEvent('workbench:active-project', (data) => {
      const payload = data as { projectId?: string; title?: string } | undefined;
      if (!payload?.projectId) return;
      if (projectRef.current?.projectId === payload.projectId && boundRef.current) return;
      bindProject(payload.projectId, payload.title);
    });
    return off;
  }, [bindProject]);

  // 插件删除工程 → 只移除绑定并清空面板（不删引擎历史，会话可另行在会话列表查看）
  useEffect(() => {
    const off = onBusEvent('workbench:project-removed', (data) => {
      const payload = data as { projectId?: string } | undefined;
      const removed = payload?.projectId;
      if (!removed) return;
      forgetBoundSession(entry.id, removed);
      if (projectRef.current?.projectId !== removed) return;
      bindTokenRef.current += 1;
      projectRef.current = null;
      setProject(null);
      setBound(null);
      setBinding(false);
      setBindError(null);
      setMessages([]);
      setLive(null);
      setAwaitingAgent(false);
      setSubmissions([]);
      setHostInbox([]);
      setApprovals([]);
      setQuestions([]);
      setViolations([]);
      setError(null);
      setDockError(null);
      setRetryableText(null);
    });
    return off;
  }, [entry.id]);

  const reloadBaseline = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const { events } = await dshSession.history(sessionId);
      eventsRef.current = events.map(e => e.event);
      const folded = foldEvents(eventsRef.current);
      setMessages(folded);
      // 对账：已落盘的用户消息退休对应的本地即时气泡（按 rpcId 优先，文本兜底）
      const rpcIds = new Set(
        folded.filter(m => m.role === 'user' && m.rpcId).map(m => m.rpcId as string),
      );
      const userTexts = new Set(folded.filter(m => m.role === 'user').map(m => m.text.trim()));
      retireSubmissions(
        s =>
          s.sessionId === sessionId &&
          s.placement === 'transcript' &&
          s.status !== 'sending' &&
          ((s.requestId ? rpcIds.has(s.requestId) : false) || userTexts.has(s.text.trim())),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 引擎暂时不可达（重启/断线）不算会话错误：重连横幅与运行态校准会兜底，
      // 直接把原始 HTTP 502 甩到对话区只会误导「会话坏了」。
      if (!/HTTP 50[23]/.test(message)) setError(message);
    }
  }, [sessionId, retireSubmissions]);

  /** 拉一次权威运行态：返回引擎里的 running（拉不到返回 null，用于断线后判定）。 */
  const refreshRunning = useCallback(async (): Promise<boolean | null> => {
    if (!sessionId) return false;
    try {
      // session/state 比会话列表更直接（running/live 队列同源）
      const state = await dshSession.state(sessionId);
      setAgentRunning(state.running);
      if (!state.running) clearStopping();
      return state.running;
    } catch {
      // state 拉不到 → 退回会话列表，再不行判定为「不可达」
      try {
        const { items } = await dshSession.list();
        const self = items.find((it) => it.sessionId === sessionId);
        const value = Boolean(self?.running);
        setAgentRunning(value);
        return value;
      } catch {
        return null;
      }
    }
  }, [sessionId, clearStopping]);

  // 绑定切换：重置面板状态 + 拉历史基线
  useEffect(() => {
    eventsRef.current = [];
    trackerRef.current.clear();
    setMessages([]);
    setLive(null);
    setAwaitingAgent(false);
    setApprovals([]);
    setQuestions([]);
    setViolations([]);
    setError(null);
    // 队列状态按会话隔离：切项目不能带走上一个项目的排队与草稿回显
    setSubmissions([]);
    setHostInbox([]);
    setDockError(null);
    setRetryableText(null);
    setStopping(false);
    setHasNewBelow(false);
    setLinkDown(false);
    interruptedRef.current = false;
    stickToBottomRef.current = true;
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      await reloadBaseline();
      await refreshRunning();
      await refreshQueueSnapshot();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadBaseline, refreshRunning, refreshQueueSnapshot]);

  // 实时流
  useEffect(() => {
    if (!sessionId) return undefined;
    const conn = connectMux((frame: DshMuxFrame, frameRpcId: string) => {
      // 会话流打不开（引擎重启后会话丢失）：立刻收敛运行态，不假装还在跑。
      // 只认本会话（或无 sessionId 的全局流）的错误——子代理等其它会话的
      // follow 失败与本次对话无关，不能误报「当前回合未完成」。
      if (frame.type === 'stream/error') {
        if (frame.sessionId && frame.sessionId !== sessionId) return;
        if (runningRef.current) {
          setAgentRunning(false);
          setAwaitingAgent(false);
          setStopping(false);
          setLive(null);
          setError(t('nav.workbenchScene.chat.turnInterrupted'));
        }
        return;
      }
      // Host 权威队列：完整替换 + 按 rpcId 退休已对齐的本地回显
      if (frame.type === 'session/inbox' && frame.sessionId === sessionId) {
        setHostInbox(frame.items);
        const rpcIds = new Set(
          frame.items.map(i => i.requestId).filter((v): v is string => Boolean(v)),
        );
        if (rpcIds.size > 0) {
          retireSubmissions(
            s => s.sessionId === sessionId && Boolean(s.requestId) && rpcIds.has(s.requestId as string),
          );
        }
        return;
      }
      // 实时助手流（逐字）：只在未落盘时显示
      if (frame.type === 'session/assistant-stream' && frame.sessionId === sessionId) {
        setAwaitingAgent(false);
        setLive(frame.live);
        return;
      }
      if (frame.type === 'approval/requested' && frame.sessionId === sessionId) {
        const cwd = boundRef.current?.cwd;
        const violation = cwd
          ? trackerRef.current.checkApproval(frame.toolName, frame.callId, cwd)
          : null;
        if (violation) {
          void dshApproval.respond(frameRpcId, sessionId, frame.approvalId, 'rejected');
          setViolations(prev => [...prev, violation]);
          return;
        }
        if (isApprovalAllowed(sessionId, frame.toolName)) {
          void dshApproval.respond(frameRpcId, sessionId, frame.approvalId, 'allowed-once');
          return;
        }
        setApprovals(prev =>
          prev.some(a => a.rpcId === frameRpcId)
            ? prev
            : [...prev, {
                rpcId: frameRpcId,
                sessionId,
                approvalId: frame.approvalId,
                toolName: frame.toolName,
                callId: frame.callId,
                reason: frame.reason,
              }],
        );
        return;
      }
      if (frame.type === 'approval/resolved' && frame.sessionId === sessionId) {
        setApprovals(prev => prev.filter(a => a.approvalId !== frame.approvalId));
        return;
      }
      if (frame.type === 'question/requested' && frame.sessionId === sessionId) {
        setQuestions(prev =>
          prev.some(q => q.rpcId === frameRpcId)
            ? prev
            : [...prev, { rpcId: frameRpcId, sessionId, questions: frame.questions }],
        );
        return;
      }
      if (frame.type === 'question/resolved' && frame.sessionId === sessionId) {
        setQuestions(prev => prev.filter(q => q.rpcId !== frame.questionRpcId));
        return;
      }
      if (frame.type !== 'session/event' || frame.sessionId !== sessionId) return;

      const event = frame.event;
      // 落盘的助手消息到达 → 撤掉实时气泡（历史基线已含全文）
      if (event.type === 'assistant/message') {
        setAwaitingAgent(false);
        setLive(null);
      }
      // 真实用户消息已落盘 → 只退休同 rpcId 的本地回显（引擎注入消息不算）
      if (event.type === 'user/message') {
        const src = (event.data as { source?: { form?: string; rpcId?: unknown } } | undefined)?.source;
        if (!src?.form) {
          const rpcId = typeof src?.rpcId === 'string' ? src.rpcId : null;
          if (rpcId) {
            retireSubmissions(s => s.sessionId === sessionId && s.requestId === rpcId);
          }
          setAwaitingAgent(false);
        }
      }
      // 跟踪工具调用参数（审批帧反查 + 写盘检测共用）
      if (event.type === 'tool/call') {
        const data = event.data as { callId?: string; name?: string; arguments?: unknown } | undefined;
        trackerRef.current.note(
          String(data?.callId ?? ''),
          String(data?.name ?? ''),
          String(data?.arguments ?? '{}'),
        );
      }
      if (event.type === 'assistant/chunk') {
        const chunk = (event.data as { chunk?: { type?: string; block?: { type?: string; id?: string; name?: string; arguments?: string } } } | undefined)?.chunk;
        if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call') {
          trackerRef.current.note(
            chunk.block.id ?? '',
            chunk.block.name ?? '',
            chunk.block.arguments ?? '{}',
          );
        }
      }
      // 写类工具成功落盘 → 回发插件刷新预览（§6.2 project-written）
      if (event.type === 'tool/result') {
        const data = event.data as {
          message?: {
            content?: Array<{ type?: string; text?: string; toolCallId?: string; isError?: boolean }>;
            toolCallId?: string;
            isError?: boolean;
            source?: { kind?: string; callId?: string };
          };
          error?: { name?: string; code?: string };
        } | undefined;
        const message = data?.message;
        // callId 在 0.2.2 落盘形状里位于 message.toolCallId / source.callId
        const callId =
          message?.toolCallId ??
          message?.content?.[0]?.toolCallId ??
          message?.source?.callId;
        const failed =
          Boolean(data?.error) ||
          message?.isError === true ||
          message?.content?.[0]?.isError === true;
        if (callId && !failed) {
          const paths = trackerRef.current.writtenPaths(callId);
          const projectId = projectRef.current?.projectId;
          if (paths.length > 0 && projectId) {
            emitBusEvent('workbench:project-written', { projectId, paths });
          }
        }
      }
      if (event.type === 'turn/end') {
        setLive(null);
        setAwaitingAgent(false);
        clearStopping();
        // 回合结束不清队列：Host 仍待处理的输入会在下一回合继续
        void reloadBaseline();
        void refreshRunning();
        void refreshQueueSnapshot();
        return;
      }
      eventsRef.current = [...eventsRef.current, event];
      setMessages(foldEvents(eventsRef.current));
    }, (connected: boolean) => {
      setLinkDown(!connected);
      if (!connected) {
        // 断线时回合仍在跑 → 记下来，重连后判定这次回合是否被带走
        if (runningRef.current) interruptedRef.current = true;
        return;
      }
      void (async () => {
        const stillRunning = await refreshRunning();
        await reloadBaseline();
        if (!interruptedRef.current) return;
        interruptedRef.current = false;
        // 引擎里还在跑（重连后继续收流）或断线期间已正常收口 → 不报错
        if (stillRunning === true) return;
        const folded = foldEvents(eventsRef.current);
        if (folded.length > 0 && folded[folded.length - 1].role === 'assistant') return;
        setAgentRunning(false);
        setAwaitingAgent(false);
        setStopping(false);
        setLive(null);
        const lastUser = [...folded].reverse().find(m => m.role === 'user');
        setRetryableText(lastUser?.text?.trim() || null);
        setError(t('nav.workbenchScene.chat.turnInterrupted'));
      })();
    });
    muxRef.current = conn;
    return () => {
      muxRef.current = null;
      conn.close();
    };
  }, [sessionId, reloadBaseline, refreshRunning, refreshQueueSnapshot, retireSubmissions, clearStopping, t]);

  // —— 事件流兜底：mux 可能因引擎重启而与后端脱节（WS 不报错、收不到帧）——
  // 运行中每 15s 用引擎权威状态校准一次；发现引擎已不在跑就拉历史收口，
  // 避免永久停在「思考中」而答案其实早已落盘。
  useEffect(() => {
    if (!running || !sessionId) return undefined;
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      if (ticks < 2) return; // 刚提交先给引擎启动时间
      void (async () => {
        const state = await refreshRunning();
        if (state !== false) {
          void refreshQueueSnapshot();
          return;
        }
        await reloadBaseline();
        void refreshQueueSnapshot();
        setAwaitingAgent(false);
        setLive(null);
        setStopping(false);
      })();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [running, sessionId, refreshRunning, reloadBaseline, refreshQueueSnapshot]);

  // —— 事件流静默检测：引擎侧 cursor 在涨、界面却收不到帧 → 强制重连 ——
  // 引擎重启后代理侧上游已死但浏览器 WS 不报 close，只有重连才能重新订阅。
  // 判据用「cursor 前进但 UI 无帧」，避免把长时间静默的工具执行误判成断流。
  useEffect(() => {
    if (!awaitingAgent || liveHasText || !sessionId) return undefined;
    const startedAt = Date.now();
    let lastCursor = -1;
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt < 12_000) return;
      void (async () => {
        const conn = muxRef.current;
        if (!conn) return;
        let cursor = -1;
        try {
          const state = await dshSession.state(sessionId);
          if (!state.running) return; // 已收口：交给运行态校准处理
          cursor = state.cursor;
        } catch {
          return; // 引擎不可达：交给断线/校准逻辑
        }
        if (lastCursor < 0) {
          lastCursor = cursor;
          return;
        }
        // 引擎没有新事件（长工具执行中）→ 不是断流
        if (cursor <= lastCursor) return;
        lastCursor = cursor;
        if (Date.now() - lastMuxRestartRef.current < 20_000) return;
        lastMuxRestartRef.current = Date.now();
        conn.restart();
      })();
    }, 6_000);
    return () => window.clearInterval(timer);
  }, [awaitingAgent, liveHasText, sessionId]);

  // —— 滚动：贴底跟随，用户向上阅读后不打断（出现「回到最新」） ——
  const scrollToBottom = useCallback((): void => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setHasNewBelow(false);
  }, []);

  const handleBodyScroll = useCallback((): void => {
    const el = bodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickToBottomRef.current = nearBottom;
    if (nearBottom) setHasNewBelow(false);
  }, []);

  useEffect(() => {
    if (stickToBottomRef.current) scrollToBottom();
    else if (messages.length > 0 || live) setHasNewBelow(true);
  }, [messages, live, awaitingAgent, scrollToBottom]);

  /** 提交一条文本：决定 mode/落位 → 本地即时回显 → 同会话串行发出。 */
  const submitText = useCallback(
    (text: string, intent: PromptSubmitIntent = 'queue'): void => {
      const trimmed = text.trim();
      if (!trimmed || !sessionId || binding) return;
      const wasRunning = running;
      const mode: 'queue' | 'steer' = wasRunning && intent === 'steer' ? 'steer' : 'queue';
      const placement: SubmissionPlacement = wasRunning
        ? mode === 'steer'
          ? 'steering'
          : 'queued'
        : 'transcript';
      const requestId = createDshRequestId();
      const submission: LocalSubmission = {
        requestId,
        sessionId,
        text: trimmed,
        mode,
        placement,
        status: 'sending',
      };
      setSubmissions(prev => [...prev, submission]);
      setError(null);
      setRetryableText(null);
      setDockError(null);
      if (placement === 'transcript') {
        setAwaitingAgent(true);
        setAgentRunning(true);
        scrollToBottom();
      }
      sendChainRef.current = sendChainRef.current.then(async () => {
        try {
          await dshSession.prompt(sessionId, trimmed, { mode, requestId });
          setSubmissions(prev =>
            prev.map(s =>
              s.requestId === requestId && s.status === 'sending'
                ? { ...s, status: 'accepted' }
                : s,
            ),
          );
          // 排队/插话：立刻用 live 队列快照补 itemId（inbox 投影不可用时的兜底）
          if (placement !== 'transcript') void refreshQueueSnapshot();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setSubmissions(prev =>
            prev.map(s => (s.requestId === requestId ? { ...s, status: 'failed', error: message } : s)),
          );
          if (placement === 'transcript') {
            setAwaitingAgent(false);
            setAgentRunning(false);
            setRetryableText(trimmed);
            setError(message);
          }
        }
      });
    },
    [sessionId, binding, running, scrollToBottom, refreshQueueSnapshot],
  );

  const handleSend = (intent?: PromptSubmitIntent): void => {
    const text = draft.trim();
    if (!text || !sessionId || binding) return;
    // 先按提交的值清空草稿，避免异步期间覆盖用户后续输入
    setDraft(prev => (prev.trim() === text ? '' : prev));
    submitText(text, intent ?? 'queue');
  };

  /** 重试一条失败提交（同一会话、同一文本，不伪造历史）。 */
  const handleRetrySubmission = (row: QueueDockRow): void => {
    retireSubmissions(s => s.requestId === row.key);
    submitText(row.text, row.placement === 'steering' ? 'steer' : 'queue');
  };

  const handleStop = async (): Promise<void> => {
    if (!sessionId || stopping) return;
    setStopping(true);
    // 兜底：引擎未回 turn/end 时也要退出「正在停止」态，避免永久禁用
    if (stoppingTimerRef.current !== null) window.clearTimeout(stoppingTimerRef.current);
    stoppingTimerRef.current = window.setTimeout(() => clearStopping(), 20_000);
    try {
      await dshSession.cancel(sessionId);
      // 只取消当前回合：inbox 里的排队项由 Host 继续调度
      void refreshRunning();
    } catch (err) {
      clearStopping();
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // —— Queue Dock 操作：只对 Host 权威行调用 updateQueue ——
  const runQueueAction = async (action: () => Promise<void>): Promise<void> => {
    if (!sessionId) return;
    setDockError(null);
    try {
      await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('queue-item-not-found')) {
        setDockError(tDsh('chat.queueItemClaimed'));
      } else if (message.includes('steer-unavailable')) {
        setDockError(tDsh('chat.queueSteerUnavailable'));
      } else {
        setDockError(tDsh('chat.queueActionFailed', { message }));
      }
      // 竞态：以最新 Host 状态收敛（inbox 帧会随后更新；这里补一次 running 校准）
      void refreshRunning();
    }
  };

  const handleQueueEdit = async (row: QueueDockRow, text: string): Promise<void> => {
    if (!sessionId || !row.itemId) return;
    await runQueueAction(async () => {
      await dshSession.updateQueue(sessionId, row.itemId as string, { kind: 'edit', text });
    });
  };

  const handleQueueRemove = async (row: QueueDockRow): Promise<void> => {
    if (!sessionId) return;
    if (!row.itemId) {
      // 本地失败项：直接从回显里移除
      retireSubmissions(s => s.requestId === row.key);
      return;
    }
    await runQueueAction(async () => {
      await dshSession.updateQueue(sessionId, row.itemId as string, { kind: 'remove' });
    });
  };

  const handleQueueSteer = async (row: QueueDockRow): Promise<void> => {
    if (!sessionId || !row.itemId) return;
    await runQueueAction(async () => {
      await dshSession.updateQueue(sessionId, row.itemId as string, { kind: 'steer' });
    });
  };

  const handleQueueClearAll = async (rows: QueueDockRow[]): Promise<void> => {
    if (!sessionId) return;
    await runQueueAction(async () => {
      for (const row of rows) {
        if (!row.itemId) continue;
        await dshSession.updateQueue(sessionId, row.itemId, { kind: 'remove' });
      }
    });
  };

  const respondApproval = async (rpcId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> => {
    if (!sessionId) return;
    const a = approvals.find(x => x.rpcId === rpcId);
    if (!a) return;
    const receipt = await dshApproval.respond(rpcId, sessionId, a.approvalId, outcome);
    if (receipt.accepted) setApprovals(prev => prev.filter(x => x.rpcId !== rpcId));
  };

  const respondQuestion = async (rpcId: string, answers: DshQuestionAnswerItem[]): Promise<void> => {
    if (!sessionId) return;
    const receipt = await dshQuestion.respond(rpcId, sessionId, answers);
    if (receipt.accepted) setQuestions(prev => prev.filter(q => q.rpcId !== rpcId));
  };

  const cancelQuestion = (rpcId: string): void => {
    void dshQuestion.cancel(rpcId);
    setQuestions(prev => prev.filter(q => q.rpcId !== rpcId));
  };

  // 插件页不可用：AI 区给出明确的不可用状态，不建立会话、不显示输入框
  if (pluginUnavailable) {
    return (
      <div className="ai00-x-workbench-chat">
        <div className="ai00-x-workbench-chat__head">
          <span className="ai00-x-workbench-chat__dot" />
          <span className="ai00-x-workbench-chat__title">{t('nav.workbenchScene.chat.title')}</span>
        </div>
        <div className="ai00-x-workbench-chat__empty" role="status">
          {t('nav.workbenchScene.chat.pluginUnavailable')}
        </div>
      </div>
    );
  }

  return (
    <div className="ai00-x-workbench-chat">
      <div className="ai00-x-workbench-chat__head">
        <span className={`ai00-x-workbench-chat__dot${agentRunning ? ' is-running' : ''}`} />
        <span className="ai00-x-workbench-chat__title">{t('nav.workbenchScene.chat.title')}</span>
        {project && (
          <span className="ai00-x-workbench-chat__project" title={bound?.cwd}>
            {project.title || project.projectId}
          </span>
        )}
      </div>

      {!project && (
        <div className="ai00-x-workbench-chat__empty">
          {t('nav.workbenchScene.chat.noProject')}
        </div>
      )}
      {project && binding && (
        <div className="ai00-x-workbench-chat__empty">
          {t('nav.workbenchScene.chat.binding')}
        </div>
      )}
      {project && !binding && bindError && (
        <div className="ai00-x-workbench-chat__empty">
          <p>{t('nav.workbenchScene.chat.bindFailed', { message: bindError })}</p>
          <button
            type="button"
            className="ai00-x-workbench-chat__retry"
            onClick={() => bindProject(project.projectId, project.title)}
          >
            {t('nav.workbenchScene.retry')}
          </button>
        </div>
      )}

      {project && !binding && !bindError && bound && (
        <>
          <div className="ai00-x-workbench-chat__body">
          <div
            className="ai00-x-dsh-scene__messages"
            ref={bodyRef}
            onScroll={handleBodyScroll}
          >
            {loading && (
              <div className="ai00-x-dsh-scene__messages-empty">{tDsh('sessions.loading')}</div>
            )}
            {!loading && messages.length === 0 && !error && (
              <div className="ai00-x-dsh-scene__messages-empty">
                <p>{tDsh('chat.empty')}</p>
                {(entry.starterPrompts?.length ?? 0) > 0 && (
                  <div className="ai00-x-workbench-chat__starters">
                    {entry.starterPrompts?.map(prompt => (
                      <button
                        key={prompt}
                        type="button"
                        className="ai00-x-workbench-chat__starter"
                        onClick={() => setDraft(prompt)}
                        title={prompt}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {displayMessages.map(m => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {/* 尚未落盘的用户输入：立即回显（落盘后按 rpcId 退休） */}
            {transcriptEchoes.map(sub => (
              <div key={sub.requestId} className="ai00-x-workbench-chat__optimistic">
                <MessageBubble
                  message={{
                    id: `pending-${sub.requestId}`,
                    role: 'user',
                    text: sub.text,
                    toolCalls: [],
                    streaming: false,
                  }}
                />
              </div>
            ))}
            {/* 未落盘的实时助手流：逐字刷新（落盘后由 MessageBubble 接管） */}
            {live && (live.text || live.reasoning) && (
              <MessageBubble
                message={{
                  id: 'live',
                  role: 'assistant',
                  text: live.text,
                  ...(live.reasoning ? { reasoning: live.reasoning } : {}),
                  toolCalls: [],
                  streaming: live.active,
                }}
              />
            )}
            {/* 助手在跑但还没有可见文本（含请求在途）：动态等待提示，避免像卡死 */}
            {showPendingDots && (
              <div className="ai00-x-dsh-scene__msg is-assistant">
                <div className="ai00-x-dsh-scene__msg-avatar">
                  <Bot size={13} />
                </div>
                <div className="ai00-x-dsh-scene__msg-body">
                  <div className="ai00-x-workbench-chat__pending" role="status" aria-live="polite">
                    <span className="ai00-x-workbench-chat__pending-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span>
                      {stopping ? tDsh('chat.stopping') : tDsh('chat.thinking')}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {linkDown && (
              <div className="ai00-x-dsh-scene__error" role="status" aria-live="polite">
                <span>{t('nav.workbenchScene.chat.reconnecting')}</span>
              </div>
            )}
            {error && (
              <div className="ai00-x-dsh-scene__error" role="alert">
                <ChatErrorText raw={error} />
                {retryableText && (
                  <button
                    type="button"
                    className="ai00-x-workbench-chat__retry"
                    onClick={() => {
                      const text = retryableText;
                      setRetryableText(null);
                      setError(null);
                      submitText(text, 'queue');
                    }}
                  >
                    {tDsh('chat.retryTurn')}
                  </button>
                )}
              </div>
            )}
          </div>
            {hasNewBelow && (
              <button
                type="button"
                className="ai00-x-workbench-chat__jump"
                onClick={scrollToBottom}
              >
                <ArrowDown size={12} />
                <span>{tDsh('chat.scrollToLatest')}</span>
              </button>
            )}
          </div>

          {violations.length > 0 && (
            <div className="ai00-x-workbench-chat__violations">
              {violations.map((v, i) => (
                <div key={`${v.path}-${i}`} className="ai00-x-workbench-chat__violation">
                  <span className="ai00-x-workbench-chat__violation-code">path_out_of_scope</span>
                  <span className="ai00-x-workbench-chat__violation-path" title={v.path}>{v.path}</span>
                  <button
                    type="button"
                    className="ai00-x-workbench-chat__violation-dismiss"
                    onClick={() => setViolations(prev => prev.filter((_, j) => j !== i))}
                    aria-label={t('nav.workbenchScene.chat.dismiss')}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {approvals.length > 0 && (
            <div className="ai00-x-dsh-scene__approvals">
              {approvals.map(a => (
                <ApprovalCard
                  key={a.rpcId}
                  approval={a}
                  onRespond={(rpcId, outcome) => void respondApproval(rpcId, outcome)}
                />
              ))}
            </div>
          )}
          {questions.length > 0 && (
            <div className="ai00-x-dsh-scene__approvals">
              {questions.map(q => (
                <QuestionCard key={q.rpcId} batch={q} onRespond={respondQuestion} onCancel={cancelQuestion} />
              ))}
            </div>
          )}

          <WorkbenchQueueDock
            rows={queueRows}
            running={running}
            onEdit={handleQueueEdit}
            onRemove={handleQueueRemove}
            onSteer={handleQueueSteer}
            onRetry={handleRetrySubmission}
            onClearAll={handleQueueClearAll}
            actionError={dockError}
          />

          <div className="ai00-x-dsh-scene__composer">
            <AgentComposer
              value={draft}
              onChange={setDraft}
              onSubmit={handleSend}
              onStop={() => void handleStop()}
              loading={hasPendingSubmission}
              running={running}
              stopping={stopping}
              placeholder={tDsh('chat.inputPlaceholder')}
              sessionId={sessionId}
              onError={setError}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default WorkbenchChatPanel;
