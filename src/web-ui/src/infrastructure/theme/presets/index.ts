 

export { Ai00XDarkTheme } from './dark-theme';
export { ai00xLightTheme } from './light-theme';

import { Ai00XDarkTheme } from './dark-theme';
import { ai00xLightTheme } from './light-theme';
import { ThemeConfig, ThemeId } from '../types';

/** Default light / dark builtin themes used when following system appearance. */
export const DEFAULT_LIGHT_THEME_ID: ThemeId = 'ai00-x-light';
export const DEFAULT_DARK_THEME_ID: ThemeId = 'ai00-x-dark';

/**
 * Picks ai00-x-dark vs ai00-x-light from `prefers-color-scheme`.
 * Used when the user has no saved theme preference.
 */
export function getSystemPreferredDefaultThemeId(): ThemeId {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return DEFAULT_LIGHT_THEME_ID;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? DEFAULT_DARK_THEME_ID
    : DEFAULT_LIGHT_THEME_ID;
}

/** Static fallback when system preference is unavailable (e.g. SSR). */
export const DEFAULT_THEME_ID: ThemeId = DEFAULT_LIGHT_THEME_ID;

/**
 * 规范 v0.7：预设主题仅明暗两档（墨/纸）。
 * 历史上曾存在 slate/midnight/china-style/china-night/cyber 五套多风格预设，
 * 2026-08-23 裁撤；此处映射保证老用户的已保存选择平滑落到同明暗档。
 */
export const LEGACY_BUILTIN_THEME_FALLBACK: Record<string, ThemeId> = {
  'ai00-x-slate': DEFAULT_DARK_THEME_ID,
  'ai00-x-midnight': DEFAULT_DARK_THEME_ID,
  'ai00-x-china-night': DEFAULT_DARK_THEME_ID,
  'ai00-x-cyber': DEFAULT_DARK_THEME_ID,
  'ai00-x-china-style': DEFAULT_LIGHT_THEME_ID,
};

 
export const builtinThemes: ThemeConfig[] = [
  ai00xLightTheme,
  Ai00XDarkTheme,
];
