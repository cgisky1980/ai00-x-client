/**
 * memberChatStore — 会员聊天数据层（zustand 单 store）
 *
 * 全部业务状态与动作集中于此：会话/频道/好友加载、WS 事件应用、消息收发、
 * 成员与好友管理。组件只消费 selector，不再持有业务状态（消灭 25 个 useState
 * 与 WS 闭包补丁——store 读取永远最新）。
 */
import { create } from 'zustand';
import { i18nService } from '@/infrastructure/i18n';
import {
  chatApi,
  getMemberSession,
  type ChatChannel,
  type ChatDm,
  type ChatMessage,
  type ChatReaction,
  type ChatUnreadItem,
  type Friend,
  type FriendReq,
  type Member,
  type MemberSession,
  type MyProfile,
  type UpdateMyProfileInput,
} from '../chatApi';
import { createChatWsClient, type ChatConnectionStatus, type ChatWsClient } from '../chatWsClient';
import type { RailTab } from '../components/RailNav';
import {
  dmAppendMessages,
  dmBumpUnread,
  dmClearMessages,
  dmGetAllMeta,
  dmGetMessagesPage,
  dmGetPending,
  dmMarkRead,
  dmMarkSentByClientIds,
} from '../localStore';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { useCommunityStore } from '../community/communityStore';

/** 桌面通知开关 localStorage key（设置页「通知与隐私」读写，store 触发时读） */
export const NOTIFY_DESKTOP_KEY = 'memberChat.notifyDesktop';

/** 非当前会话收到新消息 → 系统通知（开关关闭/非桌面环境静默跳过） */
async function notifyNewMessage(senderName: string, preview: string): Promise<void> {
  try {
    if (localStorage.getItem(NOTIFY_DESKTOP_KEY) !== '1') return;
    const body = preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
    await systemAPI.sendSystemNotification(senderName, body);
  } catch {
    // 通知失败不影响消息处理
  }
}

/** 消息流页大小（官方频道服务端硬上限 100；DM 本地分页同刻度） */
const MESSAGE_PAGE_SIZE = 100;

export type ConversationType = 'dm' | 'official' | 'room';

export interface TypingUser {
  id: number;
  name: string;
  at: number;
}

/** 会话列表预览/排序元数据（channelId → 最近消息） */
export interface ConvMeta {
  lastMsgAt: number;
  lastMsgPreview: string;
}

interface MemberChatState {
  // 会话与连接
  session: MemberSession | null;
  connection: ChatConnectionStatus;
  // rail 功能页签（社区「发消息」等跨视图跳转需要，提升进 store）
  railTab: RailTab;
  // 个人资料（设置页 + rail 头像共享）
  myProfile: MyProfile | null;
  // 列表
  channels: ChatChannel[];
  dms: ChatDm[];
  friends: Friend[];
  friendReqs: FriendReq[];
  convMeta: Record<number, ConvMeta>;
  // 当前会话
  currentId: number | null;
  // 消息
  messages: ChatMessage[];
  reactions: Record<number, ChatReaction[]>;
  hasMore: boolean;
  loadingOlder: boolean;
  loadingMessages: boolean;
  // 频道元数据
  members: Member[];
  online: Set<number>;
  pins: import('../chatApi').ChatPin[];
  typing: TypingUser[];
  unread: Record<number, number>;
  // 输入与提示
  sending: boolean;
  error: string | null;
  notice: string | null;
  // 动作
  setRailTab(tab: RailTab): void;
  initSession(): Promise<void>;
  loadMyProfile(): Promise<void>;
  saveMyProfile(input: UpdateMyProfileInput): Promise<boolean>;
  refreshChannels(): Promise<void>;
  refreshFriends(): Promise<void>;
  refreshUnread(): Promise<void>;
  selectChannel(id: number, chOverride?: ChatChannel): Promise<void>;
  loadOlder(): Promise<void>;
  sendMessage(text: string): Promise<boolean>;
  touchTyping(): void;
  editMessage(id: number, text: string): Promise<void>;
  deleteMessage(id: number): Promise<void>;
  react(id: number, emoji: string): Promise<void>;
  unreact(id: number, emoji: string): Promise<void>;
  pinToggle(id: number, pinned: boolean): Promise<void>;
  addMember(memberId: number): Promise<void>;
  removeMember(memberId: number): Promise<void>;
  createDm(memberId: number, fallbackName: string): Promise<void>;
  removeFriend(f: Friend): Promise<void>;
  respondFriendReq(id: number, accept: boolean): Promise<void>;
  clearDmHistory(): Promise<void>;
  applyWsEvent(ev: Record<string, unknown>): void;
  clearError(): void;
  clearNotice(): void;
}

// 模块级（非响应式）：WS 客户端、本地序列、节流
let wsClient: ChatWsClient | null = null;
let roomSeq = 0;
let typingThrottleAt = 0;
let typingPruneStarted = false;

/** 查频道（含 DM 伪频道映射） */
export function findChannelIn(
  channels: ChatChannel[],
  dms: ChatDm[],
  id: number | null,
): ChatChannel | undefined {
  if (id == null) return undefined;
  const ch = channels.find((c) => c.id === id);
  if (ch) return ch;
  const d = dms.find((x) => x.channel_id === id);
  if (d) {
    return {
      id: d.channel_id,
      name: d.members.join(', ') || '私信',
      description: '',
      is_dm: true,
      kind: 'official',
      parent_id: null,
      owner_id: null,
      created_at: d.created_at,
    };
  }
  return undefined;
}

/** 会话类型判定 */
export function conversationType(ch: ChatChannel | undefined, isDm: boolean): ConversationType {
  if (isDm) return 'dm';
  if (ch?.kind === 'room') return 'room';
  return 'official';
}

/**
 * 消息流统一时间正序（旧上、新下）。
 * 防御性排序：官方频道历史（后端翻页窗口 DESC 取数）、room 补拉、loadOlder 拼接，
 * 无论后端返回顺序如何，渲染与翻页都保持正确。
 * 排序键：正常消息用服务端 id（DM/room 本地临时消息 id 为负本地序且重复加载会重赋，
 * 故按 created_at 时间戳）；pending 乐观消息永远粘在流末尾（V8 稳定排序保持插入序）。
 */
function sortAsc(messages: ChatMessage[]): ChatMessage[] {
  const rank = (m: ChatMessage): number => {
    if (m.status === 'pending') return Number.MAX_SAFE_INTEGER;
    if (m.id > 0) return m.id;
    const t = Date.parse(m.created_at || '');
    return Number.isNaN(t) ? 0 : t;
  };
  return [...messages].sort((a, b) => rank(a) - rank(b));
}

/** 当前频道的我的权限（组件用） */
export function computeMyPerms(
  session: MemberSession | null,
  members: Member[],
): {
  isOwner: boolean;
  canManageMessages: boolean;
  canManageMembers: boolean;
  canManageRooms: boolean;
} {
  const myMember = members.find((m) => m.member_id === session?.memberId);
  const isOwner = !!session && (session.isSuperAdmin || myMember?.role === 'owner');
  const perms = isOwner
    ? ['create_rooms', 'manage_members', 'manage_messages', 'manage_rooms']
    : myMember?.permissions || [];
  return {
    isOwner,
    canManageMessages: perms.includes('manage_messages'),
    canManageMembers: perms.includes('manage_members'),
    canManageRooms: perms.includes('manage_rooms'),
  };
}

export const useMemberChatStore = create<MemberChatState>((set, get) => {
  /** DM 本地翻页游标：channelId → 当前已加载最旧一条的本地 seq（keyset 向前翻） */
  const dmOldestSeq = new Map<number, number>();

  /** room/DM 临时消息 id 归一化（服务端 id=0 占位 → 本地负数） */
  const normalizeMessage = (m: ChatMessage): ChatMessage => {
    if (m.id === 0) {
      roomSeq += 1;
      return { ...m, id: -roomSeq };
    }
    return m;
  };

  const loadReactions = async (msgs: ChatMessage[]) => {
    const ids = msgs.filter((m) => m.id > 0).map((m) => m.id);
    if (ids.length === 0) return;
    const results = await Promise.allSettled(ids.map((id) => chatApi.listReactions(id)));
    const map: Record<number, ChatReaction[]> = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') map[ids[i]] = r.value.reactions || [];
    });
    set((s) => ({ reactions: { ...s.reactions, ...map } }));
  };

  const loadMessages = async (ch: ChatChannel) => {
    set({ loadingMessages: true });
    try {
      if (ch.is_dm) {
        // 私聊：仅读本机 IndexedDB（服务端不落库也不暂存，明文不留服务器）；
        // 本地同样分页读取（最近一页），向上滚动由 loadOlder 继续翻
        try {
          const page = await dmGetMessagesPage(ch.id, { limit: MESSAGE_PAGE_SIZE });
          dmOldestSeq.set(ch.id, page.length > 0 ? page[0].seq : 0);
          set({
            messages: page.map(normalizeMessage),
            hasMore: page.length >= MESSAGE_PAGE_SIZE,
          });
        } catch (e) {
          set({ error: (e as Error).message });
        }
        return;
      }
      // 频道/房间：服务端落库加载（迁移 018 后房间与官方消息同一链路）
      const msgData = await chatApi.listMessages(ch.id);
      const list = sortAsc((msgData.messages || []).filter((m) => !m.deleted_at));
      set({ messages: list, hasMore: list.length >= MESSAGE_PAGE_SIZE });
      void loadReactions(list);
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loadingMessages: false });
    }
  };

  const markRead = (lastMessageId: number) => {
    const { currentId } = get();
    if (currentId == null || lastMessageId <= 0) return;
    chatApi.updateRead(currentId, lastMessageId).catch(() => {});
  };

  /** 更新会话列表预览与最近活跃时间 */
  const touchConversation = (channelId: number, preview: string) => {
    set((s) => ({
      convMeta: {
        ...s.convMeta,
        [channelId]: { lastMsgAt: Date.now(), lastMsgPreview: preview },
      },
    }));
  };

  return {
    session: null,
    connection: 'connecting',
    railTab: 'community',
    myProfile: null,
    channels: [],
    dms: [],
    friends: [],
    friendReqs: [],
    convMeta: {},
    currentId: null,
    messages: [],
    reactions: {},
    hasMore: false,
    loadingOlder: false,
    loadingMessages: false,
    members: [],
    online: new Set(),
    pins: [],
    typing: [],
    unread: {},
    sending: false,
    error: null,
    notice: null,

    initSession: async () => {
      const s = await getMemberSession();
      set({ session: s });
      if (!s.hasToken) return;
      // 恢复私聊本地未读（服务端 unread 不含不落库的 DM）
      try {
        const metas = await dmGetAllMeta();
        set((st) => {
          const unread = { ...st.unread };
          for (const m of metas) {
            if (m.unread > 0) unread[m.channel_id] = m.unread;
          }
          return { unread };
        });
      } catch {
        /* IndexedDB 不可用时静默降级 */
      }
      void get().refreshChannels();
      void get().refreshFriends();
      void get().loadMyProfile();
      void ensureWs();
      // typing 指示 3s 过期清理（全局仅启动一次）
      if (!typingPruneStarted) {
        typingPruneStarted = true;
        setInterval(() => {
          const prev = get().typing;
          const next = prev.filter((x) => Date.now() - x.at < 3000);
          if (next.length !== prev.length) set({ typing: next });
        }, 1000);
      }
    },

    loadMyProfile: async () => {
      try {
        const p = await chatApi.getMyProfile();
        set({ myProfile: p });
      } catch {
        /* 资料拉取失败不阻塞主流程（头像/昵称走 fallback） */
      }
    },

    saveMyProfile: async (input) => {
      try {
        const picked = await chatApi.updateMyProfile(input);
        set((s) => ({
          myProfile: s.myProfile ? { ...s.myProfile, ...picked } : null,
          notice: i18nService.t('memberChat.profileSaved', { defaultValue: '资料已保存' }),
        }));
        return true;
      } catch (e) {
        set({ error: (e as Error).message });
        return false;
      }
    },

    refreshUnread: async () => {
      try {
        const { unread: items } = await chatApi.myUnread();
        const map: Record<number, number> = {};
        for (const it of items as ChatUnreadItem[]) {
          map[it.channel_id] = (map[it.channel_id] || 0) + it.unread_count;
        }
        // 服务端未读不含私聊（不落库）；剔除可能残留的 DM 旧游标行，保留本地 DM 未读
        const { dms } = get();
        const dmIds = new Set(dms.map((d) => d.channel_id));
        const officialOnly = Object.fromEntries(
          Object.entries(map).filter(([k]) => !dmIds.has(Number(k))),
        );
        set((s) => {
          const dmUnread = Object.fromEntries(
            Object.entries(s.unread).filter(([k]) => dmIds.has(Number(k))),
          );
          return { unread: { ...officialOnly, ...dmUnread } };
        });
      } catch {
        /* 忽略 */
      }
    },

    refreshChannels: async () => {
      const prevId = get().currentId;
      try {
        const data = await chatApi.listChannels();
        set((s) => ({
          channels: data.channels || [],
          currentId:
            s.currentId != null && data.channels?.some((c) => c.id === s.currentId)
              ? s.currentId
              : data.channels?.length
                ? data.channels[0].id
                : null,
        }));
      } catch (e) {
        set({ error: (e as Error).message });
      }
      try {
        const dmData = await chatApi.listDms();
        set({ dms: dmData.dms || [] });
      } catch {
        /* 忽略 */
      }
      const { channels, dms, currentId } = get();
      wsClient?.subscribe([...channels.map((c) => c.id), ...dms.map((d) => d.channel_id)]);
      // 首次进入（无选中）：自动选中并加载第一个频道
      if (prevId == null && currentId != null) {
        void get().selectChannel(currentId);
      }
      void get().refreshUnread();
    },

    refreshFriends: async () => {
      try {
        const [fData, rData] = await Promise.all([
          chatApi.listFriends(),
          chatApi.listFriendRequests(),
        ]);
        set({ friends: fData.friends || [], friendReqs: rData.requests || [] });
      } catch {
        /* 忽略 */
      }
    },

    selectChannel: async (id, chOverride) => {
      const s = get();
      const ch = chOverride ?? findChannelIn(s.channels, s.dms, id);
      set({
        currentId: id,
        messages: [],
        reactions: {},
        members: [],
        online: new Set(),
        pins: [],
        unread: { ...s.unread, [id]: 0 },
      });
      if (!ch) return;
      if (ch.is_dm) void dmMarkRead(id); // 私聊进入即本地已读
      void loadMessages(ch);
      try {
        const mData = await chatApi.listMembers(id);
        set({ members: mData.members || [] });
      } catch {
        /* 可能非成员，忽略 */
      }
      if (ch.kind === 'official' || ch.kind === 'room') {
        try {
          const pData = await chatApi.listPins(id);
          set({ pins: pData.pins || [] });
        } catch {
          /* 忽略 */
        }
      }
    },

    loadOlder: async () => {
      const s = get();
      const ch = findChannelIn(s.channels, s.dms, s.currentId);
      if (!ch || s.loadingOlder || s.messages.length === 0) return;
      set({ loadingOlder: true });
      try {
        // DM：本地 IndexedDB keyset 翻页（seq < oldestSeq），返回升序
        if (ch.is_dm) {
          const beforeSeq = dmOldestSeq.get(ch.id) ?? 0;
          if (beforeSeq <= 0) {
            set({ hasMore: false });
            return;
          }
          const page = await dmGetMessagesPage(ch.id, { beforeSeq, limit: MESSAGE_PAGE_SIZE });
          if (page.length === 0) {
            set({ hasMore: false });
            return;
          }
          dmOldestSeq.set(ch.id, page[0].seq);
          set((st) => ({
            messages: sortAsc([...page.map(normalizeMessage), ...st.messages]),
            hasMore: page.length >= MESSAGE_PAGE_SIZE,
          }));
          return;
        }
        const oldest = s.messages.find((m) => m.id > 0);
        if (!oldest) return;
        const { messages: older } = await chatApi.listMessages(ch.id, {
          beforeId: oldest.id,
        });
        const list = (older || []).filter((m) => !m.deleted_at);
        if (list.length === 0) {
          set({ hasMore: false });
        } else {
          set((st) => ({ messages: sortAsc([...list, ...st.messages]) }));
          void loadReactions(list);
          set({ hasMore: list.length >= MESSAGE_PAGE_SIZE });
        }
      } catch (e) {
        set({ error: (e as Error).message });
      } finally {
        set({ loadingOlder: false });
      }
    },

    sendMessage: async (text) => {
      const { currentId, sending } = get();
      if (!text || currentId == null || sending) return false;
      const ch = findChannelIn(get().channels, get().dms, currentId);
      if (!ch) return false;
      set({ sending: true });
      try {
        if (ch.is_dm) {
          // 私聊：乐观插入本机（pending）→ REST → 等对方 dm_ack 回执标记已送达。
          // 失败也保留 pending，由「对方上线自动补发」兜底。
          const clientMsgId = genClientMsgId();
          const optimistic: ChatMessage = {
            id: 0,
            channel_id: currentId,
            topic_id: null,
            sender_id: get().session?.memberId ?? 0,
            sender_name: get().session?.username ?? '',
            content: text,
            content_type: 'text',
            reply_to: null,
            created_at: new Date().toISOString(),
            edited_at: null,
            deleted_at: null,
            client_msg_id: clientMsgId,
            status: 'pending',
          };
          const norm = normalizeMessage(optimistic);
          set((st) => ({
            messages: st.messages.some((x) => x.client_msg_id === clientMsgId)
              ? st.messages
              : [...st.messages, norm],
          }));
          void (async () => {
            await dmAppendMessages(currentId, [optimistic], 'pending');
            await dmMarkRead(currentId);
          })();
          await chatApi.sendMessage(currentId, text, clientMsgId);
          return true; // 已广播；pending→sent 由对方 ack 驱动
        }
        await chatApi.sendMessage(currentId, text);
        return true; // 消息经 WS 回显
      } catch (e) {
        set({ error: (e as Error).message });
        return false;
      } finally {
        set({ sending: false });
      }
    },

    touchTyping: () => {
      const { currentId } = get();
      const now = Date.now();
      if (currentId != null && now - typingThrottleAt > 2000) {
        typingThrottleAt = now;
        wsClient?.sendTyping(currentId, null);
      }
    },

    editMessage: async (id, text) => {
      if (id <= 0) return; // room/DM 临时消息不可编辑
      try {
        await chatApi.editMessage(id, text);
        set((s) => ({
          messages: s.messages.map((x) => (x.id === id ? { ...x, content: text } : x)),
        }));
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    deleteMessage: async (id) => {
      if (id <= 0) return;
      try {
        await chatApi.deleteMessage(id);
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    react: async (id, emoji) => {
      if (id <= 0) return;
      try {
        await chatApi.addReaction(id, emoji);
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    unreact: async (id, emoji) => {
      if (id <= 0) return;
      try {
        await chatApi.removeReaction(id, emoji);
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    pinToggle: async (id, pinned) => {
      if (id <= 0) return;
      try {
        if (pinned) await chatApi.unpinMessage(id);
        else await chatApi.pinMessage(id);
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    addMember: async (memberId) => {
      const { currentId } = get();
      if (!currentId || !memberId) return;
      try {
        await chatApi.addChannelMember(currentId, memberId);
        const mData = await chatApi.listMembers(currentId);
        set({ members: mData.members || [] });
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    removeMember: async (memberId) => {
      const { currentId } = get();
      if (!currentId) return;
      try {
        await chatApi.removeChannelMember(currentId, memberId);
        set((s) => ({ members: s.members.filter((m) => m.member_id !== memberId) }));
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    createDm: async (memberId, fallbackName) => {
      try {
        const { channel_id } = await chatApi.createDm([memberId]);
        await get().refreshChannels();
        // 新建 DM 通常已出现在刷新后的列表；若尚未返回则用本地兜底对象选中
        const ch =
          findChannelIn(get().channels, get().dms, channel_id) ??
          ({
            id: channel_id,
            name: fallbackName,
            description: '',
            is_dm: true,
            kind: 'official',
            parent_id: null,
            owner_id: null,
            created_at: new Date().toISOString(),
          } as ChatChannel);
        await get().selectChannel(channel_id, ch);
      } catch (e) {
        const msg = (e as Error).message || '';
        set({
          error: /DM with friends/.test(msg)
            ? i18nService.t('memberChat.dmFriendsOnly', {
                defaultValue: '只能向好友发起私聊，请先添加好友',
              })
            : msg,
        });
      }
    },

    removeFriend: async (f) => {
      try {
        await chatApi.removeFriend(f.member_id);
        set((s) => ({ friends: s.friends.filter((x) => x.member_id !== f.member_id) }));
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    respondFriendReq: async (id, accept) => {
      try {
        if (accept) {
          await chatApi.acceptFriendRequest(id);
          set({
            notice: i18nService.t('memberChat.friendAdded', { defaultValue: '已添加好友' }),
          });
        } else {
          await chatApi.rejectFriendRequest(id);
        }
        set((s) => ({ friendReqs: s.friendReqs.filter((r) => r.id !== id) }));
        if (accept) void get().refreshFriends();
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    clearDmHistory: async () => {
      const { currentId } = get();
      if (currentId == null) return;
      const ch = findChannelIn(get().channels, get().dms, currentId);
      if (!ch?.is_dm) return;
      try {
        await dmClearMessages(currentId);
        set({ messages: [] });
        set((s) => ({ unread: { ...s.unread, [currentId]: 0 } }));
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    applyWsEvent: (ev) => {
      const s = get();
      const op = ev.op as string;
      const channelId = ev.channel_id as number | undefined;
      const curId = s.currentId;

      if (op === 'message' && channelId != null) {
        const m = ev.message as ChatMessage;
        touchConversation(channelId, m.content);
        const isDmCh = s.dms.some((d) => d.channel_id === channelId);
        if (isDmCh) {
          // 自己消息的 WS 回显：本地已有同 client_msg_id（乐观插入的 pending）→ 幂等跳过
          if (m.client_msg_id && m.sender_id === s.session?.memberId) {
            if (get().messages.some((x) => x.client_msg_id === m.client_msg_id)) return;
            // 非当前频道的自己的回显（补发时）也只落库不重复渲染
            void dmAppendMessages(channelId, [m]);
            return;
          }
          // 私聊：持久化到本机 + 回执 ack 给发送方 + 本地未读计算（服务端不落库不暂存）
          void (async () => {
            await dmAppendMessages(channelId, [m]);
            if (m.client_msg_id) {
              wsClient?.sendDmAck(m.sender_id, [m.client_msg_id]);
            }
            if (channelId === curId) await dmMarkRead(channelId);
            else await dmBumpUnread(channelId);
          })();
          if (channelId === curId) {
            const norm = normalizeMessage(m);
            set((st) =>
              st.messages.some((x) => x.client_msg_id && x.client_msg_id === m.client_msg_id)
                ? st
                : { messages: [...st.messages, norm] },
            );
          } else {
            set((st) => ({
              unread: { ...st.unread, [channelId]: (st.unread[channelId] || 0) + 1 },
            }));
            void notifyNewMessage(m.sender_name, m.content);
          }
          return;
        }
        if (channelId === curId) {
          const norm = normalizeMessage(m);
          set((st) =>
            st.messages.some((x) => x.id === norm.id)
              ? st
              : { messages: [...st.messages, norm] },
          );
          if (m.id > 0) markRead(m.id);
        } else {
          set((st) => ({
            unread: { ...st.unread, [channelId]: (st.unread[channelId] || 0) + 1 },
          }));
          void notifyNewMessage(m.sender_name, m.content);
        }
      } else if (op === 'presence' && channelId != null && Array.isArray(ev.online)) {
        if (channelId === curId) set({ online: new Set(ev.online as number[]) });
        // DM 频道 presence：对方在线 → 触发本机 pending 补发（含启动时首次订阅的推送）
        const dm = s.dms.find((d) => d.channel_id === channelId);
        if (dm) {
          const friendIds = (ev.online as number[]).filter((x) => x !== s.session?.memberId);
          for (const fid of friendIds) void schedulePendingFlush(fid);
        }
      } else if (op === 'dm_ack') {
        // 发送方收到回执：标记本机消息已送达
        const from = ev.from as number | undefined;
        const ids = (ev.client_msg_ids as string[] | undefined) || [];
        if (from != null && ids.length > 0) {
          const username = s.friends.find((f) => f.member_id === from)?.username;
          const dm = s.dms.find((d) => username != null && d.members.includes(username));
          if (dm) {
            void dmMarkSentByClientIds(dm.channel_id, ids);
            const idSet = new Set(ids);
            set((st) => ({
              messages: st.messages.map((x) =>
                x.client_msg_id && idSet.has(x.client_msg_id)
                  ? { ...x, status: 'sent' as const }
                  : x,
              ),
            }));
          }
        }
      } else if (op === 'edit' && channelId === curId) {
        set((st) => ({
          messages: st.messages.map((x) =>
            x.id === ev.message_id ? { ...x, content: (ev.content as string) ?? x.content } : x,
          ),
        }));
      } else if (op === 'delete' && channelId === curId) {
        set((st) => ({
          messages: st.messages.map((x) =>
            x.id === ev.message_id ? { ...x, deleted_at: new Date().toISOString() } : x,
          ),
        }));
      } else if (op === 'reaction' && channelId === curId && ev.message_id != null) {
        const mid = ev.message_id as number;
        const r = ev.reaction as { id?: number; member_id: number; emoji: string } | undefined;
        if (r) {
          set((st) => {
            const list = st.reactions[mid] || [];
            if (ev.removed) {
              return {
                reactions: {
                  ...st.reactions,
                  [mid]: list.filter(
                    (x) => !(x.member_id === r.member_id && x.emoji === r.emoji),
                  ),
                },
              };
            }
            if (list.some((x) => x.member_id === r.member_id && x.emoji === r.emoji)) return st;
            return {
              reactions: {
                ...st.reactions,
                [mid]: [
                  ...list,
                  {
                    id: r.id ?? 0,
                    message_id: mid,
                    member_id: r.member_id,
                    member_name: '',
                    emoji: r.emoji,
                    created_at: '',
                  },
                ],
              },
            };
          });
        }
      } else if (op === 'pin' && channelId === curId && ev.message_id != null) {
        const mid = ev.message_id as number;
        set((st) => ({
          pins: ev.pinned
            ? st.pins.some((p) => p.message_id === mid)
              ? st.pins
              : [
                  ...st.pins,
                  {
                    id: 0,
                    channel_id: channelId,
                    topic_id: (ev.topic_id as number | null) ?? null,
                    message_id: mid,
                    pinned_by: null,
                    created_at: '',
                  },
                ]
            : st.pins.filter((p) => p.message_id !== mid),
        }));
      } else if (op === 'typing' && channelId === curId && ev.member_id != null) {
        const who = ev.member_id as number;
        if (who !== s.session?.memberId) {
          const name = s.members.find((m) => m.member_id === who)?.member_name || `#${who}`;
          set((st) => ({
            typing: [...st.typing.filter((x) => x.id !== who), { id: who, name, at: Date.now() }],
          }));
        }
      } else if (op === 'move' && channelId === curId) {
        const ch = findChannelIn(s.channels, s.dms, curId);
        if (ch) void loadMessages(ch);
      } else if (op === 'friend_request') {
        const req = ev.request as FriendReq | undefined;
        if (req) {
          set((st) => ({
            friendReqs: st.friendReqs.some((x) => x.id === req.id)
              ? st.friendReqs
              : [req, ...st.friendReqs],
            notice: i18nService.t('memberChat.friendRequestNotice', {
              defaultValue: '{{name}} 请求加你为好友',
              name: req.requester_name,
            }),
          }));
        }
      } else if (op === 'friend_accepted') {
        const f = ev.friend as { member_id: number; username: string } | undefined;
        if (f) {
          set((st) => ({
            friends: st.friends.some((x) => x.member_id === f.member_id)
              ? st.friends
              : [
                  ...st.friends,
                  {
                    member_id: f.member_id,
                    username: f.username,
                    nickname: '',
                    since: '',
                    online: true,
                  },
                ],
            notice: i18nService.t('memberChat.friendAcceptedNotice', {
              defaultValue: '已添加 {{name}} 为好友',
              name: f.username,
            }),
          }));
        }
      } else if (op === 'friend_removed') {
        const other = ev.other_member_id as number | undefined;
        if (other != null) {
          set((st) => ({
            friends: st.friends.filter((x) => x.member_id !== other),
            friendReqs: st.friendReqs.filter((x) => x.requester_id !== other),
            error: i18nService.t('memberChat.friendRemovedNotice', {
              defaultValue: '有好友删除了与你的关系或撤回了申请',
            }),
          }));
        }
      } else if (op === 'community_notice') {
        // 社区通知（like/comment/reply/follow）：广场红点 +1（轻量事件，
        // 完整内容客户端拉通知列表渲染；通知中心打开时顺带刷新列表）
        const cs = useCommunityStore.getState();
        cs.bumpUnread();
        if (cs.view === 'notifications') void cs.loadNotifications(true);
      } else if (op === 'member_presence' && ev.member_id != null) {
        const mid = ev.member_id as number;
        const on = ev.online === true;
        set((st) => ({
          friends: st.friends.map((f) => (f.member_id === mid ? { ...f, online: on } : f)),
        }));
        // 好友上线 → 延迟补发本机待送达的私聊（给对方完成频道订阅留时间）
        if (on) void schedulePendingFlush(mid);
      }
    },

    clearError: () => set({ error: null }),
    setRailTab: (tab) => set({ railTab: tab }),
    clearNotice: () => set({ notice: null }),
  };
});

// ===== 离线消息自动补发（双端记录对齐）=====

/** 生成客户端幂等 id（补发复用同一 id，接收方据此去重） */
function genClientMsgId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/// 防重入：同一会话补发进行中不再触发
const flushingChannels = new Set<number>();
const flushTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** 对方上线后延迟补发其 DM 会话的 pending 消息（3s：给对方完成 WS 订阅留时间） */
function schedulePendingFlush(memberId: number): void {
  if (flushTimers.has(memberId)) return;
  flushTimers.set(
    memberId,
    setTimeout(() => {
      flushTimers.delete(memberId);
      void flushPendingFor(memberId);
    }, 3000),
  );
}

/** 把本机 pending 的私聊消息重发给指定成员（REST 成功后仍保持 pending，等 ack） */
async function flushPendingFor(memberId: number): Promise<void> {
  const s = useMemberChatStore.getState();
  if (!s.session?.hasToken) return;
  const username = s.friends.find((f) => f.member_id === memberId)?.username;
  if (username == null) return;
  const dm = s.dms.find((d) => d.members.includes(username));
  if (!dm || flushingChannels.has(dm.channel_id)) return;
  flushingChannels.add(dm.channel_id);
  try {
    const pending = await dmGetPending(dm.channel_id);
    for (const m of pending) {
      if (!m.client_msg_id) continue;
      try {
        await chatApi.sendMessage(dm.channel_id, m.content, m.client_msg_id);
      } catch {
        // 失败保持 pending；对方下次上线/本会话 presence 再触发
        break;
      }
    }
  } finally {
    flushingChannels.delete(dm.channel_id);
  }
}

/** 建立 WS（全局仅一次）；事件集中进 applyWsEvent */
async function ensureWs(): Promise<void> {
  if (wsClient) return;
  wsClient = await createChatWsClient(
    (ev) => {
      useMemberChatStore.getState().applyWsEvent(ev as unknown as Record<string, unknown>);
    },
    (status) => {
      useMemberChatStore.setState({ connection: status });
    },
  );
  const { channels, dms } = useMemberChatStore.getState();
  wsClient.subscribe([...channels.map((c) => c.id), ...dms.map((d) => d.channel_id)]);
}
