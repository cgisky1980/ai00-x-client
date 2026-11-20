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
import { ArrowDown } from 'lucide-react';
import { AgentComposer } from '@/app/components/ai/AgentComposer';
import type { PromptSubmitIntent } from '@/component-library';
import {
  connectMux,
  createDshRequestId,
  dshApproval,
  dshQuestion,
  dshSession,
  extractSubagentCatalog,
  foldEvents,
  subagentInterrupt,
  type DshApproval,
  type DshLiveAssistant,
  type DshMessage,
  type DshMuxConnection,
  type DshMuxFrame,
  type DshQuestion,
  type DshQuestionAnswerItem,
  type DshQueueItem,
  type DshSessionEvent,
  type DshToolCallView,
} from '@/infrastructure/api/service-api/DshAPI';
import { isApprovalAllowed } from '@/shared/agent-approval-rules';
import { emitBusEvent, onBusEvent } from '@/infrastructure/plugins/runtime';
import {
  ensureWorkbenchSession,
  forgetBoundSession,
  type WorkbenchOpenSessionIntent,
} from '@/infrastructure/plugins/workbenchSession';
import { ToolCallTracker, type ScopeViolation } from '@/infrastructure/plugins/workbenchScope';
import type { WorkbenchEntry } from '@/infrastructure/plugins/workbenchRegistry';
import { useWorkbenchTaskStore, type WorkbenchChildAgent } from '../tasks/workbenchTaskStore';
import { ApprovalCard, ChatErrorText, MessageBubble, QuestionCard } from '../dsh/DshChatPieces';
import { Markdown } from '@/component-library';
import { groupMessagesForDisplay } from '../dsh/messageGroups';
import { WorkbenchQueueDock, type QueueDockRow } from './WorkbenchQueueDock';
import { ComposerInteraction } from './ComposerInteraction';
import { WorkbenchPlanRail } from './WorkbenchPlanRail';
import { WorkbenchPlanSummary } from './WorkbenchPlanSummary';
import { WorkbenchTaskCards } from './WorkbenchTaskCards';
import { WorkbenchTurnUsage } from './WorkbenchTurnUsage';
import { WorkbenchSubagentCard } from './WorkbenchSubagentCard';
import { WorkbenchSubagentOverview } from './WorkbenchSubagentOverview';
import { isSubagentDispatch } from './subagentTools';
import { parsePlanSteps } from '@/tools/todo/utils/planStructure';
import { DELEGATE_BOOK_TITLE } from '@/agent/orchestrator/promptParts';
import {
  getSessionUsage,
  resolveRemoteCredits,
  type AiUsageSplit,
} from '@/infrastructure/api/service-api/AiUsageAPI';
// 消息/输入区样式类复用策场景（__msg* / __composer 等 BEM 平级类）
import '../dsh/DshScene.scss';
import './WorkbenchDelegating.scss';

/** 稳定空数组：避免 zustand selector 每次返回新引用导致重渲染。 */
const EMPTY_CHILDREN: WorkbenchChildAgent[] = [];

/** 回合无任何新事件多久后提示「可能卡住」（实测模型侧会静默数分钟）。 */
const STALL_NOTICE_MS = 120_000;

/** 子代理已运行时长（`3m 20s` / `45s`）。 */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/**
 * 内部任务书抬头：只作引擎输入，绝不能当人话渲染。
 *
 * 判据引用 `DELEGATE_BOOK_TITLE`——曾经写死中文抬头，抬头改成 `TASK BRIEF` 后
 * 匹配失效，内部任务书（[GOAL] + 运行规约）整段漏进对话区冒充用户发言。
 * 旧会话保留中文抬头以兼容历史。
 */
const TASK_BRIEF_MARKERS = [DELEGATE_BOOK_TITLE, '════ 任务书 ════'];

function isTaskBrief(text: string): boolean {
  return TASK_BRIEF_MARKERS.some((marker) => text.includes(marker));
}

interface WorkbenchChatPanelProps {
  /** 当前插件工作台；纯外部会话宿主时为空（此时不建立任何工程绑定）。 */
  entry?: WorkbenchEntry;
  /** 插件页挂载失败：AI 区显示不可用状态，不建立任何会话。 */
  pluginUnavailable?: boolean;
  /**
   * 外部会话绑定（策看板「在工作台继续」投递）：优先于 `workbench:active-project`
   * 的工程绑定；只读展示 cwd，不建会话、不改 cwd。
   */
  externalSession?: WorkbenchOpenSessionIntent | null;
  /** 退出外部会话：回到当前工程的会话绑定。 */
  onExitExternalSession?: () => void;
  /**
   * 运行态上报（可选）：会话此刻是否在跑 / 是否出错。工作台默认任务场景用它
   * 把状态递给看板（看板只读，不复用 TodoOverlay 的轮询）。
   */
  onRuntimeChange?: (runtime: { running: boolean; failed: boolean; asking: boolean }) => void;
  /** 默认 panel=插件右侧栏；conversation=任务主对话区（隐藏通用头部）。 */
  variant?: 'panel' | 'conversation';
  /** 展示层把首轮内部编排任务书替换为用户的原始需求，不改引擎历史。 */
  initialRequest?: string;
  /**
   * 输入框上方是否显示工作区行（目录 + 分支）。
   * 项目工作台里项目名与分支已在头部/侧栏常驻，这里默认关掉避免重复。
   */
  showWorkspace?: boolean;
  /**
   * 宿主提供的交互档位（如交付验收）。
   * 优先级低于引擎自带的「提问 / 审批」，但高于工作区行——人类介入永远贴着输入框。
   */
  dock?: React.ReactNode;
  /** 计划书（有就常驻输入框上方的计划条；不限项目/任务场景）。 */
  planMd?: string | null;
  /** 计划条是否自动展开（有评审/验收动作时）。 */
  planAutoOpen?: boolean;
  /** 任务已完成：计划条不标「进行中」。 */
  planFinished?: boolean;
  /**
   * 计划书是否已被人类确认。传 `false` 且已有计划书、agent 空闲时，
   * 输入框上方升起「计划确认」档位——执行前必须过一次人类确认。
   */
  planApproved?: boolean;
  /** 计划确认结果（宿主持久化到任务卡）。 */
  onPlanApprove?: () => void;
  /**
   * agent 已提交自检（`agentCompletedAt`）。步骤全通过但它没提交时，
   * 这里给一条「让它提交自检」的入口——否则流程会在汇总前断掉。
   */
  agentSelfChecked?: boolean;
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
  externalSession = null,
  onExitExternalSession,
  onRuntimeChange,
  variant = 'panel',
  initialRequest,
  showWorkspace = true,
  dock,
  planMd,
  planAutoOpen = false,
  planFinished = false,
  planApproved,
  onPlanApprove,
  agentSelfChecked = false,
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
  /** 内部任务书只作引擎输入；任务主对话里展示用户真正写下的需求。 */
  const transcriptMessages = useMemo(() => {
    const briefIndex = messages.findIndex(
      (message) => message.role === 'user' && isTaskBrief(message.text),
    );
    if (briefIndex < 0) return messages;
    // 没有可替换的真实需求时，内部任务书（含 [GOAL]/运行规约）不能进对话区
    if (!initialRequest) {
      return messages.filter((_, index) => index !== briefIndex);
    }
    return messages.map((message, index) =>
      index === briefIndex ? { ...message, text: initialRequest } : message,
    );
  }, [initialRequest, messages]);
  /** 展示用消息：逐条落盘的助手消息按回合合并成一个气泡（Trae 形态）。 */
  const displayMessages = useMemo(
    () => groupMessagesForDisplay(transcriptMessages),
    [transcriptMessages],
  );

  /** 本轮消耗（本地 token / 云端积分，来自网关账本 + 服务端账单）。 */
  const [turnUsage, setTurnUsage] = useState<{
    local: AiUsageSplit;
    remote: AiUsageSplit;
    remoteCredits: number | null;
  } | null>(null);
  /** 本轮起点（毫秒）：优先取 durable turn/start，新提交时用本端时间兜底。 */
  const [turnStartMs, setTurnStartMs] = useState<number | null>(null);
  const usageSessionId = bound?.sessionId ?? externalSession?.sessionId ?? null;
  /** 正在跑的子代理（子会话）数量：主代理回合一结束不等于任务停下。 */
  const delegatedCount = useWorkbenchTaskStore((s) =>
    usageSessionId ? (s.delegating[usageSessionId] ?? 0) : 0,
  );
  /** 本会话的子代理活动（对话流里展示）。 */
  const childAgents = useWorkbenchTaskStore((s) =>
    usageSessionId ? (s.children[usageSessionId] ?? EMPTY_CHILDREN) : EMPTY_CHILDREN,
  );
  /** 运行中的子代理：停止必须一并取消它们（消息流里不再重复展示）。 */
  const runningChildAgents = childAgents.filter(agent => agent.running);
  /** worker 派发 → 子代理内联卡；其余工具走默认工具卡。 */
  const renderToolCall = (call: DshToolCallView): React.ReactNode => {
    if (!usageSessionId || !isSubagentDispatch(call)) return null;
    return <WorkbenchSubagentCard call={call} parentSessionId={usageSessionId} />;
  };
  /** 子代理来源记录的人类可读名（catalog label，兜底短 id 由 MessageBubble 处理）。 */
  const resolveOriginLabel = (id: string): string | null => {
    const rows = useWorkbenchTaskStore.getState().subagentCatalog[usageSessionId ?? ''] ?? [];
    return rows.find(row => row.id === id)?.label ?? null;
  };

  const eventsRef = useRef<DshSessionEvent[]>([]);
  const trackerRef = useRef(new ToolCallTracker());
  /** 当前绑定会话（mux 回调闭包里读最新值用）。 */
  const boundRef = useRef<BoundState | null>(null);
  boundRef.current = bound;
  const projectRef = useRef<ActiveProject | null>(null);
  projectRef.current = project;
  /** 外部会话（非空时压制工程绑定：外部绑定优先）。 */
  const externalRef = useRef<WorkbenchOpenSessionIntent | null>(null);
  externalRef.current = externalSession;
  /** 外部会话占用期间收到的 active-project：退出外部会话后据此恢复工程绑定。 */
  const pendingProjectRef = useRef<ActiveProject | null>(null);
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

  /** 主回合运行：断线判定、停滞检测、插话资格只看它。 */
  const turnRunning = agentRunning || awaitingAgent || Boolean(live?.active);
  /** 任务级运行：主回合或仍有子代理在跑——输入框/头部/状态卡/运行态上报用它。 */
  const taskRunning = turnRunning || delegatedCount > 0;
  const running = turnRunning; // 既有消费方（队列、停滞、重试）保持主回合语义
  runningRef.current = running;
  hostInboxRef.current = hostInbox;

  // 运行态上报（可选）：仅上报真实变化，避免每帧重渲染宿主
  const onRuntimeChangeRef = useRef(onRuntimeChange);
  onRuntimeChangeRef.current = onRuntimeChange;
  const lastRuntimeRef = useRef<string>('');
  useEffect(() => {
    if (!onRuntimeChangeRef.current) return;
    // 任务级：子代理仍在跑时任务不能报「已停止」，否则看板会误判
    const effectiveRunning = taskRunning;
    // 仍在推进（主回合或子代理任一在跑）时，回合级报错不升级为任务级「出错」——
    // 否则父回合刚报错、子代理还在跑的任务会在看板上闪「出错」。
    const failed = Boolean(error) && !effectiveRunning;
    const asking = questions.length > 0;
    const key = `${effectiveRunning ? 1 : 0}${failed ? 1 : 0}${asking ? 1 : 0}`;
    if (key === lastRuntimeRef.current) return;
    lastRuntimeRef.current = key;
    onRuntimeChangeRef.current({ running: effectiveRunning, failed, asking });
  }, [taskRunning, error, questions.length]);

  /** 已结算过的「回合起点 + 子会话集合」键：同键不重复结算，换键则替换结果。 */
  const settledKeyRef = useRef<string | null>(null);
  /** 本轮派发的子会话（排序后作为结算键的一部分，顺序不影响取值）。 */
  const childSessionIds = useMemo(
    () => childAgents.map(child => child.sessionId).filter(Boolean).sort(),
    [childAgents],
  );
  const settlementKey =
    turnStartMs !== null ? `${turnStartMs}|${childSessionIds.join(',')}` : null;

  // 本轮消耗：起点取 durable turn/start（重启后仍能恢复）；主回合与子代理全部
  // 收口后按「起点 + 子会话集合」替换式重算，换轮次/换子会话都不混算。
  useEffect(() => {
    if (!usageSessionId || turnStartMs === null || !settlementKey) return undefined;
    // 主回合或子代理仍在跑：等全部收口再结算，避免漏掉子会话扣费
    if (taskRunning) return undefined;
    if (settledKeyRef.current === settlementKey) return undefined;
    settledKeyRef.current = settlementKey;
    let cancelled = false;
    void getSessionUsage(usageSessionId, turnStartMs, childSessionIds)
      .then(async (usage) => {
        if (cancelled) return;
        // 云端只给积分：用本轮远端请求 id 去服务端会话账单核对（异步结算，内部会重试）
        setTurnUsage({ local: usage.local, remote: usage.remote, remoteCredits: null });
        const credits = await resolveRemoteCredits({
          sessionId: usageSessionId,
          childSessionIds,
          requestIds: usage.remoteRequestIds,
          sinceMs: turnStartMs,
        });
        if (!cancelled) {
          setTurnUsage({ local: usage.local, remote: usage.remote, remoteCredits: credits });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [usageSessionId, turnStartMs, settlementKey, childSessionIds, taskRunning]);

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
      if (!entry) return; // 纯外部会话宿主：不建立工程绑定
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
      // 外部会话占用 AI 区：先记账不抢绑定（退出外部会话时再恢复）
      if (externalRef.current) {
        pendingProjectRef.current = { projectId: payload.projectId, title: payload.title };
        return;
      }
      if (projectRef.current?.projectId === payload.projectId && boundRef.current) return;
      bindProject(payload.projectId, payload.title);
    });
    return off;
  }, [bindProject]);

  /** 外部会话绑定：直接用给定会话 id，不建会话、不改 cwd（P1 边界）。
   * 优先于工程绑定；cwd 缺失时用 session/list 只读反查（仍未拿到就置空，
   * 只是少了越界校验的基准，不影响对话与审批）。
   */
  const externalSessionId = externalSession?.sessionId ?? null;
  const externalSessionCwd = externalSession?.cwd ?? null;
  useEffect(() => {
    if (!externalSessionId) return;
    bindTokenRef.current += 1; // 作废进行中的工程绑定
    setProject(null);
    setBinding(false);
    setBindError(null);
    setBound({ sessionId: externalSessionId, cwd: externalSessionCwd ?? '' });
  }, [externalSessionId, externalSessionCwd]);

  useEffect(() => {
    if (!externalSessionId || externalSessionCwd) return undefined;
    const target = externalSessionId;
    let cancelled = false;
    void dshSession
      .list()
      .then(({ items }) => {
        const cwd = items.find((it) => it.sessionId === target)?.cwd;
        if (cancelled || !cwd) return;
        setBound(prev => (prev?.sessionId === target ? { ...prev, cwd } : prev));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [externalSessionId, externalSessionCwd]);

  // 退出外部会话 → 清空绑定，若期间有工程上报则恢复工程绑定
  const hadExternalRef = useRef(false);
  useEffect(() => {
    if (externalSessionId) {
      hadExternalRef.current = true;
      return;
    }
    if (!hadExternalRef.current) return;
    hadExternalRef.current = false;
    setBound(null);
    const pending = pendingProjectRef.current;
    pendingProjectRef.current = null;
    if (pending) bindProject(pending.projectId, pending.title);
  }, [externalSessionId, bindProject]);

  // 插件删除工程 → 只移除绑定并清空面板（不删引擎历史，会话可另行在会话列表查看）
  useEffect(() => {
    const off = onBusEvent('workbench:project-removed', (data) => {
      const payload = data as { projectId?: string } | undefined;
      const removed = payload?.projectId;
      if (!removed) return;
      if (entry) forgetBoundSession(entry.id, removed);
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
  }, [entry]);

  const reloadBaseline = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const { events } = await dshSession.history(sessionId);
      eventsRef.current = events.map(e => e.event);
      const folded = foldEvents(eventsRef.current);
      setMessages(folded);
      // 本轮起点：最近一次 durable turn/start（重启后据此恢复消耗；无历史为 null）
      const lastTurnStart = (() => {
        for (let i = eventsRef.current.length - 1; i >= 0; i -= 1) {
          const event = eventsRef.current[i];
          if (event.type === 'turn/start' && typeof event.time === 'number') return event.time;
        }
        return null;
      })();
      setTurnStartMs(lastTurnStart);
      // 子代理目录兜底：投影可能还没到（首帧/重启），durable 事件先对齐 label
      useWorkbenchTaskStore
        .getState()
        .seedSubagentCatalog(sessionId, extractSubagentCatalog(eventsRef.current));
      // 对账：已落盘的用户消息退休对应的本地即时气泡（按 rpcId 优先，文本兜底）
      const rpcIds = new Set(
        folded.filter(m => m.role === 'user' && m.rpcId).map(m => m.rpcId as string),
      );
      // 子代理 relay 记录也是 role=user，但不代表人类提交，不能参与文本对账
      const userTexts = new Set(
        folded.filter(m => m.role === 'user' && !m.origin).map(m => m.text.trim()),
      );
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
    // 本轮消耗按会话隔离：起点与结算键都随绑定清空（模块级 ref 不会自动清）
    setTurnStartMs(null);
    setTurnUsage(null);
    settledKeyRef.current = null;
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
      // 子代理投影（控制流按会话广播）：父会话的 subagentCatalog 提供 label，
      // 子会话的 subagentTiming 提供 durable 耗时——不在本会话也要收。
      if (frame.type === 'session/projection') {
        useWorkbenchTaskStore
          .getState()
          .applySubagentProjection(frame.sessionId, frame.key, frame.value);
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
      // 子代理派发记录：durable 副本先落 store（投影到达后同值覆盖）
      if (event.type === 'subagent/catalog') {
        useWorkbenchTaskStore.getState().seedSubagentCatalog(sessionId, extractSubagentCatalog([event]));
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

  // —— 模型侧停滞提示：回合在跑但长时间没有任何新事件 ——
  // 实测：编排者读完计划后会「思考中」5 分钟无 token、无工具、无超时，界面像卡死。
  // 这里只做提示与出口（停止 / 重试上一条），不自动打断模型。
  const [stallMs, setStallMs] = useState(0);
  const lastActivityRef = useRef(Date.now());
  useEffect(() => {
    lastActivityRef.current = Date.now();
    setStallMs(0);
  }, [messages, live]);
  useEffect(() => {
    if (!running) {
      setStallMs(0);
      return undefined;
    }
    const timer = window.setInterval(() => {
      setStallMs(Date.now() - lastActivityRef.current);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const stalled = running && stallMs >= STALL_NOTICE_MS;
  /** 重试用的上一条用户消息（没有就发一句「继续」）。 */
  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === 'user' && message.text.trim()) return message.text.trim();
    }
    return '';
  }, [messages]);

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
      // 只有主回合运行时才可能插话；子代理单独运行只能排队
      const mode: 'queue' | 'steer' = turnRunning && intent === 'steer' ? 'steer' : 'queue';
      const placement: SubmissionPlacement = taskRunning
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
        // 本轮起点：已有 durable 起点就不覆盖，否则先用本端时间兜底
        setTurnStartMs(prev => prev ?? Date.now());
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
    [sessionId, binding, turnRunning, taskRunning, scrollToBottom, refreshQueueSnapshot],
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
    // 停止覆盖整个任务：主回合 + 仍在跑的子代理（子代理有自己的回合，不取消会继续烧）
    const children = runningChildAgents.map(agent => agent.sessionId);
    const results = await Promise.allSettled([
      ...(turnRunning ? [dshSession.cancel(sessionId)] : []),
      ...children.map(childId => subagentInterrupt(sessionId, childId)),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) {
      clearStopping();
      setError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
      return;
    }
    // 只取消当前回合：inbox 里的排队项由 Host 继续调度
    void refreshRunning();
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
  // （外部会话不依赖插件页：仍可对话与应答审批）
  if (pluginUnavailable && !externalSession) {
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

  /** 对话区就绪：外部会话只需会话 id；工程绑定还需完成绑定且无错误。 */
  const chatReady =
    Boolean(bound) && (externalSession ? true : Boolean(project) && !binding && !bindError);

  /**
   * 输入框上的交互档位（同一时刻只一个，优先级：提问 > 审批/计划评审 > 宿主档位）。
   * 人类介入一律贴着输入框，消息流只留事实。
   *
   * 计划评审正文：优先取本轮 exit_plan_mode 工具调用的 plan 参数，
   * 没有就退回任务计划文件——两者都没有时评审卡只剩标题。
   */
  const planReviewText = ((): string | undefined => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      for (const tc of messages[i].toolCalls) {
        if (tc.name !== 'exit_plan_mode') continue;
        try {
          const args = JSON.parse(tc.arguments) as { plan?: unknown };
          if (typeof args?.plan === 'string' && args.plan.trim()) return args.plan;
        } catch {
          // 参数不是 JSON：退回计划文件
        }
      }
    }
    return planMd && planMd.trim() ? planMd : undefined;
  })();

  const pendingQuestion = questions[0];
  const pendingApproval = approvals[0];
  /** 计划确认卡的结构化步骤（旧计划为空 → 回落整篇 Markdown）。 */
  const confirmSteps = parsePlanSteps(planMd ?? null);
  /** 正在做计划评审（exit_plan_mode）：此时背卡直接摊开计划，不再显示计划条。 */
  const planReviewing = pendingApproval?.toolName === 'exit_plan_mode';
  /**
   * 计划确认门禁：计划书已写好、还没被人类确认。
   *
   * 这是「计划 → 执行」之间唯一的人工闸口，所以**不跟运行态挂钩**——agent
   * 收尾慢或运行态上报滞后（5s 轮询）时，按钮也必须立刻可见；此时批准消息
   * 进队列，由输入框上方的队列条显示，不会丢。
   */
  const planAwaitingConfirm =
    planApproved === false &&
    Boolean(planMd && planMd.trim()) &&
    !planFinished &&
    !pendingQuestion &&
    !pendingApproval;
  const planConfirmDock = planAwaitingConfirm ? (
    <ComposerInteraction
      tone="warning"
      actions={[
        {
          label: t('nav.workbenchWindow.progress.approvePlan'),
          variant: 'primary',
          onClick: () => {
            onPlanApprove?.();
            submitText(t('nav.workbenchWindow.progress.approvePlanMessage'));
          },
        },
      ]}
    >
      <div className="ai00-x-plan-confirm">
        {confirmSteps.length > 0 ? (
          <>
            <WorkbenchPlanSummary
              steps={confirmSteps}
              planMd={planMd ?? null}
              running={agentRunning}
              pendingApproval
              taskCompleted={planFinished}
            />
            <WorkbenchTaskCards planMd={planMd ?? null} steps={confirmSteps} compact readOnly />
          </>
        ) : (
          <Markdown
            content={(planMd ?? '').replace(/^- \[x\] /gm, '✓ ').replace(/^- \[ \] /gm, '□ ')}
          />
        )}
      </div>
      <p className="ai00-x-plan-confirm__hint">
        {agentRunning
          ? t('nav.workbenchWindow.progress.planConfirmRunningHint')
          : t('nav.workbenchWindow.progress.planConfirmHint')}
      </p>
    </ComposerInteraction>
  ) : undefined;

  /**
   * 汇总断路兜底：步骤全部通过、agent 也停了，但它没调 ai00_task_complete
   * → 验收卡永远不会出现。这里给一个「让它提交自检」的按钮。
   */
  const stepsAllDone = confirmSteps.length > 0 && confirmSteps.every(step => step.done);
  const selfCheckNudge =
    !planFinished &&
    planApproved !== false &&
    !agentSelfChecked &&
    !agentRunning &&
    stepsAllDone &&
    !pendingQuestion &&
    !pendingApproval;
  const selfCheckDock = selfCheckNudge ? (
    <ComposerInteraction
      tone="accent"
      actions={[
        {
          label: t('nav.workbenchWindow.progress.nudgeSelfCheckAction'),
          variant: 'primary',
          onClick: () => submitText(t('nav.workbenchWindow.progress.nudgeSelfCheckMessage')),
        },
      ]}
    >
      <p className="ai00-x-plan-confirm__hint">
        {t('nav.workbenchWindow.progress.nudgeSelfCheck')}
      </p>
    </ComposerInteraction>
  ) : undefined;

  const interactionDock = pendingQuestion ? (
    <ComposerInteraction
      tone="warning"
      meta={questions.length > 1 ? `${questions.length}` : undefined}
    >
      <QuestionCard
        batch={pendingQuestion}
        onRespond={respondQuestion}
        onCancel={cancelQuestion}
      />
    </ComposerInteraction>
  ) : pendingApproval ? (
    <ComposerInteraction
      tone={planReviewing ? 'warning' : 'accent'}
      meta={approvals.length > 1 ? `${approvals.length}` : undefined}
    >
      <ApprovalCard
        approval={pendingApproval}
        planText={planReviewing ? planReviewText : undefined}
        onRespond={(rpcId, outcome) => void respondApproval(rpcId, outcome)}
      />
    </ComposerInteraction>
  ) : planConfirmDock ?? selfCheckDock ?? (
    dock
  );

  /**
   * 任务状态卡：计划进度（主行）+ 本轮消耗（辅行）同一张卡。
   * 子代理运行态只在对话顶部汇总条表达，这里不重复。
   * 两者皆无时 `WorkbenchPlanRail` 自己返回 null，快速问答不会出现空卡。
   */
  const statusCard =
    planMd !== undefined || turnUsage ? (
      <WorkbenchPlanRail
        planMd={planMd}
        autoOpen={planAutoOpen}
        finished={planFinished}
        running={taskRunning}
        {...(turnUsage
          ? {
              usage: (
                <WorkbenchTurnUsage
                  local={turnUsage.local}
                  remote={turnUsage.remote}
                  remoteCredits={turnUsage.remoteCredits}
                />
              ),
            }
          : {})}
      />
    ) : null;

  /**
   * 背卡内容：计划评审/确认时只摊计划书；其余时间常驻任务状态卡，交互卡需要人类动手时升起。
   */
  const composerDock =
    !planReviewing && !planAwaitingConfirm ? (
      <>
        {statusCard}
        {interactionDock}
      </>
    ) : (
      interactionDock
    );

  return (
    <div
      className={`ai00-x-workbench-chat${variant === 'conversation' ? ' ai00-x-workbench-chat--conversation' : ''}`}
    >
      {variant === 'panel' && (
      <div className="ai00-x-workbench-chat__head">
        <span className={`ai00-x-workbench-chat__dot${taskRunning ? ' is-running' : ''}`} />
        <span className="ai00-x-workbench-chat__title">{t('nav.workbenchScene.chat.title')}</span>
        {externalSession ? (
          <>
            <span
              className="ai00-x-workbench-chat__project"
              title={bound?.cwd || externalSession.cwd || undefined}
            >
              {externalSession.title || externalSession.sessionId.slice(0, 8)}
            </span>
            {onExitExternalSession && (
              <button
                type="button"
                className="ai00-x-workbench-chat__exit"
                onClick={onExitExternalSession}
              >
                {t('nav.workbenchScene.chat.exitExternal')}
              </button>
            )}
          </>
        ) : (
          project && (
            <span className="ai00-x-workbench-chat__project" title={bound?.cwd}>
              {project.title || project.projectId}
            </span>
          )
        )}
      </div>
      )}

      {!externalSession && !project && (
        <div className="ai00-x-workbench-chat__empty">
          {t('nav.workbenchScene.chat.noProject')}
        </div>
      )}
      {!externalSession && project && binding && (
        <div className="ai00-x-workbench-chat__empty">
          {t('nav.workbenchScene.chat.binding')}
        </div>
      )}
      {!externalSession && project && !binding && bindError && (
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

      {chatReady && (
        <>
          {/* 子代理汇总：常驻在消息流之上，解决「任务一长就找不到子代理」 */}
          {usageSessionId && (
            <div className="ai00-x-workbench-chat__subagents-head">
              <WorkbenchSubagentOverview parentSessionId={usageSessionId} />
            </div>
          )}
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
                {(entry?.starterPrompts?.length ?? 0) > 0 && (
                  <div className="ai00-x-workbench-chat__starters">
                    {entry?.starterPrompts?.map(prompt => (
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
              <MessageBubble
                key={m.id}
                message={m}
                renderToolCall={renderToolCall}
                resolveOriginLabel={resolveOriginLabel}
                showUsage={false}
              />
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
                <div className="ai00-x-dsh-scene__msg-body">
                  <div className="ai00-x-workbench-chat__pending" role="status" aria-live="polite">
                    <span className="ai00-x-workbench-chat__pending-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span>
                      {stopping ? tDsh('chat.stopping') : tDsh('chat.thinking')}
                      {stallMs > 0 && ` · ${formatElapsed(stallMs)}`}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {/* 长时间无任何事件：显示已等待时长并给出出口，避免看起来像卡死 */}
            {stalled && (
              <div className="ai00-x-workbench-chat__stall" role="status" aria-live="polite">
                <span className="ai00-x-workbench-chat__stall-text">
                  {t('nav.workbenchWindow.progress.stall', { time: formatElapsed(stallMs) })}
                </span>
                <span className="ai00-x-workbench-chat__stall-actions">
                  <button
                    type="button"
                    className="ai00-x-workbench-chat__stall-btn"
                    onClick={() => void handleStop()}
                  >
                    {t('nav.workbenchWindow.progress.stallStop')}
                  </button>
                  <button
                    type="button"
                    className="ai00-x-workbench-chat__stall-btn is-primary"
                    onClick={() =>
                      submitText(
                        lastUserText || t('nav.workbenchWindow.progress.stallContinue'),
                        'queue',
                      )
                    }
                  >
                    {t('nav.workbenchWindow.progress.stallRetry')}
                  </button>
                </span>
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

          <div className="ai00-x-dsh-scene__composer">
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
            {composerDock && (
              <div
                className={`ai00-x-composer-stack__under${
                  interactionDock ? ' is-raised' : ''
                }`}
              >
                {composerDock}
              </div>
            )}
            <AgentComposer
              value={draft}
              onChange={setDraft}
              onSubmit={handleSend}
              onStop={() => void handleStop()}
              loading={hasPendingSubmission}
              running={taskRunning}
              steering={turnRunning}
              stopping={stopping}
              placeholder={tDsh('chat.inputPlaceholder')}
              sessionId={sessionId}
              mentionRoot={bound?.cwd || externalSession?.cwd || undefined}
              onError={setError}
              workspace={
                showWorkspace && (bound?.cwd || externalSession?.cwd)
                  ? { dir: (bound?.cwd || externalSession?.cwd) as string }
                  : undefined
              }
            />
          </div>
        </>
      )}
    </div>
  );
};

export default WorkbenchChatPanel;
