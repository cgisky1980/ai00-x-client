import { create } from 'zustand';

interface SandboxCreationState {
  isVisible: boolean;
  sessionName: string;
  phase: 'detecting' | 'staging' | 'creating-worktree' | 'finalizing';
  onCancel: (() => void) | null;
}

interface SandboxCreationActions {
  show: (sessionName: string, onCancel: () => void) => void;
  updatePhase: (phase: SandboxCreationState['phase']) => void;
  hide: () => void;
}

type SandboxCreationStore = SandboxCreationState & SandboxCreationActions;

const initialState: SandboxCreationState = {
  isVisible: false,
  sessionName: '',
  phase: 'detecting',
  onCancel: null,
};

export const useSandboxCreationStore = create<SandboxCreationStore>((set) => ({
  ...initialState,
  show: (sessionName, onCancel) =>
    set({ isVisible: true, sessionName, phase: 'detecting', onCancel }),
  updatePhase: (phase) => set({ phase }),
  hide: () => set(initialState),
}));
