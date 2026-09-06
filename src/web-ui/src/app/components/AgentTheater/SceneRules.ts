// ========================================================================
// 名场面规则（§4.1：6 规则 + 防误报 + 每 turn 单卡优先级）
// ========================================================================

import type { SceneRuleKey, TurnStats } from './theaterTypes';

/** 规则优先级：逆转 > 硬仗 > 多疑 > 苦力 > 深夜 > 闪电 */
const PRIORITY: SceneRuleKey[] = ['reversal', 'grind', 'ponderer', 'labor', 'late-night', 'lightning'];

/**
 * 结算一轮：返回命中的名场面规则（无命中返回 null —— 普通 turn 不产卡，稀缺性即价值）。
 * 防误报条件：
 * - 硬仗要求 toolCalls ≥ 10（排除挂机等审批的假时长）
 * - 闪电要求 toolCalls ≥ 3（排除空 turn）
 * - 深夜要求时长 > 5min（排除凌晨随手一发）
 * @param localHour 本地小时（0-23）；不传则从 now 推导（测试可显式注入）
 */
export function evaluateSceneRule(
  stats: TurnStats,
  now: number,
  localHour?: number,
): SceneRuleKey | null {
  const endedAt = stats.endedAt ?? now;
  const durationMs = Math.max(0, endedAt - stats.startedAt);
  const durationMin = durationMs / 60_000;
  const hour = localHour ?? new Date(now).getHours();

  if (stats.maxConsecutiveErrors >= 2 && stats.recoveredAfterError) return 'reversal';
  if (durationMin > 10 && stats.toolCalls >= 10) return 'grind';
  if (stats.thinkGapsOver90s >= 3) return 'ponderer';
  if (stats.toolCalls >= 50) return 'labor';
  if (hour >= 0 && hour < 5 && durationMin > 5) return 'late-night';
  if (durationMs < 20_000 && stats.errors === 0 && stats.toolCalls >= 3) return 'lightning';
  return null;
}

/** 优先级比较（多规则命中时取最高；当前实现逐条短路返回，此函数供测试与展示） */
export function higherPriorityRule(a: SceneRuleKey, b: SceneRuleKey): SceneRuleKey {
  return PRIORITY.indexOf(a) <= PRIORITY.indexOf(b) ? a : b;
}
