/**
 * ChatMessage —— AI 聊天消息（v0.15 AI 系，antd X Bubble 对位）
 * user=右侧浅青气泡；assistant=全宽无底+可选头像。
 * 内容（Markdown 等）由消费方渲染后经 children 传入。
 */
import React from 'react';
import './ChatMessage.scss';

export interface ChatMessageProps {
  role: 'user' | 'assistant';
  /** assistant 左侧头像；user 不显示 */
  avatar?: React.ReactNode;
  children: React.ReactNode;
  /** mono+tabular 时间戳 */
  time?: string;
  /** hover 显现的操作行（复制等） */
  actions?: React.ReactNode;
  /** 流式回答中：内容末尾光标（assistant） */
  streaming?: boolean;
  className?: string;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  role,
  avatar,
  children,
  time,
  actions,
  streaming = false,
  className = '',
}) => {
  const isUser = role === 'user';
  return (
    <div className={['ai-msg', `ai-msg--${role}`, className].filter(Boolean).join(' ')}>
      {!isUser && avatar != null && <div className="ai-msg__avatar">{avatar}</div>}
      <div className="ai-msg__main">
        <div className="ai-msg__bubble">
          {children}
          {streaming && !isUser && <span className="ai-msg__cursor" aria-hidden="true" />}
        </div>
        {(actions != null || time != null) && (
          <div className="ai-msg__foot">
            {actions != null && <div className="ai-msg__actions">{actions}</div>}
            {time != null && <span className="ai-msg__time">{time}</span>}
          </div>
        )}
      </div>
    </div>
  );
};
