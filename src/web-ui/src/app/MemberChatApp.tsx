/**
 * MemberChatApp — 会员聊天窗口（桌面端独立 Tauri 窗口）
 *
 * 桌面端已有登录会话（tokenManager），因此本窗口**免登陆**：
 * - REST 走 fetchWithAuth（自动注入 Bearer + baseUrl + 401 刷新）
 * - 实时走 WebSocket /api/v1/chat/ws?token=
 *
 * 布局：左=频道/房间列表，中=消息流+输入框，右=成员/在线。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  chatApi,
  createChatWs,
  getMemberSession,
  type ChatChannel,
  type ChatMessage,
  type Member,
  type MemberSession,
} from './member-chat/chatApi';
import { useI18n } from '@/infrastructure/i18n';
import './MemberChatApp.scss';

/** 简易渲染：HTML 转义防 XSS + **加粗** / `代码` / 链接 / 换行 */
function renderText(content: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = esc(content);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  html = html.replace(/\n/g, '<br/>');
  return html;
}

const MemberChatApp: React.FC = () => {
  const { t } = useI18n();

  const [session, setSession] = useState<MemberSession | null>(null);
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [online, setOnline] = useState<Set<number>>(new Set());
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<Awaited<ReturnType<typeof createChatWs>> | null>(null);
  const msgEndRef = useRef<HTMLDivElement>(null);

  const current = channels.find((c) => c.id === currentId);
  const topChannels = useMemo(() => channels.filter((c) => c.parent_id == null), [channels]);
  const roomsOf = useCallback(
    (id: number) => channels.filter((c) => c.parent_id === id),
    [channels],
  );

  // 当前用户在当前频道中的角色（超管视为 owner；非成员返回空串）
  const myChannelRole =
    session?.memberId === 1
      ? 'owner'
      : members.find((m) => m.member_id === session?.memberId)?.role || '';
  const postingLocked =
    !!current && current.post_policy === 'admin' && myChannelRole !== 'owner';

  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
  }, []);

  // 建立 WS（仅一次），随会话就绪
  useEffect(() => {
    if (!session?.hasToken) return;
    let disposed = false;
    createChatWs(
      (ev) => {
        if (disposed) return;
        const channelId = ev.channel_id;
        if (ev.op === 'message' && channelId != null && channelId === currentId) {
          const m = ev.message as ChatMessage;
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        } else if (ev.op === 'presence' && channelId === currentId) {
          setOnline(new Set(ev.online || []));
        } else if (ev.op === 'edit' && channelId === currentId) {
          setMessages((prev) =>
            prev.map((x) =>
              x.id === ev.message_id ? { ...x, content: ev.content ?? x.content } : x,
            ),
          );
        } else if (ev.op === 'delete' && channelId === currentId) {
          setMessages((prev) =>
            prev.map((x) =>
              x.id === ev.message_id ? { ...x, deleted_at: new Date().toISOString() } : x,
            ),
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
      if (currentId != null) client.subscribe([currentId]);
    });

    return () => {
      disposed = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [session?.hasToken, currentId]);

  // 会话就绪后自动加载频道
  useEffect(() => {
    if (session?.hasToken) refreshChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.hasToken]);

  // 切换频道：订阅 + 拉消息 + 拉成员
  const selectChannel = useCallback(async (id: number) => {
    setCurrentId(id);
    setMessages([]);
    setMembers([]);
    setOnline(new Set());
    wsRef.current?.subscribe([id]);
    try {
      const msgData = await chatApi.listMessages(id);
      setMessages((msgData.messages || []).filter((m) => !m.deleted_at));
    } catch (e) {
      setError((e as Error).message);
    }
    try {
      const mData = await chatApi.listMembers(id);
      setMembers(mData.members || []);
    } catch {
      /* 可能非成员，忽略 */
    }
  }, []);

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
          {topChannels.length === 0 && (
            <div className="member-chat__empty">
              {t('memberChat.noChannels', { defaultValue: '暂无频道' })}
            </div>
          )}
          {topChannels.map((ch) => {
            const rooms = roomsOf(ch.id);
            const active = currentId === ch.id;
            return (
              <div key={ch.id} className="member-chat__channel-group">
                <div
                  className={`member-chat__channel ${active ? 'is-active' : ''}`}
                  onClick={() => selectChannel(ch.id)}
                >
                  <span className="member-chat__channel-hash">#</span>
                  <span className="member-chat__channel-name">{ch.name}</span>
                  {ch.invite_only && (
                    <span className="member-chat__tag">{t('memberChat.inviteOnly', { defaultValue: '邀请制' })}</span>
                  )}
                  {rooms.length > 0 && <span className="member-chat__count">{rooms.length}</span>}
                </div>
                {rooms.map((r) => {
                  const rActive = currentId === r.id;
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
                        <span className="member-chat__tag">{t('memberChat.inviteOnly', { defaultValue: '邀请制' })}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </aside>

      <main className="member-chat__main">
        {current ? (
          <>
            <header className="member-chat__main-header">
              <div className="member-chat__main-title">
                <span className="member-chat__main-hash">#{current.name}</span>
                <span className="member-chat__main-meta">
                  {current.kind === 'room'
                    ? t('memberChat.room', { defaultValue: '房间(本地优先)' })
                    : t('memberChat.channel', { defaultValue: '官方频道' })}
                  {' · '}
                  {t('memberChat.postPolicy', { defaultValue: '发帖' })}:{' '}
                  {current.post_policy || 'everyone'}
                </span>
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

            <div className="member-chat__messages">
              {messages.length === 0 && (
                <div className="member-chat__empty">
                  {t('memberChat.noMessages', { defaultValue: '暂无消息，输入内容发送。' })}
                </div>
              )}
              {messages.map((m) => (
                <div key={m.id} className="member-chat__message">
                  <div className="member-chat__message-head">
                    <span className="member-chat__sender">{m.sender_name}</span>
                    {online.has(m.sender_id) && (
                      <span className="member-chat__online-dot" title="在线" />
                    )}
                    <span className="member-chat__time">
                      {new Date(m.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <div
                    className="member-chat__message-body"
                    dangerouslySetInnerHTML={{ __html: renderText(m.content) }}
                  />
                </div>
              ))}
              <div ref={msgEndRef} />
            </div>

            <footer className="member-chat__composer">
              <textarea
                className="member-chat__input"
                rows={2}
                value={content}
                disabled={postingLocked}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={
                  postingLocked
                    ? t('memberChat.postingLocked', { defaultValue: '仅 owner/admin 可在本频道发帖' })
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
            </div>
          ))}
        </div>
      </aside>

      {error && (
        <div className="member-chat__toast" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  );
};

export default MemberChatApp;
