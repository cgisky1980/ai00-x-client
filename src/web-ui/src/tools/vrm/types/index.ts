import type * as THREE from 'three'

export interface PersonaConfig {
  name: string
  gender: string
  identity: string
  personality: string
  user_title: string
  selected_identity: string
  selected_personality: string
  optional_tics: string[]
  language: string
  style?: string
  tone: string
  backstory: string
}

export interface VrmConfig {
  visible: boolean
  scale: number
  head_scale: number
  model_file: string | null
  position_x: number
  position_y: number
}

export interface SpeakerInfo {
  id: string
  name: string | null
  gender: string | null
  age: string | null
}

export interface VoiceActionSegment {
  speaker: string
  voice: string
  text: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  displayedContent?: string
  timestamp: number
}

/** @deprecated Use Assistant instead */
export interface PersonaProfile {
  id: string
  name: string
  gender: string
  language: string
  selected_identity: string
  selected_personality: string
  user_title: string
  optional_tics: string[]
  tts_speaker_id: string | null
  vrm_model: string | null
  metadata: Record<string, unknown>
}

export interface AssistantPersona {
  gender: string
  identity: string
  personality: string
  user_title: string
  optional_tics: string[]
  language: string
  custom_prompt?: string | null
  tone: string
  backstory: string
}

export interface AssistantAppearance {
  vrm_model: string | null
  scale: number
  head_scale: number
}

export interface AssistantVoice {
  tts_speaker_id: string | null
  voice_style?: string | null
}

export interface AudioGenConfig {
  enabled: boolean
  model_dir: string | null
  variant: 'sm-music' | 'sm-sfx'
  mnn_gpu: number
  mnn_int8: boolean
  default_duration: number
}

export interface AssistantSessionInfo {
  session_id: string | null
}

export interface Assistant {
  id: string
  name: string
  avatar?: string | null
  persona: AssistantPersona
  appearance: AssistantAppearance
  voice: AssistantVoice
  audio_gen?: AudioGenConfig
  session: AssistantSessionInfo
  metadata: Record<string, unknown>
  created_at?: number | null
  updated_at?: number | null
}

export interface GlobalDisplayConfig {
  visible: boolean
  position_x: number
  position_y: number
}

export interface ElementPalette {
  name: string
  colors: Array<{ hue: number; saturation: number; lightness: number }>
}

export interface SpellEffect {
  id: number
  x: number
  y: number
  hue: number
  saturation: number
  lightness: number
  size: number
  type: 'burst' | 'ring' | 'spark' | 'triangle' | 'lightning'
}

export interface ClickEffect {
  id: number
  x: number
  y: number
  text: string
  color: string
}

export interface VoiceInputConfig {
  enabled: boolean
  trigger_duration_secs: number
  charge_show_delay_secs: number
  input_device_id: string
  output_device_id: string
}

export type VoiceIndicatorMode = 'idle' | 'charging' | 'recording' | 'error' | 'vrm_dialog'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface VoiceInputPositionEvent {
  x: number
  y: number
  is_vrm_dialog?: boolean
}

export interface VoiceInputChargingEvent {
  x: number
  y: number
  progress: number
  is_vrm_dialog?: boolean
}

export interface VoiceInputAsrDoneEvent {
  text: string
  is_vrm_dialog?: boolean
}

export interface VoiceInputErrorEvent {
  message: string
  x: number
  y: number
}

export interface TtsSegment {
  id: number
  text: string
  speaker: string
  voice: string
}

export interface AudioChunk {
  segment_id: number
  data: string
  sample_rate: number
  is_last: boolean
}

export type VRMWithUserData = THREE.Group & {
  userData: {
    vrm?: {
      scene: THREE.Group
      expressionManager?: any
      lookAt?: any
      humanoid?: any
    }
  }
  vrmMeta?: {
    metaVersion?: string
  }
}

export interface GestureTemplateConfig {
  name: string
  description: string
  grid_size: number
  sequence: number[]
  builtin: boolean
}

export type GestureActionType = 'OpenSettings' | 'OpenMain' | 'ToggleUnderlay' | 'CustomCommand' | 'None'

export interface GestureAction {
  type: GestureActionType
  params?: Record<string, unknown>
}

export interface GestureBinding {
  gesture_name: string
  action: GestureAction
}

export interface SavedAction {
  id: string
  name: string
  command: string
  args?: string[]
  working_dir?: string
}

export interface GestureConfig {
  enabled: boolean
  trigger_button: number
  grid_size: number
  grid_spacing: number
  long_press_ms: number
  dot_radius: number
  templates: GestureTemplateConfig[]
  bindings: GestureBinding[]
  saved_actions: SavedAction[]
}