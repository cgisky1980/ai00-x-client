import { create } from 'zustand';
import { ThemeConfig, ThemeId, ThemeMetadata, ThemeSelectionId } from '../types';
import { themeService } from '../core/ThemeService';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ThemeStore');

interface ThemeState {
  currentTheme: ThemeConfig | null;
  currentThemeId: ThemeSelectionId | null;
  themes: ThemeMetadata[];
  loading: boolean;
  error: string | null;
  accentHue: number;
  accentOverride: boolean;

  initialize: () => Promise<void>;
  setTheme: (themeId: ThemeSelectionId) => Promise<void>;
  setAccentHue: (hue: number) => Promise<void>;
  clearAccentOverride: () => Promise<void>;
  refreshThemes: () => void;
  addTheme: (theme: ThemeConfig) => Promise<void>;
  removeTheme: (themeId: ThemeId) => Promise<void>;
  exportTheme: (themeId: ThemeId) => any;
}

export const useThemeStore = create<ThemeState>((set) => ({
  currentTheme: null,
  currentThemeId: null,
  themes: [],
  loading: false,
  error: null,
  accentHue: themeService.getAccentHue(),
  accentOverride: themeService.isAccentOverride(),

  initialize: async () => {
    set({ loading: true, error: null });

    try {
      themeService.on('theme:after-change', () => {
        set({
          currentTheme: themeService.getCurrentTheme(),
          currentThemeId: themeService.getCurrentThemeId(),
          accentHue: themeService.getAccentHue(),
          accentOverride: themeService.isAccentOverride(),
        });
      });

      themeService.on('theme:register', () => {
        const themes = themeService.getThemeList();
        set({ themes });
      });

      themeService.on('theme:unregister', () => {
        const themes = themeService.getThemeList();
        set({ themes });
      });

      await themeService.initialize();

      const themes = themeService.getThemeList();

      set({
        themes,
        loading: false,
        currentTheme: themeService.getCurrentTheme(),
        currentThemeId: themeService.getCurrentThemeId(),
        accentHue: themeService.getAccentHue(),
        accentOverride: themeService.isAccentOverride(),
      });
    } catch (error) {
      log.error('Failed to initialize', error);
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to initialize theme system',
      });
    }
  },

  setTheme: async (themeId: ThemeSelectionId) => {
    set({ loading: true, error: null });

    try {
      await themeService.applyTheme(themeId);
      set({ loading: false });
    } catch (error) {
      log.error('Failed to switch theme', { themeId, error });
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to switch theme',
      });
    }
  },

  setAccentHue: async (hue: number) => {
    // 立即更新 store 状态，避免滑条跳动
    set({
      accentHue: hue,
      accentOverride: true,
    });
    try {
      await themeService.setAccentHue(hue);
    } catch (error) {
      log.error('Failed to set accent hue', { hue, error });
    }
  },

  clearAccentOverride: async () => {
    try {
      await themeService.clearAccentOverride();
      set({
        accentHue: themeService.getAccentHue(),
        accentOverride: false,
      });
    } catch (error) {
      log.error('Failed to clear accent override', error);
    }
  },

  refreshThemes: () => {
    const themes = themeService.getThemeList();
    set({ themes });
  },

  addTheme: async (theme: ThemeConfig) => {
    set({ loading: true, error: null });

    try {
      themeService.registerTheme(theme);
      const themes = themeService.getThemeList();

      set({
        themes,
        loading: false,
      });
    } catch (error) {
      log.error('Failed to add theme', error);
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to add theme',
      });
    }
  },

  removeTheme: async (themeId: ThemeId) => {
    set({ loading: true, error: null });

    try {
      const success = themeService.unregisterTheme(themeId);

      if (success) {
        const themes = themeService.getThemeList();
        set({
          themes,
          loading: false,
        });
      } else {
        set({
          loading: false,
          error: 'Failed to delete theme',
        });
      }
    } catch (error) {
      log.error('Failed to remove theme', { themeId, error });
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to remove theme',
      });
    }
  },

  exportTheme: (themeId: ThemeId) => {
    return themeService.exportTheme(themeId);
  },
}));
