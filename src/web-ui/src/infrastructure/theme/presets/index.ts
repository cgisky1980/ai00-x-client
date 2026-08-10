 

export { Ai00XDarkTheme } from './dark-theme';
export { ai00xLightTheme } from './light-theme';
export { ai00xMidnightTheme } from './midnight-theme';
export { ai00xChinaStyleTheme } from './china-style-theme';
export { ai00xChinaNightTheme } from './china-night-theme';
export { ai00xCyberTheme } from './cyber-theme';
export { ai00xSlateTheme } from './slate-theme';

import { Ai00XDarkTheme } from './dark-theme';
import { ai00xLightTheme } from './light-theme';
import { ai00xMidnightTheme } from './midnight-theme';
import { ai00xChinaStyleTheme } from './china-style-theme';
import { ai00xChinaNightTheme } from './china-night-theme';
import { ai00xCyberTheme } from './cyber-theme';
import { ai00xSlateTheme } from './slate-theme';
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

 
export const builtinThemes: ThemeConfig[] = [
  ai00xLightTheme,
  ai00xSlateTheme,
  Ai00XDarkTheme,
  ai00xMidnightTheme,
  ai00xChinaStyleTheme,
  ai00xChinaNightTheme,
  ai00xCyberTheme,
];

 



