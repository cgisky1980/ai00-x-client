/**
 * TaskScene — 工作台任务主场景（规范 v0.23 §9.2 / §9.7）。
 *
 * 左：默认工作区的任务列表（项目任务归项目工作台；跨工作台聚合在看板）；
 * 中 + 右：`WorkbenchTaskHost`（计划卡 / 文件标签 + 常驻对话），与项目场景共用。
 * 新任务：Display 标题 + 起步卡 + hero 输入框；默认「完整交付」，快速问答是输入框旁的小开关。
 * 提交后立刻进入计划卡骨架，不停在 spinner。建卡 / 建会话 / 首轮任务书由 taskSession 负责。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Archive, Bug, BookOpen, Loader2, Plus, Search, Sparkles } from 'lucide-react';
import { Prompts, Switch } from '@/component-library';
import { AgentComposer } from '@/app/components/ai/AgentComposer';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { TodoTask, WorkbenchProject } from '@/tools/todo/api/types';
import { useTodoStore } from '@/tools/todo/store/todoStore';
import { summarizeFailure } from '@/tools/todo/utils/failureHint';
import { WorkbenchStageDots, WorkbenchStatusTag } from '../workbench/WorkbenchStageBar';
import { WorkbenchTaskHost } from '../workbench/WorkbenchTaskHost';
import { needsYou } from '../workbench/workbenchStage';
import { PlanCardGenerating } from '../workbench/WorkbenchPlanCard';
import {
  TASKS_WORKBENCH_ID,
  createTask,
  ensureTaskSession,
  resumeTaskRun,
  taskTitleFromRequest,
} from './taskSession';
import { TaskActionsMenu } from './TaskActionsMenu';
import { TrunkBranchDialog, type TrunkBranchRequest } from './TrunkBranchDialog';
import { taskPhase, type TaskPhase } from './taskPhase';
import { useTaskPlans } from './useTaskPlans';
import { useSessionRunningSync } from './useSessionRunningSync';
import { useWorkbenchTaskStore } from './workbenchTaskStore';
import { TrunkBranchError, WorktreeUnavailableError, createTaskBranch, type TrunkDecision } from '../projects/projectGit';
import '../workbench/WorkbenchPlanCard.scss';
import './TaskScene.scss';

interface TaskSceneProps {
  /** 看板点卡片投递的任务 id（场景内 state，不走 windowBus）；消费后清空。 */
  focusTaskId?: string | null;
  onFocusHandled?: () => void;
}

/** 起步卡：点一下把模板填进输入框（i18n 键 = tasks.starters.<key>.*）。 */
const STARTERS = [
  { key: 'bug', icon: <Bug size={16} /> },
  { key: 'feature', icon: <Sparkles size={16} /> },
  { key: 'docs', icon: <BookOpen size={16} /> },
  { key: 'research', icon: <Search size={16} /> },
] as const;

export const TaskScene: React.FC<TaskSceneProps> = ({ focusTaskId = null, onFocusHandled }) => {
  const { t } = useI18n('common');
  const workbenchTitle = t('nav.workbenchWindow.tasks.title');
  // 引擎会话运行态校准：没打开过的任务也要能落到「已停止」
  useSessionRunningSync();

  const loaded = useTodoStore((s) => s.loaded);
  const load = useTodoStore((s) => s.load);
  const allTasks = useTodoStore((s) => s.data.tasks);
  const projects = useTodoStore((s) => s.data.projects);

  /** 侧栏显示已归档任务（归档只影响列表可见性，卡片与会话保留）。 */
  const [showArchived, setShowArchived] = useState(false);

  /** 侧栏只列默认工作区任务；项目任务由项目工作台进入，详情仍可在本场景展示。 */
  const isDefaultTask = useCallback(
    (task: TodoTask): boolean =>
      task.origin === 'workbench' &&
      !task.projectId &&
      (!task.workbenchId || task.workbenchId === TASKS_WORKBENCH_ID),
    [],
  );
  const tasks = useMemo(
    () =>
      allTasks
        .filter(
          (task) =>
            isDefaultTask(task) &&
            (showArchived ? Boolean(task.archivedAt) : !task.archivedAt),
        )
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [allTasks, isDefaultTask, showArchived],
  );
  const archivedCount = useMemo(
    () =>
      allTasks.filter((task) => isDefaultTask(task) && Boolean(task.archivedAt)).length,
    [allTasks, isDefaultTask],
  );
  const openableTask = useCallback(
    (id: string | null): TodoTask | null =>
      id
        ? (allTasks.find(
            (task) => task.id === id && task.origin === 'workbench',
          ) ?? null)
        : null,
    [allTasks],
  );
  const projectOf = useCallback(
    (task: TodoTask | null): WorkbenchProject | null =>
      task?.projectId ? (projects.find((p) => p.id === task.projectId) ?? null) : null,
    [projects],
  );

  // 快速问答没有计划文档：不加载计划
  const planTasks = useMemo(
    () => allTasks.filter((task) => task.origin === 'workbench' && task.executionMode !== 'quick'),
    [allTasks],
  );
  const { plans, setPlan } = useTaskPlans(planTasks);
  const selectedId = useWorkbenchTaskStore((s) => s.selectedTaskId);
  const runtime = useWorkbenchTaskStore((s) => s.runtime);
  /** 会话上一轮失败原文（overlay 轮询同步过来）：行上给悬停提示「为什么需要你」。 */
  const agentErrors = useTodoStore((s) => s.agentErrors);
  const selectTask = useWorkbenchTaskStore((s) => s.selectTask);
  const startNewTask = useWorkbenchTaskStore((s) => s.startNewTask);
  const [draft, setDraft] = useState('');
  /** 执行模式：默认完整交付（规划 → 批准 → 子代理 → 验收）；快速问答为次要开关。 */
  const [executionMode, setExecutionMode] = useState<'quick' | 'delivery'>('delivery');
  /** 新任务空态预选的模型（建会话后落到该会话）。 */
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'open' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 主干分支守卫：等用户决定「开分支 / 照旧 / 取消」。 */
  const [trunkRequest, setTrunkRequest] = useState<TrunkBranchRequest | null>(null);
  const trunkPendingRef = useRef<{
    task: TodoTask;
    project: WorkbenchProject | null;
    model: string | null;
  } | null>(null);
  const openTokenRef = useRef(0);
  const selectedTask = openableTask(selectedId);
  const selectedProject = projectOf(selectedTask);
  const phaseOf = (task: TodoTask): TaskPhase =>
    taskPhase(
      task,
      plans[task.id] ?? null,
      task.agentSessionId ? runtime[task.agentSessionId] : undefined,
    );
  const askingOf = (task: TodoTask): boolean =>
    Boolean(task.agentSessionId && runtime[task.agentSessionId]?.asking);
  /** 「上一轮失败原因」一句话（无失败 / 无原文时为空串）。 */
  const failureOf = (task: TodoTask): string => {
    const err = task.agentSessionId ? agentErrors[task.agentSessionId] : undefined;
    return err ? summarizeFailure(err) : '';
  };

  /**
   * 列表显示顺序：三档——「需要你」置顶（待批准/待验收/提问），其次是**失败**的
   * （这一轮报错、要人点「继续执行」），其余按新→旧。判断与状态标签同源
   * （taskPhase + needsYou），不另立口径。
   */
  const orderedTasks = useMemo(() => {
    const rank = (task: TodoTask): number => {
      const phase = taskPhase(
        task,
        plans[task.id] ?? null,
        task.agentSessionId ? runtime[task.agentSessionId] : undefined,
      );
      const asking = Boolean(task.agentSessionId && runtime[task.agentSessionId]?.asking);
      if (needsYou(phase, asking)) return 0;
      return phase === 'failed' ? 1 : 2;
    };
    return tasks
      .map((task, index) => ({ task, index, rank: rank(task) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((row) => row.task);
  }, [plans, runtime, tasks]);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // 选中任务被删除 → 回到新任务输入
  useEffect(() => {
    if (selectedId && !openableTask(selectedId)) startNewTask();
  }, [selectedId, openableTask, startNewTask]);

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  /** 打开任务：绑定直接读任务卡；这里只负责首次建会话，旧 Promise 不得回写新选中。 */
  const openTask = useCallback(
    async (
      task: TodoTask,
      preferredModel: string | null = null,
      allowTrunk = false,
    ): Promise<void> => {
      const token = ++openTokenRef.current;
      setError(null);
      selectTask(task.id);
      if (task.agentSessionId) {
        setBusy(null);
        // 已有会话的任务也要刷新宿主注入的 `AGENTS.local.md`：它是每轮进上下文的
        // 常驻文件，loop 规约更新后旧卡不刷新就会一直带着过期文案（实测 7.126）。
        // `ensureTaskSession` 的「已有会话」分支只重写该文件，不重发任务书、不重建会话；
        // 外部项目目录不写该文件（内部会跳过），失败不阻断打开。
        void ensureTaskSession(task, workbenchTitle, projectOf(task)).catch(() => undefined);
        return;
      }
      setBusy('open');
      try {
        const project = projectOf(task);
        // 计划已批准但会话丢了（历史数据 / 引擎清会话）：不能当新任务重发首轮任务书，
        // 否则 agent 会从头再规划一遍，和卡片上已有的计划书打架。按计划续跑。
        // 计划直接从磁盘读，不依赖 state 是否加载完（首次打开可能还在读）。
        const resumable = !project && task.planApprovedAt && !task.completedAt && !task.agentCompletedAt;
        const planMd = resumable
          ? await invoke<string | null>('todo_plan_get', { taskId: task.id }).catch(() => null)
          : null;
        if (planMd && planMd.trim()) {
          await resumeTaskRun(task, workbenchTitle);
        } else {
          await ensureTaskSession(task, workbenchTitle, project, preferredModel, { allowTrunk });
        }
      } catch (e) {
        if (token !== openTokenRef.current) return;
        if (e instanceof TrunkBranchError) {
          trunkPendingRef.current = { task, project: projectOf(task), model: preferredModel };
          setTrunkRequest({ branch: e.branch, dir: e.dir, taskTitle: task.title });
          setBusy(null);
          return;
        }
        if (e instanceof WorktreeUnavailableError) {
          setError(t('nav.workbenchWindow.projects.isolateNotRepo'));
          return;
        }
        setError(t('nav.workbenchWindow.tasks.openFailed', { message: message(e) }));
      } finally {
        if (token === openTokenRef.current) setBusy(null);
      }
    },
    [projectOf, selectTask, t, workbenchTitle],
  );

  /** 主干守卫答复：开分支后重入；照旧带 allowTrunk 重入。 */
  const handleTrunkDecision = useCallback(
    (decision: TrunkDecision): void => {
      const pending = trunkPendingRef.current;
      trunkPendingRef.current = null;
      setTrunkRequest(null);
      if (!pending || decision === 'cancel') return;
      void (async () => {
        try {
          if (decision === 'branch' && pending.project) {
            await createTaskBranch(pending.project.dir, pending.task.title, pending.task.id);
          }
          await openTask(pending.task, pending.model, true);
        } catch (e) {
          setError(message(e));
        }
      })();
    },
    [openTask],
  );

  const handleNew = useCallback((): void => {
    openTokenRef.current += 1;
    setBusy(null);
    setError(null);
    setPendingModel(null);
    startNewTask();
  }, [startNewTask]);

  /** 一句需求 = 一张卡 + 一个会话 + 一条首轮任务书。 */
  const submitNew = useCallback(async (): Promise<void> => {
    const request = draft.trim();
    if (!request || busy) return;
    const token = ++openTokenRef.current;
    setError(null);
    setBusy('create');
    let task: TodoTask;
    try {
      task = await createTask(taskTitleFromRequest(request), request, undefined, executionMode);
    } catch (e) {
      if (token === openTokenRef.current) {
        setBusy(null);
        setError(t('nav.workbenchWindow.tasks.openFailed', { message: message(e) }));
      }
      return;
    }
    if (token !== openTokenRef.current) return;
    setDraft('');
    setPendingModel(null);
    await openTask(task, pendingModel);
  }, [busy, draft, executionMode, openTask, pendingModel, t]);

  // 看板点卡片 → 本场景选中该任务（项目任务也能在这里展示详情）
  useEffect(() => {
    if (!focusTaskId) return;
    const task = openableTask(focusTaskId);
    if (!task) return;
    void openTask(task);
    onFocusHandled?.();
  }, [focusTaskId, openableTask, openTask, onFocusHandled]);

  const creating = !selectedTask && busy === 'create';
  /** 提交后（建卡 / 建会话中）直接给计划卡骨架；快速问答没有计划区，仍用一行等待。 */
  const pendingDelivery =
    (creating && executionMode === 'delivery') ||
    (selectedTask && busy === 'open' && selectedTask.executionMode !== 'quick');

  return (
    <div className="ai00-x-task-scene">
      <aside className="ai00-x-task-scene__list">
        <div className="ai00-x-task-scene__list-head">
          <span className="ai00-x-task-scene__list-title">
            {t(
              showArchived
                ? 'nav.workbenchWindow.tasks.archivedTitle'
                : 'nav.workbenchWindow.tasks.title',
            )}
          </span>
          <button
            type="button"
            className={`ai00-x-task-scene__icon-button${showArchived ? ' is-active' : ''}`}
            onClick={() => setShowArchived((value) => !value)}
            title={t(
              showArchived
                ? 'nav.workbenchWindow.tasks.hideArchived'
                : 'nav.workbenchWindow.tasks.showArchived',
            )}
            aria-label={t(
              showArchived
                ? 'nav.workbenchWindow.tasks.hideArchived'
                : 'nav.workbenchWindow.tasks.showArchived',
            )}
            aria-pressed={showArchived}
          >
            <Archive size={14} />
            {archivedCount > 0 && !showArchived && (
              <span className="ai00-x-task-scene__badge">{archivedCount}</span>
            )}
          </button>
          <button
            type="button"
            className="ai00-x-task-scene__icon-button"
            onClick={handleNew}
            disabled={busy === 'create'}
            title={t('nav.workbenchWindow.tasks.new')}
            aria-label={t('nav.workbenchWindow.tasks.new')}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="ai00-x-task-scene__items">
          {orderedTasks.map((task) => (
            <div key={task.id} className="ai00-x-task-row">
              <button
                type="button"
                className={`ai00-x-task-scene__item${task.id === selectedId ? ' is-active' : ''}`}
                aria-current={task.id === selectedId ? 'true' : undefined}
                // 已归档：仍可打开只读查看（计划 / 交付物 / 对话历史），但不能继续驱动 agent。
                // 没有会话的归档卡没有可看的内容，保持禁用。
                disabled={Boolean(task.archivedAt) && !task.agentSessionId}
                title={
                  task.archivedAt
                    ? t('nav.workbenchWindow.tasks.archivedReadOnlyHint')
                    : failureOf(task) || undefined
                }
                onClick={() => void openTask(task)}
              >
                <span className="ai00-x-task-scene__item-title">{task.title}</span>
                {task.executionMode !== 'quick' && <WorkbenchStageDots phase={phaseOf(task)} />}
                <WorkbenchStatusTag
                  className="ai00-x-task-scene__item-meta"
                  phase={phaseOf(task)}
                  asking={askingOf(task)}
                  quick={task.executionMode === 'quick'}
                />
              </button>
              <TaskActionsMenu
                task={task}
                onArchived={() => {
                  if (task.id === selectedId) startNewTask();
                }}
                onDeleted={() => {
                  if (task.id === selectedId) startNewTask();
                }}
              />
            </div>
          ))}
          {tasks.length === 0 && (
            <div className="ai00-x-task-scene__empty">
              <p>
                {t(
                  showArchived
                    ? 'nav.workbenchWindow.tasks.archivedEmpty'
                    : 'nav.workbenchWindow.tasks.empty',
                )}
              </p>
            </div>
          )}
        </div>
      </aside>

      <main className="ai00-x-task-scene__main">
        {error && (
          <p className="ai00-x-task-scene__main-error" role="alert">
            {error}
          </p>
        )}
        {selectedTask?.agentSessionId && busy !== 'open' && (
          <WorkbenchTaskHost
            key={selectedTask.id}
            task={selectedTask}
            sessionId={selectedTask.agentSessionId}
            planMd={plans[selectedTask.id] ?? null}
            onPlanChange={setPlan}
            title={
              <>
                <h1 className="ai00-x-task-scene__conversation-title">{selectedTask.title}</h1>
                {selectedProject && (
                  <span
                    className="ai00-x-task-scene__conversation-project"
                    title={selectedProject.dir}
                  >
                    {selectedProject.name}
                  </span>
                )}
              </>
            }
          />
        )}
        {pendingDelivery && (
          <div className="ai00-x-task-scene__pending">
            <article className="ai00-x-plan-card is-empty">
              <PlanCardGenerating />
            </article>
          </div>
        )}
        {!pendingDelivery && busy && (creating || selectedTask) && (
          <div className="ai00-x-task-scene__placeholder" role="status" aria-live="polite">
            <Loader2 size={16} className="ai00-x-task-scene__spin" />
            <span>{t('nav.workbenchWindow.tasks.preparing')}</span>
          </div>
        )}
        {selectedTask && !selectedTask.agentSessionId && !busy && (
          <div className="ai00-x-task-scene__placeholder">
            <button
              type="button"
              className="ai00-x-task-scene__button"
              onClick={() => void openTask(selectedTask)}
            >
              {t('nav.workbenchScene.retry')}
            </button>
          </div>
        )}
        {!selectedTask && busy !== 'create' && (
          <section className="ai00-x-task-scene__new-task">
            <div className="ai00-x-task-scene__new-task-copy">
              <h1 className="ds-brush-reveal">{t('nav.workbenchWindow.tasks.newTaskTitle')}</h1>
              <p>{t('nav.workbenchWindow.tasks.newTaskHint')}</p>
            </div>
            <div className="ai00-x-task-scene__new-task-composer">
              <AgentComposer
                value={draft}
                onChange={setDraft}
                onSubmit={() => void submitNew()}
                placeholder={t('nav.workbenchWindow.tasks.requestPlaceholder')}
                variant="hero"
                pendingModelRef={pendingModel}
                onPendingModelChange={setPendingModel}
                controls={
                  <Switch
                    size="small"
                    checked={executionMode === 'quick'}
                    onChange={(event) =>
                      setExecutionMode(event.target.checked ? 'quick' : 'delivery')
                    }
                    label={t('nav.workbenchWindow.tasks.modeQuick')}
                    title={t('nav.workbenchWindow.tasks.modeQuickHint')}
                  />
                }
              />
            </div>
            <p className="ai00-x-task-scene__new-task-flow">
              {executionMode === 'quick'
                ? t('nav.workbenchWindow.tasks.modeQuickHint')
                : t('nav.workbenchWindow.tasks.modeDeliveryHint')}
            </p>
            <Prompts
              className="ai00-x-task-scene__starters"
              columns={2}
              items={STARTERS.map((starter) => ({
                key: starter.key,
                icon: starter.icon,
                title: t(`nav.workbenchWindow.tasks.starters.${starter.key}.title`),
                description: t(`nav.workbenchWindow.tasks.starters.${starter.key}.description`),
              }))}
              onSelect={(key) => setDraft(t(`nav.workbenchWindow.tasks.starters.${key}.prompt`))}
            />
          </section>
        )}
      </main>

      <TrunkBranchDialog request={trunkRequest} onDecision={handleTrunkDecision} />
    </div>
  );
};

export default TaskScene;
