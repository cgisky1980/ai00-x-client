/**
 * Sidebar — 第二栏：列表面板（内容由 RailNav 选中态驱动）
 *
 * chats 态 = QQ 式混合会话列表（私聊 + 房间按最近活跃混排，未读角标）
 * contacts 态 = 好友 + 好友申请入口 + 添加好友
 * channels 态 = 官方频道树（容器→房间）；超管可创建官方频道
 * community 态 = 由 MemberChatApp 整页替换为 CommunityView，不经此处；
 * settings 态由 MemberChatApp 整页替换为 SettingsPage，不经此处
 * 顶部搜索为纯前端本地过滤（不接后端）。
 */
import React, { useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { confirmDialog, IconButton } from '@/component-library';
import { MemberAvatar } from './MemberAvatar';
import { Search } from 'lucide-react';
import type { RailTab } from './RailNav';
import {
  useMemberChatStore,
  type ConvMeta,
} from '../store/memberChatStore';

export const Sidebar: React.FC<{
  tab: RailTab;
  onOpenFriendRequests: () => void;
  onOpenCreateChannel: () => void;
  onOpenStartDm: () => void;
  onOpenAddFriend: () => void;
}> = ({ tab, onOpenFriendRequests, onOpenCreateChannel, onOpenStartDm, onOpenAddFriend }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  const channels = useMemberChatStore((s) => s.channels);
  const dms = useMemberChatStore((s) => s.dms);
  const convMeta = useMemberChatStore((s) => s.convMeta);
  const session = useMemberChatStore((s) => s.session);
  const friends = useMemberChatStore((s) => s.friends);
  const friendReqs = useMemberChatStore((s) => s.friendReqs);
  const unread = useMemberChatStore((s) => s.unread);
  const currentId = useMemberChatStore((s) => s.currentId);
  const selectChannel = useMemberChatStore((s) => s.selectChannel);
  const createDm = useMemberChatStore((s) => s.createDm);
  const removeFriend = useMemberChatStore((s) => s.removeFriend);

  const match = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());

  /** QQ 式混合会话：DM + 房间（容器频道不可发言，不进列表），按最近活跃降序 */
  const conversations = useMemo(() => {
    const dmItems = dms.map((d) => {
      const meta: ConvMeta | undefined = convMeta[d.channel_id];
      const name = d.members.join(', ') || t('memberChat.dm', { defaultValue: '私信' });
      return {
        key: `dm-${d.channel_id}`,
        id: d.channel_id,
        isRoom: false as const,
        name,
        avatar: d.peer_avatar ?? null,
        lastMsgAt: meta?.lastMsgAt ?? 0,
        preview: meta?.lastMsgPreview || t('memberChat.localOnlyHint', { defaultValue: '私聊 · 仅保存在本机' }),
        unread: unread[d.channel_id] || 0,
        createdAt: d.created_at,
      };
    });
    const roomItems = channels
      .filter((c) => c.parent_id != null)
      .map((r) => {
        const meta = convMeta[r.id];
        return {
          key: `room-${r.id}`,
          id: r.id,
          isRoom: true as const,
          name: r.name,
          avatar: null,
          lastMsgAt: meta?.lastMsgAt ?? 0,
          preview: meta?.lastMsgPreview || r.description || '',
          unread: unread[r.id] || 0,
          createdAt: r.created_at,
        };
      });
    const items = [...dmItems, ...roomItems];
    items.sort(
      (a, b) =>
        b.lastMsgAt - a.lastMsgAt ||
        b.createdAt.localeCompare(a.createdAt),
    );
    return items;
  }, [dms, channels, convMeta, unread, t]);

  /** 打开好友 DM：已有会话直接切，否则创建 */
  const openFriendDm = async (memberId: number, username: string, nickname: string) => {
    const existing = dms.find((d) => d.members.includes(username));
    if (existing) {
      await selectChannel(existing.channel_id);
      return;
    }
    await createDm(memberId, nickname || username);
  };

  return (
    <aside className="member-chat__sidebar">
      <div className="member-chat__panel-search">
        <Search size={14} aria-hidden />
        <input
          type="text"
          className="member-chat__search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('memberChat.searchPlaceholder', { defaultValue: '搜索' })}
          aria-label={t('memberChat.searchPlaceholder', { defaultValue: '搜索' })}
        />
      </div>

      <div className="member-chat__sidebar-body">
        {tab === 'chats' && (
          <>
            <div className="member-chat__panel-actions">
              <button
                className="member-chat__btn-primary"
                onClick={onOpenStartDm}
                disabled={friends.length === 0}
              >
                + {t('memberChat.startDm', { defaultValue: '发起私聊' })}
              </button>
            </div>
            {conversations.length === 0 && (
              <div className="member-chat__empty">
                {t('memberChat.noConversations', {
                  defaultValue: '暂无会话；从「联系人」添加好友后开始。',
                })}
              </div>
            )}
            {conversations
              .filter((c) => match(c.name))
              .map((c) => {
                const active = currentId === c.id;
                return (
                  <button
                    key={c.key}
                    className={`member-chat__conv ${active ? 'is-active' : ''}`}
                    onClick={() => void selectChannel(c.id)}
                  >
                    {c.isRoom ? (
                      <span className="member-chat__conv-glyph" aria-hidden>
                        ◇
                      </span>
                    ) : (
                      <MemberAvatar name={c.name} size="base" data={c.avatar} />
                    )}
                    <span className="member-chat__conv-body">
                      <span className="member-chat__conv-top">
                        <span className="member-chat__conv-name">{c.name}</span>
                        {!!c.lastMsgAt && (
                          <time className="member-chat__conv-time">
                            {new Date(c.lastMsgAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                        )}
                      </span>
                      <span className="member-chat__conv-bottom">
                        <span className="member-chat__conv-preview">{c.preview}</span>
                        {!!c.unread && c.unread > 0 && (
                          <span className="member-chat__unread-badge">
                            {c.unread > 99 ? '99+' : c.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
          </>
        )}

        {tab === 'channels' && (
          <>
            {session?.isSuperAdmin && (
              <div className="member-chat__panel-actions">
                <button className="member-chat__btn-ghost" onClick={onOpenCreateChannel}>
                  + {t('memberChat.createOfficial', { defaultValue: '创建官方频道' })}
                </button>
              </div>
            )}
            {channels.filter((c) => c.parent_id == null).length === 0 && (
              <div className="member-chat__empty">
                {t('memberChat.noChannels', { defaultValue: '暂无频道' })}
              </div>
            )}
            {channels
              .filter((c) => c.parent_id == null && match(c.name))
              .map((ch) => {
                const active = currentId === ch.id;
                const badge = unread[ch.id];
                const rooms = channels.filter((c) => c.parent_id === ch.id);
                return (
                  <div key={ch.id} className="member-chat__channel-group">
                    <button
                      className={`member-chat__channel ${active ? 'is-active' : ''}`}
                      onClick={() => void selectChannel(ch.id)}
                    >
                      <span className="member-chat__channel-hash">#</span>
                      <span className="member-chat__channel-name">{ch.name}</span>
                      {!!badge && badge > 0 && (
                        <span className="member-chat__unread-badge">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                    </button>
                    {rooms
                      .filter((r) => match(r.name))
                      .map((r) => {
                        const rActive = currentId === r.id;
                        const rBadge = unread[r.id];
                        return (
                          <button
                            key={r.id}
                            className={`member-chat__channel member-chat__channel--room ${
                              rActive ? 'is-active' : ''
                            }`}
                            onClick={() => void selectChannel(r.id)}
                          >
                            <span className="member-chat__channel-hash">◇</span>
                            <span className="member-chat__channel-name">{r.name}</span>
                            {!!rBadge && rBadge > 0 && (
                              <span className="member-chat__unread-badge">
                                {rBadge > 99 ? '99+' : rBadge}
                              </span>
                            )}
                          </button>
                        );
                      })}
                  </div>
                );
              })}
          </>
        )}

        {tab === 'contacts' && (
          <>
            <div className="member-chat__panel-actions member-chat__panel-actions--between">
              <button
                className="member-chat__btn-ghost"
                onClick={onOpenFriendRequests}
                disabled={friendReqs.length === 0}
              >
                {t('memberChat.friendRequests', { defaultValue: '好友申请' })}
                {!!friendReqs.length && (
                  <span className="member-chat__req-badge">{friendReqs.length}</span>
                )}
              </button>
              <button className="member-chat__btn-ghost" onClick={onOpenAddFriend}>
                + {t('memberChat.addFriend', { defaultValue: '添加好友' })}
              </button>
            </div>
            {friends.length === 0 && (
              <div className="member-chat__empty">
                {t('memberChat.noFriends', { defaultValue: '暂无好友' })}
              </div>
            )}
            {friends
              .filter((f) => match(f.nickname || f.username))
              .map((f) => {
                const dmOpen =
                  currentId != null &&
                  dms.some(
                    (d) => d.channel_id === currentId && d.members.includes(f.username),
                  );
                return (
                  <div
                    key={f.member_id}
                    className={`member-chat__conv ${dmOpen ? 'is-active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => void openFriendDm(f.member_id, f.username, f.nickname)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void openFriendDm(f.member_id, f.username, f.nickname);
                      }
                    }}
                  >
                    <MemberAvatar name={f.nickname || f.username} size="base" data={f.avatar} />
                    <span className="member-chat__conv-body">
                      <span className="member-chat__conv-top">
                        <span className="member-chat__conv-name">{f.nickname || f.username}</span>
                        <span
                          className={`member-chat__friend-dot ${f.online ? 'is-on' : ''}`}
                          aria-label={f.online ? 'online' : 'offline'}
                        />
                      </span>
                    </span>
                    <span className="member-chat__friend-actions">
                      <IconButton
                        variant="ghost"
                        size="xs"
                        shape="square"
                        tooltip={t('memberChat.removeFriendAction', { defaultValue: '删除好友' })}
                        aria-label={t('memberChat.removeFriendAction', { defaultValue: '删除好友' })}
                        onClick={(e) => {
                          e.stopPropagation();
                          void confirmDialog({
                            title: t('memberChat.removeFriendTitle', { defaultValue: '删除好友' }),
                            message: t('memberChat.removeFriendConfirm', {
                              defaultValue: `确认删除好友「${f.nickname || f.username}」？双方好友关系将解除，私聊记录仍保留在本机。`,
                            }),
                            confirmDanger: true,
                          }).then((ok) => {
                            if (ok) void removeFriend(f);
                          });
                        }}
                      >
                        ✕
                      </IconButton>
                    </span>
                  </div>
                );
              })}
          </>
        )}
      </div>
    </aside>
  );
};
