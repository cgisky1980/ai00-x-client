/**
 * skinContrast — 皮肤色板的对比度红线（v5 的守门人）
 *
 * v5 之前颜色是「DB 种子 → palette.ts 推导」，对比度由 `lForContrast`
 * 在构造上保证。v5 颜色手写在 CSS 里，这个保证就消失了 ——
 * 所以必须由**测试**把它接回来，否则「换主题只写 CSS」等于
 * 「换主题随便写 CSS，瞎了也没人管」。
 *
 * 它做什么：扫 community.scss 里每个 `.community-profile2[data-style='xxx']` 块，
 * 取出 15 个 --pt-* 色值，用 palette.ts 的 WCAG 算法校验：
 *   - 正文 text 对 bg / surface ≥ 7（正文，宁高不低）
 *   - 次要 textMuted 对 bg / surface ≥ 4.5（红线）
 *   - 弱文字 textFaint ≥ 3（非正文）
 *   - accentText 对 accent ≥ 4.5（按钮上的字）
 *   - 描边墨色 ink 对 bg ≥ 12（描边必须"真的是黑"，见下）
 *   - 必填项齐全（漏一个 → 显式失败，不让页面悄悄半透明）
 *
 * 加一套新皮肤时，这个测试会自动覆盖它 —— 不用改本文件。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contrastRatio } from './palette';

const RAW_SCSS = readFileSync(resolve(__dirname, 'community.scss'), 'utf8');

/**
 * 先剥注释再扫。
 *
 * 踩过的坑：注释里写了句"加第三套皮肤 = 在 community.scss 里加一个
 * `[data-style='xxx']` 块"，结果扫描器把**注释里的示例**当成真皮肤，
 * 7 个用例当场报"找不到皮肤块 [data-style='xxx']"。
 * 扫源码的测试必须先剥注释 —— 文档示例是给人看的，不是定义。
 */
const SCSS = RAW_SCSS
  .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
  .replace(/^[ \t]*\/\/.*$/gm, '') // 整行 //
  .replace(/\/\/.*$/gm, ''); // 行尾 //（如 url 里没有，但保险）

/** 必填色值 → 最低对比度（对 bg 与 surface 同时成立） */
const REQUIRED: Record<string, { grounds: string[]; min: number; why: string }> = {
  'text': { grounds: ['bg', 'surface'], min: 7, why: '正文' },
  'text-muted': { grounds: ['bg', 'surface'], min: 4.5, why: '次要正文（红线）' },
  'text-faint': { grounds: ['bg'], min: 3, why: '弱文字（非正文）' },
  'accent-text': { grounds: ['accent'], min: 4.5, why: '强调色上的文字' },
};

const OPTIONAL = ['bg', 'surface', 'surface-alt', 'surface-sunken', 'banner', 'border', 'border-strong', 'accent', 'ink'];

/**
 * 描边墨色必须"真的是黑"。
 *
 * 踩过的坑：漫画风一开始拿 --pt-text (#343128，偏棕深灰) 当描边色，
 * 3px 粗边在米色纸上读作"灰线"，漫画感完全出不来 —— 视觉上"看不出黑边框"。
 * 粗黑边的力量来自明度对比，不是来自"颜色深"。所以把这条变成 CI 红线：
 * ink 对页面底 ≥ 12:1，任何"深灰当黑用"的写法都会在这里被拦下。
 */
const INK_MIN_CONTRAST = 12;

/** 取出某个皮肤块的 CSS 变量表 */
function readSkin(name: string): Record<string, string> {
  // ⚠️ 必须按大括号配对取整个块：皮肤块里有嵌套规则（.community-stream__grid 等），
  // 用 /\n}/ 会在嵌套规则结尾就截断，误判成"缺色值"。
  const open = SCSS.indexOf(`.community-profile2[data-style='${name}'] {`);
  if (open < 0) throw new Error(`community.scss 里找不到皮肤块 [data-style='${name}']`);
  let depth = 0;
  let i = SCSS.indexOf('{', open);
  const start = i + 1;
  for (; i < SCSS.length; i++) {
    if (SCSS[i] === '{') depth++;
    else if (SCSS[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const vars: Record<string, string> = {};
  for (const v of SCSS.slice(start, i).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[v[1]] = v[2].trim();
  }
  return vars;
}

/** community.scss 里所有皮肤标识 */
const SKINS = [...new Set([...SCSS.matchAll(/\[data-style='([a-z0-9-]+)'\]/g)].map((m) => m[1]))];

/** 只接受字面色值：引用 var() 的（刻意留空/继承）跳过 */
function hex(vars: Record<string, string>, key: string): string | null {
  const v = vars[key];
  return v && /^#[0-9a-f]{3,8}$/i.test(v) ? v : null;
}

/** 取必填色值；缺了就当场报错（而不是拿 null 去算对比度） */
function need(vars: Record<string, string>, key: string): string {
  const v = hex(vars, key);
  if (!v) throw new Error(`皮肤块缺 ${key} 或它不是字面色值`);
  return v;
}

describe('皮肤色板（community.scss）', () => {
  it('至少存在两个皮肤块（中华极简 + 漫画风）', () => {
    expect(SKINS).toEqual(expect.arrayContaining(['minimal', 'comic']));
  });

  it.each(SKINS)('[%s] 必填色值齐全（漏一个就会半透明）', (name) => {
    const vars = readSkin(name);
    for (const key of Object.keys(REQUIRED)) {
      expect(hex(vars, `--pt-${key}`), `${name} 缺 --pt-${key}`).not.toBeNull();
    }
    for (const key of OPTIONAL) {
      expect(hex(vars, `--pt-${key}`), `${name} 缺 --pt-${key}`).not.toBeNull();
    }
  });

  it.each(SKINS)('[%s] 卡顶色块族 6 个（nth-child 选族，少一个最后一张重复）', (name) => {
    const vars = readSkin(name);
    for (let i = 1; i <= 6; i++) {
      expect(hex(vars, `--pt-cover-${i}`), `${name} 缺 --pt-cover-${i}`).not.toBeNull();
    }
  });

  it.each(SKINS)('[%s] 皮肤变量齐全（描边语言）', (name) => {
    const vars = readSkin(name);
    for (const key of [
      '--pt-stroke-w', '--pt-stroke', '--pt-hard', '--pt-dash',
      '--pt-radius-card', '--pt-cover-ratio', '--pt-title-weight',
      '--pt-font-display', '--pt-mono',
    ]) {
      expect(vars[key], `${name} 缺 ${key}`).toBeDefined();
    }
  });

  it.each(SKINS)('[%s] 对比度达标', (name) => {
    const vars = readSkin(name);
    const get = (k: string) => need(vars, `--pt-${k}`);

    for (const [key, rule] of Object.entries(REQUIRED)) {
      const fg = get(key);
      for (const g of rule.grounds) {
        const ratio = contrastRatio(fg, get(g));
        expect(
          ratio,
          `${name} 的 --pt-${key}（${rule.why}）对 --pt-${g} 只有 ${ratio.toFixed(2)}:1，` +
            `低于 ${rule.min}:1`,
        ).toBeGreaterThanOrEqual(rule.min);
      }
    }
  });

  it.each(SKINS)('[%s] 卡顶色块上压深色大字可读（≥4.5）', (name) => {
    const vars = readSkin(name);
    for (let i = 1; i <= 6; i++) {
      const ratio = contrastRatio(need(vars, '--pt-text'), need(vars, `--pt-cover-${i}`));
      expect(ratio, `${name} 的 --pt-cover-${i} 上压正文只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(SKINS)('[%s] 描边墨色真的是黑（对 bg ≥ 12:1，挡住"深灰当黑用"）', (name) => {
    const vars = readSkin(name);
    const ratio = contrastRatio(need(vars, '--pt-ink'), need(vars, '--pt-bg'));
    expect(
      ratio,
      `${name} 的 --pt-ink 对 --pt-bg 只有 ${ratio.toFixed(2)}:1，` +
        `低于 ${INK_MIN_CONTRAST}:1 —— 描边会读成"灰线"而不是黑边`,
    ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
  });

  it.each(SKINS)('[%s] 表面层级单调（bg → surface 要能看出抬起）', (name) => {
    const vars = readSkin(name);
    const bg = need(vars, '--pt-bg');
    const surface = need(vars, '--pt-surface');
    // 卡片面必须与页面底不同，否则卡片"贴"在底上、边界消失
    expect(bg.toLowerCase(), `${name} 的 surface 与 bg 相同`).not.toBe(surface.toLowerCase());
  });
});