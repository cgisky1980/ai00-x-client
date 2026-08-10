import React from 'react'
import { X, Trash2 } from 'lucide-react'
import { useAudioPlayback } from '../hooks/useAudioPlayback'
import { useI18n } from '../../../infrastructure/i18n'
import type { SoundEntry } from '../lib/audioPlaybackApi'

const CATEGORY_ICONS: Record<string, string> = {
  nature: '\u{1F33F}',
  rain: '\u{1F327}\u{FE0F}',
  animals: '\u{1F43E}',
  urban: '\u{1F3D9}\u{FE0F}',
  places: '\u{1F4CD}',
  transport: '\u{1F682}',
  things: '\u{1F514}',
  noise: '\u{1F4FB}',
  generated: '\u2728',
}

export const AudioListPanel: React.FC = () => {
  const audio = useAudioPlayback()
  const { t } = useI18n('vrm')

  const visibleCategories = audio.categories
  const activeSounds = visibleCategories.find(c => c.id === audio.activeCategory)?.sounds ?? []

  const isSoundActive = (sound: SoundEntry): boolean => {
    return audio.sfxChannels.some(ch => {
      if (!ch.source_path) return false
      return ch.source_path.replace(/\\/g, '/').endsWith(sound.file_path.replace(/\\/g, '/'))
    })
  }

  const isGenerated = (sound: SoundEntry): boolean => {
    return typeof sound.source !== 'string'
  }

  const handleSoundClick = (sound: SoundEntry) => {
    audio.toggleLibrarySound(sound.id)
  }

  return (
    <div className="audio-list-panel">
      {/* SFX: Sound Library */}
      <div className="audio-sfx-section">
        {/* Category Tabs - wrapping */}
        <div className="sound-category-tabs">
          {visibleCategories.map((cat) => (
            <button
              key={cat.id}
              className={`sound-category-tab ${audio.activeCategory === cat.id ? 'sound-category-tab--active' : ''}`}
              onClick={() => audio.setActiveCategory(cat.id)}
            >
              <span className="sound-category-icon">{CATEGORY_ICONS[cat.id] || '\u{1F3B5}'}</span>
              <span>{cat.name}</span>
            </button>
          ))}
        </div>

        {/* Sound Grid */}
        <div className="sound-grid">
          {activeSounds.map((sound) => (
            <div
              key={sound.id}
              className={`sound-card ${isSoundActive(sound) ? 'sound-card--active' : ''}`}
              onClick={() => handleSoundClick(sound)}
              title={isSoundActive(sound) ? t('audio.list.stop') : t('audio.list.play')}
            >
              <span className="sound-card__name">{sound.name}</span>
              {isSoundActive(sound) && <span className="sound-card__indicator" />}
              {isGenerated(sound) && (
                <button
                  className="sound-card__delete"
                  onClick={(e) => { e.stopPropagation(); audio.deleteFromLibrary(sound.id) }}
                  title={t('audio.list.delete')}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
          {activeSounds.length === 0 && (
            <div className="sound-grid-empty">{t('audio.list.noSounds')}</div>
          )}
        </div>

        {/* Active SFX Channels - fixed header + scrollable list */}
        {audio.sfxChannels.length > 0 && (
          <div className="audio-active-sfx">
            <div className="audio-active-sfx__header">
              <span>{t('audio.list.activeSfx')} ({audio.sfxChannels.length})</span>
              <button className="audio-text-btn" onClick={() => audio.stopAllSfx()}>{t('audio.list.stopAll')}</button>
            </div>
            <div className="audio-active-sfx__list">
              {audio.sfxChannels.map((ch) => (
                <div key={ch.id} className="audio-channel-row">
                  <span className="audio-channel-name">{ch.name}</span>
                  <input
                    type="range"
                    className="audio-slider audio-slider--flex"
                    min={0}
                    max={1}
                    step={0.01}
                    value={ch.volume}
                    onChange={(e) => audio.setChannelVolume(ch.id, parseFloat(e.target.value))}
                  />
                  <button
                    className="audio-icon-btn audio-icon-btn--danger"
                    onClick={() => audio.stopChannel(ch.id)}
                    title={t('audio.list.stop')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
