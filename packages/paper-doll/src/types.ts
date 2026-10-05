/** 纸娃娃 manifest / 部件类型（由 pet-pipeline/scripts/lpc_export_all.py 生成，v2 = LPC 全库）。 */

export interface DollManifest {
  version: number
  note?: string
  /** 每帧边长（正方形帧），如 64 */
  frame: number
  /** 条带图行序：行下标 = 此数组的方向下标，如 ["up","left","down","right"] */
  directions: string[]
  /** 动画 → 播放循环。cycle 值 = 条带列号；fps = 每秒 tick 数 */
  animations: Record<string, { cycle: number[]; fps: number }>
  /** 树形分组索引：group = sheet_definitions 子目录路径，category = 首段 */
  groups: DollGroup[]
  parts: Record<string, DollPart>
}

export interface DollGroup {
  /** 如 "body/wings"、"torso/shirts/longsleeve" */
  group: string
  /** = group 首段，如 "body" */
  category: string
  /** 组内部件键（已按名排序） */
  keys: string[]
}

export interface DollLayer {
  /** 全局画序（升序绘制，后画盖前画；翅膀 bg=5 / fg=105 夹住身体） */
  zPos: number
  /** 动画 → 条带图相对路径（相对 manifest 所在目录） */
  anims: Record<string, string>
  /** 动画 → 条带列数（帧数） */
  cols: Record<string, number>
}

export interface DollCredit {
  authors: string[]
  licenses: string[]
  urls: string[]
}

export interface DollPart {
  /** 显示名（LPC 定义 name 字段） */
  name: string
  /** = 分类首段，如 "body" */
  category: string
  /** = 所在子目录，如 "body/wings" */
  group: string
  /**
   * LPC 槽位类型 = 互斥键：同 typeName 部件互斥（衬衫家族都是 "clothes"、
   * 全部翅膀都是 "wings"）；装饰叠层是独立 typeName（wings_dots 等）可叠加。
   */
  typeName: string
  /** LPC 调色变体全列表（当前仅导出 variantExported 一个） */
  variants: string[]
  variantExported: string | null
  /** 1..N 个图层（翅膀=2 层） */
  layers: DollLayer[]
  credits?: DollCredit[]
}
