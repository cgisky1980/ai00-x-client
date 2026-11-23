import React, { useEffect, useMemo, useRef, useState } from 'react'
import './IslandEyes.scss'

/**
 * 灵动岛机器人眼睛（参数化 SVG 实现）。
 *
 * 设计思想借鉴（均为独立重写，未复制源码）：
 * - RobotEye (fonzu, MIT) —— EyeParams 参数模型 + 24 矢量表情
 * - IrisOLED (orji123, MIT) —— 表情语义与几何
 * - FluxGarage/RoboEyes (GPL-3.0) —— 实心眼 + 背景遮罩塑形思想
 *
 * 核心：所有表情都是「同一只眼的参数变形」。每只眼用一组几何参数描述，
 * 表情切换只改参数，CSS transition 负责平滑 morph。遮罩色用岛内固定暗色，
 * 在恒暗胶囊上形成 OLED 发光眼观感。
 *
 * data-motion≠full 时冻结为静态 normal 眼（跟随用户/系统减动效设置）。
 */

export type EyeExpression =
  | 'normal' | 'happy' | 'angry' | 'sad' | 'surprised' | 'sleepy'
  | 'excited' | 'scared' | 'focused' | 'worried' | 'despair' | 'furious'
  | 'bored' | 'alert' | 'blink' | 'blinkUp' | 'blinkDown'
  | 'disoriented' | 'lookUp' | 'lookDown' | 'lookLeft' | 'lookRight'
  | 'winkLeft' | 'winkRight'

interface EyeParams {
  w: number
  h: number
  r: number
  /** 相对基准位置的偏移 */
  dx: number
  dy: number
  /** 顶部/底部水平切口高度 */
  topCut: number
  bottomCut: number
  /** 顶部左右斜切高度（倒八字/八字眉） */
  topSlopeL: number
  topSlopeR: number
  /** 中心椭圆遮罩（兴奋月牙眼）*/
  maskRx: number
  maskRy: number
}

type Face = { left: EyeParams; right: EyeParams }

// viewBox 56×35；基准眼 w16 h18 r5，两眼间距加大到 18，
// 左眼 x=3、右眼 x=37（眼组 3..53 中心=28 正好居中），居中 y=(35-18)/2=8.5
const VB_W = 56
const VB_H = 35
const BASE_X_L = 3
const BASE_X_R = 37
const BASE_Y = 9

const baseEye = (): EyeParams => ({
  w: 16, h: 18, r: 5, dx: 0, dy: 0,
  topCut: 0, bottomCut: 0, topSlopeL: 0, topSlopeR: 0, maskRx: 0, maskRy: 0,
})

/** 表情 →  Face 几何。参照 RobotEye re_gen_* 与 IrisOLED 位图 bbox 换算到 56×35。 */
function buildFace(expr: EyeExpression): Face {
  const L = baseEye()
  const R = baseEye()
  const both = (fn: (e: EyeParams) => void) => { fn(L); fn(R) }

  switch (expr) {
    case 'happy': // 眯眼笑：底部切掉一半
      both((e) => { e.bottomCut = 9 })
      break
    case 'excited': // 月牙弯眼：底部切 + 中心椭圆遮罩
      both((e) => { e.bottomCut = 6; e.maskRx = 7; e.maskRy = 4 })
      break
    case 'angry': // 怒眉：顶部斜切，左眼左低右高、右眼镜像
      L.topSlopeL = 3; L.topSlopeR = 8
      R.topSlopeL = 8; R.topSlopeR = 3
      break
    case 'furious':
      L.topSlopeL = 5; L.topSlopeR = 12
      R.topSlopeL = 12; R.topSlopeR = 5
      break
    case 'sad': // 八字眉 + 下移
      L.topSlopeL = 8; L.topSlopeR = 3
      R.topSlopeL = 3; R.topSlopeR = 8
      both((e) => { e.dy = 5 })
      break
    case 'sleepy': // 更缓的斜切 + 压扁
      L.topSlopeL = 7; L.topSlopeR = 9
      R.topSlopeL = 9; R.topSlopeR = 7
      both((e) => { e.h = 12; e.dy = 4 })
      break
    case 'worried':
      L.topSlopeL = 7; L.topSlopeR = 3
      R.topSlopeL = 3; R.topSlopeR = 7
      break
    case 'despair':
      L.topSlopeL = 6; L.topSlopeR = 2
      R.topSlopeL = 2; R.topSlopeR = 6
      both((e) => { e.h = 10; e.dy = 3 })
      break
    case 'scared': // 惊恐：放大 + 上移 + 直角
      both((e) => { e.w = 18; e.h = 22; e.r = 1; e.dy = -3 })
      break
    case 'surprised': // 惊讶：放大 + 间距缩小
      both((e) => { e.w = 19; e.h = 21; e.r = 7 })
      L.dx = 2; R.dx = -2
      break
    case 'focused': // 专注：压扁
      both((e) => { e.h = 9; e.r = 4; e.dy = 3 })
      break
    case 'alert': // 警觉：竖窄条
      both((e) => { e.w = 6; e.h = 20; e.r = 3; e.dy = -1 })
      L.dx = 3; R.dx = -3
      break
    case 'bored': // 无聊：扁平 + 下移
      both((e) => { e.h = 11; e.r = 4; e.dy = 6; e.topCut = 2 })
      break
    case 'disoriented': // 迷糊：缩小 + 外移
      both((e) => { e.w = 13; e.h = 14; e.r = 6 })
      L.dx = -4; R.dx = 4
      break
    case 'blink':
      both((e) => { e.h = 2.5; e.r = 1.25; e.dy = 8 })
      break
    case 'blinkUp':
      both((e) => { e.h = 2.5; e.r = 1.25; e.dy = 3 })
      break
    case 'blinkDown':
      both((e) => { e.h = 2.5; e.r = 1.25; e.dy = 13 })
      break
    case 'winkLeft':
      L.h = 2.5; L.r = 1.25; L.dy = 8
      break
    case 'winkRight':
      R.h = 2.5; R.r = 1.25; R.dy = 8
      break
    case 'lookUp':
      both((e) => { e.dy = -5 })
      break
    case 'lookDown':
      both((e) => { e.dy = 5 })
      break
    case 'lookLeft':
      both((e) => { e.dx = -5 })
      break
    case 'lookRight':
      both((e) => { e.dx = 5 })
      break
    case 'normal':
    default:
      break
  }
  return { left: L, right: R }
}

/** 单只眼睛 SVG：圆角矩形 + 暗色遮罩塑形（几何坐标直接含 dx/dy） */
const Eye: React.FC<{ p: EyeParams; x: number; mask: string; ink: string }> = ({ p, x, mask, ink }) => {
  const ex = x + p.dx
  const ey = BASE_Y + p.dy
  const slopeL = p.topSlopeL
  const slopeR = p.topSlopeR
  const common = Math.min(slopeL, slopeR)
  return (
    <g className="eye">
      {/* 眼球 */}
      <rect x={ex} y={ey} width={p.w} height={p.h} rx={p.r} fill={ink} className="eye__ball" />
      {/* 顶部水平切口 */}
      {p.topCut > 0 && (
        <rect x={ex} y={ey} width={p.w} height={Math.min(p.topCut, p.h)} fill={mask} className="eye__mask" />
      )}
      {/* 底部水平切口（眯眼笑） */}
      {p.bottomCut > 0 && (
        <rect x={ex} y={ey + p.h - Math.min(p.bottomCut, p.h)} width={p.w} height={Math.min(p.bottomCut, p.h)} fill={mask} className="eye__mask" />
      )}
      {/* 顶部斜切（怒眉/八字眉）：左右三角，用 polygon */}
      {common > 0 && (
        <polygon points={`${ex},${ey} ${ex + p.w},${ey} ${ex + p.w},${ey + common}`} fill={mask} className="eye__mask" />
      )}
      {slopeL > common && (
        <polygon points={`${ex},${ey + common} ${ex + p.w},${ey + common} ${ex},${ey + slopeL}`} fill={mask} className="eye__mask" />
      )}
      {slopeR > common && (
        <polygon points={`${ex},${ey + common} ${ex + p.w},${ey + common} ${ex + p.w},${ey + slopeR}`} fill={mask} className="eye__mask" />
      )}
      {/* 中心椭圆遮罩（兴奋月牙眼） */}
      {p.maskRx > 0 && (
        <ellipse cx={ex + p.w / 2} cy={ey + p.h / 2} rx={p.maskRx} ry={p.maskRy} fill={mask} className="eye__mask" />
      )}
    </g>
  )
}

interface IslandEyesProps {
  /** 外部情绪（可选） */
  expression?: EyeExpression
  /** 是否有音乐在播放（播放时自动换表情更活泼） */
  playing?: boolean
}

// 表情轮播序列——覆盖更多表情，让用户能看到丰富的动画
const IDLE_SEQUENCE: EyeExpression[] = [
  'normal', 'happy', 'focused', 'sleepy', 'normal', 'lookLeft', 'winkLeft',
  'normal', 'worried', 'lookRight', 'bored', 'normal', 'sad',
]
const PLAY_SEQUENCE: EyeExpression[] = [
  'happy', 'excited', 'happy', 'winkLeft', 'surprised', 'happy', 'winkRight',
  'excited', 'scared', 'happy', 'angry', 'normal', 'happy',
]

const isMotionFull = () => document.documentElement.getAttribute('data-motion') === 'full'

export const IslandEyes: React.FC<IslandEyesProps> = ({ expression, playing = false }) => {
  const [autoExpr, setAutoExpr] = useState<EyeExpression>('normal')
  const seqIdx = useRef(0)
  const [motionFull, setMotionFull] = useState(isMotionFull)
  const exprTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const face = useMemo(() => buildFace(expression ?? autoExpr), [expression, autoExpr])

  // 响应 data-motion 变化
  useEffect(() => {
    const obs = new MutationObserver(() => setMotionFull(isMotionFull()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })
    return () => obs.disconnect()
  }, [])

  // 自动表情轮播（播放时更活泼）
  useEffect(() => {
    if (!motionFull || expression) return
    const seq = playing ? PLAY_SEQUENCE : IDLE_SEQUENCE
    const schedule = () => {
      exprTimer.current = setTimeout(() => {
        setAutoExpr(seq[seqIdx.current % seq.length])
        seqIdx.current++
        schedule()
      }, playing ? 4000 + Math.random() * 2000 : 8000 + Math.random() * 4000)
    }
    schedule()
    return () => { if (exprTimer.current) clearTimeout(exprTimer.current) }
  }, [motionFull, playing, expression])

  // 微动作引擎（借鉴 BoopFace MIT 的灵动感算法，独立 RAF 实现）：
  // 随机化眨眼 + 随机游移注视 + 情绪过冲回弹，直接写 SVG DOM 不走 React 重渲染。
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const eyes = svg.querySelectorAll<SVGGElement>('.eye')
    if (eyes.length < 2) return
    if (!motionFull) {
      eyes.forEach((e) => { e.style.transform = '' })
      return
    }

    const rand = (a: number, b: number) => a + Math.random() * (b - a)
    const now0 = performance.now()
    const s = {
      blinkNext: now0 + rand(1800, 3600),
      blinkAnim: null as null | { start: number; dur: number },
      blinkV: 1,
      wanderX: 0, wanderY: 0,
      wanderTargetX: 0, wanderTargetY: 0,
      wanderNext: now0 + rand(1150, 3050),
      bob: 0, bobStart: 0,
      last: now0,
    }

    let raf = 0
    const tick = (now: number) => {
      const dt = Math.min(66, now - s.last); s.last = now

      // 眨眼：1→0.08→1，时长 150-220ms，间隔 1900-4500ms（闭到 8%）
      if (s.blinkAnim) {
        const t = Math.min(1, (now - s.blinkAnim.start) / s.blinkAnim.dur)
        s.blinkV = t < 0.5 ? 1 - 0.92 * (t * 2) : 0.08 + 0.92 * ((t - 0.5) * 2)
        if (t >= 1) {
          s.blinkAnim = null; s.blinkV = 1
          s.blinkNext = now + rand(1900, playing ? 3200 : 4500)
        }
      } else if (now >= s.blinkNext) {
        s.blinkAnim = { start: now, dur: rand(150, 220) }
      }

      // 游移注视：随机目标 + lerp 平滑（幅度 ±1.5-3px / ±0.8-2px）
      if (now >= s.wanderNext) {
        s.wanderTargetX = rand(-3, 3)
        s.wanderTargetY = rand(-2, 2)
        s.wanderNext = now + rand(1150, 3050)
      }
      const k = 1 - Math.pow(1 - 0.16, dt / 16.67)
      s.wanderX += (s.wanderTargetX - s.wanderX) * k
      s.wanderY += (s.wanderTargetY - s.wanderY) * k

      // 情绪切换过冲回弹：settle = 1 - e^(-5.2t)·cos(8.6t)
      const bobT = (now - s.bobStart) / 620
      s.bob = bobT >= 0 && bobT < 1 ? (1 - Math.exp(-5.2 * bobT) * Math.cos(8.6 * bobT)) * 2.5 : 0

      // 应用到两只眼：游移 + bob 用 translate，眨眼用以眼中心为原点的 scaleY
      eyes.forEach((g, i) => {
        const ex = i === 0 ? BASE_X_L : BASE_X_R
        const cy = BASE_Y + 9 // 眼球垂直中心
        const sy = Math.max(0.08, s.blinkV)
        g.style.transformBox = 'view-box'
        g.style.transform = `translate(${s.wanderX.toFixed(2)}px, ${(s.wanderY + s.bob).toFixed(2)}px) translate(${ex + 8}px, ${cy}px) scale(1, ${sy.toFixed(3)}) translate(${-ex - 8}px, ${-cy}px)`
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    // 表情切换时触发一次过冲（对惊讶/愤怒等强化"劲"）
    const onExpr = () => { s.bobStart = performance.now() }
    window.addEventListener('island-expression-change', onExpr)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('island-expression-change', onExpr)
      eyes.forEach((e) => { e.style.transform = '' })
    }
  }, [motionFull, playing])

  // 表情切换广播（给微动作引擎的过冲用）
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('island-expression-change'))
  }, [autoExpr, expression])

  const mask = 'var(--color-bg-primary)'
  const ink = 'var(--color-text-primary)'

  return (
    <svg ref={svgRef} className="island-eyes" viewBox={`0 0 ${VB_W} ${VB_H}`} width={68} height={42} aria-hidden="true">
      <Eye p={face.left} x={BASE_X_L} mask={mask} ink={ink} />
      <Eye p={face.right} x={BASE_X_R} mask={mask} ink={ink} />
    </svg>
  )
}
