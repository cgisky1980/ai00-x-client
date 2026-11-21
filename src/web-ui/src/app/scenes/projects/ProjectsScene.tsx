/**
 * ProjectsScene — 项目工作台：用户指定的已有目录（工作区）。
 *
 * 与「任务」工作台的分工：
 * - 项目：任务共享用户目录，Agent 直接读写真实工程（宿主不建目录、不写文件）；
 * - 任务：默认工作区，每个任务一个独立目录。
 *
 * 两种模式：
 * - 概览：项目清单 + 项目头 + 新任务输入框 + 最近任务；
 * - 对话：在本场景内直接进入该项目的任务会话（不跳到「任务」工作台）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, FolderOpen, FolderPlus, Loader2, Trash2 } from 'lucide-react';
import { Switch } from '@/component-library';
import { AgentComposer } from '@/app/components/ai/AgentComposer';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { pickWorkspaceDir } from '@/tools/todo/ai/workspace';
import type { TodoTask, WorkbenchProject } from '@/tools/todo/api/types';
import { useTodoStore } from '@/tools/todo/store/todoStore';
import { createTask, ensureTaskSession, taskTitleFromRequest } from '../tasks/taskSession';
import { useWorkbenchTaskStore } from '../tasks/workbenchTaskStore';
import { TaskActionsMenu } from '../tasks/TaskActionsMenu';
import { useTaskPlans } from '../tasks/useTaskPlans';
import { TrunkBranchDialog, type TrunkBranchRequest } from '../tasks/TrunkBranchDialog';
import { taskPhase } from '../tasks/taskPhase';
import { useSessionRunningSync } from '../tasks/useSessionRunningSync';
import { dirTail, relativeTime } from '../tasks/display';
import { WorkbenchStageDots, WorkbenchStatusTag } from '../workbench/WorkbenchStageBar';
import { needsYou } from '../workbench/workbenchStage';
import { WorkbenchTaskHost } from '../workbench/WorkbenchTaskHost';
import { ProjectGitBadge } from './ProjectGitBadge';
import {
  TrunkBranchError,
  WorktreeUnavailableError,
  createTaskBranch,
  type TrunkDecision,
} from './projectGit';
import './ProjectsScene.scss';

/** 项目工作台在 rail 中的保留 id。 */
export const PROJECTS_SCENE_ID = '@projects';

/** 场景内在聊的任务会话。 */
interface ActiveConversation {
  task: TodoTask;
  sessionId: string;
  cwd: string;
}

export interface ProjectsSceneProps {
  /** 「需要你」通知定位过来的任务（跨场景交接，不走 windowBus）。 */
  focusTaskId?: string | null;
  /** 定位已处理（宿主清掉交接值，避免切换场景时重复打开）。 */
  onFocusHandled?: () => void;
}

export const ProjectsScene: React.FC<ProjectsSceneProps> = ({
  focusTaskId = null,
  onFocusHandled,
}) => {
  const { t } = useI18n('common');
  const loaded = useTodoStore((s) => s.loaded);
  const load = useTodoStore((s) => s.load);
  const projects = useTodoStore((s) => s.data.projects);
  const allTasks = useTodoStore((s) => s.data.tasks);
  const createProject = useTodoStore((s) => s.createProject);
  const removeProject = useTodoStore((s) => s.removeProject);
  const updateProject = useTodoStore((s) => s.updateProject);
  const runtime = useWorkbenchTaskStore((s) => s.runtime);
  // 引擎会话运行态校准（最近任务的「执行中/已停止」以真实运行态为准）
  useSessionRunningSync();
  /** 计划书（中央计划页展示步骤与验收）。 */
  const { plans, setPlan } = useTaskPlans(allTasks);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 侧栏展开的项目（每个项目下面直接列它的任务）。 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  /** 新任务空态预选的模型（建会话后落到该会话）。 */
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'open' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 场景内对话（null = 概览）。 */
  const [conversation, setConversation] = useState<ActiveConversation | null>(null);
  /** 主干分支守卫：等用户决定「开分支 / 照旧 / 取消」。 */
  const [trunkRequest, setTrunkRequest] = useState<TrunkBranchRequest | null>(null);
  /** 守卫拦下时暂存的任务/项目/模型，答复后据此重入。 */
  const trunkPendingRef = useRef<{
    task: TodoTask;
    project: WorkbenchProject;
    model: string | null;
  } | null>(null);
  /** 旧 Promise 不得回写新选中/新对话。 */
  const openTokenRef = useRef(0);
  /** 侧栏里点了别的项目的任务：切项目后（下一帧）再打开它。 */
  const pendingOpenRef = useRef<string | null>(null);
  const allTasksRef = useRef(allTasks);
  allTasksRef.current = allTasks;

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const selected = projects.find((p) => p.id === selectedId) ?? projects[0] ?? null;

  /** 每个项目下的任务（侧栏树 + 概览最近任务共用同一过滤）。 */
  const tasksByProject = useMemo(() => {
    const map = new Map<string, TodoTask[]>();
    for (const task of allTasks) {
      if (task.origin !== 'workbench' || !task.projectId || task.archivedAt) continue;
      const list = map.get(task.projectId) ?? [];
      list.push(task);
      map.set(task.projectId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    return map;
  }, [allTasks]);

  const projectTasks = useMemo(
    () => (selected ? (tasksByProject.get(selected.id) ?? []) : []),
    [selected, tasksByProject],
  );

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const openProject = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const dir = await pickWorkspaceDir();
      if (!dir) return;
      const project = createProject({ dir });
      setSelectedId(project.id);
    } catch (e) {
      setError(message(e));
    }
  }, [createProject]);

  /** 在本场景打开任务会话：没有会话就现建（建完发首轮任务书）。 */
  const openConversation = useCallback(
    async (
      task: TodoTask,
      project: WorkbenchProject,
      preferredModel: string | null,
      allowTrunk = false,
    ): Promise<void> => {
      const token = ++openTokenRef.current;
      setError(null);
      setBusy('open');
      try {
        const bound = await ensureTaskSession(
          task,
          t('nav.workbenchWindow.tasks.title'),
          project,
          preferredModel,
          { allowTrunk },
        );
        if (token !== openTokenRef.current) return;
        setConversation({ task, sessionId: bound.sessionId, cwd: bound.cwd });
      } catch (e) {
        if (token !== openTokenRef.current) return;
        if (e instanceof TrunkBranchError) {
          // 守卫拦下：等用户在弹窗里选「开分支 / 照旧 / 取消」
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
    [t],
  );

  /**
   * 主干分支守卫的答复：开分支 → 建 `ai00/<slug>` 后重入；照旧 → allowTrunk 重入。
   * 待办任务来自 `trunkPendingRef`（弹窗只负责展示 branch/标题）。
   */
  const handleTrunkDecision = useCallback(
    (decision: TrunkDecision): void => {
      const pending = trunkPendingRef.current;
      trunkPendingRef.current = null;
      setTrunkRequest(null);
      if (!pending || decision === 'cancel') return;
      void (async () => {
        try {
          if (decision === 'branch') {
            await createTaskBranch(pending.project.dir, pending.task.title, pending.task.id);
          }
          await openConversation(pending.task, pending.project, pending.model, true);
        } catch (e) {
          setError(message(e));
        }
      })();
    },
    [openConversation],
  );

  // 切换项目/移除项目 → 回到概览（避免看到别的项目的会话）。
  // 若这次切换来自「侧栏点了别的项目的任务」，切换完成后直接打开该任务。
  useEffect(() => {
    openTokenRef.current += 1;
    setDraft('');
    setError(null);
    setBusy(null);
    setConversation(null);
    setTrunkRequest(null);
    trunkPendingRef.current = null;
    const pendingTaskId = pendingOpenRef.current;
    pendingOpenRef.current = null;
    if (!pendingTaskId || !selected) return;
    const task = allTasksRef.current.find(
      (item) => item.id === pendingTaskId && !item.archivedAt,
    );
    if (task) void openConversation(task, selected, null);
    // 只在项目切换时触发；任务/回调走 ref 与稳定回调
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  /** 侧栏树上点任务：同项目直接开，跨项目先切项目（由上面的 effect 接着开）。 */
  const openFromTree = useCallback(
    (project: WorkbenchProject, task: TodoTask): void => {
      if (project.id !== selected?.id) {
        pendingOpenRef.current = task.id;
        setSelectedId(project.id);
        return;
      }
      void openConversation(task, project, null);
    },
    [openConversation, selected?.id],
  );

  /**
   * 「需要你」通知定位：切到任务所属项目并打开它的会话。
   * 同一 taskId 只处理一次；任务/项目尚未加载时不标记已处理，等数据到位再重试。
   */
  const focusHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusTaskId || focusHandledRef.current === focusTaskId) return;
    const task = allTasks.find((item) => item.id === focusTaskId);
    if (!task) return;
    const project = projects.find((p) => p.id === task.projectId);
    if (!project) return;
    focusHandledRef.current = focusTaskId;
    onFocusHandled?.();
    if (project.id !== selected?.id) {
      // 跨项目：交给「切换项目」的 effect 接着打开
      pendingOpenRef.current = task.id;
      setSelectedId(project.id);
      return;
    }
    void openConversation(task, project, null);
  }, [focusTaskId, allTasks, projects, selected?.id, openConversation, onFocusHandled]);

  const toggleExpanded = useCallback((projectId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  // 选中项目默认展开（用户手动收起后不再强行展开）
  useEffect(() => {
    if (!selected?.id) return;
    setExpanded((prev) => (prev.has(selected.id) ? prev : new Set(prev).add(selected.id)));
  }, [selected?.id]);

  /** 一句需求 = 一张卡 + 一个会话 + 一条首轮任务书；**留在项目工作台**对话。 */
  const startTask = useCallback(async (): Promise<void> => {
    const request = draft.trim();
    if (!request || !selected || busy) return;
    const token = ++openTokenRef.current;
    setBusy('create');
    setError(null);
    try {
      const task = await createTask(taskTitleFromRequest(request), request, selected.id);
      if (token !== openTokenRef.current) return;
      setDraft('');
      const model = pendingModel;
      setPendingModel(null);
      setBusy(null);
      await openConversation(task, selected, model);
    } catch (e) {
      if (token === openTokenRef.current) {
        setBusy(null);
        setError(t('nav.workbenchWindow.tasks.openFailed', { message: message(e) }));
      }
    }
  }, [busy, draft, openConversation, pendingModel, selected, t]);

  const revealProject = useCallback((project: WorkbenchProject): void => {
    void workspaceAPI.revealInExplorer(project.dir).catch(() => undefined);
  }, []);

  const backToOverview = useCallback((): void => {
    openTokenRef.current += 1;
    setConversation(null);
    setBusy(null);
  }, []);

  return (
    <div className="ai00-x-projects-scene">
      <aside className="ai00-x-projects-scene__list">
        <div className="ai00-x-projects-scene__list-head">
          <span className="ai00-x-projects-scene__list-title">
            {t('nav.workbenchWindow.projects.title')}
          </span>
          <button
            type="button"
            className="ai00-x-projects-scene__icon-button"
            onClick={() => void openProject()}
            title={t('nav.workbenchWindow.projects.open')}
            aria-label={t('nav.workbenchWindow.projects.open')}
          >
            <FolderPlus size={14} />
          </button>
        </div>

        <div className="ai00-x-projects-scene__items">
          {projects.map((project) => {
            const items = tasksByProject.get(project.id) ?? [];
            const open = expanded.has(project.id);
            /** 该项目下有几个任务在等人（待批准 / 待验收 / 正在提问）：折叠时也要能看见。 */
            const needsYouCount = items.filter((task) =>
              needsYou(
                taskPhase(
                  task,
                  null,
                  task.agentSessionId ? runtime[task.agentSessionId] : undefined,
                ),
                Boolean(task.agentSessionId && runtime[task.agentSessionId]?.asking),
              ),
            ).length;
            return (
              <div key={project.id} className="ai00-x-projects-scene__group">
                <div
                  className={`ai00-x-projects-scene__item${
                    project.id === selected?.id ? ' is-active' : ''
                  }`}
                >
                  <button
                    type="button"
                    className={`ai00-x-projects-scene__caret${open ? ' is-open' : ''}`}
                    onClick={() => toggleExpanded(project.id)}
                    aria-expanded={open}
                    aria-label={t(
                      open
                        ? 'nav.workbenchWindow.projects.collapse'
                        : 'nav.workbenchWindow.projects.expand',
                    )}
                    title={t(
                      open
                        ? 'nav.workbenchWindow.projects.collapse'
                        : 'nav.workbenchWindow.projects.expand',
                    )}
                  >
                    <ChevronRight size={12} />
                  </button>
                  <button
                    type="button"
                    className="ai00-x-projects-scene__item-main"
                    aria-current={project.id === selected?.id ? 'true' : undefined}
                    onClick={() => setSelectedId(project.id)}
                    title={project.dir}
                  >
                    <span className="ai00-x-projects-scene__item-title">{project.name}</span>
                  </button>
                  {needsYouCount > 0 && (
                    <span
                      className="ai00-x-status-tag ai00-x-projects-scene__needs"
                      title={t('nav.workbenchWindow.projects.needsYouCount', {
                        count: needsYouCount,
                      })}
                    >
                      <span className="ai00-x-status-tag__needs">
                        {t('nav.workbenchWindow.stages.needsYou')}
                      </span>
                    </span>
                  )}
                  <ProjectGitBadge dir={project.dir} onError={setError} />
                </div>

                {open && (
                  <div className="ai00-x-projects-scene__subitems">
                    {items.length === 0 ? (
                      <p className="ai00-x-projects-scene__subempty">
                        {t('nav.workbenchWindow.projects.noTasks')}
                      </p>
                    ) : (
                      items.map((task) => (
                        <div
                          key={task.id}
                          className={`ai00-x-projects-scene__subitem-row${
                            conversation?.task.id === task.id ? ' is-active' : ''
                          }`}
                        >
                          <button
                            type="button"
                            className="ai00-x-projects-scene__subitem"
                            onClick={() => openFromTree(project, task)}
                            title={task.title}
                          >
                            <span className="ai00-x-projects-scene__subitem-title">
                              {task.title}
                            </span>
                            <WorkbenchStageDots
                              phase={taskPhase(
                                task,
                                null,
                                task.agentSessionId ? runtime[task.agentSessionId] : undefined,
                              )}
                            />
                          </button>
                          <TaskActionsMenu
                            task={task}
                            onArchived={() => {
                              if (conversation?.task.id === task.id) backToOverview();
                            }}
                            onDeleted={() => {
                              if (conversation?.task.id === task.id) backToOverview();
                            }}
                          />
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {projects.length === 0 && (
            <p className="ai00-x-projects-scene__empty">{t('nav.workbenchWindow.projects.empty')}</p>
          )}
        </div>
      </aside>

      <main
        className={`ai00-x-projects-scene__main${
          conversation ? ' is-conversation' : ''
        }`}
      >
        {!selected ? (
          <section className="ai00-x-projects-scene__welcome">
            <h1>{t('nav.workbenchWindow.projects.welcomeTitle')}</h1>
            <p>{t('nav.workbenchWindow.projects.welcomeHint')}</p>
            <button
              type="button"
              className="ai00-x-projects-scene__primary"
              onClick={() => void openProject()}
            >
              <FolderPlus size={14} />
              {t('nav.workbenchWindow.projects.open')}
            </button>
          </section>
        ) : conversation ? (
          <WorkbenchTaskHost
            key={conversation.task.id}
            task={allTasks.find((item) => item.id === conversation.task.id) ?? conversation.task}
            sessionId={conversation.sessionId}
            cwd={conversation.cwd}
            planMd={plans[conversation.task.id] ?? null}
            onPlanChange={setPlan}
            error={error}
            title={
              <>
                <button
                  type="button"
                  className="ai00-x-projects-scene__back"
                  onClick={backToOverview}
                  title={t('nav.workbenchWindow.projects.back')}
                  aria-label={t('nav.workbenchWindow.projects.back')}
                >
                  <ArrowLeft size={14} />
                </button>
                <h1 className="ai00-x-projects-scene__title">{conversation.task.title}</h1>
                <span className="ai00-x-projects-scene__dir" title={selected.dir}>
                  {selected.name}
                </span>
              </>
            }
          />
        ) : (
          <>
            <header className="ai00-x-projects-scene__head">
              <h1 className="ai00-x-projects-scene__title">{selected.name}</h1>
              <span className="ai00-x-projects-scene__dir" title={selected.dir}>
                {dirTail(selected.dir)}
              </span>
              <Switch
                size="small"
                checked={Boolean(selected.isolate)}
                onChange={(event) =>
                  updateProject(selected.id, { isolate: event.target.checked })
                }
                label={t('nav.workbenchWindow.projects.isolate')}
                title={t('nav.workbenchWindow.projects.isolateHint')}
              />
              {selected.isolate && (
                <Switch
                  size="small"
                  checked={Boolean(selected.autoDeps)}
                  onChange={(event) =>
                    updateProject(selected.id, { autoDeps: event.target.checked })
                  }
                  label={t('nav.workbenchWindow.projects.autoDeps')}
                  title={t('nav.workbenchWindow.projects.autoDepsHint')}
                />
              )}
              <button
                type="button"
                className="ai00-x-projects-scene__icon-button"
                onClick={() => revealProject(selected)}
                title={t('nav.workbenchWindow.projects.reveal')}
                aria-label={t('nav.workbenchWindow.projects.reveal')}
              >
                <FolderOpen size={14} />
              </button>
              <button
                type="button"
                className="ai00-x-projects-scene__icon-button"
                onClick={() => removeProject(selected.id)}
                title={t('nav.workbenchWindow.projects.remove')}
                aria-label={t('nav.workbenchWindow.projects.remove')}
              >
                <Trash2 size={14} />
              </button>
            </header>

            {error && (
              <p className="ai00-x-projects-scene__error" role="alert">
                {error}
              </p>
            )}

            <div className="ai00-x-projects-scene__composer">
              <AgentComposer
                value={draft}
                onChange={setDraft}
                onSubmit={() => void startTask()}
                loading={busy !== null}
                placeholder={t('nav.workbenchWindow.projects.taskPlaceholder')}
                mentionRoot={selected.dir}
                pendingModelRef={pendingModel}
                onPendingModelChange={setPendingModel}
              />
            </div>

            {busy && (
              <p className="ai00-x-projects-scene__preparing" role="status" aria-live="polite">
                <Loader2 size={14} className="ai00-x-projects-scene__spin" />
                {t('nav.workbenchWindow.tasks.preparing')}
              </p>
            )}

            <section className="ai00-x-projects-scene__tasks">
              <h2 className="ai00-x-projects-scene__section-title">
                {t('nav.workbenchWindow.projects.recentTasks')}
              </h2>
              {projectTasks.length === 0 ? (
                <p className="ai00-x-projects-scene__section-empty">
                  {t('nav.workbenchWindow.projects.noTasks')}
                </p>
              ) : (
                projectTasks.slice(0, 20).map((task) => (
                  <div key={task.id} className="ai00-x-projects-scene__task-row">
                    <button
                      type="button"
                      className="ai00-x-projects-scene__task"
                      onClick={() => void openConversation(task, selected, null)}
                    >
                      <span className="ai00-x-projects-scene__task-title">{task.title}</span>
                      <WorkbenchStatusTag
                        className="ai00-x-projects-scene__task-meta"
                        phase={taskPhase(
                          task,
                          null,
                          task.agentSessionId ? runtime[task.agentSessionId] : undefined,
                        )}
                        asking={Boolean(task.agentSessionId && runtime[task.agentSessionId]?.asking)}
                        quick={task.executionMode === 'quick'}
                      />
                      <span className="ai00-x-projects-scene__task-time">
                        {relativeTime(task.createdAt)}
                      </span>
                    </button>
                    <TaskActionsMenu task={task} />
                  </div>
                ))
              )}
            </section>
          </>
        )}
      </main>

      <TrunkBranchDialog request={trunkRequest} onDecision={handleTrunkDecision} />
    </div>
  );
};

export default ProjectsScene;
