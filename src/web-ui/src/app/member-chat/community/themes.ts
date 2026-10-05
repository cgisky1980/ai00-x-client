/**
 * themes — 个人主页主题皮肤（v5：颜色全部在 CSS 里）
 *
 * ── 这一版为什么把颜色搬进 CSS ──────────────────────────
 * 目标：**以后写扩展主题 = 只写一段 CSS**。
 * v4 之前颜色是「DB 里的 9 个种子 → palette.ts 推导 16 个值 → JS 注入
 * --pt-*」，代价是：加一套配色要写迁移、改白名单、改三处测试常量表。
 * 现在每个皮肤块在 community.scss 里自带完整色板，本模块只剩两件事：
 *   1. 把 payload.style 透传成 data-style（SCSS 靠它分支）
 *   2. 主题的商店元信息（slug / name / price）与皮肤解耦
 *
 * 推导线（palette.ts）保留，但**降级为校验器**：tests/skinContrast.test.ts
 * 扫 community.scss 里每个 [data-style] 块，校验 15 个色值的对比度红线。
 * 手写色值 + CI 把关，比运行时推导更好维护，也不会在首屏闪一下。
 *
 * ── 加一套新皮肤（照着做就行）──────────────────────────
 *   1. community.scss 里加一个 .community-profile2[data-style='xxx'] { … } 块，
 *      声明 15 个 --pt-* 色值 + 6 个 --pt-cover-* + 5 个皮肤变量
 *   2. （可选）DB 加一行主题元信息，payload.style = 'xxx'
 *   3. 跑 pnpm test（skinContrast 会校验新皮肤），然后 pnpm run preview:profile 看效果
 *   不用改 themes.ts、不用改测试常量表、不用改 H5。
 */
import type { CSSProperties } from 'react';

export type ProfileLayout = 'hero' | 'minimal' | 'editorial';

/** 皮肤标识 —— 任意字符串都透传，由 community.scss 决定长什么样 */
export type ThemeStyle = string;

/**
 * 皮肤白名单只用于**兜底**：SCSS 里没有对应 [data-style] 块时回落到 minimal。
 * 不做硬校验 —— 扩展主题不该被这里的数组拦住。
 */
export const FALLBACK_STYLE = 'minimal';

export interface ThemePayload {
  /** 皮肤标识（唯一还需要 payload 承载的字段） */
  style: ThemeStyle;
}

export const DEFAULT_THEME_SLUG = 'xuanzhi';

export interface ProfileTheme {
  slug: string;
  name: string;
  /** 商店分类标签（纯展示） */
  layout: ProfileLayout;
  price_credits: number;
  owned: boolean;
  applied: boolean;
  style: ThemeStyle;
}

/** 离线兜底：宣纸（与迁移 035 的 xuanzhi 一致） */
export const FALLBACK_THEME: ProfileTheme = {
  slug: DEFAULT_THEME_SLUG,
  name: '宣纸',
  layout: 'minimal',
  price_credits: 0,
  owned: true,
  applied: false,
  style: FALLBACK_STYLE,
};

/** 皮肤 → 容器 data-* 属性（SCSS 靠属性选择器分支，不靠 JS 条件渲染） */
export function styleAttrs(style: ThemeStyle): Record<string, string> {
  return { 'data-style': style };
}

/**
 * 主题容器上的 inline 变量 —— **刻意为空**。
 *
 * 以前这里会把 palette 推导结果注入 --pt-*（themeVars）。现在色板由
 * [data-style] 块自己声明，JS 不再参与配色，所以容器上不需要任何 inline
 * 变量。保留这个函数是为了让调用点（ProfileView / ThemeShop）读起来
 * 仍然对称，且将来真需要 per-instance 覆盖（比如作品取色晕染）时有位置。
 */
export function themeVars(overrides?: Record<string, string>): CSSProperties {
  return (overrides ?? {}) as CSSProperties;
}

/** 从主题列表解析「当前应用主题」（applied 优先，缺省回落到兜底主题） */
export function resolveAppliedTheme(themes: ProfileTheme[] | null): ProfileTheme {
  if (themes && themes.length > 0) {
    const applied = themes.find((t) => t.applied);
    if (applied) return applied;
    // 老用户可能持有已下架主题（迁移 035 删掉了 6 套）：按 slug 回落到兜底
    const known = themes.find((t) => t.slug === DEFAULT_THEME_SLUG);
    if (known) return known;
  }
  return FALLBACK_THEME;
}