import { create } from 'zustand'

export type IslandState = 'compact' | 'expanded'
export type IslandPopup = 'none' | 'music' | 'sfx'

interface IslandStore {
  state: IslandState
  popups: IslandPopup[]

  setState: (s: IslandState) => void
  openPopup: (p: IslandPopup) => void
  closePopup: (p: IslandPopup) => void
  isPopupOpen: (p: IslandPopup) => boolean
}

export const useIslandStore = create<IslandStore>((set, get) => ({
  state: 'compact',
  popups: [],

  setState: (s) => set({ state: s }),
  openPopup: (p) =>
    set((s) =>
      s.popups.includes(p) ? s : { popups: [...s.popups, p] },
    ),
  closePopup: (p) =>
    set((s) => ({ popups: s.popups.filter((x) => x !== p) })),
  isPopupOpen: (p) => get().popups.includes(p),
}))
