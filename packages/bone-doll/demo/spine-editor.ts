/**
 * Spine 动作编辑器：骨骼级 4 通道（rotate/translate/scale/shear）+ 贝塞尔曲线 + slot 显隐轨。
 * 数据层 = AnimationEditor 直接读写 Spine JSON 动画对象（移植自 pet-custom-system，纯 TS + spine-core）。
 * 本 demo 承担 pet-custom SpineManager 的宿主职责（大幅精简）：
 * - 编辑态不用全量重建：editor.toSpineJSON() → SkeletonJson.readAnimation() 直接注册进现有
 *   skeletonData（官方插值 apply，编辑所见 = 导出所得），同名先删避免重复。
 * - 播放态 = AnimationState 驱动原动画；方向 = skin 切换（down/up/left/right 四方向独立）。
 * - 保存动作 = 写回内存 dollJson.animations；导出 = 下载完整 doll.json（blob）。
 */
import {
  AnimationState,
  AnimationStateData,
  AtlasAttachmentLoader,
  CanvasTexture,
  MixFrom,
  Physics,
  Skeleton,
  SkeletonJson,
  SkeletonRenderer,
  TextureAtlas,
} from '@esotericsoftware/spine-canvas'
import { AnimationEditor, BoneChannel } from '../src/spine-editor/AnimationEditor'
import { TimelineView, type TimelineEvent } from '../src/spine-editor/TimelineView'
import { GraphEditor, type GraphEvent } from '../src/spine-editor/GraphEditor'
import { BoneGizmo, type GizmoDragEndInfo } from '../src/spine-editor/BoneGizmo'
import {
  AddKeyframeCommand,
  AddSlotKeyframeCommand,
  MacroCommand,
  MoveKeyframeCommand,
  MoveSlotKeyframeCommand,
  RemoveKeyframeCommand,
  RemoveSlotKeyframeCommand,
  SetDurationCommand,
  UndoManager,
  UpdateBezierCommand,
  UpdateKeyframeValueCommand,
} from '../src/spine-editor/UndoManager'

const DIRS = ['down', 'up', 'left', 'right'] as const
const CHANNELS: BoneChannel[] = ['rotate', 'translate', 'scale', 'shear']
const FRAME_STEP = 1 / 30

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const status = $('status')
const stage = $('stage') as HTMLCanvasElement
const stageCtx = stage.getContext('2d') as CanvasRenderingContext2D
const gizmoCv = $('gizmoCv') as HTMLCanvasElement

// ---- 资产与运行时 ----
let dollJson: any
let skeletonData: import('@esotericsoftware/spine-core').SkeletonData
let skeleton: Skeleton
let attachmentLoader: AtlasAttachmentLoader
let state: AnimationState
const renderer = new SkeletonRenderer(stageCtx)
renderer.triangleRendering = true

// ---- 编辑状态 ----
const animEditor = new AnimationEditor()
const undo = new UndoManager()
let editName: string | null = null // 编辑中的动画全名（如 idle_down），null = 播放模式
let playAnim = 'idle_down' // 播放模式的当前动画
let cachedEditAnim: import('@esotericsoftware/spine-core').Animation | null = null
let playhead = 0
let playing = true
let dir: (typeof DIRS)[number] = 'down'
let zoom = 4
let selectedBone: string | null = null
let selectedChannel: BoneChannel | 'slot' | null = null
let selectedKfIndex = -1

let timeline: TimelineView | null = null
let graph: GraphEditor | null = null
let gizmo: BoneGizmo | null = null

const skeletonProvider = { getSkeleton: (): Skeleton => skeleton }

function setStatus(msg: string): void {
  status.textContent = msg
}

// ---- 编辑动画 ↔ skeletonData 注册 ----

function rebuildEditAnimation(): void {
  cachedEditAnim = null
  if (!editName) return
  const json = animEditor.toSpineJSON()
  if (!json) return
  skeletonData.animations = skeletonData.animations.filter((a) => a.name !== editName)
  try {
    new SkeletonJson(attachmentLoader).readAnimation(json, editName, skeletonData)
    cachedEditAnim = skeletonData.findAnimation(editName) ?? null
  } catch (e) {
    setStatus(`动画解析失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function refreshAnimList(): void {
  const sel = $('animSel') as HTMLSelectElement
  sel.innerHTML = ''
  const names = Object.keys(dollJson.animations ?? {})
  for (const n of names) {
    const opt = document.createElement('option')
    opt.value = n
    opt.textContent = n
    if (n === (editName ?? playAnim)) opt.selected = true
    sel.appendChild(opt)
  }
}

// ---- 姿态应用 ----

function applyEditPose(): void {
  if (cachedEditAnim) {
    // lastTime=0 + loop=false：一次性落到 playhead 时刻，wrap 无边缘问题；
    // appliedPose=true：与官方 AnimationState.apply 一致，写入 appliedPose（渲染 + 打帧读值都依赖它）
    cachedEditAnim.apply(skeleton, 0, playhead, false, [], 1, MixFrom.first, false, false, true)
  } else {
    skeleton.setupPose()
  }
  skeleton.update(0)
  skeleton.updateWorldTransform(Physics.update)
}

function applyPlayPose(): void {
  state.apply(skeleton)
  skeleton.update(0)
  skeleton.updateWorldTransform(Physics.update)
}

function pauseAt(t: number): void {
  const dur = editName ? (animEditor.getAnimation()?.duration ?? 0) : (skeletonData.findAnimation(playAnim)?.duration ?? 0)
  playhead = Math.max(0, Math.min(t, dur || 0))
  if (editName) {
    applyEditPose()
  } else {
    const track = (state as any).tracks?.[0]
    if (track) track.trackTime = playhead
    applyPlayPose()
  }
  timeline?.setPlayhead(playhead)
  graph?.setPlayhead(playhead)
  gizmo?.setCurrentTime(playhead) // gizmo 拖拽打帧要以播放头时刻为准
}

// ---- 渲染循环 ----

let last = performance.now()
function frame(t: number): void {
  const dt = Math.min(t - last, 250)
  last = t
  const dur = editName ? (animEditor.getAnimation()?.duration ?? 0) : (skeletonData.findAnimation(playAnim)?.duration ?? 0)
  if (playing && dur > 0) {
    playhead = (playhead + dt / 1000) % dur
  }
  if (editName) {
    if (playing && dur > 0) applyEditPose()
    gizmo?.setCurrentTime(playhead)
    gizmo?.render()
  } else if (playing) {
    state.update(dt / 1000)
    applyPlayPose()
  }
  drawStage()
  if (playing) {
    timeline?.setPlayhead(playhead)
    graph?.setPlayhead(playhead)
  }
  requestAnimationFrame(frame)
}

function drawStage(): void {
  stageCtx.setTransform(1, 0, 0, 1, 0, 0)
  stageCtx.clearRect(0, 0, stage.width, stage.height)
  stageCtx.imageSmoothingEnabled = false
  renderer.draw(skeleton)
}

function setupStageTransform(): void {
  skeleton.x = stage.width / 2
  // 素体部件占 y∈[0,64]（origin 在头顶），按帧高居中
  skeleton.y = Math.max(24, (stage.height - 64 * zoom) / 2)
  skeleton.scaleX = zoom
  skeleton.scaleY = zoom
}

// ---- 方向（skin）切换 ----

function setDir(d: (typeof DIRS)[number]): void {
  dir = d
  skeleton.setSkin(d)
  skeleton.setupPoseSlots()
  if (editName) {
    applyEditPose()
  } else {
    const base = playAnim.replace(/_(down|up|left|right)$/, '')
    playAnim = Object.keys(dollJson.animations).includes(`${base}_${dir}`) ? `${base}_${dir}` : playAnim
    state.setAnimation(0, playAnim, true)
    playhead = 0
    applyPlayPose()
  }
  refreshAnimList()
}

// ---- 编辑模式进出 ----

function loadAnimationToEditor(name: string): void {
  const jsonAnim = dollJson.animations?.[name]
  if (!jsonAnim) {
    setStatus(`动画不存在: ${name}`)
    return
  }
  const boneNames = skeletonData.bones.map((b) => b.name)
  const editableSlotNames = skeletonData.slots.map((s) => s.name)
  const boneToSlots = new Map<string, string[]>()
  for (const slot of skeletonData.slots) {
    const bn = slot.boneData?.name
    if (!bn) continue
    const arr = boneToSlots.get(bn) ?? []
    arr.push(slot.name)
    boneToSlots.set(bn, arr)
  }
  animEditor.loadAnimation(name, jsonAnim, boneNames, boneToSlots, undefined, editableSlotNames)
  editName = name
  playing = false
  playhead = 0

  timeline?.destroy()
  graph?.destroy()
  gizmo?.destroy()

  const timelineContainer = $('timelineBox')
  const graphContainer = $('graphBox')
  timeline = new TimelineView(timelineContainer, animEditor, handleTimelineEvent)
  timeline.setBoneToSlotsMap(boneToSlots)
  timeline.render()
  graph = new GraphEditor(graphContainer, animEditor, handleGraphEvent)
  graph.render()
  gizmo = new BoneGizmo(gizmoCv, skeletonProvider, animEditor, onGizmoUpdate, onGizmoDragEnd)
  gizmo.setCurrentTime(0)

  $('timelineEmpty').style.display = 'none'
  $('graphEmpty').style.display = 'none'
  ;($('duration') as HTMLInputElement).disabled = false
  ;($('editBtn') as HTMLButtonElement).disabled = true
  ;($('exitBtn') as HTMLButtonElement).disabled = false
  ;($('saveBtn') as HTMLButtonElement).disabled = false
  selectedBone = null
  selectedChannel = null
  selectedKfIndex = -1
  updateKeyframeProps()
  updateGraphEditor()
  updateUndoRedoButtons()
  rebuildEditAnimation()
  skeleton.setupPose()
  applyEditPose()
  refreshAnimList()
  setStatus(`编辑中: ${name}（改动需点「保存动作」写回 JSON）`)
}

function exitEditor(): void {
  editName = null
  cachedEditAnim = null
  timeline?.destroy()
  graph?.destroy()
  gizmo?.destroy()
  timeline = null
  graph = null
  gizmo = null
  $('timelineEmpty').style.display = ''
  $('graphEmpty').style.display = ''
  ;($('duration') as HTMLInputElement).disabled = true
  ;($('editBtn') as HTMLButtonElement).disabled = false
  ;($('exitBtn') as HTMLButtonElement).disabled = true
  ;($('saveBtn') as HTMLButtonElement).disabled = true
  undo.clear()
  updateUndoRedoButtons()
  selectedBone = null
  selectedChannel = null
  selectedKfIndex = -1
  updateKeyframeProps()
  // 回播放模式
  playAnim = Object.keys(dollJson.animations).includes(playAnim) ? playAnim : 'idle_down'
  state.setAnimation(0, playAnim, true)
  playhead = 0
  playing = true
  setPlayBtn()
  refreshAnimList()
  setStatus('已退出编辑')
}

// ---- 打帧（继承当前姿态）----

// spine 4.3 时间轴值语义：rotate/translate/shear = setup 偏移（pose = setup + V），scale = setup 乘数（pose = setup × V）。
// 编辑器关键帧统一存偏移/乘数（与 Spine JSON 原生一致），面板/Gizmo 展示与输入用绝对姿态值，在此互转。
function boneSetup(boneName: string) {
  // spine 4.3: setup 值在 BoneData.setupPose（BonePose: x/y/rotation/scaleX/scaleY/shearX/shearY）
  return skeletonData.bones.find((b) => b.name === boneName)?.setupPose ?? null
}

// 通道感知读取当前姿态并转为关键帧值（偏移/乘数空间）
function currentBonePose(boneName: string, channel: BoneChannel): { value?: number; x?: number; y?: number } {
  const d = boneSetup(boneName)
  const sx = d?.scaleX || 1
  const sy = d?.scaleY || 1
  const bone = skeleton.findBone(boneName)
  if (!bone || !d) return channel === 'rotate' ? { value: 0 } : { x: channel === 'scale' ? 1 : 0, y: channel === 'scale' ? 1 : 0 }
  const p = (bone as any).appliedPose ?? bone
  switch (channel) {
    case 'rotate':
      return { value: (p.rotation ?? 0) - (d.rotation ?? 0) }
    case 'translate':
      return { x: (p.x ?? 0) - (d.x ?? 0), y: (p.y ?? 0) - (d.y ?? 0) }
    case 'scale':
      return { x: (p.scaleX ?? 1) / sx, y: (p.scaleY ?? 1) / sy }
    case 'shear':
      return { x: (p.shearX ?? 0) - (d.shearX ?? 0), y: (p.shearY ?? 0) - (d.shearY ?? 0) }
  }
}

// ---- 时间轴事件 ----

function handleTimelineEvent(event: TimelineEvent): void {
  if (!editName) return
  switch (event.type) {
    case 'select-keyframe': {
      selectedBone = event.boneName || null
      selectedChannel = event.channel || null
      selectedKfIndex = event.keyframeIndex ?? -1
      gizmo?.setSelectedBone(event.channel === ('slot' as any) ? null : selectedBone)
      const kfTime = getSelectedKfTime()
      if (kfTime >= 0) pauseAt(kfTime)
      updateKeyframeProps()
      updateGraphEditor()
      break
    }
    case 'add-keyframe': {
      if (!event.boneName) return
      if (event.channel === ('slot' as any)) {
        const cmd = new AddSlotKeyframeCommand(animEditor, event.boneName, event.time ?? 0, undefined)
        cmd.redo()
        undo.execute(cmd)
        updateUndoRedoButtons()
        selectedBone = event.boneName
        selectedChannel = 'slot'
        const track = animEditor.getAnimation()?.slotTracks.get(event.boneName)
        selectedKfIndex = track ? track.keyframes.findIndex((k) => Math.abs(k.time - (event.time ?? 0)) < 0.001) : -1
        timeline?.setSelected(selectedBone, selectedChannel as any, selectedKfIndex)
        updateKeyframeProps()
        rebuildEditAnimation()
        applyEditPose()
        break
      }
      const time = event.time ?? 0
      // 打帧继承当前姿态：每通道读各自的 BonePose 字段，避免 translate 值污染 scale/shear
      const cmds = CHANNELS.map((ch) => {
        const cmd = new AddKeyframeCommand(animEditor, event.boneName!, ch, time, currentBonePose(event.boneName!, ch))
        cmd.redo()
        return cmd
      })
      undo.execute(new MacroCommand(cmds, `打帧 ${event.boneName}@${time.toFixed(2)}（继承姿态）`))
      updateUndoRedoButtons()
      selectedBone = event.boneName
      selectedChannel = 'rotate'
      const track = animEditor.getAnimation()?.boneTracks.get(event.boneName)
      selectedKfIndex = track ? track.rotate.findIndex((k) => Math.abs(k.time - time) < 0.001) : -1
      gizmo?.setSelectedBone(selectedBone)
      timeline?.setSelected(selectedBone, selectedChannel as any, selectedKfIndex)
      updateKeyframeProps()
      updateGraphEditor()
      rebuildEditAnimation()
      applyEditPose()
      break
    }
    case 'move-keyframe':
    case 'multi-move-keyframe':
      rebuildEditAnimation()
      applyEditPose()
      break
    case 'move-keyframe-end': {
      if (event.channel === ('slot' as any)) {
        if (event.boneName && event.oldTime !== undefined && event.time !== undefined) {
          undo.execute(new MoveSlotKeyframeCommand(animEditor, event.boneName, event.oldTime, event.time, { time: event.time }))
          updateUndoRedoButtons()
        }
        break
      }
      if (event.boneName && event.channel && event.oldTime !== undefined && event.time !== undefined) {
        const track = animEditor.getAnimation()?.boneTracks.get(event.boneName)
        const kfIdx = track?.[event.channel].findIndex((k) => Math.abs(k.time - event.time!) < 0.001) ?? -1
        if (track && kfIdx >= 0) {
          undo.execute(new MoveKeyframeCommand(animEditor, event.boneName, event.channel, event.oldTime, event.time, { ...track[event.channel][kfIdx] }))
          selectedKfIndex = kfIdx
          timeline?.setSelected(event.boneName, event.channel, kfIdx)
        }
        updateUndoRedoButtons()
      }
      break
    }
    case 'multi-move-keyframe-end': {
      if (event.moves && event.moves.length > 0) {
        const cmds: MoveKeyframeCommand[] = []
        for (const mv of event.moves) {
          const track = animEditor.getAnimation()?.boneTracks.get(mv.boneName)
          const kf = track?.[mv.channel].find((k) => Math.abs(k.time - mv.newTime) < 0.001)
          if (kf) cmds.push(new MoveKeyframeCommand(animEditor, mv.boneName, mv.channel, mv.oldTime, mv.newTime, { ...kf }))
        }
        if (cmds.length > 0) {
          undo.execute(new MacroCommand(cmds, `移动 ${cmds.length} 个关键帧`))
          updateUndoRedoButtons()
        }
      }
      break
    }
    case 'delete-keyframe':
    case 'multi-delete-keyframe': {
      const sels = event.type === 'multi-delete-keyframe' ? (event.selections ?? []) : event.boneName && event.channel !== undefined && event.keyframeIndex !== undefined ? [{ boneName: event.boneName, channel: event.channel as BoneChannel, keyframeIndex: event.keyframeIndex }] : []
      const cmds: (RemoveKeyframeCommand | RemoveSlotKeyframeCommand)[] = []
      const sorted = [...sels].sort((a, b) => b.keyframeIndex - a.keyframeIndex)
      for (const sel of sorted) {
        if (sel.channel === ('slot' as any)) {
          const kf = animEditor.getAnimation()?.slotTracks.get(sel.boneName)?.keyframes[sel.keyframeIndex]
          if (kf) cmds.push(new RemoveSlotKeyframeCommand(animEditor, sel.boneName, { ...kf }, sel.keyframeIndex))
        } else {
          const kf = animEditor.getAnimation()?.boneTracks.get(sel.boneName)?.[sel.channel][sel.keyframeIndex]
          if (kf) cmds.push(new RemoveKeyframeCommand(animEditor, sel.boneName, sel.channel, { ...kf }, sel.keyframeIndex))
        }
      }
      for (const cmd of cmds) cmd.redo()
      if (cmds.length === 1) undo.execute(cmds[0])
      else if (cmds.length > 1) undo.execute(new MacroCommand(cmds as any, `删除 ${cmds.length} 个关键帧`))
      updateUndoRedoButtons()
      selectedBone = null
      selectedChannel = null
      selectedKfIndex = -1
      gizmo?.setSelectedBone(null)
      timeline?.setSelected(null, null, -1)
      updateKeyframeProps()
      updateGraphEditor()
      rebuildEditAnimation()
      applyEditPose()
      break
    }
    case 'seek':
      if (event.time !== undefined) pauseAt(event.time)
      break
  }
}

function getSelectedKfTime(): number {
  if (!selectedBone || selectedKfIndex < 0) return -1
  const anim = animEditor.getAnimation()
  if (!anim) return -1
  if (selectedChannel === 'slot') return anim.slotTracks.get(selectedBone)?.keyframes[selectedKfIndex]?.time ?? -1
  if (!selectedChannel) return -1
  return anim.boneTracks.get(selectedBone)?.[selectedChannel][selectedKfIndex]?.time ?? -1
}

// ---- 曲线编辑器事件 ----

function handleGraphEvent(event: GraphEvent): void {
  if (!editName) return
  if (event.type === 'select-keyframe' && event.keyframeIndex !== undefined && selectedBone && selectedChannel) {
    selectedKfIndex = event.keyframeIndex
    timeline?.setSelected(selectedBone, selectedChannel as any, selectedKfIndex)
    updateKeyframeProps()
  } else if (event.type === 'update-curve-handle' && event.keyframeIndex !== undefined && event.cx !== undefined && event.cy !== undefined && selectedBone && selectedChannel && selectedChannel !== 'slot') {
    const track = animEditor.getAnimation()?.boneTracks.get(selectedBone)
    const kf = track?.[selectedChannel][event.keyframeIndex]
    if (kf) {
      const oldBezier = kf.bezier ? { ...kf.bezier } : undefined
      const cmd = new UpdateBezierCommand(animEditor, selectedBone, selectedChannel, event.keyframeIndex, oldBezier, { out: [event.cx, event.cy] })
      cmd.redo()
      undo.execute(cmd)
      updateUndoRedoButtons()
      rebuildEditAnimation()
      applyEditPose()
    }
  }
}

// ---- Gizmo 事件 ----

function onGizmoUpdate(): void {
  updateKeyframeProps()
  timeline?.render()
  graph?.render()
  rebuildEditAnimation()
  applyEditPose()
}

function onGizmoDragEnd(info: GizmoDragEndInfo): void {
  if (info.createdNew) {
    undo.execute(new AddKeyframeCommand(animEditor, info.boneName, info.channel, info.time, info.newValue))
  } else {
    const track = animEditor.getAnimation()?.boneTracks.get(info.boneName)
    const kfIdx = track?.[info.channel].findIndex((k) => Math.abs(k.time - info.time) < 0.01) ?? -1
    if (track && kfIdx >= 0) {
      undo.execute(new UpdateKeyframeValueCommand(animEditor, info.boneName, info.channel, kfIdx, info.oldValue, info.newValue))
    }
  }
  updateUndoRedoButtons()
}

// ---- 属性面板 ----

function updateKeyframeProps(): void {
  const body = $('propsBody')
  const empty = $('propsEmpty')
  const anim = animEditor.getAnimation()
  if (!editName || !anim || !selectedBone || selectedKfIndex < 0) {
    body.style.display = 'none'
    empty.style.display = ''
    return
  }
  body.style.display = ''
  empty.style.display = 'none'
  $('prBone').textContent = selectedBone
  for (const id of ['prRotateRow', 'prTranslateRow', 'prScaleRow', 'prShearRow', 'prSlotRow']) $(id).style.display = 'none'

  if (selectedChannel === 'slot') {
    const kf = anim.slotTracks.get(selectedBone)?.keyframes[selectedKfIndex]
    if (!kf) return
    ;($('prTime') as HTMLInputElement).value = kf.time.toFixed(3)
    $('prSlotRow').style.display = ''
    const sel = $('prAttachment') as HTMLSelectElement
    sel.innerHTML = '<option value="">(null/隐藏)</option>'
    const slot = skeletonData.slots.find((s) => s.name === selectedBone)
    if (skeleton.skin && slot) {
      for (const entry of skeleton.skin.getAttachments()) {
        if (entry.slotIndex !== slot.index) continue
        const opt = document.createElement('option')
        opt.value = entry.placeholder
        opt.textContent = entry.placeholder
        if (kf.attachmentName === entry.placeholder) opt.selected = true
        sel.appendChild(opt)
      }
    }
    return
  }

  const track = anim.boneTracks.get(selectedBone)
  if (!track || !selectedChannel) return
  const kfTime = track[selectedChannel][selectedKfIndex]?.time ?? -1
  if (kfTime < 0) return
  ;($('prTime') as HTMLInputElement).value = kfTime.toFixed(3)
  const rowOf: Record<BoneChannel, string> = { rotate: 'prRotateRow', translate: 'prTranslateRow', scale: 'prScaleRow', shear: 'prShearRow' }
  const fields: Record<BoneChannel, [HTMLInputElement, HTMLInputElement?]> = {
    rotate: [$('prRotate') as HTMLInputElement],
    translate: [$('prTx') as HTMLInputElement, $('prTy') as HTMLInputElement],
    scale: [$('prSx') as HTMLInputElement, $('prSy') as HTMLInputElement],
    shear: [$('prHx') as HTMLInputElement, $('prHy') as HTMLInputElement],
  }
  for (const ch of CHANNELS) {
    const kf = track[ch].find((k) => Math.abs(k.time - kfTime) < 0.001)
    if (!kf) continue
    $(rowOf[ch]).style.display = ''
    const [a, b] = fields[ch]
    const d = boneSetup(selectedBone)
    // 关键帧存偏移/乘数，面板展示绝对姿态值（与舞台所见一致）
    if (ch === 'rotate') a.value = ((kf.value ?? 0) + (d?.rotation ?? 0)).toFixed(2)
    else if (ch === 'scale') {
      a.value = ((kf.x ?? 1) * (d?.scaleX || 1)).toFixed(2)
      if (b) b.value = ((kf.y ?? 1) * (d?.scaleY || 1)).toFixed(2)
    } else if (ch === 'shear') {
      a.value = ((kf.x ?? 0) + (d?.shearX ?? 0)).toFixed(2)
      if (b) b.value = ((kf.y ?? 0) + (d?.shearY ?? 0)).toFixed(2)
    } else {
      a.value = ((kf.x ?? 0) + (d?.x ?? 0)).toFixed(2)
      if (b) b.value = ((kf.y ?? 0) + (d?.y ?? 0)).toFixed(2)
    }
  }
}

function onPropInput(ch: BoneChannel | 'time' | 'slot'): void {
  if (!editName || !selectedBone) return
  const anim = animEditor.getAnimation()
  if (!anim) return
  const kfTime = getSelectedKfTime()
  const newTime = parseFloat(($('prTime') as HTMLInputElement).value)

  if (ch === 'time' && kfTime >= 0 && !isNaN(newTime)) {
    if (selectedChannel === 'slot') {
      animEditor.moveSlotKeyframe(selectedBone, selectedKfIndex, newTime)
      const track = anim.slotTracks.get(selectedBone)
      selectedKfIndex = track ? track.keyframes.findIndex((k) => Math.abs(k.time - newTime) < 0.001) : -1
    } else if (selectedChannel) {
      const track = anim.boneTracks.get(selectedBone)
      if (track) {
        const cmds: MoveKeyframeCommand[] = []
        for (const c of CHANNELS) {
          const idx = track[c].findIndex((k) => Math.abs(k.time - kfTime) < 0.001)
          if (idx >= 0) {
            const cmd = new MoveKeyframeCommand(animEditor, selectedBone, c, kfTime, newTime, { ...track[c][idx] })
            cmd.redo()
            cmds.push(cmd)
          }
        }
        undo.execute(new MacroCommand(cmds as any, `移动时间 ${kfTime.toFixed(2)}→${newTime.toFixed(2)}`))
        selectedKfIndex = track[selectedChannel].findIndex((k) => Math.abs(k.time - newTime) < 0.001)
      }
    }
    timeline?.setSelected(selectedBone, selectedChannel as any, selectedKfIndex)
    timeline?.render()
    updateKeyframeProps()
    rebuildEditAnimation()
    applyEditPose()
    updateUndoRedoButtons()
    return
  }

  if (selectedChannel === 'slot' && ch === 'slot') {
    const sel = $('prAttachment') as HTMLSelectElement
    const attName = sel.value || undefined
    animEditor.updateSlotKeyframe(selectedBone, selectedKfIndex, attName)
    const kf = anim.slotTracks.get(selectedBone)?.keyframes[selectedKfIndex]
    if (kf) undo.execute(new AddSlotKeyframeCommand(animEditor, selectedBone, kf.time, attName)) // 简化：重设 attachment
    rebuildEditAnimation()
    applyEditPose()
    return
  }

  if (!selectedChannel || selectedChannel === 'slot') return
  const track = anim.boneTracks.get(selectedBone)
  if (!track) return
  const idx = track[selectedChannel].findIndex((k) => Math.abs(k.time - kfTime) < 0.001)
  if (idx < 0) return
  const old = { ...track[selectedChannel][idx] }
  const kf = track[selectedChannel][idx]
  const d = boneSetup(selectedBone)
  // 输入为绝对姿态值，存储转回偏移/乘数
  if (selectedChannel === 'rotate') kf.value = (parseFloat(($('prRotate') as HTMLInputElement).value) || 0) - (d?.rotation ?? 0)
  else if (selectedChannel === 'translate') {
    kf.x = (parseFloat(($('prTx') as HTMLInputElement).value) || 0) - (d?.x ?? 0)
    kf.y = (parseFloat(($('prTy') as HTMLInputElement).value) || 0) - (d?.y ?? 0)
  } else if (selectedChannel === 'scale') {
    kf.x = (parseFloat(($('prSx') as HTMLInputElement).value) || 1) / (d?.scaleX || 1)
    kf.y = (parseFloat(($('prSy') as HTMLInputElement).value) || 1) / (d?.scaleY || 1)
  } else {
    kf.x = (parseFloat(($('prHx') as HTMLInputElement).value) || 0) - (d?.shearX ?? 0)
    kf.y = (parseFloat(($('prHy') as HTMLInputElement).value) || 0) - (d?.shearY ?? 0)
  }
  const nu = { ...kf }
  undo.execute(new UpdateKeyframeValueCommand(animEditor, selectedBone, selectedChannel, idx, old, nu))
  updateUndoRedoButtons()
  rebuildEditAnimation()
  applyEditPose()
}

function updateGraphEditor(): void {
  if (graph && selectedBone && selectedChannel && selectedChannel !== 'slot') {
    graph.setBoneChannel(selectedBone, selectedChannel as BoneChannel | null)
    $('graphEmpty').style.display = 'none'
  } else if (graph) {
    graph.setBoneChannel(null, null)
    $('graphEmpty').style.display = ''
  }
}

function updateUndoRedoButtons(): void {
  ;($('undoBtn') as HTMLButtonElement).disabled = !undo.canUndo
  ;($('redoBtn') as HTMLButtonElement).disabled = !undo.canRedo
}

// ---- 保存 / 导出 / 导入 ----

function saveEditToDoll(): void {
  if (!editName) return
  const json = animEditor.toSpineJSON()
  if (!json) return
  dollJson.animations[editName] = json
  rebuildEditAnimation() // 重新注册（播放模式也能播新数据）
  refreshAnimList()
  setStatus(`已保存 ${editName} 到内存（导出后落盘）`)
}

function exportDollJson(): void {
  const blob = new Blob([JSON.stringify(dollJson, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'doll.json'
  a.click()
  URL.revokeObjectURL(a.href)
  setStatus('已导出 doll.json（覆盖到 assets/spine/ 后重跑生成器或直接替换）')
}

async function importDollJson(file: File): Promise<void> {
  try {
    const parsed = JSON.parse(await file.text())
    if (!parsed.animations || !parsed.bones) throw new Error('不是合法的 Spine 骨架 JSON')
    dollJson = parsed
    rebuildRuntime()
    exitEditor()
    refreshAnimList()
    setStatus(`已导入 doll.json（${Object.keys(parsed.animations).length} 动画）`)
  } catch (e) {
    setStatus(`导入失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 用内存 dollJson 重建 skeletonData/skeleton/AnimationState（导入后调用） */
function rebuildRuntime(): void {
  skeletonData = new SkeletonJson(attachmentLoader).readSkeletonData(dollJson)
  skeleton = new Skeleton(skeletonData)
  skeleton.setSkin(dir)
  skeleton.setupPoseSlots()
  setupStageTransform()
  state = new AnimationState(new AnimationStateData(skeletonData))
  state.setAnimation(0, playAnim, true)
  applyPlayPose()
}

// ---- 骨骼树 ----

function buildBoneTree(): void {
  const root = $('bones')
  root.innerHTML = ''
  for (const b of skeletonData.bones) {
    let depth = 0
    let p = b.parent
    while (p) {
      depth++
      p = p.parent
    }
    const div = document.createElement('div')
    div.style.paddingLeft = 4 + depth * 12 + 'px'
    div.textContent = b.name
    div.onclick = () => {
      if (!editName) return
      selectedBone = b.name
      selectedChannel = null
      selectedKfIndex = -1
      gizmo?.setSelectedBone(selectedBone)
      for (const el of root.querySelectorAll('div')) el.classList.remove('on')
      div.classList.add('on')
      updateKeyframeProps()
      updateGraphEditor()
      timeline?.setSelected(selectedBone, null, -1)
    }
    root.appendChild(div)
  }
}

// ---- 控件 ----

function setPlayBtn(): void {
  const btn = $('playBtn')
  btn.textContent = playing ? '⏸' : '▶'
  btn.classList.toggle('on', playing)
}

function buttonGroup(id: string, opts: readonly string[], initial: string, onPick: (v: string) => void): void {
  const root = $(id)
  for (const o of opts) {
    const b = document.createElement('button')
    b.textContent = o
    b.classList.toggle('on', o === initial)
    b.onclick = () => {
      for (const el of root.querySelectorAll('button')) el.classList.remove('on')
      b.classList.add('on')
      onPick(o)
    }
    root.appendChild(b)
  }
}

function wireUi(): void {
  ;($('animSel') as HTMLSelectElement).onchange = (e) => {
    const name = (e.target as HTMLSelectElement).value
    if (editName) {
      loadAnimationToEditor(name)
    } else {
      playAnim = name
      state.setAnimation(0, playAnim, true)
      playhead = 0
      if (!playing) pauseAt(0)
    }
  }
  $('editBtn').onclick = () => {
    const name = ($('animSel') as HTMLSelectElement).value
    if (name) loadAnimationToEditor(name)
  }
  $('exitBtn').onclick = () => exitEditor()
  $('newAnim').onclick = () => {
    const name = prompt('新动画全名（建议 基名_方向，如 wave_down）', `anim_${dir}`)
    if (!name) return
    if (dollJson.animations[name]) {
      setStatus(`动画已存在: ${name}`)
      return
    }
    dollJson.animations[name] = { bones: {} }
    refreshAnimList()
    loadAnimationToEditor(name)
  }
  $('dupAnim').onclick = () => {
    const src = editName ?? ($('animSel') as HTMLSelectElement).value
    if (!src) return
    const base = src.replace(/_(down|up|left|right)$/, '')
    const m = base.match(/_v(\d+)$/)
    const name = m ? `${base.slice(0, -m[0].length)}_v${Number(m[1]) + 1}_${dir}` : `${base}_v1_${dir}`
    if (dollJson.animations[name]) {
      setStatus(`动画已存在: ${name}`)
      return
    }
    dollJson.animations[name] = JSON.parse(JSON.stringify(dollJson.animations[src] ?? { bones: {} }))
    refreshAnimList()
    loadAnimationToEditor(name)
  }
  $('playBtn').onclick = () => {
    playing = !playing
    setPlayBtn()
    if (!playing) pauseAt(playhead)
    last = performance.now()
  }
  ;($('duration') as HTMLInputElement).onchange = (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value)
    if (!editName || isNaN(v)) return
    const oldDur = animEditor.getAnimation()?.duration ?? 1
    undo.execute(new SetDurationCommand(animEditor, oldDur, Math.max(0.1, v)))
    animEditor.setDuration(Math.max(0.1, v))
    updateUndoRedoButtons()
    rebuildEditAnimation()
    applyEditPose()
  }
  buttonGroup('dirs', DIRS, dir, (v) => setDir(v as (typeof DIRS)[number]))
  buttonGroup('gizmoModes', ['rotate', 'translate', 'scale', 'shear'], 'rotate', (v) => gizmo?.setMode(v as any))
  $('undoBtn').onclick = () => {
    if (undo.undo()) {
      rebuildEditAnimation()
      applyEditPose()
      timeline?.render()
      graph?.render()
      updateKeyframeProps()
      updateUndoRedoButtons()
    }
  }
  $('redoBtn').onclick = () => {
    if (undo.redo()) {
      rebuildEditAnimation()
      applyEditPose()
      timeline?.render()
      graph?.render()
      updateKeyframeProps()
      updateUndoRedoButtons()
    }
  }
  $('saveBtn').onclick = () => saveEditToDoll()
  $('exportBtn').onclick = () => {
    if (editName) saveEditToDoll()
    exportDollJson()
  }
  $('importBtn').onclick = () => ($('importFile') as HTMLInputElement).click()
  ;($('importFile') as HTMLInputElement).onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (f) void importDollJson(f)
  }
  ;($('zoom') as HTMLInputElement).oninput = (e) => {
    zoom = Number((e.target as HTMLInputElement).value)
    setupStageTransform()
  }
  // 属性面板输入
  ;($('prTime') as HTMLInputElement).addEventListener('change', () => onPropInput('time'))
  for (const [id, ch] of [
    ['prRotate', 'rotate'],
    ['prTx', 'translate'],
    ['prTy', 'translate'],
    ['prSx', 'scale'],
    ['prSy', 'scale'],
    ['prHx', 'shear'],
    ['prHy', 'shear'],
  ] as const) {
    $(id).addEventListener('change', () => onPropInput(ch as BoneChannel))
  }
  ;($('prAttachment') as HTMLSelectElement).onchange = () => onPropInput('slot')
  // 键盘
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return
    if (e.ctrlKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      $('undoBtn').click()
    } else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault()
      $('redoBtn').click()
    } else if (e.key === ' ') {
      e.preventDefault()
      $('playBtn').click()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      pauseAt(playhead - FRAME_STEP)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      pauseAt(playhead + FRAME_STEP)
    }
  })
}

// ---- 启动 ----

async function main(): Promise<void> {
  try {
    const [jsonText, atlasText, img] = await Promise.all([
      fetch('/spine/doll.json').then((r) => {
        if (!r.ok) throw new Error(`doll.json HTTP ${r.status}（先跑 node scripts/gen-spine-skeleton.mjs）`)
        return r.text()
      }),
      fetch('/spine/doll.atlas').then((r) => {
        if (!r.ok) throw new Error(`doll.atlas HTTP ${r.status}`)
        return r.text()
      }),
      new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image()
        im.onload = () => resolve(im)
        im.onerror = () => reject(new Error('doll.png 加载失败'))
        im.src = '/spine/doll.png'
      }),
    ])
    dollJson = JSON.parse(jsonText)

    Skeleton.yDown = true // 静态属性，必须在 new Skeleton 之前
    const atlas = new TextureAtlas(atlasText)
    for (const page of atlas.pages) page.setTexture(new CanvasTexture(img))
    attachmentLoader = new AtlasAttachmentLoader(atlas)

    rebuildRuntime()
    buildBoneTree()
    refreshAnimList()
    wireUi()
    setPlayBtn()
    requestAnimationFrame(frame)
    setStatus(`spine ${skeletonData.version} · ${skeletonData.bones.length} 骨 · ${Object.keys(dollJson.animations).length} 动画 · 选择动画后「进入编辑」`)
  } catch (e) {
    setStatus(`boot 失败: ${e instanceof Error ? e.stack : String(e)}`)
  }
}

void main()
