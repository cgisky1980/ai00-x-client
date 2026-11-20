/**
 * WorkbenchComposerDock — 工作台对话区的输入区（从 WorkbenchChatPanel 拆出，行为不变）。
 *
 * 固定顺序（规范 §9.9）：Queue → 任务状态卡 / 提问与工具审批档位 → 输入框。
 * 计划批准与验收不在这里（规范 v0.23 §9.6）。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { AgentComposer } from '@/app/components/ai/AgentComposer';
import type { WorkbenchOpenSessionIntent } from '@/infrastructure/plugins/workbenchSession';
import { ApprovalCard, QuestionCard } from '../dsh/DshChatPieces';
import { WorkbenchQueueDock } from './WorkbenchQueueDock';
import { ComposerInteraction } from './ComposerInteraction';
import { WorkbenchPlanRail } from './WorkbenchPlanRail';
import { WorkbenchTurnUsage } from './WorkbenchTurnUsage';
import type { WorkbenchSession } from './useWorkbenchSession';

export interface WorkbenchComposerDockProps {
  session: WorkbenchSession;
  externalSession: WorkbenchOpenSessionIntent | null;
  showWorkspace: boolean;
  planMd?: string | null;
  planFinished: boolean;
  planNeedsYou: boolean;
}

export const WorkbenchComposerDock: React.FC<WorkbenchComposerDockProps> = ({
  session,
  externalSession,
  showWorkspace,
  planMd,
  planFinished,
  planNeedsYou,
}) => {
  const { t } = useTranslation('common');
  const tDsh = useTranslation('scenes/dsh').t;
  const {
    questions,
    approvals,
    pendingApproval,
    planReviewApproval,
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

  /**
   * 任务状态卡（紧凑态）：计划进度主行 + 本轮消耗辅行，同一张卡。
   * 「需要你」时只提示去计划页，不在这里放推进按钮（入口唯一）。
   */
  const statusCard =
    planMd !== undefined || turnUsage ? (
      <WorkbenchPlanRail
        planMd={planMd}
        finished={planFinished}
        running={taskRunning}
        {...(planNeedsYou || planReviewApproval
          ? { notice: t('nav.workbenchWindow.planCard.needsYouNotice') }
          : {})}
        {...(turnUsage
          ? {
              usage: (
                <WorkbenchTurnUsage
                  local={turnUsage.local}
                  remote={turnUsage.remote}
                  remoteCredits={turnUsage.remoteCredits}
                />
              ),
            }
          : {})}
      />
    ) : null;

  const composerDock =
    statusCard || interactionDock ? (
      <>
        {statusCard}
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
