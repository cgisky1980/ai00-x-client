import { create } from 'zustand';

export type FocusedPanel = 'main-panel' | 'settings-dialog' | null;

interface OverlayControlState {
  mainPanelVisible: boolean;
  focusedPanel: FocusedPanel;
  settingsDialogVisible: boolean;
  setMainPanelVisible: (visible: boolean) => void;
  setFocusedPanel: (panel: FocusedPanel) => void;
  setSettingsDialogVisible: (visible: boolean) => void;
  toggleMainPanel: () => void;
}

export const useOverlayControlStore = create<OverlayControlState>((set) => ({
  mainPanelVisible: true,
  focusedPanel: 'main-panel',
  settingsDialogVisible: false,

  setMainPanelVisible: (visible) => set({ mainPanelVisible: visible }),
  setFocusedPanel: (panel) => set({ focusedPanel: panel }),
  setSettingsDialogVisible: (visible) => set({ settingsDialogVisible: visible }),

  toggleMainPanel: () =>
    set((state) => ({ mainPanelVisible: !state.mainPanelVisible })),
}));
