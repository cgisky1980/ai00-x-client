import { useEffect, useRef } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { playRecordingStartSound } from '../systems/audioEffects'
import { useInteractionStore } from '../store/interactionStore'
import type { VoiceInputChargingEvent, VoiceInputPositionEvent, VoiceInputErrorEvent } from '../types'

function useWindowCoordinateConverter() {
  const winRef = useRef<import('@tauri-apps/api/window').Window | null>(null)

  const getWin = async () => {
    if (!winRef.current) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      winRef.current = getCurrentWindow()
    }
    return winRef.current
  }

  const toLocal = async (screenX: number, screenY: number) => {
    try {
      const win = await getWin()
      const position = await win.innerPosition()
      const scale = await win.scaleFactor()
      return {
        x: (screenX - position.x) / scale,
        y: (screenY - position.y) / scale,
      }
    } catch {
      return { x: screenX, y: screenY }
    }
  }

  return { toLocal }
}

export function useVoiceIndicator() {
  const setVoiceIndicatorMode = useInteractionStore((s) => s.setVoiceIndicatorMode)
  const setVoicePosition = useInteractionStore((s) => s.setVoicePosition)
  const setChargeProgress = useInteractionStore((s) => s.setChargeProgress)
  const setVoiceText = useInteractionStore((s) => s.setVoiceText)

  const errorHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const coordConverter = useWindowCoordinateConverter()

  useEffect(() => {
    let unlisteners: UnlistenFn[] = []
    let alive = true

    const setup = async () => {
      try {
        const charging = await listen<VoiceInputChargingEvent>('voice_input_charging', async (event) => {
          if (!alive) return
          if (errorHideTimerRef.current) {
            clearTimeout(errorHideTimerRef.current)
            errorHideTimerRef.current = null
          }
          setVoiceText('voiceInputStarting')
          const local = await coordConverter.toLocal(event.payload.x, event.payload.y)
          setVoicePosition(local.x, local.y)
          setChargeProgress(Math.max(0, Math.min(1, event.payload.progress)))
          setVoiceIndicatorMode('charging')
        })

        const chargeCancel = await listen('voice_input_charge_cancel', () => {
          if (!alive) return
          setVoiceIndicatorMode('idle')
          setChargeProgress(0)
        })

        const started = await listen<VoiceInputPositionEvent>('voice_input_started', async (event) => {
          if (!alive) return
          if (errorHideTimerRef.current) {
            clearTimeout(errorHideTimerRef.current)
            errorHideTimerRef.current = null
          }
          playRecordingStartSound()
          setVoiceText('voiceInputActive')
          const local = await coordConverter.toLocal(event.payload.x, event.payload.y)
          setVoicePosition(local.x, local.y)
          setChargeProgress(1)
          setVoiceIndicatorMode('recording')
        })

        const stopped = await listen('voice_input_stopped', () => {
          if (!alive) return
          setVoiceIndicatorMode('idle')
          setChargeProgress(0)
        })

        const error = await listen<VoiceInputErrorEvent>('voice_input_error', async (event) => {
          if (!alive) return
          if (errorHideTimerRef.current) {
            clearTimeout(errorHideTimerRef.current)
          }
          setVoiceText(event.payload.message || 'voiceInputFailed')
          const local = await coordConverter.toLocal(event.payload.x, event.payload.y)
          setVoicePosition(local.x, local.y)
          setVoiceIndicatorMode('error')
          errorHideTimerRef.current = setTimeout(() => {
            setVoiceIndicatorMode('idle')
            setChargeProgress(0)
            errorHideTimerRef.current = null
          }, 4000)
        })

        unlisteners = [charging, chargeCancel, started, stopped, error]
      } catch (error) {
        console.error('Failed to bind voice input events:', error)
      }
    }
    setup()
    return () => {
      alive = false
      if (errorHideTimerRef.current) {
        clearTimeout(errorHideTimerRef.current)
        errorHideTimerRef.current = null
      }
      for (const unlisten of unlisteners) {
        unlisten()
      }
    }
  }, [setVoiceIndicatorMode, setVoicePosition, setChargeProgress, setVoiceText, coordConverter])
}
