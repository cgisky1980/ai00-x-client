import React, { useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useIslandStore } from '../store/islandStore'
import { useAudioPlaybackStore } from '../../vrm/store/audioPlaybackStore'
import { MusicActivity } from './activities/MusicActivity'
import { SfxActivity } from './activities/SfxActivity'
import { ToolsActivity } from './activities/ToolsActivity'
import { MusicPopup } from './MusicPopup/MusicPopup'
import { SfxPopup } from './SfxPopup/SfxPopup'
import { refreshRegions } from '../../../infrastructure/overlay'
import './DynamicIsland.scss'

export const DynamicIsland: React.FC = () => {
  const state = useIslandStore((s) => s.state)
  const setState = useIslandStore((s) => s.setState)
  const popups = useIslandStore((s) => s.popups)
  const openPopup = useIslandStore((s) => s.openPopup)
  const setOverlayExpanded = useAudioPlaybackStore(
    (s) => s.setOverlayExpanded
  )
  const isPlaying = useAudioPlaybackStore((s) =>
    s.channels.some((c) => c.state === 'Playing')
  )

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverExpandedRef = useRef(false)
  const hoverLockedRef = useRef(false)

  // Sync island expanded state with audioPlaybackStore for polling
  useEffect(() => {
    setOverlayExpanded(state !== 'compact')
  }, [state, setOverlayExpanded])

  // Refresh no-penetrate regions after the 0.45s CSS transition completes.
  useEffect(() => {
    const timer = setTimeout(() => refreshRegions(), 500)
    return () => clearTimeout(timer)
  }, [state, popups])

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

  // Per-row popup openers (each row owns its own expand target)
  const openMusicPopup = useCallback(() => openPopup('music'), [openPopup])
  const openSfxPopup = useCallback(() => openPopup('sfx'), [openPopup])

  const stateClass = `dynamic-island--${state}`
  const playingClass = isPlaying ? ' dynamic-island--playing' : ''

  return createPortal(
    <>
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
              <MusicActivity onOpenPopup={openMusicPopup} />
            </div>
            <div className="dynamic-island__row dynamic-island__row--sfx">
              <SfxActivity onOpenPopup={openSfxPopup} />
            </div>
            <div className="dynamic-island__row dynamic-island__row--tools">
              <ToolsActivity />
            </div>
          </div>
        </div>
      </div>
      {popups.includes('music') && <MusicPopup />}
      {popups.includes('sfx') && <SfxPopup />}
    </>,
    document.body
  )
}
