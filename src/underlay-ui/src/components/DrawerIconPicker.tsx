import React, { useEffect, useMemo, useRef, useState } from "react"
import { Drawer } from "vaul"
import { useUnderlayDesktop } from "@underlay/desktop/UnderlayDesktopContext"
import { Button, Input } from "@ai00-x/design-system/react"
import { cn } from "@underlay/lib/utils"
import { Folder, Grid, Plus, Trash2, Edit2, Check } from "lucide-react"
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter"

export function DrawerIconPicker() {
  const {
    allItems,
    selection,
    toggleDrawer,
    drawerOpen,
    addToGrid,
    removeFromGrid,
    categories,
    createCategory,
    deleteCategory,
    renameCategory,
    moveItemToCategory
  } = useUnderlayDesktop()

  const [query, setQuery] = useState("")
  const [activeCategoryId, setActiveCategoryId] = useState<string>("all")
  const [menu, setMenu] = useState<{ x: number, y: number, path: string, isAdded: boolean } | null>(null)

  useEffect(() => {
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  // Derived state for items in current view
  const displayItems = useMemo(() => {
    let baseItems = allItems

    if (activeCategoryId === "all") {
      // Show all items
    } else if (activeCategoryId === "uncategorized") {
      // Show items not in any user category
      const categorizedPaths = new Set(categories.flatMap(c => c.itemPaths))
      baseItems = allItems.filter(i => !categorizedPaths.has(i.path))
    } else {
      // Show items in specific category
      const cat = categories.find(c => c.id === activeCategoryId)
      if (cat) {
        baseItems = allItems.filter(i => cat.itemPaths.includes(i.path))
      } else {
        baseItems = []
      }
    }

    const q = query.trim().toLowerCase()
    return baseItems.filter((i) => q ? i.name.toLowerCase().includes(q) : true)
  }, [allItems, categories, activeCategoryId, query])

  const handleCreateCategory = () => {
    createCategory("新分类")
  }

  return (
    <Drawer.Root
      open={drawerOpen}
      onOpenChange={toggleDrawer}
      direction="left"
      modal={false}
      dismissible={false}
      shouldScaleBackground={false}
    >
      {!drawerOpen && (
        <Drawer.Trigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-3 left-3 z-50 hover:bg-white/20 text-white"
          >
            <Grid className="w-6 h-6" />
          </Button>
        </Drawer.Trigger>
      )}

      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/20 pointer-events-none" />
        <Drawer.Content className="fixed left-0 top-0 bottom-12 w-[600px] bg-white/30 backdrop-blur-xl border-r border-white/30 flex flex-row z-40 shadow-2xl rounded-br-xl" style={{ backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)' }}>

          {/* Sidebar: Categories */}
          <div className="w-48 border-r border-white/20 bg-white/20 backdrop-blur-md flex flex-col p-2 gap-2" style={{ backdropFilter: 'blur(120px) saturate(150%)' }}>
            <div className="font-semibold text-sm px-2 py-1 text-gray-800">分类</div>

            <CategoryButton
              name="所有图标"
              icon={<Grid className="w-4 h-4" />}
              isActive={activeCategoryId === "all"}
              onClick={() => setActiveCategoryId("all")}
            />
            <CategoryButton
              name="未分类"
              icon={<Folder className="w-4 h-4" />}
              isActive={activeCategoryId === "uncategorized"}
              onClick={() => setActiveCategoryId("uncategorized")}
            />

            <div className="h-px bg-border my-1" />

            <div className="flex-1 overflow-y-auto space-y-1">
              {categories.map(cat => (
                <CategoryItem
                  key={cat.id}
                  category={cat}
                  isActive={activeCategoryId === cat.id}
                  onClick={() => setActiveCategoryId(cat.id)}
                  onRename={renameCategory}
                  onDelete={deleteCategory}
                  onDropItem={moveItemToCategory}
                />
              ))}
            </div>

            <Button variant="outline" size="sm" className="w-full justify-start gap-2" onClick={handleCreateCategory}>
              <Plus className="w-4 h-4" /> 新建分类
            </Button>
          </div>

          {/* Main Content: Icons */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="p-3 border-b border-white/20 flex items-center justify-between gap-2">
              <div className="font-semibold text-gray-800">
                {activeCategoryId === "all" ? "所有图标" :
                  activeCategoryId === "uncategorized" ? "未分类" :
                    categories.find(c => c.id === activeCategoryId)?.name || "未知分类"}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="搜索..."
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  className="h-8 w-48"
                />
                <Button variant="ghost" size="sm" onClick={() => toggleDrawer(false)}>✕</Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              <div className="grid grid-cols-4 gap-3">
                {displayItems.map((it) => (
                  <DraggableIconCard
                    key={it.path}
                    item={it}
                    isAdded={selection.includes(it.path)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setMenu({ x: e.clientX, y: e.clientY, path: it.path, isAdded: selection.includes(it.path) })
                    }}
                  />
                ))}
              </div>
              {displayItems.length === 0 && (
                <div className="text-center text-gray-600 mt-10 text-sm">
                  没有找到图标
                </div>
              )}
            </div>
          </div>

        </Drawer.Content>
      {menu && (
        <div
          className="fixed z-50 w-40 bg-white/30 backdrop-blur-xl border border-white/30 rounded-lg shadow-2xl py-1 flex flex-col"
          style={{ left: menu.x, top: menu.y, backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/30 text-left w-full text-gray-800"
            onClick={() => { menu.isAdded ? removeFromGrid(menu.path) : addToGrid(menu.path); setMenu(null) }}
          >
            {menu.isAdded ? "从桌面移除" : "添加到桌面"}
          </button>
        </div>
      )}
      </Drawer.Portal>
    </Drawer.Root>
  )
}

function CategoryButton({ name, icon, isActive, onClick }: { name: string, icon: React.ReactNode, isActive: boolean, onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md transition-colors text-left",
        isActive ? "bg-white/40 text-gray-900" : "hover:bg-white/20 text-gray-700"
      )}
    >
      {icon}
      <span className="truncate flex-1">{name}</span>
    </button>
  )
}

function CategoryItem({ category, isActive, onClick, onRename, onDelete, onDropItem }: {
  category: { id: string, name: string },
  isActive: boolean,
  onClick: () => void,
  onRename: (id: string, name: string) => void,
  onDelete: (id: string) => void,
  onDropItem: (path: string, catId: string) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(category.name)
  const ref = useRef<HTMLDivElement>(null)
  const [isDraggedOver, setIsDraggedOver] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    return dropTargetForElements({
      element: el,
      getData: () => ({ categoryId: category.id }),
      onDragEnter: () => setIsDraggedOver(true),
      onDragLeave: () => setIsDraggedOver(false),
      onDrop: ({ source }) => {
        setIsDraggedOver(false)
        if (source.data.type === "icon" && typeof source.data.path === "string") {
          onDropItem(source.data.path, category.id)
        }
      }
    })
  }, [category.id, onDropItem])

  const handleSave = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (editName.trim()) {
      onRename(category.id, editName.trim())
    }
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <form onSubmit={handleSave} className="px-1 py-0.5 flex items-center gap-1">
        <Input
          autoFocus
          value={editName}
          onChange={e => setEditName(e.target.value)}
          className="h-7 text-xs px-1"
          onBlur={() => handleSave()}
        />
      </form>
    )
  }

  return (
    <div
      ref={ref}
      className={cn(
        "group flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md transition-colors cursor-pointer relative",
        isActive ? "bg-white/40 text-gray-900" : "hover:bg-white/20 text-gray-700",
        isDraggedOver && "ring-2 ring-blue-400 ring-inset bg-white/30"
      )}
      onClick={onClick}
    >
      <Folder className="w-4 h-4 shrink-0" />
      <span className="truncate flex-1">{category.name}</span>

      <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 absolute right-1 bg-inherit">
        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={(e) => { e.stopPropagation(); setIsEditing(true) }}>
          <Edit2 className="w-3 h-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-5 w-5 text-destructive hover:text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(category.id) }}>
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>
    </div>
  )
}

function DraggableIconCard({ item, isAdded, onContextMenu }: { item: any, isAdded: boolean, onContextMenu: (e: React.MouseEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    return draggable({
      element: el,
      getInitialData: () => ({ type: "icon", path: item.path }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    })
  }, [item.path])

  return (
    <div
      ref={ref}
      className={cn(
        "p-2 flex flex-col items-center gap-2 cursor-grab hover:bg-accent/50 transition-all relative group",
        "border border-white/30 rounded-lg bg-white/20 text-gray-800 shadow-sm",
        dragging && "opacity-50",
        isAdded && "opacity-70"
      )}
      onContextMenu={onContextMenu}
    >
      {isAdded && (
        <div className="absolute top-1 right-1 bg-green-500 text-white rounded-full p-0.5 z-10" title="已添加到桌面">
          <Check className="w-3 h-3" />
        </div>
      )}

      <div className="relative w-12 h-12 flex items-center justify-center">
        {item.icon_base64 ? (
          <img
            src={`data:image/png;base64,${item.icon_base64}`}
            className="w-full h-full object-contain"
            draggable={false}
          />
        ) : (
          <div className="w-full h-full bg-blue-400/20 rounded flex items-center justify-center text-blue-500">
            <span className="text-xs">?</span>
          </div>
        )}
      </div>

      <div className="text-xs truncate w-full text-center select-none text-gray-800" title={item.name}>
        {item.name}
      </div>

    </div>
  )
}