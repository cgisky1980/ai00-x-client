// SceneRules 单测：6 规则 + 防误报 + 优先级（设计 §4.1）
import { describe, expect, it } from 'vitest';
import { evaluateSceneRule, higherPriorityRule } from './SceneRules';
import type { TurnStats } from './theaterTypes';

const base: TurnStats = {
  sessionId: 's1',
  turnId: 't1',
  startedAt: 0,
  taskLabel: 'x',
  toolCalls: 0,
  errors: 0,
  maxConsecutiveErrors: 0,
  consecutiveSuccesses: 0,
  recoveredAfterError: false,
  thinkGapsOver90s: 0,
};

describe('evaluateSceneRule', () => {
  it('逆转：maxConsecutiveErrors≥2 且恢复', () => {
    const s = { ...base, maxConsecutiveErrors: 2, recoveredAfterError: true, errors: 2 };
    expect(evaluateSceneRule(s, 1_000, 10)).toBe('reversal');
  });

  it('逆转不误报：只有错误无恢复', () => {
    const s = { ...base, maxConsecutiveErrors: 3, recoveredAfterError: false, errors: 3 };
    expect(evaluateSceneRule(s, 1_000, 10)).toBeNull();
  });

  it('硬仗：>10min 且 toolCalls≥10；挂机（0 次工具）不算', () => {
    const now = 11 * 60_000;
    expect(evaluateSceneRule({ ...base, toolCalls: 10 }, now, 10)).toBe('grind');
    expect(evaluateSceneRule(base, 30 * 60_000, 10)).toBeNull();
  });

  it('苦力：toolCalls≥50（时长仅 30s，不被硬仗截胡）', () => {
    const s = { ...base, toolCalls: 50, startedAt: 0 };
    expect(evaluateSceneRule(s, 30_000, 10)).toBe('labor');
  });

  it('多疑：3 次长思考', () => {
    expect(evaluateSceneRule({ ...base, thinkGapsOver90s: 3 }, 1_000, 10)).toBe('ponderer');
  });

  it('深夜：本地 0-5 点且 >5min', () => {
    const now = 6 * 60_000;
    expect(evaluateSceneRule({ ...base, toolCalls: 1 }, now, 2)).toBe('late-night');
    // 白天不算深夜
    expect(evaluateSceneRule({ ...base, toolCalls: 1 }, now, 10)).toBeNull();
  });

  it('闪电：<20s、无错误、≥3 工具；空 turn 不算', () => {
    expect(evaluateSceneRule({ ...base, toolCalls: 3 }, 15_000, 10)).toBe('lightning');
    expect(evaluateSceneRule(base, 15_000, 10)).toBeNull();
  });

  it('普通 turn 不产卡（稀缺性）', () => {
    expect(evaluateSceneRule({ ...base, toolCalls: 8 }, 3 * 60_000, 10)).toBeNull();
  });

  it('优先级：逆转 > 硬仗 > 多疑 > 苦力 > 深夜 > 闪电', () => {
    expect(higherPriorityRule('reversal', 'grind')).toBe('reversal');
    expect(higherPriorityRule('labor', 'late-night')).toBe('labor');
    expect(higherPriorityRule('lightning', 'ponderer')).toBe('ponderer');
  });
});
