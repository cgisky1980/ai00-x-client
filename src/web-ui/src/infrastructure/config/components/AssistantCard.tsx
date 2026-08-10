import React, { useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Assistant } from '../../../tools/vrm/types'
import './AssistantCard.scss'

type Rarity = 'N' | 'R' | 'SR' | 'SSR'

function computeRarity(assistant: Assistant): Rarity {
  const hasPersona = assistant.persona.identity || assistant.persona.personality
  const hasVrm = !!assistant.appearance.vrm_model
  const hasTts = !!assistant.voice.tts_speaker_id
  if (hasPersona && hasVrm && hasTts) return 'SSR'
  if (hasPersona && hasVrm) return 'SR'
  if (hasPersona) return 'R'
  return 'N'
}

const IDENTITY_ICONS: Record<string, string> = {
  '\u732B\u65CF': '\uD83D\uDC3E',
  '\u72D0\u65CF': '\uD83E\uDD8A',
  '\u7CBE\u7075': '\u2728',
  '\u4EBA\u7C7B': '\uD83D\uDC64',
}

const RARITY_COLORS: Record<Rarity, { primary: string; secondary: string; glow: string }> = {
  N: {
    primary: 'var(--color-text-muted)',
    secondary: 'var(--color-text-disabled)',
    glow: 'oklch(from var(--color-text-muted) l c h / 0.15)',
  },
  R: {
    primary: 'var(--color-accent-400)',
    secondary: 'var(--color-accent-500)',
    glow: 'oklch(from var(--color-accent-400) l c h / 0.2)',
  },
  SR: {
    primary: 'var(--color-accent-300)',
    secondary: 'var(--color-accent-400)',
    glow: 'oklch(from var(--color-accent-300) l c h / 0.25)',
  },
  SSR: {
    primary: 'var(--color-accent-200)',
    secondary: 'var(--color-accent-300)',
    glow: 'oklch(from var(--color-accent-200) l c h / 0.3)',
  },
}

const clamp = (v: number, min = 0, max = 100) => Math.min(Math.max(v, min), max)
const round = (v: number, p = 3) => parseFloat(v.toFixed(p))
const adjust = (v: number, fromMin: number, fromMax: number, toMin: number, toMax: number) =>
  round(toMin + ((toMax - toMin) * (v - fromMin)) / (fromMax - fromMin))
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)

interface AssistantCardProps {
  assistant: Assistant
  isActive: boolean
  onActivate: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  index?: number
}

export const AssistantCard: React.FC<AssistantCardProps> = ({
  assistant,
  isActive,
  onActivate,
  onEdit,
  onDelete,
  index = 0,
}) => {
  const { t } = useTranslation('settings/assistant')
  const rarity = computeRarity(assistant)
  const wrapRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)

  const colors = RARITY_COLORS[rarity]
  const identityIcon = IDENTITY_ICONS[assistant.persona.identity] || '\u2753'

  const cardStyle = useMemo(() => ({
    '--card-index': index,
    '--rarity-primary': colors.primary,
    '--rarity-secondary': colors.secondary,
    '--rarity-glow': colors.glow,
  }), [index, colors])

  const handleClick = useCallback(() => {
    if (!isActive) {
      onActivate(assistant.id)
    }
  }, [isActive, onActivate, assistant.id])

  const handleEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onEdit(assistant.id)
    },
    [onEdit, assistant.id],
  )

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onDelete(assistant.id)
    },
    [onDelete, assistant.id],
  )

  const updateCardTransform = useCallback((offsetX: number, offsetY: number) => {
    const card = cardRef.current
    const wrap = wrapRef.current
    if (!card || !wrap) return

    const width = card.clientWidth
    const height = card.clientHeight
    const percentX = clamp((100 / width) * offsetX)
    const percentY = clamp((100 / height) * offsetY)
    const centerX = percentX - 50
    const centerY = percentY - 50

    const properties: Record<string, string> = {
      '--pointer-x': `${percentX}%`,
      '--pointer-y': `${percentY}%`,
      '--background-x': `${adjust(percentX, 0, 100, 35, 65)}%`,
      '--background-y': `${adjust(percentY, 0, 100, 35, 65)}%`,
      '--pointer-from-center': `${clamp(Math.hypot(percentY - 50, percentX - 50) / 50, 0, 1)}`,
      '--pointer-from-top': `${percentY / 100}`,
      '--pointer-from-left': `${percentX / 100}`,
      '--rotate-x': `${round(-(centerX / 4))}deg`,
      '--rotate-y': `${round(centerY / 3)}deg`,
    }

    Object.entries(properties).forEach(([prop, val]) => {
      wrap.style.setProperty(prop, val)
    })
  }, [])

  const createSmoothAnimation = useCallback((duration: number, startX: number, startY: number) => {
    const card = cardRef.current
    const wrap = wrapRef.current
    if (!card || !wrap) return

    const startTime = performance.now()
    const targetX = wrap.clientWidth / 2
    const targetY = wrap.clientHeight / 2

    const animationLoop = (currentTime: number) => {
      const elapsed = currentTime - startTime
      const progress = clamp(elapsed / duration)
      const easedProgress = easeInOutCubic(progress)
      const currentX = adjust(easedProgress, 0, 1, startX, targetX)
      const currentY = adjust(easedProgress, 0, 1, startY, targetY)
      updateCardTransform(currentX, currentY)
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animationLoop)
      }
    }
    rafRef.current = requestAnimationFrame(animationLoop)
  }, [updateCardTransform])

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const card = cardRef.current
      if (!card) return
      const rect = card.getBoundingClientRect()
      updateCardTransform(e.clientX - rect.left, e.clientY - rect.top)
    },
    [updateCardTransform],
  )

  const handlePointerEnter = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    wrapRef.current?.classList.add('active')
    cardRef.current?.classList.add('active')
  }, [])

  const handlePointerLeave = useCallback(() => {
    const card = cardRef.current
    if (!card) return
    createSmoothAnimation(600, card.clientWidth / 2, card.clientHeight / 2)
    wrapRef.current?.classList.remove('active')
    cardRef.current?.classList.remove('active')
  }, [createSmoothAnimation])

  return (
    <div
      className={`assistant-card-wrap assistant-card-wrap--${rarity}${isActive ? ' selected' : ''}`}
      ref={wrapRef}
      style={cardStyle as React.CSSProperties}
    >
      <div
        className={`assistant-card assistant-card--${rarity}${isActive ? ' selected' : ''}`}
        ref={cardRef}
        data-rarity={rarity}
        onClick={handleClick}
        onPointerMove={handlePointerMove}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') handleClick()
        }}
      >
        <div className="assistant-card__inside">
          <div className="assistant-card__shine" />
          <div className="assistant-card__glare" />

          <div className="assistant-card__avatar-layer">
            <div className="assistant-card__avatar-area">
              {assistant.avatar ? (
                <img className="assistant-card__avatar-img" src={assistant.avatar} alt={assistant.name} />
              ) : (
                <div className="assistant-card__avatar-placeholder">
                  <span className="assistant-card__avatar-icon">{identityIcon}</span>
                </div>
              )}
              <div className="assistant-card__avatar-ring" />
            </div>
          </div>

          <div className="assistant-card__text-layer">
            <div className="assistant-card__rarity-badge">{rarity}</div>
            <div className="assistant-card__info">
              <div className="assistant-card__name">{assistant.name}</div>
              <div className="assistant-card__tags">
                {assistant.persona.identity && (
                  <span className="assistant-card__tag assistant-card__tag--identity">
                    {assistant.persona.identity}
                  </span>
                )}
                {assistant.persona.personality && (
                  <span className="assistant-card__tag assistant-card__tag--personality">
                    {assistant.persona.personality}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="assistant-card__actions">
            <button
              className="assistant-card__action-btn assistant-card__action-btn--edit"
              onClick={handleEdit}
              title={t('card.editCharacter')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              className="assistant-card__action-btn assistant-card__action-btn--delete"
              onClick={handleDelete}
              title={t('card.deleteCharacter')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>

          {isActive && (
            <div className="assistant-card__selected-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
              </svg>
              {t('card.activeLabel')}
            </div>
          )}

          {isActive && <div className="assistant-card__neon-border" />}
        </div>
      </div>
    </div>
  )
}