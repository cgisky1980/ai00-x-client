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
  /** 'official'（顶层频道=分类容器，不可发言，有频道主页）| 'room'（房间=频道子级，可发言且落库） */
  kind: string;
  parent_id: number | null;
  owner_id: number | null;
  created_at: string;
  invite_only?: boolean;
  post_policy?: string;
  /** 频道通告（迁移 018，仅 owner/admin 可编辑） */
  announcement?: string;
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
  /** 客户端幂等 id：DM 补发/去重/送达对齐用（服务端仅透传不存储） */
  client_msg_id?: string;
  /** 本地状态（仅发送方本机 IndexedDB 维护）：pending=等待送达回执 */
  status?: 'pending' | 'sent';
  /** 发送者头像（data URL；历史本地 DM 消息可能无此字段） */
  sender_avatar?: string | null;
}

export interface Member {
  channel_id: number;
  member_id: number;
  member_name: string;
  /** 成员头像（data URL；未设置时无） */
  member_avatar?: string | null;
  role: string;
  group_id?: number | null;
  group_name?: string | null;
  permissions?: string[];
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
  /** 对方头像（data URL；未设置时无） */
  peer_avatar?: string | null;
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
  /** 好友头像（data URL；未设置时无） */
  avatar?: string | null;
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

  /** 列出频道消息（before_id 向上翻页） */
  listMessages(
    channelId: number,
    opts: { beforeId?: number; limit?: number } = {},
  ): Promise<{ messages: ChatMessage[] }> {
    const params = new URLSearchParams();
    if (opts.beforeId != null) params.set('before_id', String(opts.beforeId));
    params.set('limit', String(opts.limit ?? 100));
    return unwrap(`/api/v1/chat/channels/${channelId}/messages?${params.toString()}`);
  },

  /** 列出频道成员 */
  listMembers(channelId: number): Promise<{ members: Member[] }> {
    return unwrap(`/api/v1/chat/channels/${channelId}/members`);
  },

  /** 发送消息（clientMsgId：DM 幂等 id，重发/去重/送达对齐用） */
  sendMessage(
    channelId: number,
    content: string,
    clientMsgId?: string,
  ): Promise<{ message: ChatMessage }> {
    return unwrap(`/api/v1/chat/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, client_msg_id: clientMsgId }),
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
  updateRead(channelId: number, lastReadMessageId: number): Promise<unknown> {
    return unwrap(`/api/v1/chat/channels/${channelId}/read`, {
      method: 'PUT',
      body: JSON.stringify({ topic_id: null, last_read_message_id: lastReadMessageId }),
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
      announcement?: string;
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

  // ---- 个人资料（/api/v1/me/profile）----

  /** 读取我的资料（账号只读字段 + 可编辑 nickname/bio/avatarData） */
  getMyProfile(): Promise<MyProfile> {
    return unwrap('/api/v1/me/profile');
  },

  /** 更新我的资料（全量提交可编辑字段；null/空串 = 清空该字段；profileTheme 不传 = 保留原值） */
  updateMyProfile(input: UpdateMyProfileInput): Promise<PickedProfile> {
    return unwrap('/api/v1/me/profile', {
      method: 'PUT',
      body: JSON.stringify({
        nickname: input.nickname ?? null,
        bio: input.bio ?? null,
        avatar_data: input.avatarData ?? null,
        profile_theme: input.profileTheme ?? null,
      }),
    });
  },
};

// ---- 个人资料类型（/api/v1/me/profile）----

export interface MyProfile {
  memberId: number;
  username: string;
  email: string;
  planTier: string;
  createdAt: string;
  nickname: string | null;
  bio: string | null;
  avatarData: string | null;
  /** 主页主题模板（xuanzhi/juan/yinzhang） */
  profileTheme: string;
}

export interface UpdateMyProfileInput {
  nickname?: string | null;
  bio?: string | null;
  avatarData?: string | null;
  profileTheme?: string | null;
}

type PickedProfile = Pick<MyProfile, 'nickname' | 'bio' | 'avatarData' | 'profileTheme'>;

/** 修改密码（成功后服务端吊销当前 access token，需重新登录） */
export async function changeMemberPassword(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  await fetchWithAuth<{ code: number; message?: string }>('/api/v1/auth/member/password', {
    method: 'PUT',
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  });
}

/** 会员登出：吊销 refresh token + 清理本机会话（之后聊天窗口回到未登录引导态） */
export async function memberLogout(): Promise<void> {
  try {
    const refreshToken = await tokenManager.getRefreshToken();
    if (refreshToken) {
      await fetchWithAuth<{ code: number; message?: string }>('/api/v1/auth/member/logout', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    }
  } finally {
    await tokenManager.clearTokens();
  }
}

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

// ---- WebSocket 事件类型（客户端实现在 chatWsClient.ts，带自动重连） ----

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
  /** dm_ack 回执：发送方 member_id */
  from?: number;
  /** dm_ack 回执：已送达的客户端消息 id 列表 */
  client_msg_ids?: string[];
  // ---- 社区事件 ----
  /** community_notice：轻量通知载荷（id/kind/post_id/comment_id/actor_id），完整内容拉通知列表渲染 */
  notice?: Record<string, unknown>;
}
