/**
 * AceStep type definitions.
 *
 * These mirror the Rust DTOs in `src/apps/desktop/src/api/acestep_api.rs` and
 * the `AceRequest` struct from `src/crates/acestep/src/types.rs`.
 *
 * NOTE: `AceRequest` fields are snake_case to match the C++ JSON format
 * expected by acestep.cpp. All other DTOs use camelCase (Tauri convention).
 */

// ---- Task type constants ----
export const TASK_TEXT2MUSIC = 'text2music';
export const TASK_COVER = 'cover';
export const TASK_COVER_NOFSQ = 'cover-nofsq';
export const TASK_REPAINT = 'repaint';
export const TASK_LEGO = 'lego';
export const TASK_EXTRACT = 'extract';
export const TASK_COMPLETE = 'complete';

// ---- Solver constants ----
export const SOLVER_EULER = 'euler';
export const SOLVER_SDE = 'sde';
export const SOLVER_DPM3M = 'dpm3m';
export const SOLVER_STORK4 = 'stork4';

// ---- LM mode constants ----
export const LM_MODE_GENERATE = 'generate';
export const LM_MODE_INSPIRE = 'inspire';
export const LM_MODE_FORMAT = 'format';

// ---- Output format constants ----
export const OUTPUT_FORMAT_MP3 = 'mp3';
export const OUTPUT_FORMAT_WAV16 = 'wav16';
export const OUTPUT_FORMAT_WAV24 = 'wav24';
export const OUTPUT_FORMAT_WAV32 = 'wav32';

// ---- Stage constants ----
export const STAGE_LM = 0;
export const STAGE_DIT = 1;
export const STAGE_VAE = 2;

/**
 * AceStep generation request.
 * Field names are snake_case (matches C++ JSON format).
 */
export interface AceRequest {
  // ---- Text content ----
  caption: string;
  lyrics: string;
  // ---- Metadata ----
  bpm: number;
  duration: number;
  keyscale: string;
  timesignature: string;
  vocal_language: string;
  // ---- Generation ----
  lm_batch_size: number;
  synth_batch_size: number;
  seed: number;
  // ---- LM control ----
  lm_temperature: number;
  lm_cfg_scale: number;
  lm_top_p: number;
  lm_top_k: number;
  lm_negative_prompt: string;
  lm_seed: number;
  use_cot_caption: boolean;
  // ---- Audio codes (for cover mode) ----
  audio_codes: string;
  // ---- DiT control ----
  inference_steps: number;
  guidance_scale: number;
  shift: number;
  // ---- DCW ----
  dcw_scaler: number;
  dcw_high_scaler: number;
  dcw_mode: string;
  // ---- Cover mode ----
  audio_cover_strength: number;
  cover_noise_strength: number;
  // ---- Repaint region ----
  repainting_start: number;
  repainting_end: number;
  // ---- Latent post-processing ----
  latent_shift: number;
  latent_rescale: number;
  // ---- Custom flow matching schedule ----
  custom_timesteps: string;
  // ---- Task type ----
  task_type: string;
  track: string;
  // ---- Solver ----
  solver: string;
  stork_substeps: number;
  // ---- LM mode ----
  lm_mode: string;
  // ---- Audio output ----
  output_format: string;
  peak_clip: number;
  mp3_bitrate: number;
  // ---- Model selection ----
  synth_model: string;
  lm_model: string;
  adapter: string;
  adapter_scale: number;
  vae: string;
}

/** Create a default AceRequest with sensible defaults. */
export function createDefaultAceRequest(): AceRequest {
  return {
    caption: '',
    lyrics: '',
    bpm: 0,
    duration: 0,
    keyscale: '',
    timesignature: '',
    vocal_language: '',
    lm_batch_size: 1,
    synth_batch_size: 1,
    seed: -1,
    lm_temperature: 0.85,
    lm_cfg_scale: 2.0,
    lm_top_p: 0.9,
    lm_top_k: 0,
    lm_negative_prompt: '',
    lm_seed: -1,
    use_cot_caption: true,
    audio_codes: '',
    inference_steps: 0,
    guidance_scale: 0,
    shift: 0,
    dcw_scaler: 0,
    dcw_high_scaler: 0,
    dcw_mode: 'low',
    audio_cover_strength: 1.0,
    cover_noise_strength: 0,
    repainting_start: 0,
    repainting_end: -1,
    latent_shift: 0,
    latent_rescale: 1.0,
    custom_timesteps: '',
    task_type: TASK_TEXT2MUSIC,
    track: '',
    solver: SOLVER_EULER,
    stork_substeps: 10,
    lm_mode: LM_MODE_GENERATE,
    output_format: OUTPUT_FORMAT_MP3,
    peak_clip: 10,
    mp3_bitrate: 128,
    synth_model: '',
    lm_model: '',
    adapter: '',
    adapter_scale: 1.0,
    vae: '',
  };
}

// ---- Creation Plan (LLM-generated) ----

/**
 * Structured creation plan produced by the Ai00-X LLM creation advisor.
 * The LLM takes the user's natural language description and outputs this
 * JSON. The frontend then builds an AceRequest from it and feeds it
 * directly to the DiT (no ACE-Step LM involved).
 */
export interface CreationPlan {
  task_type: string;
  caption: string;
  lyrics: string;
  /** 0 = let DiT auto-infer. */
  bpm: number;
  /** 0 = let DiT auto-infer. */
  duration: number;
  /** '' = let DiT auto-infer. */
  keyscale: string;
  /** '' = let DiT auto-infer. */
  timesignature: string;
  /** '' = let DiT auto-infer. */
  vocal_language: string;
  /** Brief explanation of creative choices. */
  reasoning: string;
}

// ---- DTOs (camelCase, Tauri convention) ----

export interface AceStepStatus {
  loaded: boolean;
  synthLoaded: boolean;
  lmLoaded: boolean;
  libDir: string;
}

/** Local model file status (mirrors Rust `AceStepLocalModel`). */
export interface AceStepLocalModel {
  /** Pipeline role: "lm" | "text_encoder" | "dit" | "vae". */
  role: string;
  /** Human-readable variant label (e.g. "4B-Q8_0", "0.6B-Q8_0"). */
  variant: string;
  /** Filename on disk. */
  filename: string;
  /** Absolute path if exists, empty string otherwise. */
  localPath: string;
  /** True when the file exists on disk. */
  exists: boolean;
  /** File size in bytes (0 if not exists). */
  sizeBytes: number;
}

export interface AceStepSynthLoadRequest {
  textEncoderPath: string;
  ditPath: string;
  vaePath: string;
  adapterPath?: string;
  adapterScale?: number;
  useFa?: boolean;
  clampFp16?: boolean;
  useBatchCfg?: boolean;
  vaeChunk?: number;
  vaeOverlap?: number;
  keepLoaded?: boolean;
}

export interface AceStepLmLoadRequest {
  modelPath: string;
  maxSeq?: number;
  maxBatch?: number;
  useFsm?: boolean;
  useFa?: boolean;
  useBatchCfg?: boolean;
  clampFp16?: boolean;
}

export interface AceStepGenerateRequest {
  request: AceRequest;
  srcAudioPath?: string;
  refAudioPath?: string;
  outputDir?: string;
}

export interface AceStepGenerateResult {
  outputPath: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
}

export interface AceStepProgressEvent {
  stage: number;
  stageName: string;
  step: number;
  total: number;
  msg: string;
}

// ---- LLM completion (for lyrics/caption writing) ----

export interface AceStepLlmCompleteRequest {
  prompt: string;
  systemPrompt?: string;
  model?: string;
}

export interface AceStepLlmCompleteResponse {
  text: string;
}

// ---- LLM chat stream (multi-turn + streaming + model selection) ----

/** A single chat message in a multi-turn conversation. */
export interface AceStepChatMessage {
  /** "user" | "assistant" | "system". */
  role: string;
  content: string;
}

/** Request payload for `acestep_llm_chat_stream`. */
export interface AceStepLlmChatRequest {
  /** Multi-turn message history (oldest first). */
  messages: AceStepChatMessage[];
  systemPrompt?: string;
  /** Model id ("primary" / "fast" / specific id). Defaults to "primary". */
  model?: string;
  /** Session id to scope streamed events. */
  sessionId?: string;
}

/** Payload for the `acestep_llm_chunk` Tauri event. */
export interface AceStepLlmChunkEvent {
  sessionId?: string;
  /** Incremental text delta to append to the assistant message. */
  delta: string;
}

/** Payload for the `acestep_llm_done` Tauri event. */
export interface AceStepLlmDoneEvent {
  sessionId?: string;
  fullText: string;
  /** "ok" | "error". */
  status: string;
  error?: string;
}

// ---- Web search (for lyrics knowledge expansion) ----

/** A single web search result from the acestep_web_search command. */
export interface AceStepSearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ---- Lyrics alignment (Qwen3-ForcedAligner-0.6B pure-Rust inference) ----

/** Request payload for the acestep_align_lyrics command. */
export interface AceStepAlignLyricsRequest {
  audioPath: string;
  lyrics: string;
  language?: string;
  modelDir?: string;
  outputDir?: string;
}

/** Result of the acestep_align_lyrics command. */
export interface AceStepAlignLyricsResult {
  /** LRC-formatted lyrics string (standard `[mm:ss.xx]line` format). */
  lrc: string;
  /** Path where the LRC file was saved. */
  lrcPath: string;
  /** Number of aligned word/character entries. */
  wordCount: number;
  /** Number of LRC lines emitted. */
  lineCount: number;
}

// ---- ForcedAligner model download ----

/** Status of the local ForcedAligner GGUF model file. */
export interface AsrAlignerStatus {
  /** Absolute local path where the file is expected. */
  localPath: string;
  /** True when the file exists on disk. */
  exists: boolean;
  /** File size in bytes (0 if not exists). */
  localSize: number;
  /** Expected file size in bytes (for progress display). */
  expectedSize: number;
  /** Download state: 'idle' | 'pending' | 'downloading' | 'completed' | 'failed'. */
  downloadState: string;
  /** Download progress in bytes. */
  downloadProgress: number;
  /** Download total in bytes (null if unknown / no download in progress). */
  downloadTotal: number | null;
  /** Last error message if the download failed. */
  downloadError: string | null;
}

/** Live download progress for the ForcedAligner GGUF. */
export interface AsrAlignerProgress {
  taskId: string;
  state: string;
  progress: number;
  total: number | null;
  error: string | null;
}

/** Frontend chat message (extends the wire type with rendering metadata). */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** True while the assistant message is still being streamed. */
  streaming?: boolean;
  /** Timestamp (ms since epoch). */
  createdAt: number;
  /** When true, the message contains a parsed CreationPlan (assistant only). */
  hasPlan?: boolean;
  /** Parsed plan (only set when hasPlan is true). */
  plan?: CreationPlan;
  /** Error message if this assistant turn failed. */
  error?: string;
  /** When set, the message is an ask-question with clickable options
   * rendered inline inside the bubble (both text2music and Lego modes).
   * The user clicks one option to auto-send it as a reply. */
  askOptions?: string[];
  /** When true, the user has already answered this ask-question (disables
   * the buttons and shows the chosen answer). */
  askAnswered?: boolean;
  /** When true, this message is an internal system message (lyrics subagent
   * feedback, search results, Lego auto-trigger, etc.) that should be fed
   * to the LLM but NOT displayed in the chat UI. */
  hidden?: boolean;
  /** Content kind hint for rendering. Defaults to 'text' if unset.
   *  - 'text': normal prose (rendered as bubble, optionally collapsed)
   *  - 'lyrics': lyrics subagent output (rendered as a lyrics card)
   *  - 'status': short status indicator like "searching" / "calling subagent"
   */
  kind?: 'text' | 'lyrics' | 'status';
}

// ---- Model catalog & download ----

export interface AceStepCatalogEntry {
  id: string;
  filename: string;
  role: string;
  variant: string;
  approxSizeBytes: number;
  recommended: boolean;
  /**
   * DiT type tag: "base" (2B, 50 steps, supports all tasks),
   * "xl-base" (4B XL, 50 steps, supports all tasks), or
   * "common" for non-DiT entries (LM / text_encoder / VAE).
   */
  ditType: string;
  localPath: string;
  exists: boolean;
  localSize: number;
}

export interface AceStepDownloadProgress {
  taskId: string;
  status: 'Pending' | 'Downloading' | 'Paused' | 'Completed' | 'Failed';
  progress: number;
  total: number;
  error: string | null;
}

export interface AceStepMirrorSpeed {
  mirror: string;
  latencyMs: number | null;
}

// ---- GPU detection & presets ----

/** GPU info detected on the user's machine (mirrors Rust `AceStepGpuInfo`). */
export interface AceStepGpuInfo {
  /** GPU name (e.g. "NVIDIA GeForce RTX 3060") or null if unavailable. */
  gpuName: string | null;
  /** Total VRAM in MB, or null if unavailable. */
  vramMb: number | null;
  /** Backend hint: "cuda" if nvidia-smi succeeded, otherwise null. */
  backend: string | null;
}

/**
 * Preset bundle: a curated set of model files chosen for a specific use case.
 * Mirrors Rust `AceStepPreset`.
 */
export interface AceStepPreset {
  id: string;
  /** "small" or "large" — coarse tier for UI grouping. */
  tier: string;
  /** "base" (2B, 50 steps) or "xl-base" (4B XL, 50 steps). */
  ditType: string;
  /** Sum of approx sizes across all model files in the preset. */
  totalSizeBytes: number;
  /** Recommended minimum VRAM in MB. */
  recommendedVramMb: number;
  /** Number of denoising steps (0 = auto, resolves to 50 for base/xl-base). */
  inferenceSteps: number;
  /** Task names supported by this preset's DiT type. */
  supportedTasks: string[];
  /** Catalog ids that make up this preset. */
  modelIds: string[];
  /** Count of model files in this preset that already exist on disk. */
  downloadedCount: number;
  /** Total number of model files in this preset. */
  totalCount: number;
}

// ---- Session persistence ----

/** Per-dimension audio quality scores (each 0-100). */
export interface AudioScore {
  /** Loudness compliance — 100 when LUFS is within -23..-14 range. */
  loudness: number;
  /** Dynamic range — higher when peak-to-RMS ratio is healthy. */
  dynamicRange: number;
  /** Clipping — 100 when no samples hit the clipping threshold. */
  clipping: number;
  /** Tempo stability — higher when BPM estimation is confident. */
  tempoStability: number;
  /** Spectral balance — higher when low/mid/high energy is balanced. */
  spectralBalance: number;
}

/** Complete song quality score from audio signal analysis. */
export interface SongScore {
  /** Weighted overall score (0-100). */
  overall: number;
  /** Per-dimension audio scores. */
  audio: AudioScore;
  /** Unix timestamp (millis) when scoring was performed. */
  scoredAt: number;
  /** Scoring algorithm version (e.g. "v1-basic"). */
  version: string;
}

/** Generated audio output item (stored in session). */
export interface GeneratedAudio {
  id: string;
  outputPath: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  createdAt: number;
  /** Label for this audio (e.g. "Base instrumental", "Guitar melody layer"). */
  label: string;
  /** LRC-formatted lyrics with timestamps (set after running alignment). */
  lrc?: string;
  /** Path where the .lrc file was saved. */
  lrcPath?: string;
  /** Quality score from audio analysis. Absent when not yet scored. */
  score?: SongScore;
}

// ---- Lego multi-step flow ----

/** Session creation mode. */
export type SessionMode = 'text2music' | 'lego';

/** A single step in the lego multi-track plan. */
export interface LegoStepPlan {
  /** Track name: vocals, drums, bass, guitar, etc. Empty for step 1 (base). */
  track: string;
  /** Caption describing this track's contribution. */
  caption: string;
  /** Lyrics for vocal tracks; "[Instrumental]" for non-vocal. */
  lyrics: string;
  /** Brief explanation of this step's creative choice. */
  reasoning: string;
  /** Duration in seconds. Step 1 sets the song length; steps 2+ inherit it. */
  duration: number;
}

/** A question with options that the LLM asks the user during discussion. */
export interface LegoAskState {
  /** The question text to display. */
  question: string;
  /** Clickable options the user can choose from. */
  options: string[];
}

/** State of the lego multi-step flow (stored in session).
 *
 * Unlike text2music, lego mode plans ONE step at a time: the user discusses
 * with the LLM, the LLM proposes the next layer, the user edits/generates/
 * selects, then they discuss the next layer. Steps are appended iteratively
 * — there is no upfront total step count. */
export interface LegoFlowState {
  /** Current step index (0-based). Equals steps.length while awaiting plan. */
  currentStep: number;
  /** Per-step plans from LLM (appended one at a time as the flow progresses). */
  steps: LegoStepPlan[];
  /** Per-step candidate outputs (2 per step). */
  candidates: GeneratedAudio[][];
  /** User's selected candidate index per step. */
  selectedIndices: number[];
  /** Base audio path for next step's src_audio (previous step's selection). */
  baseAudioPath?: string;
  /** Current ask state (question + options) when phase is 'asking'. */
  askState: LegoAskState | null;
  /** Flow phase.
   *  - 'awaiting-plan': waiting for user to describe the next layer in chat
   *  - 'asking': LLM is asking the user a question with clickable options
   *  - 'planning': LLM has proposed the current step; user can edit before generating
   *  - 'generating': candidates are being generated
   *  - 'selecting': candidates ready, user picks one
   *  - 'completed': user/LLM marked the track as finished
   */
  phase: 'awaiting-plan' | 'asking' | 'planning' | 'generating' | 'selecting' | 'completed';
}

/** Lightweight session metadata for list views (no message bodies). */
export interface AceStepSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** Full session data persisted as JSON on disk (mirrors Rust DTO). */
export interface AceStepSessionData {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** ChatMessage[] as opaque JSON. */
  chatMessages: unknown;
  /** CreationPlan | null as opaque JSON. */
  creationPlan: unknown;
  /** GeneratedAudio[] as opaque JSON. */
  outputs: unknown;
  /** Session mode: "text2music" | "lego". */
  mode: SessionMode;
  /** LegoFlowState | null as opaque JSON. */
  legoState: unknown;
}

/** Frontend session object (typed, used by the store). */
export interface AceStepSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  chatMessages: ChatMessage[];
  creationPlan: CreationPlan | null;
  outputs: GeneratedAudio[];
  /** Session mode. */
  mode: SessionMode;
  /** Lego flow state (only for lego mode). */
  legoState: LegoFlowState | null;
}

// ---- .a00m packaging format ----
//
// Mirrors Rust DTOs in `src/crates/acestep/src/package.rs`. The packaging
// format bundles a generated song (WAV → FLAC) with its lyrics (enhanced
// LRC), full creation context, and metadata into a single ZIP archive for
// the future Ai00-X music player.

/** User info embedded in song.json (optional). */
export interface SongUser {
  id: string;
  name: string;
  displayName?: string;
}

/** Audio metadata embedded in song.json. */
export interface AudioMeta {
  filename: string;
  format: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSeconds: number;
}

/** Lyrics metadata embedded in song.json. */
export interface LyricsMeta {
  filename: string;
  format: string;
  language: string;
}

/** Cover image metadata embedded in song.json. v1.1.0+. */
export interface CoverMeta {
  /** Filename inside the archive (e.g. "cover.jpg"). */
  filename: string;
  /** MIME type: "image/jpeg" | "image/png" | "image/webp". */
  format: string;
  width: number;
  height: number;
}

/**
 * Internal trace info embedded in manifest.json. Auto-filled, not user-editable.
 * Used for copyright tracking and abuse prevention. Distinct from song.json's
 * author fields (artist/album/genre/cover) which are user-facing metadata.
 * v1.1.0+.
 */
export interface InternalTrace {
  machineId: string;
  deviceName: string;
  userId: string;
  userName: string;
  appVersion: string;
  sessionId: string;
  packagedAt: number;
}

/**
 * Frontend-supplied internal trace fields passed to `acestep_package_song`.
 * The backend fills `appVersion` and `packagedAt` itself.
 */
export interface InternalTraceInput {
  machineId: string;
  deviceName: string;
  userId: string;
  userName: string;
  sessionId: string;
}

/** Summary of the creation context stored in the archive. */
export interface CreationSummary {
  mode: string;
  hasPlan: boolean;
  hasLegoState: boolean;
  hasChat: boolean;
}

/** Song-level metadata written to `song.json` inside the archive. */
export interface SongMeta {
  title: string;
  artist: string;
  album: string;
  genre: string;
  durationSeconds: number;
  createdAt: number;
  formatVersion: string;
  user?: SongUser;
  audio: AudioMeta;
  lyrics?: LyricsMeta;
  /** Cover image metadata. v1.1.0+. Absent when no cover was provided. */
  cover?: CoverMeta;
  creation: CreationSummary;
  /** Lego 模式生成的歌曲的段落信息（用于歌词浮层显示段落标签）。
   * text2music 模式生成的歌曲无此字段。 */
  legoState?: { segments?: Array<{ start?: number; end?: number; label?: string }> };
  /** Quality score from audio analysis. Absent when not yet scored. */
  score?: SongScore;
}

/** Manifest entry describing file locations within the archive. */
export interface PackageFiles {
  song: string;
  audio: string;
  lyrics?: string;
  creationRequest?: string;
  creationPlan?: string;
  creationLegoState?: string;
  chat?: string;
  /** Cover image path inside the archive (e.g. "cover.jpg"). v1.1.0+. */
  cover?: string;
}

/** Top-level `manifest.json` content. */
export interface PackageManifest {
  format: string;
  version: string;
  createdAt: number;
  createdAtIso: string;
  producer: string;
  files: PackageFiles;
  /** Internal trace info. v1.1.0+. Absent in v1.0.0 archives. */
  internal?: InternalTrace;
}

/** User-supplied song metadata for packaging (input). */
export interface SongMetaInput {
  title: string;
  artist?: string;
  album?: string;
  genre?: string;
  user?: SongUser;
  lyricsLanguage?: string;
  /** Creation mode: 'text2music' | 'lego'. */
  mode?: string;
  /** Quality score from audio analysis. Absent when not yet scored. */
  score?: SongScore;
}

/** Request payload for the `acestep_package_song` Tauri command. */
export interface PackageSongRequest {
  /** Output .a00m file path. If null, derived from outputDir or audio dir. */
  outputPath?: string | null;
  /** Output directory when outputPath is null. Defaults to audio dir. */
  outputDir?: string | null;
  /** Source WAV file (from `acestep_generate` output). */
  audioPath: string;
  /** LRC content (written directly; takes precedence over lyricsPath). */
  lyrics?: string | null;
  /** LRC file path (read when `lyrics` is null). */
  lyricsPath?: string | null;
  /** Local cover image path (jpg/png/webp). v1.1.0+. */
  coverPath?: string | null;
  /** Internal trace info. v1.1.0+. */
  internal?: InternalTraceInput;
  song: SongMetaInput;
  /** Full AceRequest (generation parameters) — opaque JSON. */
  creationRequest?: unknown;
  /** CreationPlan (LLM creative plan) — opaque JSON. */
  creationPlan?: unknown;
  /** LegoFlowState (multi-step flow) — opaque JSON. */
  legoState?: unknown;
  /** ChatMessage[] (creation history) — opaque JSON. */
  chatMessages?: unknown;
}

/** Result returned by `acestep_package_song`. */
export interface PackageSongResult {
  outputPath: string;
  fileSizeBytes: number;
  manifest: PackageManifest;
  song: SongMeta;
}

/**
 * User-editable options collected by the PackageDialog. Passed to the store's
 * `packageSong(audioId, options)` action, which augments them with internal
 * trace info (machineId/deviceName/userId/...) before invoking the Tauri
 * command.
 */
export interface PackageDialogOptions {
  title: string;
  artist: string;
  album: string;
  genre: string;
  /** Absolute path to the picked cover image, or null if no cover. */
  coverPath: string | null;
  /** Absolute directory path where the `.a00m` file will be written. */
  outputDir: string;
  /** Output filename WITHOUT the `.a00m` extension. */
  filename: string;
}

// ---- Player / library types (v1.3.0) ----

/**
 * A discoverable `.a00m` file on disk, returned by `acestep_list_songs`.
 *
 * Encrypted containers carry `meta = undefined` — the frontend must prompt for
 * a password and call `acestep_read_song_meta_with_password` to view metadata.
 */
export interface SongEntry {
  /** Absolute path to the `.a00m` file. */
  path: string;
  /** Filename (e.g. `song_1737000000000.a00m`). */
  filename: string;
  /** File size in bytes. */
  fileSize: number;
  /** Last-modified time as Unix milliseconds. */
  modifiedAt: number;
  /** `true` when the file is a v1.2.0+ encrypted container (magic `A00M`). */
  isEncrypted: boolean;
  /** Parsed `song.json` metadata. Only present for unencrypted archives. */
  meta?: SongMeta;
}

/**
 * Result of `acestep_unpack_song` — fully unpacked archive contents with
 * filesystem paths to the extracted audio / lyrics and in-memory JSON for
 * the creation context.
 */
export interface UnpackedSong {
  outputDir: string;
  manifest: PackageManifest;
  song: SongMeta;
  audioPath: string;
  lyricsPath?: string;
  creationRequest?: unknown;
  creationPlan?: unknown;
  legoState?: unknown;
  chatMessages?: unknown;
}

/**
 * Field-level updates for `acestep_update_song_meta`. All fields optional —
 * `undefined` means "leave unchanged". `coverPath` replaces the embedded cover
 * image when provided; omit it to keep the existing cover.
 */
export interface SongMetaUpdates {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  /** Absolute path to a new cover image file. Omit to keep existing cover. */
  coverPath?: string;
}
