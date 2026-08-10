import React, { useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useIslandStore } from '../store/islandStore'
import { useAudioPlaybackStore } from '../../vrm/store/audioPlaybackStore'
import { MusicActivity } from './activities/MusicActivity'
import { ThemeActivity } from './activities/ThemeActivity'
import { SfxActivity } from './activities/SfxActivity'
import { MusicPopup } from './MusicPopup/MusicPopup'
import { SfxPopup } from './SfxPopup/SfxPopup'
import { refreshRegions } from '../../../infrastructure/overlay'
import './DynamicIsland.scss'

export const DynamicIsland: React.FC = () => {
  const state = useIslandStore((s) => s.state)
  const setState = useIslandStore((s) => s.setState)
  const popups = useIslandStore((s) => s.popups)
  const openPopup = useIslandStore((s) => s.openPopup)
  const activeActivityId = useIslandStore((s) => s.activeActivityId)
  const activities = useIslandStore((s) => s.activities)
  const setActiveActivity = useIslandStore((s) => s.setActiveActivity)
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
      setActiveActivity('music')
      hoverExpandedRef.current = false
    }
  }, [state, setState, setActiveActivity])

  // Click handler with hover-lock logic + collapse behavior
  // - compact → click → expanded
  // - expanded (hover, not locked) → click → lock (so user can interact
  //   with controls without the island collapsing on mouseleave)
  // - expanded (locked or click-expanded) → click → compact
  // Opening popups is handled by each activity's own expand button
  // (Maximize2 icon) rather than by clicking the island body itself,
  // so the island can be collapsed by clicking anywhere on it.
  // When collapsing, always return to the music activity so the compact
  // pill only ever shows the music playback capsule.
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
      setActiveActivity('music')
      hoverExpandedRef.current = false
      hoverLockedRef.current = false
    }
  }, [state, setState, setActiveActivity])

  // Scroll — only in expanded state (switch activity)
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (state !== 'expanded') return
      const visible = activities.filter((a) => a.visible)
      if (visible.length < 2) return
      const currentIndex = visible.findIndex((a) => a.id === activeActivityId)
      if (currentIndex === -1) return
      const nextIndex =
        e.deltaY > 0
          ? (currentIndex + 1) % visible.length
          : (currentIndex - 1 + visible.length) % visible.length
      setActiveActivity(visible[nextIndex].id)
    },
    [state, activities, activeActivityId, setActiveActivity]
  )

  // Open popup handler for activity buttons
  const handleOpenPopup = useCallback(() => {
    if (activeActivityId === 'music') {
      openPopup('music')
    } else if (activeActivityId === 'sfx') {
      openPopup('sfx')
    }
  }, [activeActivityId, openPopup])

  const renderActivity = () => {
    if (activeActivityId === 'theme') {
      return <ThemeActivity />
    }
    if (activeActivityId === 'sfx') {
      return <SfxActivity onOpenPopup={handleOpenPopup} />
    }
    return <MusicActivity onOpenPopup={handleOpenPopup} />
  }

  const stateClass = `dynamic-island--${state}`
  const playingClass = isPlaying ? ' dynamic-island--playing' : ''

  return createPortal(
    <>
      <div
        className={`dynamic-island no-penetrate ${stateClass}${playingClass}`}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
        onWheel={onWheel}
      >
        {/* Activity content */}
        <div className="dynamic-island__content">
          <div className="dynamic-island__activity-wrapper">
            <div
              key={activeActivityId}
              className="dynamic-island__activity-pane"
            >
              {renderActivity()}
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
