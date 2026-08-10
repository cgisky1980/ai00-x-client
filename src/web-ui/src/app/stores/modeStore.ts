import { create } from 'zustand';
import { useTerminalSceneStore } from './terminalSceneStore';

export type AppMode = 'code' | 'task' | 'wallpaper' | 'music';

interface ModeStore {
  activeMode: AppMode;
  /** Remember the last active chat sessionId for each mode, so switching back restores context. */
  lastSessionByMode: Partial<Record<AppMode, string>>;
  /** Switch to a new mode. */
  setActiveMode: (mode: AppMode) => void;
  /** Save the current sessionId for the active mode (called before switching). */
  saveCurrentSession: (sessionId: string) => void;
  /** Get the sessionId to restore for a given mode. */
  getRestoreSession: (mode: AppMode) => string | undefined;
}

export const useModeStore = create<ModeStore>((set, get) => ({
  activeMode: 'task',
  lastSessionByMode: {},

  setActiveMode: (mode) => {
    const { activeMode } = get();
    if (activeMode !== mode) {
      useTerminalSceneStore.getState().setActiveSession(null);
    }
    set({ activeMode: mode });
  },

  saveCurrentSession: (sessionId) => {
    const { activeMode, lastSessionByMode } = get();
    set({
      lastSessionByMode: {
        ...lastSessionByMode,
        [activeMode]: sessionId,
      },
    });
  },

  getRestoreSession: (mode) => {
    const { lastSessionByMode } = get();
    return lastSessionByMode[mode];
  },
}));
