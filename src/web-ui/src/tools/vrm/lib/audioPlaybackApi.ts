import { invoke } from '@tauri-apps/api/core'

export interface ChannelInfo {
  id: number
  name: string
  kind: 'Bgm' | 'Sfx' | 'Preview'
  state: 'Playing' | 'Paused' | 'Stopped'
  volume: number
  loop_enabled: boolean
  source_path: string | null
  /**
   * Decoder position in seconds (how far cpal has read from decoded samples).
   *
   * The actual audible position lags behind this by the total output buffer
   * latency (ring buffer + cpal buffer). Lyric sync compensation is handled
   * on the frontend (`LyricsOverlay`) via a user-adjustable offset.
   */
  position_secs: number
  duration_secs: number
}

export interface SoundEntry {
  id: string
  name: string
  category: string
  file_path: string
  source: 'Builtin' | { Generated: { created_at: number; prompt: string } }
}

export interface SoundCategory {
  id: string
  name: string
  sounds: SoundEntry[]
}

export interface GenerateAudioResult {
  file_path: string
  duration_secs: number
  sample_rate: number
  channels: number
}

export const audioPlaybackApi = {
  initAudioMixer: () => invoke<void>('init_audio_mixer'),
  initSoundLibrary: (soundsDir: string | null) => invoke<string>('init_sound_library', { soundsDir }),
  audioPlayBgm: (path: string, volume: number, fadeInSecs: number, loopEnabled: boolean = true) => invoke<number>('audio_play_bgm', { path, volume, fadeInSecs, loopEnabled }),
  audioPlaySfx: (path: string, volume: number) => invoke<number>('audio_play_sfx', { path, volume }),
  audioPlayPreview: (path: string, volume: number) => invoke<number>('audio_play_preview', { path, volume }),
  audioStopChannel: (id: number, fadeOutSecs: number) => invoke<void>('audio_stop_channel', { id, fadeOutSecs }),
  audioStopAllSfx: () => invoke<void>('audio_stop_all_sfx'),
  audioStopPreview: () => invoke<void>('audio_stop_preview'),
  audioSetChannelVolume: (id: number, volume: number) => invoke<void>('audio_set_channel_volume', { id, volume }),
  audioSetMasterVolume: (volume: number) => invoke<void>('audio_set_master_volume', { volume }),
  audioGetMasterVolume: () => invoke<number>('audio_get_master_volume'),
  audioGetSpectrum: () => invoke<number[]>('audio_get_spectrum'),
  audioPauseChannel: (id: number) => invoke<void>('audio_pause_channel', { id }),
  audioResumeChannel: (id: number) => invoke<void>('audio_resume_channel', { id }),
  audioSeekChannel: (id: number, positionSecs: number) => invoke<void>('audio_seek_channel', { id, positionSecs }),
  audioListChannels: () => invoke<ChannelInfo[]>('audio_list_channels'),
  soundLibraryList: () => invoke<SoundCategory[]>('sound_library_list'),
  soundLibraryPlay: (id: string, volume: number) => invoke<number>('sound_library_play', { id, volume }),
  soundLibrarySave: (sourcePath: string, category: string, name: string, prompt: string) => invoke<SoundEntry>('sound_library_save', { sourcePath, category, name, prompt }),
  soundLibraryDelete: (id: string) => invoke<void>('sound_library_delete', { id }),
  deleteAudioFile: (filePath: string) => invoke<void>('delete_audio_file', { filePath }),
  generateAudio: (request: {
    prompt: string
    negative_prompt: string
    duration: number
    steps: number
    cfg_scale: number
    seed: number | null
    variant: 'sm-music' | 'sm-sfx'
    force_cpu?: boolean
  }) => invoke<GenerateAudioResult>('generate_audio', { request }),
}
