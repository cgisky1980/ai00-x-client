/**
 * 骨骼数学核心（纯函数，无 DOM 依赖；node:test 确定性单测覆盖）。
 *
 * 确定性说明：变换合成只依赖 IEEE-754 双精度运算与 Math.cos/sin；
 * 同一 JS 引擎内「同输入恒同输出」，且 1px 取整后跨引擎末位差异不影响栅格化结果。
 */

import type { AnimDef, BoneDef, Keyframe, RuntimeDir, SkeletonAsset, SlotDef } from './types'
import { isStorageDir } from './types'

/**
 * 槽位在某运行时方向下的实际绘制 z：
 * - up（背视角）→ zBackView（披风盖背）
 * - left/right（侧视角）→ zSideView（披风披在侧面、盖住后半身）
 * - 其余（down 正面）→ z（披风藏身后，只露边缘）
 */
export function slotDrawZ(slot: SlotDef, dir: RuntimeDir): number {
  if (dir === 'up') return slot.zBackView ?? slot.z
  if (dir === 'left' || dir === 'right') return slot.zSideView ?? slot.z
  return slot.z
}

export interface Mat2D {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENT: Mat2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

/** 骨骼局部变换 T(x,y)·R(rDeg) */
export function trs(x: number, y: number, rDeg: number): Mat2D {
  const rad = (rDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return { a: cos, b: sin, c: -sin, d: cos, e: x, f: y }
}

/** p·l（先施加 l，再施加 p） */
export function compose(p: Mat2D, l: Mat2D): Mat2D {
  return {
    a: p.a * l.a + p.c * l.b,
    b: p.b * l.a + p.d * l.b,
    c: p.a * l.c + p.c * l.d,
    d: p.b * l.c + p.d * l.d,
    e: p.a * l.e + p.c * l.f + p.e,
    f: p.b * l.e + p.d * l.f + p.f,
  }
}

/** 逻辑坐标 → 设备坐标的基础矩阵（整数倍放大；mirrored = left 方向画布级镜像） */
export function deviceBase(frame: number, scale: number, mirrored: boolean): Mat2D {
  return mirrored
    ? { a: -scale, b: 0, c: 0, d: scale, e: frame * scale, f: 0 }
    : { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }
}

// ------------------------------------------------------------ setup pose

export interface FullPose {
  x: number
  y: number
  r: number
}

/** 解析某方向下的 setup pose（bones 基础值 + setups 方向校准；left 缺省继承 right 校准） */
export function resolveSetup(
  bones: BoneDef[],
  setups: SkeletonAsset['setups'],
  dir: RuntimeDir,
): Map<string, FullPose> {
  const patch = setups
    ? dir === 'up'
      ? setups.up
      : dir === 'right'
        ? setups.right
        : dir === 'left'
          ? (setups.left ?? setups.right)
          : undefined
    : undefined
  const out = new Map<string, FullPose>()
  for (const b of bones) {
    const o = patch?.[b.key]
    out.set(b.key, { x: o?.x ?? b.x, y: o?.y ?? b.y, r: o?.r ?? b.r ?? 0 })
  }
  return out
}

// ------------------------------------------------------------ 动画编译与采样

/** 单骨骼轨道条目（字段可缺 = 该字段不在此关键帧动） */
export interface BoneTrackEntry {
  t: number
  x?: number
  y?: number
  r?: number
}

/** 编译后的动画：boneKey → 轨道（按 t 升序） */
export type CompiledAnim = Map<string, BoneTrackEntry[]>

/** 把方向关键帧列表编译成按骨骼索引的轨道表 */
export function compileAnim(keys: Keyframe[] | undefined): CompiledAnim {
  const map: CompiledAnim = new Map()
  if (!keys) return map
  for (const k of keys) {
    for (const [boneKey, pose] of Object.entries(k.bones)) {
      let list = map.get(boneKey)
      if (!list) {
        list = []
        map.set(boneKey, list)
      }
      list.push({ t: k.t, x: pose.x, y: pose.y, r: pose.r })
    }
  }
  for (const list of map.values()) list.sort((p, q) => p.t - q.t)
  return map
}

/** 按方向编译动画轨道（left 缺省继承 right 轨；镜像由渲染层负责） */
export function compileAnimFor(anim: AnimDef, dir: RuntimeDir): CompiledAnim {
  return compileAnim(anim.tracks[dir] ?? (dir === 'left' ? anim.tracks.right : undefined))
}

/** 播放时钟 → 采样域：loop 折叠进 [0,duration)，one-shot 截断 */
export function resolveSampleTime(t: number, duration: number, loop: boolean): number {
  if (loop) {
    const m = t % duration
    return m < 0 ? m + duration : m
  }
  return Math.min(Math.max(t, 0), duration)
}

/**
 * 采样单骨骼单字段：线性插值。
 * loop=true 时 time 应已在 [0,duration) 内，末关键帧之后回绕接首关键帧；
 * loop=false 时 time 已被截断，起点前取首值、终点后取末值；
 * 全程未提及该字段 = setup 值。
 */
export function sampleField(
  track: BoneTrackEntry[] | undefined,
  time: number,
  duration: number,
  loop: boolean,
  setup: number,
  field: 'x' | 'y' | 'r',
): number {
  if (!track) return setup
  const defined: BoneTrackEntry[] = []
  for (const e of track) if (e[field] !== undefined) defined.push(e)
  if (defined.length === 0) return setup

  let prev: BoneTrackEntry | undefined
  let next: BoneTrackEntry | undefined
  for (const e of defined) {
    if (e.t <= time) prev = e
    else {
      next = e
      break
    }
  }

  if (loop) {
    if (prev === undefined) prev = defined[defined.length - 1]
    if (next === undefined) next = defined[0]
    let span = next.t - prev.t
    if (span <= 0) span += duration // 首尾跨接
    let d = time - prev.t
    if (d < 0) d += duration
    const w = span === 0 ? 0 : d / span
    return (prev[field] as number) * (1 - w) + (next[field] as number) * w
  }

  if (prev === undefined) return defined[0][field] as number
  if (next === undefined) return prev[field] as number
  const span = next.t - prev.t
  const w = span === 0 ? 0 : (time - prev.t) / span
  return (prev[field] as number) * (1 - w) + (next[field] as number) * w
}

/** 采样动画在 time 时刻的全骨骼局部姿态（setup ∪ 轨道覆盖；time 需先经 resolveSampleTime） */
export function sampleAnim(
  compiled: CompiledAnim,
  time: number,
  duration: number,
  loop: boolean,
  setup: Map<string, FullPose>,
): Map<string, FullPose> {
  const out = new Map<string, FullPose>()
  for (const [key, sp] of setup) out.set(key, { x: sp.x, y: sp.y, r: sp.r })
  for (const [boneKey, track] of compiled) {
    const base = setup.get(boneKey) ?? { x: 0, y: 0, r: 0 }
    out.set(boneKey, {
      x: sampleField(track, time, duration, loop, base.x, 'x'),
      y: sampleField(track, time, duration, loop, base.y, 'y'),
      r: sampleField(track, time, duration, loop, base.r, 'r'),
    })
  }
  return out
}

// ------------------------------------------------------------ 世界矩阵

/**
 * 计算全骨骼世界矩阵（父→子复合）。
 * snapTranslate = true 时每骨世界平移取整：角色按整像素移动（像素风防抖），子骨继承整数枢轴。
 * 骨骼数组顺序不保证父先子后，内部记忆化解析；缺父/成环抛错。
 */
export function computeWorld(
  bones: BoneDef[],
  local: Map<string, FullPose>,
  snapTranslate: boolean,
): Map<string, Mat2D> {
  const byKey = new Map<string, BoneDef>()
  for (const b of bones) byKey.set(b.key, b)
  const world = new Map<string, Mat2D>()
  const resolving = new Set<string>()

  const visit = (key: string): Mat2D => {
    const hit = world.get(key)
    if (hit) return hit
    const def = byKey.get(key)
    if (!def) throw new Error(`bone-doll: 未知骨骼 ${key}`)
    if (resolving.has(key)) throw new Error(`bone-doll: 骨骼成环 ${key}`)
    resolving.add(key)
    const pose = local.get(key) ?? { x: def.x, y: def.y, r: def.r ?? 0 }
    const parentMat = def.parent ? visit(def.parent) : IDENT
    const m = compose(parentMat, trs(pose.x, pose.y, pose.r))
    if (snapTranslate) {
      m.e = Math.round(m.e)
      m.f = Math.round(m.f)
    }
    resolving.delete(key)
    world.set(key, m)
    return m
  }

  for (const b of bones) visit(b.key)
  return world
}

// ------------------------------------------------------------ 校验

/** 资产完整性校验，返回错误列表（空数组 = 通过） */
export function validateSkeleton(a: SkeletonAsset): string[] {
  const errs: string[] = []
  if (a.version !== 1 && a.version !== 2) errs.push(`version 必须为 1 或 2，得到 ${String(a.version)}`)
  if (!(a.frame > 0)) errs.push('frame 必须 > 0')
  const boneKeys = new Set<string>()
  for (const b of a.bones) {
    if (boneKeys.has(b.key)) errs.push(`骨骼键重复 ${b.key}`)
    boneKeys.add(b.key)
  }
  for (const b of a.bones) {
    if (b.parent !== null && !boneKeys.has(b.parent)) errs.push(`骨骼 ${b.key} 的父 ${b.parent} 不存在`)
  }
  const color = new Map<string, 0 | 1 | 2>()
  const byKey = new Map(a.bones.map((b) => [b.key, b]))
  const dfs = (key: string): void => {
    color.set(key, 1)
    const def = byKey.get(key)
    if (def?.parent) {
      const c = color.get(def.parent)
      if (c === 1) errs.push(`骨骼成环：${def.parent} → ${key}`)
      else if (c === undefined) dfs(def.parent)
    }
    color.set(key, 2)
  }
  for (const b of a.bones) if (color.get(b.key) === undefined) dfs(b.key)

  const slotKeys = new Set<string>()
  for (const s of a.slots) {
    if (slotKeys.has(s.key)) errs.push(`槽位键重复 ${s.key}`)
    slotKeys.add(s.key)
    if (!boneKeys.has(s.bone)) errs.push(`槽位 ${s.key} 挂到未知骨骼 ${s.bone}`)
  }
  for (const [pk, p] of Object.entries(a.parts)) {
    if (!slotKeys.has(p.slot)) errs.push(`部件 ${pk} 挂到未知槽位 ${p.slot}`)
    for (const [dir, img] of Object.entries(p.images)) {
      if (!isStorageDir(dir)) errs.push(`部件 ${pk} 含非法方向 ${dir}`)
      if (img && !img.src) errs.push(`部件 ${pk} 方向 ${dir} 缺 src`)
    }
  }
  for (const [ak, anim] of Object.entries(a.animations)) {
    if (!(anim.duration > 0)) errs.push(`动画 ${ak} duration 必须 > 0`)
    if (anim.next && !a.animations[anim.next]) errs.push(`动画 ${ak} 的 next ${anim.next} 不存在`)
    for (const [dir, keys] of Object.entries(anim.tracks)) {
      if (!isStorageDir(dir)) errs.push(`动画 ${ak} 含非法方向轨道 ${dir}`)
      for (const k of keys ?? []) {
        if (!(k.t >= 0 && k.t <= anim.duration)) {
          errs.push(`动画 ${ak}[${dir}] 关键帧 t=${k.t} 越界 [0,${anim.duration}]`)
        }
        for (const bk of Object.keys(k.bones)) {
          if (!boneKeys.has(bk)) errs.push(`动画 ${ak}[${dir}] 引用未知骨骼 ${bk}`)
        }
      }
    }
  }
  return errs
}
