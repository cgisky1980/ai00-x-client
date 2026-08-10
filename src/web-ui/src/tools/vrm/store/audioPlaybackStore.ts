import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { audioPlaybackApi, type ChannelInfo, type SoundCategory } from '../lib/audioPlaybackApi'

// BgmPlayer 仲裁器：电台是 BGM 源之一，启动前需请求仲裁（暂停其他 BGM 源）。
// 使用动态 import 避免循环依赖（bgmPlayer 反向导入本 store）。
let bgmPlayerLoaded = false
let requestBgmActive: (source: 'vrm-radio' | 'acestep') => Promise<void> = async () => {}
let releaseBgmSource: (source: 'vrm-radio' | 'acestep' | null) => void = () => {}
async function ensureBgmPlayer() {
  if (bgmPlayerLoaded) return
  bgmPlayerLoaded = true
  const mod = await import('../../island/store/bgmPlayer')
  requestBgmActive = (s) => mod.useBgmPlayerStore.getState().requestActive(s)
  releaseBgmSource = (s) => mod.useBgmPlayerStore.getState().releaseSource(s)
}

// === Playlist Types ===
export interface PlaylistItem {
  id: string
  name: string
  filePath: string
  source: 'library' | 'generated'
  prompt?: string
}

export type PlayMode = 'list' | 'radio'

// === Radio Presets ===
export interface RadioPreset {
  id: string
  name: string
  nameEn: string
  prompt: string
  bpmRange: [number, number] // [min, max] BPM range for the genre
  icon: string
  color: string
}

export const RADIO_PRESETS: RadioPreset[] = [
  {
    id: 'random',
    name: '风格随机',
    nameEn: 'Random',
    prompt: '',
    bpmRange: [0, 0],
    icon: '🎲',
    color: '#8b5cf6',
  },
  {
    id: 'lofi',
    name: 'Lo-Fi 节拍',
    nameEn: 'Lo-Fi Beats',
    prompt: 'Format: Band | Genre: Hip Hop | Subgenre: Lo-Fi | Instruments: Drum Machine, Synthesizer, Vinyl crackle, Warm Bass | Moods: Chill, Mellow, Nostalgic, Relaxing | BPM: {BPM}',
    bpmRange: [70, 90],
    icon: '🎧',
    color: '#a78bfa',
  },
  {
    id: 'rock',
    name: '摇滚',
    nameEn: 'Rock',
    prompt: 'Format: Band | Genre: Rock | Subgenre: Alternative Rock | Instruments: Electric Guitar, Bass Guitar, Drum Kit, Distorted Riffs | Moods: Energetic, Powerful, Rebellious, Raw | BPM: {BPM}',
    bpmRange: [110, 140],
    icon: '🎸',
    color: '#ef4444',
  },
  {
    id: 'eightbit',
    name: '8Bit',
    nameEn: '8Bit',
    prompt: 'Format: Band | Genre: Electronic | Subgenre: Chiptune 8-Bit | Instruments: Game Boy Sound Chip, NES Pulse Wave, Square Wave Bass, Noise Drum | Moods: Nostalgic, Playful, Retro, Bouncy | BPM: {BPM}',
    bpmRange: [120, 150],
    icon: '👾',
    color: '#f59e0b',
  },
  {
    id: 'anime',
    name: '二次元',
    nameEn: 'Anime',
    prompt: 'Format: Band | Genre: Pop | Subgenre: J-Pop Anime | Instruments: Synthesizer, Electric Guitar, Piano, Strings | Moods: Passionate, Dramatic, Emotional, Uplifting | BPM: {BPM}',
    bpmRange: [120, 160],
    icon: '🌸',
    color: '#ec4899',
  },
  {
    id: 'electronic',
    name: '电子音乐',
    nameEn: 'Electronic',
    prompt: 'Format: Band | Genre: Electronic | Subgenre: Synthwave | Instruments: Synthesizer Arp, Deep Bass, Drum Machine, Synth Pads | Moods: Futuristic, Pulsing, Driving, Energetic | BPM: {BPM}',
    bpmRange: [115, 130],
    icon: '⚡',
    color: '#6366f1',
  },
  {
    id: 'cinematic',
    name: '电影配乐',
    nameEn: 'Cinematic',
    prompt: 'Format: Orchestra | Genre: Cinematic | Subgenre: Film Score | Instruments: Sweeping Strings, Brass Section, Timpani, Piano | Moods: Epic, Dramatic, Inspiring, Powerful | BPM: {BPM}',
    bpmRange: [80, 120],
    icon: '🎬',
    color: '#f97316',
  },
  {
    id: 'jazz',
    name: '爵士乐',
    nameEn: 'Jazz',
    prompt: 'Format: Band | Genre: Jazz | Subgenre: Smooth Jazz | Instruments: Saxophone, Piano, Upright Bass, Brush Drums | Moods: Warm, Cozy, Soulful, Late Night | BPM: {BPM}',
    bpmRange: [80, 140],
    icon: '🎷',
    color: '#10b981',
  },
  {
    id: 'ambient',
    name: '氛围音乐',
    nameEn: 'Ambient',
    prompt: 'Format: Band | Genre: Electronic | Subgenre: Ambient | Instruments: Synthesizer Pads, Ethereal Drones, Reverb Tails, Soft Percussion | Moods: Atmospheric, Spacious, Peaceful, Floating | BPM: {BPM}',
    bpmRange: [60, 90],
    icon: '🌌',
    color: '#06b6d4',
  },
  {
    id: 'classical',
    name: '古典音乐',
    nameEn: 'Classical',
    prompt: 'Format: Solo | Genre: Classical | Subgenre: Contemporary Classical | Instruments: Piano, Strings, Harp | Moods: Elegant, Refined, Sentimental, Timeless | BPM: {BPM}',
    bpmRange: [60, 120],
    icon: '🎻',
    color: '#8b5cf6',
  },
  {
    id: 'meditation',
    name: '冥想音乐',
    nameEn: 'Meditation',
    prompt: 'Format: Solo | Genre: Ambient | Subgenre: Meditation | Instruments: Singing Bowls, Deep Drone, Soft Chimes, Flute | Moods: Spiritual, Calming, Mindful, Tranquil | BPM: {BPM}',
    bpmRange: [50, 70],
    icon: '🧘',
    color: '#14b8a6',
  },
  {
    id: 'rnb',
    name: 'R&B 灵魂',
    nameEn: 'R&B / Soul',
    prompt: 'Format: Band | Genre: R&B | Subgenre: Neo-Soul | Instruments: Warm Keys, Bass Guitar, Soft Drums, Horn Stabs | Moods: Smooth, Sensual, Groovy, Soulful | BPM: {BPM}',
    bpmRange: [60, 100],
    icon: '🎤',
    color: '#d946ef',
  },
  {
    id: 'country',
    name: '乡村',
    nameEn: 'Country',
    prompt: 'Format: Band | Genre: Country | Subgenre: Contemporary Country | Instruments: Acoustic Guitar, Fiddle, Steel Guitar, Banjo | Moods: Warm, Storytelling, Down-to-Earth, Heartfelt | BPM: {BPM}',
    bpmRange: [80, 120],
    icon: '🤠',
    color: '#b45309',
  },
  {
    id: 'folk',
    name: '民谣',
    nameEn: 'Folk',
    prompt: 'Format: Solo | Genre: Folk | Subgenre: Indie Folk | Instruments: Acoustic Guitar, Harmonica, Mandolin, Light Percussion | Moods: Intimate, Storytelling, Wistful, Gentle | BPM: {BPM}',
    bpmRange: [85, 120],
    icon: '🏕️',
    color: '#65a30d',
  },
]

// Random variation elements to make each Radio generation unique
// Following Stable Audio 3 prompt structure: instruments, moods, styles
const RADIO_VARIATION_INSTRUMENTS = [
  'Rhodes Piano', 'Celeste', 'Music Box', 'Harp Arpeggio',
  'Vibraphone', 'Marimba', 'Tubular Bells', 'Glockenspiel',
  'Oboe', 'Clarinet', 'French Horn', 'Cello',
  'Acoustic Guitar', 'Kalimba', 'Steel Drum', 'Tape Echo',
]

const RADIO_VARIATION_MOODS = [
  'Dreamy', 'Euphoric', 'Melancholic', 'Mystical',
  'Serene', 'Nostalgic', 'Wistful', 'Contemplative',
  'Ethereal', 'Introspective', 'Hopeful', 'Bittersweet',
  'Luminous', 'Hazy', 'Shimmering', 'Enchanting',
]

const RADIO_VARIATION_STYLES = [
  'Vintage Recording', 'Lo-Fi Texture', 'Reverb-Drenched',
  'Tape Hiss', 'Analog Warmth', 'Bedroom Production',
  'Cinematic', 'Minimalist', 'Layered', 'Expansive',
  'Stripped-Back', 'Raw', 'Lush', 'Textured',
]

export function getRandomVariation(): string {
  const inst = RADIO_VARIATION_INSTRUMENTS[Math.floor(Math.random() * RADIO_VARIATION_INSTRUMENTS.length)]
  const mood = RADIO_VARIATION_MOODS[Math.floor(Math.random() * RADIO_VARIATION_MOODS.length)]
  const style = RADIO_VARIATION_STYLES[Math.floor(Math.random() * RADIO_VARIATION_STYLES.length)]
  return `Instruments: ${inst} | Moods: ${mood} | Styles: ${style}`
}

interface AudioPlaybackState {
  // Init state
  mixerInitialized: boolean
  libraryInitialized: boolean
  initializing: boolean

  // Channel state
  channels: ChannelInfo[]
  masterVolume: number

  // Sound library
  categories: SoundCategory[]
  soundsDir: string

  // UI state
  overlayExpanded: boolean
  playMode: PlayMode
  activeCategory: string
  previewFilePath: string | null
  generating: boolean
  audioGenInitialized: boolean

  // Playlist state
  playlist: PlaylistItem[]
  currentPlaylistIndex: number
  playlistPlaying: boolean

  // Radio state
  radioActive: boolean
  radioStyle: string | null
  radioGenerating: boolean
  radioNextFilePath: string | null
  radioCurrentFilePath: string | null
  radioGenerationId: number  // incremented on each startRadio call to discard stale results

  // Actions
  initialize: () => Promise<void>
  refreshChannels: () => Promise<void>
  refreshLibrary: () => Promise<void>
  playBgm: (path: string, volume?: number, fadeIn?: number, loopEnabled?: boolean) => Promise<void>
  playSfx: (path: string, volume?: number) => Promise<void>
  playPreview: (path: string, volume?: number) => Promise<void>
  stopChannel: (id: number, fadeOut?: number) => Promise<void>
  stopAllSfx: () => Promise<void>
  stopPreview: () => Promise<void>
  setChannelVolume: (id: number, volume: number) => Promise<void>
  setMasterVolume: (volume: number) => Promise<void>
  pauseChannel: (id: number) => Promise<void>
  resumeChannel: (id: number) => Promise<void>

  // Sound library actions (toggle logic)
  toggleLibrarySound: (id: string, volume?: number) => Promise<void>
  playLibrarySoundAsBgm: (id: string, volume?: number) => Promise<void>
  saveToLibrary: (sourcePath: string, category: string, name: string, prompt: string) => Promise<void>
  deleteFromLibrary: (id: string) => Promise<void>

  // UI actions
  toggleOverlay: () => void
  setOverlayExpanded: (expanded: boolean) => void
  setPlayMode: (mode: PlayMode) => void
  setActiveCategory: (category: string) => void
  setPreviewFilePath: (path: string | null) => void
  setGenerating: (generating: boolean) => void

  // Playlist actions
  addToPlaylist: (item: PlaylistItem) => void
  removeFromPlaylist: (index: number) => void
  clearPlaylist: () => void
  playPlaylistItem: (index: number) => Promise<void>
  playNextInPlaylist: () => Promise<void>
  playPrevInPlaylist: () => Promise<void>
  setPlaylistPlaying: (playing: boolean) => void

  // Radio actions
  startRadio: (styleId: string) => Promise<void>
  stopRadio: () => void
  setRadioGenerating: (generating: boolean) => void
  setRadioNextFilePath: (path: string | null) => void
  setRadioCurrentFilePath: (path: string | null) => void
  skipToNext: () => Promise<void>
}

export const useAudioPlaybackStore = create<AudioPlaybackState>((set, get) => ({
  mixerInitialized: false,
  libraryInitialized: false,
  initializing: false,
  channels: [],
  masterVolume: 1.0,
  categories: [],
  soundsDir: '',
  overlayExpanded: false,
  playMode: 'radio',
  activeCategory: '',
  previewFilePath: null,
  generating: false,
  audioGenInitialized: false,
  playlist: [],
  currentPlaylistIndex: -1,
  playlistPlaying: false,
  radioActive: false,
  radioStyle: null,
  radioGenerating: false,
  radioNextFilePath: null,
  radioCurrentFilePath: null,
  radioGenerationId: 0,

  initialize: async () => {
    const state = get()
    if (state.initializing) return
    set({ initializing: true })

    try {
      if (!state.mixerInitialized) {
        console.log('[AudioPlayback] Initializing AudioMixer...')
        await audioPlaybackApi.initAudioMixer()
        console.log('[AudioPlayback] AudioMixer initialized OK')
        set({ mixerInitialized: true })
      }

      if (!state.libraryInitialized) {
        console.log('[AudioPlayback] Initializing SoundLibrary...')
        const soundsDir = await audioPlaybackApi.initSoundLibrary(null)
        console.log('[AudioPlayback] SoundLibrary initialized, dir:', soundsDir)
        set({ libraryInitialized: true, soundsDir })
      }

      await get().refreshChannels()
      await get().refreshLibrary()

      // Fetch master volume once during init; subsequent updates are local
      // (see setMasterVolume).
      try {
        const masterVolume = await audioPlaybackApi.audioGetMasterVolume()
        set({ masterVolume })
      } catch (e) {
        console.warn('[AudioPlayback] Failed to fetch master volume:', e)
      }

      console.log('[AudioPlayback] Init complete, categories:', get().categories.length, 'channels:', get().channels.length)

      try {
        const status = await invoke<{ audio_gen_initialized: boolean }>('get_engine_init_status')
        set({ audioGenInitialized: status.audio_gen_initialized })
      } catch (e) {
        console.warn('[AudioPlayback] Failed to check audio gen status:', e)
      }
    } catch (e) {
      console.error('[AudioPlayback] Failed to initialize:', e)
    } finally {
      set({ initializing: false })
    }
  },

  refreshChannels: async () => {
    try {
      // Only refresh channels; master volume is fetched once in initialize()
      // and updated locally in setMasterVolume().
      const channels = await audioPlaybackApi.audioListChannels()
      set({ channels })
    } catch (e) {
      console.error('[AudioPlayback] Failed to refresh channels:', e)
    }
  },

  refreshLibrary: async () => {
    try {
      const categories = await audioPlaybackApi.soundLibraryList()
      set({ categories })
      if (!get().activeCategory && categories.length > 0) {
        set({ activeCategory: categories[0].id })
      }
    } catch (e) {
      console.error('[AudioPlayback] Failed to refresh library:', e)
    }
  },

  playBgm: async (path, volume = 0.8, fadeIn = 0.5, loopEnabled = true) => {
    try {
      await audioPlaybackApi.audioPlayBgm(path, volume, fadeIn, loopEnabled)
      await get().refreshChannels()
    } catch (e) {
      console.error('[AudioPlayback] Failed to play BGM:', e)
    }
  },

  playSfx: async (path, volume = 0.8) => {
    try {
      await audioPlaybackApi.audioPlaySfx(path, volume)
      await get().refreshChannels()
    } catch (e) {
      console.error('[AudioPlayback] Failed to play SFX:', e)
    }
  },

  playPreview: async (path, volume = 0.5) => {
    try {
      await audioPlaybackApi.audioPlayPreview(path, volume)
      set({ previewFilePath: path })
      await get().refreshChannels()
    } catch (e) {
      console.error('[AudioPlayback] Failed to play preview:', e)
    }
  },

  stopChannel: async (id, fadeOut = 0.3) => {
    try {
      await audioPlaybackApi.audioStopChannel(id, fadeOut)
      await get().refreshChannels()
    } catch (e) {
      console.error('[AudioPlayback] Failed to stop channel:', e)
    }
  },

  stopAllSfx: async () => {
    try {
      await audioPlaybackApi.audioStopAllSfx()
      await get().refreshChannels()
    } catch (e) {
      console.error('[AudioPlayback] Failed to stop all SFX:', e)
    }
  },

  stopPreview: async () => {
    try {
      await audioPlaybackApi.audioStopPreview()
      set({ previewFilePath: null })
      await get().refreshChannels()
    } catch (e) {
      console.error('[AudioPlayback] Failed to stop preview:', e)
    }
  },

  setChannelVolume: async (id, volume) => {
    try {
      await audioPlaybackApi.audioSetChannelVolume(id, volume)
      set((s) => ({
        channels: s.channels.map((c) => c.id === id ? { ...c, volume } : c),
      }))
    } catch (e) {
      console.error('[AudioPlayback] Failed to set channel volume:', e)
    }
  },

  setMasterVolume: async (volume) => {
    try {
      await audioPlaybackApi.audioSetMasterVolume(volume)
      set({ masterVolume: volume })
    } catch (e) {
      console.error('[AudioPlayback] Failed to set master volume:', e)
    }
  },

  pauseChannel: async (id) => {
    try {
      await audioPlaybackApi.audioPauseChannel(id)
      await get().refreshChannels()
    } catch (e) {
      console.error('[AudioPlayback] Failed to pause channel:', e)
    }
  },

  resumeChannel: async (id) => {
    try {
      await audioPlaybackApi.audioResumeChannel(id)
      await get().refreshChannels()
    } catch (e) {
      console.error('[AudioPlayback] Failed to resume channel:', e)
    }
  },

  // Toggle library sound: click to add (play as SFX), click again to remove (stop SFX)
  toggleLibrarySound: async (id, volume = 0.8) => {
    try {
      const categories = get().categories
      let filePath: string | null = null
      for (const cat of categories) {
        const sound = cat.sounds.find(s => s.id === id)
        if (sound) {
          filePath = sound.file_path
          break
        }
      }
      if (filePath) {
        const normalized = filePath.replace(/\\/g, '/')
        const existingCh = get().channels.find(ch => {
          if (!ch.source_path || ch.kind !== 'Sfx') return false
          return ch.source_path.replace(/\\/g, '/').endsWith(normalized)
        })
        if (existingCh) {
          // Already playing -> stop it
          console.log('[AudioPlayback] Toggling off SFX:', existingCh.id)
          await audioPlaybackApi.audioStopChannel(existingCh.id, 0)
          await get().refreshChannels()
          return
        }
      }
      // Not playing -> start it
      console.log('[AudioPlayback] Toggling on SFX:', id)
      const result = await audioPlaybackApi.soundLibraryPlay(id, volume)
      console.log('[AudioPlayback] sound_library_play result:', result)
      await get().refreshChannels()
    } catch (e) {
      console.error('[AudioPlayback] Failed to toggle library sound:', e)
    }
  },

  playLibrarySoundAsBgm: async (id, volume = 0.6) => {
    try {
      const categories = get().categories
      let filePath: string | null = null
      for (const cat of categories) {
        const sound = cat.sounds.find(s => s.id === id)
        if (sound) {
          filePath = sound.file_path
          break
        }
      }
      if (!filePath) throw new Error('Sound not found: ' + id)
      const soundsDir = get().soundsDir
      const fullPath = soundsDir ? `${soundsDir}/${filePath}` : filePath
      await audioPlaybackApi.audioPlayBgm(fullPath, volume, 0.5)
      await get().refreshChannels()
    } catch (e) {
      console.error('[AudioPlayback] Failed to play library sound as BGM:', e)
    }
  },

  saveToLibrary: async (sourcePath, category, name, prompt) => {
    try {
      await audioPlaybackApi.soundLibrarySave(sourcePath, category, name, prompt)
      await get().refreshLibrary()
    } catch (e) {
      console.error('[AudioPlayback] Failed to save to library:', e)
    }
  },

  deleteFromLibrary: async (id) => {
    try {
      const categories = get().categories
      let filePath: string | null = null
      for (const cat of categories) {
        const sound = cat.sounds.find(s => s.id === id)
        if (sound) {
          filePath = sound.file_path
          break
        }
      }
      if (filePath) {
        const normalized = filePath.replace(/\\/g, '/')
        const playingChannels = get().channels.filter(ch => {
          if (!ch.source_path) return false
          return ch.source_path.replace(/\\/g, '/').endsWith(normalized)
        })
        for (const ch of playingChannels) {
          await audioPlaybackApi.audioStopChannel(ch.id, 0)
        }
      }
      await audioPlaybackApi.soundLibraryDelete(id)
      await get().refreshLibrary()
      await get().refreshChannels()
    } catch (e) {
      console.error('[AudioPlayback] Failed to delete from library:', e)
    }
  },

  toggleOverlay: () => set((s) => ({ overlayExpanded: !s.overlayExpanded })),
  setOverlayExpanded: (expanded) => set({ overlayExpanded: expanded }),
  setPlayMode: (mode) => set({ playMode: mode }),
  setActiveCategory: (category) => set({ activeCategory: category }),
  setPreviewFilePath: (path) => set({ previewFilePath: path }),
  setGenerating: (generating) => set({ generating }),

  // Playlist actions
  addToPlaylist: (item) => set((s) => {
    // Avoid duplicates by filePath
    if (s.playlist.some(p => p.filePath === item.filePath)) return s
    return { playlist: [...s.playlist, item] }
  }),

  removeFromPlaylist: (index) => set((s) => {
    const newPlaylist = s.playlist.filter((_, i) => i !== index)
    let newIndex = s.currentPlaylistIndex
    if (index < s.currentPlaylistIndex) {
      newIndex = s.currentPlaylistIndex - 1
    } else if (index === s.currentPlaylistIndex) {
      newIndex = -1
    }
    return { playlist: newPlaylist, currentPlaylistIndex: newIndex }
  }),

  clearPlaylist: () => set({ playlist: [], currentPlaylistIndex: -1, playlistPlaying: false }),

  playPlaylistItem: async (index) => {
    const item = get().playlist[index]
    if (!item) return
    set({ currentPlaylistIndex: index, playlistPlaying: true })
    await get().playBgm(item.filePath, 0.8, 0.5)
  },

  playNextInPlaylist: async () => {
    const { playlist, currentPlaylistIndex } = get()
    if (playlist.length === 0) return
    const nextIndex = (currentPlaylistIndex + 1) % playlist.length
    await get().playPlaylistItem(nextIndex)
  },

  playPrevInPlaylist: async () => {
    const { playlist, currentPlaylistIndex } = get()
    if (playlist.length === 0) return
    const prevIndex = currentPlaylistIndex <= 0 ? playlist.length - 1 : currentPlaylistIndex - 1
    await get().playPlaylistItem(prevIndex)
  },

  setPlaylistPlaying: (playing) => set({ playlistPlaying: playing }),

  // Radio actions
  startRadio: async (styleId) => {
    const preset = RADIO_PRESETS.find(p => p.id === styleId)
    if (!preset) return

    // BgmPlayer 仲裁：暂停其他 BGM 源（如 AceStep），再启动电台
    await ensureBgmPlayer()
    await requestBgmActive('vrm-radio')

    // Increment generation ID to invalidate any in-flight generation
    const genId = get().radioGenerationId + 1

    // Stop current BGM channel immediately (including Paused state).
    // Using fadeOut=0 ensures the channel is removed even when paused,
    // because the feeder thread skips paused channels so fade-out would
    // never complete, leaving a zombie channel that confuses the UI.
    const currentBgm = get().channels.find(c => c.kind === 'Bgm' && c.state !== 'Stopped')
    if (currentBgm) {
      await audioPlaybackApi.audioStopChannel(currentBgm.id, 0)
      await get().refreshChannels()
    }

    // Clean up previous radio temp file
    const prevFile = get().radioCurrentFilePath
    const prevNext = get().radioNextFilePath
    if (prevFile) audioPlaybackApi.deleteAudioFile(prevFile).catch(() => {})
    if (prevNext) audioPlaybackApi.deleteAudioFile(prevNext).catch(() => {})

    set({ radioActive: true, radioStyle: styleId, radioGenerating: true, radioCurrentFilePath: null, radioNextFilePath: null, radioGenerationId: genId })

    try {
      const result = await generateRadioTrack(styleId)
      // Discard result if a newer generation was started
      if (get().radioGenerationId !== genId) return
      await get().playBgm(result.file_path, 0.8, 0.5, false)
      set({ radioGenerating: false, radioCurrentFilePath: result.file_path })
      // Immediately start pre-generating next track
      pregenRadioNext(styleId, genId)
    } catch (e) {
      console.error('[AudioPlayback] Radio generation failed:', e)
      // Only update state if this is still the current generation
      if (get().radioGenerationId === genId) {
        set({ radioGenerating: false, radioActive: false, radioStyle: null })
      }
    }
  },

  stopRadio: () => {
    // Clean up radio temp files
    const currentFile = get().radioCurrentFilePath
    const nextFile = get().radioNextFilePath
    if (currentFile) audioPlaybackApi.deleteAudioFile(currentFile).catch(() => {})
    if (nextFile) audioPlaybackApi.deleteAudioFile(nextFile).catch(() => {})
    // Increment generation ID to invalidate any in-flight generation
    // (otherwise the pending generateRadioTrack would call playBgm after
    //  stopRadio, overriding the new BGM source e.g. AceStep)
    set({
      radioActive: false,
      radioStyle: null,
      radioGenerating: false,
      radioNextFilePath: null,
      radioCurrentFilePath: null,
      radioGenerationId: get().radioGenerationId + 1,
    })
    // Stop BGM immediately (fadeOut=0) — paused channels cannot fade-out
    // because the feeder thread skips them, so we must stop instantly.
    const bgmChannel = get().channels.find(c => c.kind === 'Bgm' && c.state !== 'Stopped')
    if (bgmChannel) {
      audioPlaybackApi.audioStopChannel(bgmChannel.id, 0).catch(() => {})
    }
    // BgmPlayer 仲裁：释放当前 BGM 源
    releaseBgmSource('vrm-radio')
  },

  setRadioGenerating: (generating) => set({ radioGenerating: generating }),
  setRadioNextFilePath: (path) => set({ radioNextFilePath: path }),
  setRadioCurrentFilePath: (path) => set({ radioCurrentFilePath: path }),

  skipToNext: async () => {
    const state = get()
    // Playlist mode: play next in playlist
    if (state.playlistPlaying && state.playlist.length > 0) {
      await state.playNextInPlaylist()
      return
    }
    // Radio mode
    if (state.radioActive && !state.radioGenerating) {
      // Clean up previous radio temp file
      const prevFile = state.radioCurrentFilePath
      if (prevFile) audioPlaybackApi.deleteAudioFile(prevFile).catch(() => {})

      const bgmChannel = state.channels.find(c => c.kind === 'Bgm' && c.state !== 'Stopped')
      if (bgmChannel) {
        await state.stopChannel(bgmChannel.id, 0.3)
      }

      // Increment generation ID for the skip operation
      const genId = state.radioGenerationId + 1
      set({ radioGenerationId: genId })

      if (state.radioNextFilePath) {
        // Pre-generated track available, play it immediately
        const nextFile = state.radioNextFilePath
        await state.playBgm(nextFile, 0.8, 0.5, false)
        set({ radioNextFilePath: null, radioCurrentFilePath: nextFile })
        // Pre-generate the next one
        pregenRadioNext(state.radioStyle!, genId)
      } else {
        // No pre-generated track, generate now
        state.setRadioGenerating(true)
        try {
          const result = await generateRadioTrack(state.radioStyle!, true)
          // Discard if a newer generation was started
          if (get().radioGenerationId !== genId) return
          await state.playBgm(result.file_path, 0.8, 0.5, false)
          set({ radioGenerating: false, radioCurrentFilePath: result.file_path })
          pregenRadioNext(state.radioStyle!, genId)
        } catch (e) {
          console.error('[AudioPlayback] Skip next generation failed:', e)
          if (get().radioGenerationId === genId) {
            state.setRadioGenerating(false)
          }
        }
      }
    }
  },
}))

// === Radio Helper Functions (must be after store definition) ===

function generateRadioTrack(styleId: string, forceCpu: boolean = false) {
  const preset = RADIO_PRESETS.find(p => p.id === styleId)
  if (!preset) throw new Error('Invalid radio style')

  const actualPreset = preset.id === 'random'
    ? RADIO_PRESETS.filter(p => p.id !== 'random')[Math.floor(Math.random() * (RADIO_PRESETS.length - 1))]
    : preset

  const [bpmMin, bpmMax] = actualPreset.bpmRange
  const randomBpm = bpmMin + Math.floor(Math.random() * (bpmMax - bpmMin + 1))
  const variation = getRandomVariation()
  const enrichedPrompt = actualPreset.prompt.replace('{BPM}', String(randomBpm)) + ' | ' + variation

  return audioPlaybackApi.generateAudio({
    prompt: enrichedPrompt,
    negative_prompt: '',
    duration: 120,
    steps: 8,
    cfg_scale: 1.0,
    seed: null,
    variant: 'sm-music',
    force_cpu: forceCpu,
  })
}

/** Pre-generate the next radio track in the background using CPU (fire-and-forget) */
function pregenRadioNext(styleId: string, genId?: number) {
  const store = useAudioPlaybackStore.getState()
  if (!store.radioActive || store.radioNextFilePath) return
  // Capture the generation ID to discard stale results
  const expectedGenId = genId ?? store.radioGenerationId

  store.setRadioGenerating(true)
  generateRadioTrack(styleId, true)
    .then((result) => {
      const current = useAudioPlaybackStore.getState()
      // Discard if a newer generation was started
      if (current.radioGenerationId !== expectedGenId) return
      current.setRadioNextFilePath(result.file_path)
      current.setRadioGenerating(false)
    })
    .catch((e) => {
      console.error('[AudioPlayback] Radio pre-generation failed:', e)
      const current = useAudioPlaybackStore.getState()
      if (current.radioGenerationId === expectedGenId) {
        current.setRadioGenerating(false)
      }
    })
}

export { generateRadioTrack, pregenRadioNext }
