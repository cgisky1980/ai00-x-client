/**
 * Ai00-X 皮肤内核（纯 JS，零依赖）—— 构建脚本（node）与运行时（web-ui 设置页 / ThemeService）共用。
 *
 * 皮肤 = 种子 → 派生（规范 v1.0 第二节）：
 *   一份皮肤只写每档（dark + light，两档必填）十来个种子色 + 字体 + 形态；
 *   tokens/semantic.json 里全部语义 token 用 color-mix() 从 --skin-* 种子派生，变量名不变。
 *   本文件负责：校验皮肤 → 补全可选种子 + 推导框架色（deep/high/scrim/shadow）→ 产出 --skin-* 变量 / CSS 块。
 *
 * 为什么是 .js：构建脚本直接 import（无需 TS 运行时），TS 侧经 core.d.ts 获得类型。
 */

/* ---------------- 颜色数学（sRGB ↔ OKLab/OKLCH，WCAG 对比度） ---------------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHex(v) {
  return typeof v === 'string' && HEX.test(v.trim());
}

export function hexToRgb(hex) {
  let h = hex.trim().slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

export function rgbToHex(rgb) {
  return `#${rgb.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklab([r, g, b]) {
  const [R, G, B] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgbRaw([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toGamma);
}

const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH → hex（超色域时降 chroma 保色相与明度） */
export function oklchToHex([L, C, h]) {
  const rad = (h * Math.PI) / 180;
  let c = C;
  let rgb = oklabToRgbRaw([L, c * Math.cos(rad), c * Math.sin(rad)]);
  while (!inGamut(rgb) && c > 0.0005) {
    c *= 0.95;
    rgb = oklabToRgbRaw([L, c * Math.cos(rad), c * Math.sin(rad)]);
  }
  return rgbToHex(rgb);
}

export function hexToOklch(hex) {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  const C = Math.hypot(a, b);
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return [L, C, h];
}

/** OKLab 感知混合：t=0 → a，t=1 → b（与 CSS color-mix(in oklab, a (1-t), b t) 一致） */
export function mixHex(a, b, t) {
  const A = rgbToOklab(hexToRgb(a));
  const B = rgbToOklab(hexToRgb(b));
  const rgb = oklabToRgbRaw(A.map((v, i) => v + (B[i] - v) * t));
  return rgbToHex(rgb);
}

/** 平移 OKLCH 明度 */
export function shiftLightness(hex, dL) {
  const [L, C, h] = hexToOklch(hex);
  return oklchToHex([clamp(L + dL, 0, 1), C, h]);
}

const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2.x 对比度 */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** 沿明度把 fg 推到与 bg 对比度 ≥ min（taste-skill 的 muted 修正同款思路）；推不到返回 null */
export function nudgeToContrast(fg, bg, min) {
  if (contrast(fg, bg) >= min) return fg;
  const [L, C, h] = hexToOklch(fg);
  const dir = luminance(bg) > 0.18 ? -1 : 1;
  for (let step = 1; step <= 100; step += 1) {
    const cand = oklchToHex([clamp(L + dir * step * 0.01, 0, 1), C, h]);
    if (contrast(cand, bg) >= min) return cand;
  }
  return null;
}

/* ---------------- 皮肤 schema ---------------- */

export const SKIN_FORMAT_VERSION = 1;
export const MODES = ['dark', 'light'];

/** 必填种子：底 / 面板 / 正文 / 次要文字 / 交互色 / 交互色上的字 */
export const REQUIRED_SEEDS = ['bg', 'surface', 'ink', 'muted', 'accent', 'accentInk'];
/** 可选种子：高亮笔（选中/标记填充）与状态色；缺省由派生补全 */
export const OPTIONAL_SEEDS = ['mark', 'markInk', 'success', 'warning', 'error', 'info'];
export const SEED_KEYS = [...REQUIRED_SEEDS, ...OPTIONAL_SEEDS];

export const RADIUS_PRESETS = {
  sharp: { sm: '3px', base: '4px', lg: '6px', xl: '8px', '2xl': '10px', '3xl': '14px' },
  soft: { sm: '6px', base: '8px', lg: '12px', xl: '16px', '2xl': '20px', '3xl': '28px' },
  round: { sm: '8px', base: '10px', lg: '16px', xl: '20px', '2xl': '24px', '3xl': '32px' },
};
export const BUTTON_SHAPES = ['solid', 'pill', 'tonal'];
export const MOTION_LEVELS = ['full', 'reduced'];

/** 字体目录：皮肤只能从这里选（离线桌面端，字体须随包自托管或用系统字体） */
const CJK_SANS = "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB'";
export const FONT_CATALOG = {
  geist: { name: 'Geist', role: 'sans', stack: `'Geist Variable', 'Geist', ${CJK_SANS}, system-ui, sans-serif` },
  'system-sans': { name: '系统无衬线', role: 'sans', stack: `system-ui, -apple-system, 'Segoe UI', ${CJK_SANS}, sans-serif` },
  'system-serif': {
    name: '系统衬线',
    role: 'serif',
    stack: "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', Georgia, serif",
  },
  'geist-mono': {
    name: 'Geist Mono',
    role: 'mono',
    stack: `'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, ${CJK_SANS}, monospace`,
  },
  'system-mono': { name: '系统等宽', role: 'mono', stack: `ui-monospace, 'SF Mono', Menlo, Consolas, ${CJK_SANS}, monospace` },
};

/** 默认状态色（未给出时按档取，保证对比度后再写入） */
const STATUS_DEFAULTS = {
  dark: { success: '#4ade80', warning: '#fbbf24', error: '#f87171', info: '#7dd3fc' },
  light: { success: '#15803d', warning: '#a16207', error: '#b91c1c', info: '#0369a1' },
};

/** 对比度门槛（taste-skill system.md：正文 7:1，次要 4.5:1；交互色要当链接文字用故 4.5:1） */
export const CONTRAST_RULES = [
  { a: 'ink', b: 'bg', min: 7, label: '正文 / 底' },
  { a: 'ink', b: 'surface', min: 4.5, label: '正文 / 面板' },
  { a: 'muted', b: 'bg', min: 4.5, label: '次要文字 / 底' },
  { a: 'accent', b: 'bg', min: 4.5, label: '交互色 / 底' },
  { a: 'accentInk', b: 'accent', min: 4.5, label: '主按钮文字 / 交互色' },
  { a: 'markInk', b: 'mark', min: 4.5, label: '高亮文字 / 高亮色' },
];
const STATUS_MIN = 3;

/**
 * 表面阶梯可分辨性（规范 §3.1 v1.1）：工作台的四个菜单承载层
 * shell / workbench / sunken / base 两两 OKLab 明度差必须 ≥ SURFACE_MIN_GAP，
 * 否则相邻菜单「糊成一块」——这是 v1.1 用户反馈的直接成因。
 * 注意：不要求全 7 层严格单调——taste 亮色档 bg 是纯白天花板，surface/scene/overlay
 * 必然挤在 0.94–1.0 窄区间，物理上塞不下 7 个可分辨层；浮层另靠 box-shadow 辅助。
 * scene 与 overlay 是同档浮层，单独要求 ≥ SCENE_MIN_GAP，避免撞色。
 * 与 semantic.json 表面公式同源；这里复算供 checkSkin 构建/编辑器共用。
 */
export const SURFACE_MIN_GAP = 0.012;
export const SCENE_MIN_GAP = 0.005;
export const SURFACE_LADDER = ['shell', 'workbench', 'sunken', 'base'];
function surfaceLadderVars(s, vars) {
  return {
    shell: vars['--skin-deep'],
    workbench: mixHex(vars['--skin-deep'], s.bg, 0.5),
    sunken: mixHex(s.bg, s.surface, 0.5),
    base: s.bg,
    scene: vars['--skin-scene'],
    overlay: mixHex(s.surface, vars['--skin-high'], 0.5),
  };
}
/** 返回菜单层撞色 / scene-overlay 撞色的违例；无违例返回空数组 */
export function checkSurfaceLadder(skin) {
  const issues = [];
  for (const mode of MODES) {
    const s = completeSeeds(skin.modes[mode], mode);
    const v = surfaceLadderVars(s, skinVars(skin, mode));
    for (let i = 0; i < SURFACE_LADDER.length; i++)
      for (let j = i + 1; j < SURFACE_LADDER.length; j++) {
        const a = SURFACE_LADDER[i], b = SURFACE_LADDER[j];
        const gap = Math.abs(hexToOklch(v[a])[0] - hexToOklch(v[b])[0]);
        if (gap < SURFACE_MIN_GAP)
          issues.push({ level: 'error', mode, pair: [a, b], label: `菜单层 ${a}/${b}`, ratio: gap, min: SURFACE_MIN_GAP });
      }
    const sceneGap = Math.abs(hexToOklch(v.scene)[0] - hexToOklch(v.overlay)[0]);
    if (sceneGap < SCENE_MIN_GAP)
      issues.push({ level: 'error', mode, pair: ['scene', 'overlay'], label: '场景/浮层撞色', ratio: sceneGap, min: SCENE_MIN_GAP });
  }
  return issues;
}

/**
 * 解析并校验一份皮肤 JSON。返回 { skin, errors }；errors 非空即不可用。
 * 只做结构校验；对比度见 checkSkin。
 */
export function parseSkin(raw) {
  const errors = [];
  const src = typeof raw === 'string' ? safeJson(raw, errors) : raw;
  if (!src || typeof src !== 'object') return { skin: null, errors: errors.length ? errors : ['皮肤必须是 JSON 对象'] };

  const id = String(src.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(id)) errors.push('id 只能是 2–48 位小写字母/数字/连字符');
  const name = String(src.name ?? '').trim();
  if (!name) errors.push('name 必填');

  const modes = {};
  for (const mode of MODES) {
    const m = src.modes?.[mode];
    if (!m || typeof m !== 'object') {
      errors.push(`modes.${mode} 必填（每个皮肤都要有暗色和亮色两档）`);
      continue;
    }
    const seeds = {};
    for (const k of REQUIRED_SEEDS) {
      if (!isHex(m[k])) errors.push(`modes.${mode}.${k} 必须是 #rrggbb`);
      else seeds[k] = m[k].trim().toLowerCase();
    }
    for (const k of OPTIONAL_SEEDS) {
      if (m[k] === undefined) continue;
      if (!isHex(m[k])) errors.push(`modes.${mode}.${k} 必须是 #rrggbb`);
      else seeds[k] = m[k].trim().toLowerCase();
    }
    modes[mode] = seeds;
  }

  const type = { display: 'geist', text: 'geist', mono: 'geist-mono', ...(src.type ?? {}) };
  for (const k of ['display', 'text', 'mono']) {
    if (!FONT_CATALOG[type[k]]) errors.push(`type.${k} 必须是 ${Object.keys(FONT_CATALOG).join(' / ')} 之一`);
  }
  const shape = { radius: 'soft', buttons: 'solid', ...(src.shape ?? {}) };
  if (!RADIUS_PRESETS[shape.radius]) errors.push('shape.radius 必须是 sharp / soft / round');
  if (!BUTTON_SHAPES.includes(shape.buttons)) errors.push(`shape.buttons 必须是 ${BUTTON_SHAPES.join(' / ')}`);
  const motion = src.motion ?? 'full';
  if (!MOTION_LEVELS.includes(motion)) errors.push('motion 必须是 full / reduced');

  if (errors.length) return { skin: null, errors };
  return {
    skin: {
      format: SKIN_FORMAT_VERSION,
      id,
      name,
      author: src.author ? String(src.author) : undefined,
      description: src.description ? String(src.description) : undefined,
      source: src.source ? String(src.source) : undefined,
      modes,
      type: { display: type.display, text: type.text, mono: type.mono },
      shape: { radius: shape.radius, buttons: shape.buttons },
      motion,
    },
    errors: [],
  };
}

function safeJson(text, errors) {
  try {
    return JSON.parse(text);
  } catch (e) {
    errors.push(`JSON 解析失败：${e.message}`);
    return null;
  }
}

/** 补全可选种子：mark 缺省 = accent；状态色缺省按档，并推到对比度合格 */
export function completeSeeds(seeds, mode) {
  const out = { ...seeds };
  if (!out.mark) out.mark = out.accent;
  if (!out.markInk) out.markInk = out.mark === out.accent ? out.accentInk : pickInk(out.mark, out.bg, out.ink);
  for (const k of ['success', 'warning', 'error', 'info']) {
    if (!out[k]) out[k] = nudgeToContrast(STATUS_DEFAULTS[mode][k], out.bg, STATUS_MIN) ?? STATUS_DEFAULTS[mode][k];
  }
  return out;
}

/** 在 bg / ink 中挑与 fill 对比度更高的作文字色 */
function pickInk(fill, bg, ink) {
  return contrast(bg, fill) >= contrast(ink, fill) ? bg : ink;
}

/** 对比度体检。返回 issues：level=error 不可保存；warn 仅提示 */
export function checkSkin(skin) {
  const issues = [];
  for (const mode of MODES) {
    const s = completeSeeds(skin.modes[mode], mode);
    for (const r of CONTRAST_RULES) {
      const ratio = contrast(s[r.a], s[r.b]);
      if (ratio < r.min) issues.push({ level: 'error', mode, pair: [r.a, r.b], label: r.label, ratio, min: r.min });
    }
    for (const k of ['success', 'warning', 'error', 'info']) {
      const ratio = contrast(s[k], s.bg);
      if (ratio < STATUS_MIN) issues.push({ level: 'warn', mode, pair: [k, 'bg'], label: `状态色 ${k} / 底`, ratio, min: STATUS_MIN });
    }
  }
  issues.push(...checkSurfaceLadder(skin));
  return issues;
}

/* ---------------- 派生：皮肤 → --skin-* 变量 ---------------- */

/**
 * 某一档的全部 --skin-* 变量（种子 + 框架色 + 字体 + 圆角）。
 * 框架色（JS 推导，用户不必管）：
 *   deep   —— 最外框 / 壳层（比底更沉）
 *   high   —— 最高浮层（模态/提示）的表面
 *   scrim  —— 模态遮罩
 *   shadow —— 投影色
 *   signature —— 品牌字形色：高亮笔色与底对比 ≥3 时用它，否则回落交互色
 */
export function skinVars(skin, mode) {
  const s = completeSeeds(skin.modes[mode], mode);
  const dark = mode === 'dark';
  // v1.1：暗色从 bg 下压 0.035（不变）；亮色种子 bg 是纯白明度天花板，
  // 从 bg 下压会让 shell 挤在 sunken 附近，改从 surface 下压 0.03 拉开工作台菜单梯度。
  const deep = dark ? shiftLightness(s.bg, -0.035) : shiftLightness(s.surface, -0.03);
  const high = dark ? shiftLightness(s.surface, 0.06) : mixHex(s.surface, '#ffffff', 0.85);
  const vars = {
    '--skin-bg': s.bg,
    '--skin-surface': s.surface,
    '--skin-ink': s.ink,
    '--skin-muted': s.muted,
    '--skin-accent': s.accent,
    '--skin-accent-ink': s.accentInk,
    '--skin-mark': s.mark,
    '--skin-mark-ink': s.markInk,
    '--skin-signature': contrast(s.mark, s.bg) >= 3 ? s.mark : s.accent,
    '--skin-success': s.success,
    '--skin-warning': s.warning,
    '--skin-error': s.error,
    '--skin-info': s.info,
    '--skin-deep': deep,
    '--skin-high': high,
    // v1.1：scene 明度按档定向，避免亮色档与 overlay 撞色（semantic.json 直接引用）
    '--skin-scene': dark ? mixHex(s.bg, s.surface, 0.4) : mixHex(s.bg, s.surface, 0.7),
    '--skin-scrim': dark ? `${deep}c7` : `${s.ink}59`,
    '--skin-shadow': dark ? '#00000080' : `${s.ink}1f`,
    '--skin-font-display': FONT_CATALOG[skin.type.display].stack,
    '--skin-font-text': FONT_CATALOG[skin.type.text].stack,
    '--skin-font-mono': FONT_CATALOG[skin.type.mono].stack,
    '--skin-button-radius': skin.shape.buttons === 'pill' ? '9999px' : RADIUS_PRESETS[skin.shape.radius].base,
  };
  for (const [k, v] of Object.entries(RADIUS_PRESETS[skin.shape.radius])) vars[`--skin-radius-${k}`] = v;
  return vars;
}

const decls = (vars, indent = '  ') =>
  Object.entries(vars)
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join('\n');

/**
 * 皮肤 → CSS 文本。selector 为暗色档选择器（亮色档自动追加 [data-theme-type='light']）。
 * 例：skinCss(skin, `html[data-skin='${skin.id}']`)
 */
export function skinCss(skin, selector) {
  const lightSel = selector
    .split(',')
    .map((s) => `${s.trim()}[data-theme-type='light']`)
    .join(',\n');
  return `${selector} {\n  color-scheme: dark;\n${decls(skinVars(skin, 'dark'))}\n}\n${lightSel} {\n  color-scheme: light;\n${decls(skinVars(skin, 'light'))}\n}\n`;
}

/** <html> 上应挂的形态属性（ThemeService 与独立入口共用） */
export function skinAttributes(skin) {
  return { 'data-skin': skin.id, 'data-buttons': skin.shape.buttons, 'data-radius': skin.shape.radius, 'data-motion': skin.motion };
}
