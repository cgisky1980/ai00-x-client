import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Music,
  Pause,
  Play,
  SkipForward,
  Volume2,
  VolumeX,
  Radio,
  Headphones,
  Repeat,
  Repeat1,
  Shuffle,
  ListOrdered,
  ListMusic,
  Globe,
  Loader2,
  X,
  GripVertical,
  Share2,
  Trash2,
  Pencil,
  Sparkles,
  Heart,
  ThumbsDown,
  RefreshCw,
  Copy,
  HardDrive,
  Square,
  Plus,
} from 'lucide-react'
import { listen, emit } from '@tauri-apps/api/event'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { useAudioPlaybackStore, RADIO_PRESETS } from '../../../vrm/store/audioPlaybackStore'
import { useAudioPlayback } from '../../../vrm/hooks/useAudioPlayback'
import { useIslandStore } from '../../store/islandStore'
import { useI18n } from '../../../../infrastructure/i18n'
import { useDraggable } from '../../../../infrastructure/overlay/useDraggable'
import { usePopupResize } from '../../hooks/usePopupResize'
import { aceStepService } from '../../../acestep/services/AceStepService'
import { shareService } from '../../../acestep/services/ShareService'
import { useShareCover } from '../../../acestep/hooks/useShareCover'
import { useBgmPlayerStore } from '../../store/bgmPlayer'
import { useShareStore } from '../../../acestep/store/shareStore'
import { usePlayerStore } from '../../../acestep/store/playerStore'
import { useP2pStore } from '../../../acestep/store/p2pStore'
import { useProfileStore, parseSongTags } from '../../../acestep/store/profileStore'
import { useRecommendStore } from '../../../acestep/store/recommendStore'
import { useMusicSourceStore } from '../../../music-source/musicSourceStore'
import { useFavoritesStore } from '../../../music-source/favoritesStore'
import { songKey, sourceDisplayName, formatDuration } from '../../../music-source/types'
import type { OnlineSong } from '../../../music-source/types'
import type { PlaylistItem } from '../../../acestep/store/playerStore'
import { confirmDanger } from '../../../../component-library'
import { ArchiveShareDialog } from '../../../acestep/components/ArchiveShareDialog'
import { SongMetaEditDialog } from '../../../acestep/components/SongMetaEditDialog'
import type { SongEntry } from '../../../acestep/types'
import type { SharedSongListItem, ShareMeta } from '../../../acestep/services/ShareService'
import type { P2pProgress } from '../../../acestep/services/P2PClient'
import './MusicPopup.scss'

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
  error: string | null
  p2pDownloadingShareId: string | null
  p2pDownloadPercent: number | null
  source: 'local' | 'share' | 'online'
  playbackState: 'idle' | 'loading' | 'playing' | 'paused' | 'ended'
  showLyrics: boolean
  currentShareId: string | null
  currentOnlineId: string | null
  currentEntryPath: string | null
}

const EVENT_PLAYER_STATE = 'acestep://player-state'
const EVENT_PLAYER_COMMAND = 'acestep://player-command'

type PlayMode = AceStepPlayerState['playMode']

// ============================================================================
// CommunityCard — single community share row with cover thumbnail.
// ============================================================================
const CommunityCard: React.FC<{
  share: SharedSongListItem
  isPlaying: boolean
  isLoading: boolean
  /** 该歌曲在 p2pStore 中的实时进度（下载中/做种，无则 undefined） */
  p2pProgress?: P2pProgress
  onPlay: (shareId: string) => void
  formatPlays: (n: number) => string
  formatBytes: (n: number) => string
}> = ({ share, isPlaying, isLoading, p2pProgress, onPlay, formatPlays, formatBytes }) => {
  const { t } = useI18n('vrm')
  const coverUrl = useShareCover(share.shareId, share.coverUrl)
  const isDownloading = p2pProgress != null && (p2pProgress.status === 'downloading' || p2pProgress.status === 'connecting')
  const isSeeding = p2pProgress?.status === 'seeding'
  const downloadPercent = p2pProgress?.percent ?? 0
  return (
    <div className={`music-popup__community-card${isPlaying ? ' is-current' : ''}`}>
      <button
        type="button"
        className="music-popup__community-main"
        onClick={(e) => { e.stopPropagation(); onPlay(share.shareId) }}
        title={`${share.title} — ${share.artistName ?? share.authorName}`}
      >
        <span className="music-popup__community-cover">
          {coverUrl === undefined ? (
            <Loader2 size={14} className="is-spinning" />
          ) : coverUrl ? (
            <img src={coverUrl} alt="" loading="lazy" />
          ) : (
            <Music size={14} />
          )}
          {isPlaying && (
            <span className="music-popup__cover-overlay">
              {<Pause size={10} />}
            </span>
          )}
        </span>
        <span className="music-popup__community-meta">
          <span className="music-popup__community-title" title={share.title}>
            {share.title}
          </span>
          <span className="music-popup__community-artist" title={share.artistName ?? share.authorName}>
            {share.artistName ?? share.authorName}
          </span>
        </span>
        <span className="music-popup__community-plays">
          <Play size={9} />
          {formatPlays(share.playCount)}
        </span>
        <span className="music-popup__community-action">
          {isLoading ? (
            <Loader2 size={14} className="is-spinning" />
          ) : isDownloading ? (
            <span className="music-popup__community-download-pct">
              {Math.round(downloadPercent * 100)}%
            </span>
          ) : isPlaying ? (
            <Pause size={14} />
          ) : (
            <Play size={14} />
          )}
        </span>
      </button>
      <span className="music-popup__community-extra">
        {isDownloading && (
          <span className="music-popup__community-rate" title={p2pProgress ? `${formatBytes(p2pProgress.downloadRate)}/s` : ''}>
            {p2pProgress && p2pProgress.downloadRate > 0 ? `${formatBytes(p2pProgress.downloadRate)}/s` : ''}
            {p2pProgress && p2pProgress.peerCount > 0 ? ` · ${p2pProgress.peerCount} 节点` : ''}
          </span>
        )}
        {isSeeding && (
          <span className="music-popup__community-rate music-popup__community-rate--seeding" title={p2pProgress ? `${formatBytes(p2pProgress.uploadRate)}/s · 累计 ${formatBytes(p2pProgress.uploaded)}` : ''}>
            {t('acestep.p2p.seeding', { defaultValue: '做种中' })}
            {p2pProgress && p2pProgress.uploadRate > 0 ? ` · ${formatBytes(p2pProgress.uploadRate)}/s` : ''}
          </span>
        )}
      </span>
      {isDownloading && (
        <span className="music-popup__community-progress">
          <span
            className="music-popup__community-progress-fill"
            style={{ width: `${Math.min(100, Math.max(0, downloadPercent * 100))}%` }}
          />
        </span>
      )}
    </div>
  )
}

// ============================================================================
// RecommendCard — CommunityCard + like/dislike buttons for personalized feed.
// ============================================================================
const RecommendCard: React.FC<{
  share: SharedSongListItem
  isPlaying: boolean
  isLoading: boolean
  isLiked: boolean
  isDisliked: boolean
  onPlay: (shareId: string) => void
  onLike: () => void
  onDislike: () => void
  formatPlays: (n: number) => string
}> = ({ share, isPlaying, isLoading, isLiked, isDisliked, onPlay, onLike, onDislike, formatPlays }) => {
  const coverUrl = useShareCover(share.shareId, share.coverUrl)
  return (
    <div
      className={`music-popup__community-card music-popup__recommend-card${isPlaying ? ' is-current' : ''}`}
      title={`${share.title} — ${share.artistName ?? share.authorName}`}
    >
      <button
        type="button"
        className="music-popup__recommend-play"
        onClick={(e) => { e.stopPropagation(); onPlay(share.shareId) }}
      >
        <span className="music-popup__community-cover">
          {coverUrl === undefined ? (
            <Loader2 size={14} className="is-spinning" />
          ) : coverUrl ? (
            <img src={coverUrl} alt="" loading="lazy" />
          ) : (
            <Music size={14} />
          )}
          {isPlaying && (
            <span className="music-popup__cover-overlay">
              {<Pause size={10} />}
            </span>
          )}
        </span>
        <span className="music-popup__community-meta">
          <span className="music-popup__community-title" title={share.title}>
            {share.title}
          </span>
          <span className="music-popup__community-artist" title={share.artistName ?? share.authorName}>
            {share.artistName ?? share.authorName}
          </span>
        </span>
        <span className="music-popup__community-plays">
          <Play size={9} />
          {formatPlays(share.playCount)}
        </span>
        <span className="music-popup__community-action">
          {isLoading ? (
            <Loader2 size={14} className="is-spinning" />
          ) : isPlaying ? (
            <Pause size={14} />
          ) : (
            <Play size={14} />
          )}
        </span>
      </button>
      <span className="music-popup__recommend-actions">
        <button
          type="button"
          className={`music-popup__recommend-action${isLiked ? ' is-active' : ''}`}
          onClick={(e) => { e.stopPropagation(); onLike() }}
          onMouseDown={(e) => e.stopPropagation()}
          title={isLiked ? '取消喜欢' : '喜欢'}
        >
          <Heart size={12} fill={isLiked ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          className={`music-popup__recommend-action${isDisliked ? ' is-active' : ''}`}
          onClick={(e) => { e.stopPropagation(); onDislike() }}
          onMouseDown={(e) => e.stopPropagation()}
          title={isDisliked ? '取消不喜欢' : '不喜欢'}
        >
          <ThumbsDown size={12} />
        </button>
      </span>
    </div>
  )
}

export const MusicPopup: React.FC = () => {
  const { t } = useI18n('vrm')
  const audio = useAudioPlayback()
  const closePopup = useIslandStore((s) => s.closePopup)
  const playMode = useAudioPlaybackStore((s) => s.playMode)
  const setPlayMode = useAudioPlaybackStore((s) => s.setPlayMode)
  const masterVolume = useAudioPlaybackStore((s) => s.masterVolume)
  const setMasterVolume = useAudioPlaybackStore((s) => s.setMasterVolume)
  const radioActive = useAudioPlaybackStore((s) => s.radioActive)
  const radioStyle = useAudioPlaybackStore((s) => s.radioStyle)

  // ---- Active sidebar section (left menu) ----
  type Section = 'radio' | 'local' | 'community' | 'recommend' | 'seeding' | 'online' | 'favorites'
  const [activeSection, setActiveSection] = useState<Section>('radio')

  // ---- Open the task window and switch to the music creation (AceStep) scene ----
  const handleOpenCreator = useCallback(() => {
    window.dispatchEvent(new CustomEvent('scene:open', { detail: { sceneId: 'acestep' } }))
  }, [])

  // ---- Draggable, non-modal popup ----
  // Initial position: centered horizontally below the dynamic island
  const POPUP_WIDTH = 600
  const POPUP_HEIGHT = 480
  const POPUP_MIN_WIDTH = 480
  const POPUP_MIN_HEIGHT = 360
  const POPUP_INITIAL_X = Math.max(8, (window.innerWidth - POPUP_WIDTH) / 2)
  const POPUP_INITIAL_Y = 56
  const { position, setPosition, elementRef, handleMouseDown, isDragging } = useDraggable({
    initialPosition: { x: POPUP_INITIAL_X, y: POPUP_INITIAL_Y },
    excludeSelector: 'button, input, .music-popup__close, .music-popup__nav-item, .music-popup__volume-slider, .music-popup__progress, .music-popup__resize-handle',
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

  // ---- AceStep state (from cross-window event) ----
  const [acestepState, setAcestepState] = useState<AceStepPlayerState | null>(null)
  const acestepTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---- AceStep local song list ----
  const [acestepSongs, setAcestepSongs] = useState<SongEntry[]>([])
  const [acestepSongsLoading, setAcestepSongsLoading] = useState(false)
  const [coverPaths, setCoverPaths] = useState<Record<string, string | null>>({})

  // ---- Community shares ----
  const [communityShares, setCommunityShares] = useState<SharedSongListItem[]>([])
  const [communityLoading, setCommunityLoading] = useState(false)
  const [loadingShareId, setLoadingShareId] = useState<string | null>(null)
  // v1.3.0+: Track current share ID for footer like/dislike buttons
  const [currentShareId, setCurrentShareId] = useState<string | null>(null)

  // ---- Library management (moved from LibraryView) ----
  const [shareDialogEntry, setShareDialogEntry] = useState<SongEntry | null>(null)
  const [editDialogEntry, setEditDialogEntry] = useState<SongEntry | null>(null)
  const [deletingPath, setDeletingPath] = useState<string | null>(null)
  const archiveShareMap = useShareStore((s) => s.archiveShareMap)
  const removeArchiveMapping = useShareStore((s) => s.removeArchiveMapping)

  const prevVolumeRef = useRef(0.8)

  // ---- 在线音源（musicdl sidecar）----
  const msPhase = useMusicSourceStore((s) => s.phase)
  const msEnsureReady = useMusicSourceStore((s) => s.ensureReady)
  const [loadingOnlineId, setLoadingOnlineId] = useState<string | null>(null)

  // ---- 播放列表（队列）面板：同窗口直读 playerStore ----
  const [queueOpen, setQueueOpen] = useState(false)
  const queuePlaylist = usePlayerStore((s) => s.playlist)
  const queueIndex = usePlayerStore((s) => s.currentIndex)
  const queueJumpTo = usePlayerStore((s) => s.jumpTo)
  const queueRemove = usePlayerStore((s) => s.removeFromPlaylist)
  const queueClear = usePlayerStore((s) => s.clearPlaylist)
  const queueAppend = usePlayerStore((s) => s.appendToPlaylist)

  const msRadioActive = useMusicSourceStore((s) => s.radioActive)
  const msRadioCurrent = useMusicSourceStore((s) => s.radioCurrent)
  const msRadioCurrentSong = useMusicSourceStore((s) => s.radioCurrentSong)
  const msStartRadio = useMusicSourceStore((s) => s.startRadio)
  const msRadioNext = useMusicSourceStore((s) => s.radioNext)
  const msStopRadio = useMusicSourceStore((s) => s.stopRadio)

  // ---- 在线歌曲收藏 ----
  const favorites = useFavoritesStore((s) => s.favorites)
  const favoritesToggle = useFavoritesStore((s) => s.toggleFavorite)
  const favoritesRemove = useFavoritesStore((s) => s.removeFavorite)

  // ---- v1.3.0+: Profile + Recommend stores ----
  const profile = useProfileStore((s) => s.profile)
  const profileToggleLike = useProfileStore((s) => s.toggleLike)
  const profileToggleDislike = useProfileStore((s) => s.toggleDislike)

  // ---- 统一收藏：社区音乐（share）喜欢的元数据（按需逐个 getMeta） ----
  const [likedShareMetas, setLikedShareMetas] = useState<Record<string, ShareMeta | null>>({})
  const likedMetaInflight = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (activeSection !== 'favorites') return
    const missing = profile.likedIds.filter(
      (id) => !(id in likedShareMetas) && !likedMetaInflight.current.has(id),
    )
    if (missing.length === 0) return
    missing.forEach((id) => likedMetaInflight.current.add(id))
    void (async () => {
      const CONCURRENCY = 4
      let cursor = 0
      const workers = Array.from({ length: Math.min(CONCURRENCY, missing.length) }, async () => {
        while (cursor < missing.length) {
          const id = missing[cursor++]
          try {
            const meta = await shareService.getMeta(id)
            setLikedShareMetas((prev) => ({ ...prev, [id]: meta }))
          } catch {
            setLikedShareMetas((prev) => ({ ...prev, [id]: null })) // 失败占位，不再重试
          } finally {
            likedMetaInflight.current.delete(id)
          }
        }
      })
      await Promise.all(workers)
    })()
  }, [activeSection, profile.likedIds, likedShareMetas])
  /** 社区喜欢（可展示的）：ShareMeta 补 authorName 适配列表项类型（tags 未知，播放采集退化为无标签） */
  const likedShareItems = useMemo<SharedSongListItem[]>(
    () => profile.likedIds
      .map((id) => likedShareMetas[id])
      .filter((m): m is ShareMeta => !!m)
      .map((m) => ({ ...m, authorName: '' })),
    [profile.likedIds, likedShareMetas],
  )
  const recommendItems = useRecommendStore((s) => s.recommendations)
  const recommendLoading = useRecommendStore((s) => s.loading)
  const recommendError = useRecommendStore((s) => s.error)
  const recommendSource = useRecommendStore((s) => s.source)
  const recommendIsStale = useRecommendStore((s) => s.isStale)
  const recommendRefresh = useRecommendStore((s) => s.refresh)

  // ---- P2P store（队列 / 进度 / 做种 / 缓存管理）----
  const p2pQueue = useP2pStore((s) => s.queue)
  const p2pProgressMap = useP2pStore((s) => s.progressMap)
  const p2pSeeding = useP2pStore((s) => s.seeding)
  const p2pCacheStats = useP2pStore((s) => s.cacheStats)
  const p2pActive = useP2pStore((s) => s.active)
  const p2pRemoveShare = useP2pStore((s) => s.removeShare)
  const p2pRefreshCacheStats = useP2pStore((s) => s.refreshCacheStats)
  const p2pClearCache = useP2pStore((s) => s.clearCache)

  // ---- Fetch local AceStep songs + covers ----
  const fetchAcestepSongs = useCallback(async () => {
    setAcestepSongsLoading(true)
    try {
      const [list, songsDir] = await Promise.all([
        aceStepService.listSongs(),
        aceStepService.getSongsDir(),
      ])
      setAcestepSongs(list)
      const entries = await Promise.all(
        list.map(async (entry) => {
          try {
            const stem = entry.filename.replace(/\.a00m$/i, '')
            const cacheDir = `${songsDir}/.cache/${stem.replace(/[\\/]/g, '_')}`
            const coverPath = await aceStepService.extractCover(entry.path, cacheDir)
            return [entry.path, coverPath] as const
          } catch {
            return [entry.path, null] as const
          }
        }),
      )
      const map: Record<string, string | null> = {}
      for (const [p, c] of entries) map[p] = c
      setCoverPaths(map)
    } catch (e) {
      console.warn('[MusicPopup] failed to list AceStep songs:', e)
    } finally {
      setAcestepSongsLoading(false)
    }
  }, [])

  // ---- Load community shares ----
  const loadCommunity = useCallback(async () => {
    setCommunityLoading(true)
    try {
      const result = await shareService.listRecent(50)
      setCommunityShares(result.songs)
    } catch (e) {
      console.warn('[MusicPopup] failed to load community shares:', e)
    } finally {
      setCommunityLoading(false)
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

  // ---- Load songs on mount ----
  useEffect(() => {
    void fetchAcestepSongs()
    void loadCommunity()
  }, [fetchAcestepSongs, loadCommunity])

  // ---- v1.3.0+: Refresh recommendations when switching to recommend tab ----
  // Auto-refresh on first visit or when cache is stale (>30min).
  useEffect(() => {
    if (activeSection === 'recommend' && recommendIsStale()) {
      void recommendRefresh()
    }
  }, [activeSection, recommendIsStale, recommendRefresh])

  // ---- musicdl：切到在线音源 section 时确保 sidecar 就绪（幂等）----
  useEffect(() => {
    if (activeSection === 'online') {
      void useMusicSourceStore.getState().ensureReady().catch(() => {})
    }
  }, [activeSection])

  // ---- Clear loading state when online song starts playing ----
  useEffect(() => {
    if (acestepState?.source === 'online' && acestepState.currentSong && loadingOnlineId) {
      setLoadingOnlineId(null)
    }
  }, [acestepState?.source, acestepState?.currentSong, loadingOnlineId])

  // ---- Auto source detection ----
  const bgmChannel = audio.bgmChannel
  // acestep 与 VRM 电台共用 Bgm 通道，需以 radioActive 判定电台，避免把
  // acestep 播放误判成电台导致灵动岛在电台/音乐间跳动。
  const vrmIsPlaying = radioActive && bgmChannel?.state === 'Playing'
  const acestepIsPlaying = acestepState?.isPlaying ?? false

  // ---- Sync BgmPlayer.activeSource with AceStep state ----
  useEffect(() => {
    const bgm = useBgmPlayerStore.getState()
    if (acestepState?.isPlaying && bgm.activeSource !== 'acestep') {
      useBgmPlayerStore.setState({ activeSource: 'acestep', pendingSource: null })
    }
  }, [acestepState?.isPlaying])

  // ---- Clear loading state when share starts playing ----
  useEffect(() => {
    if (acestepState?.source === 'share' && acestepState.currentSong && loadingShareId) {
      setLoadingShareId(null)
    }
  }, [acestepState?.source, acestepState?.currentSong, loadingShareId])

  const formatTime = (secs: number): string => {
    if (!secs || !isFinite(secs)) return '0:00'
    const m = Math.floor(secs / 60)
    const s = Math.floor(secs % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const formatPlays = useCallback((n: number): string => {
    if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
    return String(n)
  }, [])

  const formatBytes = useCallback((n: number): string => {
    if (!n || !isFinite(n) || n <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let v = n
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024
      i += 1
    }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
  }, [])

  // ---- 轻量 toast（本组件内），用于「已加入队列/已复制」等反馈 ----
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!toastMsg) return
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToastMsg(null), 2200)
  }, [toastMsg])

  // ---- 播放/下载失败反馈：AceStep 播放器把错误同步到 acestepState.error，
  //      这里以 toast + 结束 loading 的方式暴露给用户（此前错误被静默吞掉）。
  const lastPlayErrorRef = useRef<string | null>(null)
  useEffect(() => {
    if (acestepState?.error && acestepState.error !== lastPlayErrorRef.current) {
      lastPlayErrorRef.current = acestepState.error
      setToastMsg(`下载/播放失败：${acestepState.error}`)
      setLoadingShareId(null)
      setCurrentShareId(null)
    }
  }, [acestepState?.error])

  // ---- P2P 磁力复制 / 做种管理 ----
  const handleStopSeeding = useCallback(
    (shareId: string, deleteFile: boolean) => {
      const display = p2pProgressMap[shareId]?.filename ?? `share-${shareId}`
      void confirmDanger(
        deleteFile
          ? t('acestep.p2p.deleteCacheConfirm', { defaultValue: '删除缓存文件' })
          : t('acestep.p2p.stopSeedingConfirm', { defaultValue: '停止做种' }),
        deleteFile
          ? t('acestep.p2p.deleteCacheConfirmMsg', { defaultValue: '确定删除本地缓存文件？将不再做种。', filename: display })
          : t('acestep.p2p.stopSeedingConfirmMsg', { defaultValue: '停止做种将保留本地文件，可随时重播续传。' }),
        { confirmText: t('confirmDelete', { defaultValue: '删除' }) },
      ).then((ok) => {
        if (!ok) return
        void p2pRemoveShare(shareId, deleteFile)
      })
    },
    [t, p2pRemoveShare, p2pProgressMap],
  )

  const handleClearAllCache = useCallback(() => {
    const perShare = p2pCacheStats?.perShare ?? []
    if (perShare.length === 0) return
    const total = p2pCacheStats?.totalBytes ?? 0
    void confirmDanger(
      t('acestep.p2p.clearCache', { defaultValue: '清空缓存' }),
      t('acestep.p2p.clearCacheMsg', {
        defaultValue: '确定清空全部缓存？将释放 {{size}} 磁盘空间（不再做种）。',
        size: formatBytes(total),
      }),
      { confirmText: t('confirmDelete', { defaultValue: '删除' }) },
    ).then((ok) => {
      if (!ok) return
      void p2pClearCache(perShare.map((p) => p.shareId), true).then(() => setToastMsg(t('acestep.p2p.cacheCleared', { defaultValue: '缓存已清空' })))
    })
  }, [t, p2pCacheStats, p2pClearCache, formatBytes])

  // ---- VRM radio computed ----
  const vrmProgress =
    bgmChannel && bgmChannel.duration_secs > 0
      ? (bgmChannel.position_secs / bgmChannel.duration_secs) * 100
      : 0
  const vrmStationName = radioActive && radioStyle
    ? radioStyle
    : t('audio.island.activity.music', { defaultValue: '音乐电台' })

  // ---- AceStep computed ----
  const acestepProgress =
    acestepState && acestepState.duration > 0
      ? (acestepState.currentTime / acestepState.duration) * 100
      : 0

  // ---- Determine active source for top bar + footer ----
  const activeSource: 'vrm' | 'acestep' | null =
    acestepState?.isPlaying ? 'acestep' : vrmIsPlaying ? 'vrm' : acestepState?.currentSong ? 'acestep' : radioActive ? 'vrm' : null

  const topBarTitle = activeSource === 'acestep'
    ? (acestepState?.currentSong?.title || t('acestep.unknownTitle', { defaultValue: '未播放' }))
    : activeSource === 'vrm'
      ? vrmStationName
      : t('audio.island.music.nothingPlaying', { defaultValue: '未播放' })

  const topBarArtist = activeSource === 'acestep'
    ? (acestepState?.currentSong?.artist || '')
    : activeSource === 'vrm'
      ? t('audio.island.music.radio', { defaultValue: '电台' })
      : ''

  const topBarProgress = activeSource === 'acestep' ? acestepProgress : vrmProgress
  const topBarDuration = activeSource === 'acestep' ? (acestepState?.duration ?? 0) : (bgmChannel?.duration_secs ?? 0)
  const topBarCurrent = activeSource === 'acestep' ? (acestepState?.currentTime ?? 0) : (bgmChannel?.position_secs ?? 0)

  // ---- AceStep command helpers ----
  const sendAceStepCommand = useCallback(
    (action: string, payload?: Record<string, unknown>) => {
      emit(EVENT_PLAYER_COMMAND, { action, payload }).catch((e) =>
        console.warn('[MusicPopup] emit player-command failed:', e),
      )
    },
    [],
  )

  const handleAceStepTogglePlay = useCallback(() => sendAceStepCommand('togglePlay'), [sendAceStepCommand])
  const handleAceStepNext = useCallback(() => sendAceStepCommand('next'), [sendAceStepCommand])
  const handleAceStepPrev = useCallback(() => sendAceStepCommand('prev'), [sendAceStepCommand])
  const handleAceStepSeek = useCallback((time: number) => sendAceStepCommand('seek', { time }), [sendAceStepCommand])
  const handleAceStepSetVolume = useCallback((volume: number) => sendAceStepCommand('setVolume', { volume }), [sendAceStepCommand])
  const handleAceStepTogglePlayMode = useCallback(() => sendAceStepCommand('togglePlayMode'), [sendAceStepCommand])
  const handleAceStepToggleLyrics = useCallback(() => sendAceStepCommand('toggleLyrics'), [sendAceStepCommand])

  const handleAceStepPlaySong = useCallback(
    async (entry: SongEntry) => {
      await useBgmPlayerStore.getState().requestActive('acestep')
      lastPlayErrorRef.current = null
      // 整页入列 + 从点击曲开始播（播放引擎与本弹窗同在主窗口，
      // 直接调 store；setPlaylist 内部 playItem 分发播放）
      const index = acestepSongs.findIndex((e) => e.path === entry.path)
      await usePlayerStore
        .getState()
        .setPlaylist(
          acestepSongs.map((e) => ({ kind: 'local' as const, entry: e })),
          Math.max(0, index),
        )
    },
    [acestepSongs],
  )

  // ---- Delete a local song (moved from LibraryView) ----
  const handleDeleteSong = useCallback(
    async (entry: SongEntry) => {
      const displayTitle = entry.meta?.title ?? entry.filename
      const shared = Boolean(archiveShareMap[entry.path])
      const ok = await confirmDanger(
        t('acestep.library.deleteConfirmTitle', { defaultValue: 'Delete song' }),
        shared
          ? t('acestep.library.deleteConfirmShared', {
              title: displayTitle,
              defaultValue: `Delete "{{title}}"? The local file will be removed and its share will be revoked.`,
            })
          : t('acestep.library.deleteConfirm', {
              title: displayTitle,
              defaultValue: `Delete "{{title}}"? The local file will be permanently removed.`,
            }),
        { confirmText: t('acestep.library.delete', { defaultValue: 'Delete' }) },
      )
      if (!ok) return

      setDeletingPath(entry.path)
      try {
        await removeArchiveMapping(entry.path, true)
        await aceStepService.deleteSong(entry.path)
        if (usePlayerStore.getState().currentEntry?.path === entry.path) {
          usePlayerStore.getState().closePlayer()
        }
      } catch (e) {
        console.warn('[MusicPopup] Failed to delete song:', e)
      } finally {
        setDeletingPath(null)
        void fetchAcestepSongs()
      }
    },
    [archiveShareMap, removeArchiveMapping, fetchAcestepSongs, t],
  )

  const handlePlayShare = useCallback(
    async (shareId: string, sourceList?: SharedSongListItem[]) => {
      // 仅当点击的是当前正在播放的分享时才 toggle（暂停/继续）；
      // 点击其他分享应切换播放，而非暂停当前歌曲。
      if (
        acestepState?.source === 'share' &&
        acestepState.isPlaying &&
        acestepState.currentShareId === shareId
      ) {
        sendAceStepCommand('togglePlay')
        return
      }
      await useBgmPlayerStore.getState().requestActive('acestep')
      lastPlayErrorRef.current = null
      setCurrentShareId(shareId)
      setLoadingShareId(shareId)
      // 整页入列（community/recommend 页传 sourceList）+ 从点击曲播；
      // 引擎与本弹窗同窗口，直接调 store
      if (sourceList && sourceList.length > 0) {
        const index = Math.max(0, sourceList.findIndex((s) => s.shareId === shareId))
        await usePlayerStore
          .getState()
          .setPlaylist(
            sourceList.map((s) => ({ kind: 'share' as const, shareId: s.shareId, meta: s })),
            index,
          )
      } else {
        await usePlayerStore.getState().setPlaylist([
          { kind: 'share', shareId, meta: undefined },
        ])
      }
      setTimeout(() => {
        setLoadingShareId((prev) => (prev === shareId ? null : prev))
      }, 12000)
    },
    [sendAceStepCommand, acestepState?.source, acestepState?.isPlaying, acestepState?.currentShareId],
  )

  // ---- musicdl：播放在线音源歌曲（songList 传当前页整页入列）----
  const handlePlayOnline = useCallback(
    async (song: OnlineSong, songList?: OnlineSong[]) => {
      const onlineId = songKey(song)
      // 点击当前正在播放的在线歌曲 → toggle 暂停/继续
      if (
        acestepState?.source === 'online' &&
        acestepState.isPlaying &&
        acestepState.currentOnlineId === onlineId
      ) {
        sendAceStepCommand('togglePlay')
        return
      }
      await useBgmPlayerStore.getState().requestActive('acestep')
      lastPlayErrorRef.current = null
      setLoadingOnlineId(onlineId)
      const list = songList && songList.length > 0 ? songList : [song]
      const index = Math.max(0, list.findIndex((s) => songKey(s) === onlineId))
      await usePlayerStore
        .getState()
        .setPlaylist(list.map((s) => ({ kind: 'online' as const, song: s })), index)
      // flac 全曲下载可能较慢，loading 超时放宽到 60s
      setTimeout(() => {
        setLoadingOnlineId((prev) => (prev === onlineId ? null : prev))
      }, 60000)
    },
    [sendAceStepCommand, acestepState?.source, acestepState?.isPlaying, acestepState?.currentOnlineId],
  )

  // ---- musicdl 电台：启动 / 下一首 / 停止 ----
  const radioStartingRef = useRef(false)
  const handleRadioToggle = useCallback(
    async () => {
      if (msRadioActive) {
        msStopRadio()
        return
      }
      if (radioStartingRef.current) return
      radioStartingRef.current = true
      try {
        await useBgmPlayerStore.getState().requestActive('acestep')
        const song = await msStartRadio()
        if (song) await handlePlayOnline(song)
      } catch (e) {
        setToastMsg(t('audio.island.music.online.radioError', {
          defaultValue: '电台启动失败：{{msg}}',
          msg: e instanceof Error ? e.message : String(e),
        }))
      } finally {
        radioStartingRef.current = false
      }
    },
    [msRadioActive, msStopRadio, msStartRadio, handlePlayOnline, t],
  )

  const handleRadioSkip = useCallback(
    async () => {
      const song = await msRadioNext()
      if (song) await handlePlayOnline(song)
      else setToastMsg(t('audio.island.music.online.radioEnd', { defaultValue: '电台已停止（暂无可播曲目）' }))
    },
    [msRadioNext, handlePlayOnline, t],
  )

  // ---- 电台播放中强制收起播放列表面板（电台不用列表） ----
  useEffect(() => {
    if (queueOpen && msRadioActive && acestepState?.source === 'online') {
      setQueueOpen(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msRadioActive, acestepState?.source])

  // ---- musicdl：加入播放列表（不切换播放）----
  const handleAddToQueue = useCallback(
    (song: OnlineSong) => {
      queueAppend([{ kind: 'online', song }])
      setToastMsg(t('audio.island.music.online.addedToQueue', { defaultValue: '已加入播放列表：{{name}}', name: song.name }))
    },
    [queueAppend, t],
  )

  // ---- musicdl：收藏切换（toast 反馈，含上限淘汰提示）----
  const handleToggleFavorite = useCallback(
    (song: OnlineSong) => {
      const result = favoritesToggle(song)
      if (result === 'added') {
        setToastMsg(t('audio.island.music.online.favoriteAdded', { defaultValue: '已收藏「{{name}}」', name: song.name }))
      } else if (result === 'evicted') {
        setToastMsg(t('audio.island.music.online.favoriteFull', { defaultValue: '收藏已满（500），最早的收藏被移除' }))
      } else {
        setToastMsg(t('audio.island.music.online.favoriteRemoved', { defaultValue: '已取消收藏' }))
      }
    },
    [favoritesToggle, t],
  )

  // ---- 播放列表（队列）行渲染 ----
  const renderQueueRow = (item: PlaylistItem, index: number) => {
    const isCurrent = index === queueIndex
    // 三种 kind 提取显示字段
    let title = ''
    let artist = ''
    let cover: string | null = null
    if (item.kind === 'local') {
      title = item.entry.meta?.title ?? item.entry.filename
      artist = item.entry.meta?.artist ?? ''
      cover = coverPaths[item.entry.path] ? convertFileSrc(coverPaths[item.entry.path]!) : null
    } else if (item.kind === 'share') {
      title = item.meta?.title ?? `分享 ${item.shareId}`
      artist = item.meta?.artistName ?? item.meta?.authorName ?? ''
    } else {
      title = item.song.name
      artist = item.song.singers
      cover = item.song.coverUrl
    }
    return (
      <div
        key={`${item.kind}-${index}`}
        className={`music-popup__queue-row${isCurrent ? ' is-current' : ''}`}
      >
        <button
          type="button"
          className="music-popup__queue-main"
          onClick={(e) => {
            e.stopPropagation()
            if (isCurrent) { handleAceStepTogglePlay() } else { void queueJumpTo(index) }
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title={`${title} — ${artist}`}
        >
          <span className="music-popup__queue-cover">
            {cover ? <img src={cover} alt="" loading="lazy" /> : <Music size={12} />}
            {isCurrent && (
              <span className="music-popup__cover-overlay">
                {acestepState?.isPlaying ? <Pause size={9} /> : <Play size={9} />}
              </span>
            )}
          </span>
          <span className="music-popup__queue-meta">
            <span className="music-popup__queue-title" title={title}>{title}</span>
            <span className="music-popup__queue-artist" title={artist}>{artist}</span>
          </span>
        </button>
        <button
          type="button"
          className="music-popup__queue-remove"
          onClick={(e) => { e.stopPropagation(); queueRemove(index) }}
          onMouseDown={(e) => e.stopPropagation()}
          title={t('audio.island.music.online.removeQueue', { defaultValue: '从列表移除' })}
        >
          <X size={11} />
        </button>
      </div>
    )
  }

  // ---- 播放列表清空（确认）----
  const handleClearQueue = useCallback(() => {
    if (queuePlaylist.length === 0) return
    void confirmDanger(
      t('audio.island.music.online.clearQueue', { defaultValue: '清空播放列表' }),
      t('audio.island.music.online.clearQueueConfirm', { defaultValue: '确定清空播放列表？（不影响正在播放的歌曲）' }),
      { confirmText: t('confirmDelete', { defaultValue: '清空' }) },
    ).then((ok) => {
      if (ok) queueClear()
    })
  }, [queuePlaylist.length, queueClear, t])

  // ---- musicdl：清空在线缓存（释放磁盘）----
  const handleClearOnlineCache = useCallback(() => {
    void invoke<number>('musicfree_clear_cache').then((freed) => {
      setToastMsg(t('audio.island.music.online.cacheCleared', {
        defaultValue: '已清理在线缓存（{{size}}）',
        size: formatBytes(freed),
      }))
    })
  }, [t, formatBytes])

  // ---- VRM radio handlers ----
  const handleRadioSelect = async (styleId: string) => {
    if (audio.radioActive && audio.radioStyle === styleId) {
      audio.stopRadio()
      return
    }
    await audio.startRadio(styleId)
  }

  const handleVolumeToggle = () => {
    if (activeSource === 'acestep' && acestepState) {
      handleAceStepSetVolume(acestepState.volume > 0 ? 0 : 0.8)
      return
    }
    if (masterVolume > 0) {
      prevVolumeRef.current = masterVolume
      void setMasterVolume(0)
    } else {
      void setMasterVolume(prevVolumeRef.current || 0.8)
    }
  }

  // ---- Top bar seek (AceStep only; VRM radio has no seek) ----
  const handleTopBarSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (activeSource !== 'acestep' || !acestepState || acestepState.duration <= 0) return
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    handleAceStepSeek(ratio * acestepState.duration)
  }

  // ---- Play mode icon ----
  const getPlayModeIcon = (mode: PlayMode) => {
    switch (mode) {
      case 'sequential': return <ListOrdered size={14} />
      case 'repeat-all': return <Repeat size={14} />
      case 'repeat-one': return <Repeat1 size={14} />
      case 'shuffle': return <Shuffle size={14} />
    }
  }

  // ---- P2P status ----
  const errorReasonText = (reason: string | null | undefined): string => {
    switch (reason) {
      case 'no_source':
      case 'noSource': return t('acestep.p2p.error.noSource', { defaultValue: '未找到可用节点' })
      case 'timeout': return t('acestep.p2p.error.timeout', { defaultValue: '下载超时' })
      case 'cancelled':
      case 'cancel': return t('acestep.p2p.error.cancelled', { defaultValue: '已取消' })
      case 'torrent_error':
      case 'torrentError': return t('acestep.p2p.error.torrentError', { defaultValue: 'P2P 出错' })
      default: return t('acestep.p2p.error', { defaultValue: '连接失败' })
    }
  }
  const renderP2PStatus = () => {
    if (!acestepState?.p2pStatus) return null
    const { p2pStatus, p2pPeerCount, p2pDownloadPercent } = acestepState
    // 当前播放 share 的实时进度/错误原因（从 p2pStore 进度单一来源读取）
    const curShareId = currentShareId ?? acestepState.currentShareId ?? null
    const curProgress = curShareId ? p2pProgressMap[curShareId] : undefined
    let color = 'var(--color-text-muted)'
    let text = ''
    switch (p2pStatus) {
      case 'connecting':
        color = '#f59e0b'
        text = t('acestep.p2p.connecting', { defaultValue: 'P2P 连接中' })
        break
      case 'downloading':
        color = '#3b82f6'
        text = t('acestep.p2p.downloading', {
          defaultValue: 'P2P 下载中 {{pct}}% · {{count}} 节点',
          pct: Math.round((curProgress?.percent ?? p2pDownloadPercent ?? 0) * 100),
          count: p2pPeerCount,
        })
        break
      case 'seeding':
        color = '#22c55e'
        text = t('acestep.p2p.seeding', { defaultValue: '做种中' })
        break
      case 'error':
        color = '#ef4444'
        text = errorReasonText(curProgress?.errorReason)
        break
    }
    return (
      <span className="music-popup__p2p-status" style={{ color }}>
        <Globe size={10} style={{ marginRight: 3 }} />
        {text}
      </span>
    )
  }

  // ---- Footer state ----
  const isFooterPlaying = activeSource === 'acestep' ? acestepIsPlaying : vrmIsPlaying
  const footerVolume = activeSource === 'acestep' ? (acestepState?.volume ?? 0.8) : masterVolume
  const hasSong = activeSource === 'acestep' ? !!acestepState?.currentSong : !!bgmChannel

  // 当前在线播放歌曲的收藏状态（currentOnlineId 即 songKey 格式）：
  // 优先从正在播的 playlist 条目取完整对象（收藏列表未含时仍可收藏）
  const currentOnlineSong =
    acestepState?.source === 'online' && queueIndex >= 0 && queuePlaylist[queueIndex]?.kind === 'online'
      ? queuePlaylist[queueIndex].song
      : null
  const currentOnlineFavSong = currentOnlineSong
    ?? (acestepState?.currentOnlineId ? useFavoritesStore.getState().findByKey(acestepState.currentOnlineId) : null)
  const currentOnlineFavored = currentOnlineFavSong
    ? favorites.some((s) => songKey(s) === songKey(currentOnlineFavSong))
    : false

  // v1.3.0+: Current share's tags for footer like/dislike signal collection.
  // Look up from recommendItems or communityShares by currentShareId.
  const currentShareTags = currentShareId
    ? parseSongTags(
        (recommendItems.find((s) => s.shareId === currentShareId)
          ?? communityShares.find((s) => s.shareId === currentShareId))?.tags,
      )
    : []
  const isCurrentShareLiked = currentShareId ? profile.likedIds.includes(currentShareId) : false
  const isCurrentShareDisliked = currentShareId ? profile.dislikedIds.includes(currentShareId) : false

  const handleFooterTogglePlay = () => {
    if (activeSource === 'acestep') {
      handleAceStepTogglePlay()
    } else if (bgmChannel) {
      if (vrmIsPlaying) audio.pauseChannel(bgmChannel.id)
      else audio.resumeChannel(bgmChannel.id)
    }
  }

  const handleFooterPrev = () => {
    if (activeSource === 'acestep') handleAceStepPrev()
  }

  const handleFooterNext = () => {
    // 歌曲电台播放中：下一首与电台统一（电台逐首推送，不走播放列表）
    if (msRadioActive && acestepState?.source === 'online') {
      void handleRadioSkip()
      return
    }
    if (activeSource === 'acestep') handleAceStepNext()
    else audio.skipToNext()
  }

  const handleFooterVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation()
    const v = parseFloat(e.target.value)
    if (activeSource === 'acestep') {
      handleAceStepSetVolume(v)
    } else {
      void setMasterVolume(v)
    }
  }

  return createPortal(
    <div
      ref={elementRef}
      className={`music-popup no-penetrate${isDragging ? ' is-dragging' : ''}${activeResize ? ' is-resizing' : ''}${!hasSong ? ' music-popup--no-player' : ''}`}
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ===== Resize handles (8 directions) ===== */}
      <div className="music-popup__resize-handle music-popup__resize-handle--n" onMouseDown={handleResizeMouseDown('n')} />
      <div className="music-popup__resize-handle music-popup__resize-handle--s" onMouseDown={handleResizeMouseDown('s')} />
      <div className="music-popup__resize-handle music-popup__resize-handle--e" onMouseDown={handleResizeMouseDown('e')} />
      <div className="music-popup__resize-handle music-popup__resize-handle--w" onMouseDown={handleResizeMouseDown('w')} />
      <div className="music-popup__resize-handle music-popup__resize-handle--ne" onMouseDown={handleResizeMouseDown('ne')} />
      <div className="music-popup__resize-handle music-popup__resize-handle--nw" onMouseDown={handleResizeMouseDown('nw')} />
      <div className="music-popup__resize-handle music-popup__resize-handle--se" onMouseDown={handleResizeMouseDown('se')} />
      <div className="music-popup__resize-handle music-popup__resize-handle--sw" onMouseDown={handleResizeMouseDown('sw')} />

      {/* ===== Header: drag handle + close ===== */}
      <div
        className="music-popup__header"
        onMouseDown={handleMouseDown}
      >
        <GripVertical size={14} className="music-popup__drag-handle" />
        <Music size={14} className="music-popup__header-icon" />
        <span className="music-popup__header-title">
          AI00-Music
        </span>
        <button
          className="music-popup__close"
          onClick={(e) => { e.stopPropagation(); closePopup('music') }}
          onMouseDown={(e) => e.stopPropagation()}
          title={t('audio.island.collapse', { defaultValue: '收起' })}
        >
          <X size={16} />
        </button>
      </div>

        {toastMsg && (
          <div className="music-popup__toast" role="status">
            <span className="music-popup__toast-icon"><Copy size={11} /></span>
            {toastMsg}
          </div>
        )}

        {/* ===== Body: left nav + right content ===== */}
        <div className="music-popup__body">
          {/* ---- Left sidebar: navigation menu ---- */}
          <nav className="music-popup__nav">
            <button
              type="button"
              className={`music-popup__nav-item${activeSection === 'radio' ? ' is-active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setActiveSection('radio') }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Radio size={14} className="music-popup__nav-icon" />
              <span className="music-popup__nav-label">
                {t('audio.mode.radio', { defaultValue: '电台' })}
              </span>
              {radioActive && (
                <span className="music-popup__nav-indicator" />
              )}
            </button>
            <button
              type="button"
              className={`music-popup__nav-item${activeSection === 'online' ? ' is-active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setActiveSection('online') }}
              onMouseDown={(e) => e.stopPropagation()}
              title={t('audio.island.music.online.nav', { defaultValue: '歌曲电台（全球榜单随机播放）' })}
            >
              <Globe size={14} className="music-popup__nav-icon" />
              <span className="music-popup__nav-label">
                {t('audio.island.music.online.nav', { defaultValue: '歌曲电台' })}
              </span>
              {msRadioActive && (
                <span className="music-popup__nav-indicator" />
              )}
            </button>
            <button
              type="button"
              className={`music-popup__nav-item${activeSection === 'local' ? ' is-active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setActiveSection('local') }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Music size={14} className="music-popup__nav-icon" />
              <span className="music-popup__nav-label">
                {t('acestep.library', { defaultValue: '本地作品' })}
              </span>
              <span className="music-popup__nav-count">{acestepSongs.length}</span>
            </button>
            <button
              type="button"
              className={`music-popup__nav-item${activeSection === 'recommend' ? ' is-active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setActiveSection('recommend') }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Sparkles size={14} className="music-popup__nav-icon" />
              <span className="music-popup__nav-label">
                {t('audio.island.music.segment.recommend', { defaultValue: '为你推荐' })}
              </span>
              <span className="music-popup__nav-count">{recommendItems.length}</span>
            </button>
            <button
              type="button"
              className={`music-popup__nav-item${activeSection === 'community' ? ' is-active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setActiveSection('community') }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Headphones size={14} className="music-popup__nav-icon" />
              <span className="music-popup__nav-label">
                {t('audio.island.music.segment.hot', { defaultValue: '全网热门' })}
              </span>
              <span className="music-popup__nav-count">{communityShares.length}</span>
            </button>
            <button
              type="button"
              className={`music-popup__nav-item${activeSection === 'favorites' ? ' is-active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setActiveSection('favorites') }}
              onMouseDown={(e) => e.stopPropagation()}
              title={t('audio.island.music.favSection.title', { defaultValue: '收藏（在线音乐 + 社区音乐）' })}
            >
              <Heart size={14} className="music-popup__nav-icon" />
              <span className="music-popup__nav-label">
                {t('audio.island.music.favSection.title', { defaultValue: '收藏' })}
              </span>
              <span className="music-popup__nav-count">{favorites.length + profile.likedIds.length}</span>
            </button>
            {/* 做种管理：nav 隐藏（P2P 做种后台自动进行；seeding section
                保留，activeSection 状态仍可达，仅无入口） */}
          </nav>

          {/* ---- Right content: section body ---- */}
          <div className="music-popup__content">
          {/* ---- 电台组 ---- */}
          {activeSection === 'radio' && (
            <section className="music-popup__section">
            <h3 className="music-popup__section-title">
              <Radio size={12} />
              <span>{t('audio.mode.radio', { defaultValue: '电台' })}</span>
            </h3>
            <div className="music-popup__radio-grid">
              {RADIO_PRESETS.map((preset) => {
                const isActive = radioActive && radioStyle === preset.id
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`music-popup__radio-card${isActive ? ' is-active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); void handleRadioSelect(preset.id) }}
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{ '--radio-color': preset.color } as React.CSSProperties}
                    title={preset.nameEn}
                  >
                    <span className="music-popup__radio-cover">
                      <span className="music-popup__radio-icon">{preset.icon}</span>
                      {isActive ? (
                        <span className="music-popup__radio-wave">
                          {Array.from({ length: 4 }).map((_, i) => (
                            <span
                              key={i}
                              className="music-popup__radio-wave-bar"
                              style={{ animationDelay: `${i * 0.15}s` }}
                            />
                          ))}
                        </span>
                      ) : (
                        <span className="music-popup__radio-play">
                          <Play size={12} />
                        </span>
                      )}
                    </span>
                    <span className="music-popup__radio-name">
                      {t(`audio.radio.${preset.id}`, { defaultValue: preset.name })}
                    </span>
                  </button>
                )
              })}
            </div>
            </section>
          )}

          {/* ---- 本地作品组 ---- */}
          {activeSection === 'local' && (
          <section className="music-popup__section">
            <h3 className="music-popup__section-title">
              <Music size={12} />
              <span>{t('acestep.library', { defaultValue: '本地作品' })}</span>
              <span className="music-popup__section-count">{acestepSongs.length}</span>
              <button
                type="button"
                className="music-popup__create-btn"
                onClick={(e) => { e.stopPropagation(); handleOpenCreator() }}
                onMouseDown={(e) => e.stopPropagation()}
                title={t('acestep.openCreator', { defaultValue: '打开音乐创作' })}
              >
                <Sparkles size={12} />
                <span>{t('acestep.openCreator', { defaultValue: '打开音乐创作' })}</span>
              </button>
            </h3>
            <div className="music-popup__song-list">
              {acestepSongsLoading ? (
                <div className="music-popup__list-loading">
                  <Loader2 size={16} className="is-spinning" />
                </div>
              ) : acestepSongs.length === 0 ? (
                <div className="music-popup__list-empty">
                  {t('acestep.libraryEmpty', { defaultValue: '暂无作品' })}
                </div>
              ) : (
                acestepSongs.map((entry) => {
                  // 直接点击本地作品播放走 playSong，playlistIndex 不会被更新；
                  // 用当前播放歌曲的绝对路径匹配，更可靠。
                  const isCurrent =
                    !!acestepState?.currentSong &&
                    acestepState.currentEntryPath === entry.path
                  const meta = entry.meta
                  const coverPath = coverPaths[entry.path]
                  const isShared = Boolean(archiveShareMap[entry.path])
                  const isDeleting = deletingPath === entry.path
                  return (
                    <div
                      key={entry.path}
                      className={`music-popup__song-card${isCurrent ? ' is-current' : ''}`}
                    >
                      <button
                        type="button"
                        className="music-popup__song-play"
                        onClick={(e) => { e.stopPropagation(); void handleAceStepPlaySong(entry) }}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <span className="music-popup__song-cover">
                          {coverPath ? (
                            <img src={convertFileSrc(coverPath)} alt="" loading="lazy" />
                          ) : (
                            <Music size={16} />
                          )}
                          <span className="music-popup__cover-overlay">
                            {isCurrent && acestepState?.isPlaying ? (
                              <Pause size={10} />
                            ) : (
                              <Play size={10} />
                            )}
                          </span>
                        </span>
                        <span className="music-popup__song-meta">
                          <span className="music-popup__song-title" title={meta?.title ?? entry.filename}>
                            {meta?.title ?? entry.filename}
                          </span>
                          <span className="music-popup__song-artist" title={meta?.artist ?? ''}>
                            {meta?.artist ?? ''}
                          </span>
                        </span>
                      </button>
                      {isCurrent && acestepState?.isPlaying && (
                        <span className="music-popup__song-playing-indicator">
                          <span className="music-popup__bar" />
                          <span className="music-popup__bar" />
                          <span className="music-popup__bar" />
                        </span>
                      )}
                      <span className="music-popup__song-actions">
                        {isShared && (
                          <span className="music-popup__song-shared-badge" title={t('acestep.library.shared', { defaultValue: '已分享' })}>
                            <Share2 size={10} />
                          </span>
                        )}
                        <button
                          type="button"
                          className="music-popup__song-action"
                          onClick={(e) => { e.stopPropagation(); setEditDialogEntry(entry) }}
                          title={t('acestep.library.edit', { defaultValue: '编辑' })}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          className="music-popup__song-action"
                          onClick={(e) => { e.stopPropagation(); setShareDialogEntry(entry) }}
                          title={t('acestep.library.share', { defaultValue: '分享' })}
                        >
                          <Share2 size={12} />
                        </button>
                        <button
                          type="button"
                          className="music-popup__song-action music-popup__song-action--danger"
                          onClick={(e) => { e.stopPropagation(); void handleDeleteSong(entry) }}
                          disabled={isDeleting}
                          title={t('acestep.library.delete', { defaultValue: '删除' })}
                        >
                          {isDeleting ? <Loader2 size={12} className="is-spinning" /> : <Trash2 size={12} />}
                        </button>
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          </section>
          )}

          {/* ---- v1.3.0+: 为你推荐组 ---- */}
          {activeSection === 'recommend' && (
          <section className="music-popup__section music-popup__section--recommend">
            <h3 className="music-popup__section-title">
              <Sparkles size={12} />
              <span>
                {recommendSource === 'cold-start'
                  ? t('audio.island.music.recommendColdStart', { defaultValue: '热门推荐' })
                  : t('audio.island.music.recommendProfile', { defaultValue: '为你推荐' })}
              </span>
              <span className="music-popup__section-count">{recommendItems.length}</span>
              <button
                type="button"
                className="music-popup__recommend-refresh"
                onClick={(e) => { e.stopPropagation(); void recommendRefresh(true) }}
                onMouseDown={(e) => e.stopPropagation()}
                disabled={recommendLoading}
                title={t('audio.island.music.recommendRefresh', { defaultValue: '刷新推荐' })}
              >
                {recommendLoading ? (
                  <Loader2 size={11} className="is-spinning" />
                ) : (
                  <RefreshCw size={11} />
                )}
              </button>
            </h3>
            <div className="music-popup__community-list music-popup__recommend-list">
              {recommendLoading && recommendItems.length === 0 ? (
                <div className="music-popup__list-loading">
                  <Loader2 size={16} className="is-spinning" />
                  <span style={{ marginLeft: 8 }}>
                    {t('audio.island.music.recommendLoading', { defaultValue: '正在为你找歌...' })}
                  </span>
                </div>
              ) : recommendError ? (
                <div className="music-popup__list-empty">
                  {t('audio.island.music.recommendError', { defaultValue: '推荐加载失败，请稍后重试' })}
                </div>
              ) : recommendItems.length === 0 ? (
                <div className="music-popup__list-empty">
                  {t('audio.island.music.recommendEmpty', { defaultValue: '暂无推荐，播放或点赞几首歌后再来' })}
                </div>
              ) : (
                recommendItems.map((share) => {
                  const isCurrent =
                    acestepState?.source === 'share' &&
                    loadingShareId === null &&
                    acestepState.currentShareId === share.shareId
                  return (
                    <RecommendCard
                      key={share.shareId}
                      share={share}
                      isPlaying={isCurrent && acestepState?.isPlaying === true}
                      isLoading={loadingShareId === share.shareId}
                      isLiked={profile.likedIds.includes(share.shareId)}
                      isDisliked={profile.dislikedIds.includes(share.shareId)}
                      onPlay={(id: string) => void handlePlayShare(id, recommendItems)}
                      onLike={() => profileToggleLike(share.shareId, parseSongTags(share.tags))}
                      onDislike={() => profileToggleDislike(share.shareId, parseSongTags(share.tags))}
                      formatPlays={formatPlays}
                    />
                  )
                })
              )}
            </div>
          </section>
          )}

          {/* ---- 全网热门组 ---- */}
          {activeSection === 'community' && (
          <section className="music-popup__section">
            <h3 className="music-popup__section-title">
              <Headphones size={12} />
              <span>{t('audio.island.music.segment.hot', { defaultValue: '全网热门' })}</span>
              <span className="music-popup__section-count">{communityShares.length}</span>
            </h3>
            <div className="music-popup__community-list">
              {communityLoading ? (
                <div className="music-popup__list-loading">
                  <Loader2 size={16} className="is-spinning" />
                </div>
              ) : communityShares.length === 0 ? (
                <div className="music-popup__list-empty">
                  {t('audio.island.music.hotEmpty', { defaultValue: '暂无热门分享' })}
                </div>
              ) : (
                communityShares.map((share) => {
                  const isCurrent =
                    acestepState?.source === 'share' &&
                    loadingShareId === null &&
                    acestepState.currentShareId === share.shareId
                  return (
                    <CommunityCard
                      key={share.shareId}
                      share={share}
                      isPlaying={isCurrent && acestepState?.isPlaying === true}
                      isLoading={loadingShareId === share.shareId}
                      p2pProgress={p2pProgressMap[share.shareId]}
                      onPlay={(id: string) => void handlePlayShare(id, communityShares)}
                      formatPlays={formatPlays}
                      formatBytes={formatBytes}
                    />
                  )
                })
              )}
            </div>
          </section>
          )}

          {/* ---- 在线音源组（musicdl sidecar）---- */}
          {activeSection === 'online' && (
          <section className="music-popup__section music-popup__section--online">
            <h3 className="music-popup__section-title">
              <Globe size={12} />
              <span>{t('audio.island.music.online.title', { defaultValue: '在线音源' })}</span>
              <span className="music-popup__section-actions">
                <button
                  type="button"
                  className="music-popup__section-action"
                  onClick={(e) => { e.stopPropagation(); void handleClearOnlineCache() }}
                  onMouseDown={(e) => e.stopPropagation()}
                  title={t('audio.island.music.online.clearCache', { defaultValue: '清空在线缓存' })}
                >
                  <Trash2 size={11} />
                  <span>{t('audio.island.music.online.clearCache', { defaultValue: '清缓存' })}</span>
                </button>
              </span>
            </h3>
            {msPhase?.phase === 'installing' && (
              <div className="music-popup__online-degraded" role="status">
                <Loader2 size={12} className="is-spinning" style={{ marginRight: 6, flexShrink: 0 }} />
                {t('audio.island.music.online.installing', { defaultValue: '首次使用正在安装音乐源环境（Python + musicdl，一次性，需数分钟）...' })}
              </div>
            )}
            {msPhase?.phase === 'failed' && (
              <div className="music-popup__online-degraded" role="status">
                {t('audio.island.music.online.pluginError', { defaultValue: '音乐源服务启动失败' })}
                {' · '}
                {msPhase.error}
                {' · '}
                <button
                  type="button"
                  className="music-popup__online-retry"
                  onClick={(e) => { e.stopPropagation(); void msEnsureReady() }}
                >
                  {t('audio.island.music.online.retry', { defaultValue: '重试' })}
                </button>
              </div>
            )}
            {/* ---- 电台视图（多榜单曲池随机播放，不显示榜单） ---- */}
            <div className="music-popup__community-list music-popup__online-list">
                {msRadioActive ? (
                  <>
                    <div className="music-popup__online-radio-nowplaying">
                      <span className="music-popup__online-radio-cover">
                        {msRadioCurrent?.coverUrl ? (
                          <img src={msRadioCurrent.coverUrl} alt="" loading="lazy" />
                        ) : (
                          <Radio size={22} />
                        )}
                        <span className="music-popup__online-radio-wave" aria-hidden="true">
                          <i /><i /><i /><i />
                        </span>
                      </span>
                      <span className="music-popup__online-radio-meta">
                        <span className="music-popup__online-radio-title" title={msRadioCurrent?.name || ''}>
                          {msRadioCurrent?.name || t('audio.island.music.online.radioLoading', { defaultValue: '正在选曲...' })}
                        </span>
                        <span className="music-popup__online-radio-artist" title={msRadioCurrent?.singers || ''}>
                          {msRadioCurrent?.singers || ''}
                        </span>
                      </span>
                      {msRadioCurrentSong && (
                        <button
                          type="button"
                          className={`music-popup__online-radio-fav${favorites.some((f) => songKey(f) === songKey(msRadioCurrentSong)) ? ' is-favored' : ''}`}
                          onClick={(e) => { e.stopPropagation(); handleToggleFavorite(msRadioCurrentSong) }}
                          onMouseDown={(e) => e.stopPropagation()}
                          title={t('audio.island.music.online.favorite', { defaultValue: '收藏' })}
                        >
                          <Heart size={16} fill={favorites.some((f) => songKey(f) === songKey(msRadioCurrentSong)) ? 'currentColor' : 'none'} />
                        </button>
                      )}
                    </div>
                    <div className="music-popup__online-radio-controls">
                      <button
                        type="button"
                        className="music-popup__online-radio-btn"
                        onClick={(e) => { e.stopPropagation(); void handleRadioSkip() }}
                        onMouseDown={(e) => e.stopPropagation()}
                        title={t('audio.island.music.online.radioSkip', { defaultValue: '下一首' })}
                      >
                        <SkipForward size={16} />
                      </button>
                      <button
                        type="button"
                        className="music-popup__online-radio-btn music-popup__online-radio-btn--stop"
                        onClick={(e) => { e.stopPropagation(); msStopRadio() }}
                        onMouseDown={(e) => e.stopPropagation()}
                        title={t('audio.island.music.online.radioStop', { defaultValue: '停止电台' })}
                      >
                        <Square size={14} />
                      </button>
                    </div>
                    <p className="music-popup__online-radio-desc">
                      {t('audio.island.music.online.radioDesc', { defaultValue: '随机播放全球榜单歌曲，喜欢的歌点 ♥ 收藏（含音频）' })}
                    </p>
                  </>
                ) : (
                  <div className="music-popup__online-radio-start">
                    <button
                      type="button"
                      className="music-popup__online-radio-start-btn"
                      onClick={(e) => { e.stopPropagation(); void handleRadioToggle() }}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <Radio size={22} />
                      <span>{t('audio.island.music.online.radioStart', { defaultValue: '启动全球电台' })}</span>
                    </button>
                    <p className="music-popup__online-radio-subtitle">
                      {t('audio.island.music.online.radioSubtitle', { defaultValue: '随机播放多国榜单歌曲，喜欢的歌可收藏' })}
                    </p>
                  </div>
                )}
            </div>
          </section>
          )}

          {/* ---- 统一收藏组：在线音乐收藏 + 社区音乐喜欢 ---- */}
          {activeSection === 'favorites' && (
          <section className="music-popup__section">
            <h3 className="music-popup__section-title">
              <Heart size={12} />
              <span>{t('audio.island.music.favSection.title', { defaultValue: '收藏' })}</span>
              <span className="music-popup__section-count">{favorites.length + profile.likedIds.length}</span>
            </h3>

            {/* ---- 分组：在线音乐（收藏含音频，整组入列连播） ---- */}
            <div className="music-popup__favorites-group">
              {t('audio.island.music.favSection.online', { defaultValue: '在线音乐' })}
              <span className="music-popup__section-count">{favorites.length}</span>
            </div>
            <div className="music-popup__community-list music-popup__online-list">
              {favorites.length === 0 ? (
                <div className="music-popup__list-empty">
                  {t('audio.island.music.online.favoritesEmpty', { defaultValue: '暂无收藏。点击歌曲行右侧的心形即可收藏' })}
                </div>
              ) : (
                favorites.map((song) => {
                  const onlineId = songKey(song)
                  const isCurrent =
                    acestepState?.source === 'online' &&
                    loadingOnlineId === null &&
                    acestepState.currentOnlineId === onlineId
                  return (
                    <div
                      key={onlineId}
                      className={`music-popup__community-card music-popup__online-card${isCurrent ? ' is-current' : ''}`}
                      title={`${song.name} — ${song.singers} · ${sourceDisplayName(song.source)}${song.lyric ? ' · 有歌词' : ''}`}
                    >
                      <button
                        type="button"
                        className="music-popup__community-main"
                        onClick={(e) => { e.stopPropagation(); void handlePlayOnline(song, favorites) }}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <span className="music-popup__community-cover">
                          {song.coverUrl ? (
                            <img src={song.coverUrl} alt="" loading="lazy" />
                          ) : (
                            <Music size={14} />
                          )}
                          {isCurrent && (
                            <span className="music-popup__cover-overlay">
                              {acestepState?.isPlaying ? <Pause size={10} /> : <Play size={10} />}
                            </span>
                          )}
                        </span>
                        <span className="music-popup__community-meta">
                          <span className="music-popup__community-title" title={song.name}>
                            {song.name}
                            {song.lyric && <span className="music-popup__online-lyric-badge" title="有歌词">词</span>}
                          </span>
                          <span className="music-popup__community-artist" title={song.singers}>
                            {song.singers}{song.durationS ? ` · ${formatDuration(song.durationS)}` : ''}
                          </span>
                        </span>
                        <span className="music-popup__online-platform">{sourceDisplayName(song.source)}</span>
                        <span className="music-popup__community-action">
                          {loadingOnlineId === onlineId ? (
                            <Loader2 size={14} className="is-spinning" />
                          ) : isCurrent ? (
                            acestepState?.isPlaying ? <Pause size={14} /> : <Play size={14} />
                          ) : (
                            <Play size={14} />
                          )}
                        </span>
                      </button>
                      <span className="music-popup__online-fav-actions">
                        <button
                          type="button"
                          className="music-popup__online-fav"
                          onClick={(e) => { e.stopPropagation(); handleAddToQueue(song) }}
                          onMouseDown={(e) => e.stopPropagation()}
                          title={t('audio.island.music.online.addToQueue', { defaultValue: '加入播放列表' })}
                        >
                          <Plus size={12} />
                        </button>
                        <button
                          type="button"
                          className={`music-popup__online-fav is-favored`}
                          onClick={(e) => { e.stopPropagation(); favoritesRemove(onlineId) }}
                          onMouseDown={(e) => e.stopPropagation()}
                          title={t('audio.island.music.online.favoriteRemove', { defaultValue: '取消收藏' })}
                        >
                          <Heart size={12} fill="currentColor" />
                        </button>
                      </span>
                    </div>
                  )
                })
              )}
            </div>

            {/* ---- 分组：社区音乐（画像喜欢，getMeta 拉元数据） ---- */}
            <div className="music-popup__favorites-group">
              {t('audio.island.music.favSection.community', { defaultValue: '社区音乐' })}
              <span className="music-popup__section-count">{profile.likedIds.length}</span>
            </div>
            <div className="music-popup__community-list music-popup__online-list">
              {profile.likedIds.length === 0 ? (
                <div className="music-popup__list-empty">
                  {t('audio.island.music.favSection.likesEmpty', { defaultValue: '暂无喜欢的社区音乐。在「全网热门」点 ♥ 即可收藏' })}
                </div>
              ) : likedShareItems.length === 0 ? (
                <div className="music-popup__list-loading">
                  <Loader2 size={16} className="is-spinning" />
                  <span style={{ marginLeft: 8 }}>
                    {t('audio.island.music.favSection.loading', { defaultValue: '正在加载喜欢的音乐...' })}
                  </span>
                </div>
              ) : (
                likedShareItems.map((share) => {
                  const isCurrent =
                    acestepState?.source === 'share' &&
                    loadingShareId === null &&
                    acestepState.currentShareId === share.shareId
                  return (
                    <div
                      key={share.shareId}
                      className={`music-popup__community-card music-popup__online-card${isCurrent ? ' is-current' : ''}`}
                      title={`${share.title}${share.artistName ? ` — ${share.artistName}` : ''}`}
                    >
                      <button
                        type="button"
                        className="music-popup__community-main"
                        onClick={(e) => { e.stopPropagation(); void handlePlayShare(share.shareId, likedShareItems) }}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <span className="music-popup__community-cover">
                          {share.coverUrl ? (
                            <img src={share.coverUrl} alt="" loading="lazy" />
                          ) : (
                            <Headphones size={14} />
                          )}
                          {isCurrent && (
                            <span className="music-popup__cover-overlay">
                              {acestepState?.isPlaying ? <Pause size={10} /> : <Play size={10} />}
                            </span>
                          )}
                        </span>
                        <span className="music-popup__community-meta">
                          <span className="music-popup__community-title" title={share.title}>
                            {share.title}
                          </span>
                          <span className="music-popup__community-artist" title={share.artistName || ''}>
                            {share.artistName || t('audio.island.music.favSection.unknownArtist', { defaultValue: '未知歌手' })}
                            {share.durationSeconds ? ` · ${formatDuration(share.durationSeconds)}` : ''}
                          </span>
                        </span>
                        <span className="music-popup__community-action">
                          {loadingShareId === share.shareId ? (
                            <Loader2 size={14} className="is-spinning" />
                          ) : isCurrent ? (
                            acestepState?.isPlaying ? <Pause size={14} /> : <Play size={14} />
                          ) : (
                            <Play size={14} />
                          )}
                        </span>
                      </button>
                      <span className="music-popup__online-fav-actions">
                        <button
                          type="button"
                          className="music-popup__online-fav is-favored"
                          onClick={(e) => { e.stopPropagation(); profileToggleLike(share.shareId, []) }}
                          onMouseDown={(e) => e.stopPropagation()}
                          title={t('audio.island.music.online.favoriteRemove', { defaultValue: '取消收藏' })}
                        >
                          <Heart size={12} fill="currentColor" />
                        </button>
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          </section>
          )}

          {/* ---- 做种 / 缓存管理组 ---- */}
          {activeSection === 'seeding' && (
          <section className="music-popup__section">
            <h3 className="music-popup__section-title">
              <HardDrive size={12} />
              <span>{t('acestep.p2p.seedingManage', { defaultValue: '做种管理' })}</span>
              {p2pCacheStats && p2pCacheStats.perShare.length > 0 && (
                <span className="music-popup__section-count">
                  {t('acestep.p2p.diskUsage', { defaultValue: '占用 {{size}}', size: formatBytes(p2pCacheStats.totalBytes) })}
                </span>
              )}
              <span className="music-popup__section-actions">
                <button
                  type="button"
                  className="music-popup__section-action"
                  onClick={(e) => { e.stopPropagation(); void p2pRefreshCacheStats() }}
                  onMouseDown={(e) => e.stopPropagation()}
                  title={t('acestep.p2p.refresh', { defaultValue: '刷新' })}
                >
                  <RefreshCw size={11} />
                </button>
                <button
                  type="button"
                  className="music-popup__section-action music-popup__section-action--danger"
                  onClick={(e) => { e.stopPropagation(); handleClearAllCache() }}
                  onMouseDown={(e) => e.stopPropagation()}
                  disabled={!p2pCacheStats || p2pCacheStats.perShare.length === 0}
                  title={t('acestep.p2p.clearCache', { defaultValue: '清空缓存' })}
                >
                  <Trash2 size={11} />
                  <span>{t('acestep.p2p.clearCache', { defaultValue: '清空缓存' })}</span>
                </button>
              </span>
            </h3>
            <div className="music-popup__seeding-list">
              {p2pSeeding.length === 0 && !p2pActive && p2pQueue.length === 0 ? (
                <div className="music-popup__list-empty">
                  {t('acestep.p2p.seedingEmpty', { defaultValue: '暂无做种歌曲。在「全网热门」点击离线缓存即可开始贡献上行。' })}
                </div>
              ) : (
                <>
                  {p2pActive && p2pQueue.filter((q) => q.status === 'queued' || q.status === 'downloading').length > 0 && (
                    <div className="music-popup__seeding-queue-banner">
                      <Loader2 size={12} className="is-spinning" />
                      <span>
                        {t('acestep.p2p.queueActive', { defaultValue: '下载队列进行中…' })}
                      </span>
                    </div>
                  )}
                  {p2pSeeding.map((p) => (
                    <div key={`seed-${p.shareId}`} className="music-popup__seeding-card">
                      <span className="music-popup__seeding-info">
                        <span className="music-popup__seeding-name" title={p.filename}>
                          {p.filename}
                        </span>
                        <span className="music-popup__seeding-metric">
                          {t('acestep.p2p.uploadRate', {
                            defaultValue: '上行 {{rate}}/s',
                            rate: formatBytes(p.uploadRate),
                          })}
                          {' · '}
                          {t('acestep.p2p.uploaded', {
                            defaultValue: '累计 {{total}}',
                            total: formatBytes(p.uploaded),
                          })}
                          {p.peerCount > 0 ? ` · ${p.peerCount} 节点` : ''}
                        </span>
                      </span>
                      <span className="music-popup__seeding-actions">
                        <button
                          type="button"
                          className="music-popup__seeding-action"
                          onClick={(e) => { e.stopPropagation(); handleStopSeeding(p.shareId, false) }}
                          onMouseDown={(e) => e.stopPropagation()}
                          title={t('acestep.p2p.stopSeeding', { defaultValue: '停止做种（保留文件）' })}
                        >
                          <Pause size={11} />
                          <span>{t('acestep.p2p.stopSeeding', { defaultValue: '停止做种' })}</span>
                        </button>
                        <button
                          type="button"
                          className="music-popup__seeding-action music-popup__seeding-action--danger"
                          onClick={(e) => { e.stopPropagation(); handleStopSeeding(p.shareId, true) }}
                          onMouseDown={(e) => e.stopPropagation()}
                          title={t('acestep.p2p.deleteCache', { defaultValue: '删除缓存文件' })}
                        >
                          <Trash2 size={11} />
                          <span>{t('acestep.p2p.deleteCache', { defaultValue: '删除缓存' })}</span>
                        </button>
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </section>
          )}
          </div>
        </div>

        {/* ===== 播放列表（队列）滑出面板：盖在 body 内容区右侧 ===== */}
        {queueOpen && (
          <>
            <div
              className="music-popup__queue-backdrop"
              onClick={(e) => { e.stopPropagation(); setQueueOpen(false) }}
              onMouseDown={(e) => e.stopPropagation()}
            />
            <div className="music-popup__queue-panel no-penetrate" onClick={(e) => e.stopPropagation()}>
              <div className="music-popup__queue-header">
                <span className="music-popup__queue-title-text">
                  {t('audio.island.music.online.queue', { defaultValue: '播放列表' })}
                  <span className="music-popup__queue-count">{queuePlaylist.length}</span>
                </span>
                <span className="music-popup__queue-actions">
                  <button
                    type="button"
                    className="music-popup__queue-action"
                    onClick={(e) => { e.stopPropagation(); handleClearQueue() }}
                    onMouseDown={(e) => e.stopPropagation()}
                    disabled={queuePlaylist.length === 0}
                    title={t('audio.island.music.online.clearQueue', { defaultValue: '清空列表' })}
                  >
                    <Trash2 size={11} />
                  </button>
                  <button
                    type="button"
                    className="music-popup__queue-action"
                    onClick={(e) => { e.stopPropagation(); setQueueOpen(false) }}
                    onMouseDown={(e) => e.stopPropagation()}
                    title={t('audio.island.music.online.closeQueue', { defaultValue: '关闭' })}
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
              <div className="music-popup__queue-list">
                {queuePlaylist.length === 0 ? (
                  <div className="music-popup__list-empty">
                    {t('audio.island.music.online.queueEmpty', { defaultValue: '队列为空，去搜索或打开排行榜吧' })}
                  </div>
                ) : (
                  queuePlaylist.map((item, index) => renderQueueRow(item, index))
                )}
              </div>
            </div>
          </>
        )}

        {/* ===== Footer: player controls (hidden when nothing is playing) ===== */}
        {hasSong && (
        <div className="music-popup__footer">
          {/* Compact now-playing info + progress */}
          <div className="music-popup__footer-info">
            <span className="music-popup__footer-title" title={topBarTitle}>{topBarTitle}</span>
            {topBarArtist && (
              <span className="music-popup__footer-artist" title={topBarArtist}>{topBarArtist}</span>
            )}
            <span className="music-popup__footer-time">
              {formatTime(topBarCurrent)} / {formatTime(topBarDuration)}
            </span>
          </div>
          {topBarDuration > 0 && (
            <div
              className={`music-popup__progress${activeSource === 'acestep' ? ' music-popup__progress--clickable' : ''}`}
              onClick={handleTopBarSeek}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div
                className="music-popup__progress-fill"
                style={{ width: `${Math.min(100, topBarProgress)}%` }}
              />
            </div>
          )}
          <div className="music-popup__footer-controls">
            {/* 播放模式按钮：歌曲电台播放中隐藏（电台不使用列表模式） */}
            {activeSource === 'acestep' && !(msRadioActive && acestepState?.source === 'online') && (
              <button
                className="music-popup__footer-btn"
                onClick={(e) => { e.stopPropagation(); handleAceStepTogglePlayMode() }}
                onMouseDown={(e) => e.stopPropagation()}
                title={t(`acestep.playMode.${acestepState?.playMode}`, { defaultValue: acestepState?.playMode })}
              >
                {acestepState && getPlayModeIcon(acestepState.playMode)}
              </button>
            )}
            {/* 在线歌曲收藏（当前播放为在线源时） */}
            {activeSource === 'acestep' && acestepState?.source === 'online' && currentOnlineFavSong && (
              <button
                className={`music-popup__footer-btn${currentOnlineFavored ? ' is-active' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleToggleFavorite(currentOnlineFavSong) }}
                onMouseDown={(e) => e.stopPropagation()}
                title={t('audio.island.music.online.favorite', { defaultValue: '收藏' })}
              >
                <Heart size={14} fill={currentOnlineFavored ? 'currentColor' : 'none'} />
              </button>
            )}
            {/* v1.3.0+: Like/Dislike buttons (only for share playback) */}
            {activeSource === 'acestep' && acestepState?.source === 'share' && currentShareId && (
              <>
                <button
                  className={`music-popup__footer-btn${isCurrentShareLiked ? ' is-active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); profileToggleLike(currentShareId, currentShareTags) }}
                  onMouseDown={(e) => e.stopPropagation()}
                  title={t('audio.island.music.like', { defaultValue: '喜欢' })}
                >
                  <Heart size={14} fill={isCurrentShareLiked ? 'currentColor' : 'none'} />
                </button>
                <button
                  className={`music-popup__footer-btn${isCurrentShareDisliked ? ' is-active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); profileToggleDislike(currentShareId, currentShareTags) }}
                  onMouseDown={(e) => e.stopPropagation()}
                  title={t('audio.island.music.dislike', { defaultValue: '不喜欢' })}
                >
                  <ThumbsDown size={14} />
                </button>
              </>
            )}
            {activeSource === 'vrm' && (
              <>
                <button
                  className={`music-popup__footer-btn${playMode === 'radio' ? ' is-active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); setPlayMode('radio') }}
                  onMouseDown={(e) => e.stopPropagation()}
                  title={t('audio.mode.radio')}
                >
                  <Radio size={14} />
                </button>
                <button
                  className={`music-popup__footer-btn${playMode === 'list' ? ' is-active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); setPlayMode('list') }}
                  onMouseDown={(e) => e.stopPropagation()}
                  title={t('audio.mode.list')}
                >
                  <ListMusic size={14} />
                </button>
              </>
            )}
            <button
              className="music-popup__footer-btn"
              onClick={(e) => { e.stopPropagation(); handleFooterPrev() }}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={activeSource !== 'acestep'}
              title={t('acestep.prev', { defaultValue: '上一首' })}
            >
              <SkipForward size={14} style={{ transform: 'scaleX(-1)' }} />
            </button>
            <button
              className="music-popup__footer-btn music-popup__footer-btn--glow"
              onClick={(e) => { e.stopPropagation(); handleFooterTogglePlay() }}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={!hasSong}
              title={isFooterPlaying ? t('acestep.pause', { defaultValue: '暂停' }) : t('acestep.play', { defaultValue: '播放' })}
            >
              {isFooterPlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button
              className="music-popup__footer-btn"
              onClick={(e) => { e.stopPropagation(); handleFooterNext() }}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={activeSource === 'vrm' && audio.radioGenerating}
              title={t('acestep.next', { defaultValue: '下一首' })}
            >
              <SkipForward size={14} />
            </button>
            <div className="music-popup__volume-group">
              <button
                className="music-popup__footer-btn music-popup__footer-btn--volume"
                onClick={(e) => { e.stopPropagation(); handleVolumeToggle() }}
                onMouseDown={(e) => e.stopPropagation()}
                title={footerVolume > 0 ? t('audio.nowPlaying.mute') : t('audio.nowPlaying.unmute')}
              >
                {footerVolume > 0 ? <Volume2 size={14} /> : <VolumeX size={14} />}
              </button>
              <input
                type="range"
                className="music-popup__volume-slider"
                min={0}
                max={1}
                step={0.01}
                value={footerVolume}
                onChange={handleFooterVolumeChange}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              />
            </div>
            {activeSource === 'acestep' && acestepState?.currentSong && (
              <button
                className={`music-popup__footer-btn${acestepState.showLyrics ? ' is-active' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleAceStepToggleLyrics() }}
                onMouseDown={(e) => e.stopPropagation()}
                title={t('acestep.toggleLyrics', { defaultValue: '桌面歌词' })}
              >
                <ListMusic size={14} />
              </button>
            )}
            {/* 播放列表（队列）面板开关：badge 显示队列长度。
                歌曲电台播放中隐藏——电台逐首推送不使用列表 */}
            {activeSource === 'acestep' && !(msRadioActive && acestepState?.source === 'online') && (
              <button
                className={`music-popup__footer-btn music-popup__footer-btn--queue${queueOpen ? ' is-active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setQueueOpen((v) => !v) }}
                onMouseDown={(e) => e.stopPropagation()}
                title={t('audio.island.music.online.queue', { defaultValue: '播放列表' })}
              >
                <ListOrdered size={14} />
                {queuePlaylist.length > 0 && (
                  <span className="music-popup__queue-badge">{queuePlaylist.length}</span>
                )}
              </button>
            )}
            {renderP2PStatus()}
          </div>
        </div>
        )}
      {/* Archive share dialog (moved from LibraryView) */}
      {shareDialogEntry && (
        <ArchiveShareDialog
          open={true}
          entry={shareDialogEntry}
          initialCoverPath={coverPaths[shareDialogEntry.path] ?? null}
          onClose={() => setShareDialogEntry(null)}
          onSuccess={() => { void fetchAcestepSongs() }}
        />
      )}
      {/* Song meta edit dialog */}
      {editDialogEntry && (
        <SongMetaEditDialog
          open={true}
          entry={editDialogEntry}
          initialCoverPath={coverPaths[editDialogEntry.path] ?? null}
          onClose={() => setEditDialogEntry(null)}
          onSuccess={() => { void fetchAcestepSongs() }}
        />
      )}
    </div>,
    document.body,
  )
}
