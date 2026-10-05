import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  derivePalette,
  hexToOklch,
  hexToRgb,
  oklchToHex,
  type PaletteInput,
} from './palette';

/**
 * 迁移 027 种子的 8 套官方主题（payload 原文）。
 * 这里硬编码一份而不是从库里读：配色推导的契约是"给定 payload 必得合格色板"，
 * payload 改了这条测试就该被审视，而不是跟着悄悄变绿。
 */
const OFFICIAL: Array<{ slug: string; payload: PaletteInput; expectMode: 'light' | 'dark' }> = [
  {
    slug: 'songyan',
    expectMode: 'dark',
    payload: {
      bg: '#242729', surface: '#2b2f33', text: '#f0f2f4', textMuted: '#9aa3ab',
      border: '#3a4046', accent: '#60a5fa', accentText: '#0b1220', bannerBg: '#1c2023',
    },
  },
  {
    slug: 'xuanzhi',
    expectMode: 'light',
    payload: {
      bg: '#f4f2ec', surface: '#ffffff', text: '#262620', textMuted: '#8a8776',
      border: '#d9d4c5', accent: '#3d6b8e', accentText: '#ffffff', bannerBg: '#eae6da',
    },
  },
  {
    slug: 'jiguang',
    expectMode: 'dark',
    payload: {
      bg: '#0a0f14', surface: '#101820', text: '#d8faff', textMuted: '#5f7a86',
      border: '#17323d', accent: '#22d3ee', accentText: '#04121a', bannerBg: '#071118',
    },
  },
  {
    slug: 'zazhi',
    expectMode: 'light',
    payload: {
      bg: '#faf9f6', surface: '#ffffff', text: '#14120f', textMuted: '#6f6a60',
      border: '#14120f', accent: '#b3541e', accentText: '#ffffff', bannerBg: '#14120f',
    },
  },
  {
    slug: 'xiansu',
    expectMode: 'dark',
    payload: {
      bg: '#221a12', surface: '#2d2318', text: '#f5e9c8', textMuted: '#a89877',
      border: '#57452c', accent: '#ffb000', accentText: '#221a12', bannerBg: '#191008',
    },
  },
  {
    slug: 'shouzhang',
    expectMode: 'light',
    payload: {
      bg: '#fdf6ec', surface: '#fffdf6', text: '#4a3f35', textMuted: '#a08e7d',
      border: '#e3cfae', accent: '#e8604c', accentText: '#ffffff', bannerBg: '#f6e7cd',
    },
  },
  {
    slug: 'zhuyin',
    expectMode: 'dark',
    payload: {
      bg: '#14161a', surface: '#1b1e24', text: '#ece9e2', textMuted: '#8f8c85',
      border: '#2c3037', accent: '#c53d2b', accentText: '#ffffff', bannerBg: '#101216',
    },
  },
  {
    slug: 'shuangxuan',
    expectMode: 'light',
    payload: {
      bg: '#f2f5f7', surface: '#ffffff', text: '#1f2733', textMuted: '#7c8896',
      border: '#ccd6de', accent: '#4a7dab', accentText: '#ffffff', bannerBg: '#e3eaf0',
    },
  },
];

/** 三期计划红线：正文对比度 ≥4.5:1 */
const BODY_MIN = 4.5;
const ACCENT_MIN = 3;

describe('palette 色彩空间转换', () => {
  it('hexToRgb 兼容 3 位 / 6 位 / 缺省 # / 非法值', () => {
    expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('242729')).toEqual({ r: 0x24, g: 0x27, b: 0x29 });
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('nope')).toEqual({ r: 128, g: 128, b: 128 });
  });

  it('hex → oklch → hex 在色域内往返无损', () => {
    for (const { slug, payload } of OFFICIAL) {
      expect(oklchToHex(hexToOklch(payload.bg)), `${slug} bg 往返`).toBe(payload.bg);
      expect(oklchToHex(hexToOklch(payload.accent)), `${slug} accent 往返`).toBe(payload.accent);
    }
  });

  it('色域外的彩度被降下来而不是截断通道（保留色相）', () => {
    // 高彩度高明度的纯品红远在 sRGB 之外
    const out = oklchToHex({ l: 0.9, c: 0.4, h: 328 });
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    const back = hexToOklch(out);
    // 明度保留、色相保留，彩度被压回色域
    expect(Math.abs(back.l - 0.9)).toBeLessThan(0.02);
    const hueArc = Math.abs(((back.h - 328) % 360 + 360) % 360);
    expect(Math.min(hueArc, 360 - hueArc)).toBeLessThan(3);
    expect(back.c).toBeLessThan(0.4);
  });

  it('contrastRatio 与 WCAG 参考值一致（黑/白=21，同色=1）', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#242729', '#242729')).toBeCloseTo(1, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
  });
});

describe('derivePalette 对 8 套官方主题的配色契约', () => {
  it('明暗档判定与主题设计意图一致', () => {
    for (const { slug, payload, expectMode } of OFFICIAL) {
      expect(derivePalette(payload).mode, `${slug} 明暗档`).toBe(expectMode);
    }
  });

  it('正文与次要正文在所有承载表面上 ≥4.5:1（三期红线）', () => {
    for (const { slug, payload } of OFFICIAL) {
      const p = derivePalette(payload);
      for (const ground of [p.bg, p.surface, p.surfaceAlt]) {
        expect(
          contrastRatio(p.textMuted, ground),
          `${slug} textMuted(${p.textMuted}) on ${ground}`,
        ).toBeGreaterThanOrEqual(BODY_MIN);
        expect(
          contrastRatio(p.text, ground),
          `${slug} text(${p.text}) on ${ground}`,
        ).toBeGreaterThanOrEqual(BODY_MIN);
      }
    }
  });

  it('主文字对比度 ≥12（展示级标题）', () => {
    for (const { slug, payload } of OFFICIAL) {
      const p = derivePalette(payload);
      expect(contrastRatio(p.text, p.bg), `${slug} text/bg`).toBeGreaterThanOrEqual(12);
    }
  });

  it('弱文字 ≥3:1（仅用于水印/禁用态，不承担正文）', () => {
    for (const { slug, payload } of OFFICIAL) {
      const p = derivePalette(payload);
      expect(contrastRatio(p.textFaint, p.bg), `${slug} textFaint`).toBeGreaterThanOrEqual(3);
    }
  });

  it('accent 上的文字 ≥4.5:1，accent 在底色上 ≥3:1（交互可辨识）', () => {
    for (const { slug, payload } of OFFICIAL) {
      const p = derivePalette(payload);
      expect(contrastRatio(p.accentText, p.accent), `${slug} accentText/accent`)
        .toBeGreaterThanOrEqual(BODY_MIN);
      expect(contrastRatio(p.accent, p.bg), `${slug} accent/bg`).toBeGreaterThanOrEqual(ACCENT_MIN);
      expect(contrastRatio(p.accent, p.surface), `${slug} accent/surface`)
        .toBeGreaterThanOrEqual(ACCENT_MIN);
    }
  });

  it('表面阶无反转：surfaceAlt 不比 surface 更靠近 bg，sunken/banner 一律更暗', () => {
    for (const { slug, payload, expectMode } of OFFICIAL) {
      const p = derivePalette(payload);
      const bgL = hexToOklch(p.bg).l;
      const away = (hex: string): number => Math.abs(hexToOklch(hex).l - bgL);
      // 8bit 量化容差：bg 极亮时（宣纸/杂志）表面阶本就只剩 1~2 个色阶可用
      expect(away(p.surfaceAlt), `${slug} surfaceAlt 无反转`).toBeGreaterThanOrEqual(away(p.surface) - 0.001);
      // 沉面 / banner 一律朝黑走（凹进去），亮暗档同向
      expect(hexToOklch(p.surfaceSunken).l, `${slug} sunken 更暗`).toBeLessThan(bgL);
      expect(hexToOklch(p.banner).l, `${slug} banner 更暗`).toBeLessThan(bgL);
      if (expectMode === 'dark') {
        expect(hexToOklch(p.surface).l, `${slug} 暗色档 surface 抬起`).toBeGreaterThan(bgL);
        expect(hexToOklch(p.border).l, `${slug} 暗色档 border 变亮`).toBeGreaterThan(bgL);
      } else {
        expect(hexToOklch(p.surface).l, `${slug} 亮色档 surface 抬起`).toBeGreaterThan(bgL);
        expect(hexToOklch(p.border).l, `${slug} 亮色档 border 变暗`).toBeLessThan(bgL);
      }
    }
  });

  it('表面阶严格单调（seed 到白色端有余量的主题）', () => {
    // 亮色档 bg 已近白时（gapWhite < 0.05）表面阶只剩 1~2 个 8bit 色阶，
    // 严格单调在量化后不可达——那是 seed 的性质，不是推导的缺陷。
    const headroom = OFFICIAL.filter((t) => {
      const bgL = hexToOklch(t.payload.bg).l;
      return 1 - bgL > 0.05;
    });
    expect(headroom.length).toBeGreaterThanOrEqual(4);
    for (const { slug, payload } of headroom) {
      const p = derivePalette(payload);
      const bgL = hexToOklch(p.bg).l;
      const away = (hex: string): number => Math.abs(hexToOklch(hex).l - bgL);
      expect(away(p.surfaceAlt), `${slug} surfaceAlt 更远`).toBeGreaterThan(away(p.surface));
      expect(away(p.border), `${slug} border 有份量`).toBeGreaterThan(0.02);
    }
  });

  it('修好了手挑色板的既有缺陷：手帐/宣纸/霜宣/霓虹的 muted 一律 ≥4.5', () => {
    // 推导前（迁移 027 种子原值）实测：手帐 2.94 / 霜宣 3.30 / 宣纸 3.23 / 霓虹 3.93
    const broken = ['shouzhang', 'xuanzhi', 'shuangxuan', 'jiguang'];
    for (const { slug, payload } of OFFICIAL) {
      if (!broken.includes(slug)) continue;
      const p = derivePalette(payload);
      expect(contrastRatio(p.textMuted, p.bg), `${slug} 推导后 muted`).toBeGreaterThanOrEqual(BODY_MIN);
      expect(contrastRatio(p.textMuted, p.bg), `${slug} 优于推导前`)
        .toBeGreaterThan(contrastRatio(payload.textMuted, payload.bg));
    }
  });

  it('accentSoft 是 accent 叠在 bg 上的不透明淡色（免依赖 color-mix）', () => {
    for (const { slug, payload } of OFFICIAL) {
      const p = derivePalette(payload);
      expect(p.accentSoft).toMatch(/^#[0-9a-f]{6}$/);
      expect(p.accentSoft, `${slug} 不等于 bg`).not.toBe(p.bg);

      // 判据用彩度而非色相：低彩度下 8bit 量化足以让重测色相摆动几度，
      // 而彩度是"带 accent 味道"这件事的稳定信号。
      const softC = hexToOklch(p.accentSoft).c;
      const bgC = hexToOklch(p.bg).c;
      expect(softC, `${slug} accentSoft 彩度显著高于 bg`).toBeGreaterThan(Math.max(bgC * 1.5, 0.015));

      // 明度朝 accent 方向移动（与 bg→accent 同侧）
      const softL = hexToOklch(p.accentSoft).l;
      const bgL = hexToOklch(p.bg).l;
      const accL = hexToOklch(payload.accent).l;
      expect(Math.sign(softL - bgL), `${slug} accentSoft 明度朝 accent 侧移动`)
        .toBe(Math.sign(accL - bgL));
    }
  });
});

describe('derivePalette 作品取色（glow）', () => {
  it('墨阶色相朝取色相轻移，但不覆盖主题自身性格', () => {
    const { payload } = OFFICIAL[0]!; // songyan，松烟墨 hue 240
    const plain = derivePalette(payload);
    const glowed = derivePalette({ ...payload, glow: '#e8604c' }); // 手帐的珊瑚红
    const plainH = hexToOklch(plain.bg).h;
    const glowH = hexToOklch(glowed.bg).h;
    // 实际角移（mod 360 的最小弧）
    const shifted = Math.abs(((glowH - plainH) % 360 + 360) % 360);
    const arc = Math.min(shifted, 360 - shifted);
    // 动了，但不超过 28% × 180° = 50.4°
    expect(arc).toBeGreaterThan(1);
    expect(arc).toBeLessThanOrEqual(51);
  });

  it('glow 不得破坏对比度契约', () => {
    for (const { slug, payload } of OFFICIAL) {
      for (const glow of ['#e8604c', '#22d3ee', '#ffb000', '#000000', '#ffffff']) {
        const p = derivePalette({ ...payload, glow });
        expect(contrastRatio(p.textMuted, p.bg), `${slug}+${glow} muted`).toBeGreaterThanOrEqual(BODY_MIN);
        expect(contrastRatio(p.text, p.bg), `${slug}+${glow} text`).toBeGreaterThanOrEqual(BODY_MIN);
      }
    }
  });

  it('glow 为 null / 空串时与不传一致（取色失败是常态路径）', () => {
    const { payload } = OFFICIAL[2]!;
    const a = derivePalette(payload);
    expect(derivePalette({ ...payload, glow: null })).toEqual(a);
    expect(derivePalette({ ...payload, glow: '' })).toEqual(a);
  });
});

describe('derivePalette 鲁棒性', () => {
  it('payload 字段非法时降级而非抛错（主题是增强层不是依赖层）', () => {
    const p = derivePalette({
      bg: 'oops', surface: '', text: '#zzz', textMuted: '',
      border: '#000', accent: 'nope', accentText: '', bannerBg: '',
    });
    const { mode, ...colors } = p;
    expect(['light', 'dark']).toContain(mode);
    for (const v of Object.values(colors)) {
      expect(v, `字段 ${v}`).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(contrastRatio(p.textMuted, p.bg)).toBeGreaterThanOrEqual(BODY_MIN);
  });

  it('极端底色（纯黑 / 纯白）仍满足文字对比度', () => {
    for (const bg of ['#000000', '#ffffff']) {
      const p = derivePalette({
        bg, surface: bg, text: '#000', textMuted: '#888', border: '#333',
        accent: '#00ffff', accentText: '#000', bannerBg: bg,
      });
      expect(contrastRatio(p.text, p.bg), `${bg} text`).toBeGreaterThanOrEqual(BODY_MIN);
      expect(contrastRatio(p.textMuted, p.bg), `${bg} muted`).toBeGreaterThanOrEqual(BODY_MIN);
      expect(contrastRatio(p.accentText, p.accent), `${bg} accentText`).toBeGreaterThanOrEqual(BODY_MIN);
    }
  });
});