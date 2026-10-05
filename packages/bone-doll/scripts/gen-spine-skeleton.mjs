/**
 * Spine 骨架生成器：固定素体（bone-doll assets）→ Spine 4.3 JSON + atlas + 打包纹理页。
 *
 * 映射规则（推导见 参考/bone-doll-Spine化一期-实施记录.md）：
 * - 坐标系：bone-doll 画布 y 向下/顺时针角 ↔ Spine y 向上/逆时针角。
 *   每骨局部 (x,y,r) → (x,-y,-r) 严格等价（M·T·R·M⁻¹ 分解，M = flipY）；
 *   运行时 Skeleton.yDown = true 渲染翻回画布视觉。
 * - 四方向 = 四 skin（down/up/left/right）；部件无 left 图时 left attachment = right 图
 *   镜像 mesh（顶点 x 取反、UV 原样、共用图块，零纹理开销）。
 * - 遮挡差异（zBackView/zSideView）：slot 拆分（cape → cape_d/cape_s/cape_b），
 *   各方向 skin 只填对应 slot，绘制序 = slots 数组按 z 升序。
 * - 部件 attachment = 非加权 mesh（alpha 包围盒上 min(4,边长)×min(4,边长) 顶点自动网格化，
 *   外圈环序排前 = hull），整体绑定 slot 骨骼；顶点 = 画布点 − 骨骼 setup 世界位置（canvas 对齐）。
 * - setup patch（方向校准，绝对替换语义）：动画未覆盖的字段补恒定轨钉住 patch 值；
 *   x/y 合并为一条 translate 轨（Spine x/y 独立插值，与 bone-doll 字段独立语义一致）。
 * - left 动画缺省 = right 数值镜像（x→−x、r→−r、y 不变），attachment 已在 skin 层镜像。
 * - region 名 = `{part}@{dir}`（各方向图独立裁剪，bounds 互不相同，region 必须一一对应）；
 *   attachment 名 = part（skin 内槽位下唯一），path 指向对应 region。
 *
 * 幂等：确定性遍历 + 固定排序，重跑 diff 为空。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePNG } from './lib/png-decode.mjs'
import { trimAlpha, pack, blit, buildAtlasText, encodePNG } from './lib/atlas-pack.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const ASSETS = join(ROOT, 'assets')
const OUT = join(ASSETS, 'spine')
const DIRS = ['down', 'up', 'left', 'right']
const r4 = (v) => Math.round(v * 10000) / 10000

// ------------------------------------------------------- 骨骼数学（与 src/math.ts 同构精简版，精确值不 snap）

function trs(x, y, rDeg) {
  const rad = (rDeg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { a: c, b: s, c: -s, d: c, e: x, f: y }
}

function compose(p, l) {
  return {
    a: p.a * l.a + p.c * l.b,
    b: p.b * l.a + p.d * l.b,
    c: p.a * l.c + p.c * l.d,
    d: p.b * l.c + p.d * l.d,
    e: p.a * l.e + p.c * l.f + p.e,
    f: p.b * l.e + p.d * l.f + p.f,
  }
}

const IDENT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function mirrorPatch(patch) {
  if (!patch) return undefined
  const out = {}
  for (const [k, p] of Object.entries(patch)) {
    const q = { ...p }
    if (q.x !== undefined) q.x = -q.x
    if (q.r !== undefined) q.r = -q.r
    out[k] = q
  }
  return out
}

function hasLeftAssets(asset) {
  if (asset.directions.includes('left')) return true
  for (const p of Object.values(asset.parts)) if (p.images.left) return true
  return false
}

/** 方向 setup patch（left 缺省：独立 left → right patch 原样；镜像模式 → right patch 取反 x/r） */
function patchOf(asset, dir, hasLeft) {
  const st = asset.setups
  if (dir === 'up') return st?.up
  if (dir === 'right') return st?.right
  if (dir === 'left') {
    if (st?.left) return st.left
    return hasLeft ? st?.right : mirrorPatch(st?.right)
  }
  return undefined // down
}

/** bone-doll 语义 setup pose（patch 绝对替换，即 resolveSetup 等价） */
function setupPose(asset, dir, hasLeft) {
  const patch = patchOf(asset, dir, hasLeft)
  const out = new Map()
  for (const b of asset.bones) {
    const o = patch?.[b.key]
    out.set(b.key, { x: o?.x ?? b.x, y: o?.y ?? b.y, r: o?.r ?? b.r ?? 0 })
  }
  return out
}

/** setup 世界矩阵（父链复合，精确值） */
function setupWorld(asset, dir, hasLeft) {
  const local = setupPose(asset, dir, hasLeft)
  const byKey = new Map(asset.bones.map((b) => [b.key, b]))
  const world = new Map()
  const visit = (key) => {
    const hit = world.get(key)
    if (hit) return hit
    const def = byKey.get(key)
    const m = compose(def.parent ? visit(def.parent) : IDENT, trs(local.get(key).x, local.get(key).y, local.get(key).r))
    world.set(key, m)
    return m
  }
  for (const b of asset.bones) visit(b.key)
  return world
}

// ------------------------------------------------------- slot 拆分（遮挡差异 → 方向专属 slot）

/**
 * 单一 z → 原名；多 z → `key_d`（down 基准）/`key_s`（side）/`key_b`（back），同 z 共用。
 * 返回 spineSlots（z 升序）与 dirSlot[`{slot}@{dir}`] → spine slot 名。
 */
function splitSlots(asset) {
  const spineSlots = []
  const dirSlot = {}
  for (const slot of asset.slots) {
    const zDown = slot.z
    const zSide = slot.zSideView ?? slot.z
    const zBack = slot.zBackView ?? slot.z
    const uniq = [...new Set([zDown, zSide, zBack])]
    if (uniq.length === 1) {
      spineSlots.push({ name: slot.key, bone: slot.bone, z: zDown, order: slot.key })
      for (const d of DIRS) dirSlot[`${slot.key}@${d}`] = slot.key
      continue
    }
    const nameOf = (z) => (z === zDown ? `${slot.key}_d` : z === zSide ? `${slot.key}_s` : `${slot.key}_b`)
    for (const z of uniq) spineSlots.push({ name: nameOf(z), bone: slot.bone, z, order: `${slot.key}_${z}` })
    dirSlot[`${slot.key}@down`] = nameOf(zDown)
    dirSlot[`${slot.key}@left`] = nameOf(zSide)
    dirSlot[`${slot.key}@right`] = nameOf(zSide)
    dirSlot[`${slot.key}@up`] = nameOf(zBack)
  }
  spineSlots.sort((a, b) => a.z - b.z || (a.order < b.order ? -1 : 1))
  return { spineSlots, dirSlot }
}

// ------------------------------------------------------- mesh attachment

/**
 * 网格化 mesh：trim 包围盒上 cols×rows 顶点（外圈环序 = hull 排前）。
 * canvas 对齐：局部 = 画布点 − 骨骼 setup 世界位置 (e,f)；bone 对齐：局部 = spec 偏移 + 图内点。
 * spine 系 y 取反；镜像（left 无独立图）x 取反、UV 原样。
 */
function makeMesh(part, dir, useDir, spec, trim, e, f, bounds, mirrored) {
  const cols = Math.min(4, Math.max(2, trim.w))
  const rows = Math.min(4, Math.max(2, trim.h))

  // 输出序：外圈环序（top 左→右 / right 上→下 / bottom 右→左 / left 下→上）→ 内部行序
  const order = []
  const seen = new Set()
  const push = (i, j) => {
    const k = j * cols + i
    if (!seen.has(k)) {
      seen.add(k)
      order.push(k)
    }
  }
  for (let i = 0; i < cols; i++) push(i, 0)
  for (let j = 1; j < rows; j++) push(cols - 1, j)
  for (let i = cols - 2; i >= 0; i--) push(i, rows - 1)
  for (let j = rows - 2; j >= 1; j--) push(0, j)
  for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) push(i, j)
  const idxMap = new Array(cols * rows)
  order.forEach((k, out) => (idxMap[k] = out))

  const vertices = []
  const uvs = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      // 画布像素坐标（浮点均匀网格）
      const px = trim.x + (trim.w * i) / (cols - 1)
      const py = trim.y + (trim.h * j) / (rows - 1)
      let lx
      let ly
      if (spec.align === 'bone') {
        lx = (spec.x ?? 0) + px
        ly = (spec.y ?? 0) + py
      } else {
        lx = px - e
        ly = py - f
      }
      vertices.push(r4(mirrored ? -lx : lx), r4(-ly))
      // UV：图块内归一化（v=0 顶部）；镜像不翻 UV（视觉翻转由顶点完成）
      uvs.push(r4((px - trim.x) / trim.w), r4((py - trim.y) / trim.h))
    }
  }

  // 网格三角（grid 索引经 idxMap 映射）
  const triangles = []
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const p00 = idxMap[j * cols + i]
      const p10 = idxMap[j * cols + i + 1]
      const p01 = idxMap[(j + 1) * cols + i]
      const p11 = idxMap[(j + 1) * cols + i + 1]
      triangles.push(p00, p10, p01, p10, p11, p01)
    }
  }

  return {
    type: 'mesh',
    path: `${part}@${useDir}`, // 指向实际图块 region（镜像时 = right 图块）
    vertices,
    triangles,
    uvs,
    hull: 2 * cols + 2 * rows - 4,
    width: trim.w,
    height: trim.h,
    ...bounds,
  }
}

// ------------------------------------------------------- 动画迁移

/**
 * bone-doll 方向轨（bone-doll 语义值）→ spine rotate/translate 通道。
 * left 无独立轨时用 right 数值镜像（x→−x、r→−r、y 不变）。
 * setup patch 未覆盖字段补恒定轨（钉住方向校准）；x/y 合并 translate（Spine x/y 独立插值）。
 */
function convertAnim(asset, anim, dir, hasLeft) {
  const mirror = dir === 'left' && !anim.tracks.left
  const srcKeys = dir === 'left' && !anim.tracks.left ? anim.tracks.right : anim.tracks[dir]
  const setup = setupPose(asset, dir, hasLeft)
  const base = new Map(asset.bones.map((b) => [b.key, b]))

  // 骨 → 字段 → 帧列表（bone-doll 语义值；镜像在此应用）
  const fields = new Map()
  for (const k of srcKeys ?? []) {
    for (const [boneKey, pose] of Object.entries(k.bones)) {
      let fm = fields.get(boneKey)
      if (!fm) {
        fm = { x: [], y: [], r: [] }
        fields.set(boneKey, fm)
      }
      if (pose.x !== undefined) fm.x.push({ t: k.t, v: mirror ? -pose.x : pose.x })
      if (pose.y !== undefined) fm.y.push({ t: k.t, v: pose.y })
      if (pose.r !== undefined) fm.r.push({ t: k.t, v: mirror ? -pose.r : pose.r })
    }
  }

  const bones = {}
  const addEntry = (boneKey, entry) => {
    if (Object.keys(entry).length) bones[boneKey] = entry
  }
  for (const [boneKey, fm] of fields) {
    for (const list of Object.values(fm)) list.sort((a, b) => a.t - b.t)
    const sp = setup.get(boneKey)
    const bd = base.get(boneKey)
    // spine 4.2+ timeline 值 = 相对 setup 的偏移（pose = setup + value）：
    // 偏移 = spine 绝对局部值 − spine setup 绝对值；spine 绝对值 = (x, -y, -r)
    const entry = {}
    if (fm.x.length || fm.y.length) {
      // x/y 帧时间并集，每帧补齐缺字段（= 恒定 setup 值）
      const times = [...new Set([...fm.x, ...fm.y].map((k) => k.t))].sort((a, b) => a - b)
      const at = (list, t) => list.find((k) => k.t === t)?.v
      entry.translate = times.map((t) => ({
        time: t,
        x: r4((at(fm.x, t) ?? sp.x) - bd.x),
        y: r4(bd.y - (at(fm.y, t) ?? sp.y)),
      }))
    } else if (sp.x !== bd.x || sp.y !== bd.y) {
      entry.translate = [{ time: 0, x: r4(sp.x - bd.x), y: r4(bd.y - sp.y) }]
    }
    if (fm.r.length) {
      // spine 4.3 runtime readTimeline1 只读 value 字段（angle 是旧版 JSON 格式，4.3 会静默忽略）
      entry.rotate = fm.r.map((k) => ({ time: k.t, value: r4(bd.r ?? 0) - r4(k.v) }))
    } else if (sp.r !== (bd.r ?? 0)) {
      entry.rotate = [{ time: 0, value: r4((bd.r ?? 0) - sp.r) }]
    }
    addEntry(boneKey, entry)
  }
  // patch 骨骼完全未参与动画 → 恒定轨钉住校准（偏移 = patch 后绝对 − 基础绝对）
  const patch = patchOf(asset, dir, hasLeft) ?? {}
  for (const boneKey of Object.keys(patch)) {
    if (bones[boneKey]) continue
    const sp = setup.get(boneKey)
    const bd = base.get(boneKey)
    addEntry(boneKey, {
      ...(sp.x !== bd.x || sp.y !== bd.y ? { translate: [{ time: 0, x: r4(sp.x - bd.x), y: r4(bd.y - sp.y) }] } : {}),
      ...(sp.r !== (bd.r ?? 0) ? { rotate: [{ time: 0, value: r4((bd.r ?? 0) - sp.r) }] } : {}),
    })
  }
  return bones
}

// ------------------------------------------------------- 主流程

function main() {
  const asset = JSON.parse(readFileSync(join(ASSETS, 'skeleton.json'), 'utf8'))
  const hasLeft = hasLeftAssets(asset)
  console.log(`[gen-spine] 素体 v${asset.version} frame=${asset.frame} left独立=${hasLeft}`)

  // 1. 部件方向图 → 解码 → trim
  const blocks = [] // { part, dir, spec, w, h, trim }
  for (const [partKey, def] of Object.entries(asset.parts)) {
    for (const dir of DIRS) {
      const spec = def.images[dir]
      if (!spec) continue
      const png = decodePNG(readFileSync(join(ASSETS, spec.src)))
      const trim = trimAlpha(png.width, png.height, png.rgba)
      if (!trim) continue
      blocks.push({ part: partKey.replaceAll('/', '.'), dir, spec, w: png.width, h: png.height, trim })
    }
  }
  // 1b. 部件库变体（assets/spine/parts/config.json，import-pack 落盘）→ 与素体图块一起聚合进 atlas/skins。
  //     变体 attachment 名 = `{slot}.{name}`（region 名 `{slot}.{name}@{dir}`），挂所在槽位骨骼，与素体部件同 slot 互斥显示。
  const libPath = join(OUT, 'parts', 'config.json')
  const lib = existsSync(libPath) ? JSON.parse(readFileSync(libPath, 'utf8')) : null
  const libVariants = []
  for (const [slotKey, def] of Object.entries(lib?.slots ?? {})) {
    if (!asset.slots.some((s) => s.key === slotKey)) throw new Error(`gen-spine: 部件库未知槽位 ${slotKey}`)
    for (const [name, v] of Object.entries(def.variants ?? {})) {
      // 已存在于素体 parts（旧流程 import-pack 会合并 skeleton.json）→ 基础循环已按同名注册，跳过避免双注册
      if (asset.parts[`${slotKey}/${name}`]) continue
      libVariants.push({ slotKey, name, key: `${slotKey}.${name}`, images: v.images ?? {} })
    }
  }
  for (const v of libVariants) {
    for (const dir of DIRS) {
      const spec = v.images[dir]
      if (!spec) continue
      const png = decodePNG(readFileSync(join(OUT, spec.src)))
      const trim = trimAlpha(png.width, png.height, png.rgba)
      if (!trim) continue
      blocks.push({ part: v.key, dir, spec, w: png.width, h: png.height, trim })
    }
  }
  console.log(`[gen-spine] 图块 ${blocks.length} 个（部件库变体 ${libVariants.length}）`)

  // 2. 打包 → 页纹理 + atlas 文本（region 名 = part@dir）
  const packed = pack(blocks.map((b) => ({ name: `${b.part}@${b.dir}`, w: b.trim.w, h: b.trim.h })))
  const page = new Uint8Array(packed.pageW * packed.pageH * 4)
  const boundsOf = new Map()
  const regions = []
  for (const b of blocks) {
    const key = `${b.part}@${b.dir}`
    const slot = packed.slots.get(key)
    blit(page, packed.pageW, slot.x, slot.y, b.trim.w, b.trim.h, b.trim.rgba)
    const bounds = { x: slot.x, y: slot.y, w: b.trim.w, h: b.trim.h }
    boundsOf.set(key, bounds)
    regions.push({ name: key, bounds })
  }
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'doll.png'), encodePNG(packed.pageW, packed.pageH, page))
  writeFileSync(join(OUT, 'doll.atlas'), buildAtlasText('doll.png', packed.pageW, packed.pageH, regions))

  // 3. bones（(x,y,r) → (x,-y,-r)）
  const bones = asset.bones.map((b) => {
    const o = { name: b.key, x: r4(b.x), y: r4(-b.y), rotation: r4(-(b.r ?? 0)) }
    if (b.parent) o.parent = b.parent
    return o
  })

  // 4. slots（拆分 + z 升序 = 绘制序）；attachment = setup 占位名（= part 键，四 skin 一致），
  //    运行时 setSkin + setupPoseSlots 靠它按 skin 查附件（无该字段 slot 永远空白）
  const { spineSlots, dirSlot } = splitSlots(asset)
  const partOfSpineSlot = new Map()
  for (const [partKey, def] of Object.entries(asset.parts)) {
    for (const dir of DIRS) {
      const s = dirSlot[`${def.slot}@${dir}`]
      if (s && !partOfSpineSlot.has(s)) partOfSpineSlot.set(s, partKey.replaceAll('/', '.'))
    }
  }
  const slots = spineSlots.map((s) => {
    const attachment = partOfSpineSlot.get(s.name)
    return attachment ? { name: s.name, bone: s.bone, attachment } : { name: s.name, bone: s.bone }
  })

  // 5. skins（四方向；setup 世界反推顶点）
  const boneOfSlot = new Map(asset.slots.map((s) => [s.key, s.bone]))
  const setupWorlds = new Map()
  const worldOf = (dir) => {
    if (!setupWorlds.has(dir)) setupWorlds.set(dir, setupWorld(asset, dir, hasLeft))
    return setupWorlds.get(dir)
  }
  const skinAttachments = {}
  for (const dir of DIRS) skinAttachments[dir] = {}
  for (const [partKey, def] of Object.entries(asset.parts)) {
    const part = partKey.replaceAll('/', '.')
    for (const dir of DIRS) {
      // left 缺图 → right 图镜像顶点；其余方向用自身图
      const useDir = dir === 'left' && !def.images.left ? 'right' : dir
      const spec = def.images[useDir]
      if (!spec) continue // 该方向无图（如 face 无 up）→ skin 不填 = 隐藏
      const mirrored = dir !== useDir
      const block = blocks.find((b) => b.part === part && b.dir === useDir)
      if (!block) throw new Error(`gen-spine: 图块缺失 ${part} ${useDir}`)
      const spineSlot = dirSlot[`${def.slot}@${dir}`]
      if (!spineSlot) throw new Error(`gen-spine: 未知槽位 ${def.slot}`)
      const boneKey = boneOfSlot.get(def.slot)
      const wm = worldOf(useDir).get(boneKey)
      if (!wm) throw new Error(`gen-spine: 未知骨骼 ${boneKey}`)
      const bounds = boundsOf.get(`${part}@${useDir}`)
      const mesh = makeMesh(part, dir, useDir, spec, block.trim, wm.e, wm.f, { bounds }, mirrored)
      ;(skinAttachments[dir][spineSlot] ??= {})[part] = mesh
    }
  }
  // 5b. 部件库变体 attachment（left 缺图 → right 镜像，与素体部件同规则）
  for (const v of libVariants) {
    for (const dir of DIRS) {
      const useDir = dir === 'left' && !v.images.left ? 'right' : dir
      const spec = v.images[useDir]
      if (!spec) continue
      const mirrored = dir !== useDir
      const block = blocks.find((b) => b.part === v.key && b.dir === useDir)
      if (!block) throw new Error(`gen-spine: 部件库图块缺失 ${v.key} ${useDir}`)
      const spineSlot = dirSlot[`${v.slotKey}@${dir}`]
      if (!spineSlot) throw new Error(`gen-spine: 部件库未知槽位 ${v.slotKey}`)
      const boneKey = boneOfSlot.get(v.slotKey)
      const wm = worldOf(useDir).get(boneKey)
      if (!wm) throw new Error(`gen-spine: 未知骨骼 ${boneKey}`)
      const bounds = boundsOf.get(`${v.key}@${useDir}`)
      const mesh = makeMesh(v.key, dir, useDir, spec, block.trim, wm.e, wm.f, { bounds }, mirrored)
      ;(skinAttachments[dir][spineSlot] ??= {})[v.key] = mesh
    }
  }
  const skins = DIRS.map((dir) => ({ name: dir, attachments: skinAttachments[dir] }))

  // 6. 动画迁移（四方向 = 四个后缀动画：idle_down / idle_up / ...）
  const animations = {}
  for (const [name, anim] of Object.entries(asset.animations)) {
    for (const dir of DIRS) {
      animations[`${name}_${dir}`] = { bones: convertAnim(asset, anim, dir, hasLeft) }
    }
  }

  // 7. 骨架 JSON
  const out = {
    skeleton: { hash: 'gen-bone-doll', spine: '4.3.7', x: 0, y: 0, width: asset.frame, height: asset.frame },
    bones,
    slots,
    skins,
    animations,
  }
  writeFileSync(join(OUT, 'doll.json'), JSON.stringify(out, null, 2) + '\n')

  const stats = {
    bones: bones.length,
    slots: slots.length,
    attachments: DIRS.reduce((n, d) => n + Object.keys(skinAttachments[d]).length, 0),
    animations: Object.keys(animations).length,
    page: `${packed.pageW}x${packed.pageH}`,
  }
  console.log(`[gen-spine] 完成 ${JSON.stringify(stats)} → assets/spine/`)
}

main()
