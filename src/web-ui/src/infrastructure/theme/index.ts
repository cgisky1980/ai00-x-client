/**
 * Theme system exports.
 */

// Types
export * from './types';

// Presets
export * from './presets';

// Core service
export { ThemeService, themeService } from './core/ThemeService';

// Integrations
export { monacoThemeSync } from './integrations/MonacoThemeSync';

// State
export { useThemeStore } from './store/themeStore';

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
export { default as HueSlider } from './components/HueSlider';
export { generateAccentFromHue, hueFromAccentColor, DEFAULT_ACCENT_HUE } from './utils/accentGenerator';


