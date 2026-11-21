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
  const base =
    executionMode === 'quick'
      ? '继续回答本任务的问题（快速问答模式：不写计划、不派子代理、不落文件）。若已有结论，用一两句话说明是否还有未回答的部分即可。'
      : planMd && planMd.trim()
        ? '继续执行本任务：按计划里第一个未勾选的步骤推进（先按 loop 契约派发并验证，再更新计划）。计划已全部完成时，汇报当前状态、剩余验收项与交付物路径，不要新建计划，也不要重写整份计划。'
        : '继续执行本任务：目前还没有计划。按 loop 契约先写计划，然后结束本轮等待用户确认——不要在写计划的同一轮派发任何 worker。';
  if (!lastError || !lastError.trim()) return base;
  return `${base}\n\n上一轮以错误收尾：${lastError.trim().slice(0, 300)}。先判断这个错误是否已经排除：若仍在，用一两句话说明需要人改什么（凭据 / 模型 / 环境），不要重复同样的失败调用；若已排除，直接从断点继续。`;
}

/**
 * 会话已在时补一条按计划续跑的消息（不重建会话、不改预设）。
 *
 * 停住的任务（客户端重启 / 回合被打断 / 出错后 / 回合结束没收口）以前只能靠人
 * 打一句话，白费一轮；现在通知上的「继续执行」也直接走这条。
 */
export async function continueTaskRun(
  task: Pick<TodoTask, 'id' | 'executionMode' | 'agentSessionId'>,
  planMd: string | null,
  lastError?: string,
): Promise<void> {
  const sessionId = task.agentSessionId;
  if (!sessionId) throw new Error('task has no agent session');
  await dshSession.prompt(sessionId, buildContinuePrompt(task.executionMode, planMd, lastError));
  useTodoStore.getState().updateTask(task.id, { status: 'doing' });
}
