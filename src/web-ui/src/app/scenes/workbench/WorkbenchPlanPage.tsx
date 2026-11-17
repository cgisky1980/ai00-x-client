/**
 * WorkbenchPlanPage — 工作台中间区的「计划首页」（任务 / 项目共用）。
 *
 * 顺序固定：标题行（可选插槽）→ 进度 → 步骤 → 验收 → 交付物 → 计划书全文。
 * 抽屉（TaskDetail）与中区页面共用本组件，保证格式只有一份。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, FolderOpen, Send, Undo2 } from 'lucide-react';
import { InputDialog, Markdown } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { dshSession } from '@/infrastructure/api/service-api/DshAPI';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import type { TodoTask } from '@/tools/todo/api/types';
import { useTodoStore } from '@/tools/todo/store/todoStore';
import {
  parseAcceptance,
  parseStepItems,
  toggleAcceptanceLine,
} from '@/tools/todo/utils/planAcceptance';
import { parsePlanSteps } from '@/tools/todo/utils/planStructure';
import { buildRejectPrompt } from '@/agent/orchestrator/promptParts';
import { WorkbenchPlanSummary } from './WorkbenchPlanSummary';
import { WorkbenchTaskCards } from './WorkbenchTaskCards';
import { WorkbenchProgress } from './WorkbenchProgress';
import './WorkbenchPlanPage.scss';
// 步骤/验收/交付物等行样式与抽屉同源（TaskDetail.scss）
import '../tasks/TaskDetail.scss';

export interface WorkbenchPlanPageProps {
  task: TodoTask;
  planMd: string | null;
  /** 计划文件写回后的本地同步（勾选验收用）。 */
  onPlanChange?: (taskId: string, markdown: string) => void;
  /** 打开交付物：页面变体在中区开标签，抽屉变体弹预览窗。 */
  onOpenFile?: (path: string) => void;
  /** 标题行（页面变体传入任务/项目名 + 阶段 + 状态）。 */
  header?: React.ReactNode;
  /** 标题行右侧的额外入口（详情抽屉等）。 */
  actions?: React.ReactNode;
  /** 会话正在运行（步骤状态显示「进行中」）。 */
  running?: boolean;
}

const detailButton = 'ai00-x-task-detail__button';

export const WorkbenchPlanPage: React.FC<WorkbenchPlanPageProps> = ({
  task,
  planMd,
  onPlanChange,
  onOpenFile,
  header,
  actions,
  running = false,
}) => {
  const { t } = useI18n('common');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  /** 计划原文编辑（手改计划 = 需求变更，保存后必须重新批准）。 */
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const steps = useMemo(() => parseStepItems(planMd), [planMd]);
  const structuredSteps = useMemo(() => parsePlanSteps(planMd), [planMd]);
  const acceptance = useMemo(() => parseAcceptance(planMd), [planMd]);
  const acceptedCount = acceptance.filter((item) => item.done).length;
  const activeIndex = task.completedAt
    ? null
    : steps.findIndex((step) => !step.done) >= 0
      ? steps.findIndex((step) => !step.done)
      : null;

  const accept = useCallback((): void => {
    useTodoStore.getState().completeTask(task.id, true);
  }, [task.id]);

  const reject = useCallback(
    async (input: string): Promise<void> => {
      const reason = input.trim() || t('nav.workbenchWindow.board.rejectDefault');
      useTodoStore.getState().updateTask(task.id, { agentCompletedAt: null });
      if (task.agentSessionId) {
        void dshSession
          .prompt(task.agentSessionId, buildRejectPrompt(reason))
          .catch(() => undefined);
      }
    },
    [t, task.agentSessionId, task.id],
  );

  /** 保存手改的计划：写盘 + 清掉批准标记（回到「待批准」，避免改完直接执行）。 */
  const savePlan = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke('todo_plan_set', { taskId: task.id, markdown: draft });
      onPlanChange?.(task.id, draft);
      if (task.planApprovedAt) {
        useTodoStore.getState().updateTask(task.id, { planApprovedAt: null });
      }
      setEditOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, draft, onPlanChange, task.id, task.planApprovedAt]);

  const toggleAcceptance = useCallback(
    async (lineIndex: number, done: boolean): Promise<void> => {
      if (planMd == null || busy) return;
      setBusy(true);
      setError(null);
      try {
        const next = toggleAcceptanceLine(planMd, lineIndex, done);
        await invoke('todo_plan_set', { taskId: task.id, markdown: next });
        onPlanChange?.(task.id, next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, onPlanChange, planMd, task.id],
  );

  const hasPlan = Boolean(planMd && planMd.trim());

  return (
    <div className="ai00-x-plan-page">
      {header && (
        <header className="ai00-x-plan-page__head">
          <div className="ai00-x-plan-page__head-main">{header}</div>
          {actions && <div className="ai00-x-plan-page__head-actions">{actions}</div>}
        </header>
      )}

      <div className="ai00-x-plan-page__body">
        {!hasPlan && (
          <p className="ai00-x-plan-page__empty">
            {t('nav.workbenchWindow.progress.empty')}
          </p>
        )}

        {structuredSteps.length > 0 && (
          <WorkbenchPlanSummary
            steps={structuredSteps}
            planMd={planMd}
            running={running}
            awaitingReview={Boolean(task.agentCompletedAt) && !task.completedAt}
            taskCompleted={Boolean(task.completedAt)}
          />
        )}

        {structuredSteps.length > 0 ? (
          <WorkbenchTaskCards
            planMd={planMd}
            steps={structuredSteps}
            running={running}
            taskCompleted={Boolean(task.completedAt)}
            readOnly={busy || Boolean(task.completedAt)}
            onToggleDone={(lineIndex, done) => void toggleAcceptance(lineIndex, done)}
          />
        ) : (
          <WorkbenchProgress
            steps={steps.map((step) => ({ text: step.text, done: step.done }))}
            activeIndex={activeIndex}
            hint={hasPlan ? t('nav.workbenchWindow.plan.legacyPlanHint') : undefined}
          />
        )}

        {task.notes && <p className="ai00-x-task-detail__notes">{task.notes}</p>}
        {error && (
          <p className="ai00-x-task-detail__error" role="alert">
            {error}
          </p>
        )}

        <section className="ai00-x-task-detail__section">
          <h3 className="ai00-x-task-detail__section-title">
            {t('nav.workbenchWindow.board.acceptance')}
            {acceptance.length > 0 && (
              <span className="ai00-x-task-detail__count">
                {acceptedCount}/{acceptance.length}
              </span>
            )}
          </h3>
          {acceptance.length === 0 ? (
            <p className="ai00-x-task-detail__section-empty">
              {t('nav.workbenchWindow.board.noAcceptance')}
            </p>
          ) : (
            acceptance.map((item) => (
              <button
                key={item.lineIndex}
                type="button"
                className={`ai00-x-task-detail__acceptance${item.done ? ' is-done' : ''}`}
                disabled={busy || Boolean(task.completedAt)}
                onClick={() => void toggleAcceptance(item.lineIndex, !item.done)}
              >
                <span className="ai00-x-task-detail__acceptance-box">{item.done ? '✓' : ''}</span>
                <span>{item.text}</span>
              </button>
            ))
          )}
          {acceptance.length > 0 && (
            <div className="ai00-x-task-detail__actions">
              {task.agentCompletedAt && !task.completedAt && (
                <button
                  type="button"
                  className={detailButton}
                  onClick={() => setRejectOpen(true)}
                  title={t('nav.workbenchWindow.board.rejectHint')}
                >
                  <Undo2 size={11} />
                  {t('nav.workbenchWindow.board.reject')}
                </button>
              )}
              {!task.completedAt && (
                <button
                  type="button"
                  className={`${detailButton} is-primary`}
                  disabled={acceptance.length > 0 && acceptedCount < acceptance.length}
                  title={
                    acceptance.length > 0 && acceptedCount < acceptance.length
                      ? t('nav.workbenchWindow.board.acceptBlocked', {
                          count: acceptance.length - acceptedCount,
                        })
                      : t('nav.workbenchWindow.board.acceptHint')
                  }
                  onClick={accept}
                >
                  <Check size={11} />
                  {t('nav.workbenchWindow.board.accept')}
                </button>
              )}
            </div>
          )}
        </section>

        <section className="ai00-x-task-detail__section">
          <h3 className="ai00-x-task-detail__section-title">
            {t('nav.workbenchWindow.board.deliverables')}
          </h3>
          {task.deliverables?.length ? (
            <div className="ai00-x-task-detail__deliverables">
              {task.deliverables.map((path) => {
                const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
                const name = index >= 0 ? path.slice(index + 1) : path;
                return (
                  <div key={path} className="ai00-x-task-detail__deliverable">
                    <button
                      type="button"
                      className="ai00-x-task-detail__deliverable-name"
                      title={path}
                      onClick={() => onOpenFile?.(path)}
                    >
                      {name}
                    </button>
                    <button
                      type="button"
                      className={detailButton}
                      onClick={() => workspaceAPI.revealInExplorer(path).catch(() => undefined)}
                      title={t('nav.workbenchWindow.board.reveal')}
                    >
                      <FolderOpen size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="ai00-x-task-detail__section-empty">
              {task.agentCompletedAt
                ? t('nav.workbenchWindow.board.deliverablesMissing')
                : t('nav.workbenchWindow.board.deliverablesPending')}
            </p>
          )}
        </section>

        {task.agentCompletedAt && (
          <p className="ai00-x-task-detail__selfcheck">
            <Send size={11} />
            {t('nav.workbenchWindow.board.selfChecked')}
          </p>
        )}

        {hasPlan && (
          <section className="ai00-x-task-detail__section">
            <div className="ai00-x-plan-page__source-head">
              <h3 className="ai00-x-task-detail__section-title">
                {t('nav.workbenchWindow.board.plan')}
              </h3>
              <div className="ai00-x-plan-page__source-actions">
                {!editOpen && !task.completedAt && (
                  <button
                    type="button"
                    className={detailButton}
                    onClick={() => {
                      setDraft(planMd ?? '');
                      setSourceOpen(true);
                      setEditOpen(true);
                    }}
                  >
                    {t('nav.workbenchWindow.plan.edit')}
                  </button>
                )}
                <button
                  type="button"
                  className={detailButton}
                  onClick={() => setSourceOpen(prev => !prev)}
                  aria-expanded={sourceOpen}
                >
                  {sourceOpen
                    ? t('nav.workbenchWindow.plan.hideSource')
                    : t('nav.workbenchWindow.plan.viewSource')}
                </button>
              </div>
            </div>
            {sourceOpen && editOpen && (
              <div className="ai00-x-plan-page__editor">
                <textarea
                  className="ai00-x-plan-page__editor-input"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  spellCheck={false}
                  aria-label={t('nav.workbenchWindow.plan.edit')}
                />
                <div className="ai00-x-plan-page__editor-bar">
                  <span className="ai00-x-plan-page__editor-hint">
                    {t('nav.workbenchWindow.plan.editHint')}
                  </span>
                  <button
                    type="button"
                    className={detailButton}
                    onClick={() => setEditOpen(false)}
                    disabled={busy}
                  >
                    {t('nav.workbenchWindow.plan.editCancel')}
                  </button>
                  <button
                    type="button"
                    className={`${detailButton} is-primary`}
                    onClick={() => void savePlan()}
                    disabled={busy || draft === planMd}
                  >
                    {t('nav.workbenchWindow.plan.editSave')}
                  </button>
                </div>
              </div>
            )}
            {sourceOpen && !editOpen && (
              <div className="ai00-x-task-detail__plan">
                <Markdown
                  content={(planMd ?? '')
                    .replace(/^- \[x\] /gm, '✓ ')
                    .replace(/^- \[ \] /gm, '□ ')}
                />
              </div>
            )}
          </section>
        )}
      </div>

      <InputDialog
        isOpen={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={(value) => void reject(value)}
        title={t('nav.workbenchWindow.board.reject')}
        description={t('nav.workbenchWindow.board.rejectPrompt')}
        defaultValue={t('nav.workbenchWindow.board.rejectDefault')}
        confirmText={t('nav.workbenchWindow.board.reject')}
      />
    </div>
  );
};

export default WorkbenchPlanPage;
