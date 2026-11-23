import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import {
  Music,
  Pause,
  Play,
  SkipForward,
  Volume2,
  VolumeX,
  Radio,
  AudioLines,
} from 'lucide-react'
import { listen, emit } from '@tauri-apps/api/event'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useAudioPlaybackStore } from '../../../vrm/store/audioPlaybackStore'
import { useAudioPlayback } from '../../../vrm/hooks/useAudioPlayback'
import { useAudioSpectrum, sampleSpectrum } from '../../../vrm/hooks/useAudioSpectrum'
import { useI18n } from '../../../../infrastructure/i18n'
import { useBgmPlayerStore } from '../../store/bgmPlayer'
import { aceStepService } from '../../../acestep/services/AceStepService'
import type { SongEntry } from '../../../acestep/types'
import { IslandEyes } from './IslandEyes'
import './MusicActivity.scss'

// ---- AceStep bridge types (mirrored from PlayerBridge.ts) ----
interface AceStepPlayerState {
  currentSong: {
    title: string
    artist: string
    durationSeconds: number
  } | null
  /** 真实封面路径（PlayerBridge.ts:55/150 同源，经 convertFileSrc 显示） */
  coverPath: string | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  playMode: 'sequential' | 'repeat-one' | 'repeat-all' | 'shuffle'
  playlistLength: number
  playlistIndex: number
  p2pStatus: 'connecting' | 'downloading' | 'seeding' | 'error' | null
  p2pPeerCount: number
  source: 'local' | 'share' | 'online'
  playbackState: 'idle' | 'loading' | 'playing' | 'paused' | 'ended'
  showLyrics: boolean
}

const EVENT_PLAYER_STATE = 'acestep://player-state'
const EVENT_PLAYER_COMMAND = 'acestep://player-command'

interface MusicActivityProps {
  onOpenWindow: () => void
}

export const MusicActivity: React.FC<MusicActivityProps> = ({ onOpenWindow }) => {
  const { t } = useI18n('vrm')
  const audio = useAudioPlayback()
  const masterVolume = useAudioPlaybackStore((s) => s.masterVolume)
  const setMasterVolume = useAudioPlaybackStore((s) => s.setMasterVolume)
  const radioActive = useAudioPlaybackStore((s) => s.radioActive)
  const radioStyle = useAudioPlaybackStore((s) => s.radioStyle)

  // ---- AceStep state (from cross-window event) ----
  const [acestepState, setAcestepState] = useState<AceStepPlayerState | null>(null)
  const acestepTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---- AceStep local song list (used for "browse to play" hint only) ----
  const [acestepSongs, setAcestepSongs] = useState<SongEntry[]>([])

  // ---- Fetch local AceStep songs (count only — full UI moved to the music window) ----
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
  const vrmStationName = radioActive && radioStyle ? radioStyle : t('audio.island.activity.music', { defaultValue: '音乐电台' })

  // ---- AceStep command helpers ----
  const sendAceStepCommand = useCallback(
    (action: string, payload?: Record<string, unknown>) => {
      emit(EVENT_PLAYER_COMMAND, { action, payload }).catch((e) =>
        console.warn('[MusicActivity] emit player-command failed:', e),
      )
    },
    [],
  )

  // ---- 空态一键电台 ----
  // 歌曲电台：跨窗口命令给权威端（overlay webview 的 musicSourceRadioBridge）处理，
  // 桥接内部会 requestActive('acestep') 做 BGM 仲裁。
  const startSongRadio = useCallback(() => {
    emit('music-source://radio-command', { action: 'start' }).catch((e) =>
      console.warn('[MusicActivity] start song radio failed:', e),
    )
  }, [])

  // 纯音乐电台：VRM 生成式电台，风格随机；先抢 BGM 仲裁再启动。
  const startMusicRadio = useCallback(async () => {
    await useBgmPlayerStore.getState().requestActive('vrm-radio').catch(() => {})
    await audio.startRadio('random')
  }, [audio])

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

  // ========================================================================
  // Compact layer — spectrum bg + icon + time
  // ========================================================================
  const renderCompact = () => {
    const isPlaying = activeSource === 'acestep' ? acestepIsPlaying : vrmIsPlaying
    const currentTime = activeSource === 'acestep' ? (acestepState?.currentTime ?? 0) : (bgmChannel?.position_secs ?? 0)
    const mirrored = [...compactBands].reverse()
    const empty = !activeSource
    return (
      <div className={`music-activity music-activity--compact${empty ? ' music-activity--empty' : ''}`}>
        {!empty && (
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
        )}
        {/* 机器人眼睛替换原音符图标（RoboEyes 风格 SVG，播放时笑眼） */}
        <IslandEyes playing={isPlaying} />
        {isPlaying && (
          <span className="music-activity__mini-time">
            {formatTime(currentTime)}
          </span>
        )}
      </div>
    )
  }

  // ========================================================================
  // Expanded layer — music row: info + controls, progress pinned to row bottom
  // ========================================================================
  const renderExpanded = () => {
    // Resolve title/subtitle/progress/onClick based on active source
    // 空态只保留一行状态文案（主按钮已是曲库入口），副标题留白
    let title = t('audio.island.music.browseToPlay', { defaultValue: '未在播放' })
    let subtitle = ''
    let isPlaying = false
    let canSkip = false
    let canPrev = false

    if (activeSource === 'acestep' && acestepState) {
      if (acestepState.currentSong) {
        title = acestepState.currentSong.title
        subtitle = `${acestepState.currentSong.artist} · ${acestepState.isPlaying ? t('audio.island.music.playing', { defaultValue: '播放中' }) : t('audio.island.music.paused', { defaultValue: '已暂停' })}`
        isPlaying = acestepState.isPlaying
        canSkip = true
        canPrev = true
      } else {
        title = t('audio.island.music.browseSongs', { defaultValue: '打开曲库' })
        subtitle = `${t('acestep.library', { defaultValue: '作品库' })} (${acestepSongs.length})`
      }
    } else if (activeSource === 'vrm' && bgmChannel) {
      title = vrmStationName
      subtitle = `${t('audio.island.music.radio', { defaultValue: '电台' })} · ${vrmIsPlaying ? t('audio.island.music.playing', { defaultValue: '播放中' }) : t('audio.island.music.paused', { defaultValue: '已暂停' })}`
      isPlaying = vrmIsPlaying
      canSkip = true
      canPrev = false
    } else {
      title = t('audio.island.music.browseToPlay', { defaultValue: '未在播放' })
      subtitle = ''
    }

    // Unified volume state for the toggle icon
    const currentVolume = activeSource === 'acestep' ? (acestepState?.volume ?? 0) : masterVolume
    // 真实封面（AceStep 有 coverPath 时显示，否则回退音符图标）
    const coverUrl =
      activeSource === 'acestep' && acestepState?.coverPath
        ? convertFileSrc(acestepState.coverPath)
        : null

    const empty = !activeSource
    return (
      <div
        className={`music-activity music-activity--expanded music-activity--clickable${empty ? ' music-activity--empty' : ''}`}
        onClick={(e) => { e.stopPropagation(); onOpenWindow() }}
        title={t('audio.island.expand', { defaultValue: '打开音乐窗口' })}
      >
        {!empty && (
        <div className="music-activity__spectrum-bg">
          <div className="music-activity__spectrum-bg-col music-activity__spectrum-bg-col--left">
            {expandedMirrored.map((v, i) => (
              <div
                key={i}
                className="music-activity__spectrum-bg-bar"
                style={{ height: `${2 + v * 18}px` }}
              />
            ))}
          </div>
          <div className="music-activity__spectrum-bg-col music-activity__spectrum-bg-col--right">
            {expandedBgBands.map((v, i) => (
              <div
                key={i}
                className="music-activity__spectrum-bg-bar"
                style={{ height: `${2 + v * 18}px` }}
              />
            ))}
          </div>
        </div>
        )}
        {/* Main line: 封面（仅播放态）+ info + 音量 + 播放控制 */}
        <div className="music-activity__main">
          {/* 播放态显示封面图（方形），空态不显示任何图标位 */}
          {!empty && (
            <div className={`music-activity__cover${isPlaying ? ' music-activity__cover--playing' : ''}`}>
              {coverUrl ? (
                <img src={coverUrl} alt="" draggable={false} className="music-activity__cover-img" />
              ) : (
                <Music size={16} />
              )}
            </div>
          )}
          <div className="music-activity__info">
            <span className="music-activity__name" title={title}>
              {title}
            </span>
            <span className="music-activity__artist" title={subtitle}>
              {subtitle}
            </span>
          </div>
          <div className="music-activity__playback">
            {/* 音量按钮从 sub 行上移到这里（点击不触发整块开窗） */}
            <button
              className="music-activity__btn music-activity__btn--volume"
              onClick={(e) => { e.stopPropagation(); handleVolumeToggle() }}
              title={currentVolume > 0 ? t('audio.nowPlaying.mute') : t('audio.nowPlaying.unmute')}
            >
              {currentVolume > 0 ? <Volume2 size={13} /> : <VolumeX size={13} />}
            </button>
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
                className="music-activity__btn music-activity__btn--play"
                onClick={(e) => { e.stopPropagation(); handleTogglePlay() }}
                title={isPlaying ? t('acestep.pause', { defaultValue: '暂停' }) : t('acestep.play', { defaultValue: '播放' })}
              >
                {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              </button>
            ) : (
              <>
                <button
                  className="music-activity__btn music-activity__btn--radio"
                  onClick={(e) => { e.stopPropagation(); startSongRadio() }}
                  title={t('audio.island.radio.song', { defaultValue: '歌曲电台' })}
                >
                  <Radio size={14} />
                </button>
                <button
                  className="music-activity__btn music-activity__btn--radio music-activity__btn--play"
                  onClick={(e) => { e.stopPropagation(); void startMusicRadio() }}
                  title={t('audio.island.radio.music', { defaultValue: '纯音乐电台' })}
                >
                  <AudioLines size={14} />
                </button>
              </>
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
          </div>
        </div>
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
