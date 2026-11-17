/**
 * WorkbenchSubagentCard — 工作台对话里「派发了一个子代理」的内联卡。
 *
 * 为什么需要独立卡：worker 工具卡本来只显示 `started subagent <uuid>`，
 * 派发之后子代理在干什么、跑了多久、结论是什么，对话里全都看不到（只在
 * 消息流末尾堆一个活动块，历史回看时也找不到归属）。这里把派发点变成
 * 子代理的常驻记录：
 *
 * - 状态：运行中 / 正常结束 / 非正常结束（引擎 `subagentTiming.lastTurnCompleted`）
 * - 耗时：优先用 durable 投影（`settledMs + active`），没有时退化为本端观测
 * - 标签：`subagentCatalog` 里派发时冻结的 label（就是主代理写的任务标题）
 * - 过程：展开即**卡内**读子会话完整记录（不离开对话、不开中区标签）
 *
 * 数据全部来自既有投影/事件与 `session/page`，不新增协议。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  HelpCircle,
  RefreshCw,
  SendHorizontal,
  Square,
  XCircle,
} from 'lucide-react';
import {
  subagentInterrupt,
  subagentPrompt,
  type DshToolCallView,
} from '@/infrastructure/api/service-api/DshAPI';
import { useWorkbenchTaskStore } from '../tasks/workbenchTaskStore';
import { formatSubagentDuration, startedSubagentId } from './subagentTools';
import { WorkbenchSubagentTranscript } from './WorkbenchSubagentTranscript';
import { onFocusSubagentCard } from './subagentFocus';
import './WorkbenchSubagentCard.scss';

/** 工具参数里的一句话任务描述（worker 的 `description`）。 */
function toolDescription(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).description;
      if (typeof value === 'string') return value.trim();
      const prompt = (parsed as Record<string, unknown>).prompt;
      if (typeof prompt === 'string') return prompt.trim().split(/\r?\n/, 1)[0] ?? '';
    }
  } catch {
    return '';
  }
  return '';
}

/** 工具参数里的完整 prompt（展开区展示）。 */
function toolPrompt(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).prompt;
      if (typeof value === 'string') return value.trim();
    }
  } catch {
    return '';
  }
  return '';
}

export interface WorkbenchSubagentCardProps {
  call: DshToolCallView;
  /** 父会话 id（目录投影按父会话归档）。 */
  parentSessionId: string;
}

export const WorkbenchSubagentCard: React.FC<WorkbenchSubagentCardProps> = ({
  call,
  parentSessionId,
}) => {
  const { t } = useTranslation('common');
  const childId = useMemo(() => startedSubagentId(call.result), [call.result]);
  const meta = useWorkbenchTaskStore(s =>
    childId ? s.subagentCatalog[parentSessionId]?.find(row => row.id === childId) : undefined,
  );
  const timing = useWorkbenchTaskStore(s => (childId ? s.subagentTiming[childId] : undefined));
  const child = useWorkbenchTaskStore(s =>
    childId ? s.children[parentSessionId]?.find(row => row.sessionId === childId) : undefined,
  );

  const running = Boolean(timing?.active) || Boolean(child?.running);
  const abnormal = !running && (call.isError === true || timing?.lastTurnCompleted === false);
  const description = useMemo(() => toolDescription(call.arguments), [call.arguments]);
  const prompt = useMemo(() => toolPrompt(call.arguments), [call.arguments]);
  const label = meta?.label || description || child?.title || '';
  const preset = child?.preset || call.name;

  /** 运行中每秒推进一次（只在真有 active turn 时挂计时器）。 */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const durationMs = useMemo(() => {
    if (timing && (timing.settledMs > 0 || timing.active)) {
      const activeMs = timing.active ? Math.max(0, now - timing.active.since) : 0;
      return timing.settledMs + activeMs;
    }
    if (running && child) return Math.max(0, now - child.since);
    return 0;
  }, [timing, running, child, now]);

  // ---- 停止 / 继续（引擎 subagents/* 控制面；失败必须可见，不做假入口） ----
  /** continuable 才可继续；目录还没到时（meta 缺失）先按可停止处理。 */
  const continuable = meta?.mode === 'continuable';
  const canStop = Boolean(childId) && running && (!meta || continuable);

  const [continueOpen, setContinueOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [continueSent, setContinueSent] = useState(false);

  const handleStop = async (): Promise<void> => {
    if (!childId || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await subagentInterrupt(parentSessionId, childId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleContinue = async (): Promise<void> => {
    const text = draft.trim();
    if (!childId || !text || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await subagentPrompt(parentSessionId, childId, text);
      setDraft('');
      setContinueOpen(false);
      setContinueSent(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const state = running ? 'running' : abnormal ? 'abnormal' : call.pending ? 'pending' : 'done';
  const StateIcon =
    state === 'running' ? RefreshCw : state === 'abnormal' ? XCircle : state === 'done' ? CheckCircle2 : HelpCircle;
  const stateText =
    state === 'running'
      ? t('nav.workbenchWindow.subagentRunning')
      : state === 'abnormal'
        ? t('nav.workbenchWindow.subagentAbnormal')
        : state === 'done'
          ? t('nav.workbenchWindow.subagentDone')
          : t('nav.workbenchWindow.subagentPending');

  /** 展开态：默认收起（不挤占对话），展开后在卡内滚动看完整过程。 */
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDetailsElement | null>(null);

  /** 汇总条点某一行：就地展开这张卡并滚到可见位置（不离开当前对话）。 */
  useEffect(() => {
    if (!childId) return undefined;
    return onFocusSubagentCard(target => {
      if (target !== childId) return;
      setOpen(true);
      rootRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, [childId]);

  return (
    <details
      ref={rootRef}
      className={`ai00-x-wb-subagent is-${state}`}
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="ai00-x-wb-subagent__head">
        <span className="ai00-x-wb-subagent__kind" aria-hidden="true">
          <Bot size={12} />
        </span>
        <span className="ai00-x-wb-subagent__title" title={label || preset}>
          {label || preset}
        </span>
        {label && preset && <span className="ai00-x-wb-subagent__preset">{preset}</span>}
        <span className="ai00-x-wb-subagent__state">
          <StateIcon
            size={10}
            aria-hidden="true"
            className={state === 'running' ? 'ai00-x-wb-subagent__spin' : undefined}
          />
          {stateText}
          {durationMs > 0 && (
            <span className="ai00-x-wb-subagent__time">
              {formatSubagentDuration(durationMs)}
            </span>
          )}
        </span>
        <span className="ai00-x-wb-subagent__actions">
          {canStop && (
            <button
              type="button"
              className="ai00-x-wb-subagent__stop"
              title={t('nav.workbenchWindow.subagentStop')}
              disabled={actionBusy}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void handleStop();
              }}
            >
              <Square size={9} aria-hidden="true" />
              {actionBusy
                ? t('nav.workbenchWindow.subagentStopping')
                : t('nav.workbenchWindow.subagentStop')}
            </button>
          )}
          <ChevronDown size={12} aria-hidden="true" className="ai00-x-wb-subagent__chevron" />
        </span>
      </summary>
      <div className="ai00-x-wb-subagent__body">
        {/* 过程优先：展开第一眼就是子代理自己在干什么，而不是开发者字段 */}
        {childId ? (
          <WorkbenchSubagentTranscript childSessionId={childId} running={running} />
        ) : null}
        {prompt && (
          <details className="ai00-x-wb-subagent__brief">
            <summary>{t('nav.workbenchWindow.subagentPromptToggle')}</summary>
            <div className="ai00-x-wb-subagent__brief-text">{prompt}</div>
          </details>
        )}
        {childId && (
          <div className="ai00-x-wb-subagent__foot">
            <span className="ai00-x-wb-subagent__foot-id">
              {childId}
              {meta?.mode && ` · ${meta.mode}`}
            </span>
          </div>
        )}
        {call.result && !/^started subagent /i.test(call.result.trim()) && (
          <div className="ai00-x-wb-subagent__field">
            <span className="ai00-x-wb-subagent__key">
              {t('nav.workbenchWindow.subagentReceipt')}
            </span>
            <span className="ai00-x-wb-subagent__value is-mono">{call.result.trim()}</span>
          </div>
        )}
        {continuable && !running && (
          <div className="ai00-x-wb-subagent__continue">
            {continueOpen ? (
              <>
                <input
                  className="ai00-x-wb-subagent__continue-input"
                  value={draft}
                  autoFocus
                  aria-label={t('nav.workbenchWindow.subagentContinuePlaceholder')}
                  placeholder={t('nav.workbenchWindow.subagentContinuePlaceholder')}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleContinue();
                    }
                  }}
                />
                <button
                  type="button"
                  className="ai00-x-wb-subagent__continue-send"
                  disabled={!draft.trim() || actionBusy}
                  onClick={() => void handleContinue()}
                >
                  <SendHorizontal size={11} aria-hidden="true" />
                  {t('nav.workbenchWindow.subagentContinue')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ai00-x-wb-subagent__continue-open"
                onClick={() => {
                  setContinueOpen(true);
                  setContinueSent(false);
                }}
              >
                {t('nav.workbenchWindow.subagentContinue')}
              </button>
            )}
            {continueSent && (
              <span className="ai00-x-wb-subagent__note" role="status">
                {t('nav.workbenchWindow.subagentContinueSent')}
              </span>
            )}
          </div>
        )}
        {actionError && (
          <div className="ai00-x-wb-subagent__error" role="alert">
            {actionError}
          </div>
        )}
      </div>
    </details>
  );
};
