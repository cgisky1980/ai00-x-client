import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

// Debug Tauri import
console.log("Tauri Core Import (Underlay):", { invoke });

import { Category, DesktopContextType, DesktopItem, GridItem } from "@underlay/desktop/types"
import { getIcons, setIcons } from "@underlay/lib/idb"
import { listGrid as idbListGrid, setGridItem as idbSetGridItem, removeGridItem as idbRemoveGridItem, listCategories as idbListCategories, setCategory as idbSetCategory, removeCategory as idbRemoveCategory } from "@underlay/lib/griddb"
import { storage } from "@underlay/lib/storage"

const Ctx = createContext<DesktopContextType | null>(null)

const KEY_CATS = "ai00.desktop.categories"
const KEY_GRID = "ai00.desktop.grid"
const KEY_GRID_COLS = "ai00.desktop.grid_cols"
const KEY_GRID_ROWS = "ai00.desktop.grid_rows"
const KEY_ITEMS_CACHE = "ai00.desktop.items_cache"
const KEY_DRAWER_OPEN = "ai00.desktop.drawer_open"
const CACHE_EXPIRY = 30 * 1000 // 30 seconds - short expiry to keep data fresh

export function UnderlayDesktopProvider({ children }: { children: React.ReactNode }) {
  const [allItems, setAllItems] = useState<DesktopItem[]>([])
  const [gridItems, setGridItems] = useState<GridItem[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [plugins, setPlugins] = useState<any[]>([])
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false)
  const channelRef = useRef<BroadcastChannel | null>(null)
  // 缓存网格尺寸供同步函数 findNextPosition 使用（storage.get 是异步的）
  const gridDimsRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })

  // Derive selection from gridItems - no need for separate state
  const selection = useMemo(() => gridItems.map(item => item.path), [gridItems])

  const refresh = useCallback(async (forceRefresh = false) => {
    try {
      let cachedItems: DesktopItem[] | null = null

      // Load from cache first for instant display (if not forcing refresh)
      if (!forceRefresh) {
        const cached = await storage.get(KEY_ITEMS_CACHE)
        if (cached) {
          try {
            const { items, timestamp } = JSON.parse(cached)
            if (Date.now() - timestamp < CACHE_EXPIRY) {
              const validItems = items.filter((item: DesktopItem) =>
                item && item.path && item.name
              )
              if (validItems.length > 0) {
                const iconMap = await getIcons(validItems.map((i: DesktopItem) => i.name))
                const merged = validItems.map((i: DesktopItem) => iconMap[i.name] ? { ...i, icon_base64: iconMap[i.name] } : i)
                cachedItems = merged
                setAllItems(merged)
              }
            }
          } catch {
            storage.remove(KEY_ITEMS_CACHE).catch(() => {})
          }
        }
      }

      // Always fetch from backend - backend data is source of truth
      if (!invoke) {
        console.error("Tauri invoke is undefined (Underlay). Skipping backend refresh.");
        return;
      }
      const backendItems = await invoke<DesktopItem[]>("get_desktop_items")

      // Compare with cached data
      const backendJSON = JSON.stringify(backendItems)
      const cachedJSON = cachedItems ? JSON.stringify(cachedItems) : null

      // Update state and cache only if data changed
      if (backendJSON !== cachedJSON) {
        const toSave: { name: string; icon_base64: string }[] = backendItems.filter((i: DesktopItem) => i.icon_base64 && i.name).map((i: DesktopItem) => ({ name: i.name, icon_base64: i.icon_base64 as string }))
        if (toSave.length) await setIcons(toSave)
        const iconMap = await getIcons(backendItems.map((i: DesktopItem) => i.name))
        const merged = backendItems.map((i: DesktopItem) => iconMap[i.name] && !i.icon_base64 ? { ...i, icon_base64: iconMap[i.name] } : i)
        setAllItems(merged)
        const slim = merged.map((i: DesktopItem) => ({ path: i.path, name: i.name }))
        await storage.setJson(KEY_ITEMS_CACHE, {
          items: slim,
          timestamp: Date.now()
        })
      }
    } catch (err) {
      console.error('Failed to refresh desktop items:', err)
    }
  }, [])

  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    refresh()

    channelRef.current = new BroadcastChannel("ai00.desktop")
    channelRef.current.onmessage = (ev) => {
      const data = ev.data
      if (!data || typeof data !== "object") return
      if (data.type === "drawer_open") {
        setDrawerOpen(!!data.open)
      } else if (data.type === "grid_add" && typeof data.path === "string") {
        setGridItems((prev) => {
          if (prev.find((i) => i.path === data.path)) return prev

          const extra = (data as any).extra
          const p = findNextPosition(prev, { w: extra?.w ?? 1, h: extra?.h ?? 1 })
          const item: GridItem = { path: data.path, x: p ? p.x : 1, y: p ? p.y : 2, w: extra?.w ?? 1, h: extra?.h ?? 1, kind: extra?.kind ?? "shortcut" }
          idbSetGridItem(item).catch(() => { })
          return [...prev, item]
        })

        const meta = allItems.find((i) => i.path === data.path)
        if (meta && !meta.icon_base64) {
          getIcons([meta.name]).then((m) => {
            const v = m[meta.name]
            if (!v) return
            setAllItems((prev) => prev.map((it) => it.path === meta.path ? { ...it, icon_base64: v } : it))
          }).catch(() => { })
        }
      } else if (data.type === "grid_remove" && typeof data.path === "string") {
        idbRemoveGridItem(data.path).catch(() => { })
        setGridItems((prev) => prev.filter((i) => i.path !== data.path))
      }
    }

    let unlistenDrawer: (() => void) | null = null
    let unlistenAdd: (() => void) | null = null
    let unlistenRemove: (() => void) | null = null
    try {
      listen("desktop://drawer_open", (e) => {
        const payload = e.payload as any
        setDrawerOpen(!!payload?.open)
      }).then((fn) => { unlistenDrawer = fn })
      listen("desktop://grid_add", (e) => {
        const payload = e.payload as any
        const p = payload?.path
        if (typeof p !== "string") return

        setGridItems((prev) => {
          if (prev.find((i) => i.path === p)) return prev
          const extra = payload?.extra
          const pos = findNextPosition(prev, { w: extra?.w ?? 1, h: extra?.h ?? 1 })
          const item: GridItem = {
            path: p,
            x: pos ? pos.x : 1,
            y: pos ? pos.y : 2,
            w: extra?.w ?? 1,
            h: extra?.h ?? 1,
            kind: extra?.kind ?? "shortcut"
          }
          idbSetGridItem(item).catch(() => { })
          return [...prev, item]
        })

        const meta = allItems.find((i) => i.path === p)
        if (meta && !meta.icon_base64) {
          getIcons([meta.name]).then((m) => {
            const v = m[meta.name]
            if (!v) return
            setAllItems((prev) => prev.map((it) => it.path === meta.path ? { ...it, icon_base64: v } : it))
          }).catch(() => { })
        }
      }).then((fn) => { unlistenAdd = fn })
      listen("desktop://grid_remove", (e) => {
        const payload = e.payload as any
        const p = payload?.path
        if (typeof p !== "string") return
        idbRemoveGridItem(p).catch(() => { })
        setGridItems((prev) => prev.filter((i) => i.path !== p))
      }).then((fn) => { unlistenRemove = fn })
    } catch { }

    // Load categories (async via storage adapter)
    const init = async () => {
      let loadedCategories: Category[] = []
      const c = await storage.get(KEY_CATS)
      if (c) {
        try {
          loadedCategories = JSON.parse(c)
        } catch { }
      }

      // If storage failed, try loading from IndexedDB
      if (loadedCategories.length === 0) {
        try {
          const idbCats = await idbListCategories()
          if (idbCats.length > 0) {
            loadedCategories = idbCats
            // Sync back to storage
            await storage.setJson(KEY_CATS, idbCats)
          }
        } catch {}
      }
      setCategories(loadedCategories)

      // Load drawer_open
      const d = await storage.get(KEY_DRAWER_OPEN)
      if (d) {
        try {
          const v = JSON.parse(d)
          setDrawerOpen(!!v)
        } catch { }
      }

      // Load grid dims cache for findNextPosition
      const colsStr = await storage.get(KEY_GRID_COLS)
      const rowsStr = await storage.get(KEY_GRID_ROWS)
      gridDimsRef.current = {
        cols: parseInt(colsStr || '0'),
        rows: parseInt(rowsStr || '0'),
      }

      // Load grid items (selection is derived from grid)
      idbListGrid().then(async (arr) => {
        let grid = (Array.isArray(arr) ? arr : []) as GridItem[]
          
          // Filter out orphaned category blocks
          const validIds = new Set(loadedCategories.map(c => c.id))
          grid = grid.filter(item => {
            if (item.kind === "category") {
              const exists = validIds.has(item.path)
              if (!exists) {
                idbRemoveGridItem(item.path).catch(() => {})
              }
              return exists
            }
            return true
          })

          // Ensure System Monitor widget exists
          if (!grid.find(i => i.path === "system-monitor")) {
             const pos = findNextPosition(grid, { w: 4, h: 4 })
             if (pos) {
               const monitorItem: GridItem = {
                 path: "system-monitor",
                 x: pos.x,
                 y: pos.y,
                 w: 4,
                 h: 4,
                 kind: "widget",
                 locked: false
               }
               grid.push(monitorItem)
               idbSetGridItem(monitorItem).catch(() => {})
             }
          } else {
            // 兼容升级：强制 System Monitor 为 4x4
            const existing = grid.find(i => i.path === "system-monitor")
            if (existing && (existing.w !== 4 || existing.h !== 4)) {
              existing.w = 4
              existing.h = 4
              idbSetGridItem(existing).catch(() => {})
            }
          }

          // Ensure Clock Widget exists (4x4 for donut + stats + heatmap)
          if (!grid.find(i => i.path === "clock-widget")) {
            const pos = findNextPosition(grid, { w: 4, h: 4 })
            if (pos) {
              const clockItem: GridItem = {
                path: "clock-widget",
                x: pos.x,
                y: pos.y,
                w: 4,
                h: 4,
                kind: "widget",
                locked: false
              }
              grid.push(clockItem)
              idbSetGridItem(clockItem).catch(() => {})
            }
          } else {
            // 兼容升级：旧版 clock-widget 统一到 4x4
            const existing = grid.find(i => i.path === "clock-widget")
            if (existing && (existing.w !== 4 || existing.h !== 4)) {
              existing.w = 4
              existing.h = 4
              idbSetGridItem(existing).catch(() => {})
            }
          }

          // Scan for plugins and add widgets
           try {
             if (invoke) {
               const pluginsList = await invoke<any[]>("get_plugins")
               setPlugins(pluginsList)

               for (const plugin of pluginsList) {
                 if (!plugin.enabled) continue
                 const underlay = plugin.manifest.hooks?.["underlay:widget"]
                 if (underlay && typeof underlay.path === "string") {
                   // Unique path for plugin widget: plugin:{id}
                   const widgetPath = `plugin:${plugin.manifest.id}`
                   if (!grid.find(i => i.path === widgetPath)) {
                      const pos = findNextPosition(grid, { w: underlay.width || 2, h: underlay.height || 2 })
                      if (pos) {
                        const pluginItem: GridItem = {
                          path: widgetPath,
                          x: pos.x,
                          y: pos.y,
                          w: underlay.width || 2,
                          h: underlay.height || 2,
                          kind: "widget",
                          locked: !underlay.resizable
                        }
                        grid.push(pluginItem)
                        idbSetGridItem(pluginItem).catch(() => {})
                      }
                   }
                }
              }
            }
          } catch (e) {
            // Plugin system may not be available in this build
          }

          setGridItems(grid)
      }).catch(() => { })
    }
    init()

    // Hot-plug: react to install/uninstall/enable/disable of plugins
    let unlistenPlugins: (() => void) | null = null
    listen<import("@ai00-x/shared").PluginsChangedEvent>("plugins-changed", async () => {
      try {
        const pluginsList = await invoke<any[]>("get_plugins")
        setPlugins(pluginsList)
        // Sync grid items for underlay:widget plugins
        setGridItems((prev) => {
          let next = prev
          const activeWidgetIds = new Set(
            pluginsList
              .filter((p) => p.enabled && typeof p.manifest.hooks?.["underlay:widget"]?.path === "string")
              .map((p) => p.manifest.id as string)
          )
          // Add grid items for newly installed/enabled plugin widgets
          for (const id of activeWidgetIds) {
            const widgetPath = `plugin:${id}`
            if (next.find((i) => i.path === widgetPath)) continue
            const cfg = pluginsList.find((p) => p.manifest.id === id)?.manifest.hooks?.["underlay:widget"]
            const w = cfg?.width || 2
            const h = cfg?.height || 2
            const pos = findNextPosition(next, { w, h })
            if (pos) {
              const item: GridItem = { path: widgetPath, x: pos.x, y: pos.y, w, h, kind: "widget", locked: !cfg?.resizable }
              idbSetGridItem(item).catch(() => {})
              next = [...next, item]
            }
          }
          // Remove grid items of disabled/uninstalled plugin widgets
          const removed = next.filter(
            (i) => i.path.startsWith("plugin:") && !activeWidgetIds.has(i.path.slice("plugin:".length))
          )
          if (removed.length > 0) {
            for (const item of removed) {
              idbRemoveGridItem(item.path).catch(() => {})
            }
            next = next.filter((i) => !removed.includes(i))
          }
          return next === prev ? prev : next
        })
      } catch {
        // Plugin system not available in this build
      }
    }).then((fn) => { unlistenPlugins = fn })

    // Listen for KV storage changes (cross-webview sync, replaces 'storage' event)
    let unlistenKv: (() => void) | null = null
    storage.onChanged((e) => {
      if (e.key === KEY_CATS && e.value) {
        try {
          const newCategories = JSON.parse(e.value) as Category[]
          // 判等：避免 echo loop（自己写入 → 事件触发 → 再写入）
          setCategories(prev => {
            if (JSON.stringify(prev) === JSON.stringify(newCategories)) return prev
            return newCategories
          })
        } catch { }
      } else if (e.key === KEY_GRID && e.value) {
        try {
          const newGridItems = JSON.parse(e.value) as GridItem[]
          setGridItems(prev => {
            if (JSON.stringify(prev) === JSON.stringify(newGridItems)) return prev
            return newGridItems
          })
        } catch { }
      } else if (e.key === KEY_DRAWER_OPEN && e.value) {
        try {
          const newDrawerOpen = !!JSON.parse(e.value)
          setDrawerOpen(prev => prev === newDrawerOpen ? prev : newDrawerOpen)
        } catch { }
      } else if (e.key === KEY_GRID_COLS) {
        gridDimsRef.current.cols = parseInt(e.value || '0')
      } else if (e.key === KEY_GRID_ROWS) {
        gridDimsRef.current.rows = parseInt(e.value || '0')
      }
    }).then((fn) => { unlistenKv = fn })

    return () => {
      unlistenKv?.()
      try { unlistenPlugins?.() } catch { }
      // 安全关闭 BroadcastChannel
      try {
        if (channelRef.current) {
          channelRef.current.close()
          channelRef.current = null
        }
      } catch (error) {
        console.warn('Error closing BroadcastChannel:', error)
      }
      try { unlistenDrawer?.() } catch { }
      try { unlistenAdd?.() } catch { }
      try { unlistenRemove?.() } catch { }
    }
  }, [refresh])

  // Auto-save categories
  useEffect(() => {
    storage.setJson(KEY_CATS, categories).catch(() => {})
    // Also persist to IDB
    categories.forEach(cat => idbSetCategory(cat).catch(() => {}))
    // Clean up deleted categories from IDB
    idbListCategories().then(allCats => {
      const currentIds = new Set(categories.map(c => c.id))
      allCats.forEach(cat => {
        if (!currentIds.has(cat.id)) {
          idbRemoveCategory(cat.id).catch(() => {})
        }
      })
    }).catch(() => {})
  }, [categories])

  useEffect(() => {
    storage.setJson(KEY_DRAWER_OPEN, drawerOpen).catch(() => {})
    // 安全发送消息到 BroadcastChannel
    try {
      if (channelRef.current) {
        channelRef.current.postMessage({ type: "drawer_open", open: drawerOpen })
      }
    } catch (error) {
      console.warn('Error posting message to BroadcastChannel:', error)
    }
  }, [drawerOpen])

  

  const toggleDrawer = useCallback((open?: boolean) => {
    setDrawerOpen((prev) => (typeof open === "boolean" ? open : !prev))
  }, [])

  const findNextPosition = useCallback((currentItems: GridItem[], desired?: { w?: number; h?: number }) => {
    const CELL_PX = 64
    const TASKBAR_OFFSET = 60
    const rowsSetting = gridDimsRef.current.rows
    const maxRows = rowsSetting > 0 ? rowsSetting : Math.max(1, Math.floor((window.innerHeight - TASKBAR_OFFSET - 60) / CELL_PX))
    const maxColsRaw = gridDimsRef.current.cols
    const maxCols = maxColsRaw > 0 ? maxColsRaw : 100

    const wantW = Math.max(1, desired?.w ?? 1)
    const wantH = Math.max(1, desired?.h ?? 1)

    const occ: boolean[][] = Array.from({ length: maxCols }, () => Array<boolean>(maxRows).fill(false))
    for (let x = 0; x < maxCols; x++) {
      occ[x][0] = true
      occ[x][maxRows - 1] = true
    }
    for (let y = 0; y < maxRows; y++) {
      occ[0][y] = true
      occ[maxCols - 1][y] = true
    }
    occ[0][0] = true

    for (const i of currentItems) {
      const iw = Math.max(1, i.w ?? 1)
      const ih = Math.max(1, i.h ?? 1)
      for (let dx = 0; dx < iw; dx++) {
        for (let dy = 0; dy < ih; dy++) {
          const xx = i.x + dx
          const yy = i.y + dy
          if (xx >= 0 && xx < maxCols && yy >= 0 && yy < maxRows) {
            occ[xx][yy] = true
          }
        }
      }
    }

    for (let x = 1; x < maxCols - 1; x++) {
      for (let y = 1; y < maxRows - 1; y++) {
        if (x + wantW > maxCols - 1) continue
        if (y + wantH > maxRows - 1) continue
        let fits = true
        for (let dx = 0; dx < wantW && fits; dx++) {
          for (let dy = 0; dy < wantH && fits; dy++) {
            if (occ[x + dx][y + dy]) {
              fits = false
            }
          }
        }
        if (fits) {
          return { x, y }
        }
      }
    }
    return null
  }, [])

  const addToGrid = useCallback((path: string, pos?: Partial<Pick<GridItem, "x" | "y">>, extra?: Partial<Pick<GridItem, "w" | "h" | "kind">>) => {
    setGridItems((prev) => {
      if (prev.find((i) => i.path === path)) return prev

      let nextX = 0
      let nextY = 0

      if (pos) {
        nextX = pos.x ?? 0
        nextY = pos.y ?? 0
      } else {
        const p = findNextPosition(prev, { w: extra?.w ?? 1, h: extra?.h ?? 1 })
        if (!p) {
          console.warn("No space on grid for", path)
          return prev
        }
        nextX = p.x
        nextY = p.y
      }

      const next: GridItem = {
        path,
        x: nextX,
        y: nextY,
        w: extra?.w ?? 1,
        h: extra?.h ?? 1,
        kind: extra?.kind ?? "shortcut"
      }
      idbSetGridItem(next).catch(() => { })
      const out = [...prev, next]
      // 安全发送消息到 BroadcastChannel
      try {
        if (channelRef.current) {
          channelRef.current.postMessage({ type: "grid_add", path, extra })
        }
      } catch (error) {
        console.warn('Error posting grid_add message to BroadcastChannel:', error)
      }
      return out
    })
  }, [findNextPosition])

  const removeFromGrid = useCallback((path: string) => {
    setGridItems((prev) => {
      const out = prev.filter((i) => i.path !== path)
      idbRemoveGridItem(path).catch(() => { })
      // 安全发送消息到 BroadcastChannel
      try {
        if (channelRef.current) {
          channelRef.current.postMessage({ type: "grid_remove", path })
        }
      } catch (error) {
        console.warn('Error posting grid_remove message to BroadcastChannel:', error)
      }
      return out
    })
  }, [])

  const updateGridItem = useCallback((path: string, updates: Partial<GridItem>) => {
    setGridItems((prev) => prev.map((i) => {
      if (i.path === path) {
        const updated = { ...i, ...updates }
        idbSetGridItem(updated).catch(() => { })
        return updated
      }
      return i
    }))
  }, [])

  useEffect(() => {
    const catIds = new Set(categories.map(c => c.id))
    gridItems.forEach(i => {
      if (catIds.has(i.path)) {
        const nextW = Math.max(2, i.w ?? 2)
        const nextH = Math.max(2, i.h ?? 2)
        if (i.kind !== "category" || i.w !== nextW || i.h !== nextH) {
          updateGridItem(i.path, { kind: "category", w: nextW, h: nextH })
        }
      }
    })
  }, [categories, gridItems, updateGridItem])

  const openPath = useCallback(async (path: string) => {
    try {
      await invoke("open_path", { path })
    } catch { }
  }, [])

  const save = useCallback(() => {
    // No-op, auto-save via useEffect
  }, [])

  const createCategory = useCallback((name: string) => {
    setCategories((prev) => [...prev, { id: crypto.randomUUID(), name, itemPaths: [] }])
  }, [])

  const deleteCategory = useCallback((id: string) => {
    setCategories((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const renameCategory = useCallback((id: string, name: string) => {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)))
  }, [])

  const moveItemToCategory = useCallback((path: string, categoryId: string) => {
    setCategories((prev) => {
      // Remove from all other categories first
      const next = prev.map((c) => ({
        ...c,
        itemPaths: c.itemPaths.filter((p) => p !== path),
      }))
      // Add to target category
      return next.map((c) => (c.id === categoryId ? { ...c, itemPaths: [...c.itemPaths, path] } : c))
    })
  }, [])

  const updateCategory = useCallback((id: string, updates: Partial<Category>) => {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)))
  }, [])

  const value = useMemo<DesktopContextType>(() => ({
    allItems,
    gridItems,
    selection,
    drawerOpen,
    categories,
    plugins,
    refresh,
    toggleDrawer,
    addToGrid,
    removeFromGrid,
    updateGridItem,
    openPath,
    save,
    createCategory,
    deleteCategory,
    renameCategory,
    moveItemToCategory,
    updateCategory,
  }), [allItems, gridItems, selection, drawerOpen, categories, plugins, refresh, toggleDrawer, addToGrid, removeFromGrid, updateGridItem, openPath, save, createCategory, deleteCategory, renameCategory, moveItemToCategory, updateCategory])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useUnderlayDesktop() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("UnderlayDesktopProvider missing")
  return ctx
}
