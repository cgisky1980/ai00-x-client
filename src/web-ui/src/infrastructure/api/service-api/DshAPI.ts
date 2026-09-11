/**
 * DshAPI — dsh 引擎（sidecar, 127.0.0.1:3210）的前端客户端。
 *
 * 0.1.5 协议（dsh 0.1.5-rc.2）：
 * 我们自己的 UI 经内嵌服务器（2100）的同源反向代理访问 dsh：
 * - unary RPC：POST /dsh-api/<endpoint>（endpoint 斜杠路径如 session/list、
 *   $events/result；信封 {type:'client-request', rpcId, method, payload:{args}}，
 *   响应 {type:'server-response', rpcId, result:{ok, value|error}}）
 * - 事件流：WS /dsh-ws/remote.mux（dsh_proxy 双向泵到引擎 /api/remote.mux）。
 *   流复用协议：上行 {type:'open', streamId, endpoint, payload:{args}} /
 *   {type:'cancel', streamId}，下行 {type:'item', streamId, value?} /
 *   {type:'error'|'end', streamId}。本文件用三条逻辑流拼出旧版 events.mux 语义：
 *     · $events        —— 元事件流：ready 帧 + waterfall（approval/request、
 *       user-questions/request）+ emit + cancel；应答走 $events/result RPC
 *     · session/control —— 全局控制流：baseline + queue/jobs/projection 帧
 *     · session/follow  —— 每会话一条：snapshot（含 cursor）+ event 增量
 * - 会话历史：session/page（throughSeq = follow 快照的 cursor，-1 是空页不是
 *   「最新」）；模型目录：session/modelCatalog（当前选择从投影 modelSelection 取）。
 * - approval/question 应答：$events 的 waterfall 帧（{type:'waterfall', event,
 *   eventId, agentId, request}）→ POST $events/result {clientId, eventId,
 *   outcome}（outcome: {kind:'result', value} / {kind:'rejected', error} /
 *   {kind:'next'}；旧 /api/respond 已在 0.1.5 删除）。agentId 即 sessionId。
 *   为什么必须代理：0.1.5 引擎是「签名 cookie + Host/Origin 栅栏」双重门，
 *   cookie 由 Rust 侧从 stdout 启动 token 换取并注入代理转发；webview 页面
 *   origin 是 2100，直连 3210 会被 403。
 * - 引擎生命周期：Tauri 命令 dsh_status / dsh_ensure_ready / dsh_stop
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

/** dsh 代理基址（同源：内嵌 Salvo 2100 的 /dsh-api 反向代理；dev 下显式指向 2100）。 */
const DSH_BASE = import.meta.env.DEV ? 'http://127.0.0.1:2100/dsh-api' : '/dsh-api';

// ---------------------------------------------------------------------------
// 类型（对齐 UI 所需子集；内部 wire 类型见下方各 interface）
// ---------------------------------------------------------------------------

export interface DshPhase {
  phase:
    | 'not-ready'
    | 'installing'
    | 'ready'
    | 'running'
    | 'failed';
  stage?: string;
  error?: string;
}

export interface DshStatus {
  phase: DshPhase;
  nodeVersion: string | null;
  dshVersion: string | null;
  port: number | null;
  environmentReady: boolean;
}

export interface DshSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  agentPreset?: string;
  parentSessionId?: string;
  /** 投影 hints：title（会话标题）、modelSelection 等 UI 派生值（可能缺失）。 */
  projections?: {
    asOfSeq: number;
    values?: {
      title?: string | null;
      modelSelection?: DshModelSelectionProjection;
      [key: string]: unknown;
    };
  };
}

/** 会话事件（SessionWireEvent 子集；ignorable 的 assistant/chunk 也走这里）。 */
export interface DshSessionEvent {
  type: string;
  seq: number;
  time?: number;
  data?: unknown;
}

export interface DshHistoryEntry {
  event: DshSessionEvent;
  view?: unknown;
}

export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** 会话投影里的模型选择 fold（next 优先于 lastUsed）。 */
interface DshModelSelectionProjection {
  lastUsed?: DshModelSelection | null;
  next?: DshModelSelection | null;
}

/** 可选模型（DeepSeek 系带推理档位）。 */
export interface DshModelInfo {
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    efforts: Array<{ id: string; name: string }>;
    defaultEffort: string;
  };
}

export interface DshSessionModels {
  current: DshModelSelection;
  routable: boolean;
  groups: Array<{
    id: string;
    name: string;
    models: DshModelInfo[];
  }>;
  failures: Array<{ id: string; message: string }>;
}

/** session/modelCatalog 的 wire 形状（current 不在目录里，按会话投影另取）。 */
interface WireModelCatalog {
  default: DshModelSelection;
  routableProviders: string[];
  groups: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      name: string;
      description?: string;
      reasoning?: {
        efforts: Array<{ id: string; name: string }>;
        defaultEffort?: string;
      };
    }>;
  }>;
  failures: Array<{ id: string; name: string; message: string }>;
}

/** WS mux 下行帧（适配层产出的旧 events.mux 语义，UI 零改动）。 */
export type DshMuxFrame =
  | { type: 'session/event'; sessionId: string; event: DshSessionEvent; view?: unknown }
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  /** 后台任务注册表快照（来自 session/control 流的 jobs 帧 / baseline） */
  | {
      type: 'session/jobs';
      sessionId?: string;
      jobs: Array<{
        id: string;
        kind?: string;
        label?: string;
        status: string;
        startedAt?: number;
        finishedAt?: number;
      }>;
    }
  /** 投影单元更新（key: subagent/subagentTiming/title 等） */
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  | {
      type: 'approval/requested';
      sessionId: string;
      approvalId: string;
      toolName: string;
      callId?: string;
      reason?: string;
    }
  | { type: 'approval/resolved'; sessionId: string; approvalId: string; outcome: string }
  | { type: 'question/requested'; sessionId: string; questions: DshQuestionItem[] }
  | {
      type: 'question/resolved';
      sessionId: string;
      questionRpcId: string;
      outcome: 'answered' | 'cancelled';
    }
  | { type: 'stream/error'; error: { code: string; message: string } };

/** 待处理审批（UI 模型；rpcId 用于回显响应）。 */
export interface DshApproval {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

/** ask_user_question 的一个问题（dsh-user-questions 契约子集）。 */
export interface DshQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** 待处理问题批次（一次 ask 的全部问题；rpcId 即问题逻辑 id）。 */
export interface DshQuestion {
  rpcId: string;
  sessionId: string;
  questions: DshQuestionItem[];
}

/** 一批问题的答案（answers 按问题顺序逐一对齐）。 */
export interface DshQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

/** 应答回执（$events/result 的 UI 层回执）。 */
export type DshRpcReceipt =
  | { accepted: true }
  | { accepted: false; reason: 'not-pending' | 'bad-response' };

// ---------------------------------------------------------------------------
// RPC 底座（0.1.5 信封：payload 必须是 {args} 对象）
// ---------------------------------------------------------------------------

let rpcSeq = 0;

function nextRpcId(): string {
  return `ui-${Date.now()}-${rpcSeq++}`;
}

interface WireRpcEnvelope<T> {
  type: string;
  rpcId: string;
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
}

async function rpc<T>(
  endpoint: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<T> {
  const res = await fetch(`${DSH_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: nextRpcId(),
      method: endpoint,
      payload: { args },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`dsh rpc ${endpoint} HTTP ${res.status}`);
  }
  const envelope = (await res.json()) as WireRpcEnvelope<T>;
  if (envelope.result.ok) {
    return envelope.result.value;
  }
  throw new Error(`${envelope.result.error.code}: ${envelope.result.error.message}`);
}

/** dsh sidecar 健康探测（引擎是否在线；0.1.5 探活端点 settings/describe）。 */
export async function dshReachable(): Promise<boolean> {
  try {
    await rpc('settings/describe', {}, 3000);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// $events waterfall 应答注册表（rpcId → clientId/eventId）+ 全连接广播
// ---------------------------------------------------------------------------

/** 一条待应答 waterfall（UI 持 rpcId 应答；映射回引擎的 clientId/eventId）。 */
interface PendingEventAnswer {
  clientId: string;
  eventId: string;
}

const pendingEventAnswers = new Map<string, PendingEventAnswer>();
/** waterfall 登记时顺带记住 sessionId（resolved 广播/取消帧用）。 */
const pendingEventSessionIds = new Map<string, string>();
/** 所有存活 mux 连接的帧回调（respond 后广播 resolved，跨消费者清卡）。 */
const muxFrameBroadcast = new Set<(frame: DshMuxFrame) => void>();
let answerSeq = 0;

function newEventRpcId(): string {
  return `ev-${Date.now()}-${answerSeq++}`;
}

/** 引擎侧应答一个 waterfall 事件。成功返回 true（not pending 等返回 false）。 */
async function postEventResult(target: PendingEventAnswer, outcome: unknown): Promise<boolean> {
  try {
    await rpc(
      '$events/result',
      { clientId: target.clientId, eventId: target.eventId, outcome },
      10_000,
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 审批/问题应答（$events/result；旧 /api/respond 已删）
// ---------------------------------------------------------------------------

export const dshApproval = {
  /**
   * 回答一个待处理审批。rpcId 必须回显 approval/requested 帧回调给的 rpcId
   * （适配层按它找到引擎的 clientId/eventId）；sessionId/approvalId 仅保持
   * 旧签名兼容，引擎侧不再使用。
   */
  respond: async (
    rpcId: string,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<DshRpcReceipt> => {
    const target = pendingEventAnswers.get(rpcId);
    if (!target) {
      return { accepted: false, reason: 'not-pending' };
    }
    const ok = await postEventResult(target, { kind: 'result', value: outcome });
    if (!ok) {
      return { accepted: false, reason: 'bad-response' };
    }
    pendingEventAnswers.delete(rpcId);
    pendingEventSessionIds.delete(rpcId);
    broadcastFrame({ type: 'approval/resolved', sessionId, approvalId, outcome });
    return { accepted: true };
  },
};

// ---------------------------------------------------------------------------
// 问题应答（$events/result，value = {answers}；取消 = rejected error）
// ---------------------------------------------------------------------------

/** 向所有存活 mux 消费者广播一帧（跨组件清 pending 卡片）。 */
function broadcastFrame(frame: DshMuxFrame): void {
  for (const emit of muxFrameBroadcast) {
    try {
      emit(frame);
    } catch {
      // 单个消费者异常不阻断其余广播
    }
  }
}

export const dshQuestion = {
  /**
   * 回答一批问题。answers 必须与 questions 数量相等且按顺序 id 对齐；
   * selected 只能是问题选项的 label；单选问题 custom 与 selected 互斥
   * （引擎侧严格校验，不匹配 = 工具失败）。
   */
  respond: async (
    rpcId: string,
    sessionId: string,
    answers: DshQuestionAnswerItem[],
  ): Promise<DshRpcReceipt> => {
    const target = pendingEventAnswers.get(rpcId);
    if (!target) {
      return { accepted: false, reason: 'not-pending' };
    }
    const ok = await postEventResult(target, { kind: 'result', value: { answers } });
    if (!ok) {
      return { accepted: false, reason: 'bad-response' };
    }
    pendingEventAnswers.delete(rpcId);
    pendingEventSessionIds.delete(rpcId);
    broadcastFrame({ type: 'question/resolved', sessionId, questionRpcId: rpcId, outcome: 'answered' });
    return { accepted: true };
  },

  /** 取消（引擎侧 waterfall rejected，agent 收到取消错误）。 */
  cancel: async (rpcId: string): Promise<DshRpcReceipt> => {
    const target = pendingEventAnswers.get(rpcId);
    if (!target) {
      return { accepted: false, reason: 'not-pending' };
    }
    const ok = await postEventResult(target, {
      kind: 'rejected',
      error: {
        name: 'Error',
        message: 'user cancelled ask_user_question',
        code: 'cancelled',
        details: {},
      },
    });
    if (!ok) {
      return { accepted: false, reason: 'bad-response' };
    }
    pendingEventAnswers.delete(rpcId);
    const sessionId = pendingEventSessionIds.get(rpcId) ?? '';
    pendingEventSessionIds.delete(rpcId);
    broadcastFrame({ type: 'question/resolved', sessionId, questionRpcId: rpcId, outcome: 'cancelled' });
    return { accepted: true };
  },
};

// ---------------------------------------------------------------------------
// 引擎生命周期（Tauri 命令 → DshManager）
// ---------------------------------------------------------------------------

/** 插件加载错误事件 payload（stderr 归因结果）。 */
export interface DshPluginErrorPayload {
  /** 从「failed to apply loader entry <module>」提取的模块名；无法归因时为 null。 */
  module: string | null;
  /** 原始 stderr 行。 */
  raw: string;
}

/** 插件 scope 授权请求事件 payload（宿主 internal API 403 归因）。 */
export interface DshPermissionRequest {
  pluginId: string;
  scope: string;
}

export const dshEngine = {
  status: () => tauriInvoke<DshStatus>('dsh_status'),
  ensureReady: () => tauriInvoke<DshStatus>('dsh_ensure_ready'),
  stop: () => tauriInvoke<DshStatus>('dsh_stop'),
  /** 手动重启（Failed 态恢复入口；Running 态幂等）。 */
  restart: () => tauriInvoke<DshStatus>('dsh_restart'),
  /** 订阅安装/运行阶段事件（返回取消函数）。 */
  onPhase: (cb: (phase: DshPhase) => void): Promise<() => void> =>
    tauriListen<DshPhase>('dsh://phase', e => cb(e.payload)),
  /** 订阅插件加载错误事件（stderr 检出 + 模块归因）。 */
  onPluginError: (cb: (payload: DshPluginErrorPayload) => void): Promise<() => void> =>
    tauriListen<DshPluginErrorPayload>('dsh://plugin-error', e => cb(e.payload)),
  /** 订阅插件 scope 授权请求（宿主 403 归因 → 授权卡）。 */
  onPermissionRequest: (cb: (payload: DshPermissionRequest) => void): Promise<() => void> =>
    tauriListen<DshPermissionRequest>('dsh://permission-requested', e => cb(e.payload)),
};

// ---------------------------------------------------------------------------
// 引擎插件管理（Typert Remote + profile manifest）
// ---------------------------------------------------------------------------

/** 引擎运行时插件条目（loader 状态快照）。 */
export interface DshPluginInventoryEntry {
  entryId: string;
  moduleName: string;
  enabled: boolean;
  fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null;
}

/** profile manifest 层的已装插件（可装卸的 bundle 级插件）。 */
export interface DshPluginManifestEntry {
  name: string;
  spec: string;
  inBundles: boolean;
  bundled: boolean;
}

/** 引擎运行时插件清单（Typert 信封：payload 是 {args:{}} 对象包装）。 */
export async function pluginInventoryList(): Promise<DshPluginInventoryEntry[]> {
  return rpc<{ entries: DshPluginInventoryEntry[] }>('pluginInventory/list').then(v => v.entries);
}

/** profile manifest 层插件管理（Tauri 命令 → DshManager）。 */
export const dshPlugins = {
  list: () => tauriInvoke<DshPluginManifestEntry[]>('dsh_plugins_list'),
  remove: (name: string) => tauriInvoke<void>('dsh_plugin_remove', { name }),
  install: (spec: string) => tauriInvoke<void>('dsh_plugin_install', { spec }),
  /** 停用/启用（bundles 数组编辑 + 引擎重启）。 */
  setEnabled: (name: string, enabled: boolean) =>
    tauriInvoke<void>('dsh_plugin_set_enabled', { name, enabled }),
  /** 插件 scope 授权（宿主 /ai00-internal/* per-plugin 权限模型 v1）。 */
  grantsList: () => tauriInvoke<Array<{ pluginId: string; scopes: string[]; bundled: boolean }>>('dsh_plugin_grants_list'),
  grant: (pluginId: string, scope: string) =>
    tauriInvoke<void>('dsh_plugin_grant', { pluginId, scope }),
  revoke: (pluginId: string, scope: string) =>
    tauriInvoke<void>('dsh_plugin_revoke', { pluginId, scope }),
};

// ---------------------------------------------------------------------------
// 会话 API（HTTP unary；history/models 由 follow cursor + 目录拼装）
// ---------------------------------------------------------------------------

/** 全局 follow 快照 cursor 缓存（history 的 throughSeq 来源）。 */
const sessionCursors = new Map<string, number>();
/** 全局 modelSelection 投影缓存（models() 的 current 来源）。 */
const sessionModelSelection = new Map<string, DshModelSelectionProjection | undefined>();
/** 等 cursor 的 waiter（新会话创建后立即拉历史时的竞态兜底）。 */
const cursorWaiters = new Map<string, Array<(cursor: number) => void>>();

function cacheProjectionValues(sessionId: string, values?: Record<string, unknown>): void {
  const sel = values?.modelSelection;
  if (sel && typeof sel === 'object') {
    sessionModelSelection.set(sessionId, sel as DshModelSelectionProjection);
  }
}

function resolveCursor(sessionId: string): Promise<number> {
  const known = sessionCursors.get(sessionId);
  if (known !== undefined) return Promise.resolve(known);
  return new Promise<number>((resolve, reject) => {
    const list = cursorWaiters.get(sessionId) ?? [];
    list.push(resolve);
    cursorWaiters.set(sessionId, list);
    setTimeout(() => {
      const waiters = cursorWaiters.get(sessionId);
      if (waiters) {
        cursorWaiters.set(sessionId, waiters.filter(w => w !== resolve));
      }
      reject(new Error('session history unavailable: engine event stream not connected'));
    }, 3000);
  });
}

function settleCursor(sessionId: string, cursor: number): void {
  sessionCursors.set(sessionId, cursor);
  const waiters = cursorWaiters.get(sessionId);
  if (waiters) {
    cursorWaiters.delete(sessionId);
    for (const w of waiters) w(cursor);
  }
}

interface WirePageRecord {
  type: string;
  event: DshSessionEvent;
}

export const dshSession = {
  // 0.1.5 typert 严格参数：list 的 wire 参数名是 _request（其余 session 系是 request）
  list: () =>
    rpc<{ items: DshSessionSummary[] }>('session/list', { _request: {} }).then(({ items }) => {
      for (const s of items) {
        cacheProjectionValues(s.sessionId, s.projections?.values);
      }
      return { items };
    }),

  create: (opts?: { cwd?: string; agentPreset?: string }) =>
    rpc<{ sessionId: string; agentPreset?: string }>('session/create', {
      request: {
        // cwd/agentPreset 可选：空值必须省略字段（引擎会对 '' 做 mkdir 报 ENOENT）
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        ...(opts?.agentPreset ? { agentPreset: opts.agentPreset } : {}),
      },
    }),

  prompt: (sessionId: string, text: string) =>
    rpc<{ accepted: true }>('session/prompt', {
      request: {
        // 0.1.5 起必填：客户端铸造的 prompt 关联 id（乐观回执对账用）
        requestId: nextRpcId(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
    }),

  cancel: (sessionId: string) =>
    rpc<{ accepted: true }>('session/cancel', { request: { sessionId } }),

  /** 全量历史：session/page，throughSeq = follow 快照 cursor（-1 是空页）。 */
  history: async (sessionId: string) => {
    const throughSeq = await resolveCursor(sessionId);
    const page = await rpc<{ records: WirePageRecord[]; hasMore: boolean }>('session/page', {
      request: {
        address: { kind: 'session', sessionId },
        throughSeq,
        maxMessages: 100_000,
      },
    });
    return { events: page.records.map(r => ({ event: r.event })) as DshHistoryEntry[], hasMore: page.hasMore };
  },

  /** 模型目录 = session/modelCatalog；current 从会话投影 modelSelection 取。 */
  models: async (sessionId: string): Promise<DshSessionModels> => {
    const catalog = await rpc<WireModelCatalog>('session/modelCatalog');
    const sel = sessionModelSelection.get(sessionId);
    const current = sel?.next ?? sel?.lastUsed ?? catalog.default;
    return {
      current,
      routable: catalog.routableProviders.length > 0,
      groups: catalog.groups.map(g => ({
        id: g.id,
        name: g.name,
        models: g.models.map(m => ({
          id: m.id,
          name: m.name,
          ...(m.description ? { description: m.description } : {}),
          ...(m.reasoning
            ? {
                reasoning: {
                  efforts: m.reasoning.efforts.map(e => ({ id: e.id, name: e.name })),
                  defaultEffort: m.reasoning.defaultEffort ?? m.reasoning.efforts[0]?.id ?? '',
                },
              }
            : {}),
        })),
      })),
      failures: catalog.failures.map(f => ({ id: f.id, message: f.message })),
    };
  },

  selectModel: (sessionId: string, provider: string, model: string) =>
    rpc<{ selected: DshModelSelection }>('session/selectModel', {
      request: { sessionId, provider, model },
    }),

  rename: (sessionId: string, title: string) =>
    rpc<{ title: string; seq: number }>('session/rename', {
      request: { sessionId, title },
    }),

  /** 派生会话（引擎原生 fork：复制历史到新会话；atSeq 可截断）。 */
  fork: (sessionId: string) =>
    rpc<{ sessionId: string }>('session/fork', { request: { sessionId } }),
};

// ---------------------------------------------------------------------------
// WebSocket 事件流（remote.mux 适配层 → 旧 events.mux 帧语义）
// ---------------------------------------------------------------------------

export interface DshMuxConnection {
  close: () => void;
}

/** mux 逻辑流注册表条目。 */
interface MuxStreamEntry {
  kind: 'events' | 'control' | 'follow';
  sessionId?: string;
}

// ---- $events 流的 item 值形状（dsh-api-gateway stream-protocol）----

interface WireEventsReady {
  type: 'ready';
  clientId: string;
  host?: { home?: string };
}

interface WireWaterfallFrame {
  type: 'waterfall';
  event: string;
  eventId: string;
  agentId: string;
  request: Record<string, unknown>;
}

interface WireEventCancelFrame {
  type: 'cancel';
  eventId: string;
}

interface WireEmitFrame {
  type: 'emit';
  event: string;
  args: unknown[];
}

type WireEventsItem = WireEventsReady | WireWaterfallFrame | WireEventCancelFrame | WireEmitFrame;

// ---- session/follow 流的 item 值形状 ----

interface WireFollowSnapshot {
  type: 'snapshot';
  cursor: number;
  records: WirePageRecord[];
  hasMore: boolean;
  projections?: { asOfSeq: number; values?: Record<string, unknown> };
}

type WireFollowItem =
  | WireFollowSnapshot
  | { type: 'event'; event: DshSessionEvent }
  | { type: string };

// ---- session/control 流的 item 值形状 ----

interface WireJob {
  id: string;
  kind?: string;
  label?: string;
  status: string;
  startedAt?: number;
  finishedAt?: number;
}

interface WireControlBaseline {
  type: 'baseline';
  value: {
    queues?: Record<string, unknown[]>;
    jobs?: Record<string, WireJob[]>;
    projections?: Record<string, { asOfSeq: number; values?: Record<string, unknown> }>;
  };
}

type WireControlItem =
  | WireControlBaseline
  | {
      type: 'jobs' | 'projection' | 'queue';
      sessionId?: string;
      jobs?: WireJob[];
      key?: string;
      value?: unknown;
      seq?: number;
    };

/** 订阅 mux 事件流（自动重连）。返回连接句柄。rpcId 供可应答帧（approval 等）回显。 */
export function connectMux(
  onFrame: (frame: DshMuxFrame, rpcId: string) => void,
  onStateChange?: (connected: boolean) => void
): DshMuxConnection {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;

  let nextStreamId = 1;
  const streams = new Map<string, MuxStreamEntry>();
  const followed = new Set<string>();
  let eventsClientId: string | null = null;

  const send = (obj: unknown): void => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  };

  const openStream = (endpoint: string, args: Record<string, unknown>, entry: MuxStreamEntry): void => {
    const streamId = String(nextStreamId++);
    streams.set(streamId, entry);
    send({ type: 'open', streamId, endpoint, payload: { args } });
  };

  /** 跟随一个会话（幂等；connection 级去重，重连时清空重开）。 */
  const followSession = (sessionId: string): void => {
    if (followed.has(sessionId) || closed) return;
    followed.add(sessionId);
    openStream(
      'session/follow',
      // 0.1.5：follow 的 wire 参数名是 request（严格 codec）
      { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } },
      { kind: 'follow', sessionId },
    );
  };

  /** 初始拉全会话列表逐个 follow（复刻旧 events.mux「全量推送」语义）。 */
  const followAllSessions = async (): Promise<void> => {
    try {
      const { items } = await rpc<{ items: DshSessionSummary[] }>('session/list', { _request: {} });
      if (closed) return;
      for (const s of items) {
        cacheProjectionValues(s.sessionId, s.projections?.values);
        followSession(s.sessionId);
      }
    } catch {
      // 引擎未就绪/暂时不可达：等下一轮重连再拉
    }
  };

  // ---- $events 流帧处理 ----

  const answerNext = (eventId: string): void => {
    if (eventsClientId) {
      void postEventResult({ clientId: eventsClientId, eventId }, { kind: 'next' });
    }
  };

  const handleWaterfall = (frame: WireWaterfallFrame): void => {
    if (!eventsClientId) return;
    const request = frame.request ?? {};
    if (frame.event === 'approval/request') {
      const rpcId = newEventRpcId();
      pendingEventAnswers.set(rpcId, { clientId: eventsClientId, eventId: frame.eventId });
      pendingEventSessionIds.set(rpcId, frame.agentId);
      onFrame(
        {
          type: 'approval/requested',
          sessionId: frame.agentId,
          approvalId: frame.eventId,
          toolName: String(request.toolName ?? ''),
          ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
          ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
        },
        rpcId,
      );
      return;
    }
    if (frame.event === 'user-questions/request') {
      const rpcId = newEventRpcId();
      pendingEventAnswers.set(rpcId, { clientId: eventsClientId, eventId: frame.eventId });
      pendingEventSessionIds.set(rpcId, frame.agentId);
      onFrame(
        {
          type: 'question/requested',
          sessionId: frame.agentId,
          questions: Array.isArray(request.questions) ? (request.questions as DshQuestionItem[]) : [],
        },
        rpcId,
      );
      return;
    }
    // 未知 waterfall：应答 next 委托（否则 agent 侧永远挂起）
    answerNext(frame.eventId);
  };

  const handleEventsItem = (value: WireEventsItem): void => {
    if (!value || typeof value !== 'object') return;
    const v = value as unknown as Record<string, unknown>;
    if (v.type === 'ready' && typeof v.clientId === 'string') {
      eventsClientId = v.clientId;
      return;
    }
    if (v.type === 'waterfall') {
      handleWaterfall(value as WireWaterfallFrame);
      return;
    }
    if (v.type === 'cancel' && typeof v.eventId === 'string') {
      // 引擎侧已结算（别处已答/取消）：给本连接的消费者清 pending 卡
      for (const [rpcId, target] of pendingEventAnswers) {
        if (target.eventId !== v.eventId) continue;
        pendingEventAnswers.delete(rpcId);
        const sessionId = pendingEventSessionIds.get(rpcId) ?? '';
        pendingEventSessionIds.delete(rpcId);
        broadcastFrame({ type: 'approval/resolved', sessionId, approvalId: v.eventId, outcome: 'cancelled' });
        broadcastFrame({ type: 'question/resolved', sessionId, questionRpcId: rpcId, outcome: 'cancelled' });
      }
      return;
    }
    if (v.type === 'emit' && typeof v.event === 'string' && Array.isArray(v.args)) {
      // api-session/added → 开始跟随新会话（旧协议新会话自动出现）
      if (v.event === 'api-session/added') {
        const summary = v.args[0] as DshSessionSummary | undefined;
        if (summary?.sessionId) {
          cacheProjectionValues(summary.sessionId, summary.projections?.values);
          followSession(summary.sessionId);
        }
      }
      return;
    }
  };

  // ---- session/control 流帧处理 ----

  const emitJobs = (sessionId: string | undefined, jobs: WireJob[]): void => {
    onFrame({ type: 'session/jobs', ...(sessionId ? { sessionId } : {}), jobs }, '');
  };

  const emitProjection = (sessionId: string, key: string, value: unknown, seq: number): void => {
    onFrame({ type: 'session/projection', sessionId, key, value, seq }, '');
  };

  const handleControlItem = (value: WireControlItem): void => {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (v.type === 'baseline') {
      const baseline = (v.value ?? {}) as NonNullable<WireControlBaseline['value']>;
      for (const [sessionId, jobs] of Object.entries(baseline.jobs ?? {})) {
        emitJobs(sessionId, jobs);
      }
      for (const [sessionId, proj] of Object.entries(baseline.projections ?? {})) {
        cacheProjectionValues(sessionId, proj.values);
        for (const [key, val] of Object.entries(proj.values ?? {})) {
          emitProjection(sessionId, key, val, proj.asOfSeq);
        }
      }
      return;
    }
    if (v.type === 'jobs' && typeof v.sessionId === 'string') {
      emitJobs(v.sessionId, Array.isArray(v.jobs) ? (v.jobs as WireJob[]) : []);
      return;
    }
    if (v.type === 'projection' && typeof v.sessionId === 'string' && typeof v.key === 'string') {
      if (v.key === 'modelSelection') {
        cacheProjectionValues(v.sessionId, { modelSelection: v.value });
      }
      emitProjection(v.sessionId, v.key, v.value, typeof v.seq === 'number' ? v.seq : 0);
      return;
    }
    // queue 帧：旧 UI 无消费方，忽略
  };

  // ---- session/follow 流帧处理 ----

  const handleFollowItem = (sessionId: string, value: WireFollowItem): void => {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (v.type === 'snapshot') {
      const snap = value as WireFollowSnapshot;
      settleCursor(sessionId, snap.cursor);
      cacheProjectionValues(sessionId, snap.projections?.values);
      onFrame({ type: 'session/subscribed', sessionId, lastSeq: snap.cursor }, '');
      return;
    }
    if (v.type === 'event' && v.event && typeof v.event === 'object') {
      onFrame({ type: 'session/event', sessionId, event: v.event as DshSessionEvent }, '');
      return;
    }
    // assistant-stream 帧未订阅（assistantStream 未开），忽略
  };

  // ---- WS 生命周期 ----

  const open = () => {
    if (closed) return;
    // 同源代理：WS URL 按当前页面协议推导（http → ws）；dev 下显式指向 2100
    const base = import.meta.env.DEV ? 'http://127.0.0.1:2100' : window.location.origin;
    const wsUrl = base.replace(/^http/, 'ws') + '/dsh-ws/remote.mux';
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      retry = 0;
      onStateChange?.(true);
      // 三条逻辑流：元事件 + 全局控制 + 每会话 follow
      nextStreamId = 1;
      eventsClientId = null;
      openStream('$events', {}, { kind: 'events' });
      openStream('session/control', {}, { kind: 'control' });
      void followAllSessions();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type: string;
          streamId?: string;
          value?: unknown;
          error?: { code: string; message: string };
        };
        if (msg.type === 'item' && msg.streamId) {
          const entry = streams.get(msg.streamId);
          if (!entry) return;
          if (entry.kind === 'events') handleEventsItem(msg.value as WireEventsItem);
          else if (entry.kind === 'control') handleControlItem(msg.value as WireControlItem);
          else if (entry.kind === 'follow' && entry.sessionId) {
            handleFollowItem(entry.sessionId, msg.value as WireFollowItem);
          }
        } else if (msg.type === 'error' && msg.streamId) {
          // 流级错误（如 session 不存在）：清理注册，等下轮重连
          streams.delete(msg.streamId);
          onFrame(
            { type: 'stream/error', error: { code: msg.error?.code ?? 'unknown', message: msg.error?.message ?? 'stream error' } },
            '',
          );
        } else if (msg.type === 'end' && msg.streamId) {
          streams.delete(msg.streamId);
        }
      } catch {
        // 忽略无法解析的帧
      }
    };
    ws.onclose = () => {
      onStateChange?.(false);
      streams.clear();
      followed.clear();
      eventsClientId = null;
      if (!closed) {
        retry += 1;
        const delay = Math.min(1000 * 2 ** Math.min(retry, 4), 10_000);
        setTimeout(open, delay);
      }
    };
    ws.onerror = () => ws?.close();
  };
  open();

  const broadcastFn = (frame: DshMuxFrame): void => onFrame(frame, '');
  muxFrameBroadcast.add(broadcastFn);

  return {
    close: () => {
      closed = true;
      muxFrameBroadcast.delete(broadcastFn);
      ws?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// 事件折叠：SessionEvent[] → UI 消息模型
// ---------------------------------------------------------------------------

export interface DshToolCallView {
  id: string;
  name: string;
  arguments: string;
  /** tool/result 事件的模型侧结果文本（pending 时为空）。 */
  result?: string;
  /** 结果是否为错误（ToolResultBlock.isError 或事件级 error）。 */
  isError?: boolean;
  /** 尚未收到对应 tool/result。 */
  pending?: boolean;
}

/** 折叠后的 UI 消息。 */
export interface DshMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  toolCalls: DshToolCallView[];
  streaming: boolean;
  error?: string;
}

/** 会话累计用量（M2.2：assistant/message usage 聚合）。 */
export interface DshUsageSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

interface StreamChunkShape {
  type: string;
  index?: number;
  text?: string;
  block?: { type: string; text?: string; id?: string; name?: string; arguments?: string };
  reason?: { kind: string; failure?: { message: string } };
}

/**
 * 把一段会话事件（history 或实时流）折叠成 UI 消息数组。
 *
 * 处理的事件类型：
 * - user/message      → 用户消息（data.content 取 text 块）
 * - assistant/chunk   → StreamChunk 协议（text-delta 累积 / tool-call 块 / finish）
 * - tool/call         → 模型请求的工具调用（callId 关联；去重合并 block-end 同名项）
 * - tool/result       → 工具结果（按 callId 回填 result/isError）
 * - turn/start|end    → 流式状态
 */
export function foldEvents(events: DshSessionEvent[]): DshMessage[] {
  const messages: DshMessage[] = [];
  /** 当前流式 assistant 消息（跨 chunk 累积）。 */
  let current: DshMessage | null = null;
  /** callId → 工具调用视图（tool/result 回填用）。 */
  const callViews = new Map<string, DshToolCallView>();
  let seq = 0;

  const newText = (role: 'user' | 'assistant'): DshMessage => {
    const msg: DshMessage = {
      id: `m${seq}`,
      role,
      text: '',
      toolCalls: [],
      streaming: false,
    };
    seq += 1;
    messages.push(msg);
    return msg;
  };

  /** 当前 assistant 消息里登记一个工具调用（block-end 与 tool/call 去重合并）。 */
  const upsertToolCall = (callId: string, name: string, args: string): DshToolCallView => {
    if (!current) {
      current = newText('assistant');
    }
    const existing = callViews.get(callId);
    if (existing && current.toolCalls.includes(existing)) {
      return existing;
    }
    const view: DshToolCallView = { id: callId, name, arguments: args, pending: true };
    current.toolCalls.push(view);
    callViews.set(callId, view);
    return view;
  };

  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined;
    switch (event.type) {
      case 'user/message': {
        current = null;
        const msg = newText('user');
        const content = data?.content as Array<{ type: string; text?: string }> | undefined;
        msg.text = (content ?? [])
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('');
        break;
      }
      case 'turn/start': {
        // 新一轮：开启下一条 assistant 消息的流式累积
        break;
      }
      case 'turn/end': {
        if (current) {
          current.streaming = false;
        }
        current = null;
        break;
      }
      case 'assistant/chunk': {
        if (!current) {
          current = newText('assistant');
        }
        current.streaming = true;
        const chunk = (data as { chunk?: StreamChunkShape } | undefined)?.chunk;
        if (!chunk) break;
        switch (chunk.type) {
          case 'text-delta': {
            current.text += chunk.text ?? '';
            break;
          }
          case 'reasoning-delta': {
            current.reasoning = (current.reasoning ?? '') + (chunk.text ?? '');
            break;
          }
          case 'block-end': {
            if (chunk.block?.type === 'tool-call') {
              upsertToolCall(
                chunk.block.id ?? 'call',
                chunk.block.name ?? '',
                chunk.block.arguments ?? '{}',
              );
            }
            break;
          }
          case 'finish': {
            current.streaming = false;
            if (chunk.reason?.kind === 'error') {
              current.error = chunk.reason.failure?.message ?? 'unknown error';
            }
            break;
          }
          default:
            break;
        }
        break;
      }
      case 'tool/call': {
        // 模型请求的工具调用（引擎权威事件：callId 关联 tool/result）
        const callId = String(data?.callId ?? '');
        const name = String(data?.name ?? '');
        if (callId) {
          upsertToolCall(callId, name, String(data?.arguments ?? '{}'));
        }
        break;
      }
      case 'tool/result': {
        // 工具结果：按 callId 回填（message.content 的 text 块拼接）
        const message = data?.message as
          | { content?: Array<{ type?: string; text?: string }> }
          | undefined;
        const callId = (message?.content?.[0] as { toolCallId?: string } | undefined)?.toolCallId;
        const view = callId ? callViews.get(callId) : undefined;
        if (!view) break;
        const resultText = (message?.content ?? [])
          .filter(b => b?.type === 'text')
          .map(b => b.text ?? '')
          .join('');
        view.result = resultText;
        view.pending = false;
        const eventError = data?.error as { name?: string; code?: string } | undefined;
        const blockError = (
          message?.content?.[0] as { isError?: boolean } | undefined
        )?.isError;
        view.isError = Boolean(eventError) || blockError === true;
        break;
      }
      default:
        break;
    }
  }
  return messages;
}

interface UsageShape {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/**
 * 聚合会话累计用量（M2.2 薄版）：assistant/message 事件自带的
 * usage（TokenUsage{inputTokens, outputTokens, cacheReadTokens?...}）逐条累加。
 * 无任何 usage 事件（如纯本地会话未带 usage）返回 null。
 */
export function aggregateUsage(events: DshSessionEvent[]): DshUsageSummary | null {
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const usage = (event.data as { usage?: UsageShape } | undefined)?.usage;
    if (!usage) continue;
    requests += 1;
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cacheReadTokens += usage.cacheReadTokens ?? 0;
  }
  if (requests === 0) return null;
  return { requests, inputTokens, outputTokens, cacheReadTokens };
}
