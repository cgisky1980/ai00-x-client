/**
 * chatWsClient — 带自动重连的聊天 WebSocket 客户端
 *
 * - 指数退避 + 抖动重连（1s→2s→4s→…上限 30s，不限次数，窗口常驻）
 * - 重连成功后自动重订阅全部频道（subscribeChannels 保存在客户端内）
 * - 监听 online/offline 与 visibilitychange，恢复时立即重连
 * - 看门狗：>60s 无任何帧主动断开触发重连（防半开连接；服务端 25s 应用层 ping）
 * - 状态回调四态：connecting / online / offline / reconnecting
 */
import { tokenManager } from '@/infrastructure/auth/TokenManager';
import type { ChatWsEvent } from './chatApi';

export type ChatConnectionStatus = 'connecting' | 'online' | 'offline' | 'reconnecting';

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const WATCHDOG_MS = 60_000;

export interface ChatWsClient {
  /** 订阅频道（全量替换；重连后自动重发） */
  subscribe(channels: number[]): void;
  /** 发送 typing（UI 层负责节流） */
  sendTyping(channelId: number, topicId?: number | null): void;
  /** 私聊送达回执：通知发送方「这些 client_msg_id 已存入我的本机」 */
  sendDmAck(to: number, clientMsgIds: string[]): void;
  /** 关闭并停止重连 */
  close(): void;
}

export async function createChatWsClient(
  onEvent: (ev: ChatWsEvent) => void,
  onStatus: (status: ChatConnectionStatus) => void,
): Promise<ChatWsClient> {
  let ws: WebSocket | null = null;
  let disposed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lastFrameAt = 0;
  const subscribeChannels = new Set<number>();

  const setStatus = (s: ChatConnectionStatus) => {
    if (!disposed) onStatus(s);
  };

  const clearTimers = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const startWatchdog = () => {
    if (watchdogTimer) clearInterval(watchdogTimer);
    lastFrameAt = Date.now();
    watchdogTimer = setInterval(() => {
      if (ws && Date.now() - lastFrameAt > WATCHDOG_MS) {
        // 半开连接：主动断开，onclose 会触发重连
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }, 30_000);
  };

  async function connect(): Promise<void> {
    if (disposed) return;
    clearTimers();
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

    let wsUrl: string;
    try {
      const token = await tokenManager.getAccessToken();
      const baseUrl = await tokenManager.getBaseUrl();
      wsUrl =
        baseUrl.replace(/^http/, 'ws') +
        '/api/v1/chat/ws?token=' +
        encodeURIComponent(token || '');
    } catch {
      scheduleReconnect();
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      attempt = 0;
      setStatus('online');
      startWatchdog();
      if (subscribeChannels.size > 0) {
        socket.send(
          JSON.stringify({ op: 'subscribe', channels: [...subscribeChannels] }),
        );
      }
    };

    socket.onmessage = (ev) => {
      lastFrameAt = Date.now();
      try {
        onEvent(JSON.parse(ev.data as string) as ChatWsEvent);
      } catch {
        /* ignore malformed */
      }
    };

    socket.onclose = (ev) => {
      if (disposed || ws !== socket) return;
      ws = null;
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      // 正常关闭（主动 dispose / 服务端优雅关闭）不重连，其余一律重连
      if (ev.code === 1000 && disposed) return;
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (ws === socket) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    };
  };

  function scheduleReconnect(): void {
    if (disposed) return;
    setStatus('reconnecting');
    const backoff = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    const delay = Math.round(backoff * (0.5 + Math.random() * 0.5));
    attempt += 1;
    reconnectTimer = setTimeout(() => void connect(), delay);
  }

  // 网络恢复 / 页面可见 → 立即重连（仅当当前未连接）
  const onOnline = () => {
    if (!disposed && (!ws || ws.readyState > WebSocket.OPEN)) {
      attempt = 0;
      void connect();
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') onOnline();
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);

  void connect();

  return {
    subscribe(channels: number[]) {
      subscribeChannels.clear();
      for (const c of channels) subscribeChannels.add(c);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: 'subscribe', channels: [...subscribeChannels] }));
      }
    },
    sendTyping(channelId: number, topicId?: number | null) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ op: 'typing', channel_id: channelId, topic_id: topicId ?? null }),
        );
      }
    },
    sendDmAck(to: number, clientMsgIds: string[]) {
      if (ws && ws.readyState === WebSocket.OPEN && clientMsgIds.length > 0) {
        ws.send(JSON.stringify({ op: 'dm_ack', to, client_msg_ids: clientMsgIds }));
      }
    },
    close() {
      disposed = true;
      clearTimers();
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
    },
  };
}
