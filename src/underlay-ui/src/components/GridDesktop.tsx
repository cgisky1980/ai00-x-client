import { useEffect, useRef, useState } from "react"
import { IconTooltip } from "@underlay/components/IconTooltip"
import { GridStack } from "gridstack"
import { useUnderlayDesktop } from "@underlay/desktop/UnderlayDesktopContext"
import { cn } from "@underlay/lib/utils"
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter"
import { Lock, Unlock, Trash2, FolderOpen } from "lucide-react"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@ai00-x/design-system/react"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"

import { DesktopCategory } from "@underlay/components/DesktopCategory"
import { DesktopShortcut } from "@underlay/components/DesktopShortcut"
import { SystemMonitorWidget } from "@underlay/components/SystemMonitorWidget"
import { ClockWidget } from "@underlay/components/ClockWidget"
import { PluginWidget } from "@underlay/components/PluginWidget"
import { isIframeHook } from "@ai00-x/shared"
import { ItemWrapper } from "@underlay/components/ItemWrapper"
import { storage } from "@underlay/lib/storage"

export function GridDesktop() {
  const { gridItems, updateGridItem, openPath, save, addToGrid, allItems, removeFromGrid, categories, deleteCategory, plugins } = useUnderlayDesktop()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const gridRef = useRef<GridStack | null>(null)
  const CELL_PX = 64
  const KEY_GRID_COLS = "ai00.desktop.grid_cols"
  const KEY_GRID_ROWS = "ai00.desktop.grid_rows"
  const TASKBAR_OFFSET = 60 // Reserve space for taskbar
  const TOP_OFFSET = 60

  const [contextMenu, setContextMenu] = useState<{ path: string, locked: boolean, kind: "shortcut" | "category" | "widget", categoryItems?: any[] } | null>(null)
  const [tooltipData, setTooltipData] = useState<{ x: number, y: number, label: string } | null>(null)
  const isReservingRef = useRef(false)
  const isSyncingRef = useRef(false)
  // 缓存上一次写入的列数（storage.get 是异步的，这里用 ref 保持同步读取）
  const prevColsRef = useRef<number>(0)

  const onContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const itemEl = target.closest('.grid-stack-item') as HTMLElement | null
    if (!itemEl || itemEl.dataset.reserved === "true") {
      setContextMenu(null)
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const path = itemEl.dataset.path || ""
    const locked = itemEl.getAttribute('gs-locked') === 'true' || itemEl.getAttribute('gs-no-move') === 'true'

    // Determine kind
    const isCategory = categories.some(c => c.id === path)
    let categoryItems: any[] = []

    if (isCategory) {
      const cat = categories.find(c => c.id === path)
      if (cat) {
        categoryItems = allItems.filter(i => cat.itemPaths.includes(i.path))
      }
    }

    const isWidget = path === "system-monitor" || path === "clock-widget" || path.startsWith("plugin:")
    setContextMenu({ path, locked, kind: isCategory ? "category" : (isWidget ? "widget" : "shortcut"), categoryItems })
  }

  // Drop Target for Drawer Items
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    return dropTargetForElements({
      element: el,
      onDrop: ({ source }) => {
        if (source.data.type === "icon" && typeof source.data.path === "string") {
          const path = source.data.path
          // Check if already exists
          if (gridItems.find(g => g.path === path)) return

          addToGrid(path)
        }
      }
    })
  }, [addToGrid, gridItems])

  // 从 storage 加载初始列数（替代 localStorage 同步读取）
  useEffect(() => {
    storage.get(KEY_GRID_COLS).then((v) => {
      prevColsRef.current = parseInt(v || "0") || 0
    }).catch(() => {})
  }, [])

  // GridStack Initialization and Sync
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (!gridRef.current) {
      if (el.clientWidth === 0) return // Wait for layout
      console.log(`[GridDesktop] Init: clientHeight=${el.clientHeight}, clientWidth=${el.clientWidth}`)
      const initialCols = Math.max(1, Math.floor(el.clientWidth / CELL_PX))
      const initialRows = Math.max(1, Math.floor((el.clientHeight - TASKBAR_OFFSET - TOP_OFFSET) / CELL_PX))
      gridRef.current = GridStack.init({
        float: true,
        column: initialCols,
        maxRow: initialRows,
        cellHeight: CELL_PX,
        minRow: initialRows,
        margin: 5,
        // 整个 content 可拖拽；颜色按钮通过 stopPropagation 避免触发拖拽。
        // 不支持 resize，大小由创建时指定（GridItem.w/h）。
        draggable: { handle: '.grid-stack-item-content', cancel: '.no-drag' },
        disableResize: true,
      }, el)

      try {
        storage.set(KEY_GRID_COLS, String(initialCols)).catch(() => {})
        storage.set(KEY_GRID_ROWS, String(initialRows)).catch(() => {})
        prevColsRef.current = initialCols
      } catch {}

      const grid = gridRef.current

      // Keep initial column constant to avoid position drift on resize
      grid.cellHeight(CELL_PX)

      const ensureReservedRing = () => {
        if (!containerRef.current || !gridRef.current) return
        if (isReservingRef.current) return

        isReservingRef.current = true
        try {
          const grid = gridRef.current
          // Wait for next tick to ensure grid is ready
          setTimeout(() => {
            try {
              const cols = grid.getColumn()
              // Check if container still exists
              if (!containerRef.current) return

              const rowsFallback = Math.max(1, Math.floor((containerRef.current.clientHeight - TASKBAR_OFFSET - TOP_OFFSET) / CELL_PX))
              const rows = Math.max(rowsFallback, parseInt(grid.el.getAttribute('gs-current-row') || '0') || 1)

              if (!cols || !rows) return

              // Don't enforce ring on very small grids or if locked
              if (cols < 3 || rows < 3) return

              // Temporarily disable events
              grid.enableMove(false)
              
              // Note: batchUpdate removed to prevent collision resolution loops during commit
              // grid.batchUpdate()

              // 1. Remove all existing ring widgets
              containerRef.current.querySelectorAll('.grid-stack-item[data-ring="true"]').forEach((n) => {
                grid.removeWidget(n as HTMLElement, true, false) // removeDOM=true, triggerEvent=false
              })

              // 2. Push regular items inside the ring
              const outOfBoundsItems: HTMLElement[] = []
              containerRef.current.querySelectorAll('.grid-stack-item').forEach((n) => {
                const elem = n as HTMLElement
                if (elem.dataset.reserved === 'true') return
                
                const x0 = parseInt(elem.getAttribute('gs-x') || '0')
                const y0 = parseInt(elem.getAttribute('gs-y') || '0')

                // Clamp to inner area
                const minX = 1
                const maxX = Math.max(1, cols - 2)
                const minY = 1
                const maxY = Math.max(1, rows - 2)

                let x1 = Math.max(minX, Math.min(x0, maxX))
                let y1 = Math.max(minY, Math.min(y0, maxY))

                if (x1 !== x0 || y1 !== y0) {
                   outOfBoundsItems.push(elem)
                }
              })

              // Sort by y then x to keep relative order roughly
              outOfBoundsItems.sort((a, b) => {
                 const ya = parseInt(a.getAttribute('gs-y') || '0')
                 const yb = parseInt(b.getAttribute('gs-y') || '0')
                 if (ya !== yb) return ya - yb
                 const xa = parseInt(a.getAttribute('gs-x') || '0')
                 const xb = parseInt(b.getAttribute('gs-x') || '0')
                 return xa - xb
              })

              for (const elem of outOfBoundsItems) {
                 // Find a free spot in the safe zone
                 const minX = 1
                 const maxX = Math.max(1, cols - 2)
                 const minY = 1
                 const maxY = Math.max(1, rows - 2)

                 let targetX = -1
                 let targetY = -1

                 // First try the clamped position
                 const x0 = parseInt(elem.getAttribute('gs-x') || '0')
                 const y0 = parseInt(elem.getAttribute('gs-y') || '0')
                 let x1 = Math.max(minX, Math.min(x0, maxX))
                 let y1 = Math.max(minY, Math.min(y0, maxY))
                 
                 if (grid.isAreaEmpty(x1, y1, 1, 1)) {
                    targetX = x1
                    targetY = y1
                 } else {
                    // Search for first empty spot
                    let found = false
                    for (let y = minY; y <= maxY; y++) {
                       for (let x = minX; x <= maxX; x++) {
                          if (grid.isAreaEmpty(x, y, 1, 1)) {
                             targetX = x
                             targetY = y
                             found = true
                             break
                          }
                       }
                       if (found) break
                    }
                 }

                 if (targetX !== -1 && targetY !== -1) {
                    grid.update(elem, { x: targetX, y: targetY })
                    const p = elem.dataset.path || ''
                    if (p) updateGridItem(p, { x: targetX, y: targetY })
                 } else {
                    console.warn("[GridDesktop] No space in safe zone for item", elem.dataset.path)
                    // Fallback: Force update to clamped position and hope GridStack handles it, 
                    // but usually this causes the loop. 
                    // Better to NOT move it and let it be overlapped by ring (less catastrophic)
                    // OR: Try to move it to clamped position but risk the loop. 
                    // Given the error is "Maximum call stack", avoiding the force update is safer.
                    // However, if we don't move it, the ring widget addition (Step 3) will verify if it's occupied.
                    // If it's occupied by this item, Step 3 won't add the ring widget.
                    // So the item will stay, and the ring will have a hole. This is acceptable failure mode.
                 }
              }

              // 3. Add ring widgets
              const added = new Set<string>()
              const addReserved = (x: number, y: number) => {
                const key = `${x},${y}`
                if (added.has(key)) return
                added.add(key)
                
                // Check if something is already there (should have been moved by step 2)
                // If something is stuck there, don't add the ring widget to avoid infinite collision loop
                const occupied = grid.getGridItems().find(n => {
                   return parseInt(n.getAttribute('gs-x') || '-1') === x && parseInt(n.getAttribute('gs-y') || '-1') === y
                })
                
                if (occupied && occupied.dataset.reserved !== 'true') {
                   console.warn(`[GridDesktop] Cannot add ring at ${x},${y}, occupied by ${occupied.dataset.path}`)
                   return
                }

                const item = document.createElement('div')
                item.className = 'grid-stack-item'
                item.setAttribute('gs-x', String(x))
                item.setAttribute('gs-y', String(y))
                item.setAttribute('gs-w', '1')
                item.setAttribute('gs-h', '1')
                item.setAttribute('gs-no-resize', 'true')
                item.setAttribute('gs-no-move', 'true')
                item.setAttribute('gs-locked', 'true')
                item.setAttribute('gs-auto-position', 'false')
                  ; (item as any).dataset.reserved = 'true'
                  ; (item as any).dataset.ring = 'true'
                const content = document.createElement("div")
                content.className = 'grid-stack-item-content absolute inset-0'
                content.style.opacity = '0'
                content.style.pointerEvents = 'auto'
                item.appendChild(content)
                containerRef.current!.appendChild(item)
                grid.makeWidget(item)
              }
              for (let x = 1; x < cols; x++) addReserved(x, 0)
              for (let x = 0; x < cols; x++) addReserved(x, rows - 1)
              for (let y = 1; y < rows - 1; y++) addReserved(0, y)
              for (let y = 1; y < rows - 1; y++) addReserved(cols - 1, y)

              grid.enableMove(true)
              
            } catch (e) {
              console.error("[GridDesktop] ensureReservedRing error:", e)
            } finally {
               // Extended lock release to prevent event race conditions
               setTimeout(() => {
                  isReservingRef.current = false
               }, 200)
            }
          }, 0)
        } catch (e) {
          isReservingRef.current = false
        }
      }

      const updateGridSize = () => {
        if (!containerRef.current || !gridRef.current) return
        const cols = Math.max(1, Math.floor(containerRef.current.clientWidth / CELL_PX))
        const rows = Math.max(1, Math.floor((containerRef.current.clientHeight - TASKBAR_OFFSET - TOP_OFFSET) / CELL_PX))
        console.log(`[GridDesktop] Resizing: clientHeight=${containerRef.current.clientHeight}, rows=${rows}, cols=${cols}`)

        const grid = gridRef.current

        // 1. Remove ring widgets BEFORE resizing grid to prevent collision loops during reflow
        containerRef.current.querySelectorAll('.grid-stack-item[data-ring="true"]').forEach((n) => {
            grid.removeWidget(n as HTMLElement, true, false)
        })

        // 2. Resize grid
        grid.column(cols)
        grid.opts.minRow = rows
        grid.opts.maxRow = rows
        
        // 3. Re-add ring widgets and enforce constraints
        ensureReservedRing()

        try {
          storage.set(KEY_GRID_COLS, String(cols)).catch(() => {})
          storage.set(KEY_GRID_ROWS, String(rows)).catch(() => {})
          prevColsRef.current = cols
        } catch {}
      }

      window.addEventListener('resize', updateGridSize)

      grid.on("change", (_e, items) => {
        if (isReservingRef.current || isSyncingRef.current) return
        items.forEach((it: any) => {
          const path = it.el?.dataset?.path
          if (!path) return
          updateGridItem(path, { x: it.x, y: it.y, w: it.w, h: it.h })
        })
        save()
      })

      // Add a static placeholder at (0,0) to prevent items from overlapping with the drawer button
      const placeholder = document.createElement("div")
      placeholder.className = "grid-stack-item grid-stack-placeholder-reserved"
      placeholder.setAttribute("gs-x", "0")
      placeholder.setAttribute("gs-y", "0")
      placeholder.setAttribute("gs-w", "1")
      placeholder.setAttribute("gs-h", "1")
      placeholder.setAttribute("gs-no-resize", "true")
      placeholder.setAttribute("gs-no-move", "true")
      placeholder.setAttribute("gs-locked", "true")
      placeholder.dataset.reserved = "true"

      const placeholderContent = document.createElement("div")
      placeholderContent.className = "grid-stack-item-content absolute inset-0"
      placeholderContent.style.opacity = "0"
      placeholderContent.style.pointerEvents = "auto"
      placeholder.appendChild(placeholderContent)

      el.appendChild(placeholder)
      grid.makeWidget(placeholder)

      ensureReservedRing()

      // Force initial layout check
      setTimeout(updateGridSize, 100)
    }

    const grid = gridRef.current
    if (!grid) return

    const currCols = Math.max(1, Math.round(el.clientWidth / CELL_PX))
    const prevCols = prevColsRef.current
    if (prevCols > 0 && prevCols !== currCols) {
      const ratio = currCols / prevCols
      gridItems.forEach((gi) => {
        const w0 = gi.w ?? 1
        let x1 = Math.round(gi.x * ratio)
        if (x1 < 0) x1 = 0
        const maxX = Math.max(0, currCols - w0)
        if (x1 > maxX) x1 = maxX
        updateGridItem(gi.path, { x: x1 })
      })
      save()
    }
    storage.set(KEY_GRID_COLS, String(currCols)).catch(() => {})
    prevColsRef.current = currCols

    // Sync items (skip reserved placeholder)
    isSyncingRef.current = true
    try {
      const existing = new Set<string>()
      el.querySelectorAll(".grid-stack-item").forEach((n) => {
        const elem = n as HTMLElement
        if (elem.dataset.reserved === "true") return
        existing.add(elem.dataset.path || "")
      })

      gridItems.forEach((gi) => {
        let itemEl = el.querySelector(`.grid-stack-item[data-path="${gi.path.replace(/\\/g, '\\\\')}"]`) as HTMLElement

        if (itemEl) {
          // Update GridStack attributes if changed
          const currentX = itemEl.getAttribute('gs-x')
          const currentY = itemEl.getAttribute('gs-y')
          const currentW = itemEl.getAttribute('gs-w')
          const currentH = itemEl.getAttribute('gs-h')
          const currentLocked = itemEl.getAttribute('gs-locked')

          const newW = String(gi.w ?? 1)
          const newH = String(gi.h ?? 1)
          const newLocked = gi.locked ? 'true' : 'false'
          // 不支持 resize，大小由创建时指定
          const isResizable = false
          const newNoResize = 'true'

          const updateOpts: any = {}
          let needsUpdate = false

          if (currentX !== String(gi.x)) { updateOpts.x = gi.x; needsUpdate = true }
          if (currentY !== String(gi.y)) { updateOpts.y = gi.y; needsUpdate = true }
          if (currentW !== newW) { updateOpts.w = gi.w ?? 1; needsUpdate = true }
          if (currentH !== newH) { updateOpts.h = gi.h ?? 1; needsUpdate = true }
          if (currentLocked !== newLocked) {
            updateOpts.locked = !!gi.locked
            updateOpts.noMove = !!gi.locked
            needsUpdate = true
          }
          if (itemEl.getAttribute('gs-no-resize') !== newNoResize) {
            updateOpts.noResize = !isResizable
            needsUpdate = true
          }

          if (needsUpdate) {
            grid.update(itemEl, updateOpts)
            grid.movable(itemEl, !gi.locked)
            grid.resizable(itemEl, isResizable)
          }
        } else {
          // Create new widget
          const item = document.createElement("div")
          item.className = "grid-stack-item"
          item.setAttribute("gs-x", String(gi.x))
          item.setAttribute("gs-y", String(gi.y))
          item.setAttribute("gs-w", String((gi.kind === "category" || gi.kind === "widget") ? Math.max(gi.w ?? 1, 2) : (gi.w ?? 1)))
          item.setAttribute("gs-h", String((gi.kind === "category" || gi.kind === "widget") ? Math.max(gi.h ?? 1, 2) : (gi.h ?? 1)))

          if (gi.kind === "category") {
            item.setAttribute("gs-no-resize", "true")
            item.setAttribute("gs-min-w", "2")
            item.setAttribute("gs-min-h", "2")
          } else if (gi.kind === "widget") {
            item.setAttribute("gs-no-resize", "true")
            item.setAttribute("gs-min-w", "2")
            item.setAttribute("gs-min-h", "2")
          } else {
            // shortcut（最小 1x1）
            item.setAttribute("gs-no-resize", "true")
            item.setAttribute("gs-min-w", "1")
            item.setAttribute("gs-min-h", "1")
          }

          if (gi.locked) {
            item.setAttribute("gs-no-move", "true")
            item.setAttribute("gs-locked", "true")
          }
          item.dataset.path = gi.path

          const content = document.createElement("div")
          content.className = "grid-stack-item-content absolute inset-0 select-none cursor-pointer transition-all rounded group"
            content.style.pointerEvents = "auto"
          item.appendChild(content)

          grid.makeWidget(item)
          grid.movable(item, !gi.locked)
          grid.resizable(item, true)
          itemEl = item
        }

        // Render/Update React Component
        const contentEl = itemEl.querySelector('.grid-stack-item-content') as HTMLElement
        if (contentEl) {
          let root = (contentEl as any)._reactRoot as Root | undefined
          if (!root) {
            root = createRoot(contentEl)
              ; (contentEl as any)._reactRoot = root
          }

          if (gi.kind === "category") {
            const category = categories.find(c => c.id === gi.path)
            if (category) {
              root.render(
                <ItemWrapper
                  color={gi.color}
                  fallbackColor={category.color}
                  opacity={gi.opacity}
                  onColorChange={(c) => updateGridItem(gi.path, { color: c })}
                  onOpacityChange={(o) => updateGridItem(gi.path, { opacity: o })}
                >
                  <DesktopCategory
                    category={category}
                    onMouseEnter={(rect, label) => setTooltipData({ x: rect.left + rect.width / 2, y: rect.top, label })}
                    onMouseLeave={() => setTooltipData(null)}
                  />
                </ItemWrapper>
              )
            }
          } else if (gi.kind === "widget" && gi.path === "system-monitor") {
            root.render(
              <ItemWrapper
                color={gi.color}
                opacity={gi.opacity}
                onColorChange={(c) => updateGridItem(gi.path, { color: c })}
                onOpacityChange={(o) => updateGridItem(gi.path, { opacity: o })}
              >
                <SystemMonitorWidget />
              </ItemWrapper>
            )
          } else if (gi.kind === "widget" && gi.path === "clock-widget") {
            root.render(
              <ItemWrapper
                color={gi.color}
                opacity={gi.opacity}
                onColorChange={(c) => updateGridItem(gi.path, { color: c })}
                onOpacityChange={(o) => updateGridItem(gi.path, { opacity: o })}
              >
                <ClockWidget />
              </ItemWrapper>
            )
          } else if (gi.kind === "widget" && gi.path.startsWith("plugin:")) {
             const pluginId = gi.path.replace("plugin:", "")
             const plugin = plugins.find(p => p.manifest.id === pluginId)
             const underlayHook = plugin?.manifest.hooks?.["underlay:widget"]
             if (plugin && plugin.enabled && isIframeHook(underlayHook)) {
                root.render(
                  <ItemWrapper
                    color={gi.color}
                    opacity={gi.opacity}
                    onColorChange={(c) => updateGridItem(gi.path, { color: c })}
                    onOpacityChange={(o) => updateGridItem(gi.path, { opacity: o })}
                  >
                    <PluginWidget pluginId={pluginId} entryPath={underlayHook.path} />
                  </ItemWrapper>
                )
             } else {
                root.render(
                  <ItemWrapper
                    color={gi.color}
                    opacity={gi.opacity}
                    onColorChange={(c) => updateGridItem(gi.path, { color: c })}
                    onOpacityChange={(o) => updateGridItem(gi.path, { opacity: o })}
                  >
                    <div className="w-full h-full flex items-center justify-center bg-destructive/10 text-destructive text-xs">Plugin Error</div>
                  </ItemWrapper>
                )
             }
          } else {
            const meta = allItems.find((i) => i.path === gi.path)
            root.render(
              <ItemWrapper
                color={gi.color}
                opacity={gi.opacity}
                onColorChange={(c) => updateGridItem(gi.path, { color: c })}
                onOpacityChange={(o) => updateGridItem(gi.path, { opacity: o })}
              >
                <DesktopShortcut
                  item={meta}
                  path={gi.path}
                  onOpen={openPath}
                  onMouseEnter={(rect, label) => setTooltipData({ x: rect.left + rect.width / 2, y: rect.top, label })}
                  onMouseLeave={() => setTooltipData(null)}
                />
              </ItemWrapper>
            )
          }
        }
      })

      // Remove items not in state (except reserved placeholder)
      const toRemove: HTMLElement[] = []
      el.querySelectorAll(".grid-stack-item").forEach((n) => {
        const elem = n as HTMLElement
        // Skip the reserved placeholder at (0,0)
        if (elem.dataset.reserved === "true") return

        const p = elem.dataset.path || ""
        if (!gridItems.find((g) => g.path === p)) toRemove.push(elem)
      })
      toRemove.forEach((n) => grid.removeWidget(n))
    } finally {
      // Delay clearing flag to let gridstack finish any events
      setTimeout(() => {
        isSyncingRef.current = false
      }, 0)
    }

  }, [gridItems, updateGridItem, openPath, save, allItems, categories, plugins])

  const handleLock = () => {
    if (!contextMenu) return
    updateGridItem(contextMenu.path, { locked: !contextMenu.locked })
  }

  const handleRemove = () => {
    if (!contextMenu) return
    if (contextMenu.kind === "category") {
      // For category, delete it completely (from drawer and grid)
      deleteCategory(contextMenu.path)
      removeFromGrid(contextMenu.path)
    } else {
      // For shortcut, just remove from grid
      removeFromGrid(contextMenu.path)
    }

    const el = containerRef.current?.querySelector(`.grid-stack-item[data-path="${contextMenu.path.replace(/\\/g, '\\\\')}"]`)
    if (el) {
      gridRef.current?.removeWidget(el as HTMLElement)
    }
    save()
    setContextMenu(null)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="w-full h-full relative">
          <div
            ref={containerRef}
            className={cn("grid-stack absolute inset-0 overflow-hidden")}
            style={{ height: "100%" }}
            onContextMenu={onContextMenu}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[160px]">
        {contextMenu?.kind === "shortcut" && (
          <ContextMenuItem disabled={!contextMenu} onClick={() => contextMenu && openPath(contextMenu.path)}>
            <FolderOpen className="w-4 h-4 mr-2" /> 打开
          </ContextMenuItem>
        )}

        <ContextMenuItem disabled={!contextMenu} onClick={handleLock}>
          {contextMenu?.locked ? <Unlock className="w-4 h-4 mr-2" /> : <Lock className="w-4 h-4 mr-2" />} {contextMenu?.locked ? "解锁" : "锁定"}
        </ContextMenuItem>

        {contextMenu?.kind === "category" && (
          <>
            <ContextMenuItem disabled={!contextMenu} onClick={handleRemove} className="text-red-600 focus:text-red-700">
              <Trash2 className="w-4 h-4 mr-2" /> 删除分类
            </ContextMenuItem>
            <ContextMenuSeparator />
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              分类内容
            </div>
            {contextMenu.categoryItems && contextMenu.categoryItems.length > 0 ? (
              <div className="max-h-[200px] overflow-y-auto">
                {contextMenu.categoryItems.map((item: any) => (
                  <ContextMenuItem key={item.path} onClick={() => openPath(item.path)} className="gap-2">
                    {item.icon_base64 ? (
                      <img src={`data:image/png;base64,${item.icon_base64}`} className="w-4 h-4 object-contain" />
                    ) : (
                      <div className="w-4 h-4 bg-gray-200 rounded" />
                    )}
                    <span className="truncate max-w-[180px]">{item.name.replace(/\.(lnk|url)$/i, "")}</span>
                  </ContextMenuItem>
                ))}
              </div>
            ) : (
              <div className="px-2 py-1 text-xs text-muted-foreground">
                (空)
              </div>
            )}
          </>
        )}

        {contextMenu?.kind === "shortcut" && (
          <ContextMenuItem disabled={!contextMenu} onClick={handleRemove} className="text-red-600 focus:text-red-700">
            <Trash2 className="w-4 h-4 mr-2" /> 从桌面删除
          </ContextMenuItem>
        )}
      </ContextMenuContent>
      {tooltipData && <IconTooltip x={tooltipData.x} y={tooltipData.y} label={tooltipData.label} />}
    </ContextMenu>
  )
}
