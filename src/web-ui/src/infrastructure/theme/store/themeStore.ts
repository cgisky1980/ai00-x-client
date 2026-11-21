import { create } from 'zustand';
import type { Skin } from '@ai00-x/design-system/skin';
import { DEFAULT_SKIN_ID } from '@ai00-x/design-system/skin';
import { ThemeConfig, ThemeMetadata, ThemeSelectionId } from '../types';
import { themeService } from '../core/ThemeService';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ThemeStore');

/** initialize 幂等守卫：重复调用会重复注册 themeService 事件监听 */
let initializePromise: Promise<void> | null = null;

interface ThemeState {
  currentTheme: ThemeConfig | null;
  currentThemeId: ThemeSelectionId | null;
  /** 明暗两档 */
  themes: ThemeMetadata[];
  /** 皮肤：当前 id + 全部（内置在前、用户在后） */
  skinId: string;
  skins: Skin[];
  loading: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  setTheme: (themeId: ThemeSelectionId) => Promise<void>;
  setSkin: (skinId: string) => Promise<void>;
  refreshThemes: () => void;
}

const snapshot = () => ({
  currentTheme: themeService.getCurrentTheme(),
  currentThemeId: themeService.getCurrentThemeId(),
  themes: themeService.getThemeList(),
  skinId: themeService.getSkinId(),
  skins: themeService.getSkins(),
});

export const useThemeStore = create<ThemeState>((set) => ({
  currentTheme: null,
  currentThemeId: null,
  themes: [],
  skinId: DEFAULT_SKIN_ID,
  skins: [],
  loading: false,
  error: null,

  initialize: async () => {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      set({ loading: true, error: null });
      try {
        for (const ev of ['theme:after-change', 'skin:after-change', 'skin:register', 'skin:unregister'] as const) {
          themeService.on(ev, () => set(snapshot()));
        }
        await themeService.initialize();
        set({ ...snapshot(), loading: false });
      } catch (error) {
        initializePromise = null;
        log.error('Failed to initialize', error);
        set({ loading: false, error: error instanceof Error ? error.message : 'Failed to initialize theme system' });
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
      set({ loading: false, error: error instanceof Error ? error.message : 'Failed to switch theme' });
    }
  },

  setSkin: async (skinId: string) => {
    set({ loading: true, error: null });
    try {
      await themeService.applySkin(skinId);
      set({ ...snapshot(), loading: false });
    } catch (error) {
      log.error('Failed to switch skin', { skinId, error });
      set({ loading: false, error: error instanceof Error ? error.message : 'Failed to switch skin' });
    }
  },

  refreshThemes: () => set(snapshot()),
}));
