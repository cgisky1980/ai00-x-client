export interface DesktopItem {
  path: string
  name: string
  is_dir: boolean
  icon_base64: string
}

export interface GridItem {
  path: string
  x: number
  y: number
  w: number
  h: number
  locked?: boolean
  kind?: "shortcut" | "group" | "widget" | "category"
  // 用户自定义背景色（hex 如 "#3b82f6"，空字符串=清除颜色）
  color?: string
  // 背景不透明度 0-100（百分比）。未设置=不应用背景色
  opacity?: number
}

export interface Category {
  id: string
  name: string
  itemPaths: string[]
  icon?: string
  color?: string
}

export interface DesktopState {
  allItems: DesktopItem[]
  gridItems: GridItem[]
  selection: string[]
  drawerOpen: boolean
  categories: Category[]
  plugins: import("@ai00-x/shared").PluginInfo[]
}

export interface DesktopContextType extends DesktopState {
  refresh: () => Promise<void>
  toggleDrawer: (open?: boolean) => void
  addToGrid: (path: string, pos?: Partial<Pick<GridItem, "x" | "y">>, extra?: Partial<Pick<GridItem, "w" | "h" | "kind">>) => void
  removeFromGrid: (path: string) => void
  updateGridItem: (path: string, updates: Partial<GridItem>) => void
  openPath: (path: string) => Promise<void>
  save: () => void
  createCategory: (name: string) => void
  deleteCategory: (id: string) => void
  renameCategory: (id: string, name: string) => void
  updateCategory: (id: string, updates: Partial<Category>) => void
  moveItemToCategory: (path: string, categoryId: string) => void
}
