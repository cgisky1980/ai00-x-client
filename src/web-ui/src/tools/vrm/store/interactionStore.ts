import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type {
  SpeakerInfo,
  VoiceIndicatorMode,
  VoiceInputConfig,
  SpellEffect,
  ClickEffect,
} from '../types'
import { BLESSING_WORDS, BLESSING_COLORS, getBlessingWordsByLang } from '../systems/gestureEffects'

const CLICK_EFFECT_CONFIG_KEY = 'click_effect_config'

export interface ClickEffectConfig {
  enabled: boolean
  blessingWords: string[]
  blessingColors: string[]
  minValue: number
  maxValue: number
  lang?: string
}

const DEFAULT_CLICK_EFFECT_CONFIG: ClickEffectConfig = {
  enabled: true,
  blessingWords: [...BLESSING_WORDS],
  blessingColors: [...BLESSING_COLORS],
  minValue: 1,
  maxValue: 99,
}

function getDefaultBlessingWords(lang?: string): { words: string[]; lang: string } {
  const resolved = lang || (typeof navigator !== 'undefined' ? (navigator.language || 'zh') : 'zh')
  return { words: [...getBlessingWordsByLang(resolved)], lang: resolved.startsWith('zh') ? 'zh' : 'en' }
}

function loadClickEffectConfig(): ClickEffectConfig {
  try {
    const raw = localStorage.getItem(CLICK_EFFECT_CONFIG_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return { ...DEFAULT_CLICK_EFFECT_CONFIG, ...parsed }
    }
  } catch { /* ignore */ }
  // First load: use language-aware defaults
  const { words, lang } = getDefaultBlessingWords()
  return { ...DEFAULT_CLICK_EFFECT_CONFIG, blessingWords: words, lang }
}

function saveClickEffectConfig(config: ClickEffectConfig) {
  try {
    localStorage.setItem(CLICK_EFFECT_CONFIG_KEY, JSON.stringify(config))
  } catch { /* ignore */ }
}

const defaultVoiceInputConfig: VoiceInputConfig = {
  enabled: true,
  trigger_duration_secs: 0.8,
  charge_show_delay_secs: 0.4,
  input_device_id: '',
  output_device_id: '',
}

interface InteractionState {
  speakers: SpeakerInfo[]
  selectedSpeaker: string
  voiceIndicatorMode: VoiceIndicatorMode
  voicePosition: { x: number; y: number }
  chargeProgress: number
  voiceText: string
  voiceInputConfig: VoiceInputConfig
  spellEffects: SpellEffect[]
  clickEffects: ClickEffect[]
  clickEffectConfig: ClickEffectConfig
  configLoaded: boolean
}

interface InteractionActions {
  setSpeakers: (speakers: SpeakerInfo[]) => void
  reloadSpeakers: () => Promise<void>
  setSelectedSpeaker: (speaker: string) => void
  setVoiceIndicatorMode: (mode: VoiceIndicatorMode) => void
  setVoicePosition: (x: number, y: number) => void
  setChargeProgress: (progress: number) => void
  setVoiceText: (text: string) => void
  setVoiceInputConfig: (update: Partial<VoiceInputConfig>) => void
  addSpellEffect: (effect: SpellEffect) => void
  removeSpellEffect: (id: number) => void
  addClickEffect: (effect: ClickEffect) => void
  removeClickEffect: (id: number) => void
  setClickEffectConfig: (update: Partial<ClickEffectConfig>) => void
  resetClickEffectConfig: (lang?: string) => void
  setConfigLoaded: (loaded: boolean) => void
  loadInteractionConfig: () => Promise<void>
}

export const useInteractionStore = create<InteractionState & InteractionActions>((set, get) => ({
  speakers: [],
  selectedSpeaker: 'Serena',
  voiceIndicatorMode: 'idle',
  voicePosition: { x: -1000, y: -1000 },
  chargeProgress: 0,
  voiceText: '',
  voiceInputConfig: defaultVoiceInputConfig,
  spellEffects: [],
  clickEffects: [],
  clickEffectConfig: loadClickEffectConfig(),
  configLoaded: false,

  setSpeakers: (speakers) => set({ speakers }),

  reloadSpeakers: async () => {
    try {
      const speakerList = await invoke<SpeakerInfo[]>('get_speakers')
      set({ speakers: speakerList })
    } catch (e) {
      console.error('[InteractionStore] Failed to reload speakers:', e)
    }
  },

  setSelectedSpeaker: (speaker) => {
    invoke('set_config', { request: { path: 'vrm.tts_voice_id', value: speaker } }).catch(console.error)
    set({ selectedSpeaker: speaker })
  },

  setVoiceIndicatorMode: (mode) => set({ voiceIndicatorMode: mode }),
  setVoicePosition: (x, y) => set({ voicePosition: { x, y } }),
  setChargeProgress: (progress) => set({ chargeProgress: progress }),
  setVoiceText: (text) => set({ voiceText: text }),

  setVoiceInputConfig: (update) => {
    const current = get().voiceInputConfig
    const newConfig = { ...current, ...update }
    for (const [key, value] of Object.entries(update)) {
      invoke('set_config', { request: { path: `voice_input.${key}`, value } }).catch(console.error)
    }
    set({ voiceInputConfig: newConfig })
  },

  addSpellEffect: (effect) => set((s) => ({ spellEffects: [...s.spellEffects, effect] })),
  removeSpellEffect: (id) => set((s) => ({ spellEffects: s.spellEffects.filter((e) => e.id !== id) })),

  addClickEffect: (effect) => set((s) => ({ clickEffects: [...s.clickEffects, effect] })),
  removeClickEffect: (id) => set((s) => ({ clickEffects: s.clickEffects.filter((e) => e.id !== id) })),

  setClickEffectConfig: (update) => {
    const current = get().clickEffectConfig
    const newConfig = { ...current, ...update }
    saveClickEffectConfig(newConfig)
    set({ clickEffectConfig: newConfig })
  },

  resetClickEffectConfig: (lang?: string) => {
    const { words, lang: resolvedLang } = getDefaultBlessingWords(lang)
    const newConfig = { ...DEFAULT_CLICK_EFFECT_CONFIG, blessingWords: words, blessingColors: [...BLESSING_COLORS], lang: resolvedLang }
    saveClickEffectConfig(newConfig)
    set({ clickEffectConfig: newConfig })
  },

  setConfigLoaded: (loaded) => set({ configLoaded: loaded }),

  loadInteractionConfig: async () => {
    try {
      // Load voice input config from top-level path
      const voiceInput = await invoke<VoiceInputConfig>('get_config', { request: { path: 'voice_input' } })
        .catch(() => null)
      if (voiceInput) {
        set({
          voiceInputConfig: {
            enabled: voiceInput.enabled ?? defaultVoiceInputConfig.enabled,
            trigger_duration_secs: voiceInput.trigger_duration_secs ?? defaultVoiceInputConfig.trigger_duration_secs,
            charge_show_delay_secs: voiceInput.charge_show_delay_secs ?? defaultVoiceInputConfig.charge_show_delay_secs,
            input_device_id: voiceInput.input_device_id ?? defaultVoiceInputConfig.input_device_id,
            output_device_id: voiceInput.output_device_id ?? defaultVoiceInputConfig.output_device_id,
          },
        })
      }

      // Load TTS voice id from legacy vrm config (kept for compatibility)
      const ttsVoiceId = await invoke<string | null>('get_config', { request: { path: 'vrm.tts_voice_id' } })
        .catch(() => null)
      if (ttsVoiceId) {
        set({ selectedSpeaker: ttsVoiceId })
      }

      set({ configLoaded: true })

      // Load speakers list
      try {
        const speakerList = await invoke<SpeakerInfo[]>('get_speakers')
        set({ speakers: speakerList })
        const currentSpeaker = get().selectedSpeaker
        const ids = speakerList.map((s) => s.id)
        if (speakerList.length > 0 && !ids.includes(currentSpeaker)) {
          set({ selectedSpeaker: speakerList[0].id })
        }
      } catch (e) {
        console.error('[InteractionStore] Failed to load speakers:', e)
      }
    } catch (e) {
      console.error('[InteractionStore] Failed to load config:', e)
    }
  },
}))
