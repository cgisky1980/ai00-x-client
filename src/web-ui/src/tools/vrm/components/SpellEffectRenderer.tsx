import React, { useMemo } from 'react'
import { useInteractionStore } from '../store/interactionStore'

function generateLightningSVG(
  cx: number, cy: number,
  size: number,
  hue: number, sat: number, lit: number,
): string {
  const arms = 5 + Math.floor(Math.random() * 4)
  let paths = ''
  for (let a = 0; a < arms; a++) {
    const angle = (Math.PI * 2 * a) / arms + (Math.random() - 0.5) * 0.5
    const length = size * (0.3 + Math.random() * 0.7)
    const segments = 4 + Math.floor(Math.random() * 4)
    const jitter = size * 0.15
    let d = `M ${cx},${cy}`
    let px = cx
    let py = cy
    for (let s = 1; s <= segments; s++) {
      const t = s / segments
      const targetX = cx + Math.cos(angle) * length * t
      const targetY = cy + Math.sin(angle) * length * t
      const jx = (Math.random() - 0.5) * jitter * 2
      const jy = (Math.random() - 0.5) * jitter * 2
      px = targetX + jx
      py = targetY + jy
      d += ` L ${px},${py}`
    }
    const color = `hsla(${hue + (Math.random() - 0.5) * 20}, ${sat}%, ${lit + Math.random() * 20}%, ${0.6 + Math.random() * 0.4})`
    paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${1 + Math.random() * 2}" stroke-linecap="round" filter="url(#lightning-blur)"/>`

    if (Math.random() > 0.4) {
      const branchAngle = angle + (Math.random() - 0.5) * 1.2
      const branchLen = length * (0.2 + Math.random() * 0.3)
      const midX = cx + Math.cos(angle) * length * 0.5
      const midY = cy + Math.sin(angle) * length * 0.5
      let bd = `M ${midX},${midY}`
      const bSegs = 2 + Math.floor(Math.random() * 2)
      for (let bs = 1; bs <= bSegs; bs++) {
        const bt = bs / bSegs
        bd += ` L ${midX + Math.cos(branchAngle) * branchLen * bt + (Math.random() - 0.5) * jitter}, ${midY + Math.sin(branchAngle) * branchLen * bt + (Math.random() - 0.5) * jitter}`
      }
      const bColor = `hsla(${hue}, ${sat}%, ${lit + 20}%, ${0.3 + Math.random() * 0.3})`
      paths += `<path d="${bd}" fill="none" stroke="${bColor}" stroke-width="0.8" stroke-linecap="round" filter="url(#lightning-blur)"/>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 3}" height="${size * 3}" viewBox="0 0 ${size * 3} ${size * 3}"><defs><filter id="lightning-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${paths}</svg>`
}

export const SpellEffectRenderer: React.FC = () => {
  const spellEffects = useInteractionStore((s) => s.spellEffects)

  const lightningEffects = useMemo(() => {
    return spellEffects
      .filter((e) => e.type === 'lightning')
      .map((e) => ({
        ...e,
        svg: generateLightningSVG(e.x, e.y, e.size, e.hue, e.saturation, e.lightness),
      }))
  }, [spellEffects])

  if (spellEffects.length === 0) return null

  return (
    <>
      {spellEffects.map((effect) => {
        if (effect.type === 'lightning') {
          const lightning = lightningEffects.find((l) => l.id === effect.id)
          if (!lightning) return null
          return (
            <div
              key={effect.id}
              className="spell-effect spell-effect-lightning"
              style={{
                left: effect.x,
                top: effect.y,
                width: effect.size * 3,
                height: effect.size * 3,
              }}
              dangerouslySetInnerHTML={{ __html: lightning.svg }}
            />
          )
        }

        const color = `hsl(${effect.hue}, ${effect.saturation}%, ${effect.lightness}%)`
        const glowColor = `hsla(${effect.hue}, ${effect.saturation}%, ${effect.lightness}%, 0.4)`
        const className = `spell-effect spell-effect-${effect.type}`

        if (effect.type === 'ring' || effect.type === 'triangle') {
          return (
            <div
              key={effect.id}
              className={className}
              style={{
                left: effect.x,
                top: effect.y,
                width: effect.size,
                height: effect.size,
                color,
                borderColor: color,
                boxShadow: `0 0 ${effect.size * 0.3}px ${glowColor}, inset 0 0 ${effect.size * 0.15}px ${glowColor}`,
                ...(effect.type === 'ring'
                  ? { border: `2px solid ${color}` }
                  : {}),
              }}
            />
          )
        }

        if (effect.type === 'spark') {
          return (
            <div
              key={effect.id}
              className={className}
              style={{
                left: effect.x,
                top: effect.y,
                width: effect.size,
                height: effect.size,
                background: `radial-gradient(circle, ${color} 0%, ${glowColor} 40%, transparent 70%)`,
              }}
            />
          )
        }

        return (
          <div
            key={effect.id}
            className={className}
            style={{
              left: effect.x,
              top: effect.y,
              width: effect.size,
              height: effect.size,
              background: `radial-gradient(circle, ${color} 0%, ${glowColor} 50%, transparent 70%)`,
              boxShadow: `0 0 ${effect.size * 0.5}px ${glowColor}`,
            }}
          />
        )
      })}
    </>
  )
}