import React, { useEffect, useRef, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useSpring, useMotionValueEvent, useReducedMotion } from 'framer-motion'
import { emit, listen } from '@tauri-apps/api/event'
import { useIslandStore } from '../store/islandStore'
import { ISLAND_ROWS, type IslandRowId } from '../islandRows'
import { useAudioPlaybackStore } from '../../vrm/store/audioPlaybackStore'
import { MusicActivity } from './activities/MusicActivity'
import { SfxActivity } from './activities/SfxActivity'
import { ToolsActivity } from './activities/ToolsActivity'
import { WindowAPI } from '@/infrastructure/windows/WindowAPI'
import { refreshRegions } from '../../../infrastructure/overlay'
import './DynamicIsland.scss'

// 弹簧参数： stiffness 高、damping 接近临界，展开利落不晃。
// 带速度积分 → 目标中途改变时保留速度，收展反向不跳变；帧率无关。
const SPRING = { stiffness: 400, damping: 30, mass: 0.85 }

export const DynamicIsland: React.FC = () => {
  const state = useIslandStore((s) => s.state)
  const setState = useIslandStore((s) => s.setState)
  const occluded = useIslandStore((s) => s.occluded)
  const setOccluded = useIslandStore((s) => s.setOccluded)
  const setOverlayExpanded = useAudioPlaybackStore(
    (s) => s.setOverlayExpanded
  )
  const isPlaying = useAudioPlaybackStore((s) =>
    s.channels.some((c) => c.state === 'Playing')
  )

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverExpandedRef = useRef(false)
  const hoverLockedRef = useRef(false)

  // 减动效：系统偏好 + 应用 data-motion 双通道（对齐 motion.css 的开关）。
  const prefersReduced = useReducedMotion()
  const [domReduced, setDomReduced] = useState(
    () => document.documentElement.dataset.motion === 'reduced'
  )
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      setDomReduced(root.dataset.motion === 'reduced')
    })
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-motion'],
    })
    return () => observer.disconnect()
  }, [])
  const reduced = !!prefersReduced || domReduced

  // 全屏避让：前台应用全屏/最大化时收起岛为贴边细线。
  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<{ occluded: boolean }>('island://occlusion', (event) => {
      setOccluded(event.payload.occluded)
    }).then((fn) => { unlisten = fn }).catch(() => {
      // 纯浏览器 dev 环境无 Tauri 事件总线，忽略即可
    })
    return () => unlisten?.()
  }, [setOccluded])

  // 形变进度：0 = compact，1 = expanded。外框尺寸/圆角/内容淡入淡出
  // 全部由这一个 spring 驱动，保证同一条曲线、中途反向不跳变。
  // 全屏避让时强制目标为 0（收起）。
  const target = occluded ? 0 : state === 'expanded' ? 1 : 0
  const progress = useSpring(target, SPRING)
  useEffect(() => {
    progress.set(target)
  }, [target, progress])

  // 形变稳定后再上报命中区，避免穿透区域追着动画跑。
  // 减动效档为瞬时切换（无 animationComplete），单独立即刷新。
  useMotionValueEvent(progress, 'animationComplete', () => refreshRegions())
  useEffect(() => {
    if (reduced) refreshRegions()
  }, [state, reduced])

  // Sync island expanded state with audioPlaybackStore for polling
  useEffect(() => {
    setOverlayExpanded(state !== 'compact')
  }, [state, setOverlayExpanded])

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

  // 行注册表：按用户 order 排序、disabled 仅隐藏视觉（DOM 常驻，保插件槽）。
  const rowConfig = useIslandStore((s) => s.rowConfig)
  const orderedRows = [...ISLAND_ROWS].sort(
    (a, b) => rowConfig[a.id].order - rowConfig[b.id].order
  )

  const renderRow = (id: IslandRowId) => {
    switch (id) {
      case 'music':
        return <MusicActivity onOpenWindow={openMusicWindow} />
      case 'sfx':
        return <SfxActivity onOpenWindow={openSfxWindow} />
      case 'tools':
        return <ToolsActivity />
    }
  }

  const stateClass = `dynamic-island--${state}`
  const playingClass = isPlaying ? ' dynamic-island--playing' : ''
  const occludedClass = occluded ? ' dynamic-island--occluded' : ''

  return createPortal(
    <>
      {/* 边缘唤出区：compact 态下把命中区从岛顶延伸到屏幕顶边。
          光标推到屏幕最上方任意位置即可唤出岛（借鉴岛仔 side_hit_rect）。
          带 no-penetrate 纳入现有穿透链路；展开或全屏避让时移除，避免拦截。 */}
      {state === 'compact' && !occluded && (
        <div
          className="dynamic-island__edge-hit no-penetrate"
          onMouseEnter={onMouseEnter}
        />
      )}
      <motion.div
        className={`dynamic-island no-penetrate ${stateClass}${playingClass}${occludedClass}`}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
        style={
          {
            '--island-progress': reduced ? target : progress,
          } as React.CSSProperties
        }
      >
        {/* 数据驱动的模块化行：顺序/开关来自 islandStore（持久化）。
            所有行 DOM 常驻（插件槽 #ai00-island-slot 在 tools 行内，
            运行时启动时发现一次，不能丢失）；disabled 仅加 --hidden 隐藏视觉。 */}
        <div className="dynamic-island__content">
          <div className="dynamic-island__rows">
            {orderedRows.map((row) => (
              <div
                key={row.id}
                className={`dynamic-island__row dynamic-island__row--${row.id}${
                  row.compactVisible ? ' dynamic-island__row--compact-visible' : ''
                }${
                  rowConfig[row.id].enabled ? '' : ' dynamic-island__row--hidden'
                }`}
              >
                {renderRow(row.id)}
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </>,
    document.body
  )
}
