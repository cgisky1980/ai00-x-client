/**
 * taskProgress — 任务进度（所有工作台共用）。
 *
 * 真源是计划文档：步骤 checkbox 与验收 checkbox。两者都可能尚未生成（规划中），
 * 此时返回 hasPlan=false，调用方回退到「阶段」表述，不要编造百分比。
 */
import { parseAcceptance, parseStepItems } from '@/tools/todo/utils/planAcceptance';

export interface TaskProgress {
  /** 计划文档里是否有可统计的条目。 */
  hasPlan: boolean;
  stepsDone: number;
  stepsTotal: number;
  acceptanceDone: number;
  acceptanceTotal: number;
  /** 0–100；优先按步骤算，其次按验收。 */
  percent: number;
}

export const EMPTY_PROGRESS: TaskProgress = {
  hasPlan: false,
  stepsDone: 0,
  stepsTotal: 0,
  acceptanceDone: 0,
  acceptanceTotal: 0,
  percent: 0,
};

export function taskProgress(planMd: string | null | undefined): TaskProgress {
  if (!planMd) return EMPTY_PROGRESS;
  const steps = parseStepItems(planMd);
  const acceptance = parseAcceptance(planMd);
  const stepsDone = steps.filter((s) => s.done).length;
  const acceptanceDone = acceptance.filter((a) => a.done).length;

  let percent = 0;
  if (steps.length > 0) percent = Math.round((stepsDone / steps.length) * 100);
  else if (acceptance.length > 0) {
    percent = Math.round((acceptanceDone / acceptance.length) * 100);
  }

  return {
    hasPlan: steps.length > 0 || acceptance.length > 0,
    stepsDone,
    stepsTotal: steps.length,
    acceptanceDone,
    acceptanceTotal: acceptance.length,
    percent,
  };
}
