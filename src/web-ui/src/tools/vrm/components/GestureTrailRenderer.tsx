import React, { useEffect, useRef } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ELEMENT_PALETTES } from '../systems/gestureEffects'
import { useI18n } from '@/infrastructure/i18n'

interface GestureTrailEvent {
  points: [number, number][]
  gesture_type: string
}

interface GestureTrailPointEvent {
  x: number
  y: number
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  hue: number
  saturation: number
  lightness: number
  size: number
  life: number
  maxLife: number
}

interface TrailOverlay {
  id: number
  points: { x: number; y: number }[]
  gestureType: string
  hue: number
  saturation: number
  lightness: number
  createdAt: number
}

const GESTURE_COLORS: Record<string, { hue: number; saturation: number; lightness: number }> = {
  vrm_show: { hue: 120, saturation: 80, lightness: 60 },
  vrm_hide: { hue: 0, saturation: 80, lightness: 60 },
  circle: { hue: 270, saturation: 80, lightness: 70 },
}

function getGestureColor(gestureType: string) {
  if (GESTURE_COLORS[gestureType]) return GESTURE_COLORS[gestureType]
  const palette = ELEMENT_PALETTES[Math.floor(Math.random() * ELEMENT_PALETTES.length)]
  return palette.colors[0]
}

let trailIdCounter = 0

export const GestureTrailRenderer: React.FC = () => {
  const { t } = useI18n('vrm')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlesRef = useRef<Particle[]>([])
  const livePointsRef = useRef<{ x: number; y: number }[]>([])
  const isActiveRef = useRef(false)
  const liveFadeStartRef = useRef<number>(0)
  const paletteRef = useRef(ELEMENT_PALETTES[Math.floor(Math.random() * ELEMENT_PALETTES.length)])
  const overlaysRef = useRef<TrailOverlay[]>([])
  const animFrameRef = useRef<number>(0)
  const tRef = useRef(t)
  tRef.current = t

  // Cache toLocal conversion to avoid async overhead per point
  const lastWinInfoRef = useRef<{ posX: number; posY: number; scale: number; updatedAt: number }>({ posX: 0, posY: 0, scale: 1, updatedAt: 0 })

  const toLocalSync = (screenX: number, screenY: number) => {
    const info = lastWinInfoRef.current
    return {
      x: (screenX - info.posX) / info.scale,
      y: (screenY - info.posY) / info.scale,
    }
  }

  // Update window position/scale cache periodically
  const refreshWinInfo = async () => {
    try {
      const win = getCurrentWindow()
      const position = await win.innerPosition()
      const scale = await win.scaleFactor()
      lastWinInfoRef.current = {
        posX: position.x,
        posY: position.y,
        scale,
        updatedAt: Date.now(),
      }
    } catch {
      // ignore
    }
  }

  const spawnParticles = (x: number, y: number, count: number) => {
    const palette = paletteRef.current
    for (let i = 0; i < count; i++) {
      const colorIdx = Math.floor(Math.random() * palette.colors.length)
      const c = palette.colors[colorIdx]
      const angle = Math.random() * Math.PI * 2
      const speed = 0.5 + Math.random() * 2.5
      const life = 25 + Math.random() * 35
      particlesRef.current.push({
        x: x + (Math.random() - 0.5) * 6,
        y: y + (Math.random() - 0.5) * 6,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.5,
        hue: c.hue + (Math.random() - 0.5) * 25,
        saturation: c.saturation,
        lightness: c.lightness + Math.random() * 15,
        size: 2 + Math.random() * 5,
        life,
        maxLife: life,
      })
    }
  }

  // Main animation loop - draws directly to canvas, no React re-render
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = () => {
      const now = Date.now()
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)

      const particles = particlesRef.current
      const livePoints = livePointsRef.current
      const palette = paletteRef.current
      const overlays = overlaysRef.current
      const hasContent = particles.length > 0 || livePoints.length >= 2 || overlays.length > 0

      if (!hasContent) {
        animFrameRef.current = requestAnimationFrame(draw)
        return
      }

      const hue = palette.colors[0].hue
      const sat = palette.colors[0].saturation
      const lit = palette.colors[0].lightness

      // 1. Draw live trail line with glow
      if (livePoints.length >= 2) {
        let liveAlpha = 1
        const fadeStart = liveFadeStartRef.current
        if (fadeStart > 0) {
          const fadeAge = now - fadeStart
          liveAlpha = Math.max(0, 1 - fadeAge / 500)
          if (liveAlpha <= 0) {
            livePointsRef.current = []
            liveFadeStartRef.current = 0
          }
        }

        if (liveAlpha > 0) {
          ctx.save()
          ctx.globalAlpha = liveAlpha
          ctx.beginPath()
          ctx.moveTo(livePoints[0].x, livePoints[0].y)
          for (let i = 1; i < livePoints.length; i++) {
            ctx.lineTo(livePoints[i].x, livePoints[i].y)
          }
          // Outer glow
          ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${lit}%, 0.25)`
          ctx.lineWidth = 10
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          ctx.shadowColor = `hsl(${hue}, ${sat}%, ${lit}%)`
          ctx.shadowBlur = 25
          ctx.stroke()

          // Core line
          ctx.beginPath()
          ctx.moveTo(livePoints[0].x, livePoints[0].y)
          for (let i = 1; i < livePoints.length; i++) {
            ctx.lineTo(livePoints[i].x, livePoints[i].y)
          }
          ctx.strokeStyle = `hsl(${hue}, ${sat}%, ${Math.min(100, lit + 25)}%)`
          ctx.lineWidth = 2.5
          ctx.shadowBlur = 12
          ctx.stroke()
          ctx.restore()
        }
      }

      // 2. Draw and update particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        p.x += p.vx
        p.y += p.vy
        p.vy += 0.04
        p.vx *= 0.97
        p.vy *= 0.97
        p.life -= 1

        if (p.life <= 0) {
          particles.splice(i, 1)
          continue
        }

        const alpha = p.life / p.maxLife
        const size = p.size * alpha
        if (size < 0.3) continue

        // Glow
        ctx.beginPath()
        ctx.arc(p.x, p.y, size * 2.5, 0, Math.PI * 2)
        ctx.fillStyle = `hsla(${p.hue}, ${p.saturation}%, ${p.lightness}%, ${alpha * 0.2})`
        ctx.fill()

        // Core
        ctx.beginPath()
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2)
        ctx.fillStyle = `hsla(${p.hue}, ${p.saturation}%, ${Math.min(100, p.lightness + 25)}%, ${alpha * 0.85})`
        ctx.fill()
      }

      // 3. Draw overlay trails (after gesture recognized)
      for (let oi = overlays.length - 1; oi >= 0; oi--) {
        const trail = overlays[oi]
        const age = now - trail.createdAt
        if (age > 800) {
          overlays.splice(oi, 1)
          continue
        }
        const fadeAlpha = 1 - age / 800
        const { points, hue: th, saturation: ts, lightness: tl, gestureType } = trail

        if (points.length < 2) continue

        ctx.save()
        ctx.globalAlpha = fadeAlpha

        // Glow line
        ctx.beginPath()
        ctx.moveTo(points[0].x, points[0].y)
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y)
        }
        ctx.strokeStyle = `hsl(${th}, ${ts}%, ${tl}%)`
        ctx.lineWidth = 4
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.shadowColor = `hsl(${th}, ${ts}%, ${tl}%)`
        ctx.shadowBlur = 15
        ctx.stroke()

        // Core line
        ctx.beginPath()
        ctx.moveTo(points[0].x, points[0].y)
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y)
        }
        ctx.strokeStyle = `hsl(${th}, ${Math.max(0, ts - 20)}%, ${Math.min(100, tl + 30)}%)`
        ctx.lineWidth = 1.5
        ctx.shadowBlur = 0
        ctx.stroke()

        // End dot
        const last = points[points.length - 1]
        ctx.beginPath()
        ctx.arc(last.x, last.y, 6, 0, Math.PI * 2)
        ctx.fillStyle = `hsl(${th}, ${ts}%, ${tl}%)`
        ctx.shadowColor = `hsl(${th}, ${ts}%, ${tl}%)`
        ctx.shadowBlur = 10
        ctx.fill()

        // Label
        ctx.shadowBlur = 0
        ctx.font = 'bold 12px sans-serif'
        ctx.fillStyle = `hsl(${th}, ${ts}%, ${tl}%)`
        const label = gestureType === 'vrm_show' ? tRef.current('gestureTrail.vrmShow') : gestureType === 'vrm_hide' ? tRef.current('gestureTrail.vrmHide') : gestureType === 'circle' ? tRef.current('gestureTrail.seal') : ''
        if (label) {
          ctx.fillText(label, last.x + 14, last.y - 6)
        }

        ctx.restore()
      }

      animFrameRef.current = requestAnimationFrame(draw)
    }

    animFrameRef.current = requestAnimationFrame(draw)

    return () => {
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(animFrameRef.current)
    }
  }, [])

  // Event listeners
  useEffect(() => {
    let unlistenStart: UnlistenFn | null = null
    let unlistenActivated: UnlistenFn | null = null
    let unlistenPoint: UnlistenFn | null = null
    let unlistenTrail: UnlistenFn | null = null
    let alive = true

    const setup = async () => {
      // Pre-warm window info cache
      await refreshWinInfo()

      // Trail start: reset live points, pick new palette
      unlistenStart = await listen('gesture_trail_start', () => {
        if (!alive) return
        livePointsRef.current = []
        liveFadeStartRef.current = 0
        isActiveRef.current = true
        paletteRef.current = ELEMENT_PALETTES[Math.floor(Math.random() * ELEMENT_PALETTES.length)]
        refreshWinInfo()
      })

      // When PatternGrid is activated (e.g. by circle gesture), clear all trail effects
      unlistenActivated = await listen('pattern_activated', () => {
        if (!alive) return
        particlesRef.current = []
        livePointsRef.current = []
        liveFadeStartRef.current = 0
        isActiveRef.current = false
      })

      // Real-time trail point: add to live trail and spawn particles
      unlistenPoint = await listen<GestureTrailPointEvent>('gesture_trail_point', (event) => {
        if (!alive) return
        const local = toLocalSync(event.payload.x, event.payload.y)
        livePointsRef.current.push(local)
        if (livePointsRef.current.length > 300) {
          livePointsRef.current = livePointsRef.current.slice(-300)
        }
        spawnParticles(local.x, local.y, 3 + Math.floor(Math.random() * 3))
      })

      // Final trail (after gesture recognized)
      unlistenTrail = await listen<GestureTrailEvent>('gesture_trail', async (event) => {
        if (!alive) return
        isActiveRef.current = false
        // Start fading the live trail
        liveFadeStartRef.current = Date.now()

        const { points, gesture_type } = event.payload
        // For circle gestures, clear all particles immediately (PatternGrid is shown instead)
        if (gesture_type === 'circle') {
          particlesRef.current = []
          livePointsRef.current = []
          liveFadeStartRef.current = 0
          return
        }
        if (points.length < 2) return

        await refreshWinInfo()
        const color = getGestureColor(gesture_type)
        const localPoints = points.map(([x, y]: [number, number]) => toLocalSync(x, y))

        const id = ++trailIdCounter
        overlaysRef.current.push({
          id,
          points: localPoints,
          gestureType: gesture_type,
          ...color,
          createdAt: Date.now(),
        })

        // Burst particles at the end
        const lastPt = localPoints[localPoints.length - 1]
        for (let i = 0; i < 25; i++) {
          spawnParticles(lastPt.x, lastPt.y, 1)
        }
      })
    }

    setup()
    return () => {
      alive = false
      if (unlistenStart) unlistenStart()
      if (unlistenActivated) unlistenActivated()
      if (unlistenPoint) unlistenPoint()
      if (unlistenTrail) unlistenTrail()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 90003,
      }}
    />
  )
}
