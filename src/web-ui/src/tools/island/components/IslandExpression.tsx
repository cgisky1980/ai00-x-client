import React, { useEffect, useRef, useState, useCallback } from 'react'
import './IslandExpression.scss'

/**
 * 灵动岛左侧的表情挂件（素材来自岛仔 Daozai，MIT；见 public/pet/expressions/ATTRIBUTION.md）。
 *
 * 序列图 144×1440 = 16 帧竖排（每帧 144×90，3 倍密度）。用 background-position
 * 逐帧切换，按岛仔的非均匀时长表推进；播完停在图 7（睁眼常态）。
 * 状态驱动：播放/切歌→开心，hover→好奇，待机→低频轮播；减动效时只显静态帧。
 */

type ExprName =
  | 'wink' | 'smug' | 'blush' | 'delighted' | 'sideGlance' | 'praised'
  | 'heart' | 'giggle' | 'shyPeek' | 'scan' | 'peek' | 'search'

interface ExprDef {
  name: ExprName
  file: string
  times: number[] // 16 帧时长（秒）
}

const SHORT: number[] = [0.35, 0.12, 0.12, 0.12, 0.13, 0.13, 0.14, 0.40, 0.18, 0.14, 0.12, 0.12, 0.12, 0.14, 0.14, 0.45]
const LONG: number[] = [0.35, 0.13, 0.15, 0.18, 0.35, 0.28, 0.16, 0.11, 0.11, 0.16, 0.35, 0.28, 0.16, 0.14, 0.20, 0.35]

const EXPRS: ExprDef[] = [
  { name: 'wink', file: '00-wink.png', times: SHORT },
  { name: 'smug', file: '01-smug.png', times: SHORT },
  { name: 'blush', file: '02-blush.png', times: SHORT },
  { name: 'delighted', file: '03-delighted.png', times: SHORT },
  { name: 'sideGlance', file: '04-side-glance.png', times: SHORT },
  { name: 'praised', file: '05-praised.png', times: SHORT },
  { name: 'heart', file: '06-heart.png', times: SHORT },
  { name: 'giggle', file: '07-giggle.png', times: SHORT },
  { name: 'shyPeek', file: '08-shy-peek.png', times: SHORT },
  { name: 'scan', file: '09-scan.png', times: LONG },
  { name: 'peek', file: '10-peek.png', times: LONG },
  { name: 'search', file: '11-search.png', times: LONG },
]
const BY_NAME = new Map(EXPRS.map((e) => [e.name, e]))

const POOLS = {
  happy: ['praised', 'smug', 'delighted', 'giggle'] as ExprName[],
  curious: ['wink', 'blush', 'sideGlance', 'shyPeek'] as ExprName[],
  idle: ['scan', 'delighted', 'peek', 'smug', 'search', 'giggle', 'praised', 'shyPeek'] as ExprName[],
}

interface IslandExpressionProps {
  /** 播放状态变化计数（上层在 play/pause/切歌时 +1） */
  playPulse: number
  /** 岛是否被 hover */
  hovered: boolean
}

export const IslandExpression: React.FC<IslandExpressionProps> = ({ playPulse, hovered }) => {
  const [current, setCurrent] = useState<ExprDef | null>(null)
  const [frame, setFrame] = useState(7)
  const rafRef = useRef<number | null>(null)
  const poolIdx = useRef({ happy: 0, curious: 0, idle: 0 })
  const cooldownUntil = useRef(0)
  const [reduced, setReduced] = useState(false)

  // 减动效：显式 data-motion=full 优先（同岛主逻辑）
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const resolve = () => {
      const attr = document.documentElement.dataset.motion
      return attr === 'reduced' || (attr !== 'full' && mq.matches)
    }
    setReduced(resolve())
    mq.addEventListener('change', () => setReduced(resolve()))
    const obs = new MutationObserver(() => setReduced(resolve()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })
    return () => obs.disconnect()
  }, [])

  const play = useCallback((name: ExprName, cooldownMs: number) => {
    const def = BY_NAME.get(name)
    if (!def || reduced) return
    if (Date.now() < cooldownUntil.current) return
    cooldownUntil.current = Date.now() + cooldownMs
    setCurrent(def)
    setFrame(0)
    let elapsed = 0
    let last = performance.now()
    const total = def.times.reduce((a, b) => a + b, 0)
    const step = (now: number) => {
      elapsed += (now - last) / 1000
      last = now
      if (elapsed >= total) {
        setFrame(7) // 睁眼常态
        setCurrent(null)
        rafRef.current = null
        return
      }
      let acc = 0
      let idx = 15
      for (let i = 0; i < def.times.length; i++) {
        acc += def.times[i]
        if (elapsed < acc) { idx = i; break }
      }
      setFrame(idx)
      rafRef.current = requestAnimationFrame(step)
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(step)
  }, [reduced])

  // 播放/切歌 → 开心（18s 冷却）
  useEffect(() => {
    if (playPulse > 0) {
      const pool = POOLS.happy
      const i = poolIdx.current.happy++ % pool.length
      play(pool[i], 18000)
    }
  }, [playPulse, play])

  // hover → 好奇（18s 冷却）
  useEffect(() => {
    if (hovered) {
      const pool = POOLS.curious
      const i = poolIdx.current.curious++ % pool.length
      play(pool[i], 18000)
    }
  }, [hovered, play])

  // 待机低频轮播（每 6s 检查，内部 22-31s 安静间隔）
  useEffect(() => {
    const timer = setInterval(() => {
      if (current || reduced || hovered) return
      if (Date.now() < cooldownUntil.current) return
      const pool = POOLS.idle
      const i = poolIdx.current.idle++ % pool.length
      play(pool[i], 22000 + (i % 4) * 3000)
    }, 6000)
    return () => clearInterval(timer)
  }, [current, reduced, hovered, play])

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
  }, [])

  const style: React.CSSProperties = current
    ? {
        backgroundImage: `url(/pet/expressions/${current.file})`,
        backgroundPositionY: `${(frame / 15) * 100}%`,
      }
    : {
        // 静态常态：用 wink 的第 7 帧（睁眼）
        backgroundImage: 'url(/pet/expressions/00-wink.png)',
        backgroundPositionY: `${(7 / 15) * 100}%`,
      }

  return <div className="island-expression" style={style} aria-hidden="true" />
}
