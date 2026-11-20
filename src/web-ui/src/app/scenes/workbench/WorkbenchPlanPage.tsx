/**
 * WorkbenchPlanPage — 工作台中间区的「计划首页」（任务 / 项目共用）。
 *
 * page 变体（工作台中区）：Hero 概览 → 主卡（执行步骤时间线 / 结果摘要分页）
 *   → 洞察卡（概览 / 风险评估 / 核心目标）→ 底部操作条 + 计划原文。
 * compact 变体（任务详情抽屉，窄）：摘要条 → 任务卡 → 验收 → 交付物 → 原文。
 *
 * 两种变体共用同一套写盘 / 勾选 / 批准逻辑，保证数据行为只有一份。
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
import { WorkbenchPlanHero } from './WorkbenchPlanHero';
import { WorkbenchPlanTimeline } from './WorkbenchPlanTimeline';
import { WorkbenchPlanInsights } from './WorkbenchPlanInsights';
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
  /** page = 工作台中区卡片式布局；compact = 抽屉内紧凑列表（默认 page）。 */
  variant?: 'page' | 'compact';
}

const detailButton = 'ai00-x-task-detail__button';

type PlanTab = 'steps' | 'results';

export const WorkbenchPlanPage: React.FC<WorkbenchPlanPageProps> = ({
  task,
  planMd,
  onPlanChange,
  onOpenFile,
  header,
  actions,
  running = false,
  variant = 'page',
}) => {
  const { t } = useI18n('common');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [tab, setTab] = useState<PlanTab>('steps');
  /** 计划原文编辑（手改计划 = 需求变更，保存后必须重新批准）。 */
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const steps = useMemo(() => parseStepItems(planMd), [planMd]);
  const structuredSteps = useMemo(() => parsePlanSteps(planMd), [planMd]);
  const acceptance = useMemo(() => parseAcceptance(planMd), [planMd]);
  const acceptedCount = acceptance.filter((item) => item.done).length;
  const plainDone = steps.filter((step) => step.done).length;
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

  const openEditor = useCallback((): void => {
    setDraft(planMd ?? '');
    setSourceOpen(true);
    setEditOpen(true);
  }, [planMd]);

  /** 分页键盘操作（WAI-ARIA tabs：←/→ 循环，Home/End 首尾）。 */
  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const next: PlanTab =
        event.key === 'Home'
          ? 'steps'
          : event.key === 'End'
            ? 'results'
            : tab === 'steps'
              ? 'results'
              : 'steps';
      setTab(next);
      document.getElementById(`ai00-x-plan-tab-${next}`)?.focus();
    },
    [tab],
  );

  const hasPlan = Boolean(planMd && planMd.trim());

  const acceptanceSection = (
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
  );

  const deliverablesSection = (
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
  );

  const selfCheck = task.agentCompletedAt ? (
    <p className="ai00-x-task-detail__selfcheck">
      <Send size={11} />
      {t('nav.workbenchWindow.board.selfChecked')}
    </p>
  ) : null;

  const notesAndError = (
    <>
      {task.notes && <p className="ai00-x-task-detail__notes">{task.notes}</p>}
      {error && (
        <p className="ai00-x-task-detail__error" role="alert">
          {error}
        </p>
      )}
    </>
  );

  const planEditor = editOpen ? (
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
  ) : null;

  const planPreview = (
    <div className="ai00-x-task-detail__plan">
      <Markdown
        content={(planMd ?? '')
          .replace(/^- \[x\] /gm, '✓ ')
          .replace(/^- \[ \] /gm, '□ ')}
      />
    </div>
  );

  const compactBody = (
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

      {notesAndError}
      {acceptanceSection}
      {deliverablesSection}
      {selfCheck}

      {hasPlan && (
        <section className="ai00-x-task-detail__section">
          <div className="ai00-x-plan-page__source-head">
            <h3 className="ai00-x-task-detail__section-title">
              {t('nav.workbenchWindow.board.plan')}
            </h3>
            <div className="ai00-x-plan-page__source-actions">
              {!editOpen && !task.completedAt && (
                <button type="button" className={detailButton} onClick={openEditor}>
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
          {sourceOpen && (editOpen ? planEditor : planPreview)}
        </section>
      )}
    </div>
  );

  const pageBody = (
    <div className="ai00-x-plan-page__body">
      {!hasPlan ? (
        <>
          <p className="ai00-x-plan-page__empty">
            {t('nav.workbenchWindow.progress.empty')}
          </p>
          {notesAndError}
          {acceptanceSection}
          {deliverablesSection}
        </>
      ) : (
        <>
          <WorkbenchPlanHero
            task={task}
            steps={structuredSteps}
            fallbackTotal={steps.length}
            fallbackDone={plainDone}
            planMd={planMd}
            running={running}
            awaitingReview={Boolean(task.agentCompletedAt) && !task.completedAt}
            pendingApproval={Boolean(planMd) && !task.planApprovedAt}
            taskCompleted={Boolean(task.completedAt)}
          />

          {structuredSteps.length > 0 ? (
            <section className="ai00-x-plan-page__panel">
              <div
                className="ai00-x-plan-page__tabs"
                role="tablist"
                aria-label={t('nav.workbenchWindow.plan.tabsLabel')}
                onKeyDown={handleTabKeyDown}
              >
                <button
                  type="button"
                  id="ai00-x-plan-tab-steps"
                  role="tab"
                  aria-selected={tab === 'steps'}
                  aria-controls="ai00-x-plan-panel-steps"
                  tabIndex={tab === 'steps' ? 0 : -1}
                  className={`ai00-x-plan-page__tab${tab === 'steps' ? ' is-active' : ''}`}
                  onClick={() => setTab('steps')}
                >
                  {t('nav.workbenchWindow.plan.tabsSteps')}
                  <span className="ai00-x-plan-page__tab-count">{structuredSteps.length}</span>
                </button>
                <button
                  type="button"
                  id="ai00-x-plan-tab-results"
                  role="tab"
                  aria-selected={tab === 'results'}
                  aria-controls="ai00-x-plan-panel-results"
                  tabIndex={tab === 'results' ? 0 : -1}
                  className={`ai00-x-plan-page__tab${tab === 'results' ? ' is-active' : ''}`}
                  onClick={() => setTab('results')}
                >
                  {t('nav.workbenchWindow.plan.tabsResults')}
                </button>
              </div>

              {tab === 'steps' ? (
                <div
                  id="ai00-x-plan-panel-steps"
                  role="tabpanel"
                  aria-labelledby="ai00-x-plan-tab-steps"
                  className="ai00-x-plan-page__tabpanel"
                >
                  <WorkbenchPlanTimeline
                    steps={structuredSteps}
                    running={running}
                    taskCompleted={Boolean(task.completedAt)}
                    readOnly={busy || Boolean(task.completedAt)}
                    onToggleDone={(lineIndex, done) => void toggleAcceptance(lineIndex, done)}
                  />
                </div>
              ) : (
                <div
                  id="ai00-x-plan-panel-results"
                  role="tabpanel"
                  aria-labelledby="ai00-x-plan-tab-results"
                  className="ai00-x-plan-page__tabpanel"
                >
                  {acceptanceSection}
                  {deliverablesSection}
                  {selfCheck}
                </div>
              )}
            </section>
          ) : (
            <section className="ai00-x-plan-page__panel">
              <WorkbenchProgress
                steps={steps.map((step) => ({ text: step.text, done: step.done }))}
                activeIndex={activeIndex}
                hint={t('nav.workbenchWindow.plan.legacyPlanHint')}
              />
              {acceptanceSection}
              {deliverablesSection}
              {selfCheck}
            </section>
          )}

          <WorkbenchPlanInsights
            steps={structuredSteps}
            fallbackTotal={steps.length}
            fallbackDone={plainDone}
            planMd={planMd}
            fallbackGoal={task.plan?.goal}
          />

          {notesAndError}

          <footer className="ai00-x-plan-page__footer">
            {!editOpen && !task.completedAt && (
              <button type="button" className={detailButton} onClick={openEditor}>
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
          </footer>

          {sourceOpen && (
            <section className="ai00-x-plan-page__source">
              {editOpen ? planEditor : planPreview}
            </section>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className={`ai00-x-plan-page is-${variant}`}>
      {header && (
        <header className="ai00-x-plan-page__head">
          <div className="ai00-x-plan-page__head-main">{header}</div>
          {actions && <div className="ai00-x-plan-page__head-actions">{actions}</div>}
        </header>
      )}

      {variant === 'compact' ? compactBody : pageBody}

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
