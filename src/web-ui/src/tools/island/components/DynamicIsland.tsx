import React, { useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { emit } from '@tauri-apps/api/event'
import { useIslandStore } from '../store/islandStore'
import { useAudioPlaybackStore } from '../../vrm/store/audioPlaybackStore'
import { MusicActivity } from './activities/MusicActivity'
import { SfxActivity } from './activities/SfxActivity'
import { ToolsActivity } from './activities/ToolsActivity'
import { WindowAPI } from '@/infrastructure/windows/WindowAPI'
import { refreshRegions } from '../../../infrastructure/overlay'
import './DynamicIsland.scss'

// ---- 表情挂件序列帧（素材来自岛仔 Daozai，MIT）----
// 单表情 delighted 16 帧竖排；帧时长表来自 pet_expressions.rs:17-20 短组。
// 用 RAF 写 background-position-y，避开全局 prefers-reduced-motion 对 CSS animation 的钳制。
const EXPR_FRAME_TIMES = [
  0.35, 0.12, 0.12, 0.12, 0.13, 0.13, 0.14, 0.40,
  0.18, 0.14, 0.12, 0.12, 0.12, 0.14, 0.14, 0.45,
]
const EXPR_TOTAL = EXPR_FRAME_TIMES.reduce((a, b) => a + b, 0)
const EXPR_FRAME_H = 30 // 每帧显示高度（px）
const EXPR_REST_FRAME = 7 // 静止/减动效时停第 7 帧（睁眼常态）
const EXPR_URL = `${import.meta.env.BASE_URL}daozai/expressions/03-delighted.png`

/** 表情序列帧播放：data-motion=full 时循环播放，否则停静止帧。 */
function useExpressionFrames(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return

    // 预先挂上素材，让背景图先加载
    el.style.backgroundImage = `url(${EXPR_URL})`
    el.style.backgroundSize = `48px ${EXPR_FRAME_H * EXPR_FRAME_TIMES.length}px`

    const setFrame = (idx: number) => {
      el.style.backgroundPositionY = `${-idx * EXPR_FRAME_H}px`
    }

    // data-motion 优先：仅显式 full 才播放；缺失/reduced 都停静止帧。
    // 对齐岛仔「系统关闭动画时固定第 7 帧」。
    const isFull = () => document.documentElement.getAttribute('data-motion') === 'full'

    let raf = 0
    let elapsed = 0
    let last = 0
    const tick = (now: number) => {
      if (!isFull()) { setFrame(EXPR_REST_FRAME); raf = 0; return }
      if (!last) last = now
      elapsed += (now - last) / 1000
      last = now
      if (elapsed >= EXPR_TOTAL) elapsed = 0 // 循环
      let acc = 0
      let idx = EXPR_REST_FRAME
      for (let i = 0; i < EXPR_FRAME_TIMES.length; i++) {
        acc += EXPR_FRAME_TIMES[i]
        if (elapsed < acc) { idx = i; break }
      }
      setFrame(idx)
      raf = requestAnimationFrame(tick)
    }

    if (isFull()) {
      raf = requestAnimationFrame(tick)
    } else {
      setFrame(EXPR_REST_FRAME)
    }

    // data-motion 变化时启停
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = 0
      elapsed = 0
      last = 0
      if (isFull()) raf = requestAnimationFrame(tick)
      else setFrame(EXPR_REST_FRAME)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [ref])
}

export const DynamicIsland: React.FC = () => {
  const state = useIslandStore((s) => s.state)
  const setState = useIslandStore((s) => s.setState)
  const setOverlayExpanded = useAudioPlaybackStore(
    (s) => s.setOverlayExpanded
  )
  const isPlaying = useAudioPlaybackStore((s) =>
    s.channels.some((c) => c.state === 'Playing')
  )

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverExpandedRef = useRef(false)
  const hoverLockedRef = useRef(false)
  const petRef = useRef<HTMLDivElement | null>(null)
  useExpressionFrames(petRef)

  // Sync island expanded state with audioPlaybackStore for polling
  useEffect(() => {
    setOverlayExpanded(state !== 'compact')
  }, [state, setOverlayExpanded])

  // Refresh no-penetrate regions after the 0.45s CSS transition completes.
  useEffect(() => {
    const timer = setTimeout(() => refreshRegions(), 500)
    return () => clearTimeout(timer)
  }, [state])

  // Hover to expand (compact -> expanded after 300ms)
  const onMouseEnter = useCallback(() => {
    if (state !== 'compact') return
    hoverTimerRef.current = setTimeout(() => {
      hoverExpandedRef.current = true
      hoverLockedRef.current = false
      setState('expanded')
    }, 300)
  }, [state, setState])

  const onMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    // Only collapse if hover-expanded and not yet locked by a click
    if (hoverExpandedRef.current && !hoverLockedRef.current && state === 'expanded') {
      setState('compact')
      hoverExpandedRef.current = false
    }
  }, [state, setState])

  // Click handler with hover-lock logic + collapse behavior
  // - compact → click → expanded
  // - expanded (hover, not locked) → click → lock (so user can interact
  //   with controls without the island collapsing on mouseleave)
  // - expanded (locked or click-expanded) → click → compact
  // Opening popups is handled by each row's own expand button
  // (Maximize2 icon) rather than by clicking the island body itself,
  // so the island can be collapsed by clicking anywhere on it.
  const onClick = useCallback(() => {
    if (state === 'compact') {
      hoverExpandedRef.current = false
      hoverLockedRef.current = false
      setState('expanded')
    } else if (state === 'expanded') {
      // If hover-expanded and not yet locked, first click just locks (don't collapse)
      if (hoverExpandedRef.current && !hoverLockedRef.current) {
        hoverLockedRef.current = true
        return
      }
      // Locked (or click-expanded) — collapse back to compact
      setState('compact')
      hoverExpandedRef.current = false
      hoverLockedRef.current = false
    }
  }, [state, setState])

  // Per-row window openers（音乐独立窗口：弹层已退役，按钮直接开「乐」窗）。
  // SFX 入口开窗后广播分区导航，音乐窗 listen `music://navigate` 定位音效分区。
  const openMusicWindow = useCallback(() => {
    WindowAPI.open('music').catch((e) =>
      console.error('[DynamicIsland] open music window failed:', e),
    )
  }, [])
  const openSfxWindow = useCallback(() => {
    WindowAPI.open('music')
      // 窗口创建后前端还需 bootstrap + 懒加载，延迟广播确保监听已就绪
      .then(() => new Promise((resolve) => setTimeout(resolve, 800)))
      .then(() => emit('music://navigate', { section: 'sfx' }))
      .catch((e) =>
        console.error('[DynamicIsland] open sfx window failed:', e),
      )
  }, [])

  const stateClass = `dynamic-island--${state}`
  const playingClass = isPlaying ? ' dynamic-island--playing' : ''

  return createPortal(
    <>
      {/* 岛外左侧表情挂件：body 下的独立兄弟节点，不进入岛内容流。
          compact 显示、展开淡出；绝不影响 160×40 胶囊的 padding/元素。 */}
      <div className={`daozai-layer daozai-layer--${state}`} aria-hidden="true">
        <div className="daozai-pet" ref={petRef} />
      </div>

      <div
        className={`dynamic-island no-penetrate ${stateClass}${playingClass}`}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
      >
        {/* Single-page three-row layout: music / sfx / tools dock all
            rendered at once in the expanded panel. The Tools row hosts
            the plugin extension slot #ai00-island-slot, which stays in
            the DOM permanently — the plugin runtime discovers it once
            at startup and must not lose it. */}
        <div className="dynamic-island__content">
          <div className="dynamic-island__rows">
            <div className="dynamic-island__row dynamic-island__row--music">
              <MusicActivity onOpenWindow={openMusicWindow} />
            </div>
            <div className="dynamic-island__row dynamic-island__row--sfx">
              <SfxActivity onOpenWindow={openSfxWindow} />
            </div>
            <div className="dynamic-island__row dynamic-island__row--tools">
              <ToolsActivity />
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}
