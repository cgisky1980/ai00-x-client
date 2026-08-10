import React, { useState, useMemo } from 'react'

interface PatternPreviewProps {
  name: string
  sequence: number[]
  gridSize: number
  size?: number
  showSequenceNumbers?: boolean
}

function computePositions(gridSize: number, size: number): Array<{ x: number; y: number }> {
  const spacing = size / (gridSize + 1)
  const positions: Array<{ x: number; y: number }> = []
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      positions.push({
        x: spacing * (col + 1),
        y: spacing * (row + 1),
      })
    }
  }
  return positions
}

const PatternPreview: React.FC<PatternPreviewProps> = ({ sequence, gridSize, size = 36, showSequenceNumbers = false }) => {
  const [hovered, setHovered] = useState(false)
  const positions = useMemo(() => computePositions(gridSize, size), [gridSize, size])
  const dotR = Math.max(2, size / (gridSize * 4))
  const lineW = Math.max(1, size / 20)

  const previewSize = 120
  const previewPositions = useMemo(() => computePositions(gridSize, previewSize), [gridSize])
  const previewDotR = Math.max(6, previewSize / (gridSize * 4))
  const previewLineW = Math.max(2, previewSize / 20)

  const displaySize = showSequenceNumbers ? previewSize : size
  const displayPositions = showSequenceNumbers ? previewPositions : positions
  const displayDotR = showSequenceNumbers ? previewDotR : dotR
  const displayLineW = showSequenceNumbers ? previewLineW : lineW
  const numFontSize = Math.max(10, displaySize / 12)

  return (
    <span
      className="pattern-preview"
      onMouseEnter={() => !showSequenceNumbers && setHovered(true)}
      onMouseLeave={() => !showSequenceNumbers && setHovered(false)}
    >
      <svg width={displaySize} height={displaySize} viewBox={`0 0 ${displaySize} ${displaySize}`}>
        {sequence.length >= 2 &&
          sequence.slice(0, -1).map((dotIdx, i) => {
            const from = displayPositions[dotIdx]
            const to = displayPositions[sequence[i + 1]]
            if (!from || !to) return null
            return (
              <line
                key={`line-${i}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="var(--color-primary)"
                strokeWidth={displayLineW}
                strokeLinecap="round"
                opacity={0.6}
              />
            )
          })}

        {displayPositions.map((pos, idx) => {
          const isSelected = sequence.includes(idx)
          const r = isSelected ? displayDotR * 1.2 : displayDotR
          return (
            <g key={`dot-${idx}`}>
              <circle
                cx={pos.x}
                cy={pos.y}
                r={r}
                fill={isSelected ? 'var(--color-primary)' : 'rgba(255,255,255,0.15)'}
                stroke={isSelected ? 'var(--color-primary)' : 'rgba(255,255,255,0.25)'}
                strokeWidth={1}
              />
              {showSequenceNumbers && isSelected && (
                <text
                  x={pos.x}
                  y={pos.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#fff"
                  fontSize={numFontSize}
                  fontWeight="bold"
                >
                  {sequence.indexOf(idx) + 1}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {!showSequenceNumbers && hovered && (
        <div className="pattern-preview__tooltip">
          <svg width={previewSize} height={previewSize} viewBox={`0 0 ${previewSize} ${previewSize}`}>
            {sequence.length >= 2 &&
              sequence.slice(0, -1).map((dotIdx, i) => {
                const from = previewPositions[dotIdx]
                const to = previewPositions[sequence[i + 1]]
                if (!from || !to) return null
                return (
                  <line
                    key={`tooltip-line-${i}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke="var(--color-primary)"
                    strokeWidth={previewLineW}
                    strokeLinecap="round"
                    opacity={0.6}
                  />
                )
              })}

            {previewPositions.map((pos, idx) => {
              const isSelected = sequence.includes(idx)
              const r = isSelected ? previewDotR * 1.2 : previewDotR
              return (
                <g key={`tooltip-dot-${idx}`}>
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={r}
                    fill={isSelected ? 'var(--color-primary)' : 'rgba(255,255,255,0.15)'}
                    stroke={isSelected ? 'var(--color-primary)' : 'rgba(255,255,255,0.25)'}
                    strokeWidth={1}
                  />
                  {isSelected && (
                    <text
                      x={pos.x}
                      y={pos.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="#fff"
                      fontSize={Math.max(10, previewSize / 12)}
                      fontWeight="bold"
                    >
                      {sequence.indexOf(idx) + 1}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      )}
    </span>
  )
}

export default PatternPreview