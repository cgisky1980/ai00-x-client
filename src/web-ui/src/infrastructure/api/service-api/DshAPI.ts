/**
 * DshAPI — dsh 引擎（sidecar, 127.0.0.1:3210）的前端客户端。
 *
 * v3 架构（Agent体系迁移DeepSeek-Harness分阶段计划.md Phase 3）：
 * 我们自己的 UI 经内嵌服务器（2100）的同源反向代理访问 dsh：
 * - unary RPC：POST /dsh-api/<method>（dsh_proxy 剥 Origin 转发到引擎 /api）
 * - 事件流：WS /dsh-ws/events.mux（dsh_proxy 双向泵到引擎 /api/events.mux）
 *   为什么必须代理：dsh 信任栅栏要求 Origin 与请求 Host 同源，
 *   webview 页面 origin 是 2100，直连 3210 会被 403。
 * - 引擎生命周期：Tauri 命令 dsh_status / dsh_ensure_ready / dsh_stop
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

/** dsh 代理基址（同源：内嵌 Salvo 2100 的 /dsh-api 反向代理；dev 下显式指向 2100）。 */
const DSH_BASE = import.meta.env.DEV ? 'http://127.0.0.1:2100/dsh-api' : '/dsh-api';

// ---------------------------------------------------------------------------
// 类型（对齐 dsh-host-apiproxy 契约，仅取 UI 所需子集）
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
  /** 投影块：title（会话标题）等 UI 派生值（可能缺失）。 */
  projections?: {
    asOfSeq: number;
    values?: {
      title?: string | null;
      [key: string]: unknown;
    };
  };
}

/** 会话事件（SessionEvent 子集）。 */
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

/** WS mux 下行帧（payload 部分）。 */
export type DshMuxFrame =
  | { type: 'session/event'; sessionId: string; event: DshSessionEvent; view?: unknown }
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
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

/** respond 端点的回执（carrier receipt，非 RPC envelope）。 */
export type DshRpcReceipt =
  | { accepted: true }
  | { accepted: false; reason: 'not-pending' | 'bad-response' };

// ---------------------------------------------------------------------------
// RPC 底座
// ---------------------------------------------------------------------------

let rpcSeq = 0;

/** dsh sidecar 健康探测（引擎是否在线）。 */
export async function dshReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${DSH_BASE}/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `ui-${Date.now()}-${rpcSeq++}`,
        method: 'host.describe',
        payload: {},
      }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function rpc<T>(method: string, payload: unknown): Promise<T> {
  const res = await fetch(`${DSH_BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `ui-${Date.now()}-${rpcSeq++}`,
      method,
      payload,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = (await res.json()) as {
    type: string;
    rpcId: string;
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
  };
  if (envelope.result.ok) {
    return envelope.result.value;
  }
  throw new Error(`${envelope.result.error.code}: ${envelope.result.error.message}`);
}

// ---------------------------------------------------------------------------
// 审批响应（POST /api/respond：client-response 信封，rpcId 回显请求帧）
// ---------------------------------------------------------------------------

export const dshApproval = {
  /**
   * 回答一个待处理审批。rpcId 必须回显 approval/requested 帧的 rpcId
   * （引擎侧 pending 表按 rpcId 路由，payload 的 sessionId/approvalId 需与登记一致）。
   */
  respond: async (
    rpcId: string,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<DshRpcReceipt> => {
    const res = await fetch(`${DSH_BASE}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId,
        result: { ok: true, value: { sessionId, approvalId, outcome } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { accepted: false, reason: 'not-pending' };
    }
    return (await res.json()) as DshRpcReceipt;
  },
};

// ---------------------------------------------------------------------------
// 问题应答（POST /api/respond：client-response 信封，rpcId 回显请求帧）
// ---------------------------------------------------------------------------

/** respond 信封的底层 POST（审批/问题共用）。 */
async function postRespond(payload: unknown): Promise<DshRpcReceipt> {
  const res = await fetch(`${DSH_BASE}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return { accepted: false, reason: 'not-pending' };
  }
  return (await res.json()) as DshRpcReceipt;
}

export const dshQuestion = {
  /**
   * 回答一批问题。answers 必须与 questions 数量相等且按顺序 id 对齐；
   * selected 只能是问题选项的 label；单选问题 custom 与 selected 互斥
   * （引擎 matchesQuestions 严格校验，不匹配 = bad-response）。
   */
  respond: (rpcId: string, sessionId: string, answers: DshQuestionAnswerItem[]) =>
    postRespond({
      type: 'client-response',
      rpcId,
      result: {
        ok: true,
        value: { sessionId, answer: { answers } },
      },
    }),

  /** 取消（引擎侧 reject ASK_CANCELLED，agent 收到取消错误）。 */
  cancel: (rpcId: string) =>
    postRespond({
      type: 'client-response',
      rpcId,
      result: {
        ok: false,
        error: { code: 'cancelled', message: 'user cancelled ask_user_question', details: {} },
      },
    }),
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

export const dshEngine = {
  status: () => tauriInvoke<DshStatus>('dsh_status'),
  ensureReady: () => tauriInvoke<DshStatus>('dsh_ensure_ready'),
  stop: () => tauriInvoke<DshStatus>('dsh_stop'),
  /** 订阅安装/运行阶段事件（返回取消函数）。 */
  onPhase: (cb: (phase: DshPhase) => void): Promise<() => void> =>
    tauriListen<DshPhase>('dsh://phase', e => cb(e.payload)),
  /** 订阅插件加载错误事件（stderr 检出 + 模块归因）。 */
  onPluginError: (cb: (payload: DshPluginErrorPayload) => void): Promise<() => void> =>
    tauriListen<DshPluginErrorPayload>('dsh://plugin-error', e => cb(e.payload)),
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
  const res = await fetch(`${DSH_BASE}/pluginInventory/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `ui-${Date.now()}-${rpcSeq++}`,
      method: 'pluginInventory/list',
      payload: { args: {} },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const envelope = (await res.json()) as {
    result: { ok: true; value: { entries: DshPluginInventoryEntry[] } } | { ok: false; error: { message: string } };
  };
  if (envelope.result.ok) {
    return envelope.result.value.entries;
  }
  throw new Error(envelope.result.error.message);
}

/** profile manifest 层插件管理（Tauri 命令 → DshManager）。 */
export const dshPlugins = {
  list: () => tauriInvoke<DshPluginManifestEntry[]>('dsh_plugins_list'),
  remove: (name: string) => tauriInvoke<void>('dsh_plugin_remove', { name }),
  install: (spec: string) => tauriInvoke<void>('dsh_plugin_install', { spec }),
  /** 停用/启用（bundles 数组编辑 + 引擎重启）。 */
  setEnabled: (name: string, enabled: boolean) =>
    tauriInvoke<void>('dsh_plugin_set_enabled', { name, enabled }),
};

// ---------------------------------------------------------------------------
// 会话 API（HTTP unary）
// ---------------------------------------------------------------------------

export const dshSession = {
  list: () => rpc<{ items: DshSessionSummary[] }>('session.list', {}),

  create: (opts?: { cwd?: string; agentPreset?: string }) =>
    rpc<{ sessionId: string; agentPreset?: string }>('session.create', {
      // cwd/agentPreset 可选：空值必须省略字段（引擎会对 '' 做 mkdir 报 ENOENT）
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.agentPreset ? { agentPreset: opts.agentPreset } : {}),
    }),

  /** 原生目录选择（host.pickDirectory，privileged 经代理）。取消返回 null。 */
  pickDirectory: async (): Promise<string | null> => {
    const envelope = await rpc<{ directory?: string | null } | Record<string, never>>(
      'host.pickDirectory',
      {}
    ).catch(() => null);
    if (!envelope) return null;
    const dir = (envelope as { directory?: string | null }).directory;
    return typeof dir === 'string' && dir ? dir : null;
  },

  prompt: (sessionId: string, text: string) =>
    rpc<{ accepted: true }>('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }),

  cancel: (sessionId: string) =>
    rpc<{ accepted: true }>('session.cancel', { sessionId }),

  history: (sessionId: string) =>
    rpc<{ events: DshHistoryEntry[]; hasMore: boolean }>('session.history', { sessionId }),

  models: (sessionId: string) =>
    rpc<DshSessionModels>('session.models', { sessionId }),

  selectModel: (sessionId: string, provider: string, model: string) =>
    rpc<{ selected: DshModelSelection }>('session.selectModel', {
      sessionId,
      provider,
      model,
    }),

  rename: (sessionId: string, title: string) =>
    rpc<{ title: string; seq: number }>('session.rename', { sessionId, title }),
};

// ---------------------------------------------------------------------------
// WebSocket 事件流（mux）
// ---------------------------------------------------------------------------

export interface DshMuxConnection {
  close: () => void;
}

/** 订阅 mux 事件流（自动重连）。返回连接句柄。rpcId 供可应答帧（approval 等）回显。 */
export function connectMux(
  onFrame: (frame: DshMuxFrame, rpcId: string) => void,
  onStateChange?: (connected: boolean) => void
): DshMuxConnection {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;

  const open = () => {
    if (closed) return;
    // 同源代理：WS URL 按当前页面协议推导（http → ws）；dev 下显式指向 2100
    const base = import.meta.env.DEV ? 'http://127.0.0.1:2100' : window.location.origin;
    const wsUrl = base.replace(/^http/, 'ws') + '/dsh-ws/events.mux';
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      retry = 0;
      onStateChange?.(true);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type: string;
          rpcId?: string;
          payload: DshMuxFrame;
        };
        if (msg.type === 'server-request' && msg.payload && msg.rpcId) {
          onFrame(msg.payload, msg.rpcId);
        }
      } catch {
        // 忽略无法解析的帧
      }
    };
    ws.onclose = () => {
      onStateChange?.(false);
      if (!closed) {
        retry += 1;
        const delay = Math.min(1000 * 2 ** Math.min(retry, 4), 10_000);
        setTimeout(open, delay);
      }
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return {
    close: () => {
      closed = true;
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
 * - turn/start|end    → 流式状态
 */
export function foldEvents(events: DshSessionEvent[]): DshMessage[] {
  const messages: DshMessage[] = [];
  /** 当前流式 assistant 消息（跨 chunk 累积）。 */
  let current: DshMessage | null = null;
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
              current.toolCalls.push({
                id: chunk.block.id ?? 'call',
                name: chunk.block.name ?? '',
                arguments: chunk.block.arguments ?? '{}',
              });
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
      default:
        break;
    }
  }
  return messages;
}
