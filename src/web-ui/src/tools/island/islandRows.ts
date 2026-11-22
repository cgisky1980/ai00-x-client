/**
 * 灵动岛行注册表。
 *
 * 借鉴岛仔 Daozai 的「模块可独立开关 / 常驻项可拖动排序」：把三行从硬编码
 * JSX 收敛为数据驱动的描述，用户可在设置里开关、排序；渲染层按 order 排序、
 * 按 enabled 过滤。插件槽仍是纯 DOM 协议（#ai00-island-slot），不纳入本注册表。
 *
 * 注意：compact 常驻仅音乐行（产品签名行为）。其余行 compact 态隐藏，
 * registry 的 compactVisible 字段为将来扩展预留，避免再次改渲染层。
 */

export type IslandRowId = 'music' | 'sfx' | 'tools'

export interface IslandRowDef {
  id: IslandRowId
  label: string
  /** 默认是否启用 */
  defaultEnabled: boolean
  /** 默认排序（越小越靠上） */
  defaultOrder: number
  /** compact 态是否常驻（当前仅 music） */
  compactVisible: boolean
}

export const ISLAND_ROWS: IslandRowDef[] = [
  { id: 'music', label: '音乐', defaultEnabled: true, defaultOrder: 0, compactVisible: true },
  { id: 'sfx', label: '环境音效', defaultEnabled: true, defaultOrder: 1, compactVisible: false },
  { id: 'tools', label: '快捷工具', defaultEnabled: true, defaultOrder: 2, compactVisible: false },
]

export const ISLAND_ROW_IDS: IslandRowId[] = ISLAND_ROWS.map((r) => r.id)

export const isIslandRowId = (v: unknown): v is IslandRowId =>
  typeof v === 'string' && (ISLAND_ROW_IDS as string[]).includes(v)
