import React from 'react'
import { Pause, Play, Volume2, VolumeX, SkipForward } from 'lucide-react'
import { useAudioPlayback } from '../hooks/useAudioPlayback'
import { useAudioPlaybackStore, RADIO_PRESETS } from '../store/audioPlaybackStore'
import { useI18n } from '../../../infrastructure/i18n'

export const AudioNowPlayingBar: React.FC = () => {
  const audio = useAudioPlayback()
  const { t } = useI18n('vrm')
  const radioStyle = useAudioPlaybackStore((s) => s.radioStyle)
  const radioActive = useAudioPlaybackStore((s) => s.radioActive)
  const playMode = useAudioPlaybackStore((s) => s.playMode)

  const bgmChannel = audio.bgmChannel
  const isPlaying = bgmChannel?.state === 'Playing'
  const masterVolume = audio.masterVolume

  const getBgmName = (): string => {
    if (!bgmChannel) return ''
    if (!bgmChannel.source_path) return bgmChannel.name
    const normalizedPath = bgmChannel.source_path.replace(/\\/g, '/')
    for (const cat of audio.categories) {
      for (const sound of cat.sounds) {
        if (normalizedPath.endsWith(sound.file_path.replace(/\\/g, '/'))) {
          return sound.name
        }
      }
    }
    const parts = normalizedPath.split('/')
    const filename = parts[parts.length - 1]
    return filename.replace(/\.\w+$/, '')
  }

  const formatTime = (secs: number): string => {
    if (!secs || !isFinite(secs)) return '0:00'
    const m = Math.floor(secs / 60)
    const s = Math.floor(secs % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const progress = bgmChannel && bgmChannel.duration_secs > 0
    ? (bgmChannel.position_secs / bgmChannel.duration_secs) * 100
    : 0

  return (
    <div className="audio-now-playing">
      {/* Spectrum animation */}
      <div className={`audio-spectrum ${isPlaying ? 'audio-spectrum--active' : ''}`}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="audio-spectrum__bar" style={{ animationDelay: `${i * 0.08}s` }} />
        ))}
      </div>

      {/* Track info */}
      <div className="audio-now-playing__info">
        {bgmChannel ? (
          <>
            <span className="audio-now-playing__name">{
              radioActive && radioStyle
                ? (RADIO_PRESETS.find(p => p.id === radioStyle)?.name ?? t('audio.mode.radio'))
                : playMode === 'list'
                  ? t('audio.mode.list')
                  : getBgmName()
            }</span>
            <span className="audio-now-playing__time">
              {formatTime(bgmChannel.position_secs)} / {formatTime(bgmChannel.duration_secs)}
            </span>
          </>
        ) : (
          <span className="audio-now-playing__name audio-now-playing__name--idle">{t('audio.nowPlaying.noBgm')}</span>
        )}
      </div>

      {/* Progress bar */}
      {bgmChannel && (
        <div className="audio-now-playing__progress">
          <div className="audio-now-playing__progress-fill" style={{ width: `${Math.min(100, progress)}%` }} />
        </div>
      )}

      {/* Controls */}
      <div className="audio-now-playing__controls">
        {/* Master volume slider */}
        <div className="audio-now-playing__volume">
          {masterVolume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
          <input
            type="range"
            className="audio-slider audio-slider--mini"
            min={0}
            max={1}
            step={0.01}
            value={masterVolume}
            onChange={(e) => audio.setMasterVolume(parseFloat(e.target.value))}
          />
        </div>
        {bgmChannel ? (
          <button
            className="audio-icon-btn audio-icon-btn--glow"
            onClick={() => isPlaying ? audio.pauseChannel(bgmChannel.id) : audio.resumeChannel(bgmChannel.id)}
            title={isPlaying ? t('audio.nowPlaying.pause') : t('audio.nowPlaying.play')}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
        ) : (
          <div className="audio-icon-btn audio-icon-btn--muted">
            <Volume2 size={14} />
          </div>
        )}
        {/* Skip to next track */}
        {bgmChannel && (
          <button
            className="audio-icon-btn audio-icon-btn--skip"
            onClick={() => audio.skipToNext()}
            disabled={audio.radioGenerating}
            title={t('audio.nowPlaying.skipNext')}
          >
            <SkipForward size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
