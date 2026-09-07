import { create } from 'zustand';
import { ThemeConfig, ThemeId, ThemeMetadata, ThemeSelectionId } from '../types';
import { themeService } from '../core/ThemeService';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ThemeStore');

/** initialize 幂等守卫：重复调用会重复注册 themeService 事件监听（启动引导与 useTheme 挂载都会调） */
let initializePromise: Promise<void> | null = null;

interface ThemeState {
  currentTheme: ThemeConfig | null;
  currentThemeId: ThemeSelectionId | null;
  themes: ThemeMetadata[];
  loading: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  setTheme: (themeId: ThemeSelectionId) => Promise<void>;
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

  initialize: async () => {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      set({ loading: true, error: null });

      try {
        themeService.on('theme:after-change', () => {
          set({
            currentTheme: themeService.getCurrentTheme(),
            currentThemeId: themeService.getCurrentThemeId(),
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

        // themeService.initialize 幂等（内部有 initPromise 守卫），此处重复调用为 no-op
        await themeService.initialize();

        const themes = themeService.getThemeList();

        set({
          themes,
          loading: false,
          currentTheme: themeService.getCurrentTheme(),
          currentThemeId: themeService.getCurrentThemeId(),
        });
      } catch (error) {
        // 失败后清空守卫，允许下次（如设置页挂载 useTheme 时）重试
        initializePromise = null;
        log.error('Failed to initialize', error);
        set({
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to initialize theme system',
        });
      }
    })();
    return initializePromise;
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
