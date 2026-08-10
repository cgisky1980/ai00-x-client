import React, { useCallback, useRef } from 'react'
import { Volume2, VolumeX, Maximize2, Trash2 } from 'lucide-react'
import { useAudioPlayback } from '../../../vrm/hooks/useAudioPlayback'
import { useAudioPlaybackStore } from '../../../vrm/store/audioPlaybackStore'
import { useI18n } from '../../../../infrastructure/i18n'
import './SfxActivity.scss'

/**
 * SfxActivity — DynamicIsland 中的环境音效快捷入口。
 *
 * 仅显示当前正在播放的音效胶囊（一行水平排列，可左右拖动滚动）。
 * 每个胶囊可调节音量、删除。无播放时显示空状态 + 展开按钮。
 *
 * 与 MusicActivity（BGM 源）独立运行：
 *   - 使用 AudioMixer 的 Sfx 通道（与 Bgm 通道天然隔离）
 *   - 多个 SFX 可同时播放（雨声+篝火+鸟鸣叠加）
 *   - BGM 切换不影响 SFX 播放
 */
interface SfxActivityProps {
  onOpenPopup: () => void
}

export const SfxActivity: React.FC<SfxActivityProps> = ({ onOpenPopup }) => {
  const audio = useAudioPlayback()
  const { t } = useI18n('vrm')
  const masterVolume = useAudioPlaybackStore((s) => s.masterVolume)
  const setMasterVolume = useAudioPlaybackStore((s) => s.setMasterVolume)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{ startX: number; scrollLeft: number; dragging: boolean }>({
    startX: 0,
    scrollLeft: 0,
    dragging: false,
  })

  // ---- 水平拖动滚动 ----
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const el = scrollRef.current
    if (!el) return
    dragStateRef.current = {
      startX: e.clientX,
      scrollLeft: el.scrollLeft,
      dragging: true,
    }
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragStateRef.current.dragging) return
    const el = scrollRef.current
    if (!el) return
    const dx = e.clientX - dragStateRef.current.startX
    el.scrollLeft = dragStateRef.current.scrollLeft - dx
  }, [])

  const handleMouseUp = useCallback(() => {
    dragStateRef.current.dragging = false
  }, [])

  const handleVolumeToggle = () => {
    if (masterVolume > 0) {
      void setMasterVolume(0)
    } else {
      void setMasterVolume(0.8)
    }
  }

  const activeChannels = audio.sfxChannels

  if (activeChannels.length === 0) {
    return (
      <div className="sfx-activity sfx-activity--empty">
        <span className="sfx-activity__empty-text">
          {t('island.activity.sfx.empty', { defaultValue: '暂无环境音效' })}
        </span>
        <button
          className="sfx-activity__expand-btn"
          onClick={(e) => { e.stopPropagation(); onOpenPopup() }}
          title={t('audio.island.expand', { defaultValue: '展开' })}
        >
          <Maximize2 size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className="sfx-activity">
      <div className="sfx-activity__header">
        <span className="sfx-activity__title">
          {t('island.activity.sfx', { defaultValue: '环境音效' })}
          <span className="sfx-activity__count">{activeChannels.length}</span>
        </span>
        <div className="sfx-activity__header-actions">
          <button
            className="sfx-activity__header-btn"
            onClick={handleVolumeToggle}
            title={masterVolume > 0 ? t('audio.nowPlaying.mute') : t('audio.nowPlaying.unmute')}
          >
            {masterVolume > 0 ? <Volume2 size={13} /> : <VolumeX size={13} />}
          </button>
          <button
            className="sfx-activity__header-btn"
            onClick={(e) => { e.stopPropagation(); onOpenPopup() }}
            title={t('audio.island.expand', { defaultValue: '展开' })}
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
      <div
        className="sfx-activity__chips"
        ref={scrollRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {activeChannels.map((ch) => (
          <div className="sfx-activity__chip" key={ch.id}>
            <span className="sfx-activity__chip-name" title={ch.name}>
              {ch.name}
            </span>
            <input
              type="range"
              className="sfx-activity__chip-volume"
              min={0}
              max={1}
              step={0.01}
              value={ch.volume}
              onChange={(e) => { e.stopPropagation(); void audio.setChannelVolume(ch.id, parseFloat(e.target.value)) }}
              onClick={(e) => e.stopPropagation()}
              title={t('audio.list.volume', { defaultValue: '音量' })}
            />
            <button
              className="sfx-activity__chip-remove"
              onClick={(e) => { e.stopPropagation(); void audio.stopChannel(ch.id) }}
              title={t('audio.list.stop', { defaultValue: '停止' })}
            >
              <Trash2 size={10} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
