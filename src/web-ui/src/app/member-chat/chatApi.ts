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

export interface ChatTopic {
  id: number;
  channel_id: number;
  name: string;
  created_by: number | null;
  created_at: string;
  updated_at: string | null;
}

export interface ChatReaction {
  id: number;
  message_id: number;
  member_id: number;
  member_name: string;
  emoji: string;
  created_at: string;
}

export interface ChatDm {
  channel_id: number;
  created_at: string;
  /** 参与者用户名列表（不含自己） */
  members: string[];
}

export interface ChatGroup {
  id: number;
  name: string;
  owner_id: number | null;
  channel_id: number | null;
  permissions: string[];
  created_at: string;
  member_count?: number;
}

export interface ChatGroupMember {
  group_id: number;
  member_id: number;
  member_name: string;
}

export interface ChatPin {
  id: number;
  channel_id: number;
  topic_id: number | null;
  message_id: number;
  pinned_by: number | null;
  created_at: string;
}

export interface ChatUnreadItem {
  channel_id: number;
  topic_id: number | null;
  last_message_id: number;
  unread_count: number;
}

// ---- 好友体系（迁移 016）----

export interface Friend {
  member_id: number;
  username: string;
  nickname: string;
  since: string;
  /** 在线快照（listFriends 时由服务端附带） */
  online?: boolean;
}

export interface FriendReq {
  id: number;
  requester_id: number;
  requester_name: string;
  addressee_id: number;
  addressee_name: string;
  status: string;
  created_at: string;
}

export interface MemberHit {
  id: number;
  username: string;
  nickname: string;
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

  /** 列出频道消息（可选按话题过滤 / before_id 向上翻页） */
  listMessages(
    channelId: number,
    opts: { topicId?: number | null; beforeId?: number; limit?: number } = {},
  ): Promise<{ messages: ChatMessage[] }> {
    const params = new URLSearchParams();
    if (opts.topicId != null) params.set('topic_id', String(opts.topicId));
    if (opts.beforeId != null) params.set('before_id', String(opts.beforeId));
    params.set('limit', String(opts.limit ?? 100));
    return unwrap(`/api/v1/chat/channels/${channelId}/messages?${params.toString()}`);
  },

  /** room 频道离线补拉（服务端内存暂存的最近消息） */
  roomRecent(channelId: number): Promise<{ messages: ChatMessage[] }> {
    return unwrap(`/api/v1/chat/channels/${channelId}/recent`);
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

  // ---- 话题 ----

  /** 列出频道话题 */
  listTopics(channelId: number): Promise<{ topics: ChatTopic[] }> {
    return unwrap(`/api/v1/chat/channels/${channelId}/topics`);
  },

  /** 创建话题 */
  createTopic(channelId: number, name: string): Promise<{ topic_id: number }> {
    return unwrap(`/api/v1/chat/channels/${channelId}/topics`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },

  // ---- 表情回应 ----

  /** 添加回应 */
  addReaction(messageId: number, emoji: string): Promise<{ reaction_id: number }> {
    return unwrap(`/api/v1/chat/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    });
  },

  /** 移除回应 */
  removeReaction(messageId: number, emoji: string): Promise<unknown> {
    return unwrap(
      `/api/v1/chat/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'DELETE' },
    );
  },

  /** 列出消息回应 */
  listReactions(messageId: number): Promise<{ reactions: ChatReaction[] }> {
    return unwrap(`/api/v1/chat/messages/${messageId}/reactions`);
  },

  // ---- 已读 / 未读 ----

  /** 更新已读游标 */
  updateRead(
    channelId: number,
    topicId: number | null,
    lastReadMessageId: number,
  ): Promise<unknown> {
    return unwrap(`/api/v1/chat/channels/${channelId}/read`, {
      method: 'PUT',
      body: JSON.stringify({ topic_id: topicId, last_read_message_id: lastReadMessageId }),
    });
  },

  /** 我的未读数 */
  myUnread(): Promise<{ unread: ChatUnreadItem[] }> {
    return unwrap('/api/v1/chat/unread');
  },

  // ---- 私信 ----

  /** 创建私信会话（返回 channel_id） */
  createDm(memberIds: number[]): Promise<{ channel_id: number }> {
    return unwrap('/api/v1/chat/dm', {
      method: 'POST',
      body: JSON.stringify({ member_ids: memberIds }),
    });
  },

  /** 列出我的私信会话 */
  listDms(): Promise<{ dms: ChatDm[] }> {
    return unwrap('/api/v1/chat/dm');
  },

  // ---- 频道管理 ----

  /** 创建频道/房间 */
  createChannel(body: {
    name: string;
    description?: string;
    kind: 'official' | 'room';
    parent_id?: number | null;
    invite_only?: boolean;
    post_policy?: string;
  }): Promise<{ channel_id: number }> {
    return unwrap('/api/v1/chat/channels', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** 更新频道设置（owner/admin） */
  updateChannelSettings(
    channelId: number,
    body: {
      name?: string;
      description?: string;
      invite_only?: boolean;
      post_policy?: string;
    },
  ): Promise<unknown> {
    return unwrap(`/api/v1/chat/channels/${channelId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  /** 添加频道成员（owner/admin） */
  addChannelMember(
    channelId: number,
    memberId: number,
    groupId?: number | null,
  ): Promise<unknown> {
    return unwrap(`/api/v1/chat/channels/${channelId}/members`, {
      method: 'POST',
      body: JSON.stringify({ member_id: memberId, group_id: groupId ?? null }),
    });
  },

  /** 移除频道成员（owner/admin） */
  removeChannelMember(channelId: number, memberId: number): Promise<unknown> {
    return unwrap(`/api/v1/chat/channels/${channelId}/members/${memberId}`, {
      method: 'DELETE',
    });
  },

  /** 设置频道成员所属分组（owner） */
  setMemberGroup(
    channelId: number,
    memberId: number,
    groupId: number | null,
  ): Promise<unknown> {
    return unwrap(`/api/v1/chat/channels/${channelId}/members/${memberId}/group`, {
      method: 'PUT',
      body: JSON.stringify({ group_id: groupId }),
    });
  },

  // ---- 置顶 / 移动 ----

  /** 置顶消息（仅 official 频道） */
  pinMessage(messageId: number): Promise<{ pin_id: number }> {
    return unwrap(`/api/v1/chat/messages/${messageId}/pin`, { method: 'POST' });
  },

  /** 取消置顶 */
  unpinMessage(messageId: number): Promise<unknown> {
    return unwrap(`/api/v1/chat/messages/${messageId}/pin`, { method: 'DELETE' });
  },

  /** 列出频道置顶消息 */
  listPins(channelId: number): Promise<{ pins: ChatPin[] }> {
    return unwrap(`/api/v1/chat/channels/${channelId}/pins`);
  },

  /** 移动消息到目标频道/话题（仅 official） */
  moveMessage(
    messageId: number,
    targetChannelId: number,
    targetTopicId?: number | null,
  ): Promise<unknown> {
    return unwrap(`/api/v1/chat/messages/${messageId}/move`, {
      method: 'POST',
      body: JSON.stringify({
        target_channel_id: targetChannelId,
        target_topic_id: targetTopicId ?? null,
      }),
    });
  },

  // ---- 会员分组 ----

  /** 列出分组（可选按频道过滤） */
  listGroups(channelId?: number): Promise<{ groups: ChatGroup[] }> {
    const q = channelId != null ? `?channel_id=${channelId}` : '';
    return unwrap(`/api/v1/chat/groups${q}`);
  },

  /** 创建分组 */
  createGroup(
    name: string,
    channelId: number | null,
    permissions: string[] = [],
  ): Promise<{ group_id: number }> {
    return unwrap('/api/v1/chat/groups', {
      method: 'POST',
      body: JSON.stringify({ name, channel_id: channelId, permissions }),
    });
  },

  /** 分组详情（含成员） */
  getGroup(groupId: number): Promise<{ group: ChatGroup; members: ChatGroupMember[] }> {
    return unwrap(`/api/v1/chat/groups/${groupId}`);
  },

  /** 删除分组 */
  deleteGroup(groupId: number): Promise<unknown> {
    return unwrap(`/api/v1/chat/groups/${groupId}`, { method: 'DELETE' });
  },

  /** 更新分组权限 */
  updateGroupPermissions(groupId: number, permissions: string[]): Promise<unknown> {
    return unwrap(`/api/v1/chat/groups/${groupId}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissions }),
    });
  },

  /** 添加分组成员 */
  addGroupMember(groupId: number, memberId: number): Promise<unknown> {
    return unwrap(`/api/v1/chat/groups/${groupId}/members`, {
      method: 'POST',
      body: JSON.stringify({ member_id: memberId }),
    });
  },

  /** 移除分组成员 */
  removeGroupMember(groupId: number, memberId: number): Promise<unknown> {
    return unwrap(`/api/v1/chat/groups/${groupId}/members/${memberId}`, {
      method: 'DELETE',
    });
  },

  // ---- 好友体系 ----

  /** 好友列表（含在线状态快照） */
  listFriends(): Promise<{ friends: Friend[] }> {
    return unwrap('/api/v1/friends');
  },

  /** 我收到的待处理申请 */
  listFriendRequests(): Promise<{ requests: FriendReq[] }> {
    return unwrap('/api/v1/friends/requests');
  },

  /** 发起好友申请 */
  sendFriendRequest(memberId: number): Promise<FriendReq> {
    return unwrap('/api/v1/friends/requests', {
      method: 'POST',
      body: JSON.stringify({ member_id: memberId }),
    });
  },

  /** 接受好友申请 */
  acceptFriendRequest(requestId: number): Promise<{ ok: boolean }> {
    return unwrap(`/api/v1/friends/requests/${requestId}/accept`, { method: 'POST' });
  },

  /** 拒绝好友申请 */
  rejectFriendRequest(requestId: number): Promise<{ ok: boolean }> {
    return unwrap(`/api/v1/friends/requests/${requestId}/reject`, { method: 'POST' });
  },

  /** 删除好友 */
  removeFriend(memberId: number): Promise<{ deleted: boolean }> {
    return unwrap(`/api/v1/friends/${memberId}`, { method: 'DELETE' });
  },

  /** 用户名前缀搜索会员（脱敏） */
  searchMembers(q: string, limit = 10): Promise<{ hits: MemberHit[] }> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return unwrap(`/api/v1/members/search?${params.toString()}`);
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
  topic_id?: number | null;
  message?: ChatMessage;
  /** presence 事件：频道在线成员 id；member_presence 事件：true/false 上下线 */
  online?: number[] | boolean;
  message_id?: number;
  content?: string;
  /** reaction 事件：{ id?, member_id, emoji } */
  reaction?: { id?: number; member_id: number; emoji: string };
  removed?: boolean;
  /** pin 事件：true=置顶 false=取消 */
  pinned?: boolean;
  /** typing 事件：输入中的会员 id */
  member_id?: number;
  // ---- 好友事件 ----
  /** friend_request：收到的申请 */
  request?: FriendReq;
  /** friend_accepted：新好友（accept 场景为 acceptor；自动互认为对方） */
  friend?: { member_id: number; username: string };
  /** friend_removed：被删除的关系中对方的 member id */
  other_member_id?: number;
}

/**
 * 建立聊天 WebSocket。
 * @param onEvent 收到事件回调
 * @param onStatus 连接状态回调（用于 UI 显示连接状态）
 * @returns 一个控制对象：send / subscribe / sendTyping / close
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
    /** 发送 typing 状态（UI 层负责节流） */
    sendTyping(channelId: number, topicId?: number | null) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({ op: 'typing', channel_id: channelId, topic_id: topicId ?? null }),
      );
    },
    /** 关闭连接 */
    close() {
      subscribeChannels = [];
      ws.close();
    },
  };
}
