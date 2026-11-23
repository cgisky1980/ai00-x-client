import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import {
  Music,
  Pause,
  Play,
  SkipForward,
  Volume2,
  VolumeX,
  Music2,
  Piano,
  Loader2,
  Heart,
  ListMusic,
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
import { usePlayerStore } from '../../../acestep/store/playerStore'
import { useMusicSourceStore } from '../../../music-source/musicSourceStore'
import { useFavoritesStore } from '../../../music-source/favoritesStore'
import { songKey } from '../../../music-source/types'
import type { OnlineSong } from '../../../music-source/types'
import { publishWindowMessage, subscribeWindowMessage } from '../../../../infrastructure/windows/windowBus'
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
  /** 当前在线歌 songKey（收藏判定用） */
  currentOnlineId: string | null
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

  // ---- 空态模式选择：'song' 歌曲电台 / 'music' 纯音乐电台（互斥，默认歌曲）----
  const [mode, setMode] = useState<'song' | 'music'>('song')
  // 电台启动中（拉池/解析/生成有延迟，给即时反馈避免"点了没反应"）
  const [starting, setStarting] = useState(false)
  // 进度条拖动：拖动中用本地比例预览，松手才真正 seek
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubRatio, setScrubRatio] = useState(0)

  // ---- 收藏状态：favoritesStore 内存可能陈旧，用 tick 强制重算 ----
  const [favTick, setFavTick] = useState(0)
  useEffect(() => {
    // 音乐窗口 toggle 收藏后广播，岛重算红心（localStorage 同源共享）
    const unsub = subscribeWindowMessage((msg) => {
      if (msg.type === 'favorites:changed') setFavTick((v) => v + 1)
    })
    return unsub
  }, [])

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

  // 空态播放：按当前选中的模式启动对应电台
  // 歌曲电台→跨窗口命令给权威端桥接；纯音乐电台→VRM 生成式（风格随机）
  // 启动是异步的（拉池/解析/生成），点后先进入 starting 态给即时反馈。
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleEmptyPlay = useCallback(async () => {
    if (starting) return
    setStarting(true)
    const finish = () => {
      setStarting(false)
      if (startTimerRef.current) { clearTimeout(startTimerRef.current); startTimerRef.current = null }
    }
    // 兜底：20s 后无论是否成功都退出 starting（生成式电台首次可能较慢/失败）
    startTimerRef.current = setTimeout(finish, 20000)

    try {
      if (mode === 'song') {
        emit('music-source://radio-command', { action: 'start' }).catch((e) => {
          console.warn('[MusicActivity] start song radio failed:', e)
          finish()
        })
      } else {
        await useBgmPlayerStore.getState().requestActive('vrm-radio').catch(() => {})
        await audio.startRadio('random')
        // VRM 电台 startRadio 返回即已开始，无需等 activeSource
        finish()
      }
    } catch {
      finish()
    }
  }, [mode, audio, starting])

  // 检测到播放真正开始（activeSource 出现）→ 结束 starting
  useEffect(() => {
    if (starting && activeSource) {
      setStarting(false)
      if (startTimerRef.current) { clearTimeout(startTimerRef.current); startTimerRef.current = null }
    }
  }, [starting, activeSource])

  useEffect(() => () => {
    if (startTimerRef.current) clearTimeout(startTimerRef.current)
  }, [])

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

  // ---- 收藏（在线歌/电台歌；local/share 不在此数据域）----
  // favoritesStore 内存可能与音乐窗口不同步，判定直接读同源 localStorage 更准。
  const readFavored = useCallback((key: string): boolean => {
    try {
      const raw = localStorage.getItem('musicSource.favorites.v1')
      if (!raw) return false
      const arr = JSON.parse(raw) as OnlineSong[]
      return Array.isArray(arr) && arr.some((s) => songKey(s) === key)
    } catch { return false }
  }, [])

  const favoriteSong = useMemo((): OnlineSong | null => {
    void favTick
    if (activeSource === 'vrm') return useMusicSourceStore.getState().radioCurrentSong ?? null
    const onlineId = acestepState?.currentOnlineId
    if (!onlineId) return null
    const ps = usePlayerStore.getState()
    const item = ps.playlist[ps.currentIndex]
    if (item?.kind === 'online') return item.song
    return useFavoritesStore.getState().findByKey(onlineId)
  }, [activeSource, acestepState?.currentOnlineId, favTick])
  const canFavorite = !!favoriteSong
  const isFavored = !!favoriteSong && readFavored(songKey(favoriteSong))

  const handleToggleFavorite = useCallback(() => {
    if (!favoriteSong) return
    useFavoritesStore.getState().toggleFavorite(favoriteSong)
    setFavTick((v) => v + 1)
    // 通知音乐窗口重新加载它的 favoritesStore 内存镜像
    publishWindowMessage('favorites:changed')
  }, [favoriteSong])

  const handleToggleLyrics = useCallback(() => {
    sendAceStepCommand('toggleLyrics')
  }, [sendAceStepCommand])

  // ---- 进度条拖动 ----
  // 只有 aceStep 在线/本地源可 seek（VRM 电台无 seek API）
  const canSeek = activeSource === 'acestep' && !!acestepState && acestepState.duration > 0
  const ratioFromEvent = (clientX: number, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }
  const handleScrubStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canSeek) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setScrubbing(true)
    setScrubRatio(ratioFromEvent(e.clientX, e.currentTarget))
  }
  const handleScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return
    setScrubRatio(ratioFromEvent(e.clientX, e.currentTarget))
  }
  const handleScrubEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return
    e.stopPropagation()
    const ratio = ratioFromEvent(e.clientX, e.currentTarget)
    setScrubbing(false)
    if (canSeek && acestepState) {
      sendAceStepCommand('seek', { time: ratio * acestepState.duration })
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
    const progress =
      activeSource === 'acestep' && acestepState && acestepState.duration > 0
        ? (acestepState.currentTime / acestepState.duration) * 100
        : activeSource === 'vrm' && bgmChannel && bgmChannel.duration_secs > 0
          ? (bgmChannel.position_secs / bgmChannel.duration_secs) * 100
          : 0

    if (empty) {
      // 空态：一条横向迷你控制条——左侧歌曲/纯音乐互斥选择(默认歌曲)，
      // 右侧播放键。一行两端分布铺满岛宽，避免上下散乱和大片空白。
      return (
        <div
          className="music-activity music-activity--expanded music-activity--empty"
          onClick={(e) => { e.stopPropagation(); onOpenWindow() }}
        >
          <div className="music-activity__empty-bar">
            <div className="music-activity__mode-switch">
              <button
                className={`music-activity__mode-btn${mode === 'song' ? ' is-active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setMode('song') }}
                title={t('audio.island.radio.song', { defaultValue: '歌曲电台' })}
              >
                <Music2 size={17} />
              </button>
              <button
                className={`music-activity__mode-btn${mode === 'music' ? ' is-active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setMode('music') }}
                title={t('audio.island.radio.music', { defaultValue: '纯音乐电台' })}
              >
                <Piano size={17} />
              </button>
            </div>
            <button
              className={`music-activity__btn music-activity__btn--play${starting ? ' is-starting' : ''}`}
              onClick={(e) => { e.stopPropagation(); void handleEmptyPlay() }}
              disabled={starting}
              title={starting
                ? t('audio.island.music.starting', { defaultValue: '启动中' })
                : t('acestep.play', { defaultValue: '播放' })}
            >
              {starting ? <Loader2 size={15} className="music-activity__spin" /> : <Play size={15} />}
            </button>
          </div>
        </div>
      )
    }

    return (
      <div
        className="music-activity music-activity--expanded music-activity--clickable music-activity--player"
        onClick={(e) => { e.stopPropagation(); onOpenWindow() }}
        title={t('audio.island.expand', { defaultValue: '打开音乐窗口' })}
      >
        {/* 第一行：封面 + 歌名/歌手 + 右侧收藏/歌词/音量 */}
        <div className="music-activity__main">
          <div className={`music-activity__cover${isPlaying ? ' music-activity__cover--playing' : ''}`}>
            {coverUrl ? (
              <img src={coverUrl} alt="" draggable={false} className="music-activity__cover-img" />
            ) : (
              <div className="music-activity__cover-placeholder">
                <Music size={16} />
              </div>
            )}
          </div>
          <div className="music-activity__info">
            <span className="music-activity__name" title={title}>{title}</span>
            <span className="music-activity__artist" title={subtitle}>{subtitle}</span>
          </div>
          <div className="music-activity__actions">
            {canFavorite && (
              <button
                className={`music-activity__btn music-activity__btn--fav${isFavored ? ' is-favored' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleToggleFavorite() }}
                title={t('audio.nowPlaying.favorite', { defaultValue: '收藏' })}
              >
                <Heart size={14} fill={isFavored ? 'currentColor' : 'none'} />
              </button>
            )}
            <button
              className={`music-activity__btn${acestepState?.showLyrics ? ' is-active' : ''}`}
              onClick={(e) => { e.stopPropagation(); handleToggleLyrics() }}
              title={t('acestep.toggleLyrics', { defaultValue: '桌面歌词' })}
            >
              <ListMusic size={14} />
            </button>
            <button
              className="music-activity__btn music-activity__btn--volume"
              onClick={(e) => { e.stopPropagation(); handleVolumeToggle() }}
              title={currentVolume > 0 ? t('audio.nowPlaying.mute') : t('audio.nowPlaying.unmute')}
            >
              {currentVolume > 0 ? <Volume2 size={13} /> : <VolumeX size={13} />}
            </button>
          </div>
        </div>

        {/* 第二行：音柱背景（底边对齐进度条）+ 可拖动进度条 */}
        <div className="music-activity__track">
          <div className="music-activity__spectrum-bg" aria-hidden="true">
            <div className="music-activity__spectrum-bg-col music-activity__spectrum-bg-col--left">
              {expandedMirrored.map((v, i) => (
                <div key={i} className="music-activity__spectrum-bg-bar" style={{ height: `${2 + v * 18}px` }} />
              ))}
            </div>
            <div className="music-activity__spectrum-bg-col music-activity__spectrum-bg-col--right">
              {expandedBgBands.map((v, i) => (
                <div key={i} className="music-activity__spectrum-bg-bar" style={{ height: `${2 + v * 18}px` }} />
              ))}
            </div>
          </div>
          <div
            className={`music-activity__progress music-activity__progress--bar${canSeek ? ' music-activity__progress--clickable' : ''}${scrubbing ? ' is-scrubbing' : ''}`}
            onPointerDown={handleScrubStart}
            onPointerMove={handleScrubMove}
            onPointerUp={handleScrubEnd}
            onPointerCancel={handleScrubEnd}
          >
            <div
              className="music-activity__progress-fill"
              style={{ width: `${Math.min(100, scrubbing ? scrubRatio * 100 : progress)}%` }}
            />
            {scrubbing && (
              <div className="music-activity__progress-thumb" style={{ left: `${Math.min(100, scrubRatio * 100)}%` }} />
            )}
          </div>
        </div>

        {/* 第三行：底部居中播放控制 */}
        <div className="music-activity__controls">
          {canPrev && (
            <button className="music-activity__btn" onClick={(e) => { e.stopPropagation(); handlePrev() }}>
              <SkipForward size={14} style={{ transform: 'scaleX(-1)' }} />
            </button>
          )}
          <button
            className="music-activity__btn music-activity__btn--play"
            onClick={(e) => { e.stopPropagation(); handleTogglePlay() }}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          {canSkip && (
            <button className="music-activity__btn" onClick={(e) => { e.stopPropagation(); handleNext() }}>
              <SkipForward size={14} />
            </button>
          )}
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
