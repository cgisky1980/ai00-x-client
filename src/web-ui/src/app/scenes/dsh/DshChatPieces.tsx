/**
 * DshChatPieces — dsh 会话消息渲染的共享件（DshScene 与 AgentTheater 会话浮层共用）。
 *
 * 抽取自 DshScene.tsx：ToolCallCard（工具调用折叠卡）+ MessageBubble（用户/助手气泡）。
 * 样式类 `ai00-x-dsh-scene__msg*` 由 DshScene.scss 定义——使用方必须 import 该样式表，
 * 保证两处对话视觉完全一致。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Coins,
  Copy,
  HelpCircle,
  Minus,
  Quote,
  RefreshCw,
  RotateCcw,
  ShieldQuestion,
  X,
  XCircle,
} from 'lucide-react';
import { Button, MarkdownRenderer } from '@/component-library';
import { rememberSessionAllow } from '@/shared/agent-approval-rules';
import { formatCredits } from '@/infrastructure/api/service-api/AiUsageAPI';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
import type {
  DshApproval,
  DshMessage,
  DshPermissionRequest,
  DshQuestion,
  DshQuestionAnswerItem,
  DshToolCallView,
} from '@/infrastructure/api/service-api/DshAPI';
import type { DshResolutionEntry } from './hooks/useDshChat';

/**
 * 工具参数的可读化：能解析成对象就按「键 → 值」摊开（字符串值保留真实换行），
 * 解析失败才退回原始文本。原始参数是一整串转义 JSON（`\n`、`\"`），
 * 直接 `<pre>` 出来人根本读不了。
 */
function parseToolArguments(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 折叠行的一句话摘要：优先取任务描述类字段，其次取最常见的路径/命令字段。 */
const SUMMARY_KEYS = ['description', 'message', 'query', 'command', 'path', 'file_path', 'taskId'];

function toolSummary(args: Record<string, unknown> | null): string {
  if (!args) return '';
  for (const key of SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const firstLine = value.trim().split(/\r?\n/, 1)[0] ?? '';
    return firstLine.length > 72 ? `${firstLine.slice(0, 72)}…` : firstLine;
  }
  return '';
}

/** 参数值渲染：字符串原样（真实换行），其余 JSON 美化。 */
function formatToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 工具调用卡（调用参数 + 结果回填，M0.3：tool/call + tool/result 完整渲染）。 */
export const ToolCallCard: React.FC<{ call: DshMessage['toolCalls'][number] }> = ({ call }) => {
  const { t } = useTranslation('scenes/dsh');
  const args = useMemo(() => parseToolArguments(call.arguments), [call.arguments]);
  const summary = useMemo(() => toolSummary(args), [args]);
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
        <span className="ai00-x-dsh-scene__msg-tool-name">{call.name}</span>
        {summary && <span className="ai00-x-dsh-scene__msg-tool-brief">{summary}</span>}
      </summary>
      {args ? (
        <div className="ai00-x-dsh-scene__msg-tool-args">
          {Object.entries(args).map(([key, value]) => (
            <div key={key} className="ai00-x-dsh-scene__msg-tool-field">
              <span className="ai00-x-dsh-scene__msg-tool-key">{key}</span>
              <span className="ai00-x-dsh-scene__msg-tool-value">{formatToolValue(value)}</span>
            </div>
          ))}
        </div>
      ) : (
        <pre>{call.arguments}</pre>
      )}
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
    // `[工具] name({…})` / `[Tool] name({…})` 是引擎在正文里复述的工具调用，
    // 已由工具卡单独呈现 → 直接去掉（子代理结束通知里常见这种残留）
    .replace(/\[(?:工具|Tool)\]\s*[\w.-]+\([^\n]*\)\s*/gi, '')
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
  // 上游响应被截断/解码失败（网关透传的 reqwest 原文，实测一条中文都读不出来）
  if (
    /error decoding response body|upstream stream (interrupted|error)|upstream request failed|upstream returned empty body|upstream 50[234]/i.test(
      text,
    )
  ) {
    return { key: 'upstreamBroken' };
  }
  return null;
}

/** 错误文本渲染：命中已知模式走人话，否则原样显示。 */
export const ChatErrorText: React.FC<{ raw: string }> = ({ raw }) => {
  const { t } = useTranslation('scenes/dsh');
  const described = describeChatError(raw);
  if (!described) return <>{raw}</>;
  return <>{t(`chat.error.${described.key}`, { detail: described.detail ?? '' })}</>;
};

/** 办结记录行：审批/提问批后塌缩为一行只读记录（留在消息流里可回溯）。 */
export const ResolutionLogLine: React.FC<{ entry: DshResolutionEntry }> = ({ entry }) => {
  const { t } = useTranslation('scenes/dsh');
  const time = new Date(entry.at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const text =
    entry.kind === 'approval'
      ? t(
          entry.outcome === 'allowed-once'
            ? 'approval.logAllowed'
            : entry.outcome === 'rejected'
              ? 'approval.logRejected'
              : 'approval.logCancelled',
          { tool: entry.subject },
        )
      : entry.outcome === 'answered'
        ? t('question.logAnswered', { summary: entry.subject })
        : t('question.logCancelled');
  const positive = entry.outcome === 'allowed-once' || entry.outcome === 'answered';
  const Icon = positive ? Check : entry.outcome === 'rejected' ? X : Minus;
  return (
    <div className={`ai00-x-dsh-scene__logline is-${entry.outcome}`}>
      <Icon size={11} aria-hidden="true" />
      <span className="ai00-x-dsh-scene__logline-text">{text}</span>
      <span className="ai00-x-dsh-scene__logline-time">{time}</span>
    </div>
  );
};

export const MessageBubble: React.FC<{
  message: DshMessage;
  /** 重试本回合（仅最后一条助手消息传入；点击重发上一条用户输入）。 */
  onRetry?: () => void;
  /** 引用回复：把选中文本（无选中则整条正文）注入输入框。 */
  onQuote?: (text: string) => void;
  /**
   * 自定义工具卡渲染（返回 null 时退回默认 ToolCallCard）。
   * 工作台用它把 worker 派发渲染成子代理卡；dsh 场景不传，保持原样。
   */
  renderToolCall?: (call: DshToolCallView) => React.ReactNode;
  /** 反查来源会话的展示名（子代理 label），查不到时退回短 id。 */
  resolveOriginLabel?: (sessionId: string) => string | null;
  /** 本回合消耗的积分（服务端账单口径；无数据时不显示）。 */
  credits?: number;
  /**
   * 是否在气泡底部显示单条 token 用量（↑输入 ↓输出）。
   * 工作台对话传 false：那里只在「本轮」行报数，避免同一屏两处消耗口径。
   */
  showUsage?: boolean;
}> = ({
  message,
  onRetry,
  onQuote,
  renderToolCall,
  resolveOriginLabel,
  credits,
  showUsage = true,
}) => {
  const { t } = useTranslation('scenes/dsh');
  const isUser = message.role === 'user' && !message.origin;
  /** 推理过程默认折叠；只在展开时渲染 markdown，避免长历史每条消息都做一遍解析。 */
  const [reasoningOpen, setReasoningOpen] = useState(false);
  /** 推理耗时：流式期间实时计时（500ms tick），回合结束定格；历史回放（非流式）不显示。 */
  const reasoningStartRef = useRef<number | null>(null);
  const [reasoningSecs, setReasoningSecs] = useState<number | null>(null);
  const reasoningLive = !isUser && !!message.reasoning && message.streaming;
  useEffect(() => {
    if (!reasoningLive) return;
    reasoningStartRef.current ??= Date.now();
    const tick = (): void => {
      if (reasoningStartRef.current !== null) {
        setReasoningSecs((Date.now() - reasoningStartRef.current) / 1000);
      }
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [reasoningLive]);
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
  /** 引用：优先取用户在气泡里的选中文本，无选中则引用整条正文。 */
  const handleQuote = (): void => {
    if (!onQuote) return;
    const selected = window.getSelection()?.toString().trim();
    onQuote(selected || displayText);
  };
  /**
   * 子代理来源记录（relay / settled）：不是人类发言，走左侧细线记录样式，
   * 不再冒充右对齐用户气泡。来源名优先用调用方反查到的 label，兜底短 id。
   */
  if (message.origin) {
    const settled = message.origin === 'system';
    const who = message.senderSessionId
      ? resolveOriginLabel?.(message.senderSessionId) || message.senderSessionId.slice(0, 8)
      : '';
    return (
      <div className={`ai00-x-dsh-scene__msg is-origin is-${message.origin}`}>
        <div className="ai00-x-dsh-scene__msg-origin-head">
          <span className="ai00-x-dsh-scene__msg-origin-kind">
            {settled ? t('origin.settled') : t('origin.relay')}
          </span>
          {who && <span className="ai00-x-dsh-scene__msg-origin-who">{who}</span>}
          {settled && message.originLabel && message.originLabel !== displayText && (
            <span className="ai00-x-dsh-scene__msg-origin-summary" title={message.originLabel}>
              {message.originLabel}
            </span>
          )}
        </div>
        {displayText && (
          <div className="ai00-x-dsh-scene__msg-text is-markdown">
            <MarkdownRenderer content={displayText} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={`ai00-x-dsh-scene__msg ${isUser ? 'is-user' : 'is-assistant'}`}>
      <div className="ai00-x-dsh-scene__msg-body">
        {message.reasoning && (
          <details
            className="ai00-x-dsh-scene__msg-reasoning"
            open={reasoningOpen}
            onToggle={e => setReasoningOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              {t('chat.reasoning')}
              {reasoningSecs != null && (
                <span className="ai00-x-dsh-scene__msg-reasoning-time">
                  {Math.max(1, Math.round(reasoningSecs))}s
                </span>
              )}
            </summary>
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
                <React.Fragment key={tc.id}>
                  {renderToolCall?.(tc) ?? <ToolCallCard call={tc} />}
                </React.Fragment>
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
            {showUsage && message.usage && (
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
            {credits != null && credits > 0 && (
              <span
                className="ai00-x-dsh-scene__msg-usage"
                title={t('chat.creditsTitle', { credits: formatCredits(credits) })}
              >
                <Coins size={11} aria-hidden="true" />
                <span>{formatCredits(credits)}</span>
              </span>
            )}
            {(displayText || onRetry) && (
              <div className="ai00-x-dsh-scene__msg-actions">
                {displayText && (
                  <button
                    type="button"
                    className={`ai00-x-dsh-scene__msg-copy${copied ? ' is-copied' : ''}`}
                    onClick={() => void handleCopy()}
                    aria-label={copied ? t('chat.copied') : t('chat.copyMessage')}
                    title={copied ? t('chat.copied') : t('chat.copyMessage')}
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                )}
                {displayText && onQuote && (
                  <button
                    type="button"
                    className="ai00-x-dsh-scene__msg-copy"
                    onClick={handleQuote}
                    aria-label={t('chat.quote')}
                    title={t('chat.quote')}
                  >
                    <Quote size={12} />
                  </button>
                )}
                {onRetry && (
                  <button
                    type="button"
                    className="ai00-x-dsh-scene__msg-copy"
                    onClick={onRetry}
                    aria-label={t('chat.retryTurn')}
                    title={t('chat.retryTurn')}
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
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
          {question.options.map((opt, index) => {
            const active = value.selected.includes(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                className={`ai00-x-dsh-scene__q-option${active ? ' is-active' : ''}`}
                onClick={() => toggleOption(opt.label)}
                title={opt.description}
              >
                <span className="ai00-x-dsh-scene__q-option-index" aria-hidden="true">
                  {index + 1}
                </span>
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

  /** 首个带选项的问题（数字键直选的作用对象；多题批次的常见形态是单题）。 */
  const firstWithOptions = batch.questions.find(q => (q.options?.length ?? 0) > 0);

  /** 卡片挂载即接管焦点：提问是阻塞式交互，数字键/Enter 直接可用。 */
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (e.key === 'Enter') {
      // Enter 提交：只认卡片本体/自定义输入框上的 Enter（选项按钮上的 Enter 走 click 切换）
      if (canSubmit && (target === e.currentTarget || target.tagName === 'INPUT')) {
        e.preventDefault();
        submit();
      }
      return;
    }
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    const n = Number.parseInt(e.key, 10);
    if (!Number.isInteger(n) || n < 1 || n > 9 || !firstWithOptions?.options) return;
    const opt = firstWithOptions.options[n - 1];
    if (!opt) return;
    e.preventDefault();
    const d = drafts[firstWithOptions.id] ?? { selected: [], custom: '' };
    const multi = firstWithOptions.multiSelect === true;
    const selected = multi
      ? d.selected.includes(opt.label)
        ? d.selected.filter(l => l !== opt.label)
        : [...d.selected, opt.label]
      : [opt.label];
    setDrafts(prev => ({ ...prev, [firstWithOptions.id]: { selected, custom: '' } }));
  };

  return (
    // 卡片本体是键盘容器（tabIndex=-1 不参与 Tab 序）：挂载即接管焦点，数字键/Enter 直用
    <div
      className="ai00-x-dsh-scene__question"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="ai00-x-dsh-scene__q-head">
        <HelpCircle size={14} />
        <span className="ai00-x-dsh-scene__q-head-label">{t('question.pending')}</span>
        {firstWithOptions && (
          <span className="ai00-x-dsh-scene__q-keyhint">{t('question.keyHint')}</span>
        )}
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

