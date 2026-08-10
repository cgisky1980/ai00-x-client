import { useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { vrmApi } from '../api/vrmApi'

/**
 * Initializes non-VRM interaction services: gesture detection, ASR engine,
 * and global voice input. Replaces the service initialization that was
 * previously handled by the deleted useVrmServices hook.
 *
 * Overlay initialization is already done in App.tsx via initOverlaySystem,
 * so it is not repeated here.
 */
export function useInteractionServices() {
  const initialized = useRef(false)

  const initServices = useCallback(async () => {
    if (initialized.current) return
    initialized.current = true

    // Start gesture detection (right-click gesture trail + pattern grid)
    try {
      await vrmApi.gesture.startDetection()
    } catch (e) {
      console.error('[InteractionServices] Failed to start gesture detection:', e)
    }

    // Initialize ASR engine for voice input
    try {
      const exeDir = await invoke<string>('get_exe_dir_cmd')
      await vrmApi.engine.initAsr(exeDir + '/models/asr')
    } catch (e) {
      console.error('[InteractionServices] Failed to init ASR engine:', e)
    }

    // Start global voice input service
    try {
      await vrmApi.voice.startGlobalVoiceInput()
    } catch (e) {
      console.error('[InteractionServices] Failed to start voice input service:', e)
    }
  }, [])

  const cleanup = useCallback(async () => {
    try {
      await vrmApi.gesture.stopDetection()
    } catch {}

    try {
      await vrmApi.voice.stopGlobalVoiceInput()
    } catch {}
  }, [])

  useEffect(() => {
    initServices()
    return () => {
      cleanup()
    }
  }, [initServices, cleanup])
}
