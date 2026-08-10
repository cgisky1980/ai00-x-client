import React from 'react'
import { useAudioPlayback } from '../hooks/useAudioPlayback'
import { useI18n } from '../../../infrastructure/i18n'
import { RADIO_PRESETS } from '../store/audioPlaybackStore'

export const AudioRadioPanel: React.FC = () => {
  const audio = useAudioPlayback()
  const { t } = useI18n('vrm')

  const handleStyleSelect = async (styleId: string) => {
    if (audio.radioActive && audio.radioStyle === styleId) {
      audio.stopRadio()
      return
    }
    await audio.startRadio(styleId)
  }

  return (
    <div className="audio-radio-panel">
      <div className="audio-radio-grid">
        {RADIO_PRESETS.map((preset) => {
          const isActive = audio.radioStyle === preset.id
          return (
            <button
              key={preset.id}
              className={`audio-radio-card ${isActive ? 'audio-radio-card--active' : ''}`}
              onClick={() => handleStyleSelect(preset.id)}
              style={{
                '--radio-color': preset.color,
              } as React.CSSProperties}
            >
              <span className="audio-radio-card__icon">{preset.icon}</span>
              <span className="audio-radio-card__name">{t(`audio.radio.${preset.id}`)}</span>
              <span className="audio-radio-card__name-en">{preset.nameEn}</span>
              {isActive && (
                <div className="audio-radio-card__wave">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="audio-radio-card__wave-bar" style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
