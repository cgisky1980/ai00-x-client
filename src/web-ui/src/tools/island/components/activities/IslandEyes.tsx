import React, { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import './IslandEyes.scss'

/**
 * 灵动岛机器人眼睛。
 *
 * 设计思想借鉴 bbot (bwnd, MIT) —— 圆形眼 + 上下眼睑遮罩 morph + 阻尼弹簧 +
 * 饱和式注视跟随。独立重写，未复制其源码；不引入 Web Component。
 * 早期参考 RobotEye(MIT)/IrisOLED(MIT)/BoopFace(MIT) 的表情语义与灵动节奏。
 *
 * 核心：所有表情都是一组弹簧参数（lidT/lidB 上下眼睑、tilt 眼睑旋转、
 * lidSkew/scaleSkew 双眼不对称、eyeScale/squashY 大小、gazeX/Y 注视），
 * 每帧积分逼近目标，永不瞬跳。眼睑是岛背景色矩形滑过强调色眼球并旋转，
 * 与胶囊背景同色故无接缝（bbot 的 load-bearing 规则）。
 *
 * data-motion≠full 时冻结所有弹簧、停用眨眼/游走/跟随。
 */

// bbot 的完整 30 个 mood（expressions.js:19-54），不画嘴故省略 mouth/open/head
export type EyeExpression =
  | 'idle' | 'content' | 'relieved' | 'happy' | 'joy' | 'excited' | 'love'
  | 'pleading' | 'shy' | 'surprised' | 'scared' | 'curious' | 'confused' | 'dizzy'
  | 'thinking' | 'focused' | 'suspicious' | 'unimpressed' | 'smug' | 'sly'
  | 'bored' | 'exasperated' | 'worried' | 'guilty' | 'sad' | 'disgusted'
  | 'annoyed' | 'angry' | 'sleepy' | 'sleep'

interface EyeShape {
  lidT: number      // 上眼睑闭合 0..1
  lidB: number      // 下眼睑闭合 0..1
  tilt: number      // 眼睑旋转角度（bbot: +外八怒 / -内八哀）
  lidSkew: number   // 右眼额外上眼睑（怀疑/好奇）
  scaleSkew: number // 右眼大小差（困惑）
  eyeScale: number  // 整体大小
  squashY: number   // 垂直压扁
  gap: number       // 眼距倍率
  gazeX: number     // 静止注视偏置
  gazeY: number
}

const idle: EyeShape = {
  lidT: 0, lidB: 0, tilt: 0, lidSkew: 0, scaleSkew: 0,
  eyeScale: 1, squashY: 1, gap: 1, gazeX: 0, gazeY: 0,
}

const EXPRESSIONS: Record<EyeExpression, Partial<EyeShape>> = {
  idle:        {},
  content:     { lidT: 0.1, lidB: 0.2, eyeScale: 0.96 },
  relieved:    { lidB: 0.34, tilt: -5, squashY: 0.72 },
  happy:       { lidB: 0.44 },
  joy:         { lidT: 0.16, lidB: 0.6, eyeScale: 1.22 },
  excited:     { eyeScale: 1.24, gap: 1.07, gazeY: -0.2 },
  love:        { lidB: 0.12, eyeScale: 1.26 },
  pleading:    { lidB: 0.16, tilt: -9, eyeScale: 1.3, gazeY: -0.3 },
  shy:         { lidT: 0.34, lidSkew: 0.1, tilt: -6, gazeX: -0.5 },
  surprised:   { eyeScale: 1.3 },
  scared:      { lidT: 0.16, tilt: -22, eyeScale: 1.26, gap: 0.86 },
  curious:     { lidSkew: 0.12, eyeScale: 1.08, gazeY: -0.22 },
  confused:    { lidSkew: 0.1, scaleSkew: -0.18 },
  dizzy:       { scaleSkew: 0.42 },
  thinking:    { lidT: 0.22, gazeX: 0.55, gazeY: -0.5 },
  focused:     { lidT: 0.32, lidB: 0.28, gap: 0.94 },
  suspicious:  { lidT: 0.3, lidSkew: 0.24, tilt: 6 },
  unimpressed: { squashY: 0.42, eyeScale: 1.04 },
  smug:        { lidT: 0.34, lidSkew: 0.16, tilt: 8, gazeX: 0.38 },
  sly:         { lidT: 0.28, lidB: 0.36, tilt: 7, gazeX: 0.42 },
  bored:       { lidT: 0.46, gazeX: -0.62 },
  exasperated: { lidT: 0.5, gazeY: -0.72 },
  worried:     { lidT: 0.22, tilt: -14 },
  guilty:      { lidT: 0.38, tilt: -12, gazeX: -0.42, gazeY: 0.4 },
  sad:         { lidT: 0.34, tilt: -20 },
  disgusted:   { lidT: 0.3, lidSkew: 0.16, scaleSkew: -0.1, tilt: 9, squashY: 0.82 },
  annoyed:     { lidT: 0.5, lidB: 0.05, tilt: 10 },
  angry:       { lidT: 0.42, tilt: 22, gap: 0.94 },
  sleepy:      { lidT: 0.6, lidB: 0.05, gazeY: 0.15 },
  sleep:       { lidT: 0.5, lidB: 0.5 },
}

// 轮播序列覆盖全部 30 个（待机偏静态、播放偏活泼）
const ALL_EXPRESSIONS = Object.keys(EXPRESSIONS) as EyeExpression[]
const IDLE_SEQUENCE: EyeExpression[] = [
  ...ALL_EXPRESSIONS.filter((e) => !['excited', 'joy', 'angry'].includes(e)),
]
const PLAY_SEQUENCE: EyeExpression[] = [
  ...ALL_EXPRESSIONS,
]

// 几何：viewBox 56×35，两眼中心 x=14/42 y=17.5，半径 10（更大、眼距更宽）
const VB_W = 56
const VB_H = 35
const CX_L = 12
const CX_R = 44
const CY = 17.5
const R = 10
const SPAN = 2 * R + 1.2 // 眼睑行程（含抗锯齿余量，bbot lidSlack 思想）

const isMotionFull = () => document.documentElement.getAttribute('data-motion') === 'full'

// 阻尼弹簧：bbot 的 v += ((to-x)*k - v*d)*dt; x += v*dt
interface Spring { x: number; v: number; to: number; k: number; d: number }
const spring = (x: number, k: number, d: number): Spring => ({ x, v: 0, to: x, k, d })
const advance = (s: Spring, dt: number) => {
  s.v += ((s.to - s.x) * s.k - s.v * s.d) * dt
  s.x += s.v * dt
}
const SHAPE_KEYS: (keyof EyeShape)[] = [
  'lidT', 'lidB', 'tilt', 'lidSkew', 'scaleSkew', 'eyeScale', 'squashY', 'gap', 'gazeX', 'gazeY',
]

interface IslandEyesProps {
  expression?: EyeExpression
  playing?: boolean
}

export const IslandEyes: React.FC<IslandEyesProps> = ({ expression, playing = false }) => {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const shape = useRef<Record<keyof EyeShape, Spring>>(
    Object.fromEntries(SHAPE_KEYS.map((k) => [k, spring(idle[k], 190, 24)])) as Record<keyof EyeShape, Spring>
  )
  const gaze = useRef({ x: spring(0, 150, 19), y: spring(0, 150, 19) })
  const autoExpr = useRef<EyeExpression>('idle')
  const seqIdx = useRef(0)
  const exprRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const motionRef = useRef(isMotionFull())
  const playingRef = useRef(playing)
  playingRef.current = playing
  const pointer = useRef({ x: 0, y: 0, t: 0, has: false })
  const loveRef = useRef(false)
  const forcedExpr = useRef(expression)

  // data-motion 响应
  useEffect(() => {
    const sync = () => { motionRef.current = isMotionFull() }
    sync()
    const obs = new MutationObserver(sync)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })
    return () => obs.disconnect()
  }, [])

  // 表情轮播
  useEffect(() => {
    if (expression) return
    const schedule = () => {
      exprRef.current = setTimeout(() => {
        const seq = playingRef.current ? PLAY_SEQUENCE : IDLE_SEQUENCE
        autoExpr.current = seq[seqIdx.current % seq.length]
        seqIdx.current++
        const target = EXPRESSIONS[autoExpr.current]
        SHAPE_KEYS.forEach((k) => { shape.current[k].to = target[k] ?? idle[k] })
        loveRef.current = autoExpr.current === 'love'
        schedule()
      }, playing ? 3600 + Math.random() * 1800 : 6500 + Math.random() * 3500)
    }
    schedule()
    return () => { if (exprRef.current) clearTimeout(exprRef.current) }
  }, [expression, playing])

  // 外部 expression prop
  useEffect(() => {
    forcedExpr.current = expression
    if (!expression) return
    const target = EXPRESSIONS[expression]
    SHAPE_KEYS.forEach((k) => { shape.current[k].to = target[k] ?? idle[k] })
    loveRef.current = expression === 'love'
  }, [expression])

  // 鼠标跟随：按全局坐标离岛中心的远近驱动眼球+瞳孔水平位移（sqrt 饱和曲线）
  // 岛窗口鼠标穿透（set_ignore_cursor_events），网页收不到 pointermove，
  // 所以监听 Rust overlay 线程 emit 的全局鼠标坐标（每 2 帧 ~30Hz）。
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    listen<{ x: number; y: number }>('global_pointer', (e) => {
      if (disposed) return
      pointer.current = {
        x: e.payload.x - window.screenX,
        y: e.payload.y - window.screenY,
        t: performance.now(),
        has: true,
      }
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    }).catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // 主循环：弹簧积分 + 眨眼 + 游走 + 跟随 + 心跳 + 直接写 DOM
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const eyes = Array.from(svg.querySelectorAll<SVGGElement>('.eye'))
    const lids = eyes.map((g) => ({
      top: g.querySelector<SVGRectElement>('.eye__lidTop'),
      bottom: g.querySelector<SVGRectElement>('.eye__lidBottom'),
      pupil: g.querySelector<SVGCircleElement>('.eye__pupil'),
    }))
    if (eyes.length < 2) return

    const rand = (a: number, b: number) => a + Math.random() * (b - a)
    const now0 = performance.now()
    let last = now0
    let blinkAt = now0 + rand(1200, 4200)
    let blinkAnim: null | { start: number; dur: number } = null
    let doublePending = false
    let blinkV = 0
    let wanderAt = now0 + rand(700, 2600)
    let wanderTo = { x: 0, y: 0 }
    const wander = { x: 0, y: 0 }

    let raf = 0
    const tick = (now: number) => {
      const dt = Math.max(0.001, Math.min(1 / 30, (now - last) / 1000))
      last = now
      const full = motionRef.current

      // 弹簧：表情形状 + 注视
      for (const k of SHAPE_KEYS) advance(shape.current[k], full ? dt : 0)
      const gx = gaze.current.x, gy = gaze.current.y

      // 注视目标：鼠标跟随（安静 2.2s 后回落游走）
      if (full) {
        const idleGaze = { x: shape.current.gazeX.x, y: shape.current.gazeY.x }
        if (pointer.current.has && now - pointer.current.t < 2200) {
          const box = svg.getBoundingClientRect()
          const cx = box.left + box.width / 2, cy = box.top + box.height / 2
          const dx = pointer.current.x - cx, dy = pointer.current.y - cy
          // 距离映射：左右位移为主。屏幕像素距离归一化到 GAZE_REACH 后饱和，
          // sqrt 曲线让近处就有明显反应、远处平滑到顶（比原来线性*大reach生动）。
          const GAZE_REACH = 520
          const nx = Math.max(-1, Math.min(1, dx / GAZE_REACH))
          const ny = Math.max(-1, Math.min(1, dy / GAZE_REACH))
          const ease = (v: number) => Math.sign(v) * Math.sqrt(Math.abs(v))
          gx.to = Math.max(-1, Math.min(1, ease(nx) + idleGaze.x))
          gy.to = Math.max(-0.65, Math.min(0.65, ease(ny) * 0.7 + idleGaze.y))
        } else {
          if (now >= wanderAt) {
            wanderTo = Math.random() < 0.3 ? { x: 0, y: 0 } : { x: rand(-0.9, 0.9), y: rand(-0.6, 0.6) }
            wanderAt = now + rand(700, 2600)
          }
          gx.to = wander.x + idleGaze.x
          gy.to = wander.y + idleGaze.y
          // 游走本身用慢速 lerp（正弦/随机目标 + 平滑，这里目标变化本身即连续感）
          wander.x += (wanderTo.x - wander.x) * Math.min(1, dt * 2.2)
          wander.y += (wanderTo.y - wander.y) * Math.min(1, dt * 2.2)
        }
        advance(gx, dt); advance(gy, dt)
      } else {
        gx.to = gy.to = 0; gx.x = gy.x = 0; gx.v = gy.v = 0
      }

      // 眨眼：首次 1.2-4.2s，之后 2.2-6s，26% 概率双眨；sin(pπ)^0.55 曲线
      // 注意：p 必须 clamp 到 [0,1]——负数时 Math.pow(负数, 0.55)=NaN，
      // 会让 scaleY 变 NaN、transform 失效、眼睛跳到 viewBox 左上角（曾出现的 bug）。
      if (full && !loveRef.current && shape.current.lidT.x + shape.current.lidB.x < 0.9) {
        if (blinkAnim) {
          const p = Math.max(0, Math.min(1, (now - blinkAnim.start) / blinkAnim.dur))
          blinkV = Math.pow(Math.sin(p * Math.PI), 0.55)
          if (p >= 1) {
            blinkAnim = null; blinkV = 0
            if (doublePending) {
              // 双眨第二下：立即开始，不用未来时间戳（未来 start 会产生负 p）
              blinkAnim = { start: now, dur: 240 }
              doublePending = false
            } else {
              blinkAt = now + rand(2200, 6000)
              if (Math.random() < 0.26) doublePending = true
            }
          }
        } else if (now >= blinkAt) {
          blinkAnim = { start: now, dur: 260 }
        }
      } else { blinkV = 0 }

      // 心跳 lub-dub 双峰（爱心时）
      const beatT = ((now - now0) % 680) / 680
      const bell = (x: number, c: number, w: number) => Math.exp(-((x - c) ** 2) / (2 * w * w))
      const pulse = Math.max(bell(beatT, 0.12, 0.085), 0.62 * bell(beatT, 0.40, 0.10))
      const heartScale = loveRef.current && full ? 1 + 0.44 * pulse : 1

      const s = shape.current
      const scale = s.eyeScale.x * heartScale
      const squash = s.squashY.x * (1 - blinkV * 0.94)
      const tilt = s.tilt.x
      const gap = s.gap.x

      eyes.forEach((g, i) => {
        const side = i === 0 ? -1 : 1
        const cx = (side < 0 ? CX_L : CX_R) * (1 + (gap - 1) * 0.35)
        const skew = side > 0 ? s.lidSkew.x : 0
        const ss = scale * (side > 0 ? 1 + s.scaleSkew.x : 1)
        // 球面式注视：两眼朝同一方向平移（幅度加大到接近 viewBox 安全边界，更生动）
        const gxPx = gx.x * 2.6, gyPx = gy.x * 1.8
        // 用 SVG presentation attribute 而非 CSS transform（CSS 在 SVG 上坐标系行为不同，
        // 会导致眼睛跑出 viewBox）。顺序：先位移到眼位再缩放，瞳孔/眼睑都以眼中心为原点。
        g.setAttribute('transform', `translate(${(cx + gxPx).toFixed(2)} ${(CY + gyPx).toFixed(2)}) scale(${ss.toFixed(3)} ${(ss * squash).toFixed(3)})`)
        g.style.transform = ''
        g.style.transformOrigin = ''
        const spin = -side * tilt
        if (lids[i].top) {
          const lidT = Math.max(0, Math.min(1, s.lidT.x + skew))
          lids[i].top!.setAttribute('transform', `rotate(${spin.toFixed(2)}) translate(0 ${(-R + lidT * SPAN).toFixed(2)})`)
        }
        if (lids[i].bottom) {
          const lidB = Math.max(0, Math.min(1, s.lidB.x))
          lids[i].bottom!.setAttribute('transform', `rotate(${spin.toFixed(2)}) translate(0 ${(R - lidB * SPAN).toFixed(2)})`)
        }
        // 黑瞳视差：随注视移动（瞳孔在眼球内空间更大，加大幅度强化"看向鼠标"）
        if (lids[i].pupil) {
          lids[i].pupil!.setAttribute(
            'transform',
            `translate(${(gx.x * 5.2).toFixed(2)} ${(gy.x * 4.2).toFixed(2)})`
          )
        }
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const mask = 'var(--color-bg-primary)' // 黑瞳 + 眼睑同色（岛背景）
  const ink = 'var(--color-text-primary)' // 白眼球

  return (
    <svg ref={svgRef} className="island-eyes" viewBox={`0 0 ${VB_W} ${VB_H}`} width={68} height={42} aria-hidden="true">
      <defs>
        <clipPath id="island-eye-clip-L"><circle cx="0" cy="0" r={R + 0.6} /></clipPath>
        <clipPath id="island-eye-clip-R"><circle cx="0" cy="0" r={R + 0.6} /></clipPath>
        <radialGradient id="island-eye-gloss">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {(['L', 'R'] as const).map((side) => (
        <g className="eye" key={side}>
          <g clipPath={`url(#island-eye-clip-${side})`}>
            {/* 眼球：白色 */}
            <circle className="eye__ball" cx="0" cy="0" r={R} fill={ink} />
            {/* 黑瞳珠子：随注视微移，位于眼睑之下（眨眼时被盖住） */}
            <circle className="eye__pupil" cx="0" cy="0" r={R * 0.42} fill={mask} />
            {/* 双高光点：玻璃珠质感 */}
            <circle cx={-R * 0.34} cy={-R * 0.4} r={R * 0.26} fill="url(#island-eye-gloss)" opacity="0.95" />
            <circle cx={R * 0.26} cy={R * 0.2} r={R * 0.13} fill="url(#island-eye-gloss)" opacity="0.7" />
            {/* 上下眼睑：岛背景色矩形滑过并旋转（与底色同色故无接缝） */}
            <rect className="eye__lidTop" x={-R * 2} y={-R * 4} width={R * 4} height={R * 4} fill={mask} />
            <rect className="eye__lidBottom" x={-R * 2} y="0" width={R * 4} height={R * 4} fill={mask} />
          </g>
        </g>
      ))}
    </svg>
  )
}
