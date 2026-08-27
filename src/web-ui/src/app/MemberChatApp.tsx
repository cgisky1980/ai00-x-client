/**
 * MemberChatApp — 会员聊天窗口（桌面端独立 Tauri 窗口）
 *
 * 桌面端已有登录会话（tokenManager），因此本窗口**免登陆**：
 * - REST 走 fetchWithAuth（自动注入 Bearer + baseUrl + 401 刷新）
 * - 实时走 WebSocket /api/v1/chat/ws?token=（订阅我的全部频道）
 *
 * 布局：左=频道/房间/私信列表（含未读徽标），中=话题栏+置顶条+消息流+输入框（typing 指示），
 * 右=成员/在线/管理（加踢人/分组）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  chatApi,
  createChatWs,
  getMemberSession,
  type ChatChannel,
  type ChatDm,
  type ChatMessage,
  type ChatPin,
  type ChatReaction,
  type ChatTopic,
  type ChatUnreadItem,
  type Friend,
  type FriendReq,
  type Member,
  type MemberSession,
} from './member-chat/chatApi';
import MessageItem from './member-chat/MessageItem';
import {
  ChannelSettingsModal,
  CreateChannelModal,
  CreateTopicModal,
  GroupsModal,
} from './member-chat/ChatModals';
import { AddFriendModal, FriendRequestsModal } from './member-chat/FriendsPanel';
import { useI18n } from '@/infrastructure/i18n';
import './MemberChatApp.scss';

const MemberChatApp: React.FC = () => {
  const { t } = useI18n();

  const [session, setSession] = useState<MemberSession | null>(null);
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [dms, setDms] = useState<ChatDm[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [currentTopicId, setCurrentTopicId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reactions, setReactions] = useState<Record<number, ChatReaction[]>>({});
  const [members, setMembers] = useState<Member[]>([]);
  const [online, setOnline] = useState<Set<number>>(new Set());
  const [unread, setUnread] = useState<Record<number, number>>({});
  const [topics, setTopics] = useState<ChatTopic[]>([]);
  const [pins, setPins] = useState<ChatPin[]>([]);
  const [typingUsers, setTypingUsers] = useState<{ id: number; name: string; at: number }[]>([]);
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // 弹窗
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateTopic, setShowCreateTopic] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showGroups, setShowGroups] = useState(false);
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showFriendReqs, setShowFriendReqs] = useState(false);
  const [addMemberId, setAddMemberId] = useState('');
  // 好友体系
  const [friends, setFriends] = useState<Friend[]>([]);
  const [friendReqs, setFriendReqs] = useState<FriendReq[]>([]);
  /** 成功类轻提示（区别于 error 的红色 toast） */
  const [notice, setNotice] = useState<string | null>(null);

  const wsRef = useRef<Awaited<ReturnType<typeof createChatWs>> | null>(null);
  const msgEndRef = useRef<HTMLDivElement>(null);
  const msgBoxRef = useRef<HTMLDivElement>(null);
  const roomSeqRef = useRef(0);
  const typingThrottleRef = useRef(0);
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // WS 事件处理器闭包稳定性：WS 只建立一次，处理器内读取的当前频道/话题/
  // 成员必须走 ref，否则闭包停留在首次渲染值（currentId=null），导致
  // 自己发的消息回显永远匹配不上当前频道（不及时更新 bug）。
  const currentIdRef = useRef<number | null>(null);
  const currentTopicIdRef = useRef<number | null>(null);
  const membersRef = useRef<Member[]>([]);
  const findChannelRef = useRef<(id: number | null) => ChatChannel | undefined>(() => undefined);

  /** 查找频道（普通频道 + DM 伪频道：DM 消息也存服务端，按 official 对待） */
  const findChannel = useCallback(
    (id: number | null): ChatChannel | undefined => {
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
    },
    [channels, dms],
  );

  const current = findChannel(currentId);
  const isDmChannel = dms.some((d) => d.channel_id === currentId);
  const isOfficial = !!current && current.kind === 'official';

  // ref 同步（WS 处理器读取）
  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);
  useEffect(() => {
    currentTopicIdRef.current = currentTopicId;
  }, [currentTopicId]);
  useEffect(() => {
    membersRef.current = members;
  }, [members]);
  useEffect(() => {
    findChannelRef.current = findChannel;
  }, [findChannel]);

  const topChannels = useMemo(() => channels.filter((c) => c.parent_id == null), [channels]);
  const roomsOf = useCallback(
    (id: number) => channels.filter((c) => c.parent_id === id),
    [channels],
  );

  // 我的权限（当前频道）
  const myMember = members.find((m) => m.member_id === session?.memberId);
  const isOwner = !!session && (session.isSuperAdmin || myMember?.role === 'owner');
  const myPerms = useMemo(
    () => (isOwner ? ['create_rooms', 'manage_members', 'manage_messages', 'manage_rooms'] : myMember?.permissions || []),
    [isOwner, myMember],
  );
  const canManageMessages = myPerms.includes('manage_messages');
  const canManageMembers = myPerms.includes('manage_members');
  const canManageRooms = myPerms.includes('manage_rooms');
  const postingLocked =
    !!current && current.post_policy === 'admin' && !isOwner;

  // room 消息本地 id 归一化（服务端 id=0 占位）
  const normalizeMessage = useCallback((m: ChatMessage): ChatMessage => {
    if (m.id === 0) {
      roomSeqRef.current += 1;
      return { ...m, id: -roomSeqRef.current };
    }
    return m;
  }, []);

  const refreshUnread = useCallback(async () => {
    try {
      const { unread: items } = await chatApi.myUnread();
      const map: Record<number, number> = {};
      for (const it of items as ChatUnreadItem[]) {
        map[it.channel_id] = (map[it.channel_id] || 0) + it.unread_count;
      }
      setUnread(map);
    } catch {
      /* 忽略 */
    }
  }, []);

  const refreshChannels = useCallback(async () => {
    try {
      const data = await chatApi.listChannels();
      setChannels(data.channels || []);
      setCurrentId((prev) => {
        if (prev != null && data.channels?.some((c) => c.id === prev)) return prev;
        return data.channels?.length ? data.channels[0].id : null;
      });
    } catch (e) {
      setError((e as Error).message);
    }
    try {
      const dmData = await chatApi.listDms();
      setDms(dmData.dms || []);
    } catch {
      /* 忽略 */
    }
    refreshUnread();
  }, [refreshUnread]);

  // ===== 好友 =====
  // 好友 + 待处理申请加载（会话就绪后与频道并行；失败不阻塞聊天主流程）
  const refreshFriends = useCallback(async () => {
    try {
      const [fData, rData] = await Promise.all([
        chatApi.listFriends(),
        chatApi.listFriendRequests(),
      ]);
      setFriends(fData.friends || []);
      setFriendReqs(rData.requests || []);
    } catch {
      /* 忽略 */
    }
  }, []);

  // 拉取可见消息的回应（official/DM；room 无服务端消息行）
  const loadReactions = useCallback(async (msgs: ChatMessage[]) => {
    const ids = msgs.filter((m) => m.id > 0).map((m) => m.id);
    if (ids.length === 0) return;
    const results = await Promise.allSettled(ids.map((id) => chatApi.listReactions(id)));
    const map: Record<number, ChatReaction[]> = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') map[ids[i]] = r.value.reactions || [];
    });
    setReactions((prev) => ({ ...prev, ...map }));
  }, []);

  // 加载消息（official/DM 走服务端表；room 走离线暂存补拉）
  const loadMessages = useCallback(
    async (ch: ChatChannel, topicId: number | null) => {
      if (ch.kind === 'room') {
        try {
          const { messages: ms } = await chatApi.roomRecent(ch.id);
          setMessages((ms || []).map(normalizeMessage));
          setHasMore(false);
        } catch (e) {
          setError((e as Error).message);
        }
        return;
      }
      try {
        const msgData = await chatApi.listMessages(ch.id, { topicId });
        const list = (msgData.messages || []).filter((m) => !m.deleted_at);
        setMessages(list);
        setHasMore(list.length >= 100);
        loadReactions(list);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [loadReactions, normalizeMessage],
  );

  // 切换频道：订阅 + 拉消息/成员/话题/置顶 + 清未读
  const selectChannel = useCallback(
    async (id: number, topicId: number | null = null, chOverride?: ChatChannel) => {
      const ch = chOverride ?? findChannel(id);
      setCurrentId(id);
      setCurrentTopicId(topicId);
      setMessages([]);
      setReactions({});
      setMembers([]);
      setOnline(new Set());
      setTopics([]);
      setPins([]);
      if (!ch) return;
      loadMessages(ch, topicId);
      try {
        const tData = await chatApi.listTopics(id);
        setTopics(tData.topics || []);
      } catch {
        /* room 可能无话题 */
      }
      try {
        const mData = await chatApi.listMembers(id);
        setMembers(mData.members || []);
      } catch {
        /* 可能非成员，忽略 */
      }
      if (ch.kind === 'official') {
        try {
          const pData = await chatApi.listPins(id);
          setPins(pData.pins || []);
        } catch {
          /* 忽略 */
        }
      }
      // 清未读游标（有消息时）
      setUnread((prev) => ({ ...prev, [id]: 0 }));
    },
    [findChannel, loadMessages],
  );

  // 切换话题
  const selectTopic = useCallback(
    (topicId: number | null) => {
      if (!current) return;
      setCurrentTopicId(topicId);
      loadMessages(current, topicId);
    },
    [current, loadMessages],
  );

  // WS 消息到达后更新已读游标（读 ref，避免闭包过期）
  const markRead = useCallback((lastMessageId: number) => {
    const cid = currentIdRef.current;
    if (cid == null || lastMessageId <= 0) return;
    chatApi.updateRead(cid, currentTopicIdRef.current, lastMessageId).catch(() => {});
  }, []);

  // 建立 WS（仅一次，随会话就绪）；订阅全部频道。
  // 处理器内一律通过 ref 读取当前频道/话题/成员（见 currentIdRef 注释）。
  useEffect(() => {
    if (!session?.hasToken) return;
    let disposed = false;
    createChatWs(
      (ev) => {
        if (disposed) return;
        const channelId = ev.channel_id;
        const curId = currentIdRef.current;
        const curTopic = currentTopicIdRef.current;
        if (ev.op === 'message' && channelId != null) {
          const m = ev.message as ChatMessage;
          if (channelId === curId) {
            if (curTopic == null || m.topic_id === curTopic) {
              const norm = normalizeMessage(m);
              setMessages((prev) =>
                prev.some((x) => x.id === norm.id) ? prev : [...prev, norm],
              );
              if (m.id > 0) markRead(m.id);
            }
          } else {
            setUnread((prev) => ({ ...prev, [channelId]: (prev[channelId] || 0) + 1 }));
          }
        } else if (ev.op === 'presence' && channelId === curId && Array.isArray(ev.online)) {
          setOnline(new Set(ev.online));
        } else if (ev.op === 'edit' && channelId === curId) {
          setMessages((prev) =>
            prev.map((x) =>
              x.id === ev.message_id ? { ...x, content: ev.content ?? x.content } : x,
            ),
          );
        } else if (ev.op === 'delete' && channelId === curId) {
          setMessages((prev) =>
            prev.map((x) =>
              x.id === ev.message_id ? { ...x, deleted_at: new Date().toISOString() } : x,
            ),
          );
        } else if (ev.op === 'reaction' && channelId === curId && ev.message_id != null) {
          const mid = ev.message_id;
          const r = ev.reaction;
          if (r) {
            setReactions((prev) => {
              const list = prev[mid] || [];
              if (ev.removed) {
                return {
                  ...prev,
                  [mid]: list.filter((x) => !(x.member_id === r.member_id && x.emoji === r.emoji)),
                };
              }
              if (list.some((x) => x.member_id === r.member_id && x.emoji === r.emoji)) return prev;
              return {
                ...prev,
                [mid]: [
                  ...list,
                  { id: r.id ?? 0, message_id: mid, member_id: r.member_id, member_name: '', emoji: r.emoji, created_at: '' },
                ],
              };
            });
          }
        } else if (ev.op === 'pin' && channelId === curId && ev.message_id != null) {
          const mid = ev.message_id;
          setPins((prev) =>
            ev.pinned
              ? prev.some((p) => p.message_id === mid)
                ? prev
                : [...prev, { id: 0, channel_id: channelId, topic_id: ev.topic_id ?? null, message_id: mid, pinned_by: null, created_at: '' }]
              : prev.filter((p) => p.message_id !== mid),
          );
        } else if (ev.op === 'typing' && channelId === curId && ev.member_id != null) {
          const who = ev.member_id;
          if (who !== session?.memberId) {
            const name =
              membersRef.current.find((m) => m.member_id === who)?.member_name || `#${who}`;
            setTypingUsers((prev) => [
              ...prev.filter((x) => x.id !== who),
              { id: who, name, at: Date.now() },
            ]);
          }
        } else if (ev.op === 'move' && channelId === curId) {
          // 有消息移入当前频道 → 重新拉取
          const ch = findChannelRef.current(curId);
          if (ch) loadMessages(ch, curTopic);
        } else if (ev.op === 'friend_request') {
          // 收到好友申请（服务端定向推送）
          const req = ev.request;
          if (req) {
            setFriendReqs((prev) =>
              prev.some((x) => x.id === req.id) ? prev : [req, ...prev],
            );
            setNotice(`${req.requester_name} 请求加你为好友`);
          }
        } else if (ev.op === 'friend_accepted') {
          // 申请通过 / 自动互认：本地并入好友列表并置在线
          const f = ev.friend;
          if (f) {
            setFriends((prev) =>
              prev.some((x) => x.member_id === f.member_id)
                ? prev
                : [
                    ...prev,
                    { member_id: f.member_id, username: f.username, nickname: '', since: '', online: true },
                  ],
            );
            setNotice(`已添加 ${f.username} 为好友`);
          }
        } else if (ev.op === 'friend_removed') {
          // 被删除好友/申请被拒：移除本地状态
          const other = ev.other_member_id;
          if (other != null) {
            setFriends((prev) => prev.filter((x) => x.member_id !== other));
            setFriendReqs((prev) => prev.filter((x) => x.requester_id !== other));
            setError('有好友删除了与你的关系或撤回了申请');
          }
        } else if (ev.op === 'member_presence' && ev.member_id != null) {
          // 好友全局上下线
          const mid = ev.member_id;
          const on = (ev.online as unknown as boolean) === true;
          setFriends((prev) =>
            prev.map((f) => (f.member_id === mid ? { ...f, online: on } : f)),
          );
        }
      },
      setWsConnected,
    ).then((client) => {
      if (disposed) {
        client.close();
        return;
      }
      wsRef.current = client;
    });

    return () => {
      disposed = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.hasToken]);

  // 频道列表变化 → 全量订阅（含 DM）
  useEffect(() => {
    if (!wsRef.current || channels.length === 0) return;
    wsRef.current.subscribe([
      ...channels.map((c) => c.id),
      ...dms.map((d) => d.channel_id),
    ]);
  }, [channels, dms, wsConnected]);

  // typing 指示 3s 过期清理
  useEffect(() => {
    typingTimerRef.current = setInterval(() => {
      setTypingUsers((prev) => {
        const next = prev.filter((x) => Date.now() - x.at < 3000);
        return next.length === prev.length ? prev : next;
      });
    }, 1000);
    return () => {
      if (typingTimerRef.current) clearInterval(typingTimerRef.current);
    };
  }, []);

  // 新消息自动滚底（仅当接近底部时）
  const msgBox = msgBoxRef.current;
  const nearBottom =
    !msgBox || msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 120;
  useEffect(() => {
    if (nearBottom) msgEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // 免登陆：读取桌面端已有会话
  useEffect(() => {
    let active = true;
    getMemberSession().then((s) => {
      if (active) setSession(s);
    });
    return () => {
      active = false;
    };
  }, []);

  // 会话就绪后自动加载频道 + 好友
  useEffect(() => {
    if (session?.hasToken) {
      refreshChannels();
      refreshFriends();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.hasToken]);

  // 首频道自动选中
  useEffect(() => {
    if (currentId == null && channels.length > 0) selectChannel(channels[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels]);

  // 加载更早消息（official/DM）
  const loadOlder = useCallback(async () => {
    if (!current || current.kind === 'room' || loadingOlder || messages.length === 0) return;
    const oldest = messages.find((m) => m.id > 0);
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const { messages: older } = await chatApi.listMessages(current.id, {
        topicId: currentTopicId,
        beforeId: oldest.id,
      });
      const list = (older || []).filter((m) => !m.deleted_at);
      if (list.length === 0) {
        setHasMore(false);
      } else {
        const box = msgBoxRef.current;
        const prevHeight = box?.scrollHeight ?? 0;
        setMessages((prev) => [...list, ...prev]);
        loadReactions(list);
        requestAnimationFrame(() => {
          if (box) box.scrollTop = box.scrollHeight - prevHeight;
        });
        setHasMore(list.length >= 100);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }, [current, currentTopicId, loadingOlder, messages, loadReactions]);

  const onMsgBoxScroll = useCallback(() => {
    const box = msgBoxRef.current;
    if (box && box.scrollTop < 40 && hasMore && !loadingOlder) loadOlder();
  }, [hasMore, loadingOlder, loadOlder]);

  // ===== 消息操作 =====
  const send = async () => {
    const text = content.trim();
    if (!text || currentId == null || postingLocked || sending) return;
    setSending(true);
    setContent('');
    try {
      await chatApi.sendMessage(currentId, text);
      // 消息经 WS 回显
    } catch (e) {
      setError((e as Error).message);
      setContent(text);
    } finally {
      setSending(false);
    }
  };

  const onInput = (v: string) => {
    setContent(v);
    // typing 节流 2s
    const now = Date.now();
    if (currentId != null && now - typingThrottleRef.current > 2000 && v.trim()) {
      typingThrottleRef.current = now;
      wsRef.current?.sendTyping(currentId, currentTopicId);
    }
  };

  const doEdit = async (id: number, text: string) => {
    if (id <= 0) return; // room 本地消息不可编辑
    try {
      await chatApi.editMessage(id, text);
      setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, content: text } : x)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doDelete = async (id: number) => {
    if (id <= 0) return;
    try {
      await chatApi.deleteMessage(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doReact = async (id: number, emoji: string) => {
    if (id <= 0) return;
    try {
      await chatApi.addReaction(id, emoji);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doUnreact = async (id: number, emoji: string) => {
    if (id <= 0) return;
    try {
      await chatApi.removeReaction(id, emoji);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doPinToggle = async (id: number, pinned: boolean) => {
    if (id <= 0) return;
    try {
      if (pinned) await chatApi.pinMessage(id);
      else await chatApi.unpinMessage(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // ===== 成员管理 =====
  const doAddMember = async () => {
    const mid = Number(addMemberId);
    if (!currentId || !mid) return;
    try {
      await chatApi.addChannelMember(currentId, mid);
      setAddMemberId('');
      const mData = await chatApi.listMembers(currentId);
      setMembers(mData.members || []);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doRemoveMember = async (mid: number) => {
    if (!currentId) return;
    if (!window.confirm('确认移除该成员？')) return;
    try {
      await chatApi.removeChannelMember(currentId, mid);
      setMembers((prev) => prev.filter((m) => m.member_id !== mid));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doCreateDm = async (mid: number) => {
    try {
      const { channel_id } = await chatApi.createDm([mid]);
      await refreshChannels();
      // refreshChannels 异步入 state，直接传伪频道避免闭包过期
      const mName = members.find((m) => m.member_id === mid)?.member_name || `#${mid}`;
      selectChannel(
        channel_id,
        null,
        {
          id: channel_id,
          name: mName,
          description: '',
          is_dm: true,
          kind: 'official',
          parent_id: null,
          owner_id: null,
          created_at: new Date().toISOString(),
        },
      );
    } catch (e) {
      const msg = (e as Error).message || '';
      setError(/DM with friends/.test(msg) ? '只能向好友发起私聊，请先添加好友' : msg);
    }
  };

  // ===== 好友（交互）=====

  /** 好友行点击 → 打开既有 DM 或新建（好友门禁由服务端把守） */
  const openDmWith = async (f: Friend) => {
    const existing = dms.find((d) => d.members.includes(f.username));
    if (existing) {
      selectChannel(existing.channel_id);
      return;
    }
    await doCreateDm(f.member_id);
  };

  const doRemoveFriend = async (f: Friend) => {
    if (!window.confirm(`确认删除好友 ${f.username}？`)) return;
    try {
      await chatApi.removeFriend(f.member_id);
      setFriends((prev) => prev.filter((x) => x.member_id !== f.member_id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doRespondFriendReq = async (id: number, accept: boolean) => {
    try {
      if (accept) {
        await chatApi.acceptFriendRequest(id);
        setNotice('已添加好友');
      } else {
        await chatApi.rejectFriendRequest(id);
      }
      setFriendReqs((prev) => prev.filter((r) => r.id !== id));
      if (accept) refreshFriends();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // ===== 未登录（桌面端无会话）→ 引导去主窗口登录 =====
  if (session && !session.hasToken) {
    return (
      <div className="member-chat member-chat--no-auth">
        <div className="member-chat__no-auth-card">
          <h2>{t('memberChat.title', { defaultValue: '会员聊天' })}</h2>
          <p>
            {t('memberChat.notLoggedIn', {
              defaultValue: '尚未登录。请先在 Ai00-X 主窗口登录会员账号后再打开聊天。',
            })}
          </p>
        </div>
      </div>
    );
  }

  const dmLabel = (d: ChatDm) => d.members.join(', ') || '(私信)';

  return (
    <div className="member-chat">
      <aside className="member-chat__channels">
        <div className="member-chat__channels-header">
          <span className="member-chat__brand">
            {t('memberChat.title', { defaultValue: '会员聊天' })}
          </span>
          <span className={`member-chat__ws-dot ${wsConnected ? 'is-on' : ''}`} />
        </div>
        <div className="member-chat__channels-list">
          {topChannels.length === 0 && dms.length === 0 && (
            <div className="member-chat__empty">
              {t('memberChat.noChannels', { defaultValue: '暂无频道' })}
            </div>
          )}
          {topChannels.map((ch) => {
            const rooms = roomsOf(ch.id);
            const active = currentId === ch.id;
            const badge = unread[ch.id];
            return (
              <div key={ch.id} className="member-chat__channel-group">
                <div
                  className={`member-chat__channel ${active ? 'is-active' : ''}`}
                  onClick={() => selectChannel(ch.id)}
                >
                  <span className="member-chat__channel-hash">#</span>
                  <span className="member-chat__channel-name">{ch.name}</span>
                  {ch.invite_only && (
                    <span className="member-chat__tag">
                      {t('memberChat.inviteOnly', { defaultValue: '邀请制' })}
                    </span>
                  )}
                  {!!badge && badge > 0 && (
                    <span className="member-chat__unread-badge">{badge > 99 ? '99+' : badge}</span>
                  )}
                  {rooms.length > 0 && <span className="member-chat__count">{rooms.length}</span>}
                </div>
                {rooms.map((r) => {
                  const rActive = currentId === r.id;
                  const rBadge = unread[r.id];
                  return (
                    <div
                      key={r.id}
                      className={`member-chat__channel member-chat__channel--room ${
                        rActive ? 'is-active' : ''
                      }`}
                      onClick={() => selectChannel(r.id)}
                    >
                      <span className="member-chat__channel-hash">▸</span>
                      <span className="member-chat__channel-name">{r.name}</span>
                      {r.invite_only && (
                        <span className="member-chat__tag">
                          {t('memberChat.inviteOnly', { defaultValue: '邀请制' })}
                        </span>
                      )}
                      {!!rBadge && rBadge > 0 && (
                        <span className="member-chat__unread-badge">
                          {rBadge > 99 ? '99+' : rBadge}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {dms.length > 0 && (
            <div className="member-chat__section-label">
              {t('memberChat.dm', { defaultValue: '私信' })}
            </div>
          )}
          {dms.map((d) => {
            const active = currentId === d.channel_id;
            const badge = unread[d.channel_id];
            return (
              <div
                key={d.channel_id}
                className={`member-chat__channel ${active ? 'is-active' : ''}`}
                onClick={() => selectChannel(d.channel_id)}
              >
                <span className="member-chat__channel-hash">@</span>
                <span className="member-chat__channel-name">{dmLabel(d)}</span>
                {!!badge && badge > 0 && (
                  <span className="member-chat__unread-badge">{badge > 99 ? '99+' : badge}</span>
                )}
              </div>
            );
          })}

          {/* 好友区块 */}
          {session?.hasToken && (
            <>
              <div className="member-chat__section-label member-chat__section-label--friends">
                <span>{t('memberChat.friends', { defaultValue: '好友' })}</span>
                <span className="member-chat__section-actions">
                  {!!friendReqs.length && (
                    <button
                      className="member-chat__req-badge"
                      title={t('memberChat.friendRequests', { defaultValue: '好友申请' })}
                      onClick={() => setShowFriendReqs(true)}
                    >
                      {friendReqs.length}
                    </button>
                  )}
                  <button
                    className="member-chat__add-friend-btn"
                    title={t('memberChat.addFriend', { defaultValue: '添加好友' })}
                    onClick={() => setShowAddFriend(true)}
                  >
                    +
                  </button>
                </span>
              </div>
              {friends.map((f) => (
                <div
                  key={f.member_id}
                  className={`member-chat__channel member-chat__friend ${
                    currentId != null && dms.some(
                      (d) => d.channel_id === currentId && d.members.includes(f.username),
                    )
                      ? 'is-active'
                      : ''
                  }`}
                  onClick={() => openDmWith(f)}
                >
                  <span
                    className={`member-chat__friend-dot ${f.online ? 'is-on' : ''}`}
                    aria-label={f.online ? 'online' : 'offline'}
                  />
                  <span className="member-chat__channel-name">
                    {f.nickname || f.username}
                  </span>
                  <span className="member-chat__friend-actions">
                    <button
                      className="member-chat__msg-btn"
                      title={t('memberChat.dmAction', { defaultValue: '发私信' })}
                      onClick={(e) => {
                        e.stopPropagation();
                        openDmWith(f);
                      }}
                    >
                      ✉️
                    </button>
                    <button
                      className="member-chat__msg-btn"
                      title={t('memberChat.removeFriend', { defaultValue: '删除好友' })}
                      onClick={(e) => {
                        e.stopPropagation();
                        doRemoveFriend(f);
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="member-chat__channels-footer">
          <button
            className="member-chat__btn-primary member-chat__btn-create"
            onClick={() => setShowCreate(true)}
          >
            + {t('memberChat.create', { defaultValue: '创建频道 / 房间' })}
          </button>
        </div>
      </aside>

      <main className="member-chat__main">
        {current ? (
          <>
            <header className="member-chat__main-header">
              <div className="member-chat__main-title">
                <span className="member-chat__main-hash">#</span>
                <span className="member-chat__main-name">{current.name}</span>
                <span className="member-chat__main-meta">
                  {current.kind === 'room'
                    ? t('memberChat.room', { defaultValue: '房间(本地优先)' })
                    : isDmChannel
                      ? t('memberChat.dmChannel', { defaultValue: '私信' })
                      : t('memberChat.channel', { defaultValue: '官方频道' })}
                </span>
                {canManageRooms && (
                  <button
                    className="member-chat__header-btn"
                    onClick={() => setShowSettings(true)}
                  >
                    ⚙ {t('memberChat.settings', { defaultValue: '设置' })}
                  </button>
                )}
                {canManageRooms && (
                  <button className="member-chat__header-btn" onClick={() => setShowGroups(true)}>
                    👥 {t('memberChat.groups', { defaultValue: '分组' })}
                  </button>
                )}
              </div>
              {session && (
                <div className="member-chat__me">
                  {session.username}
                  {session.isSuperAdmin && (
                    <span className="member-chat__tag member-chat__tag--admin">超管</span>
                  )}
                </div>
              )}
            </header>

            {/* 话题栏（official/DM 频道） */}
            {(isOfficial || isDmChannel) && (
              <div className="member-chat__topic-bar">
                <button
                  className={`member-chat__topic-chip ${currentTopicId == null ? 'is-active' : ''}`}
                  onClick={() => selectTopic(null)}
                >
                  {t('memberChat.allTopics', { defaultValue: '全部' })}
                </button>
                {topics.map((tp) => (
                  <button
                    key={tp.id}
                    className={`member-chat__topic-chip ${currentTopicId === tp.id ? 'is-active' : ''}`}
                    onClick={() => selectTopic(tp.id)}
                  >
                    {tp.name}
                  </button>
                ))}
                <button
                  className="member-chat__topic-chip member-chat__topic-add"
                  onClick={() => setShowCreateTopic(true)}
                >
                  +
                </button>
              </div>
            )}

            {/* 置顶条 */}
            {pins.length > 0 && (
              <div className="member-chat__pin-bar">
                📌
                {pins.map((p) => {
                  const m = messages.find((x) => x.id === p.message_id);
                  return (
                    <button
                      key={`${p.id}-${p.message_id}`}
                      className="member-chat__pin-item"
                      title={m?.content?.slice(0, 60) || `消息 #${p.message_id}`}
                      onClick={() => {
                        const el = msgBoxRef.current?.querySelector(
                          `[data-mid="${p.message_id}"]`,
                        );
                        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }}
                    >
                      {m ? m.content.slice(0, 24) : `#${p.message_id}`}
                    </button>
                  );
                })}
              </div>
            )}

            <div
              className="member-chat__messages"
              ref={msgBoxRef}
              onScroll={onMsgBoxScroll}
            >
              {hasMore && (
                <div className="member-chat__load-older" onClick={loadOlder}>
                  {loadingOlder
                    ? t('memberChat.loading', { defaultValue: '加载中…' })
                    : t('memberChat.loadOlder', { defaultValue: '加载更早消息' })}
                </div>
              )}
              {messages.length === 0 && (
                <div className="member-chat__empty">
                  {t('memberChat.noMessages', { defaultValue: '暂无消息，输入内容发送。' })}
                </div>
              )}
              {messages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  isOwn={m.sender_id === session?.memberId}
                  isOnline={online.has(m.sender_id)}
                  canModerate={canManageMessages && isOfficialOrDm(isOfficial, isDmChannel)}
                  canPin={isOfficialOrDm(isOfficial, isDmChannel)}
                  pinned={pins.some((p) => p.message_id === m.id)}
                  reactions={reactions[m.id] || []}
                  myMemberId={session?.memberId ?? null}
                  onEdit={doEdit}
                  onDelete={doDelete}
                  onReact={doReact}
                  onUnreact={doUnreact}
                  onPinToggle={doPinToggle}
                />
              ))}
              <div ref={msgEndRef} />
            </div>

            {/* typing 指示 */}
            {typingUsers.length > 0 && (
              <div className="member-chat__typing">
                {typingUsers.map((u) => u.name).join('、')} 正在输入…
              </div>
            )}

            <footer className="member-chat__composer">
              <textarea
                className="member-chat__input"
                rows={2}
                value={content}
                disabled={postingLocked}
                onChange={(e) => onInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={
                  postingLocked
                    ? t('memberChat.postingLocked', {
                        defaultValue: '仅 owner/admin 可在本频道发帖',
                      })
                    : t('memberChat.inputPlaceholder', {
                        defaultValue: '输入消息，Enter 发送，Shift+Enter 换行',
                      })
                }
              />
              <button
                className="member-chat__send"
                onClick={send}
                disabled={postingLocked || sending || !content.trim()}
              >
                {t('memberChat.send', { defaultValue: '发送' })}
              </button>
            </footer>
          </>
        ) : (
          <div className="member-chat__empty member-chat__empty--center">
            {t('memberChat.selectChannel', { defaultValue: '选择一个频道开始聊天' })}
          </div>
        )}
      </main>

      <aside className="member-chat__members">
        <div className="member-chat__members-header">
          {t('memberChat.members', { defaultValue: '成员' })}
          <span className="member-chat__count">{members.length}</span>
        </div>
        <div className="member-chat__members-list">
          {members.length === 0 && (
            <div className="member-chat__empty">
              {t('memberChat.noMembers', { defaultValue: '暂无成员' })}
            </div>
          )}
          {members.map((m) => (
            <div key={m.member_id} className="member-chat__member">
              <span className="member-chat__member-name">{m.member_name}</span>
              {m.role === 'owner' && (
                <span className="member-chat__tag member-chat__tag--owner">owner</span>
              )}
              {online.has(m.member_id) && <span className="member-chat__online-dot" />}
              {m.group_name && <span className="member-chat__group">{m.group_name}</span>}
              {m.member_id !== session?.memberId && (
                <span className="member-chat__member-actions">
                  <button
                    className="member-chat__msg-btn"
                    title="发私信"
                    onClick={() => doCreateDm(m.member_id)}
                  >
                    ✉️
                  </button>
                  {canManageMembers && m.role !== 'owner' && (
                    <button
                      className="member-chat__msg-btn"
                      title="移除成员"
                      onClick={() => doRemoveMember(m.member_id)}
                    >
                      ✕
                    </button>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
        {canManageMembers && current && (
          <div className="member-chat__members-footer">
            <input
              className="member-chat__member-add-input"
              value={addMemberId}
              onChange={(e) => setAddMemberId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doAddMember()}
              placeholder={t('memberChat.addMember', { defaultValue: '会员 ID 加人' })}
            />
            <button className="member-chat__btn-primary" onClick={doAddMember}>
              {t('memberChat.add', { defaultValue: '加人' })}
            </button>
          </div>
        )}
      </aside>

      {showCreate && (
        <CreateChannelModal
          channels={channels}
          isSuperAdmin={!!session?.isSuperAdmin}
          onClose={() => setShowCreate(false)}
          onCreated={refreshChannels}
        />
      )}
      {showCreateTopic && current && (
        <CreateTopicModal
          channelId={current.id}
          onClose={() => setShowCreateTopic(false)}
          onCreated={(tid) => selectTopic(tid)}
        />
      )}
      {showSettings && current && (
        <ChannelSettingsModal
          channel={current}
          onClose={() => setShowSettings(false)}
          onSaved={refreshChannels}
        />
      )}
      {showGroups && current && (
        <GroupsModal
          channel={current}
          members={members}
          onClose={() => setShowGroups(false)}
          onChanged={async () => {
            if (!currentId) return;
            try {
              const mData = await chatApi.listMembers(currentId);
              setMembers(mData.members || []);
            } catch {
              /* 忽略 */
            }
          }}
        />
      )}
      {showAddFriend && (
        <AddFriendModal
          onClose={() => setShowAddFriend(false)}
          onNotice={(msg) => {
            setNotice(msg);
            refreshFriends();
          }}
        />
      )}
      {showFriendReqs && (
        <FriendRequestsModal
          requests={friendReqs}
          onClose={() => setShowFriendReqs(false)}
          onRespond={doRespondFriendReq}
        />
      )}

      {notice && (
        <div className="member-chat__toast member-chat__toast--ok" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {error && (
        <div className="member-chat__toast" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  );
};

/** official / DM 频道消息有服务端行（可编辑/删除/回应/置顶）；room 本地消息不支持 */
function isOfficialOrDm(isOfficial: boolean, isDm: boolean): boolean {
  return isOfficial || isDm;
}

export default MemberChatApp;
