/**
 * workbenchStage — 6 个技术状态到「计划 / 执行 / 审核」三阶段的归并。
 *
 * 与组件分开（Fast Refresh 要求组件文件只导出组件）。所有工作台共用这一份映射，
 * 避免任务场景、项目场景、插件工作台各写一套阶段判定。
 */
import type { TaskPhase } from '../tasks/taskPhase';

export type WorkbenchStage = 'plan' | 'execute' | 'review';

/** 阶段顺序（索引即进度）。 */
export const WORKBENCH_STAGES: WorkbenchStage[] = ['plan', 'execute', 'review'];

export type WorkbenchStageState = 'todo' | 'active' | 'done' | 'failed';

export function stageOf(phase: TaskPhase): { index: number; state: WorkbenchStageState } {
  switch (phase) {
    case 'planning':
    case 'approving':
      return { index: 0, state: 'active' };
    case 'running':
    case 'stopped':
      return { index: 1, state: 'active' };
    case 'awaiting':
      return { index: 2, state: 'active' };
    case 'failed':
      return { index: 1, state: 'failed' };
    case 'done':
      return { index: WORKBENCH_STAGES.length, state: 'done' };
  }
}
