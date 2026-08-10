/**
 * AceStep API service.
 *
 * Wraps Tauri commands exposed by `src/apps/desktop/src/api/acestep_api.rs`.
 * Each method corresponds to one `#[tauri::command]` function.
 */

import { api } from '@/infrastructure/api/service-api/ApiClient';
import { createTauriCommandError } from '@/infrastructure/api/errors/TauriCommandError';
import { tokenManager } from '@/infrastructure/auth/TokenManager';
import type {
  AceStepAlignLyricsRequest,
  AceStepAlignLyricsResult,
  AceStepCatalogEntry,
  AceStepDownloadProgress,
  AceStepGenerateRequest,
  AceStepGenerateResult,
  AceStepGpuInfo,
  AceStepLlmChatRequest,
  AceStepLlmCompleteRequest,
  AceStepLlmCompleteResponse,
  AceStepLmLoadRequest,
  AceStepLocalModel,
  AceStepMirrorSpeed,
  AceStepPreset,
  AceStepSearchResult,
  AceStepSessionData,
  AceStepSessionMeta,
  AceStepStatus,
  AceStepSynthLoadRequest,
  AsrAlignerProgress,
  AsrAlignerStatus,
  PackageSongRequest,
  PackageSongResult,
  SongEntry,
  SongMeta,
  SongMetaUpdates,
  SongScore,
  UnpackedSong,
} from '../types';

export class AceStepService {
  /** Query the current pipeline status. */
  async getStatus(): Promise<AceStepStatus> {
    try {
      return await api.invoke<AceStepStatus>('acestep_get_status');
    } catch (error) {
      throw createTauriCommandError('acestep_get_status', error);
    }
  }

  /** List local ACE-Step model files and their on-disk presence. */
  async listLocalModels(): Promise<AceStepLocalModel[]> {
    try {
      return await api.invoke<AceStepLocalModel[]>('acestep_list_local_models');
    } catch (error) {
      throw createTauriCommandError('acestep_list_local_models', error);
    }
  }

  /** Load the synth pipeline (DiT + text encoder + VAE). */
  async loadSynth(request: AceStepSynthLoadRequest): Promise<void> {
    try {
      await api.invoke<void>('acestep_load_synth', { request });
    } catch (error) {
      throw createTauriCommandError('acestep_load_synth', error, request);
    }
  }

  /** Load the LM (Qwen3) pipeline. */
  async loadLm(request: AceStepLmLoadRequest): Promise<void> {
    try {
      await api.invoke<void>('acestep_load_lm', { request });
    } catch (error) {
      throw createTauriCommandError('acestep_load_lm', error, request);
    }
  }

  /** Unload all models and free VRAM. */
  async unload(): Promise<void> {
    try {
      await api.invoke<void>('acestep_unload');
    } catch (error) {
      throw createTauriCommandError('acestep_unload', error);
    }
  }

  /** Generate audio. Returns the output wav file path and metadata. */
  async generate(request: AceStepGenerateRequest): Promise<AceStepGenerateResult> {
    try {
      return await api.invoke<AceStepGenerateResult>('acestep_generate', { request });
    } catch (error) {
      throw createTauriCommandError('acestep_generate', error, request);
    }
  }

  /** Cancel the running generation. Returns true if a token was found. */
  async cancel(): Promise<boolean> {
    try {
      return await api.invoke<boolean>('acestep_cancel');
    } catch (error) {
      throw createTauriCommandError('acestep_cancel', error);
    }
  }

  /**
   * Ensure the auth token is fresh before making AI requests.
   * The JWT access token (15-min expiry) may have expired during the
   * long-lived ACE-Step session. tokenManager.getAccessToken() checks
   * expiry and auto-refreshes via the refresh token, updating
   * AI00S_AUTH_TOKEN on the backend.
   */
  private async ensureFreshToken(): Promise<void> {
    try {
      const token = await tokenManager.getAccessToken();
      if (!token) {
        console.warn('[AceStepService] No valid auth token — AI request may fail with 401');
      }
    } catch (e) {
      console.warn('[AceStepService] Token refresh check failed:', e);
    }
  }

  /** LLM text completion for lyrics/caption writing (uses Ai00-X's chat LLM). */
  async llmComplete(request: AceStepLlmCompleteRequest): Promise<AceStepLlmCompleteResponse> {
    await this.ensureFreshToken();
    try {
      return await api.invoke<AceStepLlmCompleteResponse>('acestep_llm_complete', { request });
    } catch (error) {
      throw createTauriCommandError('acestep_llm_complete', error, request);
    }
  }

  /**
   * Multi-turn streaming LLM chat for the conversational creation flow.
   *
   * The command emits `acestep_llm_chunk` events as the model streams, then a
   * final `acestep_llm_done` event. The caller subscribes to these events
   * (via Tauri `listen`) before invoking this method. Resolves with the full
   * text when done.
   */
  async llmChatStream(request: AceStepLlmChatRequest): Promise<AceStepLlmCompleteResponse> {
    await this.ensureFreshToken();
    try {
      return await api.invoke<AceStepLlmCompleteResponse>('acestep_llm_chat_stream', { request });
    } catch (error) {
      throw createTauriCommandError('acestep_llm_chat_stream', error, request);
    }
  }

  /**
   * Web search for the lyrics advisor (AnySearch primary, SearXNG fallback).
   *
   * Used when the LLM emits `{"action":"search","query":"..."}` to gather
   * background knowledge (cultural context, genre traits, event details)
   * before drafting or revising lyrics.
   */
  async webSearch(
    query: string,
    language?: string,
    maxResults?: number,
  ): Promise<AceStepSearchResult[]> {
    try {
      return await api.invoke<AceStepSearchResult[]>('acestep_web_search', {
        query,
        language: language ?? null,
        maxResults: maxResults ?? null,
      });
    } catch (error) {
      throw createTauriCommandError('acestep_web_search', error, { query });
    }
  }

  /**
   * Generate timestamped LRC lyrics for a generated song.
   *
   * Spawns `uv run scripts/align_lyrics.py` which uses the official
   * `qwen-asr` package's Qwen3ForcedAligner to align the lyrics text to the
   * generated audio. The first run downloads the model (~1.7 GB) to the
   * HuggingFace cache; subsequent runs load from cache (~3-5 s).
   *
   * Returns the LRC text and the path where the .lrc file was saved.
   */
  async alignLyrics(
    request: AceStepAlignLyricsRequest,
  ): Promise<AceStepAlignLyricsResult> {
    try {
      return await api.invoke<AceStepAlignLyricsResult>('acestep_align_lyrics', {
        request,
      });
    } catch (error) {
      throw createTauriCommandError('acestep_align_lyrics', error, request);
    }
  }

  // ---- ForcedAligner model download (Qwen3-ForcedAligner-0.6B GGUF) ----

  /** Query the local ForcedAligner GGUF file presence + live download progress. */
  async getAlignerStatus(): Promise<AsrAlignerStatus> {
    try {
      return await api.invoke<AsrAlignerStatus>('asr_get_aligner_status');
    } catch (error) {
      throw createTauriCommandError('asr_get_aligner_status', error);
    }
  }

  /** Start downloading the ForcedAligner GGUF (~994 MB). Returns the task id. */
  async downloadAligner(): Promise<string> {
    try {
      return await api.invoke<string>('asr_download_aligner');
    } catch (error) {
      throw createTauriCommandError('asr_download_aligner', error);
    }
  }

  /** Poll the live download progress of the ForcedAligner GGUF. */
  async pollAlignerProgress(): Promise<AsrAlignerProgress | null> {
    try {
      return await api.invoke<AsrAlignerProgress | null>(
        'asr_poll_aligner_progress',
      );
    } catch (error) {
      throw createTauriCommandError('asr_poll_aligner_progress', error);
    }
  }

  /** List the ACE-Step model catalog with on-disk presence. */
  async listCatalog(): Promise<AceStepCatalogEntry[]> {
    try {
      return await api.invoke<AceStepCatalogEntry[]>('acestep_list_catalog');
    } catch (error) {
      throw createTauriCommandError('acestep_list_catalog', error);
    }
  }

  /** Start downloading a single model by catalog id. Returns the task id. */
  async downloadModel(id: string): Promise<string> {
    try {
      return await api.invoke<string>('acestep_download_model', { id });
    } catch (error) {
      throw createTauriCommandError('acestep_download_model', error, { id });
    }
  }

  /** Start downloading all recommended models. Returns the list of started task ids. */
  async downloadAllRecommended(): Promise<string[]> {
    try {
      return await api.invoke<string[]>('acestep_download_all_recommended');
    } catch (error) {
      throw createTauriCommandError('acestep_download_all_recommended', error);
    }
  }

  /** Query download progress for a task id. */
  async getDownloadProgress(taskId: string): Promise<AceStepDownloadProgress | null> {
    try {
      return await api.invoke<AceStepDownloadProgress | null>('acestep_get_download_progress', {
        taskId,
      });
    } catch (error) {
      throw createTauriCommandError('acestep_get_download_progress', error, { taskId });
    }
  }

  /** Test mirror speeds and return the ranking. */
  async testMirrors(): Promise<AceStepMirrorSpeed[]> {
    try {
      return await api.invoke<AceStepMirrorSpeed[]>('acestep_test_mirrors');
    } catch (error) {
      throw createTauriCommandError('acestep_test_mirrors', error);
    }
  }

  /** Detect NVIDIA GPU name and VRAM via nvidia-smi. */
  async getGpuInfo(): Promise<AceStepGpuInfo> {
    try {
      return await api.invoke<AceStepGpuInfo>('acestep_get_gpu_info');
    } catch (error) {
      throw createTauriCommandError('acestep_get_gpu_info', error);
    }
  }

  /** List preset bundles with current download status. */
  async getPresets(): Promise<AceStepPreset[]> {
    try {
      return await api.invoke<AceStepPreset[]>('acestep_get_presets');
    } catch (error) {
      throw createTauriCommandError('acestep_get_presets', error);
    }
  }

  /** Start downloading all model files for a preset. Returns the started task ids. */
  async downloadPreset(presetId: string): Promise<string[]> {
    try {
      return await api.invoke<string[]>('acestep_download_preset', { presetId });
    } catch (error) {
      throw createTauriCommandError('acestep_download_preset', error, { presetId });
    }
  }

  // ---- Session persistence ----

  /** List all persisted sessions (metadata only). */
  async sessionList(): Promise<AceStepSessionMeta[]> {
    try {
      return await api.invoke<AceStepSessionMeta[]>('acestep_session_list');
    } catch (error) {
      throw createTauriCommandError('acestep_session_list', error);
    }
  }

  /** Load a single session's full data by id. */
  async sessionLoad(id: string): Promise<AceStepSessionData> {
    try {
      return await api.invoke<AceStepSessionData>('acestep_session_load', { id });
    } catch (error) {
      throw createTauriCommandError('acestep_session_load', error, { id });
    }
  }

  /** Save (create or overwrite) a session. */
  async sessionSave(session: AceStepSessionData): Promise<void> {
    try {
      await api.invoke<void>('acestep_session_save', { session });
    } catch (error) {
      throw createTauriCommandError('acestep_session_save', error, { session });
    }
  }

  /** Delete a session by id. */
  async sessionDelete(id: string): Promise<void> {
    try {
      await api.invoke<void>('acestep_session_delete', { id });
    } catch (error) {
      throw createTauriCommandError('acestep_session_delete', error, { id });
    }
  }

  // ---- .a00m packaging ----

  /**
   * Return the default songs output directory (`<exe_dir>/data/songs/`),
   * creating it if missing. Used by the PackageDialog to prefill the
   * output directory input on first open.
   */
  async getSongsDir(): Promise<string> {
    try {
      return await api.invoke<string>('acestep_get_songs_dir');
    } catch (error) {
      throw createTauriCommandError('acestep_get_songs_dir', error);
    }
  }

  /**
   * Package a generated song into a `.a00m` archive.
   *
   * Reads the source WAV (32bit float), encodes to FLAC (16bit PCM lossless),
   * then bundles with lyrics (enhanced LRC), creation context, and metadata
   * into a ZIP container. The original WAV on disk is left untouched.
   *
   * Runs on a `spawn_blocking` thread — WAV read + FLAC encode + ZIP write
   * are all CPU/IO-heavy.
   */
  async packageSong(request: PackageSongRequest): Promise<PackageSongResult> {
    try {
      return await api.invoke<PackageSongResult>('acestep_package_song', {
        request,
      });
    } catch (error) {
      throw createTauriCommandError('acestep_package_song', error, request);
    }
  }

  // ---- .a00m library / player (v1.3.0) ----

  /**
   * List every `.a00m` file in the songs directory, newest-first.
   *
   * Each entry carries filesystem info (size / mtime / encryption flag); for
   * unencrypted archives the parsed `song.json` metadata is attached.
   * Encrypted archives return `meta = undefined` — the caller must prompt for
   * a password and call `readSongMetaWithPassword` to view metadata.
   */
  async listSongs(): Promise<SongEntry[]> {
    try {
      return await api.invoke<SongEntry[]>('acestep_list_songs');
    } catch (error) {
      throw createTauriCommandError('acestep_list_songs', error);
    }
  }

  /**
   * Delete a `.a00m` file from the songs directory, together with its unpack
   * cache directory. The backend refuses paths outside the songs directory.
   */
  async deleteSong(path: string): Promise<void> {
    try {
      await api.invoke<void>('acestep_delete_song', { path });
    } catch (error) {
      throw createTauriCommandError('acestep_delete_song', error, { path });
    }
  }

  /**
   * Check whether a `.a00m` archive is a v1.2.0+ encrypted container
   * (magic `A00M`). Returns `false` for standard ZIP archives.
   */
  async isArchiveEncrypted(path: string): Promise<boolean> {
    try {
      return await api.invoke<boolean>('acestep_is_archive_encrypted', { path });
    } catch (error) {
      throw createTauriCommandError('acestep_is_archive_encrypted', error, { path });
    }
  }

  /**
   * Read `manifest.json` + `song.json` from an unencrypted `.a00m` archive
   * without extracting the audio. Fast path for previewing a song library.
   *
   * For encrypted archives, the backend returns an error containing
   * "password required" — callers should detect this and switch to
   * `readSongMetaWithPassword` (or pre-check with `isArchiveEncrypted`).
   */
  async readSongMeta(path: string): Promise<SongMeta> {
    try {
      return await api.invoke<SongMeta>('acestep_read_song_meta', { path });
    } catch (error) {
      throw createTauriCommandError('acestep_read_song_meta', error, { path });
    }
  }

  /**
   * Read metadata from a possibly-encrypted `.a00m` archive. Same as
   * `readSongMeta` but accepts a password for v1.2.0+ encrypted containers.
   */
  async readSongMetaWithPassword(
    path: string,
    password: string | null,
  ): Promise<SongMeta> {
    try {
      return await api.invoke<SongMeta>('acestep_read_song_meta_with_password', {
        path,
        password: password ?? null,
      });
    } catch (error) {
      throw createTauriCommandError(
        'acestep_read_song_meta_with_password',
        error,
        { path },
      );
    }
  }

  /**
   * Unpack a `.a00m` archive to a directory and return parsed contents.
   *
   * If `outputDir` is null, defaults to `<archive_stem>/` next to the archive.
   * The Rust backend auto-detects encrypted containers and tries the fixed
   * version passwords from `passwords.rs` — no password is required from the
   * caller.
   */
  async unpackSong(
    path: string,
    outputDir: string | null,
  ): Promise<UnpackedSong> {
    try {
      return await api.invoke<UnpackedSong>('acestep_unpack_song', {
        path,
        outputDir: outputDir ?? null,
        password: null,
      });
    } catch (error) {
      throw createTauriCommandError('acestep_unpack_song', error, { path });
    }
  }

  /**
   * Extract just the cover image from a `.a00m` archive into `outputDir`,
   * returning the absolute path to the written cover file (or null when the
   * archive has no cover).
   *
   * Fast path for library thumbnails: skips the (much larger) FLAC audio.
   * When `password` is omitted, the Rust backend auto-detects encryption and
   * tries the fixed version passwords internally. For v1.2.0+ containers
   * encrypted with a user password, pass it explicitly.
   */
  async extractCover(
    path: string,
    outputDir: string,
    password?: string | null,
  ): Promise<string | null> {
    try {
      return await api.invoke<string | null>('acestep_extract_cover', {
        path,
        outputDir,
        password: password ?? null,
      });
    } catch (error) {
      throw createTauriCommandError('acestep_extract_cover', error, { path });
    }
  }

  /** Score a generated song's audio quality via pure-Rust signal analysis. */
  async scoreSong(audioPath: string): Promise<SongScore> {
    try {
      return await api.invoke<SongScore>('acestep_score_song', { audioPath });
    } catch (error) {
      throw createTauriCommandError('acestep_score_song', error, { audioPath });
    }
  }

  /**
   * Edit the metadata of an existing `.a00m` archive in place.
   *
   * Only `song.json`, `manifest.json` (cover field), and the cover image are
   * rewritten — audio FLAC and creation context bytes are copied verbatim, so
   * there is no lossy re-encoding. Encrypted archives are re-encrypted with
   * the same password. The original file is atomically replaced.
   *
   * @param path Absolute path to the `.a00m` file.
   * @param password User password (required for encrypted archives; ignored
   *   for standard ZIP archives). Pass null for unencrypted archives.
   * @param updates Fields to update. Omitted/undefined fields are left
   *   unchanged. `coverPath` replaces the cover image when provided.
   */
  async updateSongMeta(
    path: string,
    password: string | null,
    updates: SongMetaUpdates,
  ): Promise<void> {
    try {
      await api.invoke<void>('acestep_update_song_meta', {
        path,
        password: password ?? null,
        updates,
      });
    } catch (error) {
      throw createTauriCommandError('acestep_update_song_meta', error, { path });
    }
  }
}

/** Singleton AceStep service instance. */
export const aceStepService = new AceStepService();
