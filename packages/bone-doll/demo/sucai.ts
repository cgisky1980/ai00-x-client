/**
 * 素体工坊：画/导入素体 → 矩形选区切到部件槽位（槽位 = 骨骼绑定）→ 导出部件包。
 *
 * 工作流（人工切割，非机器逆拆解，不触碰红线）：
 * 1. 导入底图 / 载入当前素体 / 空白起稿（draft 层）
 * 2. 矩形选区框住一段身体 → 选目标槽位 → 切割（像素从源层移到槽位层）；选区内拖拽 = 移动
 * 3. 铅笔/橡皮/油漆桶/画线 修边与绘制（画在激活槽位层上）
 * 4. 三个方向各切一套 → 导出部件包 JSON → node scripts/import-pack.mjs 落盘
 *
 * 视图：滚轮缩放（以光标为中心，2~32×）、空格/中键拖拽平移。
 * 撤销：Ctrl+Z / Ctrl+Y，按操作步记录受影响层（50 步）。
 */
import { compileAnimFor, compose, computeWorld, deviceBase, resolveSampleTime, resolveSetup, sampleAnim } from '../src/math'
import { joinUrl, loadImage } from '../src/loader'
import type { SkeletonAsset, SlotDef, StorageDir } from '../src/types'

const F = 64
const canvas = document.getElementById('stage') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D

const DIRS: StorageDir[] = ['down', 'up', 'left', 'right']
let skel: SkeletonAsset
let dir: StorageDir = 'down'
let active = 'draft'
let tool: 'pencil' | 'eraser' | 'rect' | 'bucket' | 'line' = 'pencil'
let color = '#f6caa8'
let sel: { x: number; y: number; w: number; h: number } | null = null
let selStart: { x: number; y: number } | null = null
let hover: { x: number; y: number } | null = null
let painting = false
let last: { x: number; y: number } | null = null
const hidden = new Set<string>()
/** 聚焦模式：激活层不透明、其余层近乎透明；关掉 = 普通合成预览 */
let focus = true
/** 选区移动：patch = 抠出的像素，x/y = 当前目标左上角（激活层内移动） */
let move: { patch: Uint8ClampedArray; patchCanvas: HTMLCanvasElement; w: number; h: number; ox: number; oy: number; x: number; y: number } | null = null
/** 画线：锚点 + 预览格 */
let lineAnchor: { x: number; y: number } | null = null
let linePreview: { x: number; y: number }[] = []

/** 视图：zoom = 每逻辑像素的设备像素；pan = 画布内平移（设备像素） */
const view = { zoom: 8, panX: 0, panY: 0 }
let spaceDown = false
let panning: { cx: number; cy: number; px: number; py: number } | null = null

/** 调试探针（页内控制台 / 自动化验收用） */
const dbg = {
  events: [] as string[],
  state: () => ({
    active, focus, dir,
    zoom: view.zoom,
    layers: Object.entries(bufs[dir] ?? {}).map(([k, b]) => [k, b ? b.some((v, i) => i % 4 === 3 && v > 0) : false]),
  }),
}
;(window as unknown as Record<string, unknown>).__dbg = dbg

/** 每方向 × 槽位一块 RGBA 缓冲（64×64×4，画布对齐）；四方向全量初始化（无 left 缓冲时遍历 DIRS 会崩） */
const bufs: Record<string, Partial<Record<string, Uint8ClampedArray>>> = Object.fromEntries(DIRS.map((d) => [d, {}]))

function buf(d: StorageDir, slot: string): Uint8ClampedArray {
  let m = bufs[d]
  if (!m) m = bufs[d] = {}
  let b = m[slot]
  if (!b) b = m[slot] = new Uint8ClampedArray(F * F * 4)
  return b
}

const SLOT_LABEL: Record<string, string> = {
  head: '头', face: '脸', hair: '发', torso: '躯干', armL: '左臂', armR: '右臂',
  legL: '左腿', legR: '右腿', hat: '帽', cape: '披风', weapon: '武器', acc: '饰物',
}
const slotLabel = (key: string): string => SLOT_LABEL[key] ?? key

/** 素体工坊只编辑身体 6 件 */
function bodySlotsSorted(): SlotDef[] {
  return [...skel.slots].filter((s) => BODY_SLOTS.has(s.key)).sort((a, b) => a.z - b.z)
}

function slotsSorted(): SlotDef[] {
  return [...skel.slots].sort((a, b) => a.z - b.z)
}

function slotBone(slotKey: string): string {
  return skel.slots.find((s) => s.key === slotKey)?.bone ?? '?'
}

// ------------------------------------------------------------ 撤销 / 重做（按操作步记录受影响层）
interface UndoEntry {
  label: string
  before: Record<string, Uint8ClampedArray>
  after: Record<string, Uint8ClampedArray>
}
const undoStack: UndoEntry[] = []
const redoStack: UndoEntry[] = []
const UNDO_MAX = 50
const pending = new Map<string, Uint8ClampedArray>()

const copyOf = (d: StorageDir, slot: string): Uint8ClampedArray => new Uint8ClampedArray(buf(d, slot))

function markDirty(d: StorageDir, slot: string): void {
  const k = `${d}/${slot}`
  if (!pending.has(k)) pending.set(k, copyOf(d, slot))
}

function commit(label: string): void {
  if (pending.size === 0) return
  const before: Record<string, Uint8ClampedArray> = {}
  const after: Record<string, Uint8ClampedArray> = {}
  for (const [k, b] of pending) {
    before[k] = b
    const [d, slot] = k.split('/') as [StorageDir, string]
    after[k] = copyOf(d, slot)
  }
  undoStack.push({ label, before, after })
  if (undoStack.length > UNDO_MAX) undoStack.shift()
  redoStack.length = 0
  pending.clear()
  save()
}

function undo(): void {
  const e = undoStack.pop()
  if (!e) {
    msg('没有可撤销的操作')
    return
  }
  for (const [k, b] of Object.entries(e.before)) {
    const [d, slot] = k.split('/') as [StorageDir, string]
    buf(d, slot).set(b)
  }
  redoStack.push(e)
  msg(`已撤销：${e.label}`)
}

function redo(): void {
  const e = redoStack.pop()
  if (!e) {
    msg('没有可重做的操作')
    return
  }
  for (const [k, b] of Object.entries(e.after)) {
    const [d, slot] = k.split('/') as [StorageDir, string]
    buf(d, slot).set(b)
  }
  undoStack.push(e)
  msg(`已重做：${e.label}`)
}

// ------------------------------------------------------------ 合成渲染（视图变换）

const tmp = document.createElement('canvas')
tmp.width = F
tmp.height = F
const tmpCtx = tmp.getContext('2d') as CanvasRenderingContext2D

function composite(): void {
  const img = tmpCtx.createImageData(F, F)
  const out = img.data
  for (const slot of slotsSorted()) {
    if (hidden.has(slot.key)) continue
    const b = bufs[dir][slot.key]
    if (!b) continue
    blend(out, b, focus ? (slot.key === active ? 255 : 26) : 255)
  }
  const draft = bufs[dir].draft
  if (draft) blend(out, draft, focus ? (active === 'draft' ? 255 : 26) : 128)
  tmpCtx.putImageData(img, 0, 0)

  const { zoom, panX, panY } = view
  ctx.setTransform(zoom, 0, 0, zoom, panX, panY)
  ctx.imageSmoothingEnabled = false
  // 透明棋盘格（可见范围 2 逻辑格）
  const gx0 = Math.max(0, Math.floor(-panX / zoom / 2) * 2)
  const gy0 = Math.max(0, Math.floor(-panY / zoom / 2) * 2)
  const gx1 = Math.min(F, Math.ceil((canvas.width - panX) / zoom / 2) * 2)
  const gy1 = Math.min(F, Math.ceil((canvas.height - panY) / zoom / 2) * 2)
  for (let gy = gy0; gy < gy1; gy += 2) {
    for (let gx = gx0; gx < gx1; gx += 2) {
      ctx.fillStyle = (gx / 2 + gy / 2) % 2 === 0 ? '#23232b' : '#2a2a34'
      ctx.fillRect(gx, gy, 2, 2)
    }
  }
  // 合成层（禁平滑保像素）
  ctx.drawImage(tmp, 0, 0)

  // 网格
  if (zoom >= 5) {
    ctx.lineWidth = 1 / zoom
    for (let g = 0; g <= F; g++) {
      ctx.strokeStyle = g % 8 === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)'
      ctx.beginPath()
      ctx.moveTo(g, 0)
      ctx.lineTo(g, F)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, g)
      ctx.lineTo(F, g)
      ctx.stroke()
    }
  }

  // 画线预览
  if (tool === 'line' && linePreview.length > 0) {
    ctx.fillStyle = color
    for (const c of linePreview) ctx.fillRect(c.x, c.y, 1, 1)
  }

  // 落笔/选区指示框（设备空间绘制，黑白虚线随缩放对齐像素）
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // 悬停落笔格指示：油漆桶 = 直接预览所选颜色的填充；其余工具 = 黑白虚线框标示落点（2px，1px 在 100% 下看不清）
  if (hover && hover.x >= 0 && hover.y >= 0 && hover.x < F && hover.y < F) {
    if (tool === 'bucket') {
      ctx.fillStyle = color
      ctx.fillRect(panX + hover.x * zoom, panY + hover.y * zoom, zoom, zoom)
    } else {
      dashRectDev(panX + hover.x * zoom - 1, panY + hover.y * zoom - 1, zoom + 2, zoom + 2, 1, 2)
    }
  }
  if (sel) {
    dashRectDev(panX + sel.x * zoom + 0.5, panY + sel.y * zoom + 0.5, sel.w * zoom - 1, sel.h * zoom - 1)
  }
  // 移动中的像素浮层
  if (move) {
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(move.patchCanvas, panX + move.x * zoom, panY + move.y * zoom, move.w * zoom, move.h * zoom)
  }
}

/** 黑白相间虚线矩形（marching-ants 风格，深浅背景都可见） */
function dashRectDev(x: number, y: number, w: number, h: number, lw = 1, dash = 4): void {
  ctx.lineWidth = lw
  ctx.setLineDash([dash, dash])
  ctx.strokeStyle = '#ffffff'
  ctx.strokeRect(x, y, w, h)
  ctx.lineDashOffset = dash
  ctx.strokeStyle = '#000000'
  ctx.strokeRect(x, y, w, h)
  ctx.setLineDash([])
  ctx.lineDashOffset = 0
}

function blend(out: Uint8ClampedArray, src: Uint8ClampedArray, alpha: number): void {
  for (let i = 0; i < out.length; i += 4) {
    const sa = (src[i + 3] / 255) * (alpha / 255)
    if (sa === 0) continue
    const da = out[i + 3] / 255
    const oa = sa + da * (1 - sa)
    if (oa === 0) continue
    out[i] = (src[i] * sa + out[i] * da * (1 - sa)) / oa
    out[i + 1] = (src[i + 1] * sa + out[i + 1] * da * (1 - sa)) / oa
    out[i + 2] = (src[i + 2] * sa + out[i + 2] * da * (1 - sa)) / oa
    out[i + 3] = oa * 255
  }
}

// ------------------------------------------------------------ 实时预览（动作播放 + 编辑即显）

const pvCanvas = document.getElementById('pv') as HTMLCanvasElement
const pvCtx = pvCanvas.getContext('2d') as CanvasRenderingContext2D
const PVZ = 2 // 128px 预览 = 64 逻辑 × 2
const pvc = document.createElement('canvas')
pvc.width = F
pvc.height = F
const pvcCtx = pvc.getContext('2d') as CanvasRenderingContext2D
let pvAnim = 'idle'
let pvT = 0
let pvPlaying = true

function renderPreview(): void {
  if (!skel) return
  const a = skel.animations[pvAnim]
  if (!a) return
  const setup = resolveSetup(skel.bones, skel.setups, dir)
  const compiled = compileAnimFor(a, dir)
  const t = resolveSampleTime(pvT, a.duration, a.loop)
  const local = sampleAnim(compiled, t, a.duration, a.loop, setup)
  const world = computeWorld(skel.bones, local, true)
  const setupWorld = computeWorld(skel.bones, setup, false)
  const base = deviceBase(F, PVZ, false)

  pvCtx.setTransform(1, 0, 0, 1, 0, 0)
  pvCtx.clearRect(0, 0, 128, 128)
  pvCtx.imageSmoothingEnabled = false

  const items: { z: number; slotKey: string }[] = []
  for (const slot of slotsSorted()) {
    const b = bufs[dir][slot.key]
    if (!b || !b.some((v, i) => i % 4 === 3 && v > 0)) continue
    items.push({ z: slot.z, slotKey: slot.key })
  }
  items.sort((x, y) => x.z - y.z)
  for (const it of items) {
    const wm = world.get(slotBone(it.slotKey))
    if (!wm) continue
    const pivot = setupWorld.get(slotBone(it.slotKey))
    const m = compose(base, wm)
    pvCtx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
    pvcCtx.putImageData(new ImageData(new Uint8ClampedArray(bufs[dir][it.slotKey] as Uint8ClampedArray), F, F), 0, 0)
    pvCtx.drawImage(pvc, -(pivot?.e ?? 0), -(pivot?.f ?? 0))
  }
}

// ------------------------------------------------------------ 指针（视图/绘制/选区/移动）

function toCell(e: MouseEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect()
  return {
    x: Math.floor((e.clientX - r.left - view.panX) / view.zoom),
    y: Math.floor((e.clientY - r.top - view.panY) / view.zoom),
  }
}

function paint(x: number, y: number): void {
  if (x < 0 || y < 0 || x >= F || y >= F) return
  markDirty(dir, active)
  const b = buf(dir, active)
  const i = (y * F + x) * 4
  if (tool === 'eraser') {
    b[i + 3] = 0
  } else {
    const n = parseInt(color.slice(1), 16)
    b[i] = (n >> 16) & 255
    b[i + 1] = (n >> 8) & 255
    b[i + 2] = n & 255
    b[i + 3] = 255
  }
}

function bresenham(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = []
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let x = x0
  let y = y0
  for (;;) {
    pts.push({ x, y })
    if (x === x1 && y === y1) break
    const e2 = err * 2
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
  return pts
}

canvas.addEventListener('mousedown', (e) => {
  const c = toCell(e)
  // 平移（中键 / 空格+左键）
  if (e.button === 1 || (spaceDown && e.button === 0)) {
    panning = { cx: e.clientX, cy: e.clientY, px: view.panX, py: view.panY }
    canvas.style.cursor = 'grabbing'
    e.preventDefault()
    return
  }
  if (e.button !== 0) return
  if (tool === 'bucket') {
    if (c.x < 0 || c.y < 0 || c.x >= F || c.y >= F) return
    markDirty(dir, active)
    floodFill(c.x, c.y, color)
    commit('油漆桶')
    return
  }
  if (tool === 'line') {
    markDirty(dir, active)
    lineAnchor = c
    linePreview = [c]
    return
  }
  if (tool === 'rect') {
    if (sel && c.x >= sel.x && c.x < sel.x + sel.w && c.y >= sel.y && c.y < sel.y + sel.h) {
      // 抠起选区像素（激活层），开始移动
      markDirty(dir, active)
      const b = buf(dir, active)
      const w = sel.w
      const h = sel.h
      const patch = new Uint8ClampedArray(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const si = ((sel.y + y) * F + (sel.x + x)) * 4
          const di = (y * w + x) * 4
          patch[di] = b[si]
          patch[di + 1] = b[si + 1]
          patch[di + 2] = b[si + 2]
          patch[di + 3] = b[si + 3]
          b[si + 3] = 0
        }
      }
      const pc = document.createElement('canvas')
      pc.width = w
      pc.height = h
      ;(pc.getContext('2d') as CanvasRenderingContext2D).putImageData(new ImageData(patch, w, h), 0, 0)
      move = { patch, patchCanvas: pc, w, h, ox: c.x - sel.x, oy: c.y - sel.y, x: sel.x, y: sel.y }
    } else {
      selStart = c
      sel = { x: c.x, y: c.y, w: 1, h: 1 }
    }
    return
  }
  // 铅笔 / 橡皮
  painting = true
  last = c
  markDirty(dir, active)
  paint(c.x, c.y)
})

canvas.addEventListener('mousemove', (e) => {
  const c = toCell(e)
  hover = c
  ;($('cursorPos') as HTMLElement).textContent = `${c.x}, ${c.y}`
  if (panning) {
    view.panX = Math.round(panning.px + (e.clientX - panning.cx))
    view.panY = Math.round(panning.py + (e.clientY - panning.cy))
    return
  }
  if (tool === 'rect' && move) {
    move.x = Math.min(Math.max(0, c.x - move.ox), F - move.w)
    move.y = Math.min(Math.max(0, c.y - move.oy), F - move.h)
    canvas.style.cursor = 'grabbing'
    return
  }
  if (tool === 'rect' && selStart) {
    // 拖拽生长选区
    sel = {
      x: Math.min(selStart.x, c.x),
      y: Math.min(selStart.y, c.y),
      w: Math.abs(c.x - selStart.x) + 1,
      h: Math.abs(c.y - selStart.y) + 1,
    }
    canvas.style.cursor = 'crosshair'
    return
  }
  if (tool === 'rect' && sel) {
    const inside = c.x >= sel.x && c.x < sel.x + sel.w && c.y >= sel.y && c.y < sel.y + sel.h
    canvas.style.cursor = inside ? 'grab' : 'crosshair'
  } else if (tool === 'line' && lineAnchor) {
    linePreview = bresenham(lineAnchor.x, lineAnchor.y, c.x, c.y)
    canvas.style.cursor = 'crosshair'
  } else {
    canvas.style.cursor = 'crosshair'
  }
  if (!painting || !last) return
  const steps = Math.max(Math.abs(c.x - last.x), Math.abs(c.y - last.y))
  for (let s = 1; s <= steps; s++) {
    paint(Math.round(last.x + ((c.x - last.x) * s) / steps), Math.round(last.y + ((c.y - last.y) * s) / steps))
  }
  last = c
})

canvas.addEventListener('mouseup', (e) => {
  if (panning) {
    panning = null
    canvas.style.cursor = 'crosshair'
    return
  }
  if (tool === 'line' && lineAnchor) {
    const c = toCell(e)
    markDirty(dir, active)
    const pts = bresenham(lineAnchor.x, lineAnchor.y, c.x, c.y)
    for (const p of pts) paint(p.x, p.y)
    lineAnchor = null
    linePreview = []
    commit('画线')
    return
  }
  if (tool === 'rect') {
    if (move) {
      const b = buf(dir, active)
      for (let y = 0; y < move.h; y++) {
        for (let x = 0; x < move.w; x++) {
          const si = (y * move.w + x) * 4
          const di = ((move.y + y) * F + (move.x + x)) * 4
          b[di] = move.patch[si]
          b[di + 1] = move.patch[si + 1]
          b[di + 2] = move.patch[si + 2]
          b[di + 3] = move.patch[si + 3]
        }
      }
      sel = { x: move.x, y: move.y, w: move.w, h: move.h }
      move = null
      commit('移动选区')
    }
    selStart = null
    return
  }
  if (tool === 'eraser') commit('橡皮')
  else if (tool === 'pencil') commit('铅笔')
  painting = false
  last = toCell(e)
})

/** 缩放基准：100% = 画布图像撑满显示区（canvas 边长 ÷ 逻辑边长） */
const BASE_ZOOM = canvas.width / F
/** 相对档位（%）：100% = 撑满视口 */
const PCT_STEPS = [100, 150, 200, 300, 400]

const pctOf = (zoom: number): number => (zoom / BASE_ZOOM) * 100

function syncZoomUI(): void {
  const pct = pctOf(view.zoom)
  const text = `${pct % 1 === 0 ? pct : pct.toFixed(1)}%`
  ;($('zoomInfo') as HTMLElement).textContent = text
  ;($('zoomPct') as HTMLElement).textContent = text
}

function stepZoomDevice(dirIn: boolean): number {
  const cur = pctOf(view.zoom)
  const nz = dirIn
    ? (PCT_STEPS.find((p) => p > cur + 0.01) ?? cur)
    : ([...PCT_STEPS].reverse().find((p) => p < cur - 0.01) ?? cur)
  return (nz / 100) * BASE_ZOOM
}

function setZoom(nz: number, cx: number, cy: number): void {
  const old = view.zoom
  if (nz === old) return
  view.panX = Math.round(cx - ((cx - view.panX) / old) * nz)
  view.panY = Math.round(cy - ((cy - view.panY) / old) * nz)
  view.zoom = nz
  syncZoomUI()
}

function zoomStep(dirIn: boolean): void {
  const nz = stepZoomDevice(dirIn)
  if (nz === view.zoom) {
    msg(dirIn ? '已到最大 400%' : '已是最小 100%')
    return
  }
  setZoom(nz, canvas.width / 2, canvas.height / 2)
}

function zoomFit(): void {
  view.zoom = BASE_ZOOM
  view.panX = Math.round((canvas.width - F * view.zoom) / 2)
  view.panY = Math.round((canvas.height - F * view.zoom) / 2)
  syncZoomUI()
}

canvas.addEventListener('mouseleave', () => {
  hover = null
})

canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  const r = canvas.getBoundingClientRect()
  const cx = e.clientX - r.left
  const cy = e.clientY - r.top
  setZoom(stepZoomDevice(e.deltaY < 0), cx, cy)
}, { passive: false })

// ------------------------------------------------------------ 油漆桶 / 吸色

function hexToRgba(hex: string): [number, number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
}

function floodFill(x: number, y: number, hex: string): void {
  const b = buf(dir, active)
  const i0 = (y * F + x) * 4
  const t = [b[i0], b[i0 + 1], b[i0 + 2], b[i0 + 3]]
  const c = hexToRgba(hex)
  if (t[0] === c[0] && t[1] === c[1] && t[2] === c[2] && t[3] === c[3]) return
  const stack: [number, number][] = [[x, y]]
  while (stack.length > 0) {
    const [cx, cy] = stack.pop() as [number, number]
    if (cx < 0 || cy < 0 || cx >= F || cy >= F) continue
    const i = (cy * F + cx) * 4
    if (b[i] !== t[0] || b[i + 1] !== t[1] || b[i + 2] !== t[2] || b[i + 3] !== t[3]) continue
    b[i] = c[0]
    b[i + 1] = c[1]
    b[i + 2] = c[2]
    b[i + 3] = c[3]
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1])
  }
}

// ------------------------------------------------------------ 切割

function cut(): void {
  const srcKey = ($('srcSel') as HTMLSelectElement).value
  const dstKey = ($('dstSel') as HTMLSelectElement).value
  if (!sel) {
    msg('先用 ▦ 选区框住像素')
    return
  }
  if (srcKey === dstKey) return
  markDirty(dir, srcKey)
  markDirty(dir, dstKey)
  const src = buf(dir, srcKey)
  const dst = buf(dir, dstKey)
  for (let y = sel.y; y < sel.y + sel.h; y++) {
    for (let x = sel.x; x < sel.x + sel.w; x++) {
      const i = (y * F + x) * 4
      dst[i] = src[i]
      dst[i + 1] = src[i + 1]
      dst[i + 2] = src[i + 2]
      dst[i + 3] = src[i + 3]
      src[i + 3] = 0
    }
  }
  sel = null
  renderLayers()
  commit('切割')
}

// ------------------------------------------------------------ 导入 / 载入素体

/** 素体编辑只涉及身体部件；脸/发/衣是独立可更换件，不进素体编辑视图 */
const BODY_SLOTS = new Set(['head', 'torso', 'armL', 'armR', 'legL', 'legR'])

/** 载入当前素体：一次载全三方向，身体部件直接进对应槽位层（就地可改） */
async function loadBaseParts(): Promise<void> {
  const off = document.createElement('canvas')
  off.width = F
  off.height = F
  const octx = off.getContext('2d') as CanvasRenderingContext2D
  let n = 0
  for (const d of DIRS) {
    for (const key of skel.defaultEquip ?? []) {
      const part = skel.parts[key]
      const spec = part?.images[d]
      if (!part || !spec) continue
      if (!BODY_SLOTS.has(part.slot)) continue // 脸/发/衣是独立可更换件，不进素体
      const img = await loadImage(joinUrl('/', spec.src))
      octx.clearRect(0, 0, F, F)
      octx.drawImage(img, 0, 0)
      const src = octx.getImageData(0, 0, F, F).data
      markDirty(d, part.slot)
      buf(d, part.slot).set(src)
      n++
    }
  }
  active = 'torso'
  renderLayers()
  commit('载入当前素体')
  msg('素体已载入（仅身体部件；脸/发/衣为独立可更换件）')
}

// ------------------------------------------------------------ 自动存取（localStorage，刷新不丢）

const LS_KEY = 'sucai-bufs-v1'
let saveTimer = 0

function save(): void {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const out: Record<string, Record<string, string>> = {}
    for (const d of DIRS) {
      out[d] = {}
      for (const [slot, b] of Object.entries(bufs[d] ?? {})) {
        if (!b || !b.some((v, i) => i % 4 === 3 && v > 0)) continue
        const off = document.createElement('canvas')
        off.width = F
        off.height = F
        const octx = off.getContext('2d') as CanvasRenderingContext2D
        octx.putImageData(new ImageData(new Uint8ClampedArray(b), F, F), 0, 0)
        out[d][slot] = off.toDataURL('image/png')
      }
    }
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ name: ($('packName') as HTMLInputElement).value, dirs: out }))
    } catch { /* 容量满则忽略 */ }
  }, 400)
}

async function restore(): Promise<void> {
  const raw = localStorage.getItem(LS_KEY)
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as { name?: string; dirs: Record<string, Record<string, string>> }
    if (parsed.name) ($('packName') as HTMLInputElement).value = parsed.name
    for (const d of DIRS) {
      for (const [slot, dataUrl] of Object.entries(parsed.dirs[d] ?? {})) {
        const img = await loadImage(dataUrl)
        const off = document.createElement('canvas')
        off.width = F
        off.height = F
        const octx = off.getContext('2d') as CanvasRenderingContext2D
        octx.drawImage(img, 0, 0)
        buf(d, slot).set(octx.getImageData(0, 0, F, F).data)
      }
    }
    msg('已恢复上次工作区（localStorage）')
  } catch { /* 损坏则忽略 */ }
}

// ------------------------------------------------------------ 导出

/** 收集当前各方向/槽位缓冲，构建部件包（旧导出与 Spine 导出共用）。 */
function buildBundle(name: string): {
  kind: 'bone-doll-part-pack'
  name: string
  files: Record<string, string>
  skeletonPatch: { parts: Record<string, { slot: string; name: string; images: Record<string, { src: string }> }> }
  defaultEquipAdd: string[]
} {
  const files: Record<string, string> = {}
  const parts: Record<string, { slot: string; name: string; images: Record<string, { src: string }> }> = {}
  const equipAdd: string[] = []
  for (const d of DIRS) {
    for (const slot of slotsSorted()) {
      const b = bufs[d][slot.key]
      if (!b || !b.some((v, i) => i % 4 === 3 && v > 0)) continue
      const off = document.createElement('canvas')
      off.width = F
      off.height = F
      ;(off.getContext('2d') as CanvasRenderingContext2D).putImageData(new ImageData(new Uint8ClampedArray(b), F, F), 0, 0)
      const path = `parts/${slot.key}/${name}/${d}.png`
      files[path] = off.toDataURL('image/png')
    }
  }
  for (const slot of slotsSorted()) {
    const key = `${slot.key}/${name}`
    const images: Record<string, { src: string }> = {}
    for (const d of DIRS) {
      if (files[`parts/${slot.key}/${name}/${d}.png`]) images[d] = { src: `parts/${slot.key}/${name}/${d}.png` }
    }
    if (Object.keys(images).length === 0) continue
    parts[key] = { slot: slot.key, name: `${name} · ${slot.key}`, images }
    equipAdd.push(key)
  }
  return { kind: 'bone-doll-part-pack', name, files, skeletonPatch: { parts }, defaultEquipAdd: equipAdd }
}

function downloadBundle(bundle: unknown, filename: string, msgText: string): void {
  ;(window as unknown as Record<string, unknown>).__lastExport = bundle
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
  msg(msgText)
}

function exportPack(): void {
  const name = ($('packName') as HTMLInputElement).value.trim() || 'base'
  const bundle = buildBundle(name)
  downloadBundle(bundle, `bone-doll-pack-${name}.json`, `已导出 ${Object.keys(bundle.files).length} 张部件图（含 skeleton 补丁），运行 import-pack.mjs 落盘`)
}

/** Spine 部件包 = 同一份部件图 + 每变体一份独立 atlas 文本（region 名 `{slot}.{name}@{dir}`，与生成器聚合命名一致）。 */
function exportSpinePack(): void {
  const name = ($('packName') as HTMLInputElement).value.trim() || 'base'
  const bundle = buildBundle(name)
  const spineAtlas: Record<string, string> = {}
  for (const [key, def] of Object.entries(bundle.skeletonPatch.parts)) {
    const slash = key.indexOf('/')
    const slot = key.slice(0, slash)
    const variant = key.slice(slash + 1)
    let text = ''
    for (const d of DIRS) {
      const img = def.images[d]
      if (!img) continue
      // 每方向一张页图（整幅 64×64 画布，无 trim）；页名 = 包内相对路径
      text += `\n${img.src}\nsize:${F},${F}\nfilter:Nearest,Nearest\npma:false\n${slot}.${variant}@${d}\n  bounds: 0, 0, ${F}, ${F}\n`
    }
    if (text) spineAtlas[key] = text
  }
  const out = { ...bundle, spineAtlas }
  downloadBundle(out, `bone-doll-spine-pack-${name}.json`, `已导出 Spine 部件包（${Object.keys(spineAtlas).length} 变体 atlas）；import-pack.mjs 落盘后重跑 gen-spine-skeleton 聚合`)
}

// ------------------------------------------------------------ 调色盘（锁定色 + 自定义）

let commonColors: string[] = []
let customColors: string[] = []
try {
  customColors = JSON.parse(localStorage.getItem('sucai-custom-colors') ?? '[]') as string[]
} catch {
  customColors = []
}

function markSwatch(): void {
  for (const el of document.querySelectorAll('.sw')) {
    el.classList.toggle('on', (el as HTMLElement).dataset.c === color)
  }
}

function renderSwatches(): void {
  const root = $('swatches')
  root.innerHTML = ''
  for (const c of commonColors) {
    const d = document.createElement('div')
    d.className = 'sw' + (c === color ? ' on' : '')
    d.dataset.c = c
    d.style.background = c
    d.title = c
    d.onclick = () => {
      color = c
      ;($('color') as HTMLInputElement).value = c
      markSwatch()
    }
    root.appendChild(d)
  }
  const croot = $('customSwatches')
  croot.innerHTML = ''
  for (const c of customColors) {
    const d = document.createElement('div')
    d.className = 'sw' + (c === color ? ' on' : '')
    d.dataset.c = c
    d.style.background = c
    d.title = `${c}（右键删除）`
    d.onclick = () => {
      color = c
      ;($('color') as HTMLInputElement).value = c
      markSwatch()
    }
    d.oncontextmenu = (e) => {
      e.preventDefault()
      customColors = customColors.filter((x) => x !== c)
      localStorage.setItem('sucai-custom-colors', JSON.stringify(customColors))
      renderSwatches()
    }
    croot.appendChild(d)
  }
  if (customColors.length === 0) {
    const tip = document.createElement('span')
    tip.className = 'hint'
    tip.textContent = '（空，＋ 收当前色）'
    croot.appendChild(tip)
  }
}

async function loadPalette(): Promise<void> {
  try {
    const res = await fetch('/palette.json')
    const p = (await res.json()) as { colors: Record<string, string> }
    commonColors = Object.values(p.colors)
  } catch {
    commonColors = []
  }
  renderSwatches()
}

// ------------------------------------------------------------ UI

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

function msg(s: string): void {
  $('msg').textContent = s
}

function renderLayers(): void {
  ;($('activeInfo') as HTMLElement).textContent = `${slotLabel(active)} (${active}) · 骨骼 ${slotBone(active)}`
  const root = $('layers')
  root.innerHTML = ''
  const rows: { key: string; label: string; meta: string }[] = []
  for (const s of bodySlotsSorted()) {
    rows.push({ key: s.key, label: `${slotLabel(s.key)} (${s.key})`, meta: `z=${s.z} · 骨骼=${s.bone}` })
  }
  for (const r of rows) {
    const div = document.createElement('div')
    div.className = 'layer' + (r.key === active ? ' on' : '')
    const eye = document.createElement('button')
    eye.textContent = hidden.has(r.key) ? '×' : '◉'
    eye.onclick = (e) => {
      e.stopPropagation()
      if (hidden.has(r.key)) hidden.delete(r.key)
      else hidden.add(r.key)
    }
    const label = document.createElement('span')
    label.textContent = r.label
    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = r.meta
    div.append(eye, label, meta)
    div.onclick = () => {
      active = r.key
      renderLayers()
    }
    root.appendChild(div)
  }
}

function fillSelect(sel: HTMLSelectElement, keys: string[], value: string): void {
  sel.innerHTML = ''
  for (const k of keys) {
    const o = document.createElement('option')
    o.value = k
    o.textContent = k
    sel.appendChild(o)
  }
  sel.value = value
}

async function boot(): Promise<void> {
  const res = await fetch('/skeleton.json')
  skel = (await res.json()) as SkeletonAsset

  for (const d of DIRS) {
    const b = document.createElement('button')
    b.textContent = d
    b.classList.toggle('on', d === dir)
    b.onclick = () => {
      dir = d
      ;($('dirInfo') as HTMLElement).textContent = d
      for (const el of $('dirs').querySelectorAll('button')) el.classList.remove('on')
      b.classList.add('on')
    }
    $('dirs').appendChild(b)
  }

  const toolBtn = (id: string, t: typeof tool): void => {
    $(id).onclick = () => {
      tool = t
      // 选区框只在选区工具下有意义；切到铅笔/橡皮/油漆/画线时清除，避免残留在画面上
      if (t !== 'rect') {
        sel = null
        selStart = null
      }
      for (const id2 of ['toolPencil', 'toolEraser', 'toolBucket', 'toolLine', 'toolRect']) {
        $(id2).classList.toggle('on', id2 === id)
      }
    }
  }
  toolBtn('toolPencil', 'pencil')
  toolBtn('toolEraser', 'eraser')
  toolBtn('toolBucket', 'bucket')
  toolBtn('toolLine', 'line')
  toolBtn('toolRect', 'rect')

  ;($('color') as HTMLInputElement).oninput = (e) => {
    color = (e.target as HTMLInputElement).value
    markSwatch()
  }
  $('focusBtn').onclick = () => {
    focus = !focus
    $('focusBtn').classList.toggle('on', focus)
    msg(focus ? '聚焦模式：激活层不透明，其余近乎透明' : '合成预览：全部不透明')
  }
  $('loadBase').onclick = () => void loadBaseParts()
  $('clearActive').onclick = () => {
    markDirty(dir, active)
    bufs[dir][active] = new Uint8ClampedArray(F * F * 4)
    commit(`清空 ${active}`)
    msg(`已清空激活层 ${active}`)
  }

  const bodyKeys = bodySlotsSorted().map((s) => s.key)
  fillSelect($('srcSel') as HTMLSelectElement, bodyKeys, 'torso')
  fillSelect($('dstSel') as HTMLSelectElement, bodyKeys, 'head')
  $('cutBtn').onclick = () => {
    cut()
    msg(`已切割到 ${($('dstSel') as HTMLSelectElement).value}（骨骼 ${slotBone(($('dstSel') as HTMLSelectElement).value)}）`)
  }

  $('exportBtn').onclick = exportPack
  $('exportSpineBtn').onclick = exportSpinePack
  $('zoomOut').onclick = () => zoomStep(false)
  $('zoomIn').onclick = () => zoomStep(true)
  $('zoomFit').onclick = () => zoomFit()
  $('undoBtn').onclick = () => undo()
  $('redoBtn').onclick = () => redo()
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !(e.ctrlKey || e.metaKey) && (e.target as HTMLElement)?.tagName !== 'INPUT') {
      e.preventDefault()
      spaceDown = true
      return
    }
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault()
      undo()
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault()
      redo()
    }
  })
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceDown = false
  })

  const pvAnimsRoot = $('pvAnims')
  for (const key of Object.keys(skel.animations)) {
    const b = document.createElement('button')
    b.textContent = key
    b.classList.toggle('on', key === pvAnim)
    b.onclick = () => {
      pvAnim = key
      pvT = 0
      for (const el of pvAnimsRoot.querySelectorAll('button')) el.classList.remove('on')
      b.classList.add('on')
    }
    pvAnimsRoot.appendChild(b)
  }
  $('pvPlay').onclick = () => {
    pvPlaying = !pvPlaying
    $('pvPlay').textContent = pvPlaying ? '⏸ 暂停' : '▶ 播放'
  }

  renderLayers()
  void loadPalette()
  void restore()

  let lastT = performance.now()
  const loop = (t: number): void => {
    const dt = t - lastT
    lastT = t
    const a = skel.animations[pvAnim]
    if (pvPlaying && a) pvT += dt / 1000
    composite()
    renderPreview()
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

void boot()
