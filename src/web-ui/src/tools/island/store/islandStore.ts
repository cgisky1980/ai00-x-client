import { create } from 'zustand'
import { ISLAND_ROWS, isIslandRowId, type IslandRowId } from '../islandRows'

export type IslandState = 'compact' | 'expanded'

/** 单行的用户配置：是否启用 + 排序权重 */
export interface IslandRowConfig {
  enabled: boolean
  order: number
}

export type IslandRowConfigMap = Record<IslandRowId, IslandRowConfig>

const STORAGE_KEY = 'ai00-x:island-rows'

function defaultRowConfig(): IslandRowConfigMap {
  const map = {} as IslandRowConfigMap
  for (const row of ISLAND_ROWS) {
    map[row.id] = { enabled: row.defaultEnabled, order: row.defaultOrder }
  }
  return map
}

function loadRowConfig(): IslandRowConfigMap {
  const base = defaultRowConfig()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const key of Object.keys(parsed)) {
      if (!isIslandRowId(key)) continue
      const cfg = parsed[key]
      if (!cfg || typeof cfg !== 'object') continue
      const c = cfg as Record<string, unknown>
      if (typeof c.enabled === 'boolean') base[key].enabled = c.enabled
      if (typeof c.order === 'number' && Number.isFinite(c.order)) {
        base[key].order = c.order
      }
    }
  } catch {
    // 存储不可用或脏数据 → 用默认配置
  }
  return base
}

function persistRowConfig(map: IslandRowConfigMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 隐私模式 / 配额满 → 仅内存生效
  }
}

// 音乐/音效弹层已升级为独立「乐」窗口（music-window），islandStore 管理
// 岛的展开态、全屏避让、行的开关与排序；原 popups 机制已退役。
interface IslandStore {
  state: IslandState
  setState: (s: IslandState) => void
  // 前台应用全屏/最大化时为 true：岛收成贴边细线，不打扰（阶段 2 全屏避让）
  occluded: boolean
  setOccluded: (v: boolean) => void
  // 行开关与排序（阶段 3 模块化）
  rowConfig: IslandRowConfigMap
  setRowEnabled: (id: IslandRowId, enabled: boolean) => void
  setRowOrder: (id: IslandRowId, order: number) => void
  resetRowConfig: () => void
}

export const useIslandStore = create<IslandStore>((set) => ({
  state: 'compact',
  setState: (s) => set({ state: s }),
  occluded: false,
  setOccluded: (v) => set({ occluded: v }),
  rowConfig: loadRowConfig(),
  setRowEnabled: (id, enabled) =>
    set((s) => {
      const next = {
        ...s.rowConfig,
        [id]: { ...s.rowConfig[id], enabled },
      }
      persistRowConfig(next)
      return { rowConfig: next }
    }),
  setRowOrder: (id, order) =>
    set((s) => {
      const next = {
        ...s.rowConfig,
        [id]: { ...s.rowConfig[id], order },
      }
      persistRowConfig(next)
      return { rowConfig: next }
    }),
  resetRowConfig: () => {
    const next = defaultRowConfig()
    persistRowConfig(next)
    set({ rowConfig: next })
  },
}))
