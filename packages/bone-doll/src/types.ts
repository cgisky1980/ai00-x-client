/**
 * 骨骼纸娃娃资产 schema（Px2d 风路线 v2.0，见 .trae/documents/Px2d风骨骼纸娃娃-计划-20260917.md）。
 *
 * 核心语义：
 * - 部件天生分层：每部件每方向一张 64×64 PNG（与素体同画布绝对对齐，offset 兜底裁剪件）。
 * - 四方向独立：down/up/left/right 各自可有自己的部件图与动画关键帧；
 *   left 缺资产时回落 right（运行时画布级镜像 / Spine 侧 skin 自动翻转兜底）。
 * - 关键帧携带骨骼局部姿态的【绝对值】（替换 setup pose，不做增量）。
 * - 红线：不做装配图逆拆解 / 不做 IK·网格·权重 / 不自动绑骨。
 */

/** 存储方向（四方向独立；left 可缺省，缺省时回落 right 镜像） */
export type StorageDir = 'down' | 'up' | 'left' | 'right'
/** 运行时方向（与存储方向同集；保留别名避免调用面大面积改名） */
export type RuntimeDir = StorageDir

export const STORAGE_DIRS: readonly StorageDir[] = ['down', 'up', 'left', 'right']
export const RUNTIME_DIRS: readonly RuntimeDir[] = STORAGE_DIRS

export function isRuntimeDir(v: string): v is RuntimeDir {
  return v === 'down' || v === 'up' || v === 'left' || v === 'right'
}

/** 字符串是否合法存储方向键（校验用） */
export function isStorageDir(v: string): v is StorageDir {
  return isRuntimeDir(v)
}

/**
 * 方向 → 存储方向解析（兜底语义）：left 无独立资产时回落 right（镜像兜底），
 * 其余方向恒等。调用方若已确认「独立 left 资产存在」（hasLeftAssets）应直接用 dir 本身。
 */
export function storageDirOf(dir: RuntimeDir): StorageDir {
  return dir === 'left' ? 'right' : dir
}

/** 骨架是否声明了独立 left 资产（directions 含 left 或任一部件有 left 图） */
export function hasLeftAssets(a: SkeletonAsset): boolean {
  if (a.directions.includes('left')) return true
  for (const p of Object.values(a.parts)) if (p.images.left) return true
  return false
}

// ------------------------------------------------------------ 骨架

export interface BoneDef {
  key: string
  /** 父骨键；根骨为 null（最多一棵树，禁止环） */
  parent: string | null
  /** setup pose 局部平移（相对父骨；根骨 = 逻辑画布坐标） */
  x: number
  y: number
  /** setup pose 局部旋转（度，顺时针），默认 0 */
  r?: number
}

/** 槽位 = 挂图点 + 全局绘制序；同槽位默认互斥（换装语义），stack 槽可叠加 */
export interface SlotDef {
  key: string
  bone: string
  /** 全局 z（升序绘制，后画盖前画） */
  z: number
  /**
   * 背视角专用 z：up（角色背对镜头）时遮挡关系翻转——披风类背件应盖住躯干
   * （如披风 z:5, zBackView:33）。缺省 = 该槽位遮挡与方向无关。
   */
  zBackView?: number
  /**
   * 侧视角专用 z：left/right（角色侧对镜头）时披风披在身体侧面、盖住后半身
   * （如披风 z:5, zSideView:31 = 盖过躯干 z:30、让位近臂 z:36）。缺省用 z。
   */
  zSideView?: number
  /** true = 装饰槽可多件叠加（hat/cape/weapon/acc…） */
  stack?: boolean
}

/** 非方向相关的方向校准：覆盖 setup pose 的局部姿态（漏字段用 bones[].x/y/r；left 缺省回落 right） */
export interface DirSetupOverrides {
  up?: Record<string, BonePose>
  left?: Record<string, BonePose>
  right?: Record<string, BonePose>
}

// ------------------------------------------------------------ 部件

export interface PartImage {
  /** 图片相对 skeleton.json 所在目录的路径 */
  src: string
  /**
   * canvas（默认）= 图片按逻辑画布原点对齐（64×64 整幅、绝对位置绘制，rotate 围绕骨骼枢轴）；
   * bone = 图片左上角相对骨骼原点偏移 (x, y)（裁剪件用）。
   */
  align?: 'canvas' | 'bone'
  x?: number
  y?: number
}

export interface PartDef {
  slot: string
  name?: string
  /** 每存储方向一张；left 可缺省（回落 right 镜像）；face 之类可缺 up（背面无表情） */
  images: Partial<Record<StorageDir, PartImage>>
}

// ------------------------------------------------------------ 动画

/** 骨骼局部姿态（缺字段 = 不动该字段；数值为绝对局部值，替换 setup pose） */
export interface BonePose {
  x?: number
  y?: number
  r?: number
}

export interface Keyframe {
  /** 秒，0 ≤ t ≤ duration；同一关键帧内可只写部分骨骼/字段 */
  t: number
  bones: Record<string, BonePose>
}

export interface AnimDef {
  /** 周期时长（秒） */
  duration: number
  loop: boolean
  /** loop=false 播完自动接的动画键（如 attack → idle） */
  next?: string
  /** 每存储方向一套关键帧；left 缺省沿用 right 轨；漏方向 = 该方向按 setup pose 演不够的骨骼静止 */
  tracks: Partial<Record<StorageDir, Keyframe[]>>
}

// ------------------------------------------------------------ 资产根

export interface SkeletonAsset {
  /** 1 = 旧三方向（left 回落 right 镜像）；2 = 四方向（left 可有独立图/轨） */
  version: 1 | 2
  /** 逻辑画布边长（低分辨率渲染尺寸，之后整数倍放大） */
  frame: number
  /** 声明支持的方向子集（v2 四方向 = ["down","up","left","right"]；运行时可经 hasLeftAssets 推导） */
  directions: readonly StorageDir[]
  /** 初始装备部件键（素体必备件） */
  defaultEquip?: string[]
  bones: BoneDef[]
  /** 数组序无语义，绘制按 z 升序 */
  slots: SlotDef[]
  /** 每方向 setup pose 校准（侧视肩髋位置与前视不同） */
  setups?: DirSetupOverrides
  parts: Record<string, PartDef>
  animations: Record<string, AnimDef>
}
