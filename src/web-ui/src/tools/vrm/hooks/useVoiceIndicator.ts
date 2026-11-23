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
  // 充电看门狗：charging 是持续事件，若后端异常中断（漏发结束事件），
  // 超过此时间无后续事件则强制 idle，避免蓝环永久残留。
  const chargeWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const CHARGE_WATCHDOG_MS = 3000
  const coordConverter = useWindowCoordinateConverter()

  const clearChargeWatchdog = () => {
    if (chargeWatchdogRef.current) {
      clearTimeout(chargeWatchdogRef.current)
      chargeWatchdogRef.current = null
    }
  }

  useEffect(() => {
    let unlisteners: UnlistenFn[] = []
    let alive = true

    const setup = async () => {
      try {
        const charging = await listen<VoiceInputChargingEvent>('voice_input_charging', (event) => {
          if (!alive) return
          if (errorHideTimerRef.current) {
            clearTimeout(errorHideTimerRef.current)
            errorHideTimerRef.current = null
          }
          // 状态切换同步执行（不放在 await 后），避免与 error handler 异步乱序
          setVoiceText('voiceInputStarting')
          setChargeProgress(Math.max(0, Math.min(1, event.payload.progress)))
          setVoiceIndicatorMode('charging')
          // 每帧 charging 刷新看门狗：后端仍在发就一直续期，停发超时强制清理
          clearChargeWatchdog()
          chargeWatchdogRef.current = setTimeout(() => {
            setVoiceIndicatorMode('idle')
            setChargeProgress(0)
            chargeWatchdogRef.current = null
          }, CHARGE_WATCHDOG_MS)
          // 坐标异步解析，不阻塞状态切换
          void coordConverter.toLocal(event.payload.x, event.payload.y).then((local) => {
            if (alive) setVoicePosition(local.x, local.y)
          })
        })

        const chargeCancel = await listen('voice_input_charge_cancel', () => {
          if (!alive) return
          clearChargeWatchdog()
          setVoiceIndicatorMode('idle')
          setChargeProgress(0)
        })

        const started = await listen<VoiceInputPositionEvent>('voice_input_started', (event) => {
          if (!alive) return
          if (errorHideTimerRef.current) {
            clearTimeout(errorHideTimerRef.current)
            errorHideTimerRef.current = null
          }
          clearChargeWatchdog()
          playRecordingStartSound()
          setVoiceText('voiceInputActive')
          setChargeProgress(1)
          setVoiceIndicatorMode('recording')
          void coordConverter.toLocal(event.payload.x, event.payload.y).then((local) => {
            if (alive) setVoicePosition(local.x, local.y)
          })
        })

        const stopped = await listen('voice_input_stopped', () => {
          if (!alive) return
          clearChargeWatchdog()
          setVoiceIndicatorMode('idle')
          setChargeProgress(0)
        })

        const error = await listen<VoiceInputErrorEvent>('voice_input_error', (event) => {
          if (!alive) return
          if (errorHideTimerRef.current) {
            clearTimeout(errorHideTimerRef.current)
          }
          clearChargeWatchdog()
          setVoiceText(event.payload.message || 'voiceInputFailed')
          setVoiceIndicatorMode('error')
          errorHideTimerRef.current = setTimeout(() => {
            setVoiceIndicatorMode('idle')
            setChargeProgress(0)
            errorHideTimerRef.current = null
          }, 4000)
          void coordConverter.toLocal(event.payload.x, event.payload.y).then((local) => {
            if (alive) setVoicePosition(local.x, local.y)
          })
        })

        unlisteners = [charging, chargeCancel, started, stopped, error]
      } catch (error) {
        console.error('Failed to bind voice input events:', error)
      }
    }
    setup()
    return () => {
      alive = false
      // 卸载即复位：否则页面切换后重新挂载会显示残留的 charging/error 状态
      setVoiceIndicatorMode('idle')
      setChargeProgress(0)
      if (errorHideTimerRef.current) {
        clearTimeout(errorHideTimerRef.current)
        errorHideTimerRef.current = null
      }
      clearChargeWatchdog()
      for (const unlisten of unlisteners) {
        unlisten()
      }
    }
  }, [setVoiceIndicatorMode, setVoicePosition, setChargeProgress, setVoiceText, coordConverter])
}
