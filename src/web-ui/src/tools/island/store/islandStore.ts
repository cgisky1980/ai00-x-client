import { create } from 'zustand'
import { Music, Palette, Waves } from 'lucide-react'
import type React from 'react'

export type IslandState = 'compact' | 'expanded'
export type IslandPopup = 'none' | 'music' | 'sfx'

export interface Activity {
  id: string
  priority: number
  visible: boolean
  icon: React.ElementType
  labelKey: string
}

const DEFAULT_ACTIVITIES: Activity[] = [
  {
    id: 'music',
    priority: 10,
    visible: true,
    icon: Music,
    labelKey: 'island.activity.music',
  },
  {
    id: 'sfx',
    priority: 7,
    visible: true,
    icon: Waves,
    labelKey: 'island.activity.sfx',
  },
  {
    id: 'theme',
    priority: 5,
    visible: true,
    icon: Palette,
    labelKey: 'island.activity.theme',
  },
]

interface IslandStore {
  state: IslandState
  popups: IslandPopup[]
  activities: Activity[]
  activeActivityId: string

  setState: (s: IslandState) => void
  openPopup: (p: IslandPopup) => void
  closePopup: (p: IslandPopup) => void
  isPopupOpen: (p: IslandPopup) => boolean
  registerActivity: (a: Activity) => void
  unregisterActivity: (id: string) => void
  setActiveActivity: (id: string) => void
  setActivityVisible: (id: string, visible: boolean) => void
}

export const useIslandStore = create<IslandStore>((set, get) => ({
  state: 'compact',
  popups: [],
  activities: DEFAULT_ACTIVITIES,
  activeActivityId: 'music',

  setState: (s) => set({ state: s }),
  openPopup: (p) =>
    set((s) =>
      s.popups.includes(p) ? s : { popups: [...s.popups, p] },
    ),
  closePopup: (p) =>
    set((s) => ({ popups: s.popups.filter((x) => x !== p) })),
  isPopupOpen: (p) => get().popups.includes(p),
  registerActivity: (a) =>
    set((s) => {
      const activities = [...s.activities.filter((x) => x.id !== a.id), a]
      activities.sort((x, y) => y.priority - x.priority)
      const visible = activities.filter((x) => x.visible)
      const activeId = visible.some((x) => x.id === s.activeActivityId)
        ? s.activeActivityId
        : visible[0]?.id ?? s.activeActivityId
      return { activities, activeActivityId: activeId }
    }),
  unregisterActivity: (id) =>
    set((s) => {
      const activities = s.activities.filter((x) => x.id !== id)
      const visible = activities.filter((x) => x.visible)
      const activeId =
        s.activeActivityId === id
          ? visible[0]?.id ?? 'music'
          : s.activeActivityId
      return { activities, activeActivityId: activeId }
    }),
  setActiveActivity: (id) => set({ activeActivityId: id }),
  setActivityVisible: (id, visible) =>
    set((s) => ({
      activities: s.activities.map((a) =>
        a.id === id ? { ...a, visible } : a
      ),
    })),
}))
