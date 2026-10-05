// useAudioRemoteStore — 「乐」窗口侧音频远程 store（音乐独立窗口 Step 3）。
//
// 音乐窗不实例化音频引擎（audioPlaybackStore SSOT 在 overlay），本地只持有
// overlay 广播的快照（`music://audio-state`），动作通过 `music://audio-command`
// 发往 overlay 的 AudioCommandBridge 执行。
//
// API 镜像 useAudioPlayback 的消费面（bgmChannel/sfxChannels 计算属性同名同义），
// MusicWindowPage/SfxSection 只需换 import 即可切换到远程模式。
// 音量/分类/播放模式做乐观更新，保证滑杆即时响应（快照随后校正）。

import { create } from 'zustand'
import { listen, emit } from '@tauri-apps/api/event'
import type { ChannelInfo, SoundCategory } from '../vrm/lib/audioPlaybackApi'
import type { PlayMode } from '../vrm/store/audioPlaybackStore'
import type { AudioCommand } from '../vrm/services/AudioCommandBridge'

const EVENT_COMMAND = 'music://audio-command'
const EVENT_STATE = 'music://audio-state'

interface AudioRemoteState {
  connected: boolean
  channels: ChannelInfo[]
  masterVolume: number
  categories: SoundCategory[]
  playMode: PlayMode
  activeCategory: string
  radioActive: boolean
  radioStyle: string | null
  radioGenerating: boolean
  mixerInitialized: boolean
}

interface AudioRemoteActions {
  /** 发送原始命令（一般用下方语义化方法） */
  send: (cmd: AudioCommand) => void
  setMasterVolume: (volume: number) => void
  setPlayMode: (mode: PlayMode) => void
  setActiveCategory: (category: string) => void
  startRadio: (styleId: string) => void
  stopRadio: () => void
  skipToNext: () => void
  toggleLibrarySound: (id: string) => void
  deleteFromLibrary: (id: string) => void
  stopAllSfx: () => void
  stopChannel: (id: number) => void
  setChannelVolume: (id: number, volume: number) => void
  pauseChannel: (id: number) => void
  resumeChannel: (id: number) => void
}

type AudioRemoteBase = AudioRemoteState & AudioRemoteActions

/** 消费面类型：远程状态 + 派生计算字段（镜像 useAudioPlayback） */
export type AudioRemoteStore = AudioRemoteBase & {
  /** 当前 BGM 通道（Playing 优先，其次 Paused；无则 null） */
  bgmChannel: ChannelInfo | null
  /** 活跃 SFX 通道（名称已按音效库归一） */
  sfxChannels: ChannelInfo[]
}

const useAudioRemoteStoreBase = create<AudioRemoteBase>((set, get) => ({
  connected: false,
  channels: [],
  masterVolume: 1.0,
  categories: [],
  playMode: 'radio',
  activeCategory: '',
  radioActive: false,
  radioStyle: null,
  radioGenerating: false,
  mixerInitialized: false,

  send: (cmd) => {
    void emit(EVENT_COMMAND, cmd)
  },

  setMasterVolume: (volume) => {
    set({ masterVolume: volume })
    get().send({ action: 'set-master-volume', volume })
  },
  setPlayMode: (mode) => {
    set({ playMode: mode })
    get().send({ action: 'set-play-mode', mode })
  },
  setActiveCategory: (category) => {
    set({ activeCategory: category })
    get().send({ action: 'set-active-category', category })
  },
  startRadio: (styleId) => get().send({ action: 'start-radio', styleId }),
  stopRadio: () => get().send({ action: 'stop-radio' }),
  skipToNext: () => get().send({ action: 'skip-next' }),
  toggleLibrarySound: (id) => get().send({ action: 'toggle-library-sound', id }),
  deleteFromLibrary: (id) => get().send({ action: 'delete-from-library', id }),
  stopAllSfx: () => get().send({ action: 'stop-all-sfx' }),
  stopChannel: (id) => get().send({ action: 'stop-channel', id }),
  setChannelVolume: (id, volume) => {
    set((s) => ({ channels: s.channels.map((ch) => (ch.id === id ? { ...ch, volume } : ch)) }))
    get().send({ action: 'set-channel-volume', id, volume })
  },
  pauseChannel: (id) => get().send({ action: 'pause-channel', id }),
  resumeChannel: (id) => get().send({ action: 'resume-channel', id }),
}))

let initStarted = false

/** 挂载事件监听并请求首帧快照（模块单例，幂等；在 MusicWindowPage 挂载时调用） */
export function ensureAudioRemoteInit(): void {
  if (initStarted) return
  initStarted = true
  void listen<AudioRemoteState>(EVENT_STATE, (e) => {
    const p = e.payload
    useAudioRemoteStoreBase.setState({
      connected: true,
      channels: p.channels,
      masterVolume: p.masterVolume,
      categories: p.categories,
      playMode: p.playMode,
      activeCategory: p.activeCategory,
      radioActive: p.radioActive,
      radioStyle: p.radioStyle,
      radioGenerating: p.radioGenerating,
      mixerInitialized: p.mixerInitialized,
    })
  })
  // 请求 overlay 立即回一帧快照（无需等下一次状态变化）
  void emit(EVENT_COMMAND, { action: 'get-state' } satisfies AudioCommand)
}

/** 主 hook：等价于 useAudioPlayback 的消费面（远程版） */
export function useAudioRemote(): AudioRemoteStore {
  const state = useAudioRemoteStoreBase()
  const bgmChannel =
    state.channels.find((c) => c.kind === 'Bgm' && c.state === 'Playing') ??
    state.channels.find((c) => c.kind === 'Bgm' && c.state === 'Paused') ??
    null
  const sfxChannels = state.channels
    .filter((c) => c.kind === 'Sfx' && c.state !== 'Stopped')
    .map((ch) => {
      if (!ch.source_path) return ch
      const normalizedPath = ch.source_path.replace(/\\/g, '/')
      for (const cat of state.categories) {
        for (const sound of cat.sounds) {
          if (normalizedPath.endsWith(sound.file_path.replace(/\\/g, '/'))) {
            return { ...ch, name: sound.name }
          }
        }
      }
      return ch
    })
  return { ...state, bgmChannel, sfxChannels }
}

export default useAudioRemoteStoreBase
