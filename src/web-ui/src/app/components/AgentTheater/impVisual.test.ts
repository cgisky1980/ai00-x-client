// impVisual 单测：确定性 / 分类器 / 配色边界（设计 §3.4 + §7）
import { describe, expect, it } from 'vitest';
import {
  classifyAgent,
  generateImpAppearance,
  hashString,
  IMP_PALETTE,
  mulberry32,
} from './impVisualCore';

describe('确定性', () => {
  it('同 sessionId 恒定同形象', () => {
    const a = generateImpAppearance('session-abc', 'coding');
    const b = generateImpAppearance('session-abc', 'coding');
    expect(a).toEqual(b);
  });

  it('不同 sessionId 形象不同（高概率）', () => {
    const a = generateImpAppearance('session-1', 'general');
    const b = generateImpAppearance('session-2', 'general');
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('hash 与随机数本身确定', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(mulberry32(42)()).toBe(mulberry32(42)());
  });
});

describe('分类器', () => {
  it('关键词命中（中英）', () => {
    expect(classifyAgent('修复登录页 bug')).toBe('debugging');
    expect(classifyAgent('Fix the failing test')).toBe('debugging');
    expect(classifyAgent('重构 ImpManager 模块')).toBe('coding');
    expect(classifyAgent('调研一下 WebSocket 重连方案')).toBe('research');
    expect(classifyAgent('写一篇 README 文档')).toBe('writing');
  });

  it('研究类工具构成兜底', () => {
    expect(classifyAgent('', ['WebSearch', 'Read'])).toBe('research');
    expect(classifyAgent('', ['Bash', 'WebSearch'])).toBe('general');
  });

  it('未识别 → general', () => {
    expect(classifyAgent('随便看看')).toBe('general');
  });
});

describe('形象边界', () => {
  it('配色只取 token 集合内', () => {
    for (let i = 0; i < 50; i++) {
      const app = generateImpAppearance(`s${i}`, 'general');
      expect(IMP_PALETTE).toContain(app.accent);
    }
  });

  it('部件索引在合法范围', () => {
    for (let i = 0; i < 50; i++) {
      const app = generateImpAppearance(`x${i}`, 'coding');
      expect([0, 1, 2]).toContain(app.eyeStyle);
      expect([0, 1, 2]).toContain(app.antennaStyle);
      expect([0, 1, 2]).toContain(app.patternStyle);
      expect([0, 1, 2, 3]).toContain(app.gadget);
    }
  });
});
