import React from 'react'
import { useInteractionStore } from '../store/interactionStore'

function ClickEffectText({ text }: { text: string }) {
  const plusIndex = text.indexOf(' + ')
  if (plusIndex === -1) return <>{text}</>
  const word = text.slice(0, plusIndex)
  const suffix = text.slice(plusIndex) // " + 42"
  return <>{word}<i>{suffix}</i></>
}

export const ClickEffectRenderer: React.FC = () => {
  const clickEffects = useInteractionStore((s) => s.clickEffects)

  if (clickEffects.length === 0) return null

  return (
    <>
      {clickEffects.map((effect) => (
        <div
          key={effect.id}
          className="click-effect"
          style={{
            left: effect.x,
            top: effect.y,
            color: effect.color,
          }}
        >
          <ClickEffectText text={effect.text} />
        </div>
      ))}
    </>
  )
}