/**
 * Theme system exports.
 */

// Types
export * from './types';

// Presets
export * from './presets';

// Core service
export {
  ThemeService,
  themeService,
  STYLE_PACK_STORAGE_KEY,
  THEME_SELECTION_STORAGE_KEY,
} from './core/ThemeService';

// Integrations
export { monacoThemeSync } from './integrations/MonacoThemeSync';

// State
export { useThemeStore, stylePackList } from './store/themeStore';

// 风格包（规范第九节）：注册表直接透出，供设置页枚举
export {
  stylePacks,
  stylePackTokens,
  resolveStylePackTokens,
  DEFAULT_STYLE_PACK_ID,
} from '@ai00-x/design-system/packs-meta';
export type { StylePackId, StylePackMeta, StylePackTokenMap } from '@ai00-x/design-system/packs-meta';

// React hooks
export {
  useTheme,
  useThemeConfig,
  useThemeColors,
  useThemeEffects,
  useThemeManagement,
  useThemeToggle,
} from './hooks/useTheme';

export { ThemeSelector } from './components/ThemeSelector';


