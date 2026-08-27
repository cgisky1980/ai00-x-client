/**
 * MessageItem — 单条消息渲染（含 hover 工具条 / 回应 chips / 行内编辑）。
 */
import React, { useState } from 'react';
import type { ChatMessage, ChatReaction } from './chatApi';

/** 简易渲染：HTML 转义防 XSS + **加粗** / `代码` / 链接 / 换行 */
export function renderText(content: string): string {
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

/** 常用 emoji 快选 */
export const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '😮', '🔥'];

interface MessageItemProps {
  message: ChatMessage;
  isOwn: boolean;
  isOnline: boolean;
  /** 是否有 manage_messages 权限（删除/置顶他人消息） */
  canModerate: boolean;
  /** 是否 official 频道（pin 仅 official） */
  canPin: boolean;
  pinned: boolean;
  reactions: ChatReaction[];
  myMemberId: number | null;
  onEdit(id: number, content: string): void;
  onDelete(id: number): void;
  onReact(id: number, emoji: string): void;
  onUnreact(id: number, emoji: string): void;
  onPinToggle(id: number, pinned: boolean): void;
}

interface ReactionGroup {
  emoji: string;
  count: number;
  mine: boolean;
}

const MessageItem: React.FC<MessageItemProps> = ({
  message,
  isOwn,
  isOnline,
  canModerate,
  canPin,
  pinned,
  reactions,
  myMemberId,
  onEdit,
  onDelete,
  onReact,
  onUnreact,
  onPinToggle,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [showEmoji, setShowEmoji] = useState(false);

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

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };

  const saveEdit = () => {
    const text = draft.trim();
    if (text && text !== message.content) onEdit(message.id, text);
    setEditing(false);
  };

  if (message.deleted_at) {
    return (
      <div className="member-chat__message member-chat__message--deleted">
        <span className="member-chat__deleted-text">消息已删除</span>
      </div>
    );
  }

  return (
    <div className="member-chat__message" data-mid={message.id}>
      <div className="member-chat__message-head">
        <span className="member-chat__sender">{message.sender_name}</span>
        {isOnline && <span className="member-chat__online-dot" title="在线" />}
        {pinned && (
          <span className="member-chat__pin-flag" title="已置顶">
            📌
          </span>
        )}
        <span className="member-chat__time">
          {new Date(message.created_at).toLocaleTimeString()}
        </span>
        <span className="member-chat__msg-actions">
          {canPin && (
            <button
              className="member-chat__msg-btn"
              title={pinned ? '取消置顶' : '置顶'}
              onClick={() => onPinToggle(message.id, !pinned)}
            >
              {pinned ? '📍' : '📌'}
            </button>
          )}
          <button
            className="member-chat__msg-btn"
            title="添加回应"
            onClick={() => setShowEmoji((v) => !v)}
          >
            😊
          </button>
          {isOwn && (
            <button className="member-chat__msg-btn" title="编辑" onClick={startEdit}>
              ✏️
            </button>
          )}
          {(isOwn || canModerate) && (
            <button
              className="member-chat__msg-btn"
              title="删除"
              onClick={() => {
                if (window.confirm('确认删除这条消息？')) onDelete(message.id);
              }}
            >
              🗑️
            </button>
          )}
        </span>
      </div>

      {showEmoji && (
        <div className="member-chat__emoji-picker">
          {QUICK_EMOJIS.map((e) => (
            <button
              key={e}
              className="member-chat__emoji-btn"
              onClick={() => {
                const g = groups.find((x) => x.emoji === e);
                if (g?.mine) onUnreact(message.id, e);
                else onReact(message.id, e);
                setShowEmoji(false);
              }}
            >
              {e}
            </button>
          ))}
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
              保存
            </button>
            <button className="member-chat__edit-cancel" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div
          className="member-chat__message-body"
          dangerouslySetInnerHTML={{ __html: renderText(message.content) }}
        />
      )}

      {groups.length > 0 && (
        <div className="member-chat__reactions">
          {groups.map((g) => (
            <button
              key={g.emoji}
              className={`member-chat__reaction-chip ${g.mine ? 'is-mine' : ''}`}
              title={g.mine ? '点击取消回应' : '点击回应'}
              onClick={() => (g.mine ? onUnreact(message.id, g.emoji) : onReact(message.id, g.emoji))}
            >
              <span>{g.emoji}</span>
              <span className="member-chat__reaction-count">{g.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default MessageItem;
