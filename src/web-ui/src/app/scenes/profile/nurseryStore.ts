import { create } from 'zustand';

export type NurseryPage = 'gallery' | 'template';

interface NurseryStoreState {
  page: NurseryPage;
  activeWorkspaceId: string | null;
  openGallery: () => void;
  openTemplate: () => void;
}

export const useNurseryStore = create<NurseryStoreState>((set) => ({
  page: 'gallery',
  activeWorkspaceId: null,
  openGallery: () => set({ page: 'gallery', activeWorkspaceId: null }),
  openTemplate: () => set({ page: 'template', activeWorkspaceId: null }),
}));
