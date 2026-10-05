/**
 * themes — 皮肤契约测试（v5：颜色全在 CSS）
 *
 * 这一层守三件事：
 * 1. payload 只承载皮肤标识，颜色**不**在数据里
 * 2. 皮肤标识原样透传（扩展主题不该被白名单拦住）
 * 3. data-style 属性名固定
 *
 * 「颜色对不对」不由这里守 —— 那是 skinContrast.test.ts 的活
 * （它直接扫 community.scss 里每个 [data-style] 块）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  styleAttrs,
  resolveAppliedTheme,
  FALLBACK_STYLE,
  FALLBACK_THEME,
  DEFAULT_THEME_SLUG,
  type ProfileTheme,
} from './themes';

const SCSS = readFileSync(resolve(__dirname, 'community.scss'), 'utf8');

/** 抽出 community.scss 里所有皮肤标识（[data-style='xxx']） */
function skinNames(): string[] {
  return [...SCSS.matchAll(/\[data-style='([a-z0-9-]+)'\]/g)].map((m) => m[1]);
}

describe('皮肤标识透传', () => {
  it('data-style 属性名固定为 data-style', () => {
    expect(styleAttrs('minimal')).toEqual({ 'data-style': 'minimal' });
    expect(styleAttrs('comic')).toEqual({ 'data-style': 'comic' });
  });

  /**
   * 扩展主题不该被 TS 白名单拦住 —— 这是 v5 的核心诉求。
   * 以前这里是 `THEME_STYLES` 数组，加一套主题要改它 + 改三处测试常量表。
   */
  it('任意标识都原样透传（不校验、不回落）', () => {
    expect(styleAttrs('my-extension-theme')).toEqual({ 'data-style': 'my-extension-theme' });
    expect(styleAttrs('')).toEqual({ 'data-style': '' });
  });

  it('FALLBACK_STYLE 对应一个真实存在的皮肤块', () => {
    expect(skinNames()).toContain(FALLBACK_STYLE);
  });
});

describe('扩展主题的成本（回归防线）', () => {
  /**
   * 如果哪天有人又往 themes.ts 里加回"皮肤白名单"，这个测试会红。
   * 它锁的是 v5 的核心承诺：**新增皮肤 = 只写 CSS**。
   */
  it('themes.ts 不导出皮肤白名单数组', () => {
    // 白名单会重新把扩展主题卡在 TS 侧，白改一次代码才能换皮
    const src = readFileSync(resolve(__dirname, 'themes.ts'), 'utf8');
    // 只认「导出的数组常量」——FALLBACK_STYLE 是字符串，不能算白名单
    expect(src).not.toMatch(/export const \w+\s*(?::[^=]+)?=\s*\[/);
    expect(src).not.toMatch(/export const \w*MODES\b/);
  });

  it('themes.ts 不再导出运行时配色函数（颜色已在 CSS）', () => {
    const src = readFileSync(resolve(__dirname, 'themes.ts'), 'utf8');
    for (const fn of ['paletteFor', 'textureImage', 'textureSize', 'derivePalette']) {
      expect(src.includes(fn), `themes.ts 不该再出现 ${fn}`).toBe(false);
    }
  });
});

describe('resolveAppliedTheme', () => {
  const mk = (slug: string, applied: boolean): ProfileTheme => ({ ...FALLBACK_THEME, slug, applied });

  it('优先用 applied 的那套', () => {
    expect(resolveAppliedTheme([mk('xuanzhi', false), mk('manhua', true)]).slug).toBe('manhua');
  });

  it('没有任何 applied → 回落默认 slug', () => {
    expect(resolveAppliedTheme([mk('manhua', false), mk('xuanzhi', false)]).slug).toBe(
      DEFAULT_THEME_SLUG,
    );
  });

  /**
   * 迁移 035 删掉了 6 套主题。老用户可能仍持有已删 slug 的记录，
   * 此时必须安静回落到兜底主题，不能抛错也不能白屏。
   */
  it('只剩已删主题的脏数据 → 回落兜底主题（不崩）', () => {
    expect(resolveAppliedTheme([mk('zhuyin', false)]).slug).toBe(DEFAULT_THEME_SLUG);
    expect(resolveAppliedTheme(null).slug).toBe(DEFAULT_THEME_SLUG);
    expect(resolveAppliedTheme([]).slug).toBe(DEFAULT_THEME_SLUG);
  });
});