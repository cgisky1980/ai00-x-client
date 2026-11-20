/**
 * WorkbenchPlanCard — 工作台计划页的唯一主舞台（规范 v0.23 §9.2 / §9.4 / §9.6）。
 *
 * 一张卡三段：
 *   标题区   目标 + 三段阶段条（Steps）
 *   步骤列表 每行 = 状态 + 编号标题 + 工人 chip + 可折叠验证/证据（Timeline + Collapse）
 *   动作区   随阶段切换：批准并执行 → 执行统计 → 验收（全工作台唯一批准 / 验收入口）
 *
 * 数据只来自既有解析器（planStructure / planAcceptance）与 workbenchTaskStore，
 * 不新增后端字段。旧格式计划（无 T 编号）回落三态进度。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, FolderOpen, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import { Button as DsButton } from '@ai00-x/design-system/react';
import {
  Button,
  Collapse,
  CollapseItem,
  Empty,
  Input,
  InputDialog,
  Markdown,
  Skeleton,
  Statistic,
  Steps,
  Timeline,
  TimelineItem,
} from '@/component-library';
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
import {
  deriveStepState,
  parsePlanGoal,
  parsePlanPolicy,
  parsePlanSteps,
  type PlanStep,
  type PlanStepState,
} from '@/tools/todo/utils/planStructure';
import {
  appendStep,
  deleteStep,
  diffPlanSteps,
  setStepCommand,
  setStepTitle,
  type PlanStepDiff,
} from '@/tools/todo/utils/planEdit';
import { buildRejectPrompt } from '@/agent/orchestrator/promptParts';
import { useWorkbenchTaskStore } from '../tasks/workbenchTaskStore';
import { WORKBENCH_STAGES, stageOf } from './workbenchStage';
import type { TaskPhase } from '../tasks/taskPhase';
import { WorkbenchProgress } from './WorkbenchProgress';
import { focusSubagentCard } from './subagentFocus';
import './WorkbenchPlanCard.scss';

export interface WorkbenchPlanCardProps {
  task: TodoTask;
  planMd: string | null;
  /** 技术状态（由宿主 taskPhase 推导，决定动作区形态）。 */
  phase: TaskPhase;
  /** 任务级运行（含子代理）：步骤「进行中」与规划骨架用。 */
  running?: boolean;
  /** 计划写回后的本地同步。 */
  onPlanChange?: (taskId: string, markdown: string) => void;
  /** 打开交付物（页面变体在中区开标签）。 */
  onOpenFile?: (path: string) => void;
  /** 只读：不渲染批准 / 验收 / 编辑（看板抽屉预览用，保证入口唯一）。 */
  readOnly?: boolean;
}

/** 步骤展示态 → Timeline 节点态。 */
const TIMELINE_STATUS: Record<PlanStepState, 'finish' | 'active' | 'pending'> = {
  todo: 'pending',
  active: 'active',
  review: 'active',
  rework: 'active',
  done: 'finish',
  fallback: 'active',
  failed: 'pending',
};

const STATE_KEY: Record<PlanStepState, string> = {
  todo: 'nav.workbenchWindow.plan.stateTodo',
  active: 'nav.workbenchWindow.plan.stateActive',
  review: 'nav.workbenchWindow.plan.stateReview',
  rework: 'nav.workbenchWindow.plan.stateRework',
  done: 'nav.workbenchWindow.plan.stateDone',
  fallback: 'nav.workbenchWindow.plan.stateFallback',
  failed: 'nav.workbenchWindow.plan.stateFailed',
};

const MAX_DELIVERABLES = 6;

function fileName(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return index >= 0 ? path.slice(index + 1) : path;
}

/** 子代理标签里是否点名了该步骤（派发时冻结的标题以 `T3 …` 开头或含 `T3`）。 */
function labelMentions(label: string | undefined, stepId: string): boolean {
  if (!label || !stepId) return false;
  return new RegExp(`(^|[^0-9A-Za-z_-])${stepId}(?![0-9A-Za-z_-])`).test(label);
}

interface StepDraft {
  lineIndex: number;
  title: string;
  cmd: string;
}

interface StepWorker {
  id: string;
  name: string;
  running: boolean;
}

export const WorkbenchPlanCard: React.FC<WorkbenchPlanCardProps> = ({
  task,
  planMd,
  phase,
  running = false,
  onPlanChange,
  onOpenFile,
  readOnly = false,
}) => {
  const { t } = useI18n('common');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  /** 源码全文编辑（次要入口）；null = 只读预览。 */
  const [sourceDraft, setSourceDraft] = useState<string | null>(null);
  /** 行内编辑中的步骤。 */
  const [stepDraft, setStepDraft] = useState<StepDraft | null>(null);

  const sessionId = task.agentSessionId ?? '';
  const catalog = useWorkbenchTaskStore((s) => (sessionId ? s.subagentCatalog[sessionId] : undefined));
  const children = useWorkbenchTaskStore((s) => (sessionId ? s.children[sessionId] : undefined));
  const stats = useWorkbenchTaskStore((s) => (sessionId ? s.sessionStats[sessionId] : undefined));

  const hasPlan = Boolean(planMd && planMd.trim());
  const steps = useMemo(() => parsePlanSteps(planMd), [planMd]);
  const legacySteps = useMemo(() => parseStepItems(planMd), [planMd]);
  const acceptance = useMemo(() => parseAcceptance(planMd), [planMd]);
  const policy = useMemo(() => parsePlanPolicy(planMd), [planMd]);
  const goal = useMemo(
    () => parsePlanGoal(planMd) || task.plan?.goal || task.title,
    [planMd, task.plan?.goal, task.title],
  );

  const completed = Boolean(task.completedAt);
  const stage = stageOf(phase);
  /** 验收中 / 已完成不再改计划（改计划只发生在规划与执行段）。 */
  const editable = !readOnly && !completed && phase !== 'awaiting';
  const activeIndex = useMemo(() => {
    if (completed) return null;
    const index = steps.findIndex((step) => !step.done);
    return index >= 0 ? index : null;
  }, [completed, steps]);
  const states = useMemo(
    () =>
      steps.map((step, index) =>
        deriveStepState(step, { activeIndex, index, taskCompleted: completed, running }),
      ),
    [activeIndex, completed, running, steps],
  );

  /** T-id → 负责它的子代理（catalog label 点名 + children 运行态）。 */
  const workersByStep = useMemo(() => {
    const runningIds = new Set((children ?? []).filter((c) => c.running).map((c) => c.sessionId));
    const presetById = new Map((children ?? []).map((c) => [c.sessionId, c.preset]));
    const map: Record<string, StepWorker[]> = {};
    for (const step of steps) {
      map[step.id] = (catalog ?? [])
        .filter((meta) => labelMentions(meta.label, step.id))
        .map((meta) => ({
          id: meta.id,
          name: presetById.get(meta.id) ?? (meta.mode === 'unknown' ? 'worker' : meta.mode),
          running: runningIds.has(meta.id),
        }));
    }
    return map;
  }, [catalog, children, steps]);

  // ---------------------------------------------------------------------------
  // 动作
  // ---------------------------------------------------------------------------

  const writePlan = useCallback(
    async (markdown: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await invoke('todo_plan_set', { taskId: task.id, markdown });
        onPlanChange?.(task.id, markdown);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onPlanChange, task.id],
  );

  /** 计划变更摘要：「修改 T3、新增 T5」。 */
  const describeDiff = useCallback(
    (diff: PlanStepDiff): string => {
      const parts: string[] = [];
      if (diff.changed.length) {
        parts.push(t('nav.workbenchWindow.planCard.diffChanged', { ids: diff.changed.join(', ') }));
      }
      if (diff.added.length) {
        parts.push(t('nav.workbenchWindow.planCard.diffAdded', { ids: diff.added.join(', ') }));
      }
      if (diff.removed.length) {
        parts.push(t('nav.workbenchWindow.planCard.diffRemoved', { ids: diff.removed.join(', ') }));
      }
      return parts.length
        ? parts.join(t('nav.workbenchWindow.planCard.diffJoin'))
        : t('nav.workbenchWindow.planCard.diffBody');
    },
    [t],
  );

  /**
   * 用户改计划 = 需求变更（规范 §9.6「改计划即重新待批」）：
   * 写盘；若已批准则清除批准，并把 diff 摘要排进会话，让 agent 重读计划。
   */
  const commitPlan = useCallback(
    async (next: string): Promise<boolean> => {
      if (next === planMd) return true;
      const diff = diffPlanSteps(planMd, next);
      const ok = await writePlan(next);
      if (!ok) return false;
      if (task.planApprovedAt) {
        useTodoStore.getState().updateTask(task.id, { planApprovedAt: null });
        if (sessionId) {
          const message = t('nav.workbenchWindow.planCard.changedMessage', {
            summary: describeDiff(diff),
          });
          void dshSession.prompt(sessionId, message, { mode: 'queue' }).catch(() => undefined);
        }
      }
      return true;
    },
    [describeDiff, planMd, sessionId, t, task.id, task.planApprovedAt, writePlan],
  );

  const saveStep = useCallback(async (): Promise<void> => {
    if (!stepDraft || planMd == null || busy || !stepDraft.title.trim()) return;
    let next = setStepTitle(planMd, stepDraft.lineIndex, stepDraft.title);
    next = setStepCommand(next, stepDraft.lineIndex, stepDraft.cmd);
    if (await commitPlan(next)) setStepDraft(null);
  }, [busy, commitPlan, planMd, stepDraft]);

  const removeStep = useCallback(async (): Promise<void> => {
    if (!stepDraft || planMd == null || busy) return;
    if (await commitPlan(deleteStep(planMd, stepDraft.lineIndex))) setStepDraft(null);
  }, [busy, commitPlan, planMd, stepDraft]);

  const addStep = useCallback(async (): Promise<void> => {
    if (planMd == null || busy) return;
    const result = appendStep(planMd, t('nav.workbenchWindow.planCard.newStep'));
    if (!result || !(await commitPlan(result.md))) return;
    const created = parsePlanSteps(result.md).find((step) => step.id === result.id);
    if (created) setStepDraft({ lineIndex: created.lineIndex, title: created.title, cmd: '' });
  }, [busy, commitPlan, planMd, t]);

  const saveSource = useCallback(async (): Promise<void> => {
    if (sourceDraft == null || busy) return;
    if (await commitPlan(sourceDraft)) setSourceDraft(null);
  }, [busy, commitPlan, sourceDraft]);

  const approve = useCallback((): void => {
    useTodoStore.getState().updateTask(task.id, { planApprovedAt: Date.now() });
    // 批准消息进队列（agent 收尾中也不丢）；它同时是消息流里的留痕行
    if (sessionId) {
      void dshSession
        .prompt(sessionId, t('nav.workbenchWindow.progress.approvePlanMessage'), { mode: 'queue' })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [sessionId, t, task.id]);

  const nudgeSelfCheck = useCallback((): void => {
    if (!sessionId) return;
    void dshSession
      .prompt(sessionId, t('nav.workbenchWindow.progress.nudgeSelfCheckMessage'), { mode: 'queue' })
      .catch(() => undefined);
  }, [sessionId, t]);

  const accept = useCallback((): void => {
    useTodoStore.getState().completeTask(task.id, true);
  }, [task.id]);

  const reject = useCallback(
    (input: string): void => {
      const reason = input.trim() || t('nav.workbenchWindow.board.rejectDefault');
      useTodoStore.getState().updateTask(task.id, { agentCompletedAt: null });
      // 退回必须把意见发回会话，否则 agent 完全不知道被打回
      if (sessionId) {
        void dshSession.prompt(sessionId, buildRejectPrompt(reason)).catch(() => undefined);
      }
    },
    [sessionId, t, task.id],
  );

  const toggleAcceptance = useCallback(
    (lineIndex: number, done: boolean): void => {
      if (planMd == null || busy) return;
      void writePlan(toggleAcceptanceLine(planMd, lineIndex, done));
    },
    [busy, planMd, writePlan],
  );

  // ---------------------------------------------------------------------------
  // 渲染块
  // ---------------------------------------------------------------------------

  const stageSteps = WORKBENCH_STAGES.map((key) => ({
    title: t(`nav.workbenchWindow.stages.${key}`),
  }));

  const head = (
    <header className="ai00-x-plan-card__head">
      <p className="ai00-x-plan-card__goal">{goal}</p>
      <Steps className="ai00-x-plan-card__stages" steps={stageSteps} current={stage.index} />
      {policy.execution === 'local-first' && (
        <p className="ai00-x-plan-card__policy">
          {t('nav.workbenchWindow.plan.executionLocal')} ·{' '}
          {policy.review === 'strict'
            ? t('nav.workbenchWindow.plan.reviewStrict')
            : t('nav.workbenchWindow.plan.reviewAdaptive')}
        </p>
      )}
    </header>
  );

  const renderWorkers = (step: PlanStep): React.ReactNode => {
    const workers = workersByStep[step.id] ?? [];
    if (workers.length === 0) return null;
    const shown = workers.slice(-2);
    return (
      <span className="ai00-x-plan-card__workers">
        {shown.map((worker) => (
          <button
            key={worker.id}
            type="button"
            className={`ai00-x-plan-card__worker${worker.running ? ' is-running' : ''}`}
            onClick={() => focusSubagentCard(worker.id)}
            title={t('nav.workbenchWindow.subagentLocate')}
          >
            <span className="ai00-x-plan-card__worker-dot" aria-hidden />
            {worker.name}
          </button>
        ))}
        {workers.length > shown.length && (
          <span className="ai00-x-plan-card__worker-more">+{workers.length - shown.length}</span>
        )}
      </span>
    );
  };

  const renderDetails = (step: PlanStep): React.ReactNode => {
    const verdict = step.verification?.verdict;
    const hasDetails =
      step.acceptance.length > 0 || Boolean(step.evidence) || Boolean(step.verification) || step.paths.length > 0;
    if (!hasDetails) return null;
    const verdictText =
      verdict === 'passed'
        ? t('nav.workbenchWindow.plan.verifyPassed')
        : verdict === 'failed'
          ? t('nav.workbenchWindow.plan.verifyFailed')
          : verdict === 'needs-review'
            ? t('nav.workbenchWindow.plan.verifyNeedsReview')
            : null;
    return (
      <Collapse className="ai00-x-plan-card__details">
        <CollapseItem
          itemKey={step.id}
          header={
            <span className="ai00-x-plan-card__details-head">
              {t('nav.workbenchWindow.planCard.details')}
              {verdictText && (
                <span className={`ai00-x-plan-card__verdict is-${verdict}`}>{verdictText}</span>
              )}
            </span>
          }
        >
          {step.acceptance.length > 0 && (
            <ul className="ai00-x-plan-card__checks">
              {step.acceptance.map((item) => (
                <li key={item.text}>
                  <span>{item.cmd ? item.text.replace(/\s*\{cmd:.*\}\s*$/, '') : item.text}</span>
                  {item.cmd && <code className="ai00-x-plan-card__cmd">{item.cmd}</code>}
                </li>
              ))}
            </ul>
          )}
          {step.paths.length > 0 && (
            <p className="ai00-x-plan-card__meta">
              <span className="ai00-x-plan-card__meta-label">{t('nav.workbenchWindow.plan.scope')}</span>
              {step.paths.map((path) => (
                <code key={path} className="ai00-x-plan-card__path">
                  {path}
                </code>
              ))}
            </p>
          )}
          {step.verification?.at && (
            <p className="ai00-x-plan-card__meta">
              {t('nav.workbenchWindow.plan.verifiedAt', { at: step.verification.at })}
            </p>
          )}
          {step.evidence && (
            <p className="ai00-x-plan-card__meta">
              <span className="ai00-x-plan-card__meta-label">{t('nav.workbenchWindow.plan.evidence')}</span>
              {step.evidence}
            </p>
          )}
        </CollapseItem>
      </Collapse>
    );
  };

  const startEdit = (step: PlanStep): void => {
    setStepDraft({
      lineIndex: step.lineIndex,
      title: step.title,
      cmd: step.acceptance.find((item) => item.cmd)?.cmd ?? '',
    });
  };

  const renderEditor = (step: PlanStep, draft: StepDraft): React.ReactNode => {
    const onKeyDown = (event: React.KeyboardEvent): void => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void saveStep();
      } else if (event.key === 'Escape') {
        setStepDraft(null);
      }
    };
    return (
      <span className="ai00-x-plan-card__editor">
        <span className="ai00-x-plan-card__editor-row">
          <span className="ai00-x-plan-card__step-id">{step.id}</span>
          <Input
            inputSize="small"
            autoFocus
            value={draft.title}
            aria-label={t('nav.workbenchWindow.planCard.stepTitle')}
            onChange={(e) => setStepDraft({ ...draft, title: e.target.value })}
            onKeyDown={onKeyDown}
          />
        </span>
        <Input
          inputSize="small"
          className="ai00-x-plan-card__editor-cmd"
          value={draft.cmd}
          placeholder={t('nav.workbenchWindow.planCard.stepCommand')}
          aria-label={t('nav.workbenchWindow.planCard.stepCommand')}
          onChange={(e) => setStepDraft({ ...draft, cmd: e.target.value })}
          onKeyDown={onKeyDown}
        />
        <span className="ai00-x-plan-card__editor-actions">
          <Button variant="ghost" size="small" onClick={() => void removeStep()} disabled={busy}>
            <Trash2 size={12} />
            {t('nav.workbenchWindow.planCard.deleteStep')}
          </Button>
          <span className="ai00-x-plan-card__editor-spacer" />
          <Button variant="secondary" size="small" onClick={() => setStepDraft(null)} disabled={busy}>
            {t('nav.workbenchWindow.plan.editCancel')}
          </Button>
          <Button
            variant="primary"
            size="small"
            onClick={() => void saveStep()}
            disabled={busy || !draft.title.trim()}
          >
            {t('nav.workbenchWindow.planCard.saveStep')}
          </Button>
        </span>
        {task.planApprovedAt && (
          <span className="ai00-x-plan-card__muted">{t('nav.workbenchWindow.plan.editHint')}</span>
        )}
      </span>
    );
  };

  const renderStepHead = (step: PlanStep, state: PlanStepState): React.ReactNode => (
    <span className="ai00-x-plan-card__step-head">
      <span className="ai00-x-plan-card__step-id">{step.id}</span>
      <span
        className="ai00-x-plan-card__step-title"
        onDoubleClick={editable ? () => startEdit(step) : undefined}
      >
        {step.title}
      </span>
      <span className={`ai00-x-plan-card__state is-${state}`}>{t(STATE_KEY[state])}</span>
      {renderWorkers(step)}
      {editable && (
        <button
          type="button"
          className="ai00-x-plan-card__icon ai00-x-plan-card__edit"
          onClick={() => startEdit(step)}
          title={t('nav.workbenchWindow.planCard.editStep')}
          aria-label={t('nav.workbenchWindow.planCard.editStep')}
        >
          <Pencil size={12} />
        </button>
      )}
    </span>
  );

  const stepList =
    steps.length > 0 ? (
      <Timeline className="ai00-x-plan-card__steps">
        {steps.map((step, index) => {
          const state = states[index];
          const draft = stepDraft?.lineIndex === step.lineIndex ? stepDraft : null;
          return (
            <TimelineItem
              key={step.id || index}
              className={`ai00-x-plan-card__step is-${state}`}
              status={TIMELINE_STATUS[state]}
              title={draft ? renderEditor(step, draft) : renderStepHead(step, state)}
            >
              {draft ? null : renderDetails(step)}
            </TimelineItem>
          );
        })}
        {editable && (
          <li className="ai00-x-plan-card__add-row">
            <button
              type="button"
              className="ai00-x-plan-card__link"
              onClick={() => void addStep()}
              disabled={busy}
            >
              <Plus size={12} />
              {t('nav.workbenchWindow.planCard.addStep')}
            </button>
          </li>
        )}
      </Timeline>
    ) : (
      <WorkbenchProgress
        steps={legacySteps.map((step) => ({ text: step.text, done: step.done }))}
        activeIndex={completed ? null : legacySteps.findIndex((step) => !step.done)}
        hint={t('nav.workbenchWindow.plan.legacyPlanHint')}
        hideHead
      />
    );

  const doneCount = steps.length > 0 ? steps.filter((s) => s.done).length : legacySteps.filter((s) => s.done).length;
  const totalCount = steps.length > 0 ? steps.length : legacySteps.length;
  const reworkCount = states.filter((s) => s === 'rework').length;
  const allDone = totalCount > 0 && doneCount === totalCount;

  const deliverables = (
    <section className="ai00-x-plan-card__block">
      <h3 className="ai00-x-plan-card__block-title">{t('nav.workbenchWindow.board.deliverables')}</h3>
      {task.deliverables?.length ? (
        <ul className="ai00-x-plan-card__files">
          {task.deliverables.slice(0, MAX_DELIVERABLES).map((path) => (
            <li key={path} className="ai00-x-plan-card__file">
              <button
                type="button"
                className="ai00-x-plan-card__file-name"
                title={path}
                onClick={() => onOpenFile?.(path)}
              >
                {fileName(path)}
              </button>
              <button
                type="button"
                className="ai00-x-plan-card__icon"
                onClick={() => workspaceAPI.revealInExplorer(path).catch(() => undefined)}
                title={t('nav.workbenchWindow.board.reveal')}
                aria-label={t('nav.workbenchWindow.board.reveal')}
              >
                <FolderOpen size={12} />
              </button>
            </li>
          ))}
          {task.deliverables.length > MAX_DELIVERABLES && (
            <li className="ai00-x-plan-card__more">
              {t('nav.workbenchWindow.review.more', {
                count: task.deliverables.length - MAX_DELIVERABLES,
              })}
            </li>
          )}
        </ul>
      ) : (
        <p className="ai00-x-plan-card__muted">
          {task.agentCompletedAt
            ? t('nav.workbenchWindow.board.deliverablesMissing')
            : t('nav.workbenchWindow.board.deliverablesPending')}
        </p>
      )}
    </section>
  );

  const acceptedCount = acceptance.filter((item) => item.done).length;
  const acceptBlocked = acceptance.length > 0 && acceptedCount < acceptance.length;

  const reviewArea = (
    <div className="ai00-x-plan-card__review">
      <section className="ai00-x-plan-card__block">
        <h3 className="ai00-x-plan-card__block-title">
          {t('nav.workbenchWindow.board.acceptance')}
          {acceptance.length > 0 && (
            <span className="ai00-x-plan-card__count">
              {acceptedCount}/{acceptance.length}
            </span>
          )}
        </h3>
        {acceptance.length === 0 ? (
          <p className="ai00-x-plan-card__muted">{t('nav.workbenchWindow.board.noAcceptance')}</p>
        ) : (
          <ul className="ai00-x-plan-card__accept-list">
            {acceptance.map((item) => (
              <li key={item.lineIndex}>
                <label className={`ai00-x-plan-card__accept${item.done ? ' is-done' : ''}`}>
                  <input
                    type="checkbox"
                    checked={item.done}
                    disabled={busy || completed || readOnly}
                    onChange={() => toggleAcceptance(item.lineIndex, !item.done)}
                  />
                  <span>{item.text}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>
      {deliverables}
      {!readOnly && !completed && (
        <div className="ai00-x-plan-card__actions">
          <Button variant="secondary" size="small" onClick={() => setRejectOpen(true)}>
            <Undo2 size={12} />
            {t('nav.workbenchWindow.review.reject')}
          </Button>
          <Button
            variant="primary"
            size="small"
            disabled={acceptBlocked}
            title={
              acceptBlocked
                ? t('nav.workbenchWindow.board.acceptBlocked', {
                    count: acceptance.length - acceptedCount,
                  })
                : t('nav.workbenchWindow.board.acceptHint')
            }
            onClick={accept}
          >
            <Check size={12} />
            {t('nav.workbenchWindow.review.approve')}
          </Button>
        </div>
      )}
    </div>
  );

  const approveArea = (
    <div className="ai00-x-plan-card__approve">
      <p className="ai00-x-plan-card__hint">
        {running
          ? t('nav.workbenchWindow.progress.planConfirmRunningHint')
          : t('nav.workbenchWindow.planCard.approveHint')}
      </p>
      {!readOnly && (
        <DsButton variant="seal" size="base" className="ai00-x-plan-card__cta" onClick={approve}>
          {t('nav.workbenchWindow.planCard.approve')}
        </DsButton>
      )}
    </div>
  );

  const executeArea = (
    <div className="ai00-x-plan-card__execute">
      <div className="ai00-x-plan-card__stats">
        <Statistic
          title={t('nav.workbenchWindow.planCard.statsDone')}
          value={doneCount}
          suffix={`/${totalCount}`}
        />
        <Statistic title={t('nav.workbenchWindow.planCard.statsRework')} value={reworkCount} />
        {stats && (
          <>
            <Statistic title={t('nav.workbenchWindow.planCard.statsTools')} value={stats.tools.total} />
            <Statistic
              title={t('nav.workbenchWindow.planCard.statsToolFailures')}
              value={stats.tools.failures}
            />
          </>
        )}
      </div>
      {!readOnly && allDone && !running && !task.agentCompletedAt && (
        <div className="ai00-x-plan-card__nudge">
          <p className="ai00-x-plan-card__hint">{t('nav.workbenchWindow.progress.nudgeSelfCheck')}</p>
          <Button variant="secondary" size="small" onClick={nudgeSelfCheck}>
            {t('nav.workbenchWindow.progress.nudgeSelfCheckAction')}
          </Button>
        </div>
      )}
    </div>
  );

  const footer = completed ? (
    <div className="ai00-x-plan-card__review">
      <p className="ai00-x-plan-card__done-line">
        <Check size={12} />
        {t('nav.workbenchWindow.planCard.accepted')}
      </p>
      {deliverables}
    </div>
  ) : phase === 'awaiting' ? (
    reviewArea
  ) : phase === 'approving' ? (
    approveArea
  ) : (
    executeArea
  );

  // ---------------------------------------------------------------------------
  // 空态 / 规划中
  // ---------------------------------------------------------------------------

  if (!hasPlan) {
    return (
      <article className="ai00-x-plan-card is-empty">
        {running ? (
          <div className="ai00-x-plan-card__generating ds-ink-ripple" role="status" aria-live="polite">
            <p className="ai00-x-plan-card__generating-text">
              {t('nav.workbenchWindow.planCard.generating')}
            </p>
            {[0, 1, 2].map((row) => (
              <div key={row} className="ai00-x-plan-card__skeleton-row">
                <Skeleton className="ai00-x-plan-card__skeleton-dot" />
                <Skeleton className="ai00-x-plan-card__skeleton-line" />
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title={t('nav.workbenchWindow.planCard.emptyTitle')}
            description={t('nav.workbenchWindow.progress.empty')}
          />
        )}
      </article>
    );
  }

  return (
    <article className={`ai00-x-plan-card is-${phase}`}>
      {head}
      <div className="ai00-x-plan-card__body">{stepList}</div>
      {error && (
        <p className="ai00-x-plan-card__error" role="alert">
          {error}
        </p>
      )}
      <footer className="ai00-x-plan-card__footer">{footer}</footer>

      <div className="ai00-x-plan-card__source-bar">
        {editable && sourceDraft == null && (
          <button
            type="button"
            className="ai00-x-plan-card__link"
            onClick={() => {
              setSourceDraft(planMd ?? '');
              setSourceOpen(true);
            }}
          >
            {t('nav.workbenchWindow.plan.edit')}
          </button>
        )}
        <button
          type="button"
          className="ai00-x-plan-card__link"
          onClick={() => {
            setSourceOpen((prev) => !prev);
            setSourceDraft(null);
          }}
          aria-expanded={sourceOpen}
        >
          {sourceOpen ? t('nav.workbenchWindow.plan.hideSource') : t('nav.workbenchWindow.plan.viewSource')}
        </button>
      </div>
      {sourceOpen && (
        <div className="ai00-x-plan-card__source">
          {sourceDraft != null ? (
            <>
              <textarea
                className="ai00-x-plan-card__source-input"
                value={sourceDraft}
                onChange={(e) => setSourceDraft(e.target.value)}
                spellCheck={false}
                aria-label={t('nav.workbenchWindow.plan.edit')}
              />
              <div className="ai00-x-plan-card__actions">
                <span className="ai00-x-plan-card__hint">{t('nav.workbenchWindow.plan.editHint')}</span>
                <Button variant="secondary" size="small" onClick={() => setSourceDraft(null)} disabled={busy}>
                  {t('nav.workbenchWindow.plan.editCancel')}
                </Button>
                <Button
                  variant="primary"
                  size="small"
                  onClick={() => void saveSource()}
                  disabled={busy || sourceDraft === planMd}
                >
                  {t('nav.workbenchWindow.plan.editSave')}
                </Button>
              </div>
            </>
          ) : (
            <Markdown content={(planMd ?? '').replace(/^- \[x\] /gm, '✓ ').replace(/^- \[ \] /gm, '□ ')} />
          )}
        </div>
      )}

      <InputDialog
        isOpen={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={(value) => reject(value)}
        title={t('nav.workbenchWindow.review.reject')}
        description={t('nav.workbenchWindow.board.rejectPrompt')}
        defaultValue={t('nav.workbenchWindow.board.rejectDefault')}
        confirmText={t('nav.workbenchWindow.review.reject')}
        required={false}
      />
    </article>
  );
};

export default WorkbenchPlanCard;
