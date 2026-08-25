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

export interface DshSessionModels {
  current: DshModelSelection;
  routable: boolean;
  groups: Array<{
    id: string;
    name: string;
    models: Array<{ id: string; name: string; description?: string }>;
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
  | { type: 'stream/error'; error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// RPC 底座
// ---------------------------------------------------------------------------

let rpcSeq = 0;

/** dsh sidecar 健康探测（引擎是否在线）。 */
export async function dshReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${DSH_BASE}/api/host.describe`, {
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
  const res = await fetch(`${DSH_BASE}/api/${method}`, {
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
// 引擎生命周期（Tauri 命令 → DshManager）
// ---------------------------------------------------------------------------

export const dshEngine = {
  status: () => tauriInvoke<DshStatus>('dsh_status'),
  ensureReady: () => tauriInvoke<DshStatus>('dsh_ensure_ready'),
  stop: () => tauriInvoke<DshStatus>('dsh_stop'),
  /** 订阅安装/运行阶段事件（返回取消函数）。 */
  onPhase: (cb: (phase: DshPhase) => void): Promise<() => void> =>
    tauriListen<DshPhase>('dsh://phase', e => cb(e.payload)),
};

// ---------------------------------------------------------------------------
// 会话 API（HTTP unary）
// ---------------------------------------------------------------------------

export const dshSession = {
  list: () => rpc<{ items: DshSessionSummary[] }>('session.list', {}),

  create: (cwd: string) =>
    rpc<{ sessionId: string; agentPreset?: string }>('session.create', { cwd }),

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

/** 订阅 mux 事件流（自动重连）。返回连接句柄。 */
export function connectMux(
  onFrame: (frame: DshMuxFrame) => void,
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
          payload: DshMuxFrame;
        };
        if (msg.type === 'server-request' && msg.payload) {
          onFrame(msg.payload);
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
