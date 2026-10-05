/**
 * @vitest-environment jsdom
 *
 * 校验 H5 单文件与 App 端的镜像一致性。
 *
 * 背景：server/sites/community-public/index.html 是零构建单文件，
 * 皮肤调色板 / 指纹 / 纹章全是手写镜像。镜像一旦漂移，
 * 站内外就会长得不一样，而且没有任何构建期检查能发现。
 *
 * 做法：把 HTML 里的脚本抠出来在 jsdom 里跑一遍，与 TS 侧同输入比对输出。
 * 这是"零构建"必须付出的检查成本——用测试换构建。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contrastRatio } from './palette';
import { themeStyle } from './themes';
import { fpSealSvg, fpSealCells, fpHeatGrid } from './fingerprintViews';

const HTML = readFileSync(
  resolve(__dirname, '../../../../../../../server/sites/community-public/index.html'),
  'utf8',
);

/** App 端 SCSS（调色板真源） */
const SCSS = readFileSync(resolve(__dirname, 'community.scss'), 'utf8');

/** 抠出 H5 的 <style> 内容（色板镜像住在里面） */
function extractCss(src: string): string {
  const m = /<style>([\s\S]*?)<\/style>/.exec(src);
  if (!m) throw new Error('未找到内联样式');
  return m[1];
}

/** 抠出 <script> 主体（单文件只有一个内联脚本） */
function extractScript(src: string): string {
  const m = /<script>([\s\S]*)<\/script>/.exec(src);
  if (!m) throw new Error('未找到内联脚本');
  return m[1];
}

/** 把 IIFE 里的函数暴露出来：在 return 前插桩 */
function withExports(src: string): string {
  // 脚本是 `(function(){...})()`，直接追加 return 导出
  return src.replace(
    /\}\)\(\);\s*$/,
    `
  globalThis.__h5 = {
    hexToRgb: hexToRgb, contrast: contrast, shade: shade, mixOver: mixOver,
    derivePalette: derivePalette, themeStyle: themeStyle, styleAttrs: styleAttrs,
    coverLetter: coverLetter,
    fpHeatGrid: fpHeatGrid, fpClock: fpClock, fpGenres: fpGenres,
    fpMilestoneText: fpMilestoneText, fpSealSvg: fpSealSvg
  };
})();
`,
  );
}

const H5_CSS = extractCss(HTML);

type H5 = {
  hexToRgb: (hex: string) => { r: number; g: number; b: number };
  contrast: (a: string, b: string) => number;
  shade: (hex: string, amt: number) => string;
  mixOver: (fg: string, bg: string, a: number) => string;
  derivePalette: (
    p: Record<string, unknown>,
    glow: string | null,
  ) => Record<string, string>;
  themeStyle: (payload: Record<string, unknown>) => string;
  styleAttrs: (style: string) => string;
  coverLetter: (s: string) => string;
  fpHeatGrid: (days: unknown[], todayMs: number) => Array<Array<{ day: string; total: number; level: number }>>;
  fpClock: (clock: number[]) => Array<{ hour: number; count: number; ratio: number }>;
  fpGenres: (g: unknown[]) => Array<{ name: string; count: number; ratio: number }>;
  fpMilestoneText: (key: string, v: number) => string;
  fpSealSvg: (seed: string, ink: string, seal: string, size: number) => string;
};

function loadH5(): H5 {
  // 脚本尾部会调 renderState()（无路由时），它要写 #app —— 先放个最小 DOM
  document.body.innerHTML = '<div id="app"></div>';
  const src = withExports(extractScript(HTML));
  // eslint-disable-next-line no-new-func
  new Function(src)();
  const h5 = (globalThis as unknown as { __h5?: H5 }).__h5;
  if (!h5) throw new Error('H5 脚本未导出测试需要的函数');
  delete (globalThis as unknown as { __h5?: H5 }).__h5;
  return h5;
}

let h5: H5;
try {
  h5 = loadH5();
} catch (e) {
  throw new Error(
    `无法在测试环境加载 H5 脚本（jsdom 缺失或脚本已改名）：${e instanceof Error ? e.message : String(e)}`,
  );
}


describe('H5 ↔ App 镜像一致性', () => {
  it('H5 脚本可加载（语法有效）', () => {
    expect(typeof h5.derivePalette).toBe('function');
  });

  /**
   * 皮肤标识：两端**都不做白名单校验**，任意 style 原样透传。
   *
   * 契约（v5 末）：加一套皮肤 = 在 community.scss 里加一段 `[data-style='xxx']`。
   * 如果任何一端还留白名单，那个皮肤就会在那一端悄悄回落 minimal ——
   * 「扩展主题只写 CSS」就破了。所以 H5 的 STYLES 白名单已删。
   */
  it('任意皮肤：两端原样透传（无白名单）', () => {
    for (const style of ['minimal', 'comic', 'neon', 'my-ext-theme', 'x']) {
      expect(h5.themeStyle({ style })).toBe(style);
    }
  });

  it('非法/缺失 style：两端都回落 minimal（不能崩、不能空样式）', () => {
    for (const payload of [{}, { style: null }, { style: 42 }, { style: '' }, { style: '   ' }]) {
      expect(h5.themeStyle(payload as Record<string, unknown>)).toBe('minimal');
    }
  });

  it('H5 也能从 payload 里取 style（服务端两种形状都给）', () => {
    // 服务端 CommunityTheme 顶层有 style；H5 历史上从 payload.style 读。
    // 两个形状都必须认，否则改服务端 DTO 就会静默把皮肤打回 minimal。
    expect(h5.themeStyle({ payload: { style: 'comic' } })).toBe('comic');
    expect(h5.themeStyle({ style: 'comic', payload: { style: 'comic' } })).toBe('comic');
  });

  it('style → data-style 属性两端一致', () => {
    expect(h5.styleAttrs('comic')).toBe('data-style="comic"');
    expect(h5.styleAttrs('minimal')).toBe('data-style="minimal"');
  });

  /* ---- 调色板镜像（v5：色值在 CSS 里，直接比字面量）---- */

  /**
   * 抽某个皮肤块的 CSS 变量表（按大括号配对，嵌套规则不会提前截断）。
   * source 是 <style> 的内容（不含 SCSS 嵌套）。
   */
  function skinVars(source: string, selector: string): Record<string, string> {
  // ⚠️ 必须按大括号配对取整个块：皮肤块里有嵌套规则，
  // 用 /\n}/ 会在嵌套规则结尾就截断，误判成"缺色值"。
  const open = source.indexOf(`${selector} {`);
  if (open < 0) throw new Error(`找不到皮肤块 ${selector}`);
  let depth = 0;
  let i = source.indexOf('{', open);
  const from = i + 1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const vars: Record<string, string> = {};
  for (const v of source.slice(from, i).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[v[1]] = v[2].trim();
  }
  return vars;
}

  /** App 端调色板：从 community.scss 的皮肤块里取（只比字面色值） */
  function appSkinVars(name: string): Record<string, string> {
    return skinVars(SCSS, `.community-profile2[data-style='${name}']`);
  }

  function h5SkinVars(name: string): Record<string, string> {
    return skinVars(H5_CSS, `.pt[data-style='${name}']`);
  }

  it.each(['minimal', 'comic'])(
    '[%s] 调色板两端逐值一致（改一边忘了另一边必红）',
    (name) => {
      const app = appSkinVars(name);
      const h5v = h5SkinVars(name);
      // 必带色值（色块族也算：漏一个最后一张卡会重复色）
      const keys = [
        '--pt-bg', '--pt-surface', '--pt-surface-alt', '--pt-surface-sunken',
        '--pt-banner', '--pt-border', '--pt-border-strong',
        '--pt-text', '--pt-text-muted', '--pt-text-faint',
        '--pt-accent', '--pt-accent-hover', '--pt-accent-strong',
        '--pt-accent-soft', '--pt-accent-text',
        ...[1, 2, 3, 4, 5, 6].map((i) => `--pt-cover-${i}`),
      ];
      for (const k of keys) {
        expect(app[k], `App 的 ${name} 缺 ${k}`).toBeDefined();
        expect(h5v[k], `H5 的 ${name} 缺 ${k}`).toBeDefined();
        expect(h5v[k], `${name} 的 ${k} 两端不一致`).toBe(app[k]);
      }
    },
  );

  it.each(['minimal', 'comic'])(
    '[%s] 两端色板的对比度红线都成立（不靠运行时推导兜底）',
    (name) => {
      for (const vars of [appSkinVars(name), h5SkinVars(name)]) {
        const bg = vars['--pt-bg'];
        const surface = vars['--pt-surface'];
        const muted = vars['--pt-text-muted'];
        expect(contrastRatio(muted, bg), `${name} muted/bg`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(muted, surface), `${name} muted/surface`).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(vars['--pt-accent-text'], vars['--pt-accent']),
          `${name} accentText/accent`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('derivePalette 只剩兜底用途（H5 里仍存在，但不再决定颜色）', () => {
    // 兜底路径必须仍可用：data-style 指向不存在的皮肤时不能白屏
    const c = h5.derivePalette({ bg: '#242729', surface: '#2b2f33', border: '#3a4046', accent: '#60a5fa' }, null);
    expect(c.bg).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('热力图周桶切分：两端完全一致', () => {
    const today = Date.UTC(2026, 9, 4);
    const days = [
      { day: '2026-10-04', posts: 2, songs: 1 },
      { day: '2026-10-02', posts: 5, songs: 0 },
      { day: '2026-09-30', posts: 1, songs: 3 },
    ];
    const app = fpHeatGrid(days, today);
    const h = h5.fpHeatGrid(days, today);
    expect(h.length).toBe(app.weeks.length);
    h.forEach((col, wi) => {
      expect(col.length).toBe(7);
      col.forEach((cell, di) => {
        expect(cell.day, `week${wi} day${di}`).toBe(app.weeks[wi]![di]!.day);
        expect(cell.total).toBe(app.weeks[wi]![di]!.total);
        expect(cell.level).toBe(app.weeks[wi]![di]!.level);
      });
    });
  });

  it('强度分档两端一致（0/1/2/3-4/5+）', () => {
    const today = Date.UTC(2026, 9, 4);
    const days = [0, 1, 2, 3, 4, 5, 20].map((n, i) => ({
      day: `2026-10-0${i + 1}`,
      posts: n,
      songs: 0,
    }));
    const app = fpHeatGrid(days, today).weeks.flat();
    const h = h5.fpHeatGrid(days, today).flat();
    for (const c of app) {
      if (c.level < 0) continue;
      const hc = h.find((x) => x.day === c.day);
      expect(hc!.level, `${c.day}(${c.total})`).toBe(c.level);
      expect(hc!.total).toBe(c.total);
    }
  });

  it('时钟：两端桶数/峰值归一一致', () => {
    const clock = Array.from({ length: 24 }, (_, i) => (i === 3 || i === 15 ? i : 0));
    const app = fpClockView(clock);
    const h = h5.fpClock(clock);
    expect(h.length).toBe(24);
    h.forEach((b, i) => {
      expect(b.hour).toBe(app[i]!.hour);
      expect(b.count).toBe(app[i]!.count);
      expect(b.ratio).toBeCloseTo(app[i]!.ratio, 6);
    });
  });

  it('时钟：脏输入两端都清洗为 0（不产生 NaN 柱）', () => {
    const dirty = [NaN, null as unknown as number, undefined as unknown as number, 4];
    for (const b of h5.fpClock(dirty)) {
      expect(Number.isFinite(b.ratio)).toBe(true);
      expect(b.ratio).toBeGreaterThanOrEqual(0);
    }
  });

  it('类型分布：两端排序/截断/占比一致', () => {
    const genres = [
      { name: 'Ambient', count: 7 },
      { name: 'Dream Pop', count: 12 },
      { name: '', count: 3 },
      { name: 'Zero', count: 0 },
      { name: 'A', count: 1 },
      { name: 'B', count: 1 },
      { name: 'C', count: 1 },
      { name: 'D', count: 1 },
      { name: 'E', count: 1 },
      { name: 'F', count: 1 },
      { name: 'G', count: 1 },
    ];
    const app = fpGenresView(genres);
    const h = h5.fpGenres(genres);
    expect(h.length).toBe(app.length);
    expect(h.length).toBeLessThanOrEqual(8);
    h.forEach((g, i) => {
      expect(g.name, `#${i}`).toBe(app[i]!.name);
      expect(g.count).toBe(app[i]!.count);
      expect(g.ratio).toBeCloseTo(app[i]!.ratio, 6);
    });
  });

  it('里程碑文案：两端一致（服务端只发数值，文案不能分叉）', () => {
    const cases: Array<[string, number]> = [
      ['works', 24], ['songs', 9], ['posts', 15],
      ['activeDays', 42], ['streak', 7], ['minutes', 260],
    ];
    for (const [k, v] of cases) {
      expect(h5.fpMilestoneText(k, v), k).toBe(fpMilestoneTextView(k, v));
    }
  });

  it('纹章：两端格子坐标完全一致（改任一侧必红）', () => {
    const seeds = ['alice#7', 'bob#42', '张三#1', 'x', 'a-very-long-username-#999'];
    for (const s of seeds) {
      const app = fpSealCells(s);
      // H5 只导出 SVG，比较 SVG 里的 rect 坐标
      const svg = h5.fpSealSvg(s, '#111111', '#c0392b', 24);
      const rects = [...svg.matchAll(/x="(\d)" y="(\d)"/g)].map((m) => `${m[1]},${m[2]}`);
      const expectRects = app.filter((c) => c.on).map((c) => `${c.x},${c.y}`);
      expect(rects.length, `seed=${s} 格子数`).toBe(expectRects.length);
      expect(new Set(rects).size, `seed=${s} 无重复格`).toBe(expectRects.length);
    }
  });

  it('纹章：朱砂点恒在中轴偏上那一格（两端同规则）', () => {
    for (const s of ['alice#7', 'zzz#1', 'q']) {
      const appSvg = fpSealSvg(s, '#111111', '#c0392b', 24);
      const h5Svg = h5.fpSealSvg(s, '#111111', '#c0392b', 24);
      const pick = (svg: string) =>
        /<rect x="2" y="1"[^>]*fill="([^"]+)"/.exec(svg)?.[1] ?? null;
      expect(pick(h5Svg), `seed=${s}`).toBe(pick(appSvg));
    }
  });

  it('排版封面首字：两端一致', () => {
    for (const s of ['夜航', '关于《雾》的碎念', '## 标题', '', '24 点计划', '🎵 mix']) {
      expect(h5.coverLetter(s), JSON.stringify(s)).toBe(fpCoverLetterView(s));
    }
  });
});

/* ---- App 侧视图（与 H5 同输入，输出应一致） ---- */
function fpClockView(clock: number[]): Array<{ hour: number; count: number; ratio: number }> {
  const clean = Array.from({ length: 24 }, (_, i) => {
    const n = clock[i];
    return Number.isFinite(n) ? (n as number) : 0;
  });
  const peak = Math.max(1, ...clean);
  return clean.map((count, hour) => ({ hour, count, ratio: Math.max(0, Math.min(1, count / peak)) }));
}
function fpGenresView(g: Array<{ name: string; count: number }>): Array<{ name: string; count: number; ratio: number }> {
  const clean = g
    .filter((x) => typeof x.name === 'string' && Number.isFinite(x.count) && x.count > 0)
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const max = Math.max(1, ...clean.map((x) => x.count));
  return clean.map((x) => ({ name: x.name, count: x.count, ratio: x.count / max }));
}
function fpMilestoneTextView(key: string, value: number): string {
  switch (key) {
    case 'works': return `${value} 个作品`;
    case 'songs': return `${value} 首歌`;
    case 'posts': return `${value} 篇动态`;
    case 'activeDays': return `${value} 天有创作`;
    case 'streak': return `连续 ${value} 天`;
    case 'minutes': {
      const s = value * 60;
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (h > 0 && m > 0) return `${h} 小时 ${m} 分`;
      if (h > 0) return `${h} 小时`;
      return `${m} 分`;
    }
    default: return `${key} ${value}`;
  }
}
function fpCoverLetterView(seed: string): string {
  const s = String(seed || '').replace(/[#>*_`~[\]()-]/g, '').trim();
  if (!s) return '文';
  const ch = s.charAt(0);
  return /\p{L}/u.test(ch) ? ch.toUpperCase() : s.slice(0, 2);
}

