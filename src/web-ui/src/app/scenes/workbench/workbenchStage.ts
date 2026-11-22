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

/** UI 上唯一的状态词汇：三阶段 + 完成（规范 §9.2）。 */
export type WorkbenchStageKey = WorkbenchStage | 'done';

/** 看板列 = 三阶段 + 完成。 */
export const WORKBENCH_STAGE_KEYS: WorkbenchStageKey[] = [...WORKBENCH_STAGES, 'done'];

export function stageKeyOf(phase: TaskPhase): WorkbenchStageKey {
  const { index } = stageOf(phase);
  return WORKBENCH_STAGES[index] ?? 'done';
}

/**
 * 「需要你」：轮到人类动手的情形——待批准、待验收、agent 正在提问，
 * 以及**执行失败待处理**（额度/凭据/模型修好后点「已修好，重试」；
 * 列出失败但不标「需要你」时，列表上只看得到「执行」，没人知道在等谁）。
 * 提问只在面板打开过时可知（运行态 `asking`）。
 */
export function needsYou(phase: TaskPhase, asking = false): boolean {
  return asking || phase === 'approving' || phase === 'awaiting' || phase === 'failed';
}
