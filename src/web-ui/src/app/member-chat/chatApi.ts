/**
 * 会员聊天 API 客户端（桌面端免登陆版）
 *
 * 桌面端已有登录会话（tokenManager），因此聊天窗口**无需再展示登录页**：
 * - REST：复用 fetchWithAuth（自动注入 Bearer token + baseUrl + 401 刷新）
 * - WS：/api/v1/chat/ws?token=，token 经 tokenManager.getAccessToken() 获取
 *
 * 后端响应统一信封 `{ code, message, data }`。fetchWithAuth 返回整个 body，
 * 这里再取 `.data` 供 UI 使用。
 */

import { fetchWithAuth } from '@/infrastructure/auth/fetchWithAuth';
import { tokenManager } from '@/infrastructure/auth/TokenManager';

// ---- 类型（与后端 ChatChannel / ChatMessage / Member 对齐）----

export interface ChatChannel {
  id: number;
  name: string;
  description: string;
  is_dm: boolean;
  kind: string;
  parent_id: number | null;
  owner_id: number | null;
  created_at: string;
  invite_only?: boolean;
  post_policy?: string;
}

export interface ChatMessage {
  id: number;
  channel_id: number;
  topic_id: number | null;
  sender_id: number;
  sender_name: string;
  content: string;
  content_type: string;
  reply_to: number | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export interface Member {
  channel_id: number;
  member_id: number;
  member_name: string;
  role: string;
  group_id?: number | null;
  group_name?: string | null;
  permissions?: string[];
}

interface Envelope<T> {
  code: number;
  message?: string;
  data: T;
}

/** fetchWithAuth 返回整个信封，这里取其 data 字段 */
async function unwrap<T>(path: string, init?: RequestInit): Promise<T> {
  const body = await fetchWithAuth<Envelope<T>>(path, init);
  return body.data;
}

// ---- REST 端点 ----

export const chatApi = {
  /** 列出我的频道 + 房间 */
  listChannels(): Promise<{ channels: ChatChannel[] }> {
    return unwrap('/api/v1/chat/channels');
  },

  /** 列出频道消息 */
  listMessages(channelId: number, limit = 100): Promise<{ messages: ChatMessage[] }> {
    return unwrap(`/api/v1/chat/channels/${channelId}/messages?limit=${limit}`);
  },

  /** 列出频道成员 */
  listMembers(channelId: number): Promise<{ members: Member[] }> {
    return unwrap(`/api/v1/chat/channels/${channelId}/members`);
  },

  /** 发送消息 */
  sendMessage(channelId: number, content: string): Promise<{ message: ChatMessage }> {
    return unwrap(`/api/v1/chat/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  },

  /** 加入频道 */
  joinChannel(channelId: number): Promise<{ joined: boolean }> {
    return unwrap(`/api/v1/chat/channels/${channelId}/join`, { method: 'POST' });
  },

  /** 离开频道 */
  leaveChannel(channelId: number): Promise<unknown> {
    return unwrap(`/api/v1/chat/channels/${channelId}/leave`, { method: 'POST' });
  },

  /** 编辑消息（仅作者） */
  editMessage(messageId: number, content: string): Promise<unknown> {
    return unwrap(`/api/v1/chat/messages/${messageId}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  /** 删除消息（作者/频道 owner） */
  deleteMessage(messageId: number): Promise<unknown> {
    return unwrap(`/api/v1/chat/messages/${messageId}`, { method: 'DELETE' });
  },
};

// ---- 会话信息（免登陆：直接取桌面端已有会话）----

export interface MemberSession {
  memberId: number | null;
  username: string;
  isSuperAdmin: boolean;
  hasToken: boolean;
}

/** 从桌面端 tokenManager 读取当前会员会话（免登陆） */
export async function getMemberSession(): Promise<MemberSession> {
  const info = await tokenManager.getAuthInfo();
  return {
    memberId: info?.member_id ?? null,
    username: info?.username ?? '',
    isSuperAdmin: info?.member_id === 1,
    hasToken: !!info?.token,
  };
}

// ---- WebSocket 客户端 ----

export interface ChatWsEvent {
  op: string;
  channel_id?: number;
  message?: ChatMessage;
  online?: number[];
  message_id?: number;
  content?: string;
}

/**
 * 建立聊天 WebSocket。
 * @param onEvent 收到事件回调
 * @param onStatus 连接状态回调（用于 UI 显示连接状态）
 * @returns 一个控制对象：send / close
 */
export async function createChatWs(
  onEvent: (ev: ChatWsEvent) => void,
  onStatus?: (connected: boolean) => void
) {
  const token = await tokenManager.getAccessToken();
  const baseUrl = await tokenManager.getBaseUrl();
  // baseUrl 形如 http(s)://host[:port]，转成 ws(s)
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/api/v1/chat/ws?token=' + encodeURIComponent(token || '');

  const ws = new WebSocket(wsUrl);

  let subscribeChannels: number[] = [];

  ws.onopen = () => {
    onStatus?.(true);
    if (subscribeChannels.length > 0) {
      ws.send(JSON.stringify({ op: 'subscribe', channels: subscribeChannels }));
    }
  };

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as ChatWsEvent;
      onEvent(data);
    } catch {
      /* ignore malformed */
    }
  };

  ws.onclose = () => onStatus?.(false);
  ws.onerror = () => onStatus?.(false);

  return {
    /** 订阅一个或多个频道（切换频道时调用） */
    subscribe(channels: number[]) {
      subscribeChannels = channels;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: 'subscribe', channels }));
      }
    },
    /** 关闭连接 */
    close() {
      subscribeChannels = [];
      ws.close();
    },
  };
}
