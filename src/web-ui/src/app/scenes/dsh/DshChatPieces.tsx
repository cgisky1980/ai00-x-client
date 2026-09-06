/**
 * DshChatPieces — dsh 会话消息渲染的共享件（DshScene 与 AgentTheater 会话浮层共用）。
 *
 * 抽取自 DshScene.tsx：ToolCallCard（工具调用折叠卡）+ MessageBubble（用户/助手气泡）。
 * 样式类 `ai00-x-dsh-scene__msg*` 由 DshScene.scss 定义——使用方必须 import 该样式表，
 * 保证两处对话视觉完全一致。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, CheckCircle2, RefreshCw, User, XCircle } from 'lucide-react';
import type { DshMessage } from '@/infrastructure/api/service-api/DshAPI';

/** 工具调用卡（调用参数 + 结果回填，M0.3：tool/call + tool/result 完整渲染）。 */
export const ToolCallCard: React.FC<{ call: DshMessage['toolCalls'][number] }> = ({ call }) => {
  const { t } = useTranslation('scenes/dsh');
  return (
    <details
      className={`ai00-x-dsh-scene__msg-tool${call.isError ? ' is-error' : ''}${
        call.pending ? ' is-pending' : ''
      }`}
    >
      <summary>
        {call.pending ? (
          <RefreshCw size={11} className="ai00-x-dsh-scene__msg-tool-spin" />
        ) : call.isError ? (
          <XCircle size={11} />
        ) : (
          <CheckCircle2 size={11} />
        )}
        <span>{call.name}</span>
      </summary>
      <pre>{call.arguments}</pre>
      {call.result !== undefined && (
        <div className="ai00-x-dsh-scene__msg-tool-result">
          <span className="ai00-x-dsh-scene__msg-tool-result-label">
            {call.isError ? t('tool.resultError') : t('tool.result')}
          </span>
          <pre>{call.result || t('tool.resultEmpty')}</pre>
        </div>
      )}
    </details>
  );
};

/** 消息气泡（用户/助手）。 */
export const MessageBubble: React.FC<{ message: DshMessage }> = ({ message }) => {
  const { t } = useTranslation('scenes/dsh');
  const isUser = message.role === 'user';
  return (
    <div className={`ai00-x-dsh-scene__msg ${isUser ? 'is-user' : 'is-assistant'}`}>
      <div className="ai00-x-dsh-scene__msg-avatar">
        {isUser ? <User size={13} /> : <Bot size={13} />}
      </div>
      <div className="ai00-x-dsh-scene__msg-body">
        {message.reasoning && (
          <details className="ai00-x-dsh-scene__msg-reasoning">
            <summary>{t('chat.reasoning')}</summary>
            <div>{message.reasoning}</div>
          </details>
        )}
        {message.toolCalls.map(tc => (
          <ToolCallCard key={tc.id} call={tc} />
        ))}
        {message.text && (
          <div className={`ai00-x-dsh-scene__msg-text${message.streaming ? ' is-streaming' : ''}`}>
            {message.text}
          </div>
        )}
        {message.streaming && !message.text && (
          <div className="ai00-x-dsh-scene__msg-pending">{t('chat.thinking')}</div>
        )}
        {message.error && (
          <div className="ai00-x-dsh-scene__msg-error">{message.error}</div>
        )}
      </div>
    </div>
  );
};
