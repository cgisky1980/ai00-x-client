import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react'
import type { ElementPalette } from '../types'
import type { MatchAction } from '../hooks/usePatternGrid'
import { playDotSelectSound, playDotRejectSound } from '../systems/audioEffects'
import { invoke } from '@tauri-apps/api/core'

/** Mini pattern preview SVG for quick-action hints */
function MiniPatternPreview({ sequence, gridSize, hue, sat, lit }: {
  sequence: number[]
  gridSize: number
  hue: number
  sat: number
  lit: number
}) {
  const size = 22
  const spacing = size / (gridSize + 1)
  const dotR = Math.max(1.5, size / (gridSize * 5))
  const lineW = Math.max(0.8, size / 24)

  const positions = useMemo(() => {
    const pos: Array<{ x: number; y: number }> = []
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        pos.push({ x: spacing * (col + 1), y: spacing * (row + 1) })
      }
    }
    return pos
  }, [gridSize, spacing])

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      {sequence.length >= 2 && sequence.slice(0, -1).map((dotIdx, i) => {
        const from = positions[dotIdx]
        const to = positions[sequence[i + 1]]
        if (!from || !to) return null
        return (
          <line
            key={`ml-${i}`}
            x1={from.x} y1={from.y} x2={to.x} y2={to.y}
            stroke={`hsla(${hue}, ${sat}%, ${lit + 30}%, 0.7)`}
            strokeWidth={lineW}
            strokeLinecap="round"
          />
        )
      })}
      {positions.map((pos, idx) => {
        const isSelected = sequence.includes(idx)
        return (
          <circle
            key={`md-${idx}`}
            cx={pos.x} cy={pos.y}
            r={isSelected ? dotR * 1.3 : dotR * 0.7}
            fill={isSelected ? `hsla(${hue}, ${sat}%, ${lit + 40}%, 0.9)` : `hsla(${hue}, ${sat}%, ${lit + 10}%, 0.3)`}
          />
        )
      })}
    </svg>
  )
}

interface PatternGridProps {
  visible: boolean
  centerX: number
  centerY: number
  gridSize: number
  gridSpacing: number
  onGridSpacingChange: (spacing: number) => void
  selectedDots: number[]
  palette: ElementPalette | null
  matchingActions: MatchAction[]
  onDotSelect: (index: number) => void
  onUndo: () => void
  onConfirm: () => void
  onQuickAction: (index: number) => void
}

const DOT_RADIUS = 8
const DOT_RADIUS_SELECTED = 12
const LINE_WIDTH = 4
const GLOW_WIDTH = 14
const PADDING = 70
const SNAP_RADIUS_RATIO = 0.45
const BG_SCALE = 1.6

function computeLocalDotPositions(
  gridSize: number,
  gridSpacing: number,
): Array<{ x: number; y: number }> {
  const positions: Array<{ x: number; y: number }> = []
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      positions.push({
        x: PADDING + col * gridSpacing,
        y: PADDING + row * gridSpacing,
      })
    }
  }
  return positions
}

function runeSymbols(): string[] {
  return ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥']
}

function generateLightningPath(
  x1: number, y1: number,
  x2: number, y2: number,
  segments: number = 6,
  jitter: number = 12,
): string {
  const points: Array<{ x: number; y: number }> = [{ x: x1, y: y1 }]
  for (let i = 1; i < segments; i++) {
    const t = i / segments
    points.push({
      x: x1 + (x2 - x1) * t + (Math.random() - 0.5) * jitter * 2,
      y: y1 + (y2 - y1) * t + (Math.random() - 0.5) * jitter * 2,
    })
  }
  points.push({ x: x2, y: y2 })
  return 'M ' + points.map((p) => `${p.x},${p.y}`).join(' L ')
}

export const PatternGrid: React.FC<PatternGridProps> = ({
  visible,
  centerX,
  centerY,
  gridSize,
  gridSpacing,
  onGridSpacingChange,
  selectedDots,
  palette,
  matchingActions,
  onDotSelect,
  onUndo,
  onConfirm,
  onQuickAction,
}) => {
  const localDotPositions = useMemo(
    () => computeLocalDotPositions(gridSize, gridSpacing),
    [gridSize, gridSpacing],
  )

  const primaryColor = palette?.colors[0]
  const hue = primaryColor?.hue ?? 200
  const sat = primaryColor?.saturation ?? 80
  const lit = Math.max(primaryColor?.lightness ?? 60, 60)

  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null)
  const [executing, setExecuting] = useState(false)
  const [autoConnectExtra, setAutoConnectExtra] = useState<number[]>([])
  const autoConnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const executingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoConnectStepRef = useRef(0)
  const prevDotCountRef = useRef(0)

  const animSelectedDots = useMemo(() => {
    if (autoConnectExtra.length === 0) return selectedDots
    return [...selectedDots, ...autoConnectExtra]
  }, [selectedDots, autoConnectExtra])
  const [snappedDot, setSnappedDot] = useState<number | null>(null)
  const [lightningKey, setLightningKey] = useState(0)
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null)

  const svgSize = (gridSize - 1) * gridSpacing + PADDING * 2
  const snapRadius = gridSpacing * SNAP_RADIUS_RATIO
  const center = svgSize / 2
  const bgSize = svgSize * BG_SCALE
  // Clamp position so the overlay stays within the viewport
  const clampedCenterX = Math.max(bgSize / 2, Math.min(window.innerWidth - bgSize / 2, centerX))
  const clampedCenterY = Math.max(bgSize / 2, Math.min(window.innerHeight - bgSize / 2, centerY))
  const bgLeft = clampedCenterX - bgSize / 2
  const bgTop = clampedCenterY - bgSize / 2
  const clientToLocal = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const svgEl = document.querySelector('.pattern-grid-svg')
      if (!svgEl) return null
      const rect = svgEl.getBoundingClientRect()
      const offset = (bgSize - svgSize) / 2
      return {
        x: ((clientX - rect.left) / rect.width) * bgSize - offset,
        y: ((clientY - rect.top) / rect.height) * bgSize - offset,
      }
    },
    [svgSize, bgSize],
  )

  const findDotAtLocal = useCallback(
    (localX: number, localY: number): number | null => {
      for (let i = 0; i < localDotPositions.length; i++) {
        const dot = localDotPositions[i]
        const dx = localX - dot.x
        const dy = localY - dot.y
        if (dx * dx + dy * dy < snapRadius * snapRadius) {
          return i
        }
      }
      return null
    },
    [localDotPositions, snapRadius],
  )

  const isInsideCircle = useCallback(
    (localX: number, localY: number): boolean => {
      const dx = localX - svgSize / 2
      const dy = localY - svgSize / 2
      return dx * dx + dy * dy <= (svgSize / 2) * (svgSize / 2)
    },
    [svgSize],
  )

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (selectedDots.length > 0) {
      onUndo()
    }
  }, [onUndo, selectedDots])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const local = clientToLocal(e.clientX, e.clientY)
      if (local) {
        mouseDownPosRef.current = { x: local.x, y: local.y }
      }
    },
    [clientToLocal],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const local = clientToLocal(e.clientX, e.clientY)
      if (!local) return
      setCursorPos(local)
      const dotIdx = findDotAtLocal(local.x, local.y)
      setSnappedDot(dotIdx)
    }, [clientToLocal, findDotAtLocal],
  )

  const startExecutingQuickAction = useCallback(
    (index: number) => {
      const match = matchingActions[index]
      if (!match) return
      const remaining = match.sequence.slice(selectedDots.length)
      if (remaining.length > 0) {
        setAutoConnectExtra([])
        autoConnectStepRef.current = 0
        const scheduleNext = () => {
          const step = autoConnectStepRef.current
          if (step >= remaining.length) {
            setTimeout(() => {
              setExecuting(true)
              executingTimerRef.current = setTimeout(() => {
                onQuickAction(index)
              }, 700)
            }, 150)
            return
          }
          autoConnectTimerRef.current = setTimeout(() => {
            autoConnectStepRef.current = step + 1
            setAutoConnectExtra(remaining.slice(0, step + 1))
            scheduleNext()
          }, 150)
        }
        scheduleNext()
        return
      }
      setExecuting(true)
      executingTimerRef.current = setTimeout(() => {
        onQuickAction(index)
      }, 700)
    },
    [matchingActions, selectedDots, onQuickAction],
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || executing) return
      e.preventDefault()
      e.stopPropagation()

      const local = clientToLocal(e.clientX, e.clientY)
      if (!local) return

      const isClick = mouseDownPosRef.current != null
        && Math.abs(local.x - mouseDownPosRef.current.x) < 5
        && Math.abs(local.y - mouseDownPosRef.current.y) < 5
      mouseDownPosRef.current = null

      if (!isClick) return

      if (!isInsideCircle(local.x, local.y)) {
        onConfirm()
        return
      }

      const dotIdx = findDotAtLocal(local.x, local.y)
      if (dotIdx !== null) {
        if (selectedDots.length > 0 && dotIdx === selectedDots[selectedDots.length - 1]) {
          if (matchingActions.length === 1) {
            startExecutingQuickAction(0)
          }
          return
        }
        if (!selectedDots.includes(dotIdx)) {
          onDotSelect(dotIdx)
        }
      }
    },
    [clientToLocal, findDotAtLocal, isInsideCircle, executing, onDotSelect, startExecutingQuickAction, matchingActions, selectedDots, onConfirm],
  )

  const handleMouseLeave = useCallback(() => {
    setCursorPos(null)
    setSnappedDot(null)
    mouseDownPosRef.current = null
  }, [])

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const step = 10
      const minSpacing = 40
      const maxSpacing = 160
      const delta = e.deltaY > 0 ? -step : step
      const newSpacing = Math.max(minSpacing, Math.min(maxSpacing, gridSpacing + delta))
      if (newSpacing !== gridSpacing) {
        onGridSpacingChange(newSpacing)
      }
    },
    [gridSpacing, onGridSpacingChange],
  )

  useEffect(() => {
    if (!visible) {
      setCursorPos(null)
      setSnappedDot(null)
      mouseDownPosRef.current = null
      setExecuting(false)
      setAutoConnectExtra([])
      autoConnectStepRef.current = 0
      prevDotCountRef.current = 0
      if (autoConnectTimerRef.current) clearTimeout(autoConnectTimerRef.current)
      if (executingTimerRef.current) clearTimeout(executingTimerRef.current)
    }
  }, [visible])

  useEffect(() => {
    if (!visible || executing) return
    if (selectedDots.length > prevDotCountRef.current && selectedDots.length > 0) {
      if (matchingActions.length > 0) {
        playDotSelectSound()
      } else {
        playDotRejectSound()
      }
    }
    prevDotCountRef.current = selectedDots.length
  }, [selectedDots.length, visible, executing, matchingActions.length])

  // Play sound when auto-connect adds dots
  const prevExtraCountRef = useRef(0)
  useEffect(() => {
    if (!visible || executing) return
    if (autoConnectExtra.length > prevExtraCountRef.current && autoConnectExtra.length > 0) {
      playDotSelectSound()
    }
    prevExtraCountRef.current = autoConnectExtra.length
  }, [autoConnectExtra.length, visible, executing])

  // Undo last dot if no matching actions after selection
  useEffect(() => {
    if (!visible || executing || selectedDots.length === 0 || matchingActions.length > 0) return
    if (autoConnectExtra.length > 0) return
    const timer = setTimeout(() => {
      onUndo()
    }, 500)
    return () => clearTimeout(timer)
  }, [visible, executing, selectedDots.length, matchingActions.length, autoConnectExtra.length, onUndo])

  useEffect(() => {
    if (!visible || animSelectedDots.length === 0) return
    const interval = setInterval(() => {
      setLightningKey((k) => k + 1)
    }, 80)
    return () => clearInterval(interval)
  }, [visible, animSelectedDots])

  useEffect(() => {
    if (!visible || executing || matchingActions.length === 0) return
    const handleKeyDown = (e: KeyboardEvent) => {
      const num = parseInt(e.key)
      if (num >= 1 && num <= Math.min(matchingActions.length, 4)) {
        e.preventDefault()
        e.stopPropagation()
        startExecutingQuickAction(num - 1)
        return
      }
      if (e.key === 'Enter' && matchingActions.length === 1) {
        e.preventDefault()
        e.stopPropagation()
        startExecutingQuickAction(0)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [visible, executing, matchingActions, startExecutingQuickAction])

  const lastSelectedDotPre =
    animSelectedDots.length > 0 ? localDotPositions[animSelectedDots[animSelectedDots.length - 1]] : null
  const lineStartPre = lastSelectedDotPre || { x: svgSize / 2, y: svgSize / 2 }

  const lightningPaths = useMemo(() => {
    if (animSelectedDots.length < 2) return []
    return animSelectedDots.slice(0, -1).map((dotIdx, i) => {
      const from = localDotPositions[dotIdx]
      const to = localDotPositions[animSelectedDots[i + 1]]
      if (!from || !to) return null
      return {
        main: generateLightningPath(from.x, from.y, to.x, to.y, 8, 10),
        branch: generateLightningPath(from.x, from.y, to.x, to.y, 6, 18),
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animSelectedDots, localDotPositions, lightningKey])

  const previewLightning = useMemo(() => {
    if (!cursorPos || animSelectedDots.length === 0) return null
    return generateLightningPath(lineStartPre.x, lineStartPre.y, cursorPos.x, cursorPos.y, 6, 12)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorPos, lineStartPre.x, lineStartPre.y, lightningKey])

  const quickActionPos = useMemo(() => {
    if (!lastSelectedDotPre || matchingActions.length === 0) return null
    const lastDot = animSelectedDots[animSelectedDots.length - 1]
    if (lastDot === undefined) return null

    const col = lastDot % gridSize
    const row = Math.floor(lastDot / gridSize)
    const gap = 16

    // Left column: panel on left; Right column: panel on right; Middle column: top/bottom
    let side: 'left' | 'right' | 'top' | 'bottom'
    if (col === 0) {
      side = 'left'
    } else if (col === gridSize - 1) {
      side = 'right'
    } else {
      // Middle column: top row -> above, bottom row -> below
      side = row < gridSize / 2 ? 'top' : 'bottom'
    }

    // Calculate anchor position on the circle edge
    const anchorX = bgSize / 2
    const anchorY = bgSize / 2
    const radius = svgSize / 2 + gap

    // Estimate panel size for overflow check
    const panelWidth = 220
    const panelHeight = matchingActions.length * 36 + 8

    // Get overlay position on screen
    const overlayRect = document.querySelector('.pattern-grid-overlay')?.getBoundingClientRect()
    const overlayScreenX = overlayRect?.left ?? 0
    const overlayScreenY = overlayRect?.top ?? 0

    // Check if panel would overflow the viewport and flip side if needed
    const vw = window.innerWidth
    const vh = window.innerHeight

    if (side === 'left') {
      const panelScreenLeft = overlayScreenX + anchorX - radius - panelWidth
      if (panelScreenLeft < 0) side = 'right'
    } else if (side === 'right') {
      const panelScreenRight = overlayScreenX + anchorX + radius + panelWidth
      if (panelScreenRight > vw) side = 'left'
    } else if (side === 'top') {
      const panelScreenTop = overlayScreenY + anchorY - radius - panelHeight
      if (panelScreenTop < 0) side = 'bottom'
    } else {
      const panelScreenBottom = overlayScreenY + anchorY + radius + panelHeight
      if (panelScreenBottom > vh) side = 'top'
    }

    let x: number, y: number
    switch (side) {
      case 'left':
        x = anchorX - radius
        y = anchorY
        break
      case 'right':
        x = anchorX + radius
        y = anchorY
        break
      case 'top':
        x = anchorX
        y = anchorY - radius
        break
      case 'bottom':
        x = anchorX
        y = anchorY + radius
        break
    }

    return { x, y, side }
  }, [animSelectedDots, matchingActions, gridSize, bgSize, svgSize, lastSelectedDotPre])

  if (!visible) return null



  const lastSelectedDot =
    animSelectedDots.length > 0 ? localDotPositions[animSelectedDots[animSelectedDots.length - 1]] : null

  const lineStart = lastSelectedDot || { x: svgSize / 2, y: svgSize / 2 }

  const outerRadius = svgSize / 2 - 6
  const innerRadius1 = svgSize / 2 - 16
  const innerRadius2 = svgSize / 2 - 26
  const runes = runeSymbols()
  const runeRadius = svgSize / 2 - 10
  const runeAngleStep = (2 * Math.PI) / runes.length

  return (
    <div
      className={`pattern-grid-overlay${executing ? ' executing' : ''}`}
      data-no-penetrate="true"
      onContextMenu={handleContextMenu}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onWheel={handleWheel}
      style={{
        position: 'fixed',
        left: bgLeft,
        top: bgTop,
        width: bgSize,
        height: bgSize,
        pointerEvents: executing ? 'none' : 'auto',
        zIndex: 99998,
        cursor: executing ? 'default' : 'crosshair',
      }}
    >
      <div
        className="pattern-grid-circle-bg"
        style={{
          position: 'absolute',
          left: (bgSize - svgSize) / 2,
          top: (bgSize - svgSize) / 2,
          width: svgSize,
          height: svgSize,
          background: `radial-gradient(circle, hsla(${hue}, ${Math.min(sat, 30)}%, 12%, 0.75) 0%, hsla(${hue}, ${Math.min(sat, 25)}%, 8%, 0.65) 60%, hsla(${hue}, ${Math.min(sat, 20)}%, 5%, 0.55) 100%)`,
          backdropFilter: 'blur(12px)',
          borderRadius: '50%',
          border: `1.5px solid hsla(${hue}, ${sat}%, ${lit + 15}%, 0.5)`,
          boxShadow: `0 0 60px hsla(${hue}, ${sat}%, ${lit + 10}%, 0.35), 0 0 120px hsla(${hue}, ${sat}%, ${lit + 10}%, 0.2), inset 0 0 50px hsla(${hue}, ${sat}%, ${lit + 10}%, 0.08)`,
        }}
      />
      <svg
        className="pattern-grid-svg"
        width={bgSize}
        height={bgSize}
        viewBox={`0 0 ${bgSize} ${bgSize}`}
        style={{ position: 'relative', zIndex: 1, overflow: 'visible' }}
      >
        <defs>
          <filter id="glow-filter" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="glow-strong" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="blur" />
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="lightning-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur1" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur2" />
            <feMerge>
              <feMergeNode in="blur1" />
              <feMergeNode in="blur1" />
              <feMergeNode in="blur2" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="contrast-outline" x="-20%" y="-20%" width="140%" height="140%">
            <feMorphology in="SourceGraphic" operator="dilate" radius="1.5" result="dilated" />
            <feFlood floodColor="rgba(0,0,0,0.5)" result="flood" />
            <feComposite in="flood" in2="dilated" operator="in" result="outline" />
            <feGaussianBlur in="outline" stdDeviation="1" result="outlineBlur" />
            <feMerge>
              <feMergeNode in="outlineBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="text-contrast" x="-30%" y="-30%" width="160%" height="160%">
            <feMorphology in="SourceGraphic" operator="dilate" radius="2" result="dilated" />
            <feFlood floodColor="rgba(0,0,0,0.6)" result="flood" />
            <feComposite in="flood" in2="dilated" operator="in" result="outline" />
            <feGaussianBlur in="outline" stdDeviation="1.5" result="outlineBlur" />
            <feMerge>
              <feMergeNode in="outlineBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <mask id="outside-circle-mask">
            <rect x="0" y="0" width={svgSize} height={svgSize} fill="white" />
            <circle cx={center} cy={center} r={outerRadius + 2} fill="black" />
          </mask>
        </defs>

        <g transform={`translate(${(bgSize - svgSize) / 2}, ${(bgSize - svgSize) / 2})`}>
        <g className="magic-circle-bg-triangles executing-bg-group" mask="url(#outside-circle-mask)" style={{ '--magic-center': `${center}px` } as React.CSSProperties}>
          <polygon
            points={
              Array.from({ length: 3 }, (_, i) => {
                const a = (Math.PI * 2 * i) / 3 - Math.PI / 2
                const r = svgSize * 0.48
                return `${center + Math.cos(a) * r},${center + Math.sin(a) * r}`
              }).join(' ')
            }
            fill="none"
            stroke={`hsla(${hue}, ${sat}%, ${lit + 25}%, 0.75)`}
            strokeWidth="2"
            className="bg-triangle-rotate-cw"
            filter="url(#glow-strong), url(#contrast-outline)"
          />
          <polygon
            points={
              Array.from({ length: 3 }, (_, i) => {
                const a = (Math.PI * 2 * i) / 3 + Math.PI / 6
                const r = svgSize * 0.48
                return `${center + Math.cos(a) * r},${center + Math.sin(a) * r}`
              }).join(' ')
            }
            fill="none"
            stroke={`hsla(${hue}, ${sat}%, ${lit + 25}%, 0.75)`}
            strokeWidth="2"
            className="bg-triangle-rotate-ccw"
            filter="url(#glow-strong), url(#contrast-outline)"
          />
        </g>

        <g className="magic-circle-decorations executing-bg-group" opacity="0.5">
          <circle
            cx={center}
            cy={center}
            r={outerRadius}
            fill="none"
            stroke={`hsla(${hue}, ${sat}%, ${lit + 25}%, 0.7)`}
            strokeWidth="1.5"
            strokeDasharray="8 6"
          />
          <circle
            cx={center}
            cy={center}
            r={innerRadius1}
            fill="none"
            stroke={`hsla(${hue}, ${sat}%, ${lit + 20}%, 0.55)`}
            strokeWidth="1"
            strokeDasharray="3 5"
          />
          <circle
            cx={center}
            cy={center}
            r={innerRadius2}
            fill="none"
            stroke={`hsla(${hue}, ${sat}%, ${lit + 20}%, 0.45)`}
            strokeWidth="0.8"
            strokeDasharray="2 8"
          />
          <line
            x1={center}
            y1={PADDING - 20}
            x2={center}
            y2={svgSize - PADDING + 20}
            stroke={`hsla(${hue}, ${sat}%, ${lit + 20}%, 0.35)`}
            strokeWidth="0.5"
          />
          <line
            x1={PADDING - 20}
            y1={center}
            x2={svgSize - PADDING + 20}
            y2={center}
            stroke={`hsla(${hue}, ${sat}%, ${lit + 20}%, 0.35)`}
            strokeWidth="0.5"
          />
          <line
            x1={PADDING - 20}
            y1={PADDING - 20}
            x2={svgSize - PADDING + 20}
            y2={svgSize - PADDING + 20}
            stroke={`hsla(${hue}, ${sat}%, ${lit + 20}%, 0.25)`}
            strokeWidth="0.5"
          />
          <line
            x1={svgSize - PADDING + 20}
            y1={PADDING - 20}
            x2={PADDING - 20}
            y2={svgSize - PADDING + 20}
            stroke={`hsla(${hue}, ${sat}%, ${lit + 20}%, 0.25)`}
            strokeWidth="0.5"
          />
        </g>

        <g className="magic-circle-hexagram-outer executing-bg-group" style={{ '--magic-center': `${center}px` } as React.CSSProperties}>
          <polygon
            points={
              Array.from({ length: 3 }, (_, i) => {
                const a = (Math.PI * 2 * i) / 3 - Math.PI / 2
                return `${center + Math.cos(a) * (outerRadius - 2)},${center + Math.sin(a) * (outerRadius - 2)}`
              }).join(' ')
            }
            fill="none"
            stroke={`hsla(${hue}, ${sat}%, ${lit + 25}%, 0.5)`}
            strokeWidth="1.5"
            className="hexagram-rotate-cw"
            filter="url(#glow-filter), url(#contrast-outline)"
          />
          <polygon
            points={
              Array.from({ length: 3 }, (_, i) => {
                const a = (Math.PI * 2 * i) / 3 + Math.PI / 6
                return `${center + Math.cos(a) * (outerRadius - 2)},${center + Math.sin(a) * (outerRadius - 2)}`
              }).join(' ')
            }
            fill="none"
            stroke={`hsla(${hue}, ${sat}%, ${lit + 25}%, 0.5)`}
            strokeWidth="1.5"
            className="hexagram-rotate-ccw"
            filter="url(#glow-filter), url(#contrast-outline)"
          />
        </g>

        <g className="magic-circle-runes executing-bg-group" style={{ '--magic-center': `${center}px` } as React.CSSProperties}>
          {runes.map((rune, i) => {
            const angle = runeAngleStep * i - Math.PI / 2
            const x = center + Math.cos(angle) * runeRadius
            const y = center + Math.sin(angle) * runeRadius
            return (
              <text
                key={`rune-${i}`}
                x={x}
                y={y}
                fill={`hsla(${hue}, ${sat}%, ${lit + 25}%, 0.65)`}
                fontSize="16"
                textAnchor="middle"
                dominantBaseline="central"
                className="magic-circle-rune-text"
                filter="url(#text-contrast)"
              >
                {rune}
              </text>
            )
          })}
        </g>

        {animSelectedDots.length >= 2 &&
        animSelectedDots.slice(0, -1).map((dotIdx, i) => {
          const from = localDotPositions[dotIdx]
          const to = localDotPositions[animSelectedDots[i + 1]]
          if (!from || !to) return null
          const paths = lightningPaths[i]
          return (
            <g key={`line-${i}`} className="executing-line-group">
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={`hsla(${hue}, ${sat}%, ${lit + 15}%, 0.35)`}
                  strokeWidth={GLOW_WIDTH}
                  strokeLinecap="round"
                  filter="url(#glow-strong)"
                />
                {paths && (
                  <path
                    d={paths.branch}
                    fill="none"
                    stroke={`hsla(${hue}, ${sat}%, ${lit + 30}%, 0.55)`}
                    strokeWidth="1.5"
                    filter="url(#lightning-glow)"
                    className="lightning-branch"
                  />
                )}
                {paths && (
                  <path
                    d={paths.main}
                    fill="none"
                    stroke={`hsla(${hue}, ${sat}%, ${lit + 40}%, 1)`}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    filter="url(#lightning-glow)"
                  />
                )}
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={`hsla(${hue}, ${sat}%, ${lit + 20}%, 0.9)`}
                  strokeWidth={LINE_WIDTH}
                  strokeLinecap="round"
                  strokeDasharray="12 6"
                  className="energy-flow-line"
                  filter="url(#contrast-outline)"
                />
              </g>
            )
          })}

        {cursorPos && animSelectedDots.length > 0 && (
          <g>
            <line
              x1={lineStart.x}
              y1={lineStart.y}
              x2={cursorPos.x}
              y2={cursorPos.y}
              stroke={`hsla(${hue}, ${sat}%, ${lit + 15}%, 0.3)`}
              strokeWidth={GLOW_WIDTH}
              strokeLinecap="round"
              filter="url(#glow-strong)"
            />
            {previewLightning && (
              <path
                d={previewLightning}
                fill="none"
                stroke={`hsla(${hue}, ${sat}%, ${lit + 40}%, 0.85)`}
                strokeWidth="2"
                strokeLinecap="round"
                filter="url(#lightning-glow)"
              />
            )}
            <line
              x1={lineStart.x}
              y1={lineStart.y}
              x2={cursorPos.x}
              y2={cursorPos.y}
              stroke={`hsla(${hue}, ${sat}%, ${lit + 20}%, 0.7)`}
              strokeWidth={LINE_WIDTH}
              strokeLinecap="round"
              strokeDasharray="8 4"
              className="energy-flow-line"
              filter="url(#contrast-outline)"
            />
          </g>
        )}

        {localDotPositions.map((pos, idx) => {
          const isSelected = animSelectedDots.includes(idx)
          const r = isSelected ? DOT_RADIUS_SELECTED : DOT_RADIUS

          return (
            <g key={`dot-${idx}`} className={isSelected ? 'executing-dot-group' : undefined} style={isSelected ? { transformOrigin: `${pos.x}px ${pos.y}px` } : undefined}>
              {isSelected && (
                <>
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={r + 18}
                    fill={`hsla(${hue}, ${sat}%, ${lit + 15}%, 0.18)`}
                    className="dot-pulse-outer"
                  />
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={r + 12}
                    fill="none"
                    stroke={`hsla(${hue}, ${sat}%, ${lit + 15}%, 0.5)`}
                    strokeWidth="1"
                    strokeDasharray="4 4"
                    className="dot-rotate-ring"
                  />
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={r + 7}
                    fill="none"
                    stroke={`hsla(${hue}, ${sat}%, ${lit + 15}%, 0.65)`}
                    strokeWidth="0.8"
                    className="dot-rotate-ring-reverse"
                  />
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={r + 3}
                    fill={`hsla(${hue}, ${sat}%, ${lit + 40}%, 0.4)`}
                    filter="url(#lightning-glow)"
                  />
                </>
              )}
              {!isSelected && (
                <>
                  {snappedDot === idx && (
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={r + 10}
                      fill="none"
                      stroke={`hsla(${hue}, ${sat}%, ${lit + 30}%, 0.6)`}
                      strokeWidth="1.5"
                      strokeDasharray="3 3"
                      className="dot-rotate-ring"
                    />
                  )}
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={r + 5}
                    fill="none"
                    stroke={`hsla(${hue}, ${sat}%, ${lit + 20}%, 0.5)`}
                    strokeWidth="0.8"
                    className="dot-idle-pulse"
                  />
                </>
              )}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={r}
                fill={
                  isSelected
                    ? `hsl(${hue}, ${sat}%, ${lit + 15}%)`
                    : 'none'
                }
                stroke={
                  isSelected
                    ? `hsl(${hue}, ${sat}%, ${lit + 30}%)`
                    : `hsla(${hue}, ${sat}%, ${lit + 20}%, 0.8)`
                }
                strokeWidth={isSelected ? 2 : 1.5}
                filter={isSelected ? 'url(#glow-filter), url(#contrast-outline)' : 'url(#contrast-outline)'}
              />
            </g>
          )
        })}
        </g>
      </svg>
      {selectedDots.length >= 1 && matchingActions.length > 0 && quickActionPos && (
        <div
          className="pattern-grid-quick-actions"
          onMouseDown={(e) => { e.stopPropagation(); invoke('set_vrm_interaction_active', { active: true }).catch(() => {}) }}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={() => { invoke('set_vrm_interaction_active', { active: true }).catch(() => {}) }}
          onMouseLeave={() => { invoke('set_vrm_interaction_active', { active: false }).catch(() => {}) }}
          style={{
            position: 'absolute',
            ...(quickActionPos.side === 'left'
              ? { right: bgSize - quickActionPos.x, top: quickActionPos.y, transform: 'translate(0, -50%)' }
              : quickActionPos.side === 'right'
                ? { left: quickActionPos.x, top: quickActionPos.y, transform: 'translate(0, -50%)' }
                : quickActionPos.side === 'top'
                  ? { left: quickActionPos.x, bottom: bgSize - quickActionPos.y, transform: 'translate(-50%, 0)' }
                  : { left: quickActionPos.x, top: quickActionPos.y, transform: 'translate(-50%, 0)' }
            ),
            pointerEvents: 'auto',
            zIndex: 10,
          }}
        >
          <div
            style={{
              background: `hsla(${hue}, ${sat}%, 6%, 0.93)`,
              backdropFilter: 'blur(10px)',
              borderRadius: 10,
              border: `1px solid hsla(${hue}, ${sat}%, ${lit + 20}%, 0.3)`,
              padding: '4px 0',
              minWidth: 220,
              boxShadow: `0 0 24px hsla(${hue}, ${sat}%, ${lit}%, 0.2), inset 0 0 12px hsla(${hue}, ${sat}%, ${lit + 10}%, 0.05)`,
            }}
          >
            {matchingActions.map((m, i) => (
              <div
                key={m.templateName}
                className="pattern-grid-quick-action-item"
                onClick={(e) => { e.stopPropagation(); startExecutingQuickAction(i) }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 10px',
                  fontSize: 12,
                  color: `hsla(${hue}, ${sat}%, ${lit + 30}%, 0.92)`,
                  cursor: 'pointer',
                  borderRadius: 6,
                  margin: '0 4px',
                  transition: 'background 0.15s, color 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = `hsla(${hue}, ${sat}%, ${lit + 15}%, 0.25)`
                  e.currentTarget.style.color = `hsla(${hue}, 100%, 90%, 1)`
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = `hsla(${hue}, ${sat}%, ${lit + 30}%, 0.92)`
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: `hsla(${hue}, ${sat + 10}%, ${lit + 15}%, 0.3)`,
                    border: `1px solid hsla(${hue}, ${sat}%, ${lit + 30}%, 0.4)`,
                    fontSize: 10,
                    fontWeight: 700,
                    color: `hsla(${hue}, 100%, 88%, 0.95)`,
                    flexShrink: 0,
                  }}
                >
                  {i + 1}
                </span>
                <MiniPatternPreview sequence={m.sequence} gridSize={gridSize} hue={hue} sat={sat} lit={lit} />
                <span style={{ flex: 1, fontWeight: 500 }}>{m.templateName}</span>
                <span
                  style={{
                    fontSize: 10,
                    color: `hsla(${hue}, ${sat}%, ${lit + 15}%, 0.45)`,
                  }}
                >
                  {m.actionLabel}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default PatternGrid