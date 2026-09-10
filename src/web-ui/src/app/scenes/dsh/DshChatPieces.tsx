/**
 * DshChatPieces — dsh 会话消息渲染的共享件（DshScene 与 AgentTheater 会话浮层共用）。
 *
 * 抽取自 DshScene.tsx：ToolCallCard（工具调用折叠卡）+ MessageBubble（用户/助手气泡）。
 * 样式类 `ai00-x-dsh-scene__msg*` 由 DshScene.scss 定义——使用方必须 import 该样式表，
 * 保证两处对话视觉完全一致。
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  CheckCircle2,
  HelpCircle,
  RefreshCw,
  ShieldQuestion,
  User,
  X,
  XCircle,
} from 'lucide-react';
import { Button } from '@/component-library';
import { rememberSessionAllow } from '@/shared/agent-approval-rules';
import type {
  DshApproval,
  DshMessage,
  DshPermissionRequest,
  DshQuestion,
  DshQuestionAnswerItem,
} from '@/infrastructure/api/service-api/DshAPI';

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

/** 待处理审批卡片（工具执行确认）。 */
export const ApprovalCard: React.FC<{
  approval: DshApproval;
  onRespond: (rpcId: string, outcome: 'allowed-once' | 'rejected') => void;
}> = ({ approval, onRespond }) => {
  const { t } = useTranslation('scenes/dsh');
  return (
    <div className="ai00-x-dsh-scene__approval">
      <div className="ai00-x-dsh-scene__approval-head">
        <ShieldQuestion size={14} />
        <span className="ai00-x-dsh-scene__approval-tool">{approval.toolName}</span>
        <span className="ai00-x-dsh-scene__approval-label">{t('approval.pending')}</span>
      </div>
      {approval.reason && (
        <p className="ai00-x-dsh-scene__approval-reason">{approval.reason}</p>
      )}
      <div className="ai00-x-dsh-scene__approval-actions">
        <Button
          variant="primary"
          size="small"
          onClick={() => {
            // 「允许」= 本卡放行；「总是允许」= 额外记住本会话+该工具，
            // 后续同类审批帧由客户端自动放行（引擎词汇仅 allowed-once）
            rememberSessionAllow(approval.sessionId, approval.toolName);
            onRespond(approval.rpcId, 'allowed-once');
          }}
        >
          {t('approval.allow')}
        </Button>
        <Button
          variant="secondary"
          size="small"
          onClick={() => onRespond(approval.rpcId, 'allowed-once')}
          title="本会话内该工具不再询问（客户端记忆，引擎仍逐次确认）"
        >
          {t('approval.allowAlways', { defaultValue: '总是允许' })}
        </Button>
        <Button
          variant="secondary"
          size="small"
          onClick={() => onRespond(approval.rpcId, 'rejected')}
        >
          {t('approval.reject')}
        </Button>
      </div>
    </div>
  );
};

/** 插件 scope 授权卡（per-plugin 权限模型 v1：403 归因 → 一键授予）。 */
export const PermissionCard: React.FC<{
  request: DshPermissionRequest;
  onGrant: (request: DshPermissionRequest) => void;
  onDismiss: (request: DshPermissionRequest) => void;
}> = ({ request, onGrant, onDismiss }) => {
  const { t } = useTranslation('scenes/dsh');
  return (
    <div className="ai00-x-dsh-scene__approval">
      <div className="ai00-x-dsh-scene__approval-head">
        <ShieldQuestion size={14} />
        <span className="ai00-x-dsh-scene__approval-tool">{request.pluginId}</span>
        <span className="ai00-x-dsh-scene__approval-label">
          {t('permission.pending', { scope: request.scope })}
        </span>
      </div>
      <p className="ai00-x-dsh-scene__approval-reason">
        {t('permission.reason', { scope: request.scope })}
      </p>
      <div className="ai00-x-dsh-scene__approval-actions">
        <Button variant="primary" size="small" onClick={() => onGrant(request)}>
          {t('permission.grant')}
        </Button>
        <Button variant="secondary" size="small" onClick={() => onDismiss(request)}>
          {t('permission.deny')}
        </Button>
      </div>
    </div>
  );
};

/** 单个问题的作答区（选项按钮 + 自定义输入）。 */
const QuestionItemForm: React.FC<{
  question: DshQuestion['questions'][number];
  value: { selected: string[]; custom: string };
  onChange: (v: { selected: string[]; custom: string }) => void;
}> = ({ question, value, onChange }) => {
  const { t } = useTranslation('scenes/dsh');
  const multi = question.multiSelect === true;

  const toggleOption = (label: string) => {
    if (multi) {
      const selected = value.selected.includes(label)
        ? value.selected.filter(l => l !== label)
        : [...value.selected, label];
      onChange({ selected, custom: '' });
    } else {
      // 单选：选中即清空 custom（契约：互斥）
      onChange({ selected: [label], custom: '' });
    }
  };

  const setCustom = (custom: string) => {
    // 填 custom 即清空 selected（契约：互斥）
    onChange({ selected: custom ? [] : value.selected, custom });
  };

  return (
    <div className="ai00-x-dsh-scene__q-item">
      <div className="ai00-x-dsh-scene__q-text">{question.question}</div>
      {question.detail && <p className="ai00-x-dsh-scene__q-detail">{question.detail}</p>}
      {question.options && question.options.length > 0 && (
        <div className={`ai00-x-dsh-scene__q-options${multi ? ' is-multi' : ''}`}>
          {question.options.map(opt => {
            const active = value.selected.includes(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                className={`ai00-x-dsh-scene__q-option${active ? ' is-active' : ''}`}
                onClick={() => toggleOption(opt.label)}
                title={opt.description}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
      <input
        type="text"
        className="ai00-x-dsh-scene__q-custom"
        placeholder={t('question.customPlaceholder')}
        value={value.custom}
        onChange={e => setCustom(e.target.value)}
      />
    </div>
  );
};

/** 待处理问题批次卡片（ask_user_question 应答）。 */
export const QuestionCard: React.FC<{
  batch: DshQuestion;
  onRespond: (rpcId: string, answers: DshQuestionAnswerItem[]) => void;
  onCancel: (rpcId: string) => void;
}> = ({ batch, onRespond, onCancel }) => {
  const { t } = useTranslation('scenes/dsh');
  /** 每个问题的草稿作答。 */
  const [drafts, setDrafts] = useState<Record<string, { selected: string[]; custom: string }>>(
    () =>
      Object.fromEntries(
        batch.questions.map(q => [q.id, { selected: [] as string[], custom: '' }]),
      ),
  );

  const canSubmit = batch.questions.every(q => {
    const d = drafts[q.id];
    return !!d && (d.selected.length > 0 || d.custom.trim().length > 0);
  });

  const submit = () => {
    const answers: DshQuestionAnswerItem[] = batch.questions.map(q => {
      const d = drafts[q.id];
      const custom = d.custom.trim();
      return {
        id: q.id,
        selected: custom ? [] : d.selected,
        ...(custom ? { custom } : {}),
      };
    });
    onRespond(batch.rpcId, answers);
  };

  return (
    <div className="ai00-x-dsh-scene__question">
      <div className="ai00-x-dsh-scene__q-head">
        <HelpCircle size={14} />
        <span className="ai00-x-dsh-scene__q-head-label">{t('question.pending')}</span>
        <button
          type="button"
          className="ai00-x-dsh-scene__q-cancel"
          onClick={() => onCancel(batch.rpcId)}
          aria-label={t('question.cancel')}
        >
          <X size={12} />
        </button>
      </div>
      {batch.questions.map(q => (
        <QuestionItemForm
          key={q.id}
          question={q}
          value={drafts[q.id] ?? { selected: [], custom: '' }}
          onChange={v => setDrafts(prev => ({ ...prev, [q.id]: v }))}
        />
      ))}
      <div className="ai00-x-dsh-scene__q-actions">
        <Button variant="primary" size="small" onClick={submit} disabled={!canSubmit}>
          {t('question.submit')}
        </Button>
      </div>
    </div>
  );
};

