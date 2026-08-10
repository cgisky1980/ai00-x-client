import React from 'react'
import { useInteractionStore } from '../store/interactionStore'
import { useI18n } from '@/infrastructure/i18n'

const MODE_LABEL_KEYS: Record<string, string> = {
  idle: '',
  charging: 'voiceIndicator.charging',
  recording: 'voiceIndicator.recording',
  vrm_dialog: 'voiceIndicator.dialog',
  error: 'voiceIndicator.error',
}

export const VoiceIndicator: React.FC = () => {
  const { t } = useI18n('vrm')
  const indicatorMode = useInteractionStore((s) => s.voiceIndicatorMode)
  const voicePosition = useInteractionStore((s) => s.voicePosition)
  const chargeProgress = useInteractionStore((s) => s.chargeProgress)
  const voiceText = useInteractionStore((s) => s.voiceText)

  if (indicatorMode === 'idle') return null

  const isActive = true
  const isCharging = indicatorMode === 'charging' || indicatorMode === 'vrm_dialog'
  const isRecording = indicatorMode === 'recording'
  const isError = indicatorMode === 'error'

  const labelKey = MODE_LABEL_KEYS[indicatorMode] || ''
  const label = isError
    ? (voiceText || (labelKey ? t(labelKey) : ''))
    : (labelKey ? t(labelKey) : voiceText || '')

  const ringSize = 80
  const strokeWidth = 3
  const radius = (ringSize - strokeWidth * 2) / 2
  const circumference = 2 * Math.PI * radius
  const progressOffset = circumference - chargeProgress * circumference

  const ringColor = isError
    ? '#ef4444'
    : isRecording
      ? '#f59e0b'
      : isCharging
        ? '#3b82f6'
        : '#6b7280'

  return (
    <div
      style={{
        position: 'fixed',
        left: voicePosition.x,
        top: voicePosition.y,
        transform: 'translate(-50%, -50%)',
        zIndex: 90003,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px',
        opacity: isActive ? 1 : 0,
        transition: 'opacity 0.2s ease',
      }}
    >
      <div style={{ position: 'relative', width: ringSize, height: ringSize }}>
        <svg
          width={ringSize}
          height={ringSize}
          style={{ transform: 'rotate(-90deg)' }}
        >
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.15)"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={progressOffset}
            style={{
              transition: 'stroke-dashoffset 0.15s ease, stroke 0.3s ease',
              filter: `drop-shadow(0 0 6px ${ringColor})`,
            }}
          />
        </svg>

        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: isRecording ? 12 : 8,
            height: isRecording ? 12 : 8,
            borderRadius: '50%',
            background: ringColor,
            boxShadow: `0 0 12px ${ringColor}`,
            animation: isRecording ? 'voice-pulse 1s ease-in-out infinite' : undefined,
          }}
        />
      </div>

      {label && (
        <div
          style={{
            fontSize: '11px',
            color: 'rgba(255,255,255,0.85)',
            background: 'rgba(0,0,0,0.5)',
            padding: '2px 8px',
            borderRadius: '10px',
            backdropFilter: 'blur(4px)',
            whiteSpace: isError ? 'normal' : 'nowrap',
            maxWidth: isError ? '200px' : undefined,
            textAlign: 'center' as const,
            wordBreak: 'break-word' as const,
          }}
        >
          {label}
        </div>
      )}
    </div>
  )
}
