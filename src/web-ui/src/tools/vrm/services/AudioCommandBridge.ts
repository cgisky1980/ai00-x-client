// AudioCommandBridge — overlay 侧音频命令桥（音乐独立窗口 Step 3）。
//
// 背景：audioPlaybackStore 的 SSOT 留在 overlay（电台/SFX/主音量引擎 = Rust mixer +
// 本 store；VRM 桌宠与动态岛都消费它）。「乐」窗口内的电台/SFX/音量 UI 通过
// `music://audio-command` 远程驱动本 store，状态变化以 `music://audio-state`
// 快照（150ms debounce）回广播给音乐窗渲染。
//
// 生命周期：overlay App.tsx 挂载时 startAudioCommandBridge()（与 startPlayerBridge 同模式）。

import { listen, emit } from '@tauri-apps/api/event'
import { useAudioPlaybackStore, type PlayMode } from '../store/audioPlaybackStore'

const EVENT_COMMAND = 'music://audio-command'
const EVENT_STATE = 'music://audio-state'

export type AudioCommand =
  | { action: 'get-state' }
  | { action: 'start-radio'; styleId: string }
  | { action: 'stop-radio' }
  | { action: 'skip-next' }
  | { action: 'set-play-mode'; mode: PlayMode }
  | { action: 'set-master-volume'; volume: number }
  | { action: 'toggle-library-sound'; id: string }
  | { action: 'delete-from-library'; id: string }
  | { action: 'set-active-category'; category: string }
  | { action: 'stop-all-sfx' }
  | { action: 'stop-channel'; id: number }
  | { action: 'set-channel-volume'; id: number; volume: number }
  | { action: 'pause-channel'; id: number }
  | { action: 'resume-channel'; id: number }

function buildSnapshot() {
  const s = useAudioPlaybackStore.getState()
  return {
    channels: s.channels,
    masterVolume: s.masterVolume,
    categories: s.categories,
    playMode: s.playMode,
    activeCategory: s.activeCategory,
    radioActive: s.radioActive,
    radioStyle: s.radioStyle,
    radioGenerating: s.radioGenerating,
    mixerInitialized: s.mixerInitialized,
  }
}

function broadcast() {
  void emit(EVENT_STATE, buildSnapshot())
}

let broadcastTimer: ReturnType<typeof setTimeout> | null = null

function broadcastDebounced() {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    broadcast()
  }, 150)
}

let unlistenCommand: (() => void) | null = null
let unsubscribeStore: (() => void) | null = null

export async function startAudioCommandBridge(): Promise<() => void> {
  if (unlistenCommand) {
    // 幂等：重复调用直接复用现有桥（App 严格模式双重挂载防御）
    return stopAudioCommandBridge
  }

  unlistenCommand = await listen<AudioCommand>(EVENT_COMMAND, (e) => {
    const cmd = e.payload
    const s = useAudioPlaybackStore.getState()
    // 防御初始化：mixer 未就绪时先拉起（音乐窗可能在 overlay 音频 UI 未挂载时发命令）
    if (!s.mixerInitialized && !s.initializing && cmd.action !== 'get-state') {
      void s.initialize()
    }
    switch (cmd.action) {
      case 'get-state':
        broadcast()
        break
      case 'start-radio':
        void s.startRadio(cmd.styleId)
        break
      case 'stop-radio':
        s.stopRadio()
        break
      case 'skip-next':
        void s.skipToNext()
        break
      case 'set-play-mode':
        s.setPlayMode(cmd.mode)
        break
      case 'set-master-volume':
        void s.setMasterVolume(cmd.volume)
        break
      case 'toggle-library-sound':
        void s.toggleLibrarySound(cmd.id)
        break
      case 'delete-from-library':
        void s.deleteFromLibrary(cmd.id)
        break
      case 'set-active-category':
        s.setActiveCategory(cmd.category)
        break
      case 'stop-all-sfx':
        void s.stopAllSfx()
        break
      case 'stop-channel':
        void s.stopChannel(cmd.id)
        break
      case 'set-channel-volume':
        void s.setChannelVolume(cmd.id, cmd.volume)
        break
      case 'pause-channel':
        void s.pauseChannel(cmd.id)
        break
      case 'resume-channel':
        void s.resumeChannel(cmd.id)
        break
    }
  })

  // 状态变化 → debounce 广播快照（channels 每秒轮询刷新，天然驱动进度同步）
  unsubscribeStore = useAudioPlaybackStore.subscribe((state, prev) => {
    if (
      state.channels !== prev.channels ||
      state.masterVolume !== prev.masterVolume ||
      state.categories !== prev.categories ||
      state.playMode !== prev.playMode ||
      state.activeCategory !== prev.activeCategory ||
      state.radioActive !== prev.radioActive ||
      state.radioStyle !== prev.radioStyle ||
      state.radioGenerating !== prev.radioGenerating ||
      state.mixerInitialized !== prev.mixerInitialized
    ) {
      broadcastDebounced()
    }
  })

  broadcast()

  return stopAudioCommandBridge
}

export function stopAudioCommandBridge(): void {
  unlistenCommand?.()
  unsubscribeStore?.()
  unlistenCommand = null
  unsubscribeStore = null
  if (broadcastTimer) {
    clearTimeout(broadcastTimer)
    broadcastTimer = null
  }
}
