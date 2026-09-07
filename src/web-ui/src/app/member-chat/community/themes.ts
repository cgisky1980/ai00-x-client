/**
 * themes — 个人主页主题引擎（P2A）
 *
 * 主题 = 布局骨架（hero/minimal/editorial）+ token 载荷 JSON。
 * 服务端 profile_themes 表为 SSOT；此处提供：
 * - ThemePayload 类型与兜底（服务器不可达时用默认松烟主题渲染）
 * - applyThemeVars(resolver)：payload → [data-profile-root] 容器级 CSS 变量（--pt-*）
 * - 纹理/装饰的 CSS 生成（grain/dots/grid + seal/pixel/sticker 落在容器伪元素/角标）
 *
 * 设计约束：主题只作用于主页容器，不外溢应用界面；正文对比度底线由 schema 值域保证
 * （curated 色板，非自由 CSS）。
 */
import type { CSSProperties } from 'react';

export type ProfileLayout = 'hero' | 'minimal' | 'editorial';

export interface ThemePayload {
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;
  /** solid | dashed | double */
  borderStyle: string;
  accent: string;
  accentText: string;
  bannerBg: string;
  /** 0..1 遮罩强度（封面图压暗） */
  bannerOverlay: number;
  /** 大标题字体：serif | sans */
  fontDisplay: 'serif' | 'sans';
  /** none | sm | base | lg */
  radius: string;
  /** none | grain | dots | grid */
  texture: string;
  /** none | seal | pixel | sticker */
  decoration: string;
  monoData: boolean;
}

export const DEFAULT_THEME_SLUG = 'songyan';

/** 离线兜底：默认松烟主题（与迁移 027 种子同值） */
export const FALLBACK_THEME: ProfileTheme = {
  slug: DEFAULT_THEME_SLUG,
  name: '松烟',
  layout: 'hero',
  price_credits: 0,
  owned: true,
  applied: false,
  payload: {
    bg: '#242729',
    surface: '#2b2f33',
    text: '#f0f2f4',
    textMuted: '#9aa3ab',
    border: '#3a4046',
    borderStyle: 'solid',
    accent: '#60a5fa',
    accentText: '#0b1220',
    bannerBg: '#1c2023',
    bannerOverlay: 0.35,
    fontDisplay: 'serif',
    radius: 'base',
    texture: 'grain',
    decoration: 'none',
    monoData: true,
  },
};

export interface ProfileTheme {
  slug: string;
  name: string;
  layout: ProfileLayout;
  price_credits: number;
  owned: boolean;
  applied: boolean;
  payload: ThemePayload;
}

const RADIUS_MAP: Record<string, string> = {
  none: '0px',
  sm: '6px',
  base: '10px',
  lg: '16px',
};

/** payload → 容器级 CSS 变量（组件样式全部消费 --pt-*） */
export function themeVars(theme: ProfileTheme): CSSProperties {
  const p = theme.payload;
  return {
    '--pt-bg': p.bg,
    '--pt-surface': p.surface,
    '--pt-text': p.text,
    '--pt-text-muted': p.textMuted,
    '--pt-border': p.border,
    '--pt-border-style': p.borderStyle,
    '--pt-accent': p.accent,
    '--pt-accent-text': p.accentText,
    '--pt-banner': p.bannerBg,
    '--pt-banner-overlay': String(p.bannerOverlay),
    '--pt-font-display':
      p.fontDisplay === 'serif'
        ? "var(--font-family-serif, 'Ai00 X Serif', serif)"
        : 'var(--font-family-sans)',
    '--pt-radius': RADIUS_MAP[p.radius] ?? '10px',
    '--pt-mono': p.monoData ? 'var(--font-family-mono)' : 'inherit',
  } as CSSProperties;
}

/** 容器背景（纹理层用 background-image 实现，避免覆盖 background-color） */
export function textureImage(payload: ThemePayload): string | undefined {
  switch (payload.texture) {
    case 'grain':
      return (
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='0.06'/%3E%3C/svg%3E\")"
      );
    case 'dots':
      return 'radial-gradient(rgba(128,128,128,0.18) 1px, transparent 1px)';
    case 'grid':
      return 'linear-gradient(rgba(128,200,220,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(128,200,220,0.08) 1px, transparent 1px)';
    default:
      return undefined;
  }
}

/** 纹理 background-size */
export function textureSize(payload: ThemePayload): string | undefined {
  switch (payload.texture) {
    case 'dots':
      return '14px 14px';
    case 'grid':
      return '28px 28px';
    default:
      return undefined;
  }
}

/** 从列表解析出「当前应用主题」（applied 优先，缺省松烟兜底） */
export function resolveAppliedTheme(themes: ProfileTheme[] | null): ProfileTheme {
  if (themes && themes.length > 0) {
    const applied = themes.find((t) => t.applied);
    if (applied) return applied;
  }
  return FALLBACK_THEME;
}
