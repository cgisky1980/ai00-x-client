import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import {
  Music,
  Pause,
  Play,
  SkipForward,
  Maximize2,
  Volume2,
  VolumeX,
  ListMusic,
} from 'lucide-react'
import { listen, emit } from '@tauri-apps/api/event'
import { useAudioPlaybackStore } from '../../../vrm/store/audioPlaybackStore'
import { useAudioPlayback } from '../../../vrm/hooks/useAudioPlayback'
import { useAudioSpectrum, sampleSpectrum } from '../../../vrm/hooks/useAudioSpectrum'
import { useIslandStore } from '../../store/islandStore'
import { useI18n } from '../../../../infrastructure/i18n'
import { useBgmPlayerStore } from '../../store/bgmPlayer'
import { aceStepService } from '../../../acestep/services/AceStepService'
import type { SongEntry } from '../../../acestep/types'
import {
  parseEnhancedLrc,
} from '../../../acestep/utils/lrcParser'
import './MusicActivity.scss'

// ---- AceStep bridge types (mirrored from PlayerBridge.ts) ----
interface AceStepPlayerState {
  currentSong: {
    title: string
    artist: string
    durationSeconds: number
  } | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  playMode: 'sequential' | 'repeat-one' | 'repeat-all' | 'shuffle'
  playlistLength: number
  playlistIndex: number
  p2pStatus: 'connecting' | 'downloading' | 'seeding' | 'error' | null
  p2pPeerCount: number
  source: 'local' | 'share'
  showLyrics: boolean
}

const EVENT_PLAYER_STATE = 'acestep://player-state'
const EVENT_PLAYER_COMMAND = 'acestep://player-command'
const EVENT_LYRICS_STATE = 'acestep://lyrics-state'

// ---- Lyrics state schema (AceStep → Main) ----
interface AceStepLyricsState {
  lrcText: string | null
  currentTime: number
  title: string | null
  showLyrics: boolean
}

interface MusicActivityProps {
  onOpenPopup: () => void
}

export const MusicActivity: React.FC<MusicActivityProps> = ({ onOpenPopup }) => {
  const { t } = useI18n('vrm')
  const audio = useAudioPlayback()
  const masterVolume = useAudioPlaybackStore((s) => s.masterVolume)
  const setMasterVolume = useAudioPlaybackStore((s) => s.setMasterVolume)
  const radioActive = useAudioPlaybackStore((s) => s.radioActive)
  const radioStyle = useAudioPlaybackStore((s) => s.radioStyle)
  const activities = useIslandStore((s) => s.activities)
  const activeActivityId = useIslandStore((s) => s.activeActivityId)

  // ---- AceStep state (from cross-window event) ----
  const [acestepState, setAcestepState] = useState<AceStepPlayerState | null>(null)
  const acestepTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---- AceStep local song list (used for "browse to play" hint only) ----
  const [acestepSongs, setAcestepSongs] = useState<SongEntry[]>([])

  // ---- AceStep lyrics state (for hasLyrics check in expanded layer) ----
  const [lyricsState, setLyricsState] = useState<AceStepLyricsState | null>(null)

  // ---- Fetch local AceStep songs (count only — full UI moved to MusicPopup) ----
  const fetchAcestepSongs = useCallback(async () => {
    try {
      const list = await aceStepService.listSongs()
      setAcestepSongs(list)
    } catch (e) {
      console.warn('[MusicActivity] failed to list AceStep songs:', e)
    }
  }, [])

  // ---- Subscribe to AceStep player state ----
  useEffect(() => {
    const unlisten = listen<AceStepPlayerState>(EVENT_PLAYER_STATE, (event) => {
      setAcestepState(event.payload)
      if (acestepTimeoutRef.current) clearTimeout(acestepTimeoutRef.current)
      acestepTimeoutRef.current = setTimeout(() => {
        setAcestepState(null)
      }, 3000)
    })
    return () => {
      unlisten.then((fn) => fn())
      if (acestepTimeoutRef.current) clearTimeout(acestepTimeoutRef.current)
    }
  }, [])

  // ---- Subscribe to AceStep lyrics state ----
  useEffect(() => {
    const unlisten = listen<AceStepLyricsState>(EVENT_LYRICS_STATE, (event) => {
      setLyricsState(event.payload)
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  // ---- Auto source detection (acestep takes priority over vrm radio) ----
  // 注意：acestep 播放和 VRM 电台共用同一个 Rust AudioMixer 的 Bgm 通道，
  // 不能仅凭「有 Bgm 通道在播放」判定是电台（acestep 播放时也会有一个
  // Playing 的 Bgm 通道）。电台必须显式设了 radioActive 才算，否则会因为
  // acestep 状态短暂未同步而被误判成电台，导致灵动岛在电台/音乐间疯跳。
  const bgmChannel = audio.bgmChannel
  const vrmIsPlaying = radioActive && bgmChannel?.state === 'Playing'
  const acestepIsPlaying = acestepState?.isPlaying ?? false
  const acestepAvailable = acestepState !== null

  // Unified active source: 'acestep' | 'vrm' | null
  const activeSource: 'acestep' | 'vrm' | null =
    acestepState?.isPlaying ? 'acestep'
      : vrmIsPlaying ? 'vrm'
        : acestepState?.currentSong ? 'acestep'
          : radioActive ? 'vrm'
            : null

  // ---- Load songs when AceStep is available ----
  useEffect(() => {
    if (acestepAvailable) {
      void fetchAcestepSongs()
    }
  }, [acestepAvailable, fetchAcestepSongs])

  const prevVolumeRef = useRef(0.8)

  // ---- Real-time spectrum from Rust AudioMixer (covers both VRM + AceStep) ----
  const spectrum = useAudioSpectrum(vrmIsPlaying || acestepIsPlaying)
  const compactBands = useMemo(() => sampleSpectrum(spectrum, 8), [spectrum])
  const expandedBgBands = useMemo(() => sampleSpectrum(spectrum, 10), [spectrum])
  const expandedMirrored = useMemo(() => [...expandedBgBands].reverse(), [expandedBgBands])

  const formatTime = (secs: number): string => {
    if (!secs || !isFinite(secs)) return '0:00'
    const m = Math.floor(secs / 60)
    const s = Math.floor(secs % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  // ---- VRM radio computed ----
  const vrmProgress =
    bgmChannel && bgmChannel.duration_secs > 0
      ? (bgmChannel.position_secs / bgmChannel.duration_secs) * 100
      : 0
  const vrmStationName = radioActive && radioStyle ? radioStyle : t('audio.island.activity.music', { defaultValue: '音乐电台' })

  // ---- AceStep computed ----
  const acestepProgress =
    acestepState && acestepState.duration > 0
      ? (acestepState.currentTime / acestepState.duration) * 100
      : 0

  // ---- Lyrics parsing (for hasLyrics check in expanded layer) ----
  const parsedLrc = useMemo(
    () => (lyricsState?.lrcText ? parseEnhancedLrc(lyricsState.lrcText) : null),
    [lyricsState?.lrcText],
  )
  const lyricsLines = parsedLrc?.lines ?? []
  const hasLyrics = lyricsLines.length > 0

  // ---- AceStep command helpers ----
  const sendAceStepCommand = useCallback(
    (action: string, payload?: Record<string, unknown>) => {
      emit(EVENT_PLAYER_COMMAND, { action, payload }).catch((e) =>
        console.warn('[MusicActivity] emit player-command failed:', e),
      )
    },
    [],
  )

  // ---- Unified volume toggle (acts on active source) ----
  const handleVolumeToggle = () => {
    if (activeSource === 'acestep' && acestepState) {
      sendAceStepCommand('setVolume', { volume: acestepState.volume > 0 ? 0 : 0.8 })
      return
    }
    // VRM / fallback: master volume
    if (masterVolume > 0) {
      prevVolumeRef.current = masterVolume
      void setMasterVolume(0)
    } else {
      void setMasterVolume(prevVolumeRef.current || 0.8)
    }
  }

  // ---- Sync BgmPlayer.activeSource with AceStep playback state ----
  useEffect(() => {
    const bgm = useBgmPlayerStore.getState()
    if (acestepState?.isPlaying && bgm.activeSource !== 'acestep') {
      useBgmPlayerStore.setState({ activeSource: 'acestep', pendingSource: null })
    }
  }, [acestepState?.isPlaying])

  // ---- Unified toggle play ----
  const handleTogglePlay = useCallback(() => {
    if (activeSource === 'acestep') {
      sendAceStepCommand('togglePlay')
    } else if (activeSource === 'vrm' && bgmChannel) {
      if (vrmIsPlaying) audio.pauseChannel(bgmChannel.id)
      else audio.resumeChannel(bgmChannel.id)
    }
  }, [activeSource, bgmChannel, vrmIsPlaying, audio, sendAceStepCommand])

  // ---- Unified next ----
  const handleNext = useCallback(() => {
    if (activeSource === 'acestep') {
      sendAceStepCommand('next')
    } else if (activeSource === 'vrm') {
      audio.skipToNext()
    }
  }, [activeSource, audio, sendAceStepCommand])

  // ---- Unified prev ----
  const handlePrev = useCallback(() => {
    if (activeSource === 'acestep') {
      sendAceStepCommand('prev')
    }
    // VRM radio has no prev
  }, [activeSource, sendAceStepCommand])

  const handleAceStepToggleLyrics = useCallback(() => {
    sendAceStepCommand('toggleLyrics')
  }, [sendAceStepCommand])

  // ---- AceStep progress bar click-to-seek ----
  const handleAceStepProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!acestepState || acestepState.duration <= 0) return
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    sendAceStepCommand('seek', { time: ratio * acestepState.duration })
  }

  // ========================================================================
  // Compact layer — spectrum bg + icon + time
  // ========================================================================
  const renderCompact = () => {
    const isPlaying = activeSource === 'acestep' ? acestepIsPlaying : vrmIsPlaying
    const currentTime = activeSource === 'acestep' ? (acestepState?.currentTime ?? 0) : (bgmChannel?.position_secs ?? 0)
    const mirrored = [...compactBands].reverse()
    return (
      <div className="music-activity music-activity--compact">
        <div className="music-activity__spectrum-bg">
          <div className="music-activity__spectrum-bg-col music-activity__spectrum-bg-col--left">
            {mirrored.map((v, i) => (
              <div
                key={i}
                className="music-activity__spectrum-bg-bar"
                style={{ height: `${2 + v * 38}px` }}
              />
            ))}
          </div>
          <div className="music-activity__spectrum-bg-col music-activity__spectrum-bg-col--right">
            {compactBands.map((v, i) => (
              <div
                key={i}
                className="music-activity__spectrum-bg-bar"
                style={{ height: `${2 + v * 38}px` }}
              />
            ))}
          </div>
        </div>
        <Music size={14} className={`music-activity__icon ${isPlaying ? 'music-activity__icon--playing' : ''}`} />
        {isPlaying && (
          <span className="music-activity__mini-time">
            {formatTime(currentTime)}
          </span>
        )}
      </div>
    )
  }

  // ========================================================================
  // Expanded layer — info + unified controls + open-playlist button
  // ========================================================================
  const renderExpanded = () => {
    // Resolve title/subtitle/progress/onClick based on active source
    let title = t('audio.island.music.browseToPlay', { defaultValue: '点击展开浏览' })
    let subtitle = ''
    let progress = 0
    let duration = 0
    let progressClick: ((e: React.MouseEvent<HTMLDivElement>) => void) | undefined
    let isPlaying = false
    let canSkip = false
    let canPrev = false

    if (activeSource === 'acestep' && acestepState) {
      if (acestepState.currentSong) {
        title = acestepState.currentSong.title
        subtitle = `${acestepState.currentSong.artist} · ${acestepState.isPlaying ? t('audio.island.music.playing', { defaultValue: '播放中' }) : t('audio.island.music.paused', { defaultValue: '已暂停' })}`
        progress = acestepProgress
        duration = acestepState.duration
        progressClick = handleAceStepProgressClick
        isPlaying = acestepState.isPlaying
        canSkip = true
        canPrev = true
      } else {
        title = t('audio.island.music.browseSongs', { defaultValue: '点击展开选歌' })
        subtitle = `${t('acestep.library', { defaultValue: '作品库' })} (${acestepSongs.length})`
      }
    } else if (activeSource === 'vrm' && bgmChannel) {
      title = vrmStationName
      subtitle = `${t('audio.island.music.radio', { defaultValue: '电台' })} · ${vrmIsPlaying ? t('audio.island.music.playing', { defaultValue: '播放中' }) : t('audio.island.music.paused', { defaultValue: '已暂停' })}`
      progress = vrmProgress
      duration = bgmChannel.duration_secs
      // VRM has no seekChannel API — progress is display-only
      progressClick = undefined
      isPlaying = vrmIsPlaying
      canSkip = true
      canPrev = false
    } else {
      title = t('audio.island.music.browseToPlay', { defaultValue: '点击展开浏览' })
      subtitle = t('audio.island.music.nothingPlaying', { defaultValue: '未播放' })
    }

    // Unified volume state for the toggle icon
    const currentVolume = activeSource === 'acestep' ? (acestepState?.volume ?? 0) : masterVolume

    return (
      <div className="music-activity music-activity--expanded">
        <div className="music-activity__indicators">
          {activities.filter((a) => a.visible).map((a) => (
            <span
              key={a.id}
              className={`music-activity__indicator ${a.id === activeActivityId ? 'music-activity__indicator--active' : ''}`}
            />
          ))}
        </div>
        <div className="music-activity__spectrum-bg">
          <div className="music-activity__spectrum-bg-col music-activity__spectrum-bg-col--left">
            {expandedMirrored.map((v, i) => (
              <div
                key={i}
                className="music-activity__spectrum-bg-bar"
                style={{ height: `${2 + v * 90}px` }}
              />
            ))}
          </div>
          <div className="music-activity__spectrum-bg-col music-activity__spectrum-bg-col--right">
            {expandedBgBands.map((v, i) => (
              <div
                key={i}
                className="music-activity__spectrum-bg-bar"
                style={{ height: `${2 + v * 90}px` }}
              />
            ))}
          </div>
        </div>
        {/* Top row: info + controls */}
        <div className="music-activity__expanded-row">
          <div className="music-activity__info">
            <span className="music-activity__name" title={title}>
              {title}
            </span>
            <span className="music-activity__artist" title={subtitle}>
              {subtitle}
            </span>
          </div>
          <div className="music-activity__controls">
            {canPrev && (
              <button
                className="music-activity__btn"
                onClick={(e) => { e.stopPropagation(); handlePrev() }}
                title={t('acestep.prev', { defaultValue: '上一首' })}
              >
                <SkipForward size={14} style={{ transform: 'scaleX(-1)' }} />
              </button>
            )}
            {activeSource ? (
              <button
                className="music-activity__btn music-activity__btn--glow"
                onClick={(e) => { e.stopPropagation(); handleTogglePlay() }}
                title={isPlaying ? t('acestep.pause', { defaultValue: '暂停' }) : t('acestep.play', { defaultValue: '播放' })}
              >
                {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              </button>
            ) : (
              <button
                className="music-activity__btn music-activity__btn--glow"
                onClick={(e) => { e.stopPropagation(); onOpenPopup() }}
                title={t('audio.island.music.browseSongs', { defaultValue: '点击展开选歌' })}
              >
                <ListMusic size={14} />
              </button>
            )}
            {canSkip && (
              <button
                className="music-activity__btn"
                onClick={(e) => { e.stopPropagation(); handleNext() }}
                title={t('acestep.next', { defaultValue: '下一首' })}
              >
                <SkipForward size={14} />
              </button>
            )}
            {/* Unified volume toggle */}
            <button
              className="music-activity__btn music-activity__btn--volume"
              onClick={(e) => { e.stopPropagation(); handleVolumeToggle() }}
              title={currentVolume > 0 ? t('audio.nowPlaying.mute') : t('audio.nowPlaying.unmute')}
            >
              {currentVolume > 0 ? <Volume2 size={13} /> : <VolumeX size={13} />}
            </button>
            {/* Lyrics toggle: only when AceStep has a song with lyrics */}
            {activeSource === 'acestep' && acestepState?.currentSong && hasLyrics && (
              <button
                className={`music-activity__btn${acestepState.showLyrics ? ' music-activity__btn--active' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleAceStepToggleLyrics() }}
                title={t('acestep.toggleLyrics', { defaultValue: '桌面歌词' })}
              >
                <ListMusic size={13} />
              </button>
            )}
            {/* Open playlist popup — pinned to right edge with margin-left: auto */}
            <button
              className="music-activity__btn music-activity__btn--expand"
              onClick={(e) => { e.stopPropagation(); onOpenPopup() }}
              title={t('audio.island.expand', { defaultValue: '展开' })}
            >
              <Maximize2 size={14} />
            </button>
          </div>
        </div>
        {/* Bottom: progress bar (full width, no overlap) */}
        {duration > 0 && (
          <div
            className={`music-activity__progress music-activity__progress--bar${progressClick ? ' music-activity__progress--clickable' : ''}`}
            onClick={progressClick}
          >
            <div
              className="music-activity__progress-fill"
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="island-layer island-layer--compact">
        {renderCompact()}
      </div>
      <div className="island-layer island-layer--expanded">
        {renderExpanded()}
      </div>
    </>
  )
}
