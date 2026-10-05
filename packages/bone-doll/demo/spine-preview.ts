/**
 * Spine 转换比对台：左 = BoneDoll 自研运行时（skeleton.json + parts/*.png），
 * 右 = spine-canvas 官方运行时（spine/doll.json + doll.atlas + doll.png）。
 * 验证目标：生成器转换正确性——setup pose 像素对齐、同动画同步播放、四方向 skin 切换。
 *
 * 渲染要点（4.3.7 实测约束）：
 * - Skeleton.yDown = true（静态属性，实例化前设置）：画布 y 向下，与 bone-doll 视觉一致；
 * - renderer.triangleRendering = true：部件是非加权 mesh，drawImages 路径只画 region；
 * - imageSmoothingEnabled = false：像素风 NEAREST（canvas 改尺寸会重置，须每帧设）。
 */
import { BoneDoll, type RuntimeDir } from '../src/index'
import {
  AnimationState,
  AnimationStateData,
  AtlasAttachmentLoader,
  CanvasTexture,
  Physics,
  Skeleton,
  SkeletonJson,
  SkeletonRenderer,
  TextureAtlas,
} from '@esotericsoftware/spine-canvas'

const DIRS: RuntimeDir[] = ['down', 'up', 'left', 'right']
const status = document.getElementById('status') as HTMLElement
const bdCanvas = document.getElementById('bd') as HTMLCanvasElement
const spCanvas = document.getElementById('sp') as HTMLCanvasElement
const spCtx = spCanvas.getContext('2d') as CanvasRenderingContext2D

function buttonGroup(id: string, opts: readonly string[], initial: string, onPick: (v: string) => void): void {
  const root = document.getElementById(id) as HTMLElement
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

async function main(): Promise<void> {
  try {
    // ---- 左：BoneDoll 自研运行时
    const doll = await BoneDoll.load('/', { scale: 4 })
    // Spine skin 天然包含全部部件 → BoneDoll 侧补装全部，保证两侧同集比对（含 hat/weapon/cape 叠层）
    for (const key of Object.keys(doll.skeleton.parts)) await doll.equip(key)
    doll.attach(bdCanvas)
    const F = doll.skeleton.frame
    doll.play('idle')
    doll.pause() // 停掉自带 rAF，改由下方统一循环驱动（与 spine 同一 dt）

    // ---- 右：spine-canvas 官方运行时
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

    Skeleton.yDown = true // 静态属性，必须在 new Skeleton 之前
    const atlas = new TextureAtlas(atlasText)
    for (const page of atlas.pages) page.setTexture(new CanvasTexture(img))
    const data = new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(jsonText)
    const skeleton = new Skeleton(data)

    const state = new AnimationState(new AnimationStateData(data))
    const renderer = new SkeletonRenderer(spCtx)
    renderer.triangleRendering = true

    let dir: RuntimeDir = 'down'
    let anim = 'idle'
    let playing = true
    let scale = 4

    const drawSpine = (): void => {
      spCtx.setTransform(1, 0, 0, 1, 0, 0)
      spCtx.clearRect(0, 0, spCanvas.width, spCanvas.height)
      spCtx.imageSmoothingEnabled = false
      spCtx.setTransform(scale, 0, 0, scale, 0, 0)
      renderer.draw(skeleton)
    }

    const poseSpine = (): void => {
      state.apply(skeleton)
      skeleton.update(0)
      skeleton.updateWorldTransform(Physics.update)
    }

    /** 暂停状态下的即时重画（播放中由统一循环接管） */
    const renderBoth = (): void => {
      doll.render()
      poseSpine()
      drawSpine()
    }

    /** 两边同时从头播当前动画（方向切换/重置时保证时钟同步） */
    const restartBoth = (): void => {
      doll.play(anim, { restart: true })
      doll.pause()
      state.setAnimation(0, `${anim}_${dir}`, doll.skeleton.animations[anim].loop)
      if (!playing) renderBoth()
    }

    // 初始姿态：down skin + idle_down
    skeleton.setSkin(dir)
    skeleton.setupPoseSlots()
    state.setAnimation(0, `${anim}_${dir}`, doll.skeleton.animations[anim].loop)

    // 统一驱动循环：同一 dt 喂两边（暂停时冻结姿态）
    let last = performance.now()
    const step = (t: number): void => {
      const dt = Math.min(t - last, 250)
      last = t
      if (playing) {
        doll.tick(dt)
        doll.render()
        state.update(dt / 1000)
        poseSpine()
        drawSpine()
      }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)

    // ---- 换装（slot attachment 切换；部件库变体在 skin 内以 `{slot}.{name}` 命名）
    const partsSel = document.getElementById('partsSel') as HTMLSelectElement
    let pick: { slot: string; att: string | null } | null = null
    const applyPick = (): void => {
      if (pick) skeleton.setAttachment(pick.slot, pick.att)
    }
    const restoreAndApply = (): void => {
      skeleton.setSkin(dir) // 方向 = skin；setupPoseSlots 按 attachmentName 重建附件（无残留）
      skeleton.setupPoseSlots()
      applyPick()
    }
    const downSkin = data.skins.find((s) => s.name === 'down') ?? data.skins[0]
    const attsBySlot = new Map<string, string[]>()
    for (const entry of downSkin.getAttachments()) {
      const slotName = data.slots[entry.slotIndex]?.name
      if (!slotName) continue
      const arr = attsBySlot.get(slotName) ?? []
      arr.push(entry.placeholder)
      attsBySlot.set(slotName, arr)
    }
    partsSel.innerHTML = '<option value="">（各槽默认）</option>'
    let variantSlots = 0
    for (const [slotName, atts] of [...attsBySlot.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (atts.length <= 1) continue
      variantSlots++
      for (const att of atts.sort()) {
        const opt = document.createElement('option')
        opt.value = `${slotName}|${att}`
        opt.textContent = `${slotName} → ${att}`
        partsSel.appendChild(opt)
      }
    }
    partsSel.onchange = () => {
      const v = partsSel.value
      if (!v) {
        pick = null
        restoreAndApply()
      } else {
        const bar = v.indexOf('|')
        pick = { slot: v.slice(0, bar), att: v.slice(bar + 1) }
        applyPick()
      }
      if (!playing) renderBoth()
    }

    // ---- 控件
    buttonGroup('anims', doll.listAnims(), anim, (v) => {
      anim = v
      restartBoth()
    })
    buttonGroup('dirs', DIRS, dir, (v) => {
      dir = v as RuntimeDir
      doll.setDirection(dir)
      restoreAndApply()
      restartBoth()
    })

    const playBtn = document.getElementById('playBtn') as HTMLButtonElement
    playBtn.onclick = () => {
      playing = !playing
      playBtn.textContent = playing ? '暂停' : '播放'
      playBtn.classList.toggle('on', playing)
      last = performance.now()
    }
    ;(document.getElementById('resetBtn') as HTMLButtonElement).onclick = () => restartBoth()

    const scaleEl = document.getElementById('scale') as HTMLInputElement
    const scaleVal = document.getElementById('scaleVal') as HTMLElement
    scaleEl.oninput = () => {
      scale = Number(scaleEl.value)
      doll.setScale(scale)
      const S = F * scale
      spCanvas.width = S
      spCanvas.height = S
      scaleVal.textContent = `${scale}×`
      if (!playing) renderBoth()
    }

    status.textContent = `spine ${data.version} · ${data.bones.length} 骨 · ${data.animations.length} 动画 · skins ${data.skins.map((s) => s.name).join('/')} · mesh 三角光栅 · 换装槽 ${variantSlots}`
  } catch (e) {
    status.textContent = `boot 失败: ${e instanceof Error ? e.stack : String(e)}`
  }
}

void main()
