import type { DollManifest, DollPart } from './types'
import { joinUrl, loadImage, loadManifest } from './loader'

interface LoadedLayer {
  zPos: number
  /** 动画 → (条带图, 列数)。部件缺某动画时无条目（运行时跳层）。 */
  strips: Map<string, { img: HTMLImageElement; cols: number }>
}

interface LoadedPart {
  key: string
  part: DollPart
  layers: LoadedLayer[]
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

export interface PaperDollOptions {
  /** 整数放大倍数（画布物理尺寸 = frame × scale；禁用平滑保证像素锐利） */
  scale?: number
}

/** 默认素体（LPC 人类男性裸体 + 人头；manifest 缺该键时静默跳过） */
const DEFAULT_PARTS = ['body/body', 'head/heads/human/heads_human_male']

/**
 * 纸娃娃分层动画运行时（纯 TS + Canvas2D，LPC 全库版）。
 *
 * - 播放：所有已装备部件的**所有图层**（各层独立条带）按 zPos 全局升序、
 *   同帧号叠加（翅膀前层 zPos 105 / 背层 zPos 5 正确夹住身体）。
 * - 换装：equip(key) 即时穿上 / 卸下；同 typeName 部件自动互斥（衬衫↔衬衫、
 *   翅膀↔翅膀），不同 typeName 叠加（翅膀 + 尾巴 + 盔甲共存）。
 * - 兜底：部件缺某动画（如武器无 idle）→ 该层该动画跳过，其余层照播。
 * - 双驱动：startLoop() 自带 rAF；或外部每帧调 tick(dt) + render()（接 PIXI ticker）。
 */
export class PaperDoll {
  readonly manifest: DollManifest
  private readonly baseUrl: string
  private scale: number
  private canvas: AnyCanvas | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private loaded = new Map<string, LoadedPart>()
  /** 已装备部件（key = 部件键；绘制时展开图层按 zPos 排序） */
  private active = new Map<string, LoadedPart>()
  private direction: string
  private anim: string | null = null
  private accMs = 0
  private tickN = 0
  private rafId = 0
  private lastT = 0

  private constructor(manifest: DollManifest, baseUrl: string, scale: number) {
    this.manifest = manifest
    this.baseUrl = baseUrl
    this.scale = Math.max(1, Math.floor(scale))
    this.direction = manifest.directions[Math.floor(manifest.directions.length / 2)] ?? manifest.directions[0]
  }

  static async load(baseUrl: string, opts: PaperDollOptions = {}): Promise<PaperDoll> {
    const manifest = await loadManifest(baseUrl)
    const doll = new PaperDoll(manifest, baseUrl, opts.scale ?? 1)
    for (const key of DEFAULT_PARTS) {
      if (manifest.parts[key]) await doll.equip(key)
    }
    return doll
  }

  // ------------------------------------------------------------ 资产装载

  private loadPart(key: string): Promise<LoadedPart> {
    const hit = this.loaded.get(key)
    if (hit) return Promise.resolve(hit)
    const part = this.manifest.parts[key]
    if (!part) return Promise.reject(new Error(`paper-doll: 未知部件键 ${key}`))
    const jobs: Promise<void>[] = []
    const layers: LoadedLayer[] = part.layers.map((l) => {
      const strips = new Map<string, { img: HTMLImageElement; cols: number }>()
      for (const [anim, rel] of Object.entries(l.anims)) {
        jobs.push(
          loadImage(joinUrl(this.baseUrl, rel)).then((img) => {
            strips.set(anim, { img, cols: l.cols[anim] ?? Math.floor(img.width / this.manifest.frame) })
          }),
        )
      }
      return { zPos: l.zPos, strips }
    })
    return Promise.all(jobs).then(() => {
      const lp: LoadedPart = { key, part, layers }
      this.loaded.set(key, lp)
      return lp
    })
  }

  /**
   * 穿上部件（同 typeName 的其他部件自动卸下；LPC 槽位语义）。
   * 已装备时重复调用 = 无操作。
   */
  async equip(key: string): Promise<void> {
    if (this.active.has(key)) return
    const lp = await this.loadPart(key)
    const tn = lp.part.typeName
    if (tn) {
      for (const [k, other] of this.active) {
        if (other.part.typeName === tn && k !== key) this.active.delete(k)
      }
    }
    this.active.set(key, lp)
    this.accMs = 0
    this.tickN = 0
    this.render()
  }

  /** 卸下部件（自由摘戴；装饰叠层/武器/翅膀随时可脱）。 */
  unequip(key: string): void {
    if (!this.active.delete(key)) return
    this.render()
  }

  // ------------------------------------------------------------ 播放控制

  /** 播放指定动画（缺省 = 继续当前）。切换动画时从头开始循环。 */
  play(anim?: string): void {
    if (anim !== undefined) {
      if (!this.manifest.animations[anim]) {
        throw new Error(`paper-doll: 未知动画 ${anim}（可选 ${Object.keys(this.manifest.animations).join('/')}）`)
      }
      if (anim !== this.anim) {
        this.anim = anim
        this.accMs = 0
        this.tickN = 0
      }
    } else if (this.anim === null) {
      throw new Error('paper-doll: play() 前先用 play(name) 指定动画')
    }
    this.startLoop()
  }

  /** 暂停在当前帧。 */
  stop(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }

  setDirection(dir: string): void {
    if (!this.manifest.directions.includes(dir)) {
      throw new Error(`paper-doll: 未知方向 ${dir}（可选 ${this.manifest.directions.join('/')}）`)
    }
    this.direction = dir
    this.render()
  }

  /** 推进播放时钟（外部驱动模式：每帧 tick(dt) + render()）。 */
  tick(dtMs: number): void {
    if (this.anim === null) return
    const a = this.manifest.animations[this.anim]
    this.accMs += Math.min(dtMs, 250) // 后台标签页回来时避免狂跳
    const stepMs = 1000 / a.fps
    while (this.accMs >= stepMs) {
      this.accMs -= stepMs
      this.tickN++
    }
  }

  /** 绘制当前状态（重复调用开销 ≈ 0，直接重画也很快）。 */
  render(): void {
    const ctx = this.ctx
    if (ctx === null || this.anim === null) return
    const { frame: F, directions } = this.manifest
    const S = F * this.scale
    ctx.clearRect(0, 0, S, S)
    const a = this.manifest.animations[this.anim]
    const col = a.cycle[this.tickN % a.cycle.length]
    const row = directions.indexOf(this.direction)
    if (row < 0) return
    // 全局 zPos 升序（Array.sort 稳定：同 zPos 保持装备顺序）
    const layers: LoadedLayer[] = []
    for (const lp of this.active.values()) layers.push(...lp.layers)
    layers.sort((x, y) => x.zPos - y.zPos)
    for (const layer of layers) {
      const strip = layer.strips.get(this.anim)
      if (!strip) continue // 缺动画 → 该层跳过（武器无 idle 等）
      if (col >= strip.cols) continue
      ctx.drawImage(strip.img, col * F, row * F, F, F, 0, 0, S, S)
    }
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

  // ------------------------------------------------------------ 画布

  attach(canvas: AnyCanvas): void {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    this.applySize()
    this.render()
  }

  detach(): void {
    this.stop()
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
    const S = this.manifest.frame * this.scale
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

  get currentDirection(): string {
    return this.direction
  }

  listAnims(): string[] {
    return Object.keys(this.manifest.animations)
  }

  listGroups(): DollManifest['groups'] {
    return this.manifest.groups
  }

  /** 当前已装备部件键（装备顺序）。 */
  equipped(): string[] {
    return [...this.active.keys()]
  }

  isEquipped(key: string): boolean {
    return this.active.has(key)
  }

  /** 当前装备下某动画是否至少有一层可播。 */
  hasAnim(anim: string): boolean {
    if (!this.manifest.animations[anim]) return false
    for (const lp of this.active.values()) {
      for (const layer of lp.layers) {
        if (layer.strips.has(anim)) return true
      }
    }
    return false
  }

  dispose(): void {
    this.detach()
    this.loaded.clear()
    this.active.clear()
  }
}
