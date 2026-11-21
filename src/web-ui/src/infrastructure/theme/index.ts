/**
 * Theme system exports（规范 v1.0：皮肤 × 明暗）
 */
export * from './types';
export * from './presets';
export { ThemeService, themeService, SKIN_STORAGE_KEY, THEME_SELECTION_STORAGE_KEY } from './core/ThemeService';
export { monacoThemeSync } from './integrations/MonacoThemeSync';
export { useThemeStore } from './store/themeStore';
export { builtinSkins, DEFAULT_SKIN_ID } from '@ai00-x/design-system/skin';
export type { Skin, SkinMode, SkinSeeds, SkinIssue } from '@ai00-x/design-system/skin';
export {
  useTheme,
  useThemeConfig,
  useThemeColors,
  useThemeEffects,
  useThemeToggle,
} from './hooks/useTheme';
export { ThemeSelector } from './components/ThemeSelector';
