// ========================================================================
// 工灵形象生成（§3.4：分类模板 + sessionId 种子随机）
// ========================================================================
// 纯逻辑：同一 sessionId 恒定同一形象（重启/重开不变，产生个体认同）。
// 配色只从 design token CSS 变量集合中取（AGENTS.md：禁止硬编码色值）。

import type { AgentCategory } from './theaterTypes';
import { CATEGORY_KEYWORDS, RESEARCH_TOOLS } from './theaterCopy';

/** FNV-1a 32 位字符串哈希 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 确定性伪随机（返回 [0,1)） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 可用配色（design token CSS 变量，禁硬编码色值）。
 * 视觉规范（新东方极简）：黛青是唯一交互色，紫色体系新代码禁用，
 * 语义色（success/warning）只表达状态不做装饰——类别区分靠模板轮廓与部件。
 */
export const IMP_PALETTE = [
  'var(--color-accent-300)',
  'var(--color-accent-400)',
  'var(--color-accent-500)',
  'var(--color-text-secondary)',
  'var(--color-text-muted)',
  'var(--element-bg-medium)',
] as const;

/** 模板（体型/轮廓）——分类决定 */
export const CATEGORY_TEMPLATES: Record<AgentCategory, string> = {
  coding: 'bee', // 蜜蜂（搬砖工）
  debugging: 'woodpecker', // 啄木鸟（敲击诊断）
  research: 'owl', // 猫头鹰（文献眼）
  writing: 'snail', // 蜗牛（慢慢写）
  general: 'worker', // 小黄帽工蜂
};

/** 分类器（§3.4：turn/start 的任务标签 + 会话已用工具名） */
export function classifyAgent(taskLabel: string, toolNames: string[] = []): AgentCategory {
  const text = taskLabel.toLowerCase();
  for (const group of CATEGORY_KEYWORDS) {
    if (group.patterns.some((p) => text.includes(p))) return group.category;
  }
  const known = toolNames.filter(Boolean);
  if (known.length > 0 && known.every((t) => RESEARCH_TOOLS.has(t))) return 'research';
  return 'general';
}

export interface ImpAppearance {
  category: AgentCategory;
  template: string;
  /** 形象部件索引（渲染层映射为 CSS/SVG 变体） */
  accent: string;
  eyeStyle: 0 | 1 | 2;
  antennaStyle: 0 | 1 | 2;
  patternStyle: 0 | 1 | 2;
  gadget: 0 | 1 | 2 | 3;
}

/**
 * 生成工灵形象：同 (sessionId, category) 输入恒定同输出。
 * category 由分类器提供（turn 内定档不漂移）；toolNames 仅用于分类兜底。
 */
export function generateImpAppearance(
  sessionId: string,
  category: AgentCategory,
  toolNames: string[] = [],
): ImpAppearance {
  const finalCategory = category === 'general' ? classifyAgent('', toolNames) : category;
  const rand = mulberry32(hashString(`${sessionId}::${finalCategory}`));
  return {
    category: finalCategory,
    template: CATEGORY_TEMPLATES[finalCategory],
    accent: IMP_PALETTE[Math.floor(rand() * IMP_PALETTE.length)],
    eyeStyle: Math.floor(rand() * 3) as 0 | 1 | 2,
    antennaStyle: Math.floor(rand() * 3) as 0 | 1 | 2,
    patternStyle: Math.floor(rand() * 3) as 0 | 1 | 2,
    gadget: Math.floor(rand() * 4) as 0 | 1 | 2 | 3,
  };
}
