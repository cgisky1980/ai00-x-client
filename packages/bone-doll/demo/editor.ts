/**
 * bone-doll 关键帧编辑器（最小版）。
 *
 * 交互：拖拽骨骼 = 旋转该骨（自动在当前时间打帧，帧内记录全骨骼姿态）；
 * Shift+拖拽 = 平移；点击轴上圆点切换选中骨骼；数字输入框微调 x/y/r。
 * 导出 = 序列化整个 skeleton.json（只改了 animations，其余原样保留）。
 * 红线自查：本编辑器只产关键帧数据，不做 IK/网格/权重/自动绑骨。
 */
import {
  compileAnim,
  compose,
  computeWorld,
  deviceBase,
  resolveSampleTime,
  resolveSetup,
  sampleAnim,
  slotDrawZ,
  type FullPose,
  type Mat2D,
} from '../src/math'
import { joinUrl, loadImage } from '../src/loader'
import type { AnimDef, Keyframe, SkeletonAsset, StorageDir } from '../src/types'

const canvas = document.getElementById('stage') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
const SCALE = 6 // 64×64 → 384

let skel: SkeletonAsset
const images = new Map<string, HTMLImageElement>()
let animKey = 'idle'
let dir: StorageDir = 'down'
let time = 0
let playing = true
let selectedBone = 'body'

// ------------------------------------------------------------ 数据访问

function anim(): AnimDef {
  return skel.animations[animKey]
}

function setup(): Map<string, FullPose> {
  return resolveSetup(skel.bones, skel.setups, dir)
}

function setupWorld(): Map<string, Mat2D> {
  return computeWorld(skel.bones, setup(), false)
}

function currentPose(): Map<string, FullPose> {
  const a = anim()
  const compiled = compileAnim(a.tracks[dir])
  const t = resolveSampleTime(time, a.duration, a.loop)
  return sampleAnim(compiled, t, a.duration, a.loop, setup())
}

function currentWorld(): Map<string, Mat2D> {
  return computeWorld(skel.bones, currentPose(), true)
}

function ensureKey(t: number): Keyframe {
  const a = anim()
  const list = (a.tracks[dir] ??= [])
  const hit = list.find((k) => Math.abs(k.t - t) < 1e-4)
  if (hit) return hit
  const pose = currentPose()
  const bones: Keyframe['bones'] = {}
  for (const [bk, p] of pose) bones[bk] = { x: p.x, y: p.y, r: p.r }
  const k: Keyframe = { t, bones }
  list.push(k)
  list.sort((x, y) => x.t - y.t)
  return k
}

// ------------------------------------------------------------ 渲染

function drawDoll(): void {
  const F = skel.frame
  const world = currentWorld()
  const sw = setupWorld()
  const base = deviceBase(F, SCALE, false)

  ctx.setTransform(base.a, base.b, base.c, base.d, base.e, base.f)
  ctx.clearRect(0, 0, F, F)
  ctx.imageSmoothingEnabled = false

  const items: { z: number; src: string; bone: string }[] = []
  for (const key of skel.defaultEquip ?? []) {
    const part = skel.parts[key]
    const slot = skel.slots.find((s) => s.key === part?.slot)
    const img = part?.images[dir]
    if (!part || !slot || !img) continue
    items.push({ z: slotDrawZ(slot, dir), src: img.src, bone: slot.bone })
  }
  items.sort((x, y) => x.z - y.z)
  for (const it of items) {
    const wm = world.get(it.bone)
    const img = images.get(it.src)
    if (!wm || !img) continue
    const m = compose(base, wm)
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
    const pivot = sw.get(it.bone)
    ctx.drawImage(img, -(pivot?.e ?? 0), -(pivot?.f ?? 0))
  }

  // 骨骼叠加层：枢轴点 + 骨干连线
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  for (const b of skel.bones) {
    const wm = world.get(b.key)
    if (!wm) continue
    const px = wm.e * SCALE
    const py = wm.f * SCALE
    const parentMat = b.parent ? world.get(b.parent) : null
    if (parentMat) {
      ctx.strokeStyle = 'rgba(106,143,176,0.55)'
      ctx.beginPath()
      ctx.moveTo(parentMat.e * SCALE, parentMat.f * SCALE)
      ctx.lineTo(px, py)
      ctx.stroke()
    }
    ctx.fillStyle = b.key === selectedBone ? '#e8a33d' : 'rgba(232,163,61,0.55)'
    ctx.beginPath()
    ctx.arc(px, py, b.key === selectedBone ? 6 : 3.5, 0, Math.PI * 2)
    ctx.fill()
    if (b.key === selectedBone) {
      ctx.fillStyle = '#f2d3b3'
      ctx.font = '12px Consolas'
      ctx.fillText(b.key, px + 8, py - 8)
    }
  }
}

// ------------------------------------------------------------ 拖拽（自动打帧）

let dragMode: 'rotate' | 'move' | null = null
let dragStart = { x: 0, y: 0 }
let dragStartPose: FullPose = { x: 0, y: 0, r: 0 }
let dragParentRotRad = 0
/** 旋转枢轴 = 被选骨骼自身原点的屏幕位置（旋转不改自身平移，枢轴不动） */
let dragPivot = { x: 0, y: 0 }

function hitBone(mx: number, my: number): string | null {
  const world = currentWorld()
  let best: string | null = null
  let bestD = 16 * 16
  for (const b of skel.bones) {
    const wm = world.get(b.key)
    if (!wm) continue
    const dx = wm.e * SCALE - mx
    const dy = wm.f * SCALE - my
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = b.key
    }
  }
  return best
}

canvas.addEventListener('pointerdown', (ev) => {
  const rect = canvas.getBoundingClientRect()
  const mx = ev.clientX - rect.left
  const my = ev.clientY - rect.top
  const hit = hitBone(mx, my)
  if (!hit) return
  selectedBone = hit
  syncBoneInputs()
  const world = currentWorld()
  const wm = world.get(hit) as Mat2D
  const bDef = skel.bones.find((b) => b.key === hit)
  const parentMat = bDef?.parent ? world.get(bDef.parent) : null
  dragMode = ev.shiftKey ? 'move' : 'rotate'
  dragStart = { x: mx, y: my }
  dragStartPose = { ...(currentPose().get(hit) as FullPose) }
  dragParentRotRad = parentMat ? Math.atan2(parentMat.b, parentMat.a) : 0
  dragPivot = { x: wm.e * SCALE, y: wm.f * SCALE }
  canvas.setPointerCapture(ev.pointerId)
})

canvas.addEventListener('pointermove', (ev) => {
  if (!dragMode) return
  const rect = canvas.getBoundingClientRect()
  const mx = ev.clientX - rect.left
  const my = ev.clientY - rect.top
  const key = ensureKey(time)
  key.bones[selectedBone] ??= { ...dragStartPose }
  const pose = key.bones[selectedBone] as { x: number; y: number; r: number }

  if (dragMode === 'rotate') {
    // 鼠标相对骨骼自身枢轴的角度（0 = 向下，顺时针为正）− 父链世界旋转 = 局部 r
    const worldDeg = (Math.atan2(mx - dragPivot.x, -(my - dragPivot.y)) * 180) / Math.PI
    const parentDeg = (dragParentRotRad * 180) / Math.PI
    pose.r = Math.round(worldDeg - parentDeg)
  } else {
    // 平移：世界位移逆旋转回父骨局部系
    const dwx = (mx - dragStart.x) / SCALE
    const dwy = (my - dragStart.y) / SCALE
    const cos = Math.cos(-dragParentRotRad)
    const sin = Math.sin(-dragParentRotRad)
    pose.x = Math.round(dragStartPose.x + cos * dwx - sin * dwy)
    pose.y = Math.round(dragStartPose.y + sin * dwx + cos * dwy)
  }
  syncBoneInputs()
})

canvas.addEventListener('pointerup', () => {
  if (dragMode) refreshKeyChips() // 拖拽期间可能自动新建了关键帧，刷新 chips
  dragMode = null
})

// ------------------------------------------------------------ UI

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

function msg(s: string): void {
  $('msg').textContent = s
}

function refreshAnimList(): void {
  const sel = $('animSel') as HTMLSelectElement
  sel.innerHTML = ''
  for (const key of Object.keys(skel.animations)) {
    const o = document.createElement('option')
    o.value = key
    o.textContent = key
    sel.appendChild(o)
  }
  sel.value = animKey
}

function refreshKeyChips(): void {
  const root = $('keys')
  root.innerHTML = ''
  const keys = anim().tracks[dir] ?? []
  for (const k of [...keys].sort((a, b) => a.t - b.t)) {
    const b = document.createElement('button')
    b.textContent = k.t.toFixed(2)
    b.classList.toggle('on', Math.abs(k.t - time) < 1e-4)
    b.onclick = () => {
      time = k.t
      playing = false
      syncTime()
    }
    const del = document.createElement('button')
    del.textContent = '×'
    del.classList.add('danger')
    del.onclick = () => {
      const list = anim().tracks[dir] ?? []
      anim().tracks[dir] = list.filter((x) => x !== k)
      time = 0
      syncTime()
      refreshKeyChips()
    }
    root.appendChild(b)
    root.appendChild(del)
  }
}

function syncTime(): void {
  const scrub = $('scrub') as HTMLInputElement
  scrub.max = String(anim().duration)
  scrub.value = String(Math.min(time, anim().duration))
  $('timeVal').textContent = `${resolveSampleTime(time, anim().duration, anim().loop).toFixed(2)}s`
  refreshKeyChips()
}

function syncBoneInputs(): void {
  const pose = currentPose().get(selectedBone) ?? { x: 0, y: 0, r: 0 }
  ;($('bx') as HTMLInputElement).value = String(Math.round(pose.x))
  ;($('by') as HTMLInputElement).value = String(Math.round(pose.y))
  ;($('br') as HTMLInputElement).value = String(Math.round(pose.r))
  const sel = $('boneSel') as HTMLSelectElement
  sel.value = selectedBone
}

function boot_ui(): void {
  refreshAnimList()

  const dirsRoot = $('dirs')
  for (const d of ['down', 'up', 'left', 'right'] as StorageDir[]) {
    const b = document.createElement('button')
    b.textContent = d
    b.classList.toggle('on', d === dir)
    b.onclick = () => {
      dir = d
      time = 0
      for (const el of dirsRoot.querySelectorAll('button')) el.classList.remove('on')
      b.classList.add('on')
      syncTime()
    }
    dirsRoot.appendChild(b)
  }

  const boneSel = $('boneSel') as HTMLSelectElement
  for (const b of skel.bones) {
    const o = document.createElement('option')
    o.value = b.key
    o.textContent = b.key
    boneSel.appendChild(o)
  }
  boneSel.onchange = () => {
    selectedBone = boneSel.value
  }

  ;($('animSel') as HTMLSelectElement).onchange = (ev) => {
    animKey = (ev.target as HTMLSelectElement).value
    time = 0
    syncTime()
  }
  $('newAnim').onclick = () => {
    const name = window.prompt('新动画键名（如 jump）：')
    if (!name || skel.animations[name]) return
    skel.animations[name] = { duration: 1, loop: true, tracks: { [dir]: [{ t: 0, bones: {} }] } }
    animKey = name
    time = 0
    refreshAnimList()
    syncTime()
  }
  $('duration').onchange = (ev) => {
    const v = Number((ev.target as HTMLInputElement).value)
    if (v > 0) anim().duration = v
    syncTime()
  }
  $('playBtn').onclick = () => {
    playing = !playing
    $('playBtn').textContent = playing ? '⏸' : '▶'
  }
  $('scrub').oninput = (ev) => {
    time = Number((ev.target as HTMLInputElement).value)
    playing = false
    $('playBtn').textContent = '▶'
    syncTime()
  }
  $('addKey').onclick = () => {
    ensureKey(time)
    refreshKeyChips()
    msg(`已打帧 @ ${time.toFixed(2)}s`)
  }
  for (const [id, field] of [
    ['bx', 'x'],
    ['by', 'y'],
    ['br', 'r'],
  ] as const) {
    $(id).onchange = (ev) => {
      const v = Number((ev.target as HTMLInputElement).value)
      if (Number.isNaN(v)) return
      const key = ensureKey(time)
      key.bones[selectedBone] ??= {}
      key.bones[selectedBone]![field] = v
    }
  }
  $('exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(skel, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'skeleton.json'
    a.click()
    URL.revokeObjectURL(a.href)
    msg('已下载 skeleton.json（覆盖 assets/skeleton.json 后生效）')
  }
  $('copyBtn').onclick = async () => {
    await navigator.clipboard.writeText(JSON.stringify(skel, null, 2))
    msg('JSON 已复制到剪贴板')
  }
}

// ------------------------------------------------------------ 启动与主循环

async function boot(): Promise<void> {
  const res = await fetch('/skeleton.json')
  skel = (await res.json()) as SkeletonAsset

  const srcs = new Set<string>()
  for (const part of Object.values(skel.parts)) {
    for (const img of Object.values(part.images)) {
      if (img) srcs.add(img.src)
    }
  }
  await Promise.all(
    [...srcs].map(async (s) => {
      images.set(s, await loadImage(joinUrl('/', s)))
    }),
  )

  boot_ui()
  syncTime()
  syncBoneInputs()

  let lastT = performance.now()
  let lastSync = 0
  const loop = (t: number): void => {
    const dt = t - lastT
    lastT = t
    const a = anim()
    if (playing) {
      time += dt / 1000
      if (a.loop) {
        time = time % a.duration
      } else if (time > a.duration) {
        time = a.duration
        playing = false
        $('playBtn').textContent = '▶'
      }
      $('timeVal').textContent = `${time.toFixed(2)}s`
      if (t - lastSync > 150) {
        lastSync = t
        syncBoneInputs()
      }
    }
    drawDoll()
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

void boot()
