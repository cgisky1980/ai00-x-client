/**
 * DshAPI — dsh 引擎（sidecar, 127.0.0.1:3210）的前端客户端。
 *
 * 协议版本：钉版 dsh 0.2.2（dsh_versions.gen.rs 决定）。
 * 与 0.1.5 的关键差异（本文件已按新版适配）：
 * - session/control 的 baseline 只有 `projections`；增量是
 *   `{ sessionId, seq, changes:[{key,val}] }`，不再有独立 queue/jobs 帧；
 * - 待处理队列以 `inbox` 投影（next-turn / next-step）为权威来源；
 * - session/prompt 带 `mode:'queue'|'steer'` 与客户端铸造的 requestId，
 *   `session/updateQueue` 支持 edit/remove/steer（无排序）；
 * - `session/state` 提供 running/live 队列快照，用于回合结束与重连对账。
 *
 * 0.1.5 基础协议：
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
 *     · session/control —— 全局控制流：baseline + projection 增量（含 inbox）
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
import { noteSessionWorkspace } from '../../../shared/agent-approval-rules';

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
/** 后台作业条目（session/control 流 jobs 帧；子代理/工作流等后台执行单元）。 */
export interface DshJobItem {
  id: string;
  kind?: string;
  label?: string;
  status: string;
  startedAt?: number;
  finishedAt?: number;
}

/** 队列项的权威位置：next-turn=本轮结束后执行，next-step=当前步骤结束后插话。 */
export type DshQueuePlacement = 'queued' | 'steering';

/** 归一化后的待处理输入项（来源：inbox 投影 / session/state.queue）。 */
export interface DshQueueItem {
  /** 引擎 MessageId：updateQueue 的目标。 */
  itemId: string;
  text: string;
  /** 提交时客户端铸造的 requestId（用于与本地 echo 对账）。 */
  requestId?: string;
  placement: DshQueuePlacement;
}

/** 会话待处理输入（Host 权威）。 */
export interface DshInbox {
  items: DshQueueItem[];
  /** 产生本次投影的事件 seq（基线取 asOfSeq）。 */
  seq: number;
}

/** 队列项变更动作（引擎词汇，无排序）。 */
export type DshQueueAction =
  | { kind: 'edit'; text: string }
  | { kind: 'remove' }
  | { kind: 'steer' };

/** 会话被动状态快照（session/state）。 */
export interface DshSessionState {
  cursor: number;
  active: boolean;
  running: boolean;
  /** 待应答的转发事件分类（approval/question/other）。 */
  pendingInput: string[];
  /** live Agent 的待处理队列；无 live Agent 时为 null（未知，不是空）。 */
  queue: DshQueueItem[] | null;
}

export type DshMuxFrame =
  | { type: 'session/event'; sessionId: string; event: DshSessionEvent; view?: unknown }  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  /**
   * 实时 assistant 流（session/follow 的 assistant-stream 帧折叠结果）。
   * 已提交事件只在回合结束落盘，逐字刷新必须靠这条进程内流。
   */
  | { type: 'session/assistant-stream'; sessionId: string; live: DshLiveAssistant }
  /** 后台任务注册表快照（来自 session/control 流的 jobs 帧 / baseline） */
  | {
      type: 'session/jobs';
      sessionId?: string;
      jobs: DshJobItem[];
    }
  /** 投影单元更新（key: subagent/subagentTiming/title 等） */
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  /**
   * 会话待处理输入（inbox 投影归一化结果，Host 权威）。
   * 每次都是该会话的完整列表：直接替换，不做增量合并。
   */
  | { type: 'session/inbox'; sessionId: string; items: DshQueueItem[]; seq: number }
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
  | {
      type: 'stream/error';
      /** follow 流失败时带上所属会话；全局流（$events/control）没有 sessionId。 */
      sessionId?: string;
      error: { code: string; message: string };
    };

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

let promptSeq = 0;

/**
 * 铸造一条 prompt 的 requestId。
 *
 * 必须在调用 `dshSession.prompt` **之前**生成：UI 先用它建立本地即时回显，
 * 之后按 durable `user/message.source.rpcId` 与 inbox 行退休回显。
 */
export function createDshRequestId(): string {
  return `ui-prompt-${Date.now()}-${promptSeq++}`;
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
// 引擎 checkpoint（P1-B：三槽位健康快照 + 恢复）
// ---------------------------------------------------------------------------

/** checkpoint 槽位卡片（设置页「引擎健康」分区）。 */
export interface DshCheckpointInfo {
  slot: number;
  timestamp_unix_secs: number;
  engine_version: string;
  file_count: number;
}

export const dshCheckpoints = {
  list: () => tauriInvoke<DshCheckpointInfo[]>('dsh_checkpoints_list'),
  /** 恢复槽位并重启引擎（Rust 侧 stop→start 串行化）。 */
  restore: (slot: number) => tauriInvoke<unknown>('dsh_checkpoint_restore', { slot }),
};

// ---------------------------------------------------------------------------
// Slash 命令（commands/list + commands/execute；plan mode 等引擎能力经此驱动）
// ---------------------------------------------------------------------------

/** 引擎已注册的 slash 命令（agent 作用域，含全局注册；description 供面板展示）。 */
export interface DshCommandInfo {
  name: string;
  description: string;
  input?: { hint: string; attachments?: boolean };
}

/** 命令执行 settled 结果（无效语法/未知命令返回 undefined）。 */
export interface DshCommandExecutionResult {
  commandId?: string;
  result?: { kind: 'success'; text?: string } | { kind: 'error'; text: string };
}

export const dshCommands = {
  /** 列出某会话可用的 slash 命令（agent-scoped，含 agent 内遮蔽解析）。 */
  list: (sessionId: string) => rpc<DshCommandInfo[]>('commands/list', { agent: sessionId }),
  /**
   * 执行一条命令行（如 `/plan`、`/plan off`、`/compact`）。命令不产生模型消息，
   * 但会记入会话日志；结果在返回值里（UI 层提示）。
   */
  execute: (sessionId: string, line: string) =>
    rpc<DshCommandExecutionResult | undefined>('commands/execute', {
      agent: sessionId,
      line,
      submittedAttachments: [],
    }),
};

/** 引擎权限档（DSH_PERMISSION_MODE：read-only / workspace-write / danger-full-access）。 */
export const dshPermission = {
  /** 当前档（null = 引擎默认 workspace-write）。 */
  get: () => tauriInvoke<string | null>('get_dsh_permission_mode'),
  /** 设置档（持久化，重启引擎后生效）。 */
  set: (mode: string | null) => tauriInvoke<void>('set_dsh_permission_mode', { mode }),
};

// ---------------------------------------------------------------------------
// Agent 编排：帮手定义（<DSH_HOME>/agent-workers/*.md）+ Claude Code 兼容 hooks
// ---------------------------------------------------------------------------

/** 帮手定义摘要（编辑器列表行）。 */
export interface DshWorkerSummary {
  fileName: string;
  name: string;
  description: string;
  model: string;
  tools: string[];
}

/** 帮手定义管理（改动重启引擎生效；删空回退内嵌默认两件套）。 */
export const dshWorkers = {
  list: () => tauriInvoke<DshWorkerSummary[]>('dsh_workers_list'),
  read: (fileName: string) => tauriInvoke<string>('dsh_worker_read', { fileName }),
  save: (fileName: string, content: string) =>
    tauriInvoke<void>('dsh_worker_save', { fileName, content }),
  delete: (fileName: string) => tauriInvoke<void>('dsh_worker_delete', { fileName }),
};

/** Claude Code 兼容 hooks（<DSH_HOME>/hooks.json；空串 = 未配置）。 */
export const dshHooks = {
  get: () => tauriInvoke<string>('dsh_hooks_config_get'),
  set: (content: string) => tauriInvoke<void>('dsh_hooks_config_set', { content }),
};

// ---------------------------------------------------------------------------
// 志·快照时间线（agent 签名快照；libgit2 纯库）
// ---------------------------------------------------------------------------

/** 单条快照记录。 */
export interface DshSnapshotEntry {
  commit: string;
  message: string;
  time: number;
}

/** 快照时间线（工作区 = 当前打开的工作区路径）。 */
export const dshSnapshots = {
  list: (dir: string, limit?: number) =>
    tauriInvoke<DshSnapshotEntry[]>('git_snapshots_list', { request: { dir, limit } }),
  now: (dir: string, message?: string) =>
    tauriInvoke<{ initialized: boolean; commit: string | null; message: string }>(
      'git_snapshot_now',
      { request: { dir, message } },
    ),
  rollback: (dir: string, commit: string) =>
    tauriInvoke<{ initialized: boolean; commit: string | null; message: string }>(
      'git_snapshot_rollback',
      { request: { dir, commit } },
    ),
};

// ---------------------------------------------------------------------------
// 会话 API（HTTP unary；history/models 由 follow cursor + 目录拼装）
// ---------------------------------------------------------------------------

/** 全局 follow 快照 cursor 缓存（history 的 throughSeq 来源）。 */
const sessionCursors = new Map<string, number>();
/** 全局 modelSelection 投影缓存（models() 的 current 来源）。 */
const sessionModelSelection = new Map<string, DshModelSelectionProjection | undefined>();
/** 全局 inbox 投影缓存（Host 权威待处理输入；断线重连后仍可读最后已知值）。 */
const sessionInbox = new Map<string, DshInbox>();
/** 等 cursor 的 waiter（新会话创建后立即拉历史时的竞态兜底）。 */
const cursorWaiters = new Map<string, Array<(cursor: number) => void>>();

/** inbox 投影 wire 值 → UI 待处理项（next-turn=排队 / next-step=待插话）。 */
function normalizeInboxValue(value: unknown): DshQueueItem[] {
  const wire = (value ?? {}) as Record<string, unknown>;
  const items: DshQueueItem[] = [];
  const collect = (raw: unknown, placement: DshQueuePlacement): void => {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      const msg = (entry ?? {}) as Record<string, unknown>;
      const itemId = typeof msg.id === 'string' ? msg.id : '';
      if (!itemId) continue;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = content
        .filter(b => (b as { type?: string })?.type === 'text')
        .map(b => String((b as { text?: string }).text ?? ''))
        .join('');
      const source = (msg.source ?? {}) as { rpcId?: unknown; form?: unknown };
      // 引擎注入的上下文（form 标记）不进用户可见队列
      if (typeof source.form === 'string') continue;
      items.push({
        itemId,
        text,
        placement,
        ...(typeof source.rpcId === 'string' ? { requestId: source.rpcId } : {}),
      });
    }
  };
  collect(wire['next-turn'], 'queued');
  collect(wire['next-step'], 'steering');
  return items;
}

function cacheProjectionValues(sessionId: string, values?: Record<string, unknown>, seq = 0): void {
  const sel = values?.modelSelection;
  if (sel && typeof sel === 'object') {
    sessionModelSelection.set(sessionId, sel as DshModelSelectionProjection);
  }
  if (values && 'inbox' in values) {
    sessionInbox.set(sessionId, { items: normalizeInboxValue(values.inbox), seq });
  }
}

/** 读取最近一次 inbox 投影（Host 权威；未收到过返回空列表）。 */
export function readSessionInbox(sessionId: string): DshInbox {
  return sessionInbox.get(sessionId) ?? { items: [], seq: -1 };
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
        // R2-11b：回填「会话 → 工作区」映射，供审批「总是允许」的持久判定用
        noteSessionWorkspace(s.sessionId, s.cwd);
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
    }).then(res => {
      // R2-11b：新建会话即刻登记工作区（list 尚未含该会话时也能命中持久白名单）
      noteSessionWorkspace(res.sessionId, opts?.cwd);
      return res;
    }),

  /**
   * 提交一条用户输入。
   *
   * - `mode:'queue'`（默认）：空闲时直接开始新回合；运行中进入待处理队列。
   * - `mode:'steer'`：在 Agent 下一个可接收输入的安全边界插话，不取消当前回合；
   *   安全窗口关闭时由引擎回落为队列项（不是硬中断）。
   *
   * `requestId` 由调用方在调用前铸造，用于本地即时回显与 durable
   * `user/message.source.rpcId` / inbox 行对账；未传时内部生成（旧调用方）。
   */
  prompt: (
    sessionId: string,
    text: string,
    opts?: { mode?: 'queue' | 'steer'; requestId?: string },
  ) =>
    rpc<{ accepted: true }>('session/prompt', {
      request: {
        requestId: opts?.requestId ?? createDshRequestId(),
        sessionId,
        mode: opts?.mode ?? 'queue',
        content: [{ type: 'text', text }],
      },
    }),

  /**
   * 修改仍待处理（尚未被领取）的队列项。
   * 引擎只支持 edit/remove/steer，没有排序；清空队列由调用方逐项 remove 实现。
   */
  updateQueue: (sessionId: string, itemId: string, action: DshQueueAction) =>
    rpc<{ accepted: true }>('session/updateQueue', {
      request: {
        sessionId,
        itemId,
        action:
          action.kind === 'edit'
            ? { kind: 'edit', content: [{ type: 'text', text: action.text }] }
            : { kind: action.kind },
      },
    }),

  /** 会话被动状态（cursor/running/队列快照）；无 live Agent 时 queue 为 null。 */
  state: (sessionId: string): Promise<DshSessionState> =>
    rpc<WireSessionState>('session/state', { request: { sessionId } }).then(wire => ({
      cursor: wire.cursor,
      active: wire.active,
      running: wire.running,
      pendingInput: Array.isArray(wire.pendingInput) ? wire.pendingInput : [],
      queue:
        wire.queue == null
          ? null
          : wire.queue
              .filter(q => q.placement !== 'context')
              .map(q => ({
                itemId: q.id,
                text: (q.content ?? [])
                  .filter(b => (b as { type?: string })?.type === 'text')
                  .map(b => String((b as { text?: string }).text ?? ''))
                  .join(''),
                placement: q.placement === 'steering' ? 'steering' : 'queued',
                ...(q.rpcId ? { requestId: q.rpcId } : {}),
              })),
    })),

  cancel: (sessionId: string) =>
    rpc<{ accepted: true }>('session/cancel', { request: { sessionId } }),

  /**
   * 全量历史：session/page（省略 throughSeq = 引擎观测到的日志末端）。
   *
   * 不能用 follow 快照的 cursor 当截止点——快照只在订阅时取一次，之后
   * 新写入的事件都大于它，导致「回合结束后重拉历史」永远拿不到新内容。
   * 先等 cursor 就绪仍保留（保证事件流已连上，与实时流同源）。
   */
  history: async (sessionId: string) => {
    await resolveCursor(sessionId);
    const page = await rpc<{ records: WirePageRecord[]; hasMore: boolean }>('session/page', {
      request: {
        address: { kind: 'session', sessionId },
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
  /**
   * 主动重连（不改变连接生命周期）：用于「WS 没报关闭、但后端已换进程」的
   * 静默脱节——引擎重启后代理侧上游已死，浏览器收不到 close，事件永久断流。
   */
  restart: () => void;
  /** 最近一次收到帧的时间戳（ms）；调用方据此判断事件流是否已静默。 */
  lastActivity: () => number;
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
  /** assistantStream=true 时的重连基线（进行中的 attempt 及其已产出片段）。 */
  assistantStream?: {
    revision: number;
    activeAttempt?: {
      attemptId: string;
      stream?: Array<{ type?: string; texts?: string[] }>;
    };
  };
}

/** 实时 assistant 流增量帧（session/follow 的 assistant-stream item）。 */
interface WireAssistantStreamFrame {
  type?: string;
  revision?: number;
  attemptId?: string;
  chunk?: StreamChunkShape;
}

type WireFollowItem =
  | WireFollowSnapshot
  | { type: 'event'; event: DshSessionEvent }
  | { type: 'assistant-stream'; frame: WireAssistantStreamFrame }
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

/**
 * session/control（Host 全局控制流）帧。
 *
 * 钉版 dsh 0.2.2 的形状：baseline 只带 `projections`，增量是
 * `changes[{ key, val }]`（一次事件可能改动多个投影）。
 * 旧的独立 `queue` / `jobs` 帧已不存在——队列统一从 `inbox` 投影读取。
 */
interface WireControlBaseline {
  type: 'baseline';
  value: {
    projections?: Record<string, { asOfSeq: number; values?: Record<string, unknown> }>;
    /** 0.2.1 及更早的遗留字段（保留容错，不再依赖）。 */
    queues?: Record<string, unknown[]>;
    jobs?: Record<string, WireJob[]>;
  };
}

type WireControlItem =
  | WireControlBaseline
  | {
      type: 'projection';
      sessionId?: string;
      seq?: number;
      changes?: Array<{ key?: string; val?: unknown }>;
      /** 旧协议单值形状（容错）。 */
      key?: string;
      value?: unknown;
    };

/** session/state 的 wire 形状。 */
interface WireSessionState {
  cursor: number;
  active: boolean;
  running: boolean;
  pendingInput?: string[];
  queue?: Array<{
    id: string;
    placement: 'queued' | 'steering' | 'context';
    rpcId?: string;
    content?: unknown[];
  }> | null;
}

/** 订阅 mux 事件流（自动重连）。返回连接句柄。rpcId 供可应答帧（approval 等）回显。 */
export function connectMux(
  onFrame: (frame: DshMuxFrame, rpcId: string) => void,
  onStateChange?: (connected: boolean) => void
): DshMuxConnection {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  /** 最近一次收到帧的时间：判断事件流是否已静默（引擎换进程后 WS 不会报 close）。 */
  let lastFrameAt = Date.now();

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
      // assistantStream: true → 引擎附带进程内 assistant-stream 帧（逐字刷新）
      { request: { address: { kind: 'session', sessionId }, maxMessages: 1, assistantStream: true } },
      { kind: 'follow', sessionId },
    );
  };

  /** 初始拉全会话列表逐个 follow（复刻旧 events.mux「全量推送」语义）。 */
  const followAllSessions = async (attempt = 0): Promise<void> => {
    try {
      const { items } = await rpc<{ items: DshSessionSummary[] }>('session/list', { _request: {} });
      if (closed) return;
      for (const s of items) {
        cacheProjectionValues(s.sessionId, s.projections?.values);
        followSession(s.sessionId);
      }
    } catch {
      // 引擎未就绪/暂时不可达（重连时最常见：WS 端口先通、HTTP 还没就绪）：
      // 必须重试，否则所有会话都不被 follow，界面再也收不到事件直到手动刷新。
      if (closed || attempt >= 4) return;
      setTimeout(() => void followAllSessions(attempt + 1), 1500 * (attempt + 1));
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

  const emitInbox = (sessionId: string, seq: number): void => {
    const inbox = readSessionInbox(sessionId);
    onFrame({ type: 'session/inbox', sessionId, items: inbox.items, seq }, '');
  };

  /**
   * 应用一条投影变更：写缓存 + 广播。inbox 走独立的完整列表帧，
   * 其余（modelSelection/title/subagent…）继续走单值投影帧。
   */
  const applyProjection = (sessionId: string, key: string, val: unknown, seq: number): void => {
    cacheProjectionValues(sessionId, { [key]: val }, seq);
    if (key === 'inbox') {
      emitInbox(sessionId, seq);
      return;
    }
    emitProjection(sessionId, key, val, seq);
  };

  const handleControlItem = (value: WireControlItem): void => {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (v.type === 'baseline') {
      const baseline = (v.value ?? {}) as NonNullable<WireControlBaseline['value']>;
      // 0.2.1 及更早才有独立 jobs 帧：保留容错，钉版不会走到
      for (const [sessionId, jobs] of Object.entries(baseline.jobs ?? {})) {
        emitJobs(sessionId, jobs);
      }
      const projections = baseline.projections ?? {};
      // 基线是完整快照：不在基线里的会话说明其 live 状态已不存在，清空旧队列
      for (const cachedId of [...sessionInbox.keys()]) {
        if (!(cachedId in projections)) {
          sessionInbox.delete(cachedId);
          onFrame({ type: 'session/inbox', sessionId: cachedId, items: [], seq: 0 }, '');
        }
      }
      for (const [sessionId, proj] of Object.entries(projections)) {
        const seq = typeof proj.asOfSeq === 'number' ? proj.asOfSeq : 0;
        // 基线同样是一次完整替换：没有 inbox 键就按空队列处理
        cacheProjectionValues(sessionId, { inbox: proj.values?.inbox ?? {} }, seq);
        emitInbox(sessionId, seq);
        for (const [key, val] of Object.entries(proj.values ?? {})) {
          if (key === 'inbox') continue;
          cacheProjectionValues(sessionId, { [key]: val }, seq);
          emitProjection(sessionId, key, val, seq);
        }
      }
      return;
    }
    if (v.type !== 'projection' || typeof v.sessionId !== 'string') return;
    const seq = typeof v.seq === 'number' ? v.seq : 0;
    const changes = Array.isArray(v.changes) ? v.changes : [];
    if (changes.length > 0) {
      for (const change of changes) {
        if (!change || typeof change.key !== 'string') continue;
        applyProjection(v.sessionId, change.key, change.val, seq);
      }
      return;
    }
    // 旧协议单值形状（容错）
    if (typeof v.key === 'string') {
      applyProjection(v.sessionId, v.key, v.value, seq);
    }
  };

  // ---- session/follow 流帧处理 ----

  /** 每会话实时流折叠状态（attemptId 用于丢弃上一轮迟到的增量）。 */
  const liveStreams = new Map<
    string,
    { attemptId: string | null; text: string; reasoning: string; active: boolean }
  >();

  const emitLive = (sessionId: string): void => {
    const live = liveStreams.get(sessionId);
    if (!live) return;
    onFrame(
      {
        type: 'session/assistant-stream',
        sessionId,
        live: { text: live.text, reasoning: live.reasoning, active: live.active },
      },
      '',
    );
  };

  /** 把紧凑记录（text-chunks / reasoning-chunks）拼回文本（重连基线用）。 */
  const joinRecords = (
    stream: Array<{ type?: string; texts?: string[] }> | undefined,
    kind: 'text-chunks' | 'reasoning-chunks',
  ): string =>
    (stream ?? [])
      .filter(r => r?.type === kind)
      .map(r => (r.texts ?? []).join(''))
      .join('');

  const handleAssistantStream = (sessionId: string, frame: WireAssistantStreamFrame): void => {
    if (!frame || typeof frame.type !== 'string') return;
    let live = liveStreams.get(sessionId);
    if (frame.type === 'start') {
      live = { attemptId: frame.attemptId ?? null, text: '', reasoning: '', active: true };
      liveStreams.set(sessionId, live);
      emitLive(sessionId);
      return;
    }
    if (!live) {
      live = { attemptId: frame.attemptId ?? null, text: '', reasoning: '', active: true };
      liveStreams.set(sessionId, live);
    }
    // 迟到的旧 attempt 增量：丢弃（否则会串到新回合的文本里）
    if (frame.attemptId && live.attemptId && frame.attemptId !== live.attemptId) return;
    if (frame.type === 'end') {
      live.active = false;
      emitLive(sessionId);
      return;
    }
    const chunk = frame.chunk;
    if (!chunk) return;
    switch (chunk.type) {
      case 'text-delta':
        live.text += chunk.text ?? '';
        break;
      case 'reasoning-delta':
        live.reasoning += chunk.text ?? '';
        break;
      case 'block-end':
        if (chunk.block?.type === 'tool-call') {
          // 工具调用以提交事件为准；实时只标记仍在产出
        }
        break;
      case 'finish':
        live.active = false;
        break;
      default:
        break;
    }
    emitLive(sessionId);
  };

  const handleFollowItem = (sessionId: string, value: WireFollowItem): void => {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (v.type === 'snapshot') {
      const snap = value as WireFollowSnapshot;
      settleCursor(sessionId, snap.cursor);
      const asOfSeq = typeof snap.projections?.asOfSeq === 'number' ? snap.projections.asOfSeq : 0;
      cacheProjectionValues(sessionId, snap.projections?.values, asOfSeq);
      // follow 快照是会话级完整投影：inbox 也要以它为准重置（重连/挂载时补齐队列）
      emitInbox(sessionId, asOfSeq);
      // 重连基线：进行中的 attempt 已产出的片段先垫上，后续增量再续
      const attempt = snap.assistantStream?.activeAttempt;
      if (attempt) {
        liveStreams.set(sessionId, {
          attemptId: attempt.attemptId,
          text: joinRecords(attempt.stream, 'text-chunks'),
          reasoning: joinRecords(attempt.stream, 'reasoning-chunks'),
          active: true,
        });
        emitLive(sessionId);
      }
      onFrame({ type: 'session/subscribed', sessionId, lastSeq: snap.cursor }, '');
      return;
    }
    if (v.type === 'event' && v.event && typeof v.event === 'object') {
      onFrame({ type: 'session/event', sessionId, event: v.event as DshSessionEvent }, '');
      return;
    }
    if (v.type === 'assistant-stream') {
      handleAssistantStream(sessionId, (value as { frame: WireAssistantStreamFrame }).frame);
      return;
    }
  };

  // ---- WS 生命周期 ----

  const open = () => {
    if (closed) return;
    // 同源代理：WS URL 按当前页面协议推导（http → ws）；dev 下显式指向 2100
    const base = import.meta.env.DEV ? 'http://127.0.0.1:2100' : window.location.origin;
    const wsUrl = base.replace(/^http/, 'ws') + '/dsh-ws/remote.mux';
    const sock = new WebSocket(wsUrl);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      retry = 0;
      lastFrameAt = Date.now();
      onStateChange?.(true);
      // 三条逻辑流：元事件 + 全局控制 + 每会话 follow
      nextStreamId = 1;
      eventsClientId = null;
      openStream('$events', {}, { kind: 'events' });
      openStream('session/control', {}, { kind: 'control' });
      void followAllSessions();
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      lastFrameAt = Date.now();
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
          // 流级错误（如 session 不存在）：清理注册，等下轮重连。
          // 必须带上所属会话：子代理/其它会话的 follow 失败不应被当成本会话中断。
          const entry = streams.get(msg.streamId);
          streams.delete(msg.streamId);
          onFrame(
            {
              type: 'stream/error',
              sessionId: entry?.sessionId,
              error: { code: msg.error?.code ?? 'unknown', message: msg.error?.message ?? 'stream error' },
            },
            '',
          );
        } else if (msg.type === 'end' && msg.streamId) {
          streams.delete(msg.streamId);
        }
      } catch {
        // 忽略无法解析的帧
      }
    };
    sock.onclose = () => {
      // 已被 restart() 替换掉的旧 socket：不得再触发重连（否则会开两条流）
      if (ws !== sock) return;
      onStateChange?.(false);
      streams.clear();
      followed.clear();
      liveStreams.clear();
      eventsClientId = null;
      if (!closed) {
        retry += 1;
        const delay = Math.min(1000 * 2 ** Math.min(retry, 4), 10_000);
        setTimeout(open, delay);
      }
    };
    sock.onerror = () => sock.close();
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
    restart: () => {
      if (closed) return;
      retry = 0;
      // 直接换一条新 socket 并立刻重连：旧 socket 可能早已处于 CLOSED（代理侧
      // 上游死掉时浏览器不一定会回调 close），单纯 close() 不会再触发重连。
      const old = ws;
      ws = null;
      // 旧 socket 的流注册全部作废（onopen 会按新 socket 重新订阅）
      streams.clear();
      followed.clear();
      liveStreams.clear();
      try {
        old?.close();
      } catch {
        // 忽略：旧 socket 已不可用
      }
      open();
    },
    lastActivity: () => lastFrameAt,
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

/** 单条助手消息的 token 用量（与 `aggregateUsage` 的会话累计区分开）。 */
export interface DshMessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

/** 文本形式的工具调用标记（`[工具] name(…)` / `<tool_call>` / `<arg_value>`）。 */
const UNPARSED_TOOL_CALL = /\[工具\]\s*[\w.-]+\(|<\/?(?:tool_call|arg_value|function_call)\b/i;

/** 引擎上下文压缩 checkpoint（伪 user/message，只给模型看，不能进对话区）。 */
const CHECKPOINT_USER_MESSAGE =
  /automatically generated checkpoint|condensing an earlier span of the conversation/i;

/** 气泡内的时序片段：一次模型响应 = 一段（工具调用 + 该段正文）。 */
export interface DshMessageSegment {
  text: string;
  toolCalls: DshToolCallView[];
}

/** 折叠后的 UI 消息。 */
export interface DshMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  toolCalls: DshToolCallView[];
  /**
   * 按时间顺序排列的片段（仅按回合合并后的助手消息有）。
   * 渲染用它保证「工具 → 中间说明 → 工具 → 结论」的先后不被压平。
   */
  segments?: DshMessageSegment[];
  streaming: boolean;
  error?: string;
  /** 本条助手消息的 token 用量（引擎在 assistant/message 事件上报；历史回放可能没有）。 */
  usage?: DshMessageUsage;
  /**
   * 用户消息的提交关联 id（`source.rpcId`）。
   * 工作台用它在本地即时回显与落盘消息之间精确退休，避免误清其他提交。
   */
  rpcId?: string;
  /**
   * 引擎把工具调用写成了文本（`[工具] name({…})` / `<tool_call>`）却没有真正执行：
   * 内容已被 UI 过滤，但需要明确告诉用户「本回合什么都没做」。
   */
  toolCallUnparsed?: boolean;
}

/**
 * 进程内实时 assistant 流（未落盘）。回合结束、已提交的 assistant/message
 * 事件到达后由消费者清空，避免与历史基线重复。
 */
export interface DshLiveAssistant {
  text: string;
  reasoning: string;
  /** 当前 attempt 仍在产出（false = 已结束/未开始）。 */
  active: boolean;
}

/** 会话累计用量（M2.2：assistant/message usage 聚合）。 */
export interface DshUsageSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 是否有任一请求上报了缓存用量。false = 供应商未上报，UI 不应显示命中率（避免误导为 0%）。 */
  cacheReported: boolean;
}

interface StreamChunkShape {
  type: string;
  index?: number;
  text?: string;
  block?: { type: string; text?: string; id?: string; name?: string; arguments?: string };
  reason?: { kind: string; failure?: { message: string } };
}

/** 读取 assistant/message 事件自带的 token 用量；全零/缺失返回 null（UI 不显示空用量）。 */
function readMessageUsage(data: Record<string, unknown> | undefined): DshMessageUsage | null {
  const usage = (data as { usage?: UsageShape } | undefined)?.usage;
  if (!usage) return null;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (inputTokens <= 0 && outputTokens <= 0) return null;
  const result: DshMessageUsage = { inputTokens, outputTokens };
  if (typeof usage.cacheReadTokens === 'number') result.cacheReadTokens = usage.cacheReadTokens;
  return result;
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

  /**
   * 回合边界收口：把还挂着的工具调用标记为完成。
   *
   * `session/history` 只回放消息级事件（不含 tool/result），刷新/重启后若不收口，
   * 已完成的历史工具会永远显示「运行中」。工具必然在该回合的落盘助手消息前返回，
   * 因此「收到 assistant/message」或「turn/end」即代表此前工具都已结束。
   */
  const settleToolCalls = (): void => {
    for (const view of callViews.values()) {
      view.pending = false;
    }
  };

  /** 本回合是否真的执行过工具调用（用于识别「只写了文本形式工具调用」。 */
  let turnHasToolCall = false;
  /** 本回合最后一条落盘助手消息（回合结束时判定是否需要提示）。 */
  let lastAssistant: DshMessage | null = null;

  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined;
    switch (event.type) {
      case 'user/message': {
        // 引擎注入的上下文消息只给模型看，不进对话显示（agent-instructions/
        // runtime-context/skill-catalog/time-context/model-switch notice，统一按
        // source.form 过滤；真实用户输入 source.kind='user' 无 form，不受影响）。
        // 过滤不改变分组状态。
        const source = data?.source as { form?: string; rpcId?: unknown } | undefined;
        if (
          source?.form === 'snapshot' ||
          source?.form === 'instructions' ||
          source?.form === 'catalog' ||
          source?.form === 'notice'
        ) {
          break;
        }
        current = null;
        const msg = newText('user');
        if (typeof source?.rpcId === 'string') msg.rpcId = source.rpcId;
        const content = data?.content as Array<{ type: string; text?: string }> | undefined;
        msg.text = (content ?? [])
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('');
        // 引擎上下文压缩的 checkpoint 也是 user/message，但内容是给模型看的摘要：
        // 直接用英文长段落在对话里冒充「用户发言」（实测触发后满屏
        // "This is an automatically generated checkpoint …"）。按内容特征丢弃。
        if (CHECKPOINT_USER_MESSAGE.test(msg.text)) {
          messages.pop();
          break;
        }
        break;
      }
      case 'turn/start': {
        // 新一轮：开启下一条 assistant 消息的流式累积
        turnHasToolCall = false;
        lastAssistant = null;
        break;
      }
      case 'turn/end': {
        if (current) {
          current.streaming = false;
        }
        settleToolCalls();
        current = null;
        // 整回合没有任何真实工具执行，但最后一条助手文本里带着工具调用标记：
        // 模型/适配层没走工具协议，引擎不会执行——明确告警，避免「说了要做却没动静」。
        if (!turnHasToolCall && lastAssistant && UNPARSED_TOOL_CALL.test(lastAssistant.text)) {
          lastAssistant.toolCallUnparsed = true;
        }
        // 回合级失败（缺凭据/切模型失败等）也要有一条可见的助手气泡，
        // 否则界面上只剩用户自己那句话，看起来像卡死。
        const reason = (data as {
          reason?: { kind?: string; error?: { message?: string; code?: string } };
        } | undefined)?.reason;
        if (reason?.kind === 'error') {
          const failed = newText('assistant');
          failed.error = reason.error?.message ?? 'turn failed';
        }
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
              turnHasToolCall = true;
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
          turnHasToolCall = true;
          upsertToolCall(callId, name, String(data?.arguments ?? '{}'));
        }
        break;
      }
      case 'tool/result': {
        // 工具结果：按 callId 回填（message.content 的 text 块拼接）。
        // callId 在 0.2.2 的落盘形状里位于 message.toolCallId / source.callId，
        // 而不是 content[0].toolCallId —— 三处都要兼容，否则结果永远挂不回工具卡。
        const message = data?.message as
          | {
            content?: Array<{ type?: string; text?: string; toolCallId?: string; isError?: boolean }>;
            toolCallId?: string;
            isError?: boolean;
            source?: { kind?: string; callId?: string };
          }
          | undefined;
        const callId =
          message?.toolCallId ??
          message?.content?.[0]?.toolCallId ??
          message?.source?.callId;
        const view = callId ? callViews.get(callId) : undefined;
        if (!view) break;
        const resultText = (message?.content ?? [])
          .filter(b => b?.type === 'text')
          .map(b => b.text ?? '')
          .join('');
        view.result = resultText;
        view.pending = false;
        const eventError = data?.error as { name?: string; code?: string } | undefined;
        const blockError =
          message?.isError ??
          (message?.content?.[0] as { isError?: boolean } | undefined)?.isError;
        view.isError = Boolean(eventError) || blockError === true;
        break;
      }
      case 'assistant/message': {
        // 已提交的助手消息（durable）：text/reasoning 块拼成一条完整消息。
        // 这是回合结束后唯一可回放的助手文本来源（assistant/chunk 只存在于
        // assistant/attempt 的紧凑 stream 里，不逐条落盘）。
        const message = (data as {
          message?: { content?: Array<{ type?: string; text?: string }> };
        } | undefined)?.message;
        const blocks = message?.content ?? [];
        const text = blocks
          .filter(b => b?.type === 'text')
          .map(b => b.text ?? '')
          .join('');
        const reasoning = blocks
          .filter(b => b?.type === 'reasoning')
          .map(b => b.text ?? '')
          .join('');
        const usage = readMessageUsage(data);
        if (!text && !reasoning && !usage) break;
        settleToolCalls();
        current = null;
        const msg = newText('assistant');
        msg.text = text;
        if (reasoning) msg.reasoning = reasoning;
        if (usage) msg.usage = usage;
        lastAssistant = msg;
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
  let cacheReported = false;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const usage = (event.data as { usage?: UsageShape } | undefined)?.usage;
    if (!usage) continue;
    requests += 1;
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cacheReadTokens += usage.cacheReadTokens ?? 0;
    if (typeof usage.cacheReadTokens === 'number') cacheReported = true;
  }
  if (requests === 0) return null;
  return { requests, inputTokens, outputTokens, cacheReadTokens, cacheReported };
}

/**
 * 缓存命中率文本（R2-8）。命中率 = 缓存读 / 输入总 token（OpenAI 语义下
 * prompt_tokens 已含缓存部分）。供应商未上报返回 null——UI 不显示，避免
 * 把「没数据」误读成「命中率 0%」。
 */
export function formatCacheHitRate(usage: DshUsageSummary | null): string | null {
  if (!usage || !usage.cacheReported || usage.inputTokens <= 0) return null;
  const rate = (usage.cacheReadTokens / usage.inputTokens) * 100;
  return `${rate.toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// 执行过程统计（R1-6 仪表盘）：事件流水账里都有，只是没人数——这里数出来。
// ---------------------------------------------------------------------------

/** 执行过程统计（R1-6）。口径：压缩按 compaction/end 结算；轮耗时按
 *  turn/start→turn/end 的 event.time 差；工具失败判定与 foldEvents 一致
 *  （事件级 error 或结果块 isError）。 */
export interface DshSessionStats {
  /** 成功完成的上下文压缩次数（compaction/end 无 error） */
  compactions: number;
  /** 失败的压缩次数（compaction/end 带 error） */
  compactionFailures: number;
  rounds: {
    /** 完整配对（start+end 均有 time）的轮数 */
    count: number;
    /** 最近一轮耗时（ms） */
    lastMs: number | null;
    /** 平均轮耗时（ms） */
    avgMs: number | null;
  };
  tools: {
    /** 已返回结果（按 callId 去重） */
    total: number;
    failures: number;
    /** 已请求未返回（callId 无对应 result） */
    pending: number;
    /** 失败率 = failures / total（total=0 时 null） */
    failureRate: number | null;
  };
}

/** 从会话事件流水账统计压缩次数/轮耗时/工具失败率（R1-6；纯函数每渲染重算）。 */
export function aggregateSessionStats(events: DshSessionEvent[]): DshSessionStats {
  let compactions = 0;
  let compactionFailures = 0;
  let openTurnAt: number | null = null;
  const roundMs: number[] = [];
  const calledIds = new Set<string>();
  const failedIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined;
    switch (event.type) {
      case 'compaction/end': {
        if (data?.error) compactionFailures += 1;
        else compactions += 1;
        break;
      }
      case 'turn/start': {
        openTurnAt = typeof event.time === 'number' ? event.time : null;
        break;
      }
      case 'turn/end': {
        if (openTurnAt != null && typeof event.time === 'number') {
          roundMs.push(Math.max(0, event.time - openTurnAt));
        }
        openTurnAt = null;
        break;
      }
      case 'tool/call': {
        const callId = String(data?.callId ?? '');
        if (callId) calledIds.add(callId);
        break;
      }
      case 'tool/result': {
        const message = data?.message as
          | { content?: Array<{ type?: string; text?: string; isError?: boolean; toolCallId?: string }> }
          | undefined;
        const first = message?.content?.[0] as { toolCallId?: string; isError?: boolean } | undefined;
        if (first?.toolCallId) {
          resultIds.add(first.toolCallId);
          const eventError = data?.error as { name?: string; code?: string } | undefined;
          if (Boolean(eventError) || first.isError === true) failedIds.add(first.toolCallId);
        }
        break;
      }
      default:
        break;
    }
  }

  const total = resultIds.size;
  const failures = failedIds.size;
  const lastMs = roundMs.length ? roundMs[roundMs.length - 1] : null;
  const avgMs = roundMs.length ? roundMs.reduce((a, b) => a + b, 0) / roundMs.length : null;
  return {
    compactions,
    compactionFailures,
    rounds: { count: roundMs.length, lastMs, avgMs },
    tools: {
      total,
      failures,
      pending: calledIds.size - resultIds.size,
      failureRate: total > 0 ? failures / total : null,
    },
  };
}

/**
 * 会话运行态（R2-9）——从事件流水账重放派生，替代「读历史尾找 error」启发式。
 *
 * 判定依据全部是引擎权威事件的闭合性，不依赖消息折叠规则：
 * - `openTurn`：最后一个轮次未闭合（turn/start 之后没有 turn/end）——被中断的确定性信号；
 * - `pendingTools`：工具调用未返回数（tool/call 无对应 tool/result）——含「卡在审批上」；
 * - `lastTurnErrored`：最后一个轮次以错误收尾（assistant/chunk 的 finish.reason.kind === 'error'），
 *   每遇 turn/start 重置，故只看最后一轮。
 *
 * 注意：审批/提问是 $events 瀑布流信号（不进会话事件日志），但它们发生时必然
 * 表现为「轮次未闭合 + 工具未返回」，故本函数已覆盖，无需单独判定。
 */
export interface DshSessionRunState {
  openTurn: boolean;
  pendingTools: number;
  lastTurnErrored: boolean;
}

export function deriveSessionRunState(events: DshSessionEvent[]): DshSessionRunState {
  let openTurn = false;
  let turnErrored = false;
  const calledIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined;
    switch (event.type) {
      case 'turn/start': {
        openTurn = true;
        turnErrored = false;
        break;
      }
      case 'turn/end': {
        openTurn = false;
        break;
      }
      case 'assistant/chunk': {
        const chunk = data?.chunk as
          | { type?: string; reason?: { kind?: string } }
          | undefined;
        if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          turnErrored = true;
        }
        break;
      }
      case 'tool/call': {
        const callId = String(data?.callId ?? '');
        if (callId) calledIds.add(callId);
        break;
      }
      case 'tool/result': {
        const message = data?.message as
          | { content?: Array<{ toolCallId?: string }> }
          | undefined;
        const callId = message?.content?.[0]?.toolCallId;
        if (callId) resultIds.add(callId);
        break;
      }
      default:
        break;
    }
  }

  let pendingTools = 0;
  for (const id of calledIds) {
    if (!resultIds.has(id)) pendingTools += 1;
  }

  return { openTurn, pendingTools, lastTurnErrored: turnErrored };
}
