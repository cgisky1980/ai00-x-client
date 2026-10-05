import { create } from 'zustand';
import { ThemeConfig, ThemeId, ThemeMetadata, ThemeSelectionId } from '../types';
import { themeService } from '../core/ThemeService';
import { createLogger } from '@/shared/utils/logger';
import {
  DEFAULT_STYLE_PACK_ID,
  stylePacks,
  type StylePackId,
  type StylePackMeta,
} from '@ai00-x/design-system/packs-meta';

const log = createLogger('ThemeStore');

/** 风格包元信息（构建期生成，规范第九节） */
export const stylePackList: StylePackMeta[] = [...stylePacks];

/** initialize 幂等守卫：重复调用会重复注册 themeService 事件监听（启动引导与 useTheme 挂载都会调） */
let initializePromise: Promise<void> | null = null;

interface ThemeState {
  currentTheme: ThemeConfig | null;
  currentThemeId: ThemeSelectionId | null;
  themes: ThemeMetadata[];
  /** 风格包（第二正交轴）：当前选择 + 可选清单 */
  stylePackId: StylePackId;
  stylePacks: StylePackMeta[];
  loading: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  setTheme: (themeId: ThemeSelectionId) => Promise<void>;
  setStylePack: (stylePackId: StylePackId) => Promise<void>;
  refreshThemes: () => void;
  addTheme: (theme: ThemeConfig) => Promise<void>;
  removeTheme: (themeId: ThemeId) => Promise<void>;
  exportTheme: (themeId: ThemeId) => any;
}

export const useThemeStore = create<ThemeState>((set) => ({
  currentTheme: null,
  currentThemeId: null,
  themes: [],
  stylePackId: DEFAULT_STYLE_PACK_ID,
  stylePacks: stylePackList,
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

        themeService.on('style:after-change', () => {
          set({ stylePackId: themeService.getStylePackId() });
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
          stylePackId: themeService.getStylePackId(),
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

  setStylePack: async (stylePackId: StylePackId) => {
    set({ loading: true, error: null });

    try {
      await themeService.applyStylePack(stylePackId);
      set({ stylePackId: themeService.getStylePackId(), loading: false });
    } catch (error) {
      log.error('Failed to switch style pack', { stylePackId, error });
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to switch style pack',
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
