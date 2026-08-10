import { useEffect, useRef, useState } from 'react'
import { audioPlaybackApi } from '../lib/audioPlaybackApi'

const SPECTRUM_BANDS = 24
const POLL_INTERVAL_MS = 50

const emptySpectrum = (): number[] => new Array(SPECTRUM_BANDS).fill(0)

/**
 * Polls real-time audio spectrum data from the Rust AudioMixer.
 *
 * The backend computes 24 frequency bands from the actual audio output
 * callback (RMS energy per band, normalized to 0.0~1.0). This hook polls
 * `audio_get_spectrum` at ~20fps and returns the latest bands.
 *
 * Only polls while `isPlaying` is true to avoid unnecessary IPC traffic.
 */
export function useAudioSpectrum(isPlaying: boolean): number[] {
  const [spectrum, setSpectrum] = useState<number[]>(emptySpectrum)
  const playingRef = useRef(isPlaying)
  playingRef.current = isPlaying

  useEffect(() => {
    if (!isPlaying) {
      setSpectrum(emptySpectrum())
      return
    }

    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      if (!alive) return
      try {
        const data = await audioPlaybackApi.audioGetSpectrum()
        if (alive && data.length > 0) {
          setSpectrum(data)
        }
      } catch {
        // Mixer not ready — keep last values
      }
      if (alive && playingRef.current) {
        timer = setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    timer = setTimeout(poll, POLL_INTERVAL_MS)

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [isPlaying])

  return spectrum
}

/**
 * Downsample 24 spectrum bands into `count` bars by averaging groups.
 * Returns values 0.0~1.0.
 */
export function sampleSpectrum(bands: number[], count: number): number[] {
  if (bands.length === 0) return new Array(count).fill(0)
  if (bands.length <= count) return bands.slice(0, count)

  const step = bands.length / count
  const result: number[] = []
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * step)
    const end = Math.floor((i + 1) * step)
    let sum = 0
    let n = 0
    for (let j = start; j < end && j < bands.length; j++) {
      sum += bands[j]
      n++
    }
    result.push(n > 0 ? sum / n : 0)
  }
  return result
}
