/**
 * musicdl 在线音源 store — sidecar 状态 + 聚合搜索。
 *
 * 数据链路：
 *   MusicPopup「在线音源」
 *     → invoke music_source_search（Rust 确保 sidecar 就绪并 HTTP 转发）
 *     → Python sidecar（musicdl：5 源并发搜索 + 逐首取源校验 + LRC 歌词）
 *
 * 搜索耗时较长（多源取源校验实测 ~75s），前端需展示 loading 与提示。
 */

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { songKey } from './types'
import type { OnlineChart, OnlineSong, OnlineTrack, OnlineTrackList } from './types'

/** sidecar 阶段（镜像 Rust MusicSourcePhase，kebab-case tag） */
export type MusicSourcePhase =
  | { phase: 'not-ready' }
  | { phase: 'installing'; stage: string }
  | { phase: 'ready' }
  | { phase: 'running'; port: number }
  | { phase: 'failed'; error: string }

export interface MusicSourceState {
  // ---- sidecar 状态 ----
  phase: MusicSourcePhase | null
  /** 确保 sidecar 就绪（幂等；首次会触发 uv venv + musicdl 安装） */
  ensureReady: () => Promise<void>

  // ---- 搜索 ----
  query: string
  results: OnlineSong[]
  searching: boolean
  searchError: string | null
  search: (query: string) => Promise<void>
  clearSearch: () => void

  // ---- 排行榜 ----
  charts: OnlineChart[]
  /** 当前打开的榜单内容（null = 榜单列表视图） */
  chartDetail: OnlineTrackList | null
  chartLoading: boolean
  chartError: string | null
  loadCharts: () => Promise<void>
  openChart: (chartId: string) => Promise<void>
  closeChart: () => void

  // ---- 歌单导入 ----
  playlistDetail: OnlineTrackList | null
  playlistLoading: boolean
  playlistError: string | null
  parsePlaylist: (url: string) => Promise<void>
  closePlaylist: () => void

  // ---- 曲目解析（榜单/歌单 → 可播放） ----
  resolvingId: string | null
  resolveError: string | null
  resolveTrack: (name: string, singers: string) => Promise<OnlineSong | null>

  // ---- 电台（多榜单曲池随机播放，逐首 resolve 推送） ----
  radioActive: boolean
  radioPool: OnlineTrack[]
  radioPos: number
  /** 当前电台正在解析/推送的曲目（null = 空闲） */
  radioCurrent: OnlineTrack | null
  /** 电台当前已解析成可播放/可收藏的 OnlineSong（null = 尚未解析成功） */
  radioCurrentSong: OnlineSong | null
  /** 电台启动：拉池洗牌（sidecar 已洗）→ 从头播放。返回第一首 OnlineSong 由 UI 播放。 */
  startRadio: () => Promise<OnlineSong | null>
  /** 电台下一首（跳过当前）。返回下一首 OnlineSong；池尽自动换池。 */
  radioNext: () => Promise<OnlineSong | null>
  /** 停止电台（不打断正在播的歌） */
  stopRadio: () => void
}

/** 搜索请求序号（丢弃过期响应） */
let searchSeq = 0

// ---- 电台预解析缓存（模块级，非序列化状态不入 store） ----
/** trackId → 已解析的 OnlineSong（预解析成果，radioNext 优先命中） */
const radioResolveCache = new Map<string, OnlineSong>()
/** 预解析互斥（同一时刻只预解析一首） */
let radioPrefetching = false

export const useMusicSourceStore = create<MusicSourceState>((set, get) => ({
  phase: null,

  ensureReady: async () => {
    try {
      await invoke('music_source_ensure_ready')
      set({ phase: { phase: 'running', port: 0 } })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ phase: { phase: 'failed', error: msg } })
      throw e
    }
  },

  query: '',
  results: [],
  searching: false,
  searchError: null,

  search: async (query) => {
    const q = query.trim()
    if (!q) return
    const seq = ++searchSeq
    set({ query: q, searching: true, searchError: null, results: [] })
    try {
      const songs = await invoke<OnlineSong[]>('music_source_search', { keyword: q })
      if (seq !== searchSeq) return // 已被更新的搜索覆盖
      set({ results: songs, searching: false })
    } catch (e) {
      if (seq !== searchSeq) return
      const msg = e instanceof Error ? e.message : String(e)
      set({ searching: false, searchError: msg })
    }
  },

  clearSearch: () => {
    searchSeq += 1
    set({ query: '', results: [], searching: false, searchError: null })
  },

  charts: [],
  chartDetail: null,
  chartLoading: false,
  chartError: null,

  loadCharts: async () => {
    set({ chartLoading: true, chartError: null })
    try {
      const charts = await invoke<OnlineChart[]>('music_source_charts')
      set({ charts, chartLoading: false })
    } catch (e) {
      set({ chartLoading: false, chartError: e instanceof Error ? e.message : String(e) })
    }
  },

  openChart: async (chartId) => {
    set({ chartLoading: true, chartError: null, chartDetail: null })
    try {
      const detail = await invoke<OnlineTrackList>('music_source_chart_tracks', { chartId })
      set({ chartDetail: detail, chartLoading: false })
    } catch (e) {
      set({ chartLoading: false, chartError: e instanceof Error ? e.message : String(e) })
    }
  },

  closeChart: () => set({ chartDetail: null, chartError: null }),

  playlistDetail: null,
  playlistLoading: false,
  playlistError: null,

  parsePlaylist: async (url) => {
    set({ playlistLoading: true, playlistError: null, playlistDetail: null })
    try {
      const detail = await invoke<OnlineTrackList>('music_source_parse_playlist', { url })
      set({ playlistDetail: detail, playlistLoading: false })
    } catch (e) {
      set({ playlistLoading: false, playlistError: e instanceof Error ? e.message : String(e) })
    }
  },

  closePlaylist: () => set({ playlistDetail: null, playlistError: null }),

  resolvingId: null,
  resolveError: null,

  resolveTrack: async (name, singers) => {
    set({ resolveError: null })
    const key = `${name}|${singers}`
    set({ resolvingId: key })
    try {
      const song = await invoke<OnlineSong>('music_source_resolve', { name, singers })
      return song
    } catch (e) {
      set({ resolveError: e instanceof Error ? e.message : String(e) })
      return null
    } finally {
      set({ resolvingId: null })
    }
  },

  radioActive: false,
  radioPool: [],
  radioPos: 0,
  radioCurrent: null,
  radioCurrentSong: null,

  startRadio: async (): Promise<OnlineSong | null> => {
    set({ radioActive: true, radioPos: 0 })
    // 拉池（sidecar 内多榜单并发取样 + 去重洗牌）
    const pool = await invoke<OnlineTrack[]>('music_source_radio_pool').catch(() => [])
    if (!get().radioActive) return null // 已被停止
    if (pool.length === 0) {
      set({ radioActive: false })
      throw new Error('radio pool empty')
    }
    set({ radioPool: pool, radioPos: 0 })
    // 逐首 resolve，失败自动跳下一首（最多试 5 首避免死循环）
    for (let i = 0; i < 5 && i < pool.length; i++) {
      const track = pool[i]
      set({ radioCurrent: track, radioPos: i, radioCurrentSong: null })
      const song = radioResolveCache.get(track.trackId)
        ?? await get().resolveTrack(track.name, track.singers)
      if (song) {
        set({ radioCurrentSong: song })
        void prefetchRadioNext() // 后台预解析下一首（省 5-10s 切歌等待）
        return song
      }
    }
    set({ radioActive: false, radioCurrent: null, radioCurrentSong: null })
    throw new Error('radio resolve failed')
  },

  radioNext: async () => {
    const { radioPool: pool, radioPos, radioActive } = get()
    if (!radioActive) return null
    let pos = radioPos + 1
    // 池尽自动换新池（重新拉取洗牌）
    if (pos >= pool.length) {
      const fresh = await invoke<OnlineTrack[]>('music_source_radio_pool').catch(() => [] as OnlineTrack[])
      if (fresh.length === 0) {
        set({ radioActive: false, radioCurrent: null, radioCurrentSong: null })
        return null
      }
      set({ radioPool: fresh, radioPos: 0 })
      pos = 0
    }
    const nextPool = get().radioPool
    // 最多试 5 首（解析失败跳过）
    for (let i = 0; i < 5 && pos + i < nextPool.length; i++) {
      const track = nextPool[pos + i]
      set({ radioCurrent: track, radioPos: pos + i, radioCurrentSong: null })
      const song = radioResolveCache.get(track.trackId)
        ?? await get().resolveTrack(track.name, track.singers)
      if (song) {
        set({ radioCurrentSong: song })
        void prefetchRadioNext() // 后台预解析下一首
        return song
      }
    }
    set({ radioActive: false, radioCurrent: null, radioCurrentSong: null })
    return null
  },

  stopRadio: () => set({ radioActive: false, radioCurrent: null, radioCurrentSong: null }),
}))

/**
 * 后台预解析电台池中下一首曲目（resolve 约 5-10s，提前做掉），
 * resolve 成功后顺手预下载音频（与 playOnline 同 cacheKey，
 * 轮到播放时磁盘缓存命中秒开）。失败/无下一首静默跳过。
 * 定义在 store 之后（引用 useMusicSourceStore，避免 use-before-define）。
 */
async function prefetchRadioNext(): Promise<void> {
  if (radioPrefetching) return
  const { radioPool, radioPos, radioActive } = useMusicSourceStore.getState()
  if (!radioActive) return
  const next = radioPool[radioPos + 1]
  if (!next || radioResolveCache.has(next.trackId)) return
  radioPrefetching = true
  try {
    const song = await useMusicSourceStore.getState().resolveTrack(next.name, next.singers)
    if (song && useMusicSourceStore.getState().radioActive) {
      radioResolveCache.set(next.trackId, song)
      // 预下载音频（缓存目录；key 与 playOnline 构造一致）
      const key = songKey(song).replace(/[^a-zA-Z0-9_-]/g, '_')
      await invoke<string>('musicfree_download_media', {
        url: song.downloadUrl,
        key,
        headers: song.dlHeaders ?? {},
      }).catch(() => { /* 静默：播放时走正常链路 */ })
    }
  } finally {
    radioPrefetching = false
  }
}
