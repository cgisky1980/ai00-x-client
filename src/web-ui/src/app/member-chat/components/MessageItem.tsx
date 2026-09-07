/**
 * MessageItem — 单条消息（新东方极简重做）
 *
 * - 连续消息分组：非首条不显示头部（头像/名字/时间）
 * - hover 工具条：IconButton + Tooltip + Popover emoji 快选（禁手写弹出）
 * - 能力矩阵：官方频道全能力；私聊/房间临时消息（id≤0）禁编辑/删除/回应
 * - @提及高亮（匹配成员名）；日期/时间 mono
 */
import React, { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import {
  confirmDialog,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from '@/component-library';
import { MemberAvatar } from './MemberAvatar';
import type { ChatMessage, ChatReaction } from '../chatApi';
import type { ConversationType } from '../store/memberChatStore';

/** 常用 emoji 快选 */
const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '😮', '🔥'];

/** 渲染文本：HTML 转义 + **加粗** / `代码` / 链接 / @提及 / 换行 */
function renderText(content: string, mentionNames: string[] = []): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = esc(content);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  // @提及：按名字长度降序匹配，避免前缀遮蔽
  if (mentionNames.length > 0) {
    const sorted = [...mentionNames].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(
        new RegExp(`@(${safe})(?!\\w)`, 'g'),
        '<span class="member-chat__mention">@$1</span>',
      );
    }
  }
  html = html.replace(/\n/g, '<br/>');
  return html;
}

interface ReactionGroup {
  emoji: string;
  count: number;
  mine: boolean;
}

interface MessageItemProps {
  message: ChatMessage;
  convType: ConversationType;
  isOwn: boolean;
  isOnline: boolean;
  canModerate: boolean;
  pinned: boolean;
  reactions: ChatReaction[];
  myMemberId: number | null;
  memberNames: string[];
  isGroupStart: boolean;
  /** 发送方本机：消息尚未收到对方送达回执 */
  pending?: boolean;
  onEdit(id: number, content: string): void;
  onDelete(id: number): void;
  onReact(id: number, emoji: string): void;
  onUnreact(id: number, emoji: string): void;
  onPinToggle(id: number, pinned: boolean): void;
}

const MessageItem: React.FC<MessageItemProps> = ({
  message,
  convType,
  isOwn,
  isOnline,
  canModerate,
  pinned,
  reactions,
  myMemberId,
  memberNames,
  isGroupStart,
  pending,
  onEdit,
  onDelete,
  onReact,
  onUnreact,
  onPinToggle,
}) => {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // 受控 hover：CSS :hover 在鼠标移向 portal 弹层时丢失会导致工具条卸载、
  // Popover 锚点消失、面板连带关闭——改用 React state（hovered || emojiOpen || editing
  // 时工具条强制显示），鼠标路径再也不会打断点选
  const [hovered, setHovered] = useState(false);

  const ephemeral = message.id <= 0; // room/DM 临时消息（服务端不落库）
  const canPin = convType === 'official' && !ephemeral;
  const canModerateHere = convType === 'official' && canModerate && !ephemeral;

  // 按 emoji 聚合
  const groups: ReactionGroup[] = (() => {
    const map = new Map<string, ReactionGroup>();
    for (const r of reactions) {
      const g = map.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
      g.count += 1;
      if (r.member_id === myMemberId) g.mine = true;
      map.set(r.emoji, g);
    }
    return [...map.values()];
  })();

  const saveEdit = () => {
    const text = draft.trim();
    if (text && text !== message.content) onEdit(message.id, text);
    setEditing(false);
  };

  if (message.deleted_at) {
    return (
      <div className="member-chat__message member-chat__message--deleted" data-mid={message.id}>
        <span className="member-chat__deleted-text">
          {t('memberChat.msgDeleted', { defaultValue: '消息已删除' })}
        </span>
      </div>
    );
  }

  const timeLabel = new Date(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const ephemeralHint = ephemeral
    ? convType === 'dm'
      ? t('memberChat.ephemeralDm', {
          defaultValue: '临时消息，仅保存在本机，不可编辑/回应；离线期间不送达',
        })
      : t('memberChat.ephemeralRoom', { defaultValue: '临时消息，不会长期保存，不可编辑/回应' })
    : '';

  return (
    <div
      className={`member-chat__message ${isGroupStart ? '' : 'member-chat__message--cont'} ${
        hovered || emojiOpen || editing ? 'is-active' : ''
      }`}
      data-mid={message.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {isGroupStart && (
        <div className="member-chat__message-head">
          <MemberAvatar name={message.sender_name} size="sm" data={message.sender_avatar} />
          <span className="member-chat__sender">{message.sender_name}</span>
          {isOnline && <span className="member-chat__online-dot" title="在线" />}
          {pinned && (
            <span className="member-chat__pin-flag" title={t('memberChat.pinned', { defaultValue: '已置顶' })}>
              📌
            </span>
          )}
          <time className="member-chat__time">{timeLabel}</time>
          {isOwn && pending && (
            <Tooltip
              content={t('memberChat.pendingAck', {
                defaultValue: '待送达：对方上线后将自动补发',
              })}
              placement="top"
            >
              <span className="member-chat__pending-flag" aria-label="pending">
                ⏳
              </span>
            </Tooltip>
          )}
        </div>
      )}

      {editing ? (
        <div className="member-chat__edit-box">
          <textarea
            className="member-chat__edit-input"
            rows={2}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                saveEdit();
              } else if (e.key === 'Escape') {
                setEditing(false);
              }
            }}
          />
          <div className="member-chat__edit-actions">
            <button className="member-chat__edit-save" onClick={saveEdit}>
              {t('memberChat.save', { defaultValue: '保存' })}
            </button>
            <button className="member-chat__edit-cancel" onClick={() => setEditing(false)}>
              {t('memberChat.cancel', { defaultValue: '取消' })}
            </button>
          </div>
        </div>
      ) : (
        <div
          className="member-chat__message-body"
          dangerouslySetInnerHTML={{ __html: renderText(message.content, memberNames) }}
        />
      )}

      {groups.length > 0 && (
        <div className="member-chat__reactions">
          {groups.map((g) => (
            <button
              key={g.emoji}
              className={`member-chat__reaction-chip ${g.mine ? 'is-mine' : ''}`}
              title={g.mine
                ? t('memberChat.unreactHint', { defaultValue: '点击取消回应' })
                : t('memberChat.reactHint', { defaultValue: '点击回应' })}
              onClick={() => (g.mine ? onUnreact(message.id, g.emoji) : onReact(message.id, g.emoji))}
            >
              <span>{g.emoji}</span>
              <span className="member-chat__reaction-count">{g.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* hover 工具条 */}
      <div className="member-chat__msg-toolbar">
        {ephemeral ? (
          <Tooltip content={ephemeralHint} placement="top">
            <span className="member-chat__ephemeral-hint">⏳</span>
          </Tooltip>
        ) : (
          <>
            <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverTrigger asChild>
                <IconButton
                  variant="ghost"
                  size="xs"
                  shape="square"
                  tooltip="回应"
                  aria-label={t('memberChat.reactAction', { defaultValue: '添加回应' })}
                >
                  😊
                </IconButton>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="member-chat__emoji-pop">
                {QUICK_EMOJIS.map((e) => {
                  const g = groups.find((x) => x.emoji === e);
                  return (
                    <button
                      key={e}
                      className="member-chat__emoji-btn"
                      onClick={() => {
                        if (g?.mine) onUnreact(message.id, e);
                        else onReact(message.id, e);
                        setEmojiOpen(false);
                      }}
                    >
                      {e}
                    </button>
                  );
                })}
              </PopoverContent>
            </Popover>
            {isOwn && (
              <IconButton
                variant="ghost"
                size="xs"
                shape="square"
                tooltip={t('memberChat.editAction', { defaultValue: '编辑' })}
                aria-label={t('memberChat.editAction', { defaultValue: '编辑' })}
                onClick={() => {
                  setDraft(message.content);
                  setEditing(true);
                }}
              >
                ✏️
              </IconButton>
            )}
            {(isOwn || canModerateHere) && (
              <IconButton
                variant="ghost"
                size="xs"
                shape="square"
                tooltip={t('memberChat.deleteAction', { defaultValue: '删除' })}
                aria-label={t('memberChat.deleteAction', { defaultValue: '删除' })}
                onClick={() => {
                  void confirmDialog({
                    title: t('memberChat.deleteConfirmTitle', { defaultValue: '删除消息' }),
                    message: t('memberChat.deleteConfirmMsg', {
                      defaultValue: '确认删除这条消息？',
                    }),
                    confirmDanger: true,
                  }).then((ok) => {
                    if (ok) onDelete(message.id);
                  });
                }}
              >
                🗑️
              </IconButton>
            )}
            {canPin && (
              <IconButton
                variant="ghost"
                size="xs"
                shape="square"
                tooltip={pinned
                  ? t('memberChat.unpinAction', { defaultValue: '取消置顶' })
                  : t('memberChat.pinAction', { defaultValue: '置顶' })}
                aria-label={pinned
                  ? t('memberChat.unpinAction', { defaultValue: '取消置顶' })
                  : t('memberChat.pinAction', { defaultValue: '置顶' })}
                onClick={() => onPinToggle(message.id, !pinned)}
              >
                📌
              </IconButton>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default MessageItem;
