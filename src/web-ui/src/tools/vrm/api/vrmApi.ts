import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type {
  GestureConfig,
  GestureBinding,
  GestureTemplateConfig,
  SavedAction,
} from '../types'

export interface PatternActivatedEvent {
  center_x: number
  center_y: number
  grid_size: number
  grid_spacing: number
}

export interface PatternDotSelectedEvent {
  index: number
  x: number
  y: number
}

export interface PatternMatchedEvent {
  name: string
  score: number
  sequence: number[]
  start_x: number
  start_y: number
}

export interface PatternCompletedEvent {
  sequence: number[]
  start_x: number
  start_y: number
}

export interface VoiceInputPositionEvent {
  x: number
  y: number
  is_vrm_dialog: boolean
}

export interface VoiceInputChargingEvent {
  x: number
  y: number
  progress: number
  is_vrm_dialog: boolean
}

export interface VoiceInputStoppedEvent {
  x: number
  y: number
  duration_ms: number
}

export interface VoiceInputAsrDoneEvent {
  text: string
  is_vrm_dialog: boolean
}

export interface VoiceInputErrorEvent {
  message: string
  x: number
  y: number
}

export interface GlobalClickEvent {
  x: number
  y: number
}

export interface AudioDeviceInfo {
  name: string
  device_id: string
  is_default: boolean
}

export interface GlobalVoiceInputStatus {
  running: boolean
  recording: boolean
}

export interface EngineInitStatus {
  asr_initialized: boolean
  tts_initialized: boolean
  llm_initialized: boolean
  embedding_initialized: boolean
  audio_gen_initialized: boolean
}

export interface TtsChunkEvent {
  chunk: string
  is_final: boolean
}

export interface NoPenetrateRect {
  x: number
  y: number
  width: number
  height: number
}

export const vrmApi = {
  gesture: {
    startDetection: () => invoke<void>('start_gesture_detection'),
    stopDetection: () => invoke<void>('stop_gesture_detection'),
    onPatternActivated: (handler: (e: PatternActivatedEvent) => void) =>
      listen<PatternActivatedEvent>('pattern_activated', (event) => handler(event.payload)),
    onPatternDotSelected: (handler: (e: PatternDotSelectedEvent) => void) =>
      listen<PatternDotSelectedEvent>('pattern_dot_selected', (event) => handler(event.payload)),
    onPatternMatched: (handler: (e: PatternMatchedEvent) => void) =>
      listen<PatternMatchedEvent>('pattern_matched', (event) => handler(event.payload)),
    onPatternCompleted: (handler: (e: PatternCompletedEvent) => void) =>
      listen<PatternCompletedEvent>('pattern_completed', (event) => handler(event.payload)),
    onPatternCancelled: (handler: () => void) =>
      listen<void>('pattern_cancelled', () => handler()),
    getConfig: () => invoke<GestureConfig>('get_gesture_config'),
    setConfig: (config: GestureConfig) => invoke<void>('set_gesture_config', { config }),
    addTemplate: (template: GestureTemplateConfig) => invoke<void>('add_gesture_template', { template }),
    removeTemplate: (name: string) => invoke<void>('remove_gesture_template', { name }),
    setBindings: (bindings: GestureBinding[]) => invoke<void>('set_gesture_bindings', { bindings }),
    addSavedAction: (action: SavedAction) => invoke<void>('add_saved_action', { action }),
    removeSavedAction: (id: string) => invoke<void>('remove_saved_action', { id }),
    updateSavedAction: (action: SavedAction) => invoke<void>('update_saved_action', { action }),
  },

  voice: {
    startGlobalVoiceInput: () => invoke<void>('start_global_voice_input_service'),
    stopGlobalVoiceInput: () => invoke<void>('stop_global_voice_input_service'),
    getStatus: () => invoke<GlobalVoiceInputStatus>('get_global_voice_input_status'),
    setVrmInteractionActive: (active: boolean) =>
      invoke<void>('set_vrm_interaction_active_voice', { active }),
    getVrmInteractionActive: () => invoke<boolean>('get_vrm_interaction_active_voice'),
    getAudioInputDevices: () => invoke<AudioDeviceInfo[]>('get_audio_input_devices'),
    getAudioOutputDevices: () => invoke<AudioDeviceInfo[]>('get_audio_output_devices'),
    onVoiceInputStarted: (handler: (e: VoiceInputPositionEvent) => void) =>
      listen<VoiceInputPositionEvent>('voice_input_started', (event) => handler(event.payload)),
    onVoiceInputCharging: (handler: (e: VoiceInputChargingEvent) => void) =>
      listen<VoiceInputChargingEvent>('voice_input_charging', (event) => handler(event.payload)),
    onVoiceInputChargeCancel: (handler: (e: { x: number; y: number }) => void) =>
      listen<{ x: number; y: number }>('voice_input_charge_cancel', (event) => handler(event.payload)),
    onVoiceInputStopped: (handler: (e: VoiceInputStoppedEvent) => void) =>
      listen<VoiceInputStoppedEvent>('voice_input_stopped', (event) => handler(event.payload)),
    onVoiceInputAsrDone: (handler: (e: VoiceInputAsrDoneEvent) => void) =>
      listen<VoiceInputAsrDoneEvent>('voice_input_asr_done', (event) => handler(event.payload)),
    onVoiceInputError: (handler: (e: VoiceInputErrorEvent) => void) =>
      listen<VoiceInputErrorEvent>('voice_input_error', (event) => handler(event.payload)),
    onVrmDialogInput: (handler: (text: string) => void) =>
      listen<string>('vrm_dialog_input', (event) => handler(event.payload)),
  },

  overlay: {
    init: () => invoke<void>('init_overlay'),
    setNoPenetrateRegions: (regions: NoPenetrateRect[]) =>
      invoke<void>('set_no_penetrate_regions', { regions }),
    setVrmInteractionActive: (active: boolean) =>
      invoke<void>('set_vrm_interaction_active', { active }),
    onGlobalClick: (handler: (e: GlobalClickEvent) => void) =>
      listen<GlobalClickEvent>('global_click', (event) => handler(event.payload)),
  },

  tts: {
    onTtsChunk: (handler: (e: TtsChunkEvent) => void) =>
      listen<TtsChunkEvent>('tts_chunk', (event) => handler(event.payload)),
    preview: (speakerId: string, text?: string, instruct?: string) =>
      invoke<void>('tts_preview', { speakerId, text, instruct }),
    deleteSpeaker: (speakerId: string) =>
      invoke<void>('delete_speaker', { speakerId }),
    updateSpeakerMeta: (speakerId: string, name?: string, gender?: string, age?: string) =>
      invoke<string>('update_speaker_meta', { speakerId, name, gender, age }),
    onPreviewChunk: (handler: (e: TtsChunkEvent) => void) =>
      listen<TtsChunkEvent>('tts://preview_chunk', (event) => handler(event.payload)),
    onPreviewDone: (handler: (e: { speaker_id: string }) => void) =>
      listen<{ speaker_id: string }>('tts://preview_done', (event) => handler(event.payload)),
  },

  engine: {
    getInitStatus: () => invoke<EngineInitStatus>('get_engine_init_status'),
    initAsr: (modelDir: string) => invoke<void>('init_asr_engine', { modelDir }),
    reinitAsr: (modelDir: string) => invoke<void>('reinit_asr_engine', { modelDir }),
    reinitTts: (modelDir: string, quant: string) => invoke<void>('reinit_tts_engine', { modelDir, quant }),
    initAudioGen: (modelDir: string, variant: string, mnnGpu: number, mnnInt8: boolean, defaultDuration: number) =>
      invoke<void>('init_audio_gen_engine', { modelDir, variant, mnnGpu, mnnInt8, defaultDuration }),
    reinitAudioGen: (modelDir: string, variant: string, mnnGpu: number, mnnInt8: boolean, defaultDuration: number) =>
      invoke<void>('reinit_audio_gen_engine', { modelDir, variant, mnnGpu, mnnInt8, defaultDuration }),
  },
}

export type VrmApiUnlistenFn = UnlistenFn
