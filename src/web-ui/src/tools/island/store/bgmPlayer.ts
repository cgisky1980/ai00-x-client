/**
 * BgmPlayer — BGM 播放源仲裁器
 *
 * 职责：
 *   确保同一时刻只有一个 BGM 源（VRM 电台 或 AceStep）活跃播放，
 *   避免双声音重叠。SFX 通道不受此仲裁器管理（环境音效可叠加）。
 *
 * 设计原则：
 *   - 任何 BGM 源启动前必须调用 requestActive(source) 请求仲裁
 *   - 仲裁器会先暂停当前活跃的其他源，再设置新的活跃源
 *   - 关闭/停止播放时调用 releaseSource(source) 释放
 *   - 不自动恢复上一源（用户主动选择）
 *
 * 跨窗口：
 *   - VRM 窗口直接调用 audioPlaybackStore.stopRadio()
 *   - AceStep 窗口通过 Tauri Event 'acestep://player-command' 通信
 */

import { create } from 'zustand'
import { emit } from '@tauri-apps/api/event'
import { useAudioPlaybackStore } from '../../vrm/store/audioPlaybackStore'

/** BGM 播放源类型 */
export type BgmSource = 'vrm-radio' | 'acestep' | null

interface BgmPlayerState {
  /** 当前活跃的 BGM 源（null 表示无源活跃） */
  activeSource: BgmSource
  /** 正在加载中的源（requestActive 期间设置，UI 可显示 loading） */
  pendingSource: BgmSource | null

  /**
   * 请求激活某个 BGM 源。
   * 如果当前已有其他源活跃，会先暂停它。
   * 调用者应在实际启动播放之前调用此方法。
   */
  requestActive: (source: NonNullable<BgmSource>) => Promise<void>
  /**
   * 释放某个 BGM 源（关闭/停止时调用）。
   * 仅当 source 与当前 activeSource 一致时才清空。
   */
  releaseSource: (source: BgmSource) => void
  /** 查询当前是否允许某源播放（用于防御性检查） */
  isSourceAllowed: (source: BgmSource) => boolean
}

export const useBgmPlayerStore = create<BgmPlayerState>((set, get) => ({
  activeSource: null,
  pendingSource: null,

  requestActive: async (source) => {
    const { activeSource } = get()
    // 已是当前源 — 无需操作
    if (activeSource === source) return

    set({ pendingSource: source })

    try {
      // 暂停其他源
      // 1. 如果当前是 VRM 电台，且新源不是 VRM 电台 → 停止电台
      if (source !== 'vrm-radio' && activeSource === 'vrm-radio') {
        useAudioPlaybackStore.getState().stopRadio()
      }
      // 2. 如果当前是 AceStep，且新源不是 AceStep → 暂停 AceStep（跨窗口）
      if (source !== 'acestep' && activeSource === 'acestep') {
        await emit('acestep://player-command', { action: 'togglePlay' }).catch((e) =>
          console.warn('[BgmPlayer] emit togglePlay to acestep failed:', e),
        )
        // 等待 PlayerBridge 心跳同步状态（200ms 足够，心跳 1s 但 emit 是即时的）
        await new Promise((r) => setTimeout(r, 200))
      }

      set({ activeSource: source, pendingSource: null })
    } catch (e) {
      console.error('[BgmPlayer] requestActive failed:', e)
      // 失败时仍设置活跃源，避免卡在 pending 状态
      set({ activeSource: source, pendingSource: null })
    }
  },

  releaseSource: (source) => {
    if (get().activeSource !== source) return
    set({ activeSource: null })
    // 不自动恢复上一源（用户主动选择）
  },

  isSourceAllowed: (source) => {
    const { activeSource } = get()
    return activeSource === null || activeSource === source
  },
}))
