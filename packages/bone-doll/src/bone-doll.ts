import type { PartDef, RuntimeDir, SkeletonAsset, SlotDef, StorageDir } from './types'
import { hasLeftAssets, isRuntimeDir, storageDirOf } from './types'
import {
  compileAnimFor,
  compose,
  computeWorld,
  deviceBase,
  resolveSampleTime,
  resolveSetup,
  sampleAnim,
  slotDrawZ,
  type CompiledAnim,
  type FullPose,
  type Mat2D,
} from './math'
import { joinUrl, loadImage, loadSkeleton } from './loader'

export interface BoneDollOptions {
  /** 整数放大倍数（画布物理尺寸 = frame × scale；禁用平滑保证像素锐利） */
  scale?: number
  /** 骨骼世界平移取整（默认 true：整像素移动，像素风防抖） */
  snapTranslate?: boolean
}

interface LoadedPart {
  key: string
  def: PartDef
  /** storageDir → 已解码图片（缺方向 = 该方向不绘制，如 face 无背面） */
  images: Partial<Record<StorageDir, HTMLImageElement>>
}

interface DrawItem {
  z: number
  part: LoadedPart
  img: HTMLImageElement
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

/**
 * 骨骼纸娃娃运行时（纯 TS + Canvas2D，Px2d 风 chibi 路线）。
 *
 * - 播放：骨骼关键帧线性插值 → 世界矩阵（父链复合，平移取整）→ 按 slot.z 升序画部件图。
 * - 换装：equip(key) 即时穿上 / 卸下；同槽位默认互斥，stack 槽（hat/cape/weapon/acc）可叠加。
 * - 方向：down/up/left/right；left = right 画布级镜像，部件与关键帧零额外资产。
 * - 部件图默认「画布对齐」（64×64 整幅、绝对位置），rotate 围绕骨骼枢轴；裁剪件可用 align:'bone' + x/y。
 * - 双驱动：startLoop() 自带 rAF；或外部每帧 tick(dt) + render()（接 PIXI ticker）。
 */
export class BoneDoll {
  readonly skeleton: SkeletonAsset
  private readonly baseUrl: string
  private scale: number
  private readonly snapTranslate: boolean
  /** 独立 left 模式：骨架声明了 left 资产时，left 用自己的图/轨不再画布镜像 */
  private readonly independentLeft: boolean
  private canvas: AnyCanvas | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private loaded = new Map<string, LoadedPart>()
  private active = new Map<string, LoadedPart>()
  private setupCache = new Map<RuntimeDir, Map<string, FullPose>>()
  private setupWorldCache = new Map<RuntimeDir, Map<string, Mat2D>>()
  private compiledCache = new Map<string, CompiledAnim>()
  private direction: RuntimeDir
  private anim: string | null = null
  /** 秒 */
  private clock = 0
  private rafId = 0
  private lastT = 0

  /** 一次性动画播完回调（切 next 之后触发） */
  onAnimEnd: ((finished: string) => void) | null = null

  private constructor(skeleton: SkeletonAsset, baseUrl: string, opts: BoneDollOptions) {
    this.skeleton = skeleton
    this.baseUrl = baseUrl
    this.scale = Math.max(1, Math.floor(opts.scale ?? 1))
    this.snapTranslate = opts.snapTranslate ?? true
    this.independentLeft = hasLeftAssets(skeleton)
    this.direction = 'down'
  }

  static async load(baseUrl: string, opts: BoneDollOptions = {}): Promise<BoneDoll> {
    const skeleton = await loadSkeleton(baseUrl)
    const doll = new BoneDoll(skeleton, baseUrl, opts)
    for (const key of skeleton.defaultEquip ?? []) {
      if (skeleton.parts[key]) await doll.equip(key)
    }
    return doll
  }

  // ------------------------------------------------------------ 资产装载

  private async loadPart(key: string): Promise<LoadedPart> {
    const hit = this.loaded.get(key)
    if (hit) return hit
    const def = this.skeleton.parts[key]
    if (!def) throw new Error(`bone-doll: 未知部件键 ${key}`)
    const dirs = Object.keys(def.images) as StorageDir[]
    const entries = await Promise.all(
      dirs.map(async (dir) => {
        const spec = def.images[dir]
        if (!spec) return null
        const img = await loadImage(joinUrl(this.baseUrl, spec.src))
        return { dir, img }
      }),
    )
    const images: Partial<Record<StorageDir, HTMLImageElement>> = {}
    for (const e of entries) {
      if (e) images[e.dir] = e.img
    }
    const lp: LoadedPart = { key, def, images }
    this.loaded.set(key, lp)
    return lp
  }

  /** 穿上部件（同槽位非 stack 部件自动卸下）。已装备时重复调用 = 无操作。 */
  async equip(key: string): Promise<void> {
    if (this.active.has(key)) return
    const lp = await this.loadPart(key)
    const slot = this.slotOf(lp.def.slot)
    if (slot && !slot.stack) {
      for (const [k, other] of this.active) {
        if (other.def.slot === lp.def.slot && k !== key) this.active.delete(k)
      }
    }
    this.active.set(key, lp)
    this.render()
  }

  /** 卸下部件。 */
  unequip(key: string): void {
    if (!this.active.delete(key)) return
    this.render()
  }

  private slotOf(key: string): SlotDef | undefined {
    return this.skeleton.slots.find((s) => s.key === key)
  }

  // ------------------------------------------------------------ 播放控制

  /** 播放指定动画（缺省 = 继续当前）。切换动画时从头开始；restart=true 同动画也重头。 */
  play(anim?: string, opts?: { restart?: boolean }): void {
    if (anim !== undefined) {
      if (!this.skeleton.animations[anim]) {
        throw new Error(
          `bone-doll: 未知动画 ${anim}（可选 ${Object.keys(this.skeleton.animations).join('/')}）`,
        )
      }
      if (anim !== this.anim || opts?.restart) {
        this.anim = anim
        this.clock = 0
      }
    } else if (this.anim === null) {
      throw new Error('bone-doll: play() 前先用 play(name) 指定动画')
    }
    this.startLoop()
  }

  /** 暂停（保留当前姿态与进度）。 */
  pause(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }

  /** 恢复播放（等价 play()）。 */
  resume(): void {
    if (this.anim !== null) this.startLoop()
  }

  setDirection(dir: RuntimeDir): void {
    if (!isRuntimeDir(dir)) {
      throw new Error(`bone-doll: 未知方向 ${dir}（可选 down/up/left/right）`)
    }
    if (this.direction === dir) return
    this.direction = dir
    this.render()
  }

  /** 推进播放时钟（外部驱动模式：每帧 tick(dt) + render()）。 */
  tick(dtMs: number): void {
    if (this.anim === null) return
    const a = this.skeleton.animations[this.anim]
    this.clock += Math.min(dtMs, 250) / 1000 // 后台标签页回来时避免狂跳
    if (!a.loop && this.clock >= a.duration) {
      const finished = this.anim
      if (a.next && this.skeleton.animations[a.next]) {
        this.anim = a.next
        this.clock = 0
      } else {
        this.clock = a.duration
        this.pause()
      }
      this.onAnimEnd?.(finished)
    }
  }

  /** 绘制当前状态（无动画时画 setup pose 静态像）。 */
  render(): void {
    const ctx = this.ctx
    if (ctx === null) return
    const F = this.skeleton.frame
    const dir = this.direction
    const mirrored = dir === 'left' && !this.independentLeft
    const sd = this.independentLeft ? dir : storageDirOf(dir)

    const a = this.anim ? this.skeleton.animations[this.anim] : null
    const setup = this.setupFor(dir)
    const setupWorld = this.setupWorldFor(dir)
    let local: Map<string, FullPose>
    if (a) {
      const compiled = this.compiledFor(this.anim as string, dir)
      const time = resolveSampleTime(this.clock, a.duration, a.loop)
      local = sampleAnim(compiled, time, a.duration, a.loop, setup)
    } else {
      local = setup
    }
    const world = computeWorld(this.skeleton.bones, local, this.snapTranslate)

    // 收集绘制项：当前存储方向有图的已装备部件
    const items: DrawItem[] = []
    for (const part of this.active.values()) {
      const img = part.images[sd]
      const slot = this.slotOf(part.def.slot)
      if (!img || !slot) continue
      items.push({ z: slotDrawZ(slot, dir), part, img })
    }
    items.sort((x, y) => x.z - y.z) // Array.sort 稳定：同 z 保持装备顺序

    const base: Mat2D = deviceBase(F, this.scale, mirrored)
    ctx.setTransform(base.a, base.b, base.c, base.d, base.e, base.f)
    ctx.clearRect(0, 0, F, F)
    ctx.imageSmoothingEnabled = false

    for (const item of items) {
      const boneKey = this.slotOf(item.part.def.slot)?.bone
      if (!boneKey) continue
      const wm = world.get(boneKey)
      if (!wm) continue
      const spec = item.part.def.images[sd]
      const m = compose(base, wm)
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
      let ox: number
      let oy: number
      if (spec && spec.align === 'bone') {
        ox = spec.x ?? 0
        oy = spec.y ?? 0
      } else {
        // 画布对齐（默认）：图片按逻辑画布原点绘制，枢轴 = 骨骼的 setup 世界位置；
        // 骨骼旋转时整图围绕该枢轴转动（cutout 语义）
        const sw = setupWorld.get(boneKey)
        ox = -(sw?.e ?? 0)
        oy = -(sw?.f ?? 0)
      }
      ctx.drawImage(item.img, ox, oy)
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /** 自带 rAF 驱动（demo / 简单场景用；PIXI 场景请用 tick+render）。 */
  startLoop(): void {
    if (this.rafId || this.canvas === null) return
    const step = (t: number) => {
      this.tick(t - this.lastT)
      this.lastT = t
      this.render()
      this.rafId = requestAnimationFrame(step)
    }
    this.lastT = performance.now()
    this.rafId = requestAnimationFrame(step)
  }

  private setupFor(dir: RuntimeDir): Map<string, FullPose> {
    const hit = this.setupCache.get(dir)
    if (hit) return hit
    const s = resolveSetup(this.skeleton.bones, this.skeleton.setups, dir)
    this.setupCache.set(dir, s)
    return s
  }

  /** setup pose 的世界矩阵（部件画布对齐枢轴 = 骨骼 setup 世界位置） */
  private setupWorldFor(dir: RuntimeDir): Map<string, Mat2D> {
    const hit = this.setupWorldCache.get(dir)
    if (hit) return hit
    const w = computeWorld(this.skeleton.bones, this.setupFor(dir), false)
    this.setupWorldCache.set(dir, w)
    return w
  }

  private compiledFor(animKey: string, dir: RuntimeDir): CompiledAnim {
    const cacheKey = `${animKey}@${dir}`
    const hit = this.compiledCache.get(cacheKey)
    if (hit) return hit
    const c = compileAnimFor(this.skeleton.animations[animKey], dir)
    this.compiledCache.set(cacheKey, c)
    return c
  }

  // ------------------------------------------------------------ 画布

  attach(canvas: AnyCanvas): void {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    this.applySize()
    this.render()
  }

  detach(): void {
    this.pause()
    this.canvas = null
    this.ctx = null
  }

  setScale(n: number): void {
    this.scale = Math.max(1, Math.floor(n))
    this.applySize()
    this.render()
  }

  private applySize(): void {
    const c = this.canvas
    if (c === null || this.ctx === null) return
    const S = this.skeleton.frame * this.scale
    if (c.width !== S || c.height !== S) {
      c.width = S
      c.height = S
    }
    this.ctx.imageSmoothingEnabled = false
  }

  // ------------------------------------------------------------ 查询

  get currentAnim(): string | null {
    return this.anim
  }

  get currentDirection(): RuntimeDir {
    return this.direction
  }

  listAnims(): string[] {
    return Object.keys(this.skeleton.animations)
  }

  /** 部件目录：槽位 → 可选部件键列表（换装 UI 数据源） */
  listPartsBySlot(): Map<string, { key: string; name: string }[]> {
    const out = new Map<string, { key: string; name: string }[]>()
    for (const [key, def] of Object.entries(this.skeleton.parts)) {
      const list = out.get(def.slot) ?? []
      list.push({ key, name: def.name ?? key })
      out.set(def.slot, list)
    }
    return out
  }

  equipped(): string[] {
    return [...this.active.keys()]
  }

  isEquipped(key: string): boolean {
    return this.active.has(key)
  }

  /** 某动画是否存在。 */
  hasAnim(anim: string): boolean {
    return this.skeleton.animations[anim] !== undefined
  }

  dispose(): void {
    this.detach()
    this.loaded.clear()
    this.active.clear()
  }
}

export type { PartDef, RuntimeDir, SkeletonAsset, SlotDef, StorageDir }
export { storageDirOf, isRuntimeDir } from './types'
