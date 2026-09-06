/**
 * MessageList — 消息流
 *
 * - 日期分隔（mono）；同人连续消息（<5min）合并分组
 * - 顶部滚动加载更早（保留滚动位置）；「回到底部」悬浮按钮（含新消息计数）
 * - 首载 Skeleton；空态 Empty
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Empty, Skeleton } from '@/component-library';
import { useMemberChatStore, computeMyPerms, conversationType, findChannelIn } from '../store/memberChatStore';
import MessageItem from './MessageItem';
import { TypingIndicator } from './TypingIndicator';

const GROUP_GAP_MS = 5 * 60 * 1000;

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function dayLabel(iso: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString())
    return t('memberChat.today', { defaultValue: '今天' });
  if (d.toDateString() === yesterday.toDateString())
    return t('memberChat.yesterday', { defaultValue: '昨天' });
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export const MessageList: React.FC = () => {
  const { t } = useI18n();
  const messages = useMemberChatStore((s) => s.messages);
  const reactions = useMemberChatStore((s) => s.reactions);
  const members = useMemberChatStore((s) => s.members);
  const online = useMemberChatStore((s) => s.online);
  const pins = useMemberChatStore((s) => s.pins);
  const session = useMemberChatStore((s) => s.session);
  const hasMore = useMemberChatStore((s) => s.hasMore);
  const loadingOlder = useMemberChatStore((s) => s.loadingOlder);
  const loadingMessages = useMemberChatStore((s) => s.loadingMessages);
  const convType = useMemberChatStore((s) => {
    const ch = findChannelIn(s.channels, s.dms, s.currentId);
    return conversationType(ch, ch?.is_dm ?? false);
  });
  const editMessage = useMemberChatStore((s) => s.editMessage);
  const deleteMessage = useMemberChatStore((s) => s.deleteMessage);
  const react = useMemberChatStore((s) => s.react);
  const unreact = useMemberChatStore((s) => s.unreact);
  const pinToggle = useMemberChatStore((s) => s.pinToggle);
  const loadOlderAction = useMemberChatStore((s) => s.loadOlder);
  const canManageMessages = useMemberChatStore(
    (s) => computeMyPerms(s.session, s.members).canManageMessages,
  );

  const msgBoxRef = useRef<HTMLDivElement>(null);
  const msgEndRef = useRef<HTMLDivElement>(null);
  const [newBelow, setNewBelow] = useState(0);
  // 向上加载历史前的滚动快照（会话 id + scrollHeight + scrollTop），完成后补偿差值防跳底；
  // 恢复时校验会话未切换，防止把旧位置套到新会话
  const scrollRestoreRef = useRef<{ convId: number | null; height: number; top: number } | null>(null);
  // loadOlder 追加的旧消息不计入「下方新消息」计数
  const skipArrivalRef = useRef(false);

  const currentId = useMemberChatStore((s) => s.currentId);

  const memberNames = useMemo(() => members.map((m) => m.member_name), [members]);

  /** 加载更早消息：先快照滚动位置，完成后按 scrollHeight 差补偿 scrollTop */
  const handleLoadOlder = () => {
    const box = msgBoxRef.current;
    if (box) scrollRestoreRef.current = { convId: currentId, height: box.scrollHeight, top: box.scrollTop };
    skipArrivalRef.current = true;
    void loadOlderAction();
  };

  // 滚动状态：距底判定 + 新消息计数
  const nearBottomRef = useRef(true);
  const onScroll = () => {
    const box = msgBoxRef.current;
    if (!box) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (near && newBelow !== 0) setNewBelow(0);
    nearBottomRef.current = near;
    if (box.scrollTop < 40 && hasMore && !loadingOlder) handleLoadOlder();
  };

  // 新消息到达：接近底部则滚底，否则累计新消息数
  useEffect(() => {
    if (skipArrivalRef.current) {
      skipArrivalRef.current = false;
      return;
    }
    if (nearBottomRef.current) {
      msgEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setNewBelow(0);
    } else {
      setNewBelow((n) => n + 1);
    }
  }, [messages.length]);

  // loadOlder 完成（loadingOlder 回落）后恢复滚动位置；会话已切换则丢弃快照
  useEffect(() => {
    if (loadingOlder) return;
    const snap = scrollRestoreRef.current;
    if (!snap) return;
    scrollRestoreRef.current = null;
    if (snap.convId !== currentId) return;
    const box = msgBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight - snap.height + snap.top;
  }, [loadingOlder, currentId]);

  const items = useMemo(() => {
    return messages.map((m, i) => {
      const prev = i > 0 ? messages[i - 1] : null;
      const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
      const groupStart =
        newDay ||
        !prev ||
        prev.sender_id !== m.sender_id ||
        new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() > GROUP_GAP_MS;
      return { m, newDay, groupStart };
    });
  }, [messages]);

  return (
    <div className="member-chat__msgwrap">
      <div className="member-chat__messages" ref={msgBoxRef} onScroll={onScroll}>
        {hasMore && (
          <div className="member-chat__load-older" onClick={handleLoadOlder}>
            {loadingOlder
              ? t('memberChat.loading', { defaultValue: '加载中…' })
              : t('memberChat.loadOlder', { defaultValue: '加载更早消息' })}
          </div>
        )}
        {loadingMessages && messages.length === 0 && (
          <div className="member-chat__skeletons" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="member-chat__skeleton-row">
                <Skeleton style={{ width: 32, height: 32, borderRadius: '50%' }} />
                <div className="member-chat__skeleton-lines">
                  <Skeleton style={{ width: 120, height: 12 }} />
                  <Skeleton style={{ width: 280 - (i % 3) * 60, height: 12 }} />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loadingMessages && messages.length === 0 && (
          <Empty
            title={t('memberChat.noMessagesTitle', { defaultValue: '还没有消息' })}
            description={t('memberChat.noMessages', { defaultValue: '暂无消息，输入内容发送。' })}
          />
        )}
        {items.map(({ m, newDay, groupStart }) => (
          <React.Fragment key={m.id}>
            {newDay && (
              <div className="member-chat__day-sep">
                <span>{dayLabel(m.created_at, t)}</span>
              </div>
            )}
            <MessageItem
              message={m}
              convType={convType}
              isOwn={m.sender_id === session?.memberId}
              isOnline={online.has(m.sender_id)}
              canModerate={canManageMessages}
              pinned={pins.some((p) => p.message_id === m.id)}
              reactions={reactions[m.id] || []}
              myMemberId={session?.memberId ?? null}
              memberNames={memberNames}
              isGroupStart={groupStart}
              pending={(m as { status?: string }).status === 'pending'}
              onEdit={(id, text) => void editMessage(id, text)}
              onDelete={(id) => void deleteMessage(id)}
              onReact={(id, emoji) => void react(id, emoji)}
              onUnreact={(id, emoji) => void unreact(id, emoji)}
              onPinToggle={(id, p) => void pinToggle(id, p)}
            />
          </React.Fragment>
        ))}
        <div ref={msgEndRef} />
      </div>
      {newBelow > 0 && (
        <button
          className="member-chat__to-bottom"
          onClick={() => {
            setNewBelow(0);
            msgEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
        >
          ↓ {newBelow > 99 ? '99+' : newBelow}
        </button>
      )}
      <TypingIndicator />
    </div>
  );
};
