import React, { useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Volume2, VolumeX, X, Trash2, Play, Pause, GripVertical } from 'lucide-react'
import { useAudioPlayback } from '../../../vrm/hooks/useAudioPlayback'
import { useAudioPlaybackStore } from '../../../vrm/store/audioPlaybackStore'
import { useIslandStore } from '../../store/islandStore'
import { useI18n } from '../../../../infrastructure/i18n'
import { useDraggable } from '../../../../infrastructure/overlay/useDraggable'
import { usePopupResize } from '../../hooks/usePopupResize'
import type { SoundEntry } from '../../../vrm/lib/audioPlaybackApi'
import './SfxPopup.scss'

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

export const SfxPopup: React.FC = () => {
  const audio = useAudioPlayback()
  const { t } = useI18n('vrm')
  const closePopup = useIslandStore((s) => s.closePopup)
  const masterVolume = useAudioPlaybackStore((s) => s.masterVolume)
  const setMasterVolume = useAudioPlaybackStore((s) => s.setMasterVolume)

  // ---- Draggable, non-modal popup ----
  const POPUP_WIDTH = 480
  const POPUP_HEIGHT = 420
  const POPUP_MIN_WIDTH = 360
  const POPUP_MIN_HEIGHT = 320
  const POPUP_INITIAL_X = Math.max(8, (window.innerWidth - POPUP_WIDTH) / 2)
  const POPUP_INITIAL_Y = 56
  const { position, setPosition, elementRef, handleMouseDown, isDragging } = useDraggable({
    initialPosition: { x: POPUP_INITIAL_X, y: POPUP_INITIAL_Y },
    excludeSelector: 'button, input, .sfx-popup__close, .sfx-popup__category-tab, .sfx-popup__card, .sfx-popup__chip, .sfx-popup__chip-volume, .sfx-popup__chip-remove, .sfx-popup__stop-all, .sfx-popup__volume-toggle, .sfx-popup__volume-slider, .sfx-popup__resize-handle',
  })

  // ---- Resizable popup (8-direction edges + corners) ----
  const { size, activeResize, handleResizeMouseDown } = usePopupResize({
    initialSize: { width: POPUP_WIDTH, height: POPUP_HEIGHT },
    minWidth: POPUP_MIN_WIDTH,
    minHeight: POPUP_MIN_HEIGHT,
    getPosition: useCallback(() => position, [position]),
    setPosition,
    elementRef,
  })

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
      void setMasterVolume(0)
    } else {
      void setMasterVolume(0.8)
    }
  }

  return createPortal(
    <div
      ref={elementRef}
      className={`sfx-popup no-penetrate${isDragging ? ' is-dragging' : ''}${activeResize ? ' is-resizing' : ''}`}
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ===== Resize handles (8 directions) ===== */}
      <div className="sfx-popup__resize-handle sfx-popup__resize-handle--n" onMouseDown={handleResizeMouseDown('n')} />
      <div className="sfx-popup__resize-handle sfx-popup__resize-handle--s" onMouseDown={handleResizeMouseDown('s')} />
      <div className="sfx-popup__resize-handle sfx-popup__resize-handle--e" onMouseDown={handleResizeMouseDown('e')} />
      <div className="sfx-popup__resize-handle sfx-popup__resize-handle--w" onMouseDown={handleResizeMouseDown('w')} />
      <div className="sfx-popup__resize-handle sfx-popup__resize-handle--ne" onMouseDown={handleResizeMouseDown('ne')} />
      <div className="sfx-popup__resize-handle sfx-popup__resize-handle--nw" onMouseDown={handleResizeMouseDown('nw')} />
      <div className="sfx-popup__resize-handle sfx-popup__resize-handle--se" onMouseDown={handleResizeMouseDown('se')} />
      <div className="sfx-popup__resize-handle sfx-popup__resize-handle--sw" onMouseDown={handleResizeMouseDown('sw')} />

      {/* ===== Header (drag handle) ===== */}
      <div
        className="sfx-popup__header"
        onMouseDown={handleMouseDown}
      >
        <GripVertical size={14} className="sfx-popup__drag-handle" />
        <span className="sfx-popup__title">
          AI00-SFX
        </span>
        <button
          className="sfx-popup__close"
          onClick={(e) => { e.stopPropagation(); closePopup('sfx') }}
          title={t('audio.island.collapse', { defaultValue: '收起' })}
        >
          <X size={16} />
        </button>
      </div>

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
                    <>
                      <span className="sfx-popup__card-indicator" />
                      <span className="sfx-popup__card-overlay">
                        <Pause size={16} />
                      </span>
                    </>
                  )}
                  {!active && (
                    <span className="sfx-popup__card-overlay sfx-popup__card-overlay--hover">
                      <Play size={16} />
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
              onChange={(e) => { e.stopPropagation(); void setMasterVolume(parseFloat(e.target.value)) }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
    </div>,
    document.body,
  )
}
