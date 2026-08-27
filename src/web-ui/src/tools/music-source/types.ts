/**
 * musicdl 在线音源 — 类型定义。
 *
 * 与 Rust music_source_manager.rs 的 OnlineSong 序列化 1:1
 * （camelCase），数据来自 Python sidecar（musicdl 引擎）。
 */

/** 平台显示名映射（musicdl 客户端类名 → 中文） */
export const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  QQMusicClient: 'QQ音乐',
  KuwoMusicClient: '酷我',
  MiguMusicClient: '咪咕',
  NeteaseMusicClient: '网易云',
  KugouMusicClient: '酷狗',
}

/** 平台显示名（未知源回退为类名去 Client 后缀） */
export function sourceDisplayName(source: string): string {
  return SOURCE_DISPLAY_NAMES[source] ?? source.replace(/MusicClient$/, '')
}

/** 搜索结果歌曲（musicdl SongInfo 序列化；localPath 为收藏落盘扩展字段） */
export interface OnlineSong {
  source: string
  name: string
  singers: string
  album: string
  durationS: number
  ext: string
  fileSizeBytes: number
  downloadUrl: string
  lyric: string | null
  coverUrl: string | null
  identifier: string
  dlHeaders: Record<string, string>
  /** 收藏持久化后的本地音频绝对路径（仅收藏条目有；播放时优先本地免下载） */
  localPath?: string
}

/** 歌曲唯一键（`{source}:{identifier}`；identifier 缺失时用 name+singers 兜底） */
export function songKey(song: OnlineSong): string {
  const id = song.identifier || `${song.name}|${song.singers}|${song.ext}`
  return `${song.source}:${id}`
}

/** 时长格式化（秒 → m:ss） */
export function formatDuration(secs: number): string {
  if (!secs || !isFinite(secs)) return ''
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** 榜单/歌单曲目（仅元数据；播放前经 resolve 换成 OnlineSong） */
export interface OnlineTrack {
  trackId: string
  name: string
  singers: string
  album: string
  durationS: number
  coverUrl: string | null
}

/** 排行榜条目 */
export interface OnlineChart {
  id: string
  name: string
}

/** 榜单/歌单内容 */
export interface OnlineTrackList {
  name: string
  tracks: OnlineTrack[]
}
