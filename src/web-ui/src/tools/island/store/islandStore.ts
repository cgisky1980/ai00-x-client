import { create } from 'zustand'

export type IslandState = 'compact' | 'expanded'

// 音乐/音效弹层已升级为独立「乐」窗口（music-window），islandStore 仅剩
// 动态岛展开态管理；原 popups 机制随 MusicPopup/SfxPopup 一并退役。
interface IslandStore {
  state: IslandState
  setState: (s: IslandState) => void
}

export const useIslandStore = create<IslandStore>((set) => ({
  state: 'compact',
  setState: (s) => set({ state: s }),
}))
