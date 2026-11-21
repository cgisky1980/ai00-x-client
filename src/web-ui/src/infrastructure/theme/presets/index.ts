/**
 * 明暗档 + 皮肤 → ThemeConfig（JS 侧消费者用：xterm / Monaco / MiniApp / Mermaid）。
 *
 * 规范 v1.0：CSS 是唯一事实来源（tokens.css 的 color-mix 公式 + 皮肤种子）。这里用同一套
 * 种子与 OKLab 混合在 JS 里算出字面色值，供拿不到 CSS 变量的场景（canvas 终端、编辑器主题）。
 * 不再有手写的 dark/light 预设对象。
 */
import { completeSeeds, mixHex, skinVars, RADIUS_PRESETS, FONT_CATALOG, type Skin, type SkinMode } from '@ai00-x/design-system/skin';
import type { ThemeConfig, ThemeId } from '../types';

export const DEFAULT_LIGHT_THEME_ID: ThemeId = 'ai00-x-light';
export const DEFAULT_DARK_THEME_ID: ThemeId = 'ai00-x-dark';
export const DEFAULT_THEME_ID: ThemeId = DEFAULT_LIGHT_THEME_ID;
export const BUILTIN_THEME_IDS: readonly ThemeId[] = [DEFAULT_LIGHT_THEME_ID, DEFAULT_DARK_THEME_ID];

/** 主题 id → 明暗档 */
export function modeOfThemeId(id: ThemeId): SkinMode {
  return id === DEFAULT_LIGHT_THEME_ID ? 'light' : 'dark';
}

/** 跟随系统时的明暗档 */
export function getSystemPreferredDefaultThemeId(): ThemeId {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return DEFAULT_LIGHT_THEME_ID;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? DEFAULT_DARK_THEME_ID
    : DEFAULT_LIGHT_THEME_ID;
}

/** 历史主题 id（裁撤的多风格预设）→ 同明暗档 */
export const LEGACY_BUILTIN_THEME_FALLBACK: Record<string, ThemeId> = {
  'ai00-x-slate': DEFAULT_DARK_THEME_ID,
  'ai00-x-midnight': DEFAULT_DARK_THEME_ID,
  'ai00-x-china-night': DEFAULT_DARK_THEME_ID,
  'ai00-x-cyber': DEFAULT_DARK_THEME_ID,
  'ai00-x-china-style': DEFAULT_LIGHT_THEME_ID,
};

/** 8 位 hex 透明度：#rrggbb + alpha(0..1) */
const alpha = (hex: string, a: number) =>
  `${hex}${Math.round(Math.min(1, Math.max(0, a)) * 255)
    .toString(16)
    .padStart(2, '0')}`;

/** 与 tokens/semantic.json 的公式一一对应（改公式两边一起改） */
export function themeConfigFromSkin(skin: Skin, mode: SkinMode): ThemeConfig {
  const s = completeSeeds(skin.modes[mode], mode);
  const dark = mode === 'dark';
  const v = skinVars(skin, mode);
  const deep = v['--skin-deep'];
  const high = v['--skin-high'];
  const r = RADIUS_PRESETS[skin.shape.radius];
  const ink = (a: number) => alpha(s.ink, a);

  return {
    id: dark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID,
    name: `${skin.name} · ${dark ? '暗色' : '亮色'}`,
    type: mode,
    description: skin.description,
    author: skin.author,
    version: String(skin.format),
    colors: {
      background: {
        primary: s.bg,
        secondary: mixHex(s.bg, s.surface, 0.5),
        tertiary: s.surface,
        quaternary: mixHex(s.surface, high, 0.5),
        elevated: high,
        workbench: mixHex(deep, s.bg, 0.5),
        scene: mixHex(s.bg, s.surface, 0.6),
        tooltip: high,
      },
      text: {
        primary: s.ink,
        secondary: mixHex(s.ink, s.muted, 0.45),
        muted: s.muted,
        disabled: mixHex(s.muted, s.bg, 0.45),
      },
      accent: {
        50: mixHex(s.bg, s.mark, 0.06),
        100: mixHex(s.bg, s.mark, 0.12),
        200: mixHex(s.bg, s.mark, 0.22),
        300: mixHex(s.bg, s.accent, 0.5),
        400: mixHex(s.ink, s.accent, 0.85),
        500: s.accent,
        600: mixHex(s.bg, s.accent, 0.82),
        700: mixHex(s.bg, s.accent, 0.7),
        800: mixHex(s.bg, s.accent, 0.58),
      },
      semantic: {
        success: s.success,
        successBg: alpha(s.success, 0.12),
        successBorder: alpha(s.success, 0.32),
        warning: s.warning,
        warningBg: alpha(s.warning, 0.12),
        warningBorder: alpha(s.warning, 0.32),
        error: s.error,
        errorBg: alpha(s.error, 0.12),
        errorBorder: alpha(s.error, 0.32),
        info: s.info,
        infoBg: alpha(s.info, 0.12),
        infoBorder: alpha(s.info, 0.32),
        highlight: mixHex(s.muted, s.ink, 0.7),
        highlightBg: alpha(s.mark, 0.28),
      },
      border: { subtle: ink(0.09), base: ink(0.14), medium: ink(0.22), strong: ink(0.32), prominent: ink(0.48) },
      element: { subtle: ink(0.04), soft: ink(0.06), base: ink(0.08), medium: ink(0.12), strong: ink(0.17), elevated: ink(0.07) },
      git: {
        branch: s.muted,
        branchBg: alpha(s.muted, 0.1),
        changes: s.warning,
        changesBg: alpha(s.warning, 0.1),
        added: s.success,
        addedBg: alpha(s.success, 0.1),
        deleted: s.error,
        deletedBg: alpha(s.error, 0.1),
        staged: s.success,
        stagedBg: alpha(s.success, 0.1),
      },
      scrollbar: { thumb: ink(0.2), thumbHover: ink(0.34) },
      overlay: { overlay: v['--skin-scrim'], modalOverlay: v['--skin-scrim'] },
    },
    effects: {
      shadow: {
        xs: '0 1px 2px var(--skin-shadow)',
        sm: '0 2px 4px var(--skin-shadow)',
        base: '0 4px 10px var(--skin-shadow)',
        lg: '0 8px 20px var(--skin-shadow)',
        xl: '0 14px 32px var(--skin-shadow)',
        '2xl': '0 20px 48px var(--skin-shadow)',
      },
      glow: { blue: 'var(--glow-shadow-blue)', purple: 'var(--glow-shadow-purple)', mixed: 'var(--glow-shadow-mixed)' },
      blur: {
        subtle: 'blur(4px) saturate(1.05)',
        base: 'blur(8px) saturate(1.1)',
        medium: 'blur(12px) saturate(1.2)',
        strong: 'blur(16px) saturate(1.3) brightness(1.1)',
        intense: 'blur(20px) saturate(1.4) brightness(1.15)',
      },
      radius: { sm: r.sm, base: r.base, lg: r.lg, xl: r.xl, '2xl': r['2xl'], full: '9999px' },
      spacing: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 8: '32px', 10: '40px', 12: '48px', 16: '64px' },
      opacity: { disabled: 0.6, hover: 0.8, focus: 0.9, overlay: 0.4 },
    },
    motion: {
      duration: { instant: '0.1s', fast: '0.15s', base: '0.3s', slow: '0.6s', lazy: '1s' },
      easing: {
        standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
        decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
        accelerate: 'cubic-bezier(0.4, 0, 1, 1)',
        bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
    },
    typography: {
      font: { sans: FONT_CATALOG[skin.type.text].stack, mono: FONT_CATALOG[skin.type.mono].stack },
      weight: { normal: 400, medium: 500, semibold: 600, bold: 600 },
      size: { xs: '12px', sm: '13px', base: '14px', lg: '15px', xl: '16px', '2xl': '18px', '3xl': '22px', '4xl': '26px', '5xl': '32px' },
      lineHeight: { tight: 1.2, base: 1.5, relaxed: 1.6 },
    },
  };
}
