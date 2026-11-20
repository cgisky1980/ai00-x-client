/**
 * WorkbenchMessageStream — 工作台对话区的消息流（从 WorkbenchChatPanel 拆出，行为不变）。
 *
 * 子代理汇总条 → 可滚动消息列表（历史 / 即时回显 / 实时流 / 等待 / 留痕 / 停滞 /
 * 重连 / 错误重试）→ 回到最新 → 越界提示。状态全部来自 useWorkbenchSession。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown } from 'lucide-react';
import type { DshToolCallView } from '@/infrastructure/api/service-api/DshAPI';
import type { WorkbenchEntry } from '@/infrastructure/plugins/workbenchRegistry';
import { useWorkbenchTaskStore } from '../tasks/workbenchTaskStore';
import { ChatErrorText, MessageBubble } from '../dsh/DshChatPieces';
import { WorkbenchSubagentCard } from './WorkbenchSubagentCard';
import { WorkbenchSubagentOverview } from './WorkbenchSubagentOverview';
import { isSubagentDispatch } from './subagentTools';
import type { WorkbenchSession } from './useWorkbenchSession';

/** 子代理已运行时长（`3m 20s` / `45s`）。 */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export interface WorkbenchMessageStreamProps {
  session: WorkbenchSession;
  entry?: WorkbenchEntry;
  planHosted: boolean;
  planFinished: boolean;
}

export const WorkbenchMessageStream: React.FC<WorkbenchMessageStreamProps> = ({
  session,
  entry,
  planHosted,
  planFinished,
}) => {
  const { t } = useTranslation('common');
  const tDsh = useTranslation('scenes/dsh').t;
  const {
    usageSessionId,
    bodyRef,
    handleBodyScroll,
    loading,
    messages,
    error,
    setError,
    setDraft,
    displayMessages,
    transcriptEchoes,
    live,
    showPendingDots,
    stopping,
    stallMs,
    stalled,
    handleStop,
    submitText,
    lastUserText,
    linkDown,
    retryableText,
    setRetryableText,
    hasNewBelow,
    scrollToBottom,
    violations,
    setViolations,
  } = session;

  /** worker 派发 → 子代理内联卡；其余工具走默认工具卡。 */
  const renderToolCall = (call: DshToolCallView): React.ReactNode => {
    if (!usageSessionId || !isSubagentDispatch(call)) return null;
    return <WorkbenchSubagentCard call={call} parentSessionId={usageSessionId} />;
  };
  /** 子代理来源记录的人类可读名（catalog label，兜底短 id 由 MessageBubble 处理）。 */
  const resolveOriginLabel = (id: string): string | null => {
    const rows = useWorkbenchTaskStore.getState().subagentCatalog[usageSessionId ?? ''] ?? [];
    return rows.find(row => row.id === id)?.label ?? null;
  };

  return (
    <>
      {/* 子代理汇总：常驻在消息流之上，解决「任务一长就找不到子代理」 */}
      {usageSessionId && (
        <div className="ai00-x-workbench-chat__subagents-head">
          <WorkbenchSubagentOverview parentSessionId={usageSessionId} />
        </div>
      )}
      <div className="ai00-x-workbench-chat__body">
      <div
        className="ai00-x-dsh-scene__messages"
        ref={bodyRef}
        onScroll={handleBodyScroll}
      >
        {loading && (
          <div className="ai00-x-dsh-scene__messages-empty">{tDsh('sessions.loading')}</div>
        )}
        {!loading && messages.length === 0 && !error && (
          <div className="ai00-x-dsh-scene__messages-empty">
            <p>{tDsh('chat.empty')}</p>
            {(entry?.starterPrompts?.length ?? 0) > 0 && (
              <div className="ai00-x-workbench-chat__starters">
                {entry?.starterPrompts?.map(prompt => (
                  <button
                    key={prompt}
                    type="button"
                    className="ai00-x-workbench-chat__starter"
                    onClick={() => setDraft(prompt)}
                    title={prompt}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {displayMessages.map(m => (
          <MessageBubble
            key={m.id}
            message={m}
            renderToolCall={renderToolCall}
            resolveOriginLabel={resolveOriginLabel}
            showUsage={false}
          />
        ))}
        {/* 尚未落盘的用户输入：立即回显（落盘后按 rpcId 退休） */}
        {transcriptEchoes.map(sub => (
          <div key={sub.requestId} className="ai00-x-workbench-chat__optimistic">
            <MessageBubble
              message={{
                id: `pending-${sub.requestId}`,
                role: 'user',
                text: sub.text,
                toolCalls: [],
                streaming: false,
              }}
            />
          </div>
        ))}
        {/* 未落盘的实时助手流：逐字刷新（落盘后由 MessageBubble 接管） */}
        {live && (live.text || live.reasoning) && (
          <MessageBubble
            message={{
              id: 'live',
              role: 'assistant',
              text: live.text,
              ...(live.reasoning ? { reasoning: live.reasoning } : {}),
              toolCalls: [],
              streaming: live.active,
            }}
          />
        )}
        {/* 助手在跑但还没有可见文本（含请求在途）：动态等待提示，避免像卡死 */}
        {showPendingDots && (
          <div className="ai00-x-dsh-scene__msg is-assistant">
            <div className="ai00-x-dsh-scene__msg-body">
              <div className="ai00-x-workbench-chat__pending" role="status" aria-live="polite">
                <span className="ai00-x-workbench-chat__pending-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span>
                  {stopping ? tDsh('chat.stopping') : tDsh('chat.thinking')}
                  {stallMs > 0 && ` · ${formatElapsed(stallMs)}`}
                </span>
              </div>
            </div>
          </div>
        )}
        {/* 留痕（规范 §9.6）：验收只在计划卡完成，这里只追加一条事实行，不触发 agent */}
        {planHosted && planFinished && (
          <p className="ai00-x-workbench-chat__fact" role="status">
            {t('nav.workbenchWindow.planCard.acceptedFact')}
          </p>
        )}
        {/* 长时间无任何事件：显示已等待时长并给出出口，避免看起来像卡死 */}
        {stalled && (
          <div className="ai00-x-workbench-chat__stall" role="status" aria-live="polite">
            <span className="ai00-x-workbench-chat__stall-text">
              {t('nav.workbenchWindow.progress.stall', { time: formatElapsed(stallMs) })}
            </span>
            <span className="ai00-x-workbench-chat__stall-actions">
              <button
                type="button"
                className="ai00-x-workbench-chat__stall-btn"
                onClick={() => void handleStop()}
              >
                {t('nav.workbenchWindow.progress.stallStop')}
              </button>
              <button
                type="button"
                className="ai00-x-workbench-chat__stall-btn is-primary"
                onClick={() =>
                  submitText(
                    lastUserText || t('nav.workbenchWindow.progress.stallContinue'),
                    'queue',
                  )
                }
              >
                {t('nav.workbenchWindow.progress.stallRetry')}
              </button>
            </span>
          </div>
        )}
        {linkDown && (
          <div className="ai00-x-dsh-scene__error" role="status" aria-live="polite">
            <span>{t('nav.workbenchScene.chat.reconnecting')}</span>
          </div>
        )}
        {error && (
          <div className="ai00-x-dsh-scene__error" role="alert">
            <ChatErrorText raw={error} />
            {retryableText && (
              <button
                type="button"
                className="ai00-x-workbench-chat__retry"
                onClick={() => {
                  const text = retryableText;
                  setRetryableText(null);
                  setError(null);
                  submitText(text, 'queue');
                }}
              >
                {tDsh('chat.retryTurn')}
              </button>
            )}
          </div>
        )}
      </div>
        {hasNewBelow && (
          <button
            type="button"
            className="ai00-x-workbench-chat__jump"
            onClick={scrollToBottom}
          >
            <ArrowDown size={12} />
            <span>{tDsh('chat.scrollToLatest')}</span>
          </button>
        )}
      </div>

      {violations.length > 0 && (
        <div className="ai00-x-workbench-chat__violations">
          {violations.map((v, i) => (
            <div key={`${v.path}-${i}`} className="ai00-x-workbench-chat__violation">
              <span className="ai00-x-workbench-chat__violation-code">path_out_of_scope</span>
              <span className="ai00-x-workbench-chat__violation-path" title={v.path}>{v.path}</span>
              <button
                type="button"
                className="ai00-x-workbench-chat__violation-dismiss"
                onClick={() => setViolations(prev => prev.filter((_, j) => j !== i))}
                aria-label={t('nav.workbenchScene.chat.dismiss')}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

export default WorkbenchMessageStream;
