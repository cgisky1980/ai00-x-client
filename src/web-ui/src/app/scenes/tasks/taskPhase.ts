/**
 * taskPhase — 工作台任务技术状态推导（内部映射，不直接出 UI 文案）。
 *
 * UI 一律经 `workbenchStage.ts` 的 `stageOf()` / `stageKeyOf()` / `needsYou()` 呈现（规范 §9.2）。
 *
 * 状态真源全部是既有字段（不新增持久化状态）：
 * - 已完成 = `completedAt` 非空（人类验收通过）
 * - 待验收 = `agentCompletedAt` 非空且 `completedAt` 空（模型自检已提交）
 * - 出错   = 会话运行态 failed（见 workbenchTaskStore）
 * - 执行中 = 会话此刻确实在跑（引擎 session/list 的 running，或面板实时上报）
 * - 已停止 = 运行态已知且不在跑（回合结束/被打断/宿主重启），但还没自检
 * - 待批准 = 计划书已写好、还没被人类确认（唯一「等你动手」的规划态）
 * - 规划中 = 还没有计划书
 *
 * ★ 关键修正：有计划书 ≠ 执行中。以前只要读过计划书就显示「执行中」，
 *   导致早就停下的任务永远挂着「执行中」。现在以引擎运行态为准。
 */
import type { TodoTask } from '@/tools/todo/api/types';
import type { WorkbenchTaskRuntime } from './workbenchTaskStore';

export type TaskPhase =
  | 'planning'
  | 'approving'
  | 'running'
  | 'stopped'
  | 'awaiting'
  | 'done'
  | 'failed';

export function taskPhase(
  task: TodoTask,
  planMd: string | null,
  runtime?: WorkbenchTaskRuntime,
): TaskPhase {
  if (task.completedAt) return 'done';
  if (task.agentCompletedAt) return 'awaiting';
  // 在跑优先于出错：failed 是回合级历史状态（5s 回填会改 running、不清 failed），
  // 子代理仍在跑时回合报错不应把任务钉在「出错」。
  if (runtime?.running) return 'running';
  if (runtime?.failed) return 'failed';
  // 快速问答没有计划、也没有批准门：它只活在「执行」段里。
  // 以前落到「规划中」——列表上显示「计划」，可它压根没有计划可批（实测两条问答任务都这样）。
  if (task.executionMode === 'quick') return 'stopped';
  // 计划书已写好但没被人类确认：明确标「待批准」，让用户知道轮到自己了
  if (!task.planApprovedAt) {
    return planMd && planMd.trim() ? 'approving' : 'planning';
  }
  // 运行态已知且不在跑：有会话就是「已停止」，没有会话又没计划书才是「规划中」
  if (runtime) return task.agentSessionId || (planMd && planMd.trim()) ? 'stopped' : 'planning';
  // 运行态未知：没有会话的任务永远不可能在跑（引擎没这个会话），不能回落「执行中」，
  // 否则（历史数据/会话被清）卡片会永远挂「执行中」，也没有「继续执行」可点。
  if (!task.agentSessionId) return planMd && planMd.trim() ? 'stopped' : 'planning';
  // 有会话但快照还没回来（挂载后 5s 内）：暂时沿用「执行中」，避免首屏误报「已停止」。
  return planMd && planMd.trim() ? 'running' : 'planning';
}
