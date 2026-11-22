/**
 * continueRun — 「继续执行」的续跑话术与动作（单一来源）。
 *
 * 计划卡按钮、任务列表 / 看板 / overlay 通知上的「继续执行」都走这里，
 * 避免措辞在多处各自漂移。放在 tools 层是因为 overlay（`TodoOverlay`）也要用，
 * 而它不该依赖 app 场景模块。
 */
import { dshSession } from '@/infrastructure/api/service-api/DshAPI';
import { useTodoStore } from '../store/todoStore';
import type { TodoTask } from '../api/types';

export interface PlanStepProgress {
  total: number;
  done: number;
  /** 第一个未勾选的步骤（含它上一次的验收是否失败）；没有未勾步骤时为 null。 */
  next: { id: string; title: string; lastFailed: boolean } | null;
}

/**
 * 计划里「## 步骤 / ## Steps」段的勾选进度。
 *
 * 只数步骤行（`- [ ] T1 …`），不数验收行：验收项常在自检时统一勾掉。
 * 没有步骤段 / 没有步骤行 → total 0（按「还没有可推进的步骤」处理）。
 *
 * 同时取**第一个未勾选步骤**及其 `验证: failed` 标记：续跑时点名步骤、并说明
 * 上一次没过，比一句「按第一个未勾选的步骤推进」更容易让模型直接修那一处。
 */
export function planStepProgress(planMd: string | null): PlanStepProgress {
  if (!planMd) return { total: 0, done: 0, next: null };
  let inSteps = false;
  let total = 0;
  let done = 0;
  let next: PlanStepProgress['next'] = null;
  let openUnchecked: { id: string; title: string; lastFailed: boolean } | null = null;
  const settle = () => {
    if (!next && openUnchecked) next = openUnchecked;
    openUnchecked = null;
  };
  for (const line of planMd.split('\n')) {
    if (/^##\s/.test(line)) {
      settle();
      inSteps = /^##\s*(步骤|Steps)/i.test(line);
      continue;
    }
    if (!inSteps) continue;
    const step = /^\s*-\s+\[([ xX])\]\s+(T[\w-]+)\s*(.*)$/.exec(line);
    if (step) {
      settle();
      total += 1;
      const checked = step[1].toLowerCase() === 'x';
      if (checked) done += 1;
      else openUnchecked = { id: step[2], title: step[3].trim().replace(/\s+/g, ' '), lastFailed: false };
      continue;
    }
    if (openUnchecked && /^\s*-\s*(验证|Verification)\s*[:：]\s*failed/i.test(line)) {
      openUnchecked.lastFailed = true;
    }
  }
  settle();
  return { total, done, next };
}

/**
 * 「步骤全勾选、但还没提交自检」时的收口话术。
 *
 * 计划卡的「让它提交自检」与外部「继续执行」共用这一份：以前卡上那句只要
 * `ai00_task_complete`，跳过了 verify 与 plan_check，等于让 agent 用一个没被
 * 复核过的验收去登记交付物。
 */
export const WRAP_UP_PROMPT =
  '本任务的计划步骤已经全部勾选，但还没有提交自检。请直接收口：① 调 ai00_task_verify（不带 stepId）跑整体验收；② 验收项还有未勾的用 ai00_plan_check 补勾（不通就修到通为止；已全勾则跳过）；③ 调 ai00_task_complete 登记交付物并汇报结果。不要新建计划，不要重写整份计划，也不要只汇报当前状态就结束。';

/**
 * 续跑话术。
 *
 * 提示词必须兼容「快速问答」会话：那类 preset 只挂了检索+通知，没有
 * ai00_plan_write / 工人 / verify（实测继续执行时模型正确地拒绝了假装写计划，
 * 但整轮就白跑了）。所以先看清会话真实工具面再决定让它做什么。
 *
 * `lastError` = 上一轮失败的原文（code + message）：失败后点「继续执行」时带上，
 * 让 agent 先判断「还犯不犯这个错」，而不是照原样再撞一遍。
 */
export function buildContinuePrompt(
  executionMode: TodoTask['executionMode'],
  planMd: string | null,
  lastError?: string,
): string {
  const progress = planStepProgress(planMd);
  const allStepsDone = progress.total > 0 && progress.done === progress.total;
  const nextStep = progress.next;
  const nextLabel = nextStep
    ? `${nextStep.id}「${nextStep.title.slice(0, 60) || '（无标题）'}」`
    : '计划里第一个未勾选的步骤';
  const base =
    executionMode === 'quick'
      ? '继续回答本任务的问题（快速问答模式：不写计划、不派子代理、不落文件）。若已有结论，用一两句话说明是否还有未回答的部分即可。'
      : planMd && planMd.trim()
        ? allStepsDone
          ? // 步骤全勾上却没自检 = 最常见的「停在执行段」：以前这里只说「汇报状态」，
            // agent 汇报完就停，永远走不到自检。现在明确要求走完收口三步。
            WRAP_UP_PROMPT
          : nextStep?.lastFailed
            ? // 点名失败的那一步：不说「第一个未勾选」，免得模型从别处重新铺一遍。
              `继续执行本任务：从 ${nextLabel}开始——该步骤上一次验收未通过（证据写在该步骤下的「验证」行），先修到验收命令通过、再用 ai00_plan_check 勾选，然后继续后面的步骤。计划已全部完成时，按收口流程提交自检（verify → plan_check → task_complete），不要新建计划，也不要重写整份计划。`
            : `继续执行本任务：从 ${nextLabel}开始推进（先按 loop 契约派发并验证，再更新计划）。计划已全部完成时，按收口流程提交自检（verify → plan_check → task_complete），不要新建计划，也不要重写整份计划。`
        : '继续执行本任务：目前还没有计划。按 loop 契约先写计划，然后结束本轮等待用户确认——不要在写计划的同一轮派发任何 worker。';
  if (!lastError || !lastError.trim()) return base;
  return `${base}\n\n上一轮以错误收尾：${lastError.trim().slice(0, 300)}。先判断这个错误是否已经排除：若仍在，用一两句话说明需要人改什么（凭据 / 模型 / 环境），不要重复同样的失败调用；若已排除，直接从断点继续。`;
}

/**
 * 任务绑定的会话已经不存在（引擎清理 / 换了数据目录）。
 *
 * 与「这一轮跑失败」区分开：那种情况重试有意义；会话没了怎么重试都送不到，
 * 必须先重置绑定、由卡片重新建会话。否则卡片会永久卡在「继续执行 → 失败」的死循环。
 */
export class SessionLostError extends Error {
  constructor() {
    super('任务会话已丢失（引擎清理或更换了数据目录），已重置绑定');
    this.name = 'SessionLostError';
  }
}

/**
 * 计划已写、但用户还没批准时的统一拦截文案。
 *
 * 批准闸口是工作台 loop 的硬约束（契约第 1 条：写计划后停机等确认）。外部触发、
 * 通知上的「继续执行」、会话丢失后的自动续跑都必须停在这里——它们只代表「有人
 * 想让它继续跑」，不代表「用户批准了这份计划」。
 */
export const PLAN_NOT_APPROVED_MESSAGE =
  '计划尚未批准——请先在计划卡上点「批准并执行」。外部触发与「继续执行」不会替你批准，也不会派发任何 worker。';

/**
 * 会话已在时补一条按计划续跑的消息（不重建会话、不改预设）。
 *
 * 停住的任务（客户端重启 / 回合被打断 / 出错后 / 回合结束没收口）以前只能靠人
 * 打一句话，白费一轮；现在通知上的「继续执行」也直接走这条。
 */
export async function continueTaskRun(
  task: Pick<TodoTask, 'id' | 'executionMode' | 'agentSessionId' | 'planApprovedAt'>,
  planMd: string | null,
  lastError?: string,
): Promise<void> {
  const sessionId = task.agentSessionId;
  if (!sessionId) throw new Error('task has no agent session');
  // 有计划但没批准 = 停在批准闸口前：续跑消息会被模型当成「开跑」指令，必须拦住。
  if (planMd && planMd.trim() && !task.planApprovedAt) {
    throw new Error(PLAN_NOT_APPROVED_MESSAGE);
  }
  try {
    await dshSession.prompt(sessionId, buildContinuePrompt(task.executionMode, planMd, lastError));
  } catch (e) {
    // 会话不存在 → 清掉绑定，让「打开卡片」按计划重建会话（TaskScene 的 resumable 分支）。
    const alive = await dshSession
      .list()
      .then(({ items }) => items.some((s) => s.sessionId === sessionId))
      .catch(() => true); // 列不出来时按「还活着」处理：别把可重试的失败误判成会话丢失
    if (!alive) {
      useTodoStore.getState().updateTask(task.id, { agentSessionId: undefined });
      throw new SessionLostError();
    }
    throw e;
  }
  useTodoStore.getState().updateTask(task.id, { status: 'doing' });
}
