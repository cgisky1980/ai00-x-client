/**
 * TaskScene — 工作台默认任务的主对话工作区。
 *
 * 三栏：左任务列表 + 中间标签区（首页=计划页，其余=文件预览）+ 右常驻对话。
 * 快速问答没有计划页：不渲染中间标签区，对话独占剩余空间。
 * 新任务从一句需求开始，建卡、准备目录、建会话与首轮 loop 任务书仍由 taskSession 统一负责。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, FileText, Loader2, Plus } from 'lucide-react';
import { AgentComposer } from '@/app/components/ai/AgentComposer';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { dshSession } from '@/infrastructure/api/service-api/DshAPI';
import { useResizablePane } from '@/hooks/useResizablePane';
import type { TodoTask, WorkbenchProject } from '@/tools/todo/api/types';
import { useTodoStore } from '@/tools/todo/store/todoStore';
import { WorkbenchChatPanel } from '../workbench/WorkbenchChatPanel';
import { WorkbenchStageDots, WorkbenchStatusTag } from '../workbench/WorkbenchStageBar';
import { WorkbenchReviewPanel } from '../workbench/WorkbenchReviewPanel';
import { buildRejectPrompt } from '@/agent/orchestrator/promptParts';
import { WorkbenchTabs, type WorkbenchTabItem } from '../workbench/WorkbenchTabs';
import { WorkbenchPlanPage } from '../workbench/WorkbenchPlanPage';
import { WorkbenchFilePreview } from '../workbench/WorkbenchFilePreview';
import { activeFilePath, useWorkbenchTabs } from '../workbench/useWorkbenchTabs';
import {
  TASKS_WORKBENCH_ID,
  createTask,
  ensureTaskSession,
  taskTitleFromRequest,
} from './taskSession';
import { TaskActionsMenu } from './TaskActionsMenu';
import { TrunkBranchDialog, type TrunkBranchRequest } from './TrunkBranchDialog';
import { taskPhase, type TaskPhase } from './taskPhase';
import { useTaskPlans } from './useTaskPlans';
import { useSessionRunningSync } from './useSessionRunningSync';
import { useWorkbenchTaskStore } from './workbenchTaskStore';
import { TrunkBranchError, WorktreeUnavailableError, createTaskBranch, type TrunkDecision } from '../projects/projectGit';
import './TaskScene.scss';

interface SceneBinding {
  sessionId: string;
  cwd: string;
  title: string;
}

interface TaskSceneProps {
  /** 看板点卡片投递的任务 id（场景内 state，不走 windowBus）；消费后清空。 */
  focusTaskId?: string | null;
  onFocusHandled?: () => void;
}

export const TaskScene: React.FC<TaskSceneProps> = ({ focusTaskId = null, onFocusHandled }) => {
  const { t } = useI18n('common');
  const workbenchTitle = t('nav.workbenchWindow.tasks.title');
  // 引擎会话运行态校准：没打开过的任务也要能落到「已停止」
  useSessionRunningSync();

  const loaded = useTodoStore((s) => s.loaded);
  const load = useTodoStore((s) => s.load);
  const allTasks = useTodoStore((s) => s.data.tasks);
  const completeTask = useTodoStore((s) => s.completeTask);
  const updateTask = useTodoStore((s) => s.updateTask);

  const projects = useTodoStore((s) => s.data.projects);
  /** 侧栏显示已归档任务（归档只影响列表可见性，卡片与会话保留）。 */
  const [showArchived, setShowArchived] = useState(false);
  /** 侧栏只列默认工作区任务；项目任务由项目工作台进入，详情仍在本场景展示。 */
  const tasks = useMemo(
    () =>
      allTasks
        .filter(
          (task) =>
            task.origin === 'workbench' &&
            !task.projectId &&
            (!task.workbenchId || task.workbenchId === TASKS_WORKBENCH_ID) &&
            (showArchived ? Boolean(task.archivedAt) : !task.archivedAt),
        )
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [allTasks, showArchived],
  );
  const archivedCount = useMemo(
    () =>
      allTasks.filter(
        (task) =>
          task.origin === 'workbench' &&
          !task.projectId &&
          (!task.workbenchId || task.workbenchId === TASKS_WORKBENCH_ID) &&
          Boolean(task.archivedAt),
      ).length,
    [allTasks],
  );
  const openableTask = useCallback(
    (id: string | null): TodoTask | null =>
      id
        ? (allTasks.find(
            (task) => task.id === id && task.origin === 'workbench' && !task.archivedAt,
          ) ?? null)
        : null,
    [allTasks],
  );

  // 快速问答没有计划文档：不加载计划，也就不存在计划页/计划条/步骤进度
  const planTasks = useMemo(
    () => allTasks.filter((task) => task.origin === 'workbench' && task.executionMode !== 'quick'),
    [allTasks],
  );
  const { plans, setPlan } = useTaskPlans(planTasks);
  const selectedId = useWorkbenchTaskStore((s) => s.selectedTaskId);
  const runtime = useWorkbenchTaskStore((s) => s.runtime);
  const selectTask = useWorkbenchTaskStore((s) => s.selectTask);
  const startNewTask = useWorkbenchTaskStore((s) => s.startNewTask);
  const reportRuntime = useWorkbenchTaskStore((s) => s.reportRuntime);
  const [draft, setDraft] = useState('');
  // 执行模式：快速问答（默认，直接回答） / 完整交付（规划→审批→子代理→验收）
  const [executionMode, setExecutionMode] = useState<'quick' | 'delivery'>('quick');
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
  const selectedProject = selectedTask?.projectId
    ? (projects.find((p) => p.id === selectedTask.projectId) ?? null)
    : null;
  const phaseOf = (task: TodoTask): TaskPhase =>
    taskPhase(
      task,
      plans[task.id] ?? null,
      task.agentSessionId ? runtime[task.agentSessionId] : undefined,
    );
  const askingOf = (task: TodoTask): boolean =>
    Boolean(task.agentSessionId && runtime[task.agentSessionId]?.asking);
  /** 快速问答：不展示任何计划相关 UI（计划页/计划条/阶段条/审批）。 */
  const selectedQuick = selectedTask?.executionMode === 'quick';
  /** 选中任务的会话是否在跑（计划步骤标「进行中」用）。 */
  const selectedRunning = Boolean(
    selectedTask?.agentSessionId && runtime[selectedTask.agentSessionId]?.running,
  );
  const binding = useMemo<SceneBinding | null>(
    () =>
      selectedTask?.agentSessionId
        ? { sessionId: selectedTask.agentSessionId, cwd: '', title: selectedTask.title }
        : null,
    [selectedTask?.agentSessionId, selectedTask?.title],
  );
  /** 快速问答没有中央计划区：对话独占主区（无标签区、无拖拽条）。 */
  const quickFull = Boolean(selectedQuick && binding);

  // ---- 中间标签区：首页=计划页，其余=文件预览；按任务记忆 ----
  const tabs = useWorkbenchTabs(selectedTask?.id ?? 'tasks-new');
  const currentPath = activeFilePath(tabs.activeKey);
  const tabItems = useMemo<WorkbenchTabItem[]>(
    () => [
      {
        key: 'home',
        kind: 'home' as const,
        title: t('nav.workbenchWindow.tabs.plan'),
        icon: <FileText size={13} />,
      },
      ...tabs.fileTabs.map((tab) => ({
        key: tab.key,
        kind: 'file' as const,
        title: tab.title,
        tooltip: tab.path,
        icon: <FileText size={13} />,
      })),
    ],
    [tabs.fileTabs, t],
  );
  /** 对话区宽度（与插件工作台共用记忆键）。 */
  const chat = useResizablePane({
    storageKey: 'workbench.chatWidth',
    defaultWidth: 380,
    min: 300,
    max: 640,
    edge: 'left',
    label: t('nav.workbenchWindow.resizeChat'),
  });

  const pickFile = useCallback((): void => {
    void import('@tauri-apps/plugin-dialog').then(({ open }) =>
      open({ multiple: false, directory: false, title: t('nav.workbenchWindow.tabs.pickFile') }).then(
        (picked) => {
          if (typeof picked === 'string') tabs.openFile(picked);
        },
      ),
    );
  }, [tabs, t]);

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
        return;
      }
      setBusy('open');
      const project = task.projectId
        ? (projects.find((p) => p.id === task.projectId) ?? null)
        : null;
      try {
        await ensureTaskSession(task, workbenchTitle, project, preferredModel, { allowTrunk });
      } catch (e) {
        if (token !== openTokenRef.current) return;
        if (e instanceof TrunkBranchError) {
          trunkPendingRef.current = { task, project, model: preferredModel };
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
    [projects, selectTask, t, workbenchTitle],
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

  // 看板点卡片 → 本场景选中该任务（场景内 state，不走 windowBus）
  useEffect(() => {
    if (!focusTaskId) return;
    const task = tasks.find((it) => it.id === focusTaskId);
    if (!task) return;
    void openTask(task);
    onFocusHandled?.();
  }, [focusTaskId, tasks, openTask, onFocusHandled]);

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
          {tasks.map((task) => (
            <div key={task.id} className="ai00-x-task-row">
              <button
                type="button"
                className={`ai00-x-task-scene__item${task.id === selectedId ? ' is-active' : ''}`}
                aria-current={task.id === selectedId ? 'true' : undefined}
                disabled={Boolean(task.archivedAt)}
                onClick={() => void openTask(task)}
              >
                <span className="ai00-x-task-scene__item-title">{task.title}</span>
                {task.executionMode !== 'quick' && <WorkbenchStageDots phase={phaseOf(task)} />}
                <WorkbenchStatusTag
                  className="ai00-x-task-scene__item-meta"
                  phase={phaseOf(task)}
                  asking={askingOf(task)}
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
        {selectedTask && busy !== 'open' && (
          <div className={`ai00-x-task-scene__row${quickFull ? ' is-quick' : ''}`}>
            {!quickFull && (
              <div className="ai00-x-task-scene__stage">
                <WorkbenchTabs
                  tabs={tabItems}
                  activeKey={tabs.activeKey}
                  onChange={tabs.setActiveKey}
                  onClose={tabs.closeTab}
                  onPickFile={pickFile}
                >
                  {currentPath ? (
                    <WorkbenchFilePreview path={currentPath} />
                  ) : (
                    <WorkbenchPlanPage
                      task={selectedTask}
                      planMd={plans[selectedTask.id] ?? null}
                      onPlanChange={setPlan}
                      onOpenFile={tabs.openFile}
                      running={selectedRunning}
                      header={
                        <>
                          <h1 className="ai00-x-task-scene__conversation-title">
                            {selectedTask.title}
                          </h1>
                          {selectedProject && (
                            <span
                              className="ai00-x-task-scene__conversation-project"
                              title={selectedProject.dir}
                            >
                              {selectedProject.name}
                            </span>
                          )}
                          <WorkbenchStatusTag
                            className="ai00-x-task-scene__conversation-status"
                            phase={phaseOf(selectedTask)}
                            asking={askingOf(selectedTask)}
                          />
                        </>
                      }
                    />
                  )}
                </WorkbenchTabs>
              </div>
            )}
            {binding && (
              <>
                {!quickFull && (
                  <div
                    className={`ai00-x-task-scene__chat-resizer${chat.dragging ? ' is-dragging' : ''}`}
                    {...chat.handleProps}
                  />
                )}
                <div
                  className={`ai00-x-task-scene__chat${quickFull ? ' is-full' : ''}`}
                  {...(quickFull ? {} : { style: { width: `${chat.width}px` } })}
                >
                  <WorkbenchChatPanel
                    key={binding.sessionId}
                    variant="conversation"
                    showWorkspace={false}
                    initialRequest={selectedTask.notes || selectedTask.title}
                    externalSession={{
                      sessionId: binding.sessionId,
                      ...(binding.cwd ? { cwd: binding.cwd } : {}),
                      title: binding.title,
                    }}
                    onRuntimeChange={(state) => reportRuntime(binding.sessionId, state)}
                    // 快速问答没有计划：相关 props 一律不传（计划条/审批卡就不会出现）
                    {...(selectedQuick
                      ? {}
                      : {
                          planMd: plans[selectedTask.id] ?? null,
                          planAutoOpen: phaseOf(selectedTask) === 'awaiting',
                          planFinished: Boolean(selectedTask.completedAt),
                          planApproved: Boolean(selectedTask.planApprovedAt),
                          agentSelfChecked: Boolean(selectedTask.agentCompletedAt),
                          onPlanApprove: () =>
                            updateTask(selectedTask.id, { planApprovedAt: Date.now() }),
                        })}
                    dock={
                      !selectedQuick &&
                      selectedTask &&
                      phaseOf(selectedTask) === 'awaiting' ? (
                        <WorkbenchReviewPanel
                          task={selectedTask}
                          planMd={plans[selectedTask.id] ?? null}
                          onApprove={() => completeTask(selectedTask.id, true)}
                          onReject={(reason) => {
                            updateTask(selectedTask.id, { agentCompletedAt: null });
                            // 退回必须把意见发回会话，否则 agent 完全不知道被打回
                            void dshSession
                              .prompt(binding.sessionId, buildRejectPrompt(reason))
                              .catch(() => undefined);
                          }}
                        />
                      ) : undefined
                    }
                  />
                </div>
              </>
            )}
          </div>
        )}
        {selectedTask && busy === 'open' && (
          <div className="ai00-x-task-scene__placeholder" role="status" aria-live="polite">
            <Loader2 size={16} className="ai00-x-task-scene__spin" />
            <span>{t('nav.workbenchWindow.tasks.preparing')}</span>
          </div>
        )}
        {selectedTask && !binding && busy !== 'open' && (
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
              <h1>{t('nav.workbenchWindow.tasks.newTaskTitle')}</h1>
              <p>{t('nav.workbenchWindow.tasks.newTaskHint')}</p>
            </div>
            <div className="ai00-x-task-scene__new-task-mode" role="radiogroup" aria-label={t('nav.workbenchWindow.tasks.modeLabel')}>
              {(['quick', 'delivery'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={executionMode === mode}
                  className={`ai00-x-task-scene__new-task-mode-option${executionMode === mode ? ' is-active' : ''}`}
                  onClick={() => setExecutionMode(mode)}
                >
                  {t(
                    mode === 'quick'
                      ? 'nav.workbenchWindow.tasks.modeQuick'
                      : 'nav.workbenchWindow.tasks.modeDelivery',
                  )}
                </button>
              ))}
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
              />
            </div>
            <p className="ai00-x-task-scene__new-task-flow">
              {executionMode === 'quick'
                ? t('nav.workbenchWindow.tasks.modeQuickHint')
                : t('nav.workbenchWindow.tasks.flowHint')}
            </p>
          </section>
        )}
        {!selectedTask && busy === 'create' && (
          <div className="ai00-x-task-scene__placeholder" role="status" aria-live="polite">
            <Loader2 size={16} className="ai00-x-task-scene__spin" />
            <span>{t('nav.workbenchWindow.tasks.preparing')}</span>
          </div>
        )}
      </main>

      <TrunkBranchDialog request={trunkRequest} onDecision={handleTrunkDecision} />
    </div>
  );
};

export default TaskScene;
