import React from 'react'
import { Volume2, VolumeX, Maximize2, Trash2, Waves } from 'lucide-react'
import { useAudioPlayback } from '../../../vrm/hooks/useAudioPlayback'
import { useAudioPlaybackStore } from '../../../vrm/store/audioPlaybackStore'
import { useI18n } from '../../../../infrastructure/i18n'
import { useHorizontalScroll } from '../../hooks/useHorizontalScroll'
import './SfxActivity.scss'

/**
 * SfxActivity — 灵动岛第 2 行：环境音效货架（单行）。
 *
 * [Waves 图标 + 数量] [胶囊滚动区（拖动/滚轮横滑）] [音量] [展开]
 * 无播放时显示空态（行高占位不变，保持固定 3 行）。
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
  const scroll = useHorizontalScroll()

  const handleVolumeToggle = () => {
    if (masterVolume > 0) {
      void setMasterVolume(0)
    } else {
      void setMasterVolume(0.8)
    }
  }

  const activeChannels = audio.sfxChannels

  return (
    <div className={`sfx-activity${activeChannels.length === 0 ? ' sfx-activity--empty' : ''}`}>
      {/* Row head: icon + count badge */}
      <Waves size={14} className="sfx-activity__icon" />
      {activeChannels.length > 0 && (
        <span className="sfx-activity__count">{activeChannels.length}</span>
      )}
      {activeChannels.length === 0 ? (
        <span className="sfx-activity__empty-text">
          {t('island.activity.sfx.empty', { defaultValue: '暂无环境音效' })}
        </span>
      ) : (
        <div
          className="sfx-activity__chips"
          ref={scroll.ref}
          onMouseDown={scroll.onMouseDown}
          onMouseMove={scroll.onMouseMove}
          onMouseUp={scroll.onMouseUp}
          onMouseLeave={scroll.onMouseLeave}
          onWheel={scroll.onWheel}
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
      )}
      {/* Row tail: volume toggle + expand */}
      <button
        className="sfx-activity__row-btn"
        onClick={handleVolumeToggle}
        title={masterVolume > 0 ? t('audio.nowPlaying.mute') : t('audio.nowPlaying.unmute')}
      >
        {masterVolume > 0 ? <Volume2 size={13} /> : <VolumeX size={13} />}
      </button>
      <button
        className="sfx-activity__row-btn"
        onClick={(e) => { e.stopPropagation(); onOpenPopup() }}
        title={t('audio.island.expand', { defaultValue: '展开' })}
      >
        <Maximize2 size={13} />
      </button>
    </div>
  )
}
