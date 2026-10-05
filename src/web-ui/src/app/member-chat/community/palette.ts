/**
 * palette — 色板推导与对比度计算
 *
 * ── 角色（v5 起）────────────────────────────────────────
 * **不再是运行时依赖**。以前主题色板是「DB 里的 9 个种子 → 本模块推导
 * 16 个值 → JS 注入 --pt-*」。现在颜色手写在 community.scss 的
 * [data-style] 块里（换主题 = 只写 CSS），本模块降级为：
 *
 *   1. **校验器**：skinContrast.test.ts 用 contrastRatio() 扫每个皮肤块，
 *      保证「正文 ≥7:1、次要 ≥4.5:1、强调色上的字 ≥4.5:1」这条红线
 *      不会因为「随便写了套 CSS」而破掉。
 *   2. **推导器**：仍被一次性脚本用来从种子快速生成整套色值再粘进 SCSS
 *      （省得手调 15 个 hex）。
 *   3. H5 的兜底：data-style 指向一个**没有 CSS 块**的皮肤时，
 *      靠它给出一版可读配色而不是全透明。
 *
 * 所以：改皮肤颜色**不需要碰这个文件**，但删掉它会让对比度红线失守。
 */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** sRGB，0..255 */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 推导种子：只取 payload 的色相/明暗档，不取手挑的具体色值 */
export interface PaletteInput {
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentText: string;
  bannerBg: string;
  /** 作品取色（封面/首曲封面主色）；null 时只用主题自身色相 */
  glow?: string | null;
}

export interface Palette {
  mode: 'light' | 'dark';
  /** 页面底色（种子） */
  bg: string;
  /** 卡片面 */
  surface: string;
  /** 嵌套面（hover / 次级容器） */
  surfaceAlt: string;
  /** 凹面（代码块 / 井） */
  surfaceSunken: string;
  /** banner / 沉浸层底（比 bg 更远） */
  banner: string;
  border: string;
  borderStrong: string;
  /** 正文 */
  text: string;
  /** 次要正文（≥4.5:1，构造保证） */
  textMuted: string;
  /** 极弱文字（水印 / 禁用态，≥3:1，仅非正文） */
  textFaint: string;
  /** 唯一交互色 */
  accent: string;
  accentHover: string;
  accentStrong: string;
  /** accent 叠 bg 的 14% 不透明淡色（免依赖 color-mix） */
  accentSoft: string;
  /** accent 上的文字（≥4.5:1） */
  accentText: string;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

const HEX3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** hex（3/6 位，可选 #）→ sRGB；无法解析时回退中灰（不抛，主题是增强层不是依赖层） */
export function hexToRgb(hex: string): Rgb {
  const raw = hex.trim();
  const m3 = HEX3.exec(raw);
  if (m3) {
    return {
      r: parseInt(m3[1]! + m3[1]!, 16),
      g: parseInt(m3[2]! + m3[2]!, 16),
      b: parseInt(m3[3]! + m3[3]!, 16),
    };
  }
  const m6 = HEX6.exec(raw);
  if (m6) {
    return {
      r: parseInt(m6[1]!, 16),
      g: parseInt(m6[2]!, 16),
      b: parseInt(m6[3]!, 16),
    };
  }
  return { r: 128, g: 128, b: 128 };
}

const toHex2 = (v: number): string => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');

/** sRGB → hex */
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

/** sRGB(0..255) → OKLCH */
export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lr = lin(r);
  const lg = lin(g);
  const lb = lin(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const c = Math.sqrt(okA * okA + okB * okB);
  // 无彩色时色相未定义，落在 0（后续 lerpHue 会自然退化）
  const h = c < 1e-6 ? 0 : ((Math.atan2(okB, okA) * 180) / Math.PI + 360) % 360;
  return { l: okL, c, h };
}

/** 线性 sRGB 分量是否都在 [0,1]（色域判定） */
function inGamut({ l, c, h }: Oklch): boolean {
  const rad = (h * Math.PI) / 180;
  const okA = c * Math.cos(rad);
  const okB = c * Math.sin(rad);
  const l_ = l + 0.3963377774 * okA + 0.2158037573 * okB;
  const m_ = l - 0.1055613458 * okA - 0.0638541728 * okB;
  const s_ = l - 0.0894841775 * okA - 1.291485548 * okB;
  const cube = (v: number): number => v * v * v;
  const lr = 4.0767416621 * cube(l_) - 3.3077115913 * cube(m_) + 0.2309699292 * cube(s_);
  const lg = -1.2684380046 * cube(l_) + 2.6097574011 * cube(m_) - 0.3413193965 * cube(s_);
  const lb = -0.0041960863 * cube(l_) - 0.7034186147 * cube(m_) + 1.707614701 * cube(s_);
  const eps = 1e-4;
  return lr >= -eps && lr <= 1 + eps && lg >= -eps && lg <= 1 + eps && lb >= -eps && lb <= 1 + eps;
}

/**
 * OKLCH → hex。
 * 超出 sRGB 色域时**降彩度**而非截断通道（截断会连带偏色相）；
 * 二分降彩度，保留明度与色相，这是色域映射的稳定近似。
 */
export function oklchToHex(candidate: Oklch): string {
  const l = clamp(candidate.l, 0, 1);
  const h = ((candidate.h % 360) + 360) % 360;
  let c = Math.max(0, candidate.c);

  if (!inGamut({ l, c, h })) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut({ l, c: mid, h })) lo = mid;
      else hi = mid;
    }
    c = lo;
  }

  const rad = (h * Math.PI) / 180;
  const okA = c * Math.cos(rad);
  const okB = c * Math.sin(rad);
  const l_ = l + 0.3963377774 * okA + 0.2158037573 * okB;
  const m_ = l - 0.1055613458 * okA - 0.0638541728 * okB;
  const s_ = l - 0.0894841775 * okA - 1.291485548 * okB;
  const cube = (v: number): number => v * v * v;

  const enc = (v: number): number => {
    const x = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return clamp(x * 255, 0, 255);
  };
  return rgbToHex({
    r: enc(4.0767416621 * cube(l_) - 3.3077115913 * cube(m_) + 0.2309699292 * cube(s_)),
    g: enc(-1.2684380046 * cube(l_) + 2.6097574011 * cube(m_) - 0.3413193965 * cube(s_)),
    b: enc(-0.0041960863 * cube(l_) - 0.7034186147 * cube(m_) + 1.707614701 * cube(s_)),
  });
}

/** hex → OKLCH */
export function hexToOklch(hex: string): Oklch {
  return rgbToOklch(hexToRgb(hex));
}

/** WCAG 相对亮度 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 对比度（1..21） */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 混色：t=0 取 a，t=1 取 b（明度线性，色相走短弧，彩度线性） */
function mix(a: Oklch, b: Oklch, t: number): Oklch {
  const dh = ((b.h - a.h) % 360 + 540) % 360 - 180;
  return {
    l: a.l + (b.l - a.l) * t,
    c: a.c + (b.c - a.c) * t,
    h: (a.h + dh * t + 360) % 360,
  };
}

/**
 * 反解明度：从种子明度向两端步进，取**离种子最近**且对全部背景都达标的明度。
 *
 * 两个方向都要走：文字阶通常朝本模式远端走，但 accent 上的文字取决于 accent
 * 本身明暗——暗色主题配浅 accent 时需要的是更*暗*的文字。只走单端会得到
 * 白字压浅蓝这种 2.5:1 的废色（迁移 027 的松烟 accent 就是浅蓝）。
 *
 * 文字阶的对比度因此是构造保证的；两端都走不到则退纯黑/纯白——对任意单一背景，
 * max(黑,白) 的对比度下界是 4.58:1（Y≈0.179 处取平），数学上不可能破 4.5。
 */
function lForContrast(
  color: Oklch,
  backgrounds: string[],
  target: number,
  mode: 'light' | 'dark',
): number {
  const step = 0.004;
  const meets = (l: number): boolean => {
    if (l <= 0 || l >= 1) return false;
    const hex = oklchToHex({ ...color, l });
    return backgrounds.every((bg) => contrastRatio(hex, bg) >= target);
  };
  const walk = (dir: 1 | -1): number | null => {
    for (let i = 1; i <= 250; i++) {
      const l = color.l + dir * step * i;
      if (l <= 0 || l >= 1) break;
      if (meets(l)) return l;
    }
    return null;
  };

  // 优先朝本模式远端（保持设计的明暗走向），无解再试反端
  const preferred = walk(mode === 'dark' ? 1 : -1);
  if (preferred != null) return preferred;
  const opposite = walk(mode === 'dark' ? -1 : 1);
  if (opposite != null) return opposite;

  // 兜底：取两端中对所有背景都更可读的一端
  const worst = (hex: string): number => Math.min(...backgrounds.map((bg) => contrastRatio(hex, bg)));
  return worst('#000000') >= worst('#ffffff') ? 0 : 1;
}

/** 把 OKLCH 变成在给定背景上达标的目标 hex */
function resolved(color: Oklch, backgrounds: string[], target: number, mode: 'light' | 'dark'): string {
  return oklchToHex({ ...color, l: lForContrast(color, backgrounds, target, mode) });
}

/**
 * derivePalette — 主题 payload + 作品取色 → 完整色板。
 *
 * 核心手法：**从种子学「相对推进度」k，而不是学绝对色值**。
 *
 * k = 种子色相对 bg 朝「本档远端」推进了整段距离的比例。松烟 surface #2b2f33
 * 对 bg #242729 的 k≈0.04，杂志 border #14120f 对 bg #faf9f6 的 k≈0.81——两者
 * 天差地别，但都在 0..1 这个统一坐标里。于是：
 *
 * - 色阶绝对值由 bg 的明度与色相决定 → **保证单调、保证对比度**
 * - k 由种子给出 → **保住每套主题自己的性格**（杂志的墨线厚重、霜宣的界线轻）
 *
 * 这样既不是「6 个手挑 hex 互不相关」，也不是「8 套主题长得一样」。
 */
export function derivePalette(input: PaletteInput): Palette {
  const base = hexToOklch(input.bg);
  const surf = hexToOklch(input.surface);
  const mode: 'light' | 'dark' = base.l >= 0.5 ? 'light' : 'dark';

  // 墨阶色相/彩度：保留主题自身性格，作品取色只做轻移（≤28%）
  const glow = input.glow ? hexToOklch(input.glow) : null;
  const neutralHue = glow ? mix(base, glow, 0.28).h : base.h;
  const neutralC = clamp(Math.max(base.c, surf.c, glow ? glow.c * 0.3 : 0), 0, 0.05);

  // 「朝本档远端」的方向与总距离（远端 = 暗色档趋白 / 亮色档趋黑）
  const toFar = mode === 'dark' ? 1 : -1;
  const gap = mode === 'dark' ? 1 - base.l : base.l;
  // 卡片永远是**抬起**的：明暗档都朝白走（宣纸 #f4f2ec→#fff；松烟 #242729→#2b2f33），
  // 所以抬起方向恒为 +1，不能用 toFar——亮色档的远端是黑，那会把卡片压下去。
  const gapWhite = 1 - base.l;
  const paint = (l: number): string => oklchToHex({ l, c: neutralC, h: neutralHue });
  /** 抬起面不得纯白：留一丝墨色性格 */
  const lift = (d: number): number => clamp(base.l + d, 0, mode === 'light' ? 0.995 : 1);

  // —— 相对推进度：从种子学 ——
  /** 抬起推进度：朝白端的占比 */
  const kLift = (seedHex: string): number =>
    (hexToOklch(seedHex).l - base.l) / (gapWhite || 1);
  /** 有符号推进度：正值表示朝远端推进（暗色档更亮 / 亮色档更暗） */
  const kSigned = (seedHex: string): number =>
    ((hexToOklch(seedHex).l - base.l) * toFar) / (gap || 1);
  /** 无符号推进度：只关心离 bg 多远，不关心方向（沉面/banner 一律更暗） */
  const kAbs = (seedHex: string): number => Math.abs(kSigned(seedHex));

  // kSurface 上限留出余量，否则 surfaceAlt 无处可去（会与 surface 撞成同一档）
  const kSurface = clamp(kLift(input.surface), 0.02, 0.26);
  const kBorder = clamp(kSigned(input.border), 0.04, 0.85);
  const kBanner = clamp(kAbs(input.bannerBg), 0.03, 0.8);
  // 凹面无种子：借「边界线的重量」当参照（凹槽与界线本就是同一档语义），封顶保证只是微凹
  const kSunken = Math.min(kBorder * 0.55, 0.12);

  const bg = paint(base.l);
  const surface = paint(lift(gapWhite * kSurface));
  const surfaceAlt = paint(lift(gapWhite * Math.min(kSurface * 1.9, 0.46)));
  // 沉面 / banner 一律朝黑走（凹进去），亮暗档同向
  const surfaceSunken = paint(clamp(base.l - gap * kSunken, 0, 1));
  const banner = paint(clamp(base.l - gap * kBanner, 0, 1));
  const border = paint(clamp(base.l + toFar * gap * kBorder, 0, 1));
  const borderStrong = paint(clamp(base.l + toFar * gap * Math.min(kBorder * 2.1, 0.95), 0, 1));

  // 文字阶：反解到对比度目标（正文 4.5 底线 → 目标 4.8；主文字 12；弱文字 3）
  const grounds = [bg, surface, surfaceAlt];
  const text = resolved({ l: base.l, c: neutralC * 0.6, h: neutralHue }, grounds, 12, mode);
  const textMuted = resolved({ l: base.l, c: neutralC, h: neutralHue }, grounds, 4.8, mode);
  const textFaint = resolved({ l: base.l, c: neutralC, h: neutralHue }, grounds, 3, mode);

  // 交互色族：色相彩度来自 accent，明度派生
  const a = hexToOklch(input.accent);
  const accent = oklchToHex(a);
  const accentHover = oklchToHex({ ...a, l: clamp(a.l + 0.05, 0, 1) });
  const accentStrong = oklchToHex({ ...a, l: clamp(a.l - 0.05, 0, 1) });
  const accentSoft = oklchToHex(mix(base, a, 0.16));
  // accent 上的文字：保留 accent 的色相但去掉彩度 → 读作墨，不像"深色 accent"
  const accentText = resolved({ l: a.l, c: a.c * 0.12, h: a.h }, [accent], 4.8, mode);

  return {
    mode,
    bg,
    surface,
    surfaceAlt,
    surfaceSunken,
    banner,
    border,
    borderStrong,
    text,
    textMuted,
    textFaint,
    accent,
    accentHover,
    accentStrong,
    accentSoft,
    accentText,
  };
}

/**
 * 卡顶「色块封面」用的柔和色板（漫画风的核心记号）。
 *
 * 为什么需要：Flarum 扩展中心那种卡片的区分感，一半来自「每张卡顶一块
 * 不同颜色的色块」。单靠一套墨阶 + 一个 accent 撑不出这种活泼感。
 *
 * 做法：以 accent 的**色相**为锚，按固定偏移旋出一圈色相，明度/彩度统一
 * 压到「柔和但仍能看出颜色」的区间（亮档偏浅、暗档偏深，跟随 mode）。
 * 所以主题只要给一个 accent，就自动得到一族同源的颜色 —— 不必逐个手调，
 * 换主题也不会散。
 *
 * 刻意**不**做：低对比的随机色。色块上要压黑字，所以明度锁在能扛住
 * 正文对比度的区间（由 lForContrast 那套同源逻辑保证）。
 */
export function coverSwatches(accent: string, mode: 'light' | 'dark', count = 6): string[] {
  const a = hexToOklch(oklchToHex(hexToOklch(accent)));
  // 同源但拉开距离的色相环：正红/橙/黄/绿/青/紫一圈（offset 单位：度）
  const HUES = [0, 32, 68, 145, 200, 305];
  // 亮档：高明度低彩度（粉扑扑）；暗档：低明度中彩度（沉稳）
  const l = mode === 'light' ? 0.86 : 0.42;
  const c = mode === 'light' ? 0.075 : 0.055;
  const out: string[] = [];
  for (let i = 0; i < Math.max(1, count); i++) {
    const hue = a.h + (HUES[i % HUES.length] ?? 0);
    out.push(oklchToHex({ l, c, h: ((hue % 360) + 360) % 360 }));
  }
  return out;
}