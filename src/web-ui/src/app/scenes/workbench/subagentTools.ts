/**
 * 子代理派发识别：worker 工具调用与其结果回执的解析。
 *
 * 独立成模块（不是组件文件），供子代理卡与工作台对话共用；
 * 规则只依赖既有工具名/结果文案，不新增协议。
 */
import type { DshToolCallView } from '@/infrastructure/api/service-api/DshAPI';

/** 引擎 worker 工具的结果回执：`started subagent <childSessionId>`。 */
const STARTED_SUBAGENT = /^started subagent\s+(\S+)/i;

/** 从工具结果里取子代理会话 id（还没有结果时返回 null）。 */
export function startedSubagentId(result: string | undefined): string | null {
  if (!result) return null;
  return result.trim().match(STARTED_SUBAGENT)?.[1] ?? null;
}

/** 这个工具调用是不是「派发子代理」（结果回执优先，其次按工具名判断）。 */
export function isSubagentDispatch(call: DshToolCallView): boolean {
  if (startedSubagentId(call.result)) return true;
  return /(^|_)(sub)?agent\b|_worker$/i.test(call.name);
}

/** 子代理耗时展示（`3m 20s` / `45s`）。 */
export function formatSubagentDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
