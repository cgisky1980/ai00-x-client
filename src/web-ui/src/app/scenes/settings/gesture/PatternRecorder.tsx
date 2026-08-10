import React, { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface PatternRecorderProps {
  initialName: string
  initialSequence?: number[]
  onSave: (sequence: number[], name: string) => void
  onCancel: () => void
}

const DOT_RADIUS = 16
const DOT_RADIUS_SELECTED = 20
const GRID_SPACING = 90
const GRID_SIZE = 3
const VIEWBOX_SIZE = 340

function computePositions(): Array<{ x: number; y: number }> {
  const half = (GRID_SIZE - 1) * GRID_SPACING / 2
  const center = VIEWBOX_SIZE / 2
  const positions: Array<{ x: number; y: number }> = []
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      positions.push({
        x: center - half + col * GRID_SPACING,
        y: center - half + row * GRID_SPACING,
      })
    }
  }
  return positions
}

const PatternRecorder: React.FC<PatternRecorderProps> = ({ initialName, initialSequence, onSave, onCancel }) => {
  const { t } = useTranslation('settings')
  const [selected, setSelected] = useState<number[]>(initialSequence ?? [])
  const [recording, setRecording] = useState(false)
  const [name, setName] = useState(initialName)
  const svgRef = useRef<SVGSVGElement>(null)

  const positions = computePositions()

  const clientToViewBox = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const svgPt = pt.matrixTransform(ctm.inverse())
    return { x: svgPt.x, y: svgPt.y }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const local = clientToViewBox(e.clientX, e.clientY)
    if (!local) return

    for (let i = 0; i < positions.length; i++) {
      const dx = local.x - positions[i].x
      const dy = local.y - positions[i].y
      if (Math.sqrt(dx * dx + dy * dy) < DOT_RADIUS + 10) {
        setRecording(true)
        setSelected((prev) => {
          if (prev.includes(i)) return prev
          return [...prev, i]
        })
        return
      }
    }
  }, [clientToViewBox, positions])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!recording) return
    const local = clientToViewBox(e.clientX, e.clientY)
    if (!local) return

    for (let i = 0; i < positions.length; i++) {
      const dx = local.x - positions[i].x
      const dy = local.y - positions[i].y
      if (Math.sqrt(dx * dx + dy * dy) < DOT_RADIUS + 10) {
        setSelected((prev) => {
          if (prev.includes(i)) return prev
          return [...prev, i]
        })
        return
      }
    }
  }, [recording, clientToViewBox, positions])

  const handleMouseUp = useCallback(() => {
    setRecording(false)
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setSelected((prev) => prev.slice(0, -1))
  }, [])

  const handleClear = useCallback(() => {
    setSelected([])
    setRecording(false)
  }, [])

  const handleSave = useCallback(() => {
    if (selected.length < 2) return
    const trimmed = name.trim()
    onSave(selected, trimmed || initialName)
  }, [selected, name, initialName, onSave])

  return (
    <div className="gesture-recorder">
      <div className="gesture-recorder__backdrop" onClick={onCancel} />
      <div className="gesture-recorder__panel">
        <div className="gesture-recorder__title">{t('configCenter.gesture.recordPattern')}</div>

        <div
          className="gesture-recorder__canvas-wrapper"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onContextMenu={handleContextMenu}
        >
          <svg ref={svgRef} className="gesture-recorder__canvas" viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}>
            {selected.length >= 2 &&
              selected.slice(0, -1).map((dotIdx, i) => {
                const from = positions[dotIdx]
                const to = positions[selected[i + 1]]
                if (!from || !to) return null
                return (
                  <line
                    key={`line-${i}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke="var(--color-primary)"
                    strokeWidth={4}
                    strokeLinecap="round"
                    opacity={0.7}
                  />
                )
              })}

            {positions.map((pos, idx) => {
              const isSelected = selected.includes(idx)
              const order = selected.indexOf(idx)
              const r = isSelected ? DOT_RADIUS_SELECTED : DOT_RADIUS
              return (
                <g key={`dot-${idx}`}>
                  {isSelected && (
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={r + 6}
                      fill="var(--color-primary)"
                      opacity={0.15}
                    />
                  )}
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={r}
                    fill={isSelected ? 'var(--color-primary)' : 'var(--color-bg-secondary)'}
                    stroke={isSelected ? 'var(--color-primary)' : 'var(--color-border)'}
                    strokeWidth={2}
                  />
                  {isSelected && order >= 0 && (
                    <text
                      x={pos.x}
                      y={pos.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="#fff"
                      fontSize="14"
                      fontWeight="bold"
                    >
                      {order + 1}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>

        <p className={`gesture-recorder__hint${selected.length > 0 && selected.length < 2 ? ' gesture-recorder__hint--warning' : ''}`}>
          {recording
            ? t('configCenter.gesture.recording')
            : selected.length > 0 && selected.length < 2
              ? t('configCenter.gesture.minTwoPointsHint')
              : t('configCenter.gesture.drawPatternHint')}
        </p>

        <div className="gesture-recorder__name-row">
          <label className="gesture-recorder__name-label">{t('configCenter.gesture.enterName')}</label>
          <input
            className="gesture-recorder__name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={initialName}
          />
        </div>

        <div className="gesture-recorder__actions">
          <button className="gesture-recorder__btn gesture-recorder__btn--secondary" onClick={handleClear}>
            {t('configCenter.gesture.retry')}
          </button>
          <button className="gesture-recorder__btn gesture-recorder__btn--secondary" onClick={onCancel}>
            {t('configCenter.gesture.cancel')}
          </button>
          <button
            className="gesture-recorder__btn gesture-recorder__btn--primary"
            onClick={handleSave}
            disabled={selected.length < 2}
          >
            {t('configCenter.gesture.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default PatternRecorder