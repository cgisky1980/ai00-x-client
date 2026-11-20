/**
 * WorkbenchComposerDock — 工作台对话区的输入区（从 WorkbenchChatPanel 拆出，行为不变）。
 *
 * 固定顺序（规范 §9.9）：Queue → 本轮消耗 / 提问与工具审批档位 → 输入框。
 * 计划进度、批准与验收都不在这里（规范 v0.23 §9.6，进度只在中央计划卡）。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { AgentComposer } from '@/app/components/ai/AgentComposer';
import type { WorkbenchOpenSessionIntent } from '@/infrastructure/plugins/workbenchSession';
import { ApprovalCard, QuestionCard } from '../dsh/DshChatPieces';
import { WorkbenchQueueDock } from './WorkbenchQueueDock';
import { ComposerInteraction } from './ComposerInteraction';
import { WorkbenchTurnUsage } from './WorkbenchTurnUsage';
import type { WorkbenchSession } from './useWorkbenchSession';

export interface WorkbenchComposerDockProps {
  session: WorkbenchSession;
  externalSession: WorkbenchOpenSessionIntent | null;
  showWorkspace: boolean;
}

export const WorkbenchComposerDock: React.FC<WorkbenchComposerDockProps> = ({
  session,
  externalSession,
  showWorkspace,
}) => {
  const tDsh = useTranslation('scenes/dsh').t;
  const {
    questions,
    approvals,
    pendingApproval,
    planReviewText,
    respondQuestion,
    cancelQuestion,
    respondApproval,
    turnUsage,
    taskRunning,
    turnRunning,
    running,
    queueRows,
    handleQueueEdit,
    handleQueueRemove,
    handleQueueSteer,
    handleRetrySubmission,
    handleQueueClearAll,
    dockError,
    draft,
    setDraft,
    handleSend,
    handleStop,
    hasPendingSubmission,
    stopping,
    sessionId,
    bound,
    setError,
  } = session;

  /**
   * 输入框上的交互档位（规范 v0.23 §9.6）：输入框只承载 ask user 与工具审批。
   * 计划批准与最终验收只在中央计划卡；exit_plan_mode 审批登记到 store，由计划卡应答。
   */
  const pendingQuestion = questions[0];

  const interactionDock = pendingQuestion ? (
    <ComposerInteraction
      tone="warning"
      meta={questions.length > 1 ? `${questions.length}` : undefined}
    >
      <QuestionCard
        batch={pendingQuestion}
        onRespond={respondQuestion}
        onCancel={cancelQuestion}
      />
    </ComposerInteraction>
  ) : pendingApproval ? (
    <ComposerInteraction
      tone={pendingApproval.toolName === 'exit_plan_mode' ? 'warning' : 'accent'}
      meta={approvals.length > 1 ? `${approvals.length}` : undefined}
    >
      <ApprovalCard
        approval={pendingApproval}
        planText={pendingApproval.toolName === 'exit_plan_mode' ? planReviewText : undefined}
        onRespond={(rpcId, outcome) => void respondApproval(rpcId, outcome)}
      />
    </ComposerInteraction>
  ) : undefined;

  /** 本轮消耗辅行：只显示用量，不放进度/批准/验收（都在中央计划卡）。 */
  const usageDock = turnUsage ? (
    <div className="ai00-x-turn-usage-dock">
      <WorkbenchTurnUsage
        local={turnUsage.local}
        remote={turnUsage.remote}
        remoteCredits={turnUsage.remoteCredits}
      />
    </div>
  ) : null;

  const composerDock =
    usageDock || interactionDock ? (
      <>
        {usageDock}
        {interactionDock}
      </>
    ) : null;

  return (
    <div className="ai00-x-dsh-scene__composer">
      <WorkbenchQueueDock
        rows={queueRows}
        running={running}
        onEdit={handleQueueEdit}
        onRemove={handleQueueRemove}
        onSteer={handleQueueSteer}
        onRetry={handleRetrySubmission}
        onClearAll={handleQueueClearAll}
        actionError={dockError}
      />
      {composerDock && (
        <div
          className={`ai00-x-composer-stack__under${
            interactionDock ? ' is-raised' : ''
          }`}
        >
          {composerDock}
        </div>
      )}
      <AgentComposer
        value={draft}
        onChange={setDraft}
        onSubmit={handleSend}
        onStop={() => void handleStop()}
        loading={hasPendingSubmission}
        running={taskRunning}
        steering={turnRunning}
        stopping={stopping}
        placeholder={tDsh('chat.inputPlaceholder')}
        sessionId={sessionId}
        mentionRoot={bound?.cwd || externalSession?.cwd || undefined}
        onError={setError}
        workspace={
          showWorkspace && (bound?.cwd || externalSession?.cwd)
            ? { dir: (bound?.cwd || externalSession?.cwd) as string }
            : undefined
        }
      />
    </div>
  );
};

export default WorkbenchComposerDock;
