/**
 * noticeTitle — 通知里任务显示名的去歧义（同名卡补 id 尾缀）。
 *
 * 实测两张卡都叫「Ai00-X · 灵」，通知各写一遍同样的名字，人分不清该点哪一条
 * （「去查看」只会落到第一张）。这里把「名字怎么取、什么时候需要尾缀」收成一处：
 * 通知文案（单卡 / 合并条 / 首条提示）都用同一套规则。
 */
import type { TodoTask } from '../api/types';

/**
 * 同名任务卡在通知里的显示名。
 *
 * 重名时补 id 尾缀（`标题前 14 字·id 尾 3 位`，如 `Ai00-X · 灵·jzx`）。
 * `counts` 必须是**跨通知全局**的计数：两张同名卡可能落在「停住」和「失败」
 * 两个槽位里，只看单条通知自己的列表会以为名字唯一。
 */
export function notificationTitle(task: TodoTask, counts: Map<string, number>): string {
  const base = task.title.slice(0, 14);
  return (counts.get(base) ?? 0) > 1 ? `${base}·${task.id.slice(-3)}` : base;
}

/** 参与通知的任务名计数：已完成/归档的卡不会再出现在通知里，不应让活跃卡挂尾缀。 */
export function titleCounts(list: TodoTask[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of list) {
    if (task.completedAt || task.archivedAt) continue;
    const base = task.title.slice(0, 14);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return counts;
}

/**
 * 合并通知的刷新键：任务集合变了要重发，**显示名变了也要重发**。
 *
 * 重名尾缀取决于全局同名计数——另一张同名卡完成/归档后尾缀会消失；只按 id
 * 生成键的话，通知会永远停在旧名字上（同步器看到「键没变」直接 return）。
 */
export function mergedNoticeKey(list: TodoTask[], counts: Map<string, number>): string {
  return list
    .map((t) => `${t.id}:${notificationTitle(t, counts)}`)
    .sort()
    .join(',');
}
