// SfxSection — 「乐」窗口音效分区（原 SfxPopup，去弹层壳：无 portal/拖拽/缩放/header）。
// 音频引擎为远程模式（useAudioRemote）：SSOT 在 overlay，动作经命令桥驱动。
import React from 'react'
import { Volume2, VolumeX, X, Trash2, Play, Pause } from 'lucide-react'
import { useAudioRemote } from './useAudioRemoteStore'
import { useI18n } from '../../infrastructure/i18n'
import type { SoundEntry } from '../vrm/lib/audioPlaybackApi'
import './SfxSection.scss'

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

export const SfxSection: React.FC = () => {
  const audio = useAudioRemote()
  const { t } = useI18n('vrm')
  const { masterVolume, setMasterVolume } = audio

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

  const handleVolumeToggle = () => {
    if (masterVolume > 0) {
      setMasterVolume(0)
    } else {
      setMasterVolume(0.8)
    }
  }

  return (
    <div className="sfx-popup">
      {/* ===== Category tabs ===== */}
      <div className="sfx-popup__categories">
        {visibleCategories.map((cat) => (
          <button
            key={cat.id}
            className={`sfx-popup__category-tab${audio.activeCategory === cat.id ? ' is-active' : ''}`}
            onClick={(e) => { e.stopPropagation(); audio.setActiveCategory(cat.id) }}
          >
            <span className="sfx-popup__category-icon">{CATEGORY_ICONS[cat.id] || '\u{1F3B5}'}</span>
            <span>{cat.name}</span>
          </button>
        ))}
      </div>

      {/* ===== Sound grid (4 columns) ===== */}
      <div className="sfx-popup__grid">
        {activeSounds.length === 0 ? (
          <div className="sfx-popup__empty">
            {t('audio.list.noSounds', { defaultValue: '暂无音效' })}
          </div>
        ) : (
          activeSounds.map((sound) => {
            const active = isSoundActive(sound)
            return (
              <button
                key={sound.id}
                type="button"
                className={`sfx-popup__card${active ? ' is-active' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleSoundClick(sound) }}
                title={active ? t('audio.list.stop', { defaultValue: '停止' }) : t('audio.list.play', { defaultValue: '播放' })}
              >
                <span className="sfx-popup__card-icon">
                  {CATEGORY_ICONS[sound.category] || '\u{1F3B5}'}
                </span>
                <span className="sfx-popup__card-name">{sound.name}</span>
                {active && (
                  <span className="sfx-popup__card-indicator" />
                )}
                {active ? (
                  <span className="sfx-popup__card-pause">
                    <Pause size={12} />
                  </span>
                ) : (
                  <span className="sfx-popup__card-play">
                    <Play size={12} />
                  </span>
                )}
                {isGenerated(sound) && (
                  <button
                    className="sfx-popup__card-delete"
                    onClick={(e) => { e.stopPropagation(); audio.deleteFromLibrary(sound.id) }}
                    title={t('audio.list.delete', { defaultValue: '删除' })}
                  >
                    <X size={10} />
                  </button>
                )}
              </button>
            )
          })
        )}
      </div>

      {/* ===== Footer: active chips + volume ===== */}
      <div className="sfx-popup__footer">
        {audio.sfxChannels.length > 0 ? (
          <>
            <div className="sfx-popup__active-header">
              <span>
                {t('audio.list.activeSfx', { defaultValue: '正在播放' })} ({audio.sfxChannels.length})
              </span>
              <button
                className="sfx-popup__stop-all"
                onClick={(e) => { e.stopPropagation(); audio.stopAllSfx() }}
              >
                {t('audio.list.stopAll', { defaultValue: '全部停止' })}
              </button>
            </div>
            <div className="sfx-popup__active-chips">
              {audio.sfxChannels.map((ch) => (
                <span key={ch.id} className="sfx-popup__chip">
                  <span className="sfx-popup__chip-name">{ch.name}</span>
                  <input
                    type="range"
                    className="sfx-popup__chip-volume"
                    min={0}
                    max={1}
                    step={0.01}
                    value={ch.volume}
                    onChange={(e) => { e.stopPropagation(); audio.setChannelVolume(ch.id, parseFloat(e.target.value)) }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <button
                    className="sfx-popup__chip-remove"
                    onClick={(e) => { e.stopPropagation(); audio.stopChannel(ch.id) }}
                    title={t('audio.list.stop', { defaultValue: '停止' })}
                  >
                    <Trash2 size={10} />
                  </button>
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="sfx-popup__active-empty">
            {t('island.activity.sfx.empty', { defaultValue: '点击上方卡片叠加播放' })}
          </div>
        )}
        <div className="sfx-popup__volume-row">
          <button
            className="sfx-popup__volume-toggle"
            onClick={(e) => { e.stopPropagation(); handleVolumeToggle() }}
            title={masterVolume > 0 ? t('audio.nowPlaying.mute') : t('audio.nowPlaying.unmute')}
          >
            {masterVolume > 0 ? <Volume2 size={14} /> : <VolumeX size={14} />}
          </button>
          <input
            type="range"
            className="sfx-popup__volume-slider"
            min={0}
            max={1}
            step={0.01}
            value={masterVolume}
            onChange={(e) => { e.stopPropagation(); setMasterVolume(parseFloat(e.target.value)) }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      </div>
    </div>
  )
}
