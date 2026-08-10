import { useEffect, useRef, useCallback, useMemo, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { playSpellSound } from '../systems/audioEffects'
import { notificationService } from '@/shared/notification-system'
import {
  type ElementPalette,
  ELEMENT_PALETTES,
  BLESSING_WORDS,
  BLESSING_COLORS,
  getCurrentElementPalette,
  setCurrentElementPalette,
} from '../systems/gestureEffects'
import { useInteractionStore } from '../store/interactionStore'
import { vrmApi } from '../api/vrmApi'
import { refreshRegions } from '../lib/mouseThrough'
import type { GestureBinding, GestureTemplateConfig, GestureActionType } from '../types'
import { useI18n } from '@/infrastructure/i18n'

interface PatternActivatedEvent {
  center_x: number
  center_y: number
  grid_size: number
  grid_spacing: number
}

interface PatternMatchedEvent {
  name: string
  score: number
  sequence: number[]
  start_x: number
  start_y: number
}

let clickEffectId = 0

export interface MatchAction {
  templateName: string
  actionLabel: string
  action: GestureBinding['action']
  sequence: number[]
}

function getActionLabel(action: { type: string; params?: Record<string, unknown> }, t: (key: string, options?: Record<string, unknown>) => string): string {
  switch (action.type) {
    case 'OpenSettings': return t('patternGrid.openSettings')
    case 'OpenMain': return t('patternGrid.openMain')
    case 'CustomCommand': {
      const cmd = action.params?.command
      return typeof cmd === 'string' && cmd ? cmd.slice(0, 12) : t('patternGrid.customCommand')
    }
    case 'None': return t('patternGrid.effectOnly')
    default: return action.type
  }
}

interface UsePatternGridOptions {
  onOpenSettings: () => void
  onOpenMain: () => void
}

export function usePatternGrid(options: UsePatternGridOptions) {
  const { t } = useI18n('vrm')
  const addSpellEffect = useInteractionStore((s) => s.addSpellEffect)
  const removeSpellEffect = useInteractionStore((s) => s.removeSpellEffect)
  const addClickEffect = useInteractionStore((s) => s.addClickEffect)
  const removeClickEffect = useInteractionStore((s) => s.removeClickEffect)
  const clickEffectConfig = useInteractionStore((s) => s.clickEffectConfig)

  const spellEffectIdRef = useRef(0)
  const bindingsRef = useRef<GestureBinding[]>([])
  const templatesRef = useRef<GestureTemplateConfig[]>([])
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [gridVisible, setGridVisible] = useState(false)
  const [gridCenter, setGridCenter] = useState({ x: 0, y: 0 })
  const [gridSize, setGridSize] = useState(3)
  const [gridSpacing, setGridSpacing] = useState(80)
  const [selectedDots, setSelectedDots] = useState<number[]>([])
  const [currentPalette, setCurrentPaletteState] = useState<ElementPalette | null>(null)
  const activationCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const triggerSpellEffect = useCallback(
    (centerX: number, centerY: number, palette: ElementPalette, gestureName?: string) => {
      playSpellSound()

      const isTriangle = gestureName?.toLowerCase().includes('triangle')

      const imprintId = ++spellEffectIdRef.current
      const imprintColor = palette.colors[0]
      addSpellEffect({
        id: imprintId,
        x: centerX,
        y: centerY,
        hue: imprintColor.hue,
        saturation: imprintColor.saturation,
        lightness: imprintColor.lightness + 20,
        size: 80,
        type: 'spark',
      })
      setTimeout(() => removeSpellEffect(imprintId), 400)

      for (let ring = 0; ring < 4; ring++) {
        const ringId = ++spellEffectIdRef.current
        const ringSize = 30 + ring * 30
        const baseColor = palette.colors[ring % palette.colors.length]

        setTimeout(() => {
          addSpellEffect({
            id: ringId,
            x: centerX,
            y: centerY,
            hue: baseColor.hue,
            saturation: baseColor.saturation,
            lightness: baseColor.lightness + 15,
            size: ringSize,
            type: isTriangle ? 'triangle' : 'ring',
          })
        }, ring * 80)

        setTimeout(() => {
          removeSpellEffect(ringId)
        }, 600 + ring * 80)
      }

      const sparkId = ++spellEffectIdRef.current
      const baseColor = palette.colors[0]
      addSpellEffect({
        id: sparkId,
        x: centerX,
        y: centerY,
        hue: baseColor.hue,
        saturation: 30,
        lightness: 98,
        size: 70,
        type: 'spark',
      })
      setTimeout(() => removeSpellEffect(sparkId), 400)

      const burstCount = 45
      for (let i = 0; i < burstCount; i++) {
        const colorIndex = Math.floor(Math.random() * palette.colors.length)
        const bc = palette.colors[colorIndex]
        const id = ++spellEffectIdRef.current
        const angle = (Math.PI * 2 * i) / burstCount + (Math.random() - 0.5) * 0.3
        const distance = 40 + Math.random() * 120

        addSpellEffect({
          id,
          x: centerX + Math.cos(angle) * distance,
          y: centerY + Math.sin(angle) * distance,
          hue: bc.hue + (Math.random() - 0.5) * 25,
          saturation: bc.saturation,
          lightness: bc.lightness + Math.random() * 25,
          size: 6 + Math.random() * 14,
          type: 'burst',
        })
        setTimeout(() => removeSpellEffect(id), 900)
      }

      const innerRingCount = 12
      for (let i = 0; i < innerRingCount; i++) {
        const colorIndex = i % palette.colors.length
        const ic = palette.colors[colorIndex]
        const id = ++spellEffectIdRef.current
        const angle = (Math.PI * 2 * i) / innerRingCount
        const distance = 25 + Math.random() * 30

        setTimeout(() => {
          addSpellEffect({
            id,
            x: centerX + Math.cos(angle) * distance,
            y: centerY + Math.sin(angle) * distance,
            hue: ic.hue,
            saturation: ic.saturation,
            lightness: ic.lightness + 30,
            size: 4 + Math.random() * 6,
            type: 'spark',
          })
        }, 100)

        setTimeout(() => removeSpellEffect(id), 500)
      }

      const lightningCount = 3
      for (let l = 0; l < lightningCount; l++) {
        const lightningId = ++spellEffectIdRef.current
        const lc = palette.colors[l % palette.colors.length]

        setTimeout(() => {
          addSpellEffect({
            id: lightningId,
            x: centerX,
            y: centerY,
            hue: lc.hue,
            saturation: lc.saturation,
            lightness: lc.lightness + 25,
            size: 60 + Math.random() * 40,
            type: 'lightning',
          })
        }, l * 120)

        setTimeout(() => removeSpellEffect(lightningId), 500 + l * 120)
      }
    },
    [addSpellEffect, removeSpellEffect],
  )

  const dispatchAction = useCallback(
    (action: { type: string; params?: Record<string, unknown> }) => {
      switch (action.type) {
        case 'OpenSettings':
          optionsRef.current.onOpenSettings()
          break
        case 'OpenMain':
          optionsRef.current.onOpenMain()
          break
        case 'ToggleUnderlay':
          invoke('execute_custom_command', { command: 'show_underlay' }).catch((e) => {
            console.error('[Pattern] ToggleUnderlay failed:', e)
          })
          break
        case 'CustomCommand': {
          const command = action.params?.command
          if (typeof command === 'string' && command.trim()) {
            invoke('execute_custom_command', { command }).catch((e) => {
              console.error('[Pattern] CustomCommand failed:', e)
            })
          }
          break
        }
        default:
          break
      }
    },
    [],
  )

  const hideGrid = useCallback(() => {
    setGridVisible(false)
    setSelectedDots([])
    setTimeout(() => refreshRegions(), 50)
  }, [])

  const handleDotSelect = useCallback((index: number) => {
    setSelectedDots((prev) => {
      if (prev.includes(index)) return prev
      return [...prev, index]
    })
  }, [])

  const handleDotUndo = useCallback(() => {
    setSelectedDots((prev) => prev.slice(0, -1))
  }, [])

  const handleConfirm = useCallback(async () => {
    const sequence = selectedDots
    if (sequence.length < 2) {
      hideGrid()
      invoke('cancel_pattern').catch(() => {})
      return
    }

    const palette = getCurrentElementPalette()
    if (palette) {
      triggerSpellEffect(gridCenter.x, gridCenter.y, palette)
    }

    try {
      const result = await invoke<PatternMatchedEvent | null>('match_pattern', {
        sequence,
        startX: Math.round(activationCenterRef.current.x),
        startY: Math.round(activationCenterRef.current.y),
      })

      if (result) {
        notificationService.info(result.name, { duration: 1500 })

        const binding = bindingsRef.current.find(
          (b) => b.gesture_name === result.name,
        )
        if (binding) {
          dispatchAction(binding.action)
        }
      } else {
        notificationService.info('Unknown pattern', { duration: 1500 })
      }
    } catch (_e) {
      // ignore
    }

    hideGrid()
  }, [selectedDots, gridCenter, hideGrid, triggerSpellEffect, dispatchAction])

  const matchingActions = useMemo<MatchAction[]>(() => {
    if (selectedDots.length === 0) return []
    const matches: MatchAction[] = []
    for (const template of templatesRef.current) {
      if (template.sequence.length < 2) continue
      const prefix = template.sequence.slice(0, selectedDots.length)
      if (prefix.length === selectedDots.length && prefix.every((v, i) => v === selectedDots[i])) {
        const binding = bindingsRef.current.find((b) => b.gesture_name === template.name)
        const action = binding?.action ?? { type: 'None' as GestureActionType }
        matches.push({ templateName: template.name, actionLabel: getActionLabel(action, t), action, sequence: template.sequence })
      }
    }
    return matches.slice(0, 4)
  }, [selectedDots, t])

  const handleQuickAction = useCallback(
    (matchIndex: number) => {
      const match = matchingActions[matchIndex]
      if (!match) return

      const palette = getCurrentElementPalette()
      if (palette) {
        triggerSpellEffect(gridCenter.x, gridCenter.y, palette)
      }

      dispatchAction(match.action)
      hideGrid()
    },
    [matchingActions, gridCenter, triggerSpellEffect, dispatchAction, hideGrid],
  )

  useEffect(() => {
    let unlisten: UnlistenFn | null = null
    let alive = true

    const setup = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()

        unlisten = await listen<{ x: number; y: number }>('global_click', async (event) => {
          if (!alive) return
          const cfg = clickEffectConfig
          if (!cfg.enabled) return

          const position = await win.innerPosition()
          const scale = await win.scaleFactor()
          const localX = (event.payload.x - position.x) / scale
          const localY = (event.payload.y - position.y) / scale

          const words = cfg.blessingWords.length > 0 ? cfg.blessingWords : BLESSING_WORDS
          const colors = cfg.blessingColors.length > 0 ? cfg.blessingColors : BLESSING_COLORS
          const word = words[Math.floor(Math.random() * words.length)]
          const range = cfg.maxValue - cfg.minValue
          const value = range > 0 ? Math.floor(Math.random() * range) + cfg.minValue : cfg.minValue
          const color = colors[Math.floor(Math.random() * colors.length)]
          const id = ++clickEffectId

          addClickEffect({ id, x: localX, y: localY, text: `${word} + ${value}`, color })
          setTimeout(() => removeClickEffect(id), 1200)
        })
      } catch (error) {
        console.error('Failed to bind global_click event:', error)
      }
    }
    setup()
    return () => {
      alive = false
      if (unlisten) unlisten()
    }
  }, [addClickEffect, removeClickEffect, clickEffectConfig])

  useEffect(() => {
    let unlistenActivated: UnlistenFn | null = null
    let unlistenCancelled: UnlistenFn | null = null
    let unlistenMatched: UnlistenFn | null = null
    let alive = true

    const setup = async () => {
      try {
        const config = await vrmApi.gesture.getConfig()
        bindingsRef.current = config.bindings
        templatesRef.current = config.templates
      } catch (_e) {
        bindingsRef.current = []
      }

      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()

        const toLocal = async (screenX: number, screenY: number) => {
          const position = await win.innerPosition()
          const scale = await win.scaleFactor()
          return {
            x: (screenX - position.x) / scale,
            y: (screenY - position.y) / scale,
          }
        }

        unlistenActivated = await listen<PatternActivatedEvent>('pattern_activated', async (event) => {
          if (!alive) return

          try {
            const freshConfig = await vrmApi.gesture.getConfig()
            bindingsRef.current = freshConfig.bindings
            templatesRef.current = freshConfig.templates
          } catch (_e) {
            // keep existing bindings as fallback
          }

          const local = await toLocal(event.payload.center_x, event.payload.center_y)
          const palette = ELEMENT_PALETTES[Math.floor(Math.random() * ELEMENT_PALETTES.length)]
          setCurrentElementPalette(palette)
          setCurrentPaletteState(palette)
          activationCenterRef.current = { x: event.payload.center_x, y: event.payload.center_y }
          setGridVisible(true)
          setGridCenter({ x: local.x, y: local.y })
          setGridSize(event.payload.grid_size)
          setGridSpacing(event.payload.grid_spacing)
          setSelectedDots([])
          setTimeout(() => refreshRegions(), 50)
        })

        unlistenCancelled = await listen('pattern_cancelled', () => {
          if (!alive) return
          hideGrid()
        })

        unlistenMatched = await listen<PatternMatchedEvent>('pattern_matched', () => {
          // handled by frontend directly via handleConfirm
        })
      } catch (error) {
        console.error('Failed to bind pattern events:', error)
      }
    }
    setup()
    return () => {
      alive = false
      if (unlistenActivated) unlistenActivated()
      if (unlistenCancelled) unlistenCancelled()
      if (unlistenMatched) unlistenMatched()
    }
  }, [hideGrid])

  return {
    gridVisible,
    gridCenter,
    gridSize,
    gridSpacing,
    setGridSpacing,
    selectedDots,
    currentPalette,
    matchingActions,
    handleDotSelect,
    handleDotUndo,
    handleConfirm,
    handleQuickAction,
  }
}
