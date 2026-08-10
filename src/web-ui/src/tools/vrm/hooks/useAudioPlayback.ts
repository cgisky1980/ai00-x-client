import { useEffect, useRef } from 'react'
import { useAudioPlaybackStore, generateRadioTrack, pregenRadioNext } from '../store/audioPlaybackStore'
import { audioPlaybackApi } from '../lib/audioPlaybackApi'

export function useAudioPlayback() {
  const store = useAudioPlaybackStore()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevBgmState = useRef<string | null>(null)
  const prevBgmProgress = useRef(0) // track progress when BGM was last Playing

  // Auto-initialize on first use
  useEffect(() => {
    if (!store.mixerInitialized && !store.initializing) {
      store.initialize()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll channel state:
  // - When overlay is expanded (UI needs live data)
  // - When radio is active (need to detect track end)
  // - When playlist is playing (need to detect track end)
  const needsPolling = store.overlayExpanded || store.radioActive || store.playlistPlaying

  useEffect(() => {
    if (needsPolling) {
      store.refreshChannels()
      pollRef.current = setInterval(() => {
        store.refreshChannels()
      }, 1000)
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPolling])

  // Detect BGM channel state changes for playlist auto-next and radio
  const bgmChannelAny = store.channels.find(c => c.kind === 'Bgm')
  const bgmState = bgmChannelAny?.state ?? null
  const bgmPosition = bgmChannelAny?.position_secs ?? 0
  const bgmDuration = bgmChannelAny?.duration_secs ?? 0

  // Track progress on every render (not just when bgmState changes)
  if (bgmState === 'Playing' && bgmDuration > 0) {
    prevBgmProgress.current = bgmPosition / bgmDuration
  }

  useEffect(() => {
    const prev = prevBgmState.current

    // BGM stopped — only trigger auto-next if it finished naturally (played to near the end).
    const bgmStopped = (prev === 'Playing' && bgmState === 'Stopped') ||
                       (prev === 'Playing' && bgmState === null)
    const naturalEnd = prevBgmProgress.current > 0.9

    if (bgmStopped && naturalEnd) {
      // Radio mode: play next pre-generated track or wait for generation
      if (store.radioActive) {
        // Capture current generation ID to detect stale results
        const genId = store.radioGenerationId

        // Clean up previous radio temp file
        const prevFile = store.radioCurrentFilePath
        if (prevFile) {
          audioPlaybackApi.deleteAudioFile(prevFile).catch(() => {})
        }

        if (store.radioNextFilePath) {
          // Pre-generated track ready — play immediately
          const nextFile = store.radioNextFilePath
          store.playBgm(nextFile, 0.8, 0.5, false)
          store.setRadioCurrentFilePath(nextFile)
          store.setRadioNextFilePath(null)
          // Pre-generate the next one
          if (store.radioStyle) {
            pregenRadioNext(store.radioStyle, genId)
          }
        } else if (!store.radioGenerating) {
          // No pre-generated track yet — generate now
          store.setRadioGenerating(true)
          generateRadioTrack(store.radioStyle!, true).then((result) => {
            // Discard if a newer generation was started
            if (useAudioPlaybackStore.getState().radioGenerationId !== genId) return
            store.setRadioCurrentFilePath(result.file_path)
            return store.playBgm(result.file_path, 0.8, 0.5, false)
          }).then(() => {
            if (useAudioPlaybackStore.getState().radioGenerationId !== genId) return
            store.setRadioGenerating(false)
            if (store.radioStyle) {
              pregenRadioNext(store.radioStyle, genId)
            }
          }).catch((e) => {
            console.error('[AudioPlayback] Radio generation failed:', e)
            if (useAudioPlaybackStore.getState().radioGenerationId === genId) {
              store.setRadioGenerating(false)
              store.stopRadio()
            }
          })
        }
      }
      // Playlist mode: auto-play next
      else if (store.playlistPlaying && store.playlist.length > 0) {
        store.playNextInPlaylist()
      }
    }

    // Reset progress tracking when BGM starts playing (new song)
    if (bgmState === 'Playing' && prev !== 'Playing') {
      prevBgmProgress.current = 0
    }

    prevBgmState.current = bgmState
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgmState])

  // Computed values
  const sfxChannels = store.channels
    .filter(c => c.kind === 'Sfx' && c.state !== 'Stopped')
    .map(ch => {
      if (!ch.source_path) return ch
      const normalizedPath = ch.source_path.replace(/\\/g, '/')
      for (const cat of store.categories) {
        for (const sound of cat.sounds) {
          if (normalizedPath.endsWith(sound.file_path.replace(/\\/g, '/'))) {
            return { ...ch, name: sound.name }
          }
        }
      }
      return ch
    })
  const hasActiveChannels = store.channels.some(c => c.state === 'Playing')

  return {
    ...store,
    bgmChannel: store.channels.find(c => c.kind === 'Bgm' && c.state === 'Playing')
      ?? store.channels.find(c => c.kind === 'Bgm' && c.state === 'Paused')
      ?? null,
    sfxChannels,
    previewChannel: store.channels.find(c => c.kind === 'Preview' && c.state !== 'Stopped') ?? null,
    hasActiveChannels,
  }
}
