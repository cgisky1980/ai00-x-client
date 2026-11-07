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
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  HelpCircle,
  RefreshCw,
  ShieldQuestion,
  User,
  X,
  XCircle,
} from 'lucide-react';
import { Button, MarkdownRenderer } from '@/component-library';
import { rememberSessionAllow } from '@/shared/agent-approval-rules';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
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

/**
 * 去掉引擎写在文本块里的**已序列化工具调用**（形如
 * `read{"file_path":"…"}write{"file_path":"…"}`）。
 *
 * 这类内容与工具卡是同一件事：模型/适配层没走 tool-call 块，而是把调用序列化进
 * 文本通道。这里按「名字 + JSON 对象」精确切除，且只在对象体首字符是引号键时处理，
 * 避免误伤正文里出现的 `函数名{…}` 描述。
 */
function stripSerializedToolCalls(text: string): string {
  const callStart = /[A-Za-z_][\w.-]*(?=\{)/g;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = callStart.exec(text)) !== null) {
    const braceIndex = match.index + match[0].length;
    const end = findJsonObjectEnd(text, braceIndex);
    const body = text.slice(braceIndex + 1, end === -1 ? text.length : end);
    if (!/^\s*"/.test(body)) continue;
    result += text.slice(cursor, match.index);
    cursor = end === -1 ? text.length : end + 1;
    callStart.lastIndex = cursor;
  }
  return result + text.slice(cursor);
}

/** 从 `{` 起按字符串/转义感知的括号配对找对象结束位置；未闭合返回 -1。 */
function findJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function sanitizeAssistantText(text: string): string {
  return stripSerializedToolCalls(text)
    .replace(/<\/?(?:tool_call|tool_calls|arg_value|arguments|parameter|function_call|invoke|result)\b[^>]*>/gi, '')
    // `[工具] name({…})` 是引擎在正文里复述的工具调用，已由工具卡单独呈现 → 直接去掉
    .replace(/\[工具\]\s*[\w.-]+\([^\n]*\)\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** token 数的紧凑写法：1234 → 1.2k（用量是机器输出，固定 mono 呈现）。 */
function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  const scaled = value / 1000;
  return `${scaled >= 10 ? Math.round(scaled) : Number(scaled.toFixed(1))}k`;
}

/** 已知引擎/网关错误的归类结果（key 对应 locales `scenes/dsh` → `chat.error.*`）。 */
interface ChatErrorDescription {
  key: string;
  detail?: string;
}

/**
 * 把引擎/网关的英文错误原文翻成人话：只归类高频几类，未识别的返回 null
 * （调用方保留原文，避免为了好看而丢排查信息）。
 */
function describeChatError(raw: string): ChatErrorDescription | null {
  const text = raw.trim();
  if (!text) return null;
  // 模型引用可能自身带冒号（`ai00s:GLM-4.7-Flash`），所以不能按「首个冒号」截断
  let m = text.match(/Cannot switch to [\s\S]+?context compaction failed:?([\s\S]*)/i);
  if (m) return { key: 'switchCompaction', detail: m[1].trim().slice(0, 160) };
  m = text.match(/Model configuration not found:\s*(.+)/i);
  if (m) return { key: 'modelNotConfigured', detail: m[1].trim() };
  if (/session\/model-unavailable|model-unavailable/i.test(text)) return { key: 'modelUnavailable' };
  m = text.match(/dsh rpc (\S+) HTTP (50\d)/i);
  if (m) return { key: 'engineUnavailable', detail: `${m[1]} ${m[2]}` };
  if (/HTTP 401|unauthorized|invalid internal token/i.test(text)) return { key: 'authExpired' };
  if (/quota|insufficient_quota|额度不足|余额不足/i.test(text)) return { key: 'quota' };
  if (/fetch failed|ECONNREFUSED|network error/i.test(text)) return { key: 'network' };
  return null;
}

/** 错误文本渲染：命中已知模式走人话，否则原样显示。 */
export const ChatErrorText: React.FC<{ raw: string }> = ({ raw }) => {
  const { t } = useTranslation('scenes/dsh');
  const described = describeChatError(raw);
  if (!described) return <>{raw}</>;
  return <>{t(`chat.error.${described.key}`, { detail: described.detail ?? '' })}</>;
};

export const MessageBubble: React.FC<{ message: DshMessage }> = ({ message }) => {
  const { t } = useTranslation('scenes/dsh');
  const isUser = message.role === 'user';
  /** 推理过程默认折叠；只在展开时渲染 markdown，避免长历史每条消息都做一遍解析。 */
  const [reasoningOpen, setReasoningOpen] = useState(false);
  /** 用户输入原样展示；助手文本先清掉引擎泄漏的工具调用残片。 */
  const displayText = isUser ? message.text : sanitizeAssistantText(message.text);
  /** 复制整条回复（复制后 1.5s 内显示「已复制」）。 */
  const [copied, setCopied] = useState(false);
  const handleCopy = async (): Promise<void> => {
    // 走共享 helper：异步剪贴板被拒时自动退回 execCommand（WebView2 无焦点场景）
    if (await copyTextToClipboard(displayText)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className={`ai00-x-dsh-scene__msg ${isUser ? 'is-user' : 'is-assistant'}`}>
      <div className="ai00-x-dsh-scene__msg-avatar">
        {isUser ? <User size={13} /> : <Bot size={13} />}
      </div>
      <div className="ai00-x-dsh-scene__msg-body">
        {message.reasoning && (
          <details
            className="ai00-x-dsh-scene__msg-reasoning"
            open={reasoningOpen}
            onToggle={e => setReasoningOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>{t('chat.reasoning')}</summary>
            {/* 推理过程同样是 markdown（标题/列表/行内代码）：原样输出会把 ## 和反引号暴露给用户 */}
            {reasoningOpen && (
              <div className="ai00-x-dsh-scene__msg-reasoning-body">
                <MarkdownRenderer content={message.reasoning} isStreaming={message.streaming} />
              </div>
            )}
          </details>
        )}
        {/*
          按时间顺序渲染片段：一次模型响应 = 一段（先该段的工具卡，再该段正文）。
          这样「工具 → 中间说明 → 工具 → 结论」不会被压平成「所有工具 + 一段长正文」。
          没有 segments 的消息（用户消息 / 未合并的实时流）退化成单段。
        */}
        {(message.segments && message.segments.length > 0
          ? message.segments
          : [{ text: displayText, toolCalls: message.toolCalls }]
        ).map((segment, index, list) => {
          const isLast = index === list.length - 1;
          const segmentText = isUser ? segment.text : sanitizeAssistantText(segment.text);
          return (
            <div className="ai00-x-dsh-scene__msg-segment" key={`${message.id}-seg-${index}`}>
              {segment.toolCalls.map(tc => (
                <ToolCallCard key={tc.id} call={tc} />
              ))}
              {segmentText &&
                (isUser ? (
                  <div className="ai00-x-dsh-scene__msg-text">{segmentText}</div>
                ) : (
                  <div
                    className={`ai00-x-dsh-scene__msg-text is-markdown${
                      message.streaming && isLast ? ' is-streaming' : ''
                    }`}
                  >
                    <MarkdownRenderer
                      content={segmentText}
                      isStreaming={message.streaming && isLast}
                    />
                  </div>
                ))}
            </div>
          );
        })}
        {message.streaming && !displayText && (
          <div className="ai00-x-dsh-scene__msg-pending">{t('chat.thinking')}</div>
        )}
        {!isUser && !message.streaming && (displayText || message.usage) && (
          <div className="ai00-x-dsh-scene__msg-meta">
            {message.usage && (
              <span
                className="ai00-x-dsh-scene__msg-usage"
                title={t('chat.usageTitle', {
                  input: message.usage.inputTokens,
                  output: message.usage.outputTokens,
                })}
              >
                <ArrowUp size={11} aria-hidden="true" />
                <span>{formatTokens(message.usage.inputTokens)}</span>
                <ArrowDown size={11} aria-hidden="true" />
                <span>{formatTokens(message.usage.outputTokens)}</span>
              </span>
            )}
            {displayText && (
              <div className="ai00-x-dsh-scene__msg-actions">
                <button
                  type="button"
                  className={`ai00-x-dsh-scene__msg-copy${copied ? ' is-copied' : ''}`}
                  onClick={() => void handleCopy()}
                  aria-label={copied ? t('chat.copied') : t('chat.copyMessage')}
                  title={copied ? t('chat.copied') : t('chat.copyMessage')}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copied ? t('chat.copied') : t('chat.copyMessage')}</span>
                </button>
              </div>
            )}
          </div>
        )}
        {message.toolCallUnparsed && (
          <div className="ai00-x-dsh-scene__msg-error">{t('chat.toolCallUnparsed')}</div>
        )}
        {message.error && (
          <div className="ai00-x-dsh-scene__msg-error">
            <ChatErrorText raw={message.error} />
          </div>
        )}
      </div>
    </div>
  );
};

/** 待处理审批卡片（工具执行确认；exit_plan_mode 渲染为计划评审卡）。 */
export const ApprovalCard: React.FC<{
  approval: DshApproval;
  onRespond: (rpcId: string, outcome: 'allowed-once' | 'rejected') => void;
  /** exit_plan_mode 的计划正文（由调用方从会话工具调用参数提取）。 */
  planText?: string;
}> = ({ approval, onRespond, planText }) => {
  const { t } = useTranslation('scenes/dsh');
  const isPlan = approval.toolName === 'exit_plan_mode';
  return (
    <div className="ai00-x-dsh-scene__approval">
      <div className="ai00-x-dsh-scene__approval-head">
        <ShieldQuestion size={14} />
        <span className="ai00-x-dsh-scene__approval-tool">
          {isPlan ? t('plan.cardTitle') : approval.toolName}
        </span>
        <span className="ai00-x-dsh-scene__approval-label">{t('approval.pending')}</span>
      </div>
      {isPlan && planText ? (
        <pre className="ai00-x-dsh-scene__approval-plan">{planText}</pre>
      ) : (
        approval.reason && <p className="ai00-x-dsh-scene__approval-reason">{approval.reason}</p>
      )}
      <div className="ai00-x-dsh-scene__approval-actions">
        <Button
          variant="primary"
          size="small"
          onClick={() => {
            // 「允许」= 本卡放行；「总是允许」= 额外记住本会话+该工具，
            // 后续同类审批帧由客户端自动放行（引擎词汇仅 allowed-once）
            if (!isPlan) rememberSessionAllow(approval.sessionId, approval.toolName);
            onRespond(approval.rpcId, 'allowed-once');
          }}
        >
          {isPlan ? t('plan.approve') : t('approval.allow')}
        </Button>
        {!isPlan && (
          <Button
            variant="secondary"
            size="small"
            onClick={() => onRespond(approval.rpcId, 'allowed-once')}
            title="本会话内该工具不再询问（客户端记忆，引擎仍逐次确认）"
          >
            {t('approval.allowAlways', { defaultValue: '总是允许' })}
          </Button>
        )}
        <Button
          variant="secondary"
          size="small"
          onClick={() => onRespond(approval.rpcId, 'rejected')}
        >
          {isPlan ? t('plan.reject') : t('approval.reject')}
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

