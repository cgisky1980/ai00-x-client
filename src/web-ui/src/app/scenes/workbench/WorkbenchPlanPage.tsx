/**
 * WorkbenchPlanPage — 工作台中间区的「计划首页」（任务 / 项目共用）。
 *
 * v0.23 起只是外壳：固定标题行 + 滚动区里一张 `WorkbenchPlanCard`（规范 §9.2）。
 * 计划、批准、执行进度、验收全部在卡片里，不再有平行视图。
 * compact 变体（看板抽屉）= 同一张卡的只读形态，保证批准 / 验收入口唯一。
 */
import React from 'react';
import type { TodoTask } from '@/tools/todo/api/types';
import { taskPhase } from '../tasks/taskPhase';
import { useWorkbenchTaskStore } from '../tasks/workbenchTaskStore';
import { WorkbenchPlanCard } from './WorkbenchPlanCard';
import './WorkbenchPlanPage.scss';

export interface WorkbenchPlanPageProps {
  task: TodoTask;
  planMd: string | null;
  /** 计划文件写回后的本地同步。 */
  onPlanChange?: (taskId: string, markdown: string) => void;
  /** 打开交付物：页面变体在中区开标签，抽屉变体弹预览窗。 */
  onOpenFile?: (path: string) => void;
  /** 标题行（页面变体传入任务/项目名 + 状态）。 */
  header?: React.ReactNode;
  /** 标题行右侧的额外入口。 */
  actions?: React.ReactNode;
  /** 会话正在运行（步骤状态显示「进行中」、规划中显示骨架）。 */
  running?: boolean;
  /** page = 工作台中区；compact = 看板抽屉内只读预览（默认 page）。 */
  variant?: 'page' | 'compact';
  /** 只读（已归档查看）：与 compact 同一条只读路径，保证入口唯一。 */
  readOnly?: boolean;
  /** 任务工作目录（验收记录里可一键打开，便于清理计划外文件）。 */
  cwd?: string | null;
}

export const WorkbenchPlanPage: React.FC<WorkbenchPlanPageProps> = ({
  task,
  planMd,
  onPlanChange,
  onOpenFile,
  header,
  actions,
  running = false,
  variant = 'page',
  readOnly = false,
  cwd = null,
}) => {
  const runtime = useWorkbenchTaskStore((s) =>
    task.agentSessionId ? s.runtime[task.agentSessionId] : undefined,
  );
  const phase = taskPhase(task, planMd, runtime);

  return (
    <div className={`ai00-x-plan-page is-${variant}`}>
      {header && (
        <header className="ai00-x-plan-page__head">
          <div className="ai00-x-plan-page__head-main">{header}</div>
          {actions && <div className="ai00-x-plan-page__head-actions">{actions}</div>}
        </header>
      )}
      <div className="ai00-x-plan-page__body">
        <WorkbenchPlanCard
          task={task}
          planMd={planMd}
          phase={phase}
          running={running}
          lastError={runtime?.lastError}
          cwd={cwd}
          onPlanChange={onPlanChange}
          onOpenFile={onOpenFile}
          readOnly={readOnly || variant === 'compact'}
        />
      </div>
    </div>
  );
};

export default WorkbenchPlanPage;
