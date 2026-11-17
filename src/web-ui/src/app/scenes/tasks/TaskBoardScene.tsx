/**
 * TaskBoardScene — 工作台任务五态总览；详情与验收复用 TaskDetail。
 * 只列 origin='workbench'，与策任务展示/归属保持隔离。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { TodoTask } from '@/tools/todo/api/types';
import { useTodoStore } from '@/tools/todo/store/todoStore';
import { TASK_PHASES, taskPhase, type TaskPhase } from './taskPhase';
import TaskDetail from './TaskDetail';
import { TaskActionsMenu } from './TaskActionsMenu';
import { useTaskPlans } from './useTaskPlans';
import { useSessionRunningSync } from './useSessionRunningSync';
import { useWorkbenchTaskStore } from './workbenchTaskStore';
import { WorkbenchStageDots } from '../workbench/WorkbenchStageBar';
import './TaskBoardScene.scss';

/** 看板场景在 rail 中的保留 id。 */
export const BOARD_SCENE_ID = '@board';

interface TaskBoardSceneProps {
  /** 在「任务」场景打开该任务（场景内 state 交接，不走 windowBus）。 */
  onOpenTask: (taskId: string) => void;
}

export const TaskBoardScene: React.FC<TaskBoardSceneProps> = ({ onOpenTask }) => {
  const { t } = useI18n('common');
  const loaded = useTodoStore((s) => s.loaded);
  const load = useTodoStore((s) => s.load);
  const allTasks = useTodoStore((s) => s.data.tasks);
  const projects = useTodoStore((s) => s.data.projects);
  const runtime = useWorkbenchTaskStore((s) => s.runtime);
  // 引擎会话运行态校准（没打开过的任务也能落到「已停止」）
  useSessionRunningSync();
  /** 全部 / 默认工作区（空串）/ 某项目 id。 */
  const [projectFilter, setProjectFilter] = useState<string>('all');

  const workbenchTasks = useMemo(
    () => allTasks.filter((task) => task.origin === 'workbench' && !task.archivedAt),
    [allTasks],
  );

  const tasks = useMemo(
    () =>
      workbenchTasks
        .filter((task) => {
          if (projectFilter === 'all') return true;
          if (projectFilter === '') return !task.projectId;
          return task.projectId === projectFilter;
        })
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [projectFilter, workbenchTasks],
  );
  const { plans, setPlan } = useTaskPlans(tasks);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const grouped = useMemo(() => {
    const map: Record<TaskPhase, TodoTask[]> = {
      planning: [],
      approving: [],
      running: [],
      stopped: [],
      awaiting: [],
      done: [],
      failed: [],
    };
    for (const task of tasks) {
      const state = task.agentSessionId ? runtime[task.agentSessionId] : undefined;
      map[taskPhase(task, plans[task.id] ?? null, state)].push(task);
    }
    map.done = map.done.slice(0, 20);
    return map;
  }, [tasks, plans, runtime]);

  const selected = tasks.find((task) => task.id === selectedId) ?? null;

  const renderCard = (task: TodoTask): React.ReactNode => {
    const md = plans[task.id] ?? null;
    const isSelected = task.id === selectedId;
    return (
      <button
        key={task.id}
        type="button"
        className={`ai00-x-task-board__card${isSelected ? ' is-active' : ''}`}
        onClick={() => setSelectedId(task.id)}
      >
        <span className="ai00-x-task-board__card-title">{task.title}</span>
        {md && md.trim() && (
          <span className="ai00-x-task-board__card-meta">
            {t('nav.workbenchWindow.board.hasPlan')}
          </span>
        )}
        {task.projectId && (
          <span className="ai00-x-task-board__card-source">
            {projects.find((p) => p.id === task.projectId)?.name ?? t('nav.workbenchWindow.projects.rail')}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="ai00-x-task-board">
      {projects.length > 0 && (
        <div className="ai00-x-task-board__filter">
          <span>{t('nav.workbenchWindow.board.filterLabel')}</span>
          <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="all">{t('nav.workbenchWindow.board.filterAll')}</option>
            <option value="">{t('nav.workbenchWindow.automations.defaultWorkspace')}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="ai00-x-task-board__body">
      <div className="ai00-x-task-board__columns">
        {TASK_PHASES.map((phase) => (
          <section key={phase} className="ai00-x-task-board__column">
            <header className="ai00-x-task-board__column-head">
              <WorkbenchStageDots phase={phase} />
              <span className="ai00-x-task-board__column-label">
                {t(`nav.workbenchWindow.board.phases.${phase}`)}
              </span>
              <span className="ai00-x-task-board__count">{grouped[phase].length}</span>
            </header>
            <div className="ai00-x-task-board__cards">
              {grouped[phase].map(renderCard)}
              {grouped[phase].length === 0 && (
                <p className="ai00-x-task-board__column-empty">
                  {t('nav.workbenchWindow.board.columnEmpty')}
                </p>
              )}
            </div>
          </section>
        ))}
      </div>

      <aside className="ai00-x-task-board__detail">
        {!selected ? (
          <div className="ai00-x-task-board__placeholder">
            <p>{t('nav.workbenchWindow.board.noSelection')}</p>
          </div>
        ) : (
          <>
            <header className="ai00-x-task-board__detail-head">
              <h2 className="ai00-x-task-board__detail-title">{selected.title}</h2>
              <TaskActionsMenu
                task={selected}
                onArchived={() => setSelectedId(null)}
                onDeleted={() => setSelectedId(null)}
              />
              <button
                type="button"
                className="ai00-x-task-board__button"
                onClick={() => onOpenTask(selected.id)}
              >
                <ExternalLink size={11} />
                {t('nav.workbenchWindow.board.openInTasks')}
              </button>
            </header>
            <TaskDetail
              task={selected}
              planMd={plans[selected.id] ?? null}
              onPlanChange={setPlan}
            />
          </>
        )}
      </aside>
      </div>
    </div>
  );
};

export default TaskBoardScene;
