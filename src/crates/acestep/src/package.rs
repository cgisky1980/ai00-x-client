//! `.a00m` (Ai00 Music) packaging format.
//!
//! Bundles a generated music work with its full creation context into a single
//! ZIP container for the future Ai00-X music player:
//!
//! ```text
//! song.a00m (ZIP)
//! ├── manifest.json              # Format version, file index, timestamps
//! ├── song.json                  # Song metadata (title, artist, user, duration)
//! ├── audio.flac                 # FLAC lossless audio (16bit/48kHz stereo)
//! ├── lyrics.lrc                 # Enhanced LRC (word-by-word sync)
//! ├── creation/
//! │   ├── request.json           # Full AceRequest (generation parameters)
//! │   ├── plan.json              # CreationPlan (LLM creative plan, optional)
//! │   └── lego_state.json        # LegoFlowState (multi-step flow, optional)
//! └── chat.json                  # ChatMessage[] (creation history, optional)
//! ```
//!
//! Audio is encoded from the source WAV (32bit float) to FLAC (16bit PCM,
//! lossless) using the pure-Rust `flacenc` crate. The original WAV file on
//! disk is left untouched.

use std::fs::File;
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

// ----------------------------------------------------------------------------
// Format constants
// ----------------------------------------------------------------------------

const FORMAT_NAME: &str = "a00m";
const FORMAT_VERSION: &str = "1.2.0";
const PRODUCER: &str = "Ai00-X";
const FLAC_BITS_PER_SAMPLE: u32 = 16;
const SONG_JSON: &str = "song.json";
const MANIFEST_JSON: &str = "manifest.json";
const AUDIO_FLAC: &str = "audio.flac";
const LYRICS_LRC: &str = "lyrics.lrc";
const CREATION_REQUEST_JSON: &str = "creation/request.json";
const CREATION_PLAN_JSON: &str = "creation/plan.json";
const CREATION_LEGO_STATE_JSON: &str = "creation/lego_state.json";
const CHAT_JSON: &str = "chat.json";

// ----------------------------------------------------------------------------
// Error
// ----------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum PackageError {
    #[error("audio file not found: {0}")]
    AudioNotFound(PathBuf),
    #[error("invalid .a00m archive: format field is '{found}', expected '{expected}'")]
    InvalidFormat { found: String, expected: String },
    #[error("manifest.json missing in archive")]
    ManifestMissing,
    #[error("song.json missing in archive")]
    SongMissing,
    #[error("FLAC encoding failed: {0}")]
    FlacEncode(String),
    #[error("WAV read failed: {0}")]
    WavRead(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("ZIP error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// v1.2.0+: caller attempted to read an encrypted container without
    /// providing a password.
    #[error("password required to decrypt this archive")]
    PasswordRequired,
    /// v1.2.0+: AES-256-GCM decryption failed — wrong password or tampered
    /// ciphertext (GCM tag mismatch).
    #[error("decryption failed (wrong password or corrupted archive): {0}")]
    DecryptionFailed(String),
    /// v1.2.0+: container header is malformed (bad magic, unsupported
    /// algorithm byte, truncated, etc.).
    #[error("invalid container header: {0}")]
    InvalidContainer(String),
    #[error("other: {0}")]
    Other(#[from] anyhow::Error),
}

/// Convert an error from `package_container::decrypt_container` into a
/// `package.rs` error, preserving the `DecryptionFailed` variant so callers
/// (Tauri command layer) can downcast and distinguish "wrong password" from
/// other failures.
///
/// The `matches!` expression produces a temporary borrow of `e` that ends
/// immediately after evaluation (NLL), so `e` can be moved in either branch.
fn preserve_decrypt_error(e: anyhow::Error) -> anyhow::Error {
    if matches!(
        e.downcast_ref::<PackageError>(),
        Some(PackageError::DecryptionFailed(_))
    ) {
        // Already a PackageError::DecryptionFailed — pass through so the
        // Tauri command can downcast and return a specific error to the UI.
        e
    } else {
        // Wrap everything else (io::Error, argon2::Error, InvalidContainer,
        // etc.) in PackageError::Other for uniform handling.
        anyhow::Error::from(PackageError::Other(e))
    }
}

// ----------------------------------------------------------------------------
// Manifest & metadata types
// ----------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct PackageManifest {
    pub format: String,
    pub version: String,
    pub created_at: i64,
    pub created_at_iso: String,
    pub producer: String,
    pub files: PackageFiles,
    /// Internal trace info (machineId/deviceName/userId/...). Auto-filled,
    /// not user-editable. Distinct from song.json's author fields.
    /// Absent in v1.0.0 archives — `#[serde(default)]` keeps backward compat.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub internal: Option<InternalTrace>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct PackageFiles {
    pub song: String,
    pub audio: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_request: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_lego_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat: Option<String>,
    /// Cover image path inside the archive (e.g. "cover.jpg"). v1.1.0+.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cover: Option<String>,
}

/// Internal trace info embedded in manifest.json. Auto-filled, not user-editable.
/// Used for copyright tracking and abuse prevention. Distinct from song.json's
/// author fields (artist/album/genre/cover) which are user-facing metadata.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct InternalTrace {
    pub machine_id: String,
    pub device_name: String,
    pub user_id: String,
    pub user_name: String,
    pub app_version: String,
    pub session_id: String,
    pub packaged_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SongMeta {
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub genre: String,
    pub duration_seconds: f32,
    pub created_at: i64,
    pub format_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<SongUser>,
    pub audio: AudioMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<LyricsMeta>,
    /// Cover image metadata. v1.1.0+. Absent when no cover was provided.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cover: Option<CoverMeta>,
    pub creation: CreationSummary,
    /// Quality score from audio analysis. Absent when not yet scored.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub score: Option<crate::scoring::SongScore>,
    /// Auto-generated classification tags (multilingual: `zh:标签` / `en:tag`).
    /// v1.3.0+. Absent when not yet generated.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tags: Option<Vec<String>>,
    /// Vector embedding of tags + metadata (256-dim, model2vec).
    /// v1.3.0+. Absent when embedding service unavailable.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub embedding: Option<Vec<f32>>,
    /// Tags generation timestamp (Unix ms). v1.3.0+.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tags_generated_at: Option<i64>,
}

/// Cover image metadata embedded in song.json. v1.1.0+.
#[derive(Serialize, Deserialize, Clone)]
pub struct CoverMeta {
    /// Filename inside the archive (e.g. "cover.jpg").
    pub filename: String,
    /// MIME type: "image/jpeg" | "image/png" | "image/webp".
    pub format: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SongUser {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AudioMeta {
    pub filename: String,
    pub format: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub bits_per_sample: u32,
    pub duration_seconds: f32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LyricsMeta {
    pub filename: String,
    pub format: String,
    pub language: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct CreationSummary {
    pub mode: String,
    pub has_plan: bool,
    pub has_lego_state: bool,
    pub has_chat: bool,
}

// ----------------------------------------------------------------------------
// Request / response types
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSongRequest {
    /// Output .a00m file path. If None, derived from output_dir or audio dir.
    #[serde(default)]
    pub output_path: Option<String>,
    /// Output directory when output_path is None. Defaults to audio dir.
    #[serde(default)]
    pub output_dir: Option<String>,
    /// Source WAV file (from `acestep_generate` output).
    pub audio_path: String,
    /// LRC content (written directly; takes precedence over lyrics_path).
    #[serde(default)]
    pub lyrics: Option<String>,
    /// LRC file path (read when `lyrics` is None).
    #[serde(default)]
    pub lyrics_path: Option<String>,
    /// Local cover image path (jpg/png/webp). Read and embedded as cover.{ext}.
    /// v1.1.0+. None = no cover in the archive.
    #[serde(default)]
    pub cover_path: Option<String>,
    /// Internal trace info (machineId/deviceName/userId/...). Auto-filled by
    /// the frontend by invoking get_machine_id / get_device_name / get_auth_info.
    /// v1.1.0+. None = no internal trace in manifest.
    #[serde(default)]
    pub internal: Option<InternalTraceInput>,
    pub song: SongMetaInput,
    #[serde(default)]
    pub creation_request: Option<serde_json::Value>,
    #[serde(default)]
    pub creation_plan: Option<serde_json::Value>,
    #[serde(default)]
    pub lego_state: Option<serde_json::Value>,
    #[serde(default)]
    pub chat_messages: Option<serde_json::Value>,
    /// User password for v1.2.0+ encryption. None = plaintext standard ZIP
    /// (v1.0.0/v1.1.0 compat, magic `PK`). When provided, the archive uses
    /// the custom `A00M` container format with AES-256-GCM + Argon2id.
    #[serde(default)]
    pub password: Option<String>,
    /// Pre-computed vector embedding (256-dim f32). v1.3.0+.
    /// Generated by the caller (desktop app) using EmbeddingService.
    /// None = embedding field omitted from song.json.
    #[serde(default)]
    pub embedding: Option<Vec<f32>>,
}

/// Frontend-supplied internal trace fields. The backend fills `app_version`
/// and `packaged_at` itself (not user-controllable).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalTraceInput {
    pub machine_id: String,
    pub device_name: String,
    pub user_id: String,
    pub user_name: String,
    pub session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongMetaInput {
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub user: Option<SongUser>,
    #[serde(default)]
    pub lyrics_language: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    /// Quality score from audio analysis. Absent when not yet scored.
    #[serde(default)]
    pub score: Option<crate::scoring::SongScore>,
    /// Pre-generated tags (skip auto-generation if provided). v1.3.0+.
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSongResult {
    pub output_path: String,
    pub file_size_bytes: u64,
    pub manifest: PackageManifest,
    pub song: SongMeta,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpackedSong {
    pub output_dir: String,
    pub manifest: PackageManifest,
    pub song: SongMeta,
    pub audio_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lyrics_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_request: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_plan: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lego_state: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_messages: Option<serde_json::Value>,
}

/// A discoverable `.a00m` file entry on disk.
///
/// Returned by [`list_songs`] for each `.a00m` file found in the songs
/// directory. Encrypted containers (v1.2.0+, magic `A00M`) carry `meta = None`
/// — callers must prompt for a password and use
/// [`read_song_meta_with_password`] to access the metadata.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SongEntry {
    /// Absolute path to the `.a00m` file.
    pub path: String,
    /// Filename (e.g. `song_1737000000000.a00m`).
    pub filename: String,
    /// File size in bytes.
    pub file_size: u64,
    /// Last-modified time as Unix milliseconds.
    pub modified_at: i64,
    /// `true` when the file is a v1.2.0+ encrypted container (magic `A00M`).
    pub is_encrypted: bool,
    /// Parsed `song.json` metadata. Only present for unencrypted archives
    /// (read during scanning). `None` for encrypted archives.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<SongMeta>,
}

// ----------------------------------------------------------------------------
// FLAC encoding helper
// ----------------------------------------------------------------------------

/// Encode a WAV (any bit depth / sample format) file to FLAC 16bit PCM bytes.
///
/// Returns `(flac_bytes, sample_rate, channels, duration_seconds)`.
///
/// Conversion path:
///   WAV (hound) → interleaved f32 → clamp + quantize to i16 →
///   interleaved i32 → flacenc::source::MemSource → FLAC stream → bytes
fn encode_wav_to_flac(wav_path: &Path) -> Result<(Vec<u8>, u32, u32, f32)> {
    use flacenc::bitsink::ByteSink;
    use flacenc::component::BitRepr;
    use flacenc::config::Encoder;
    use flacenc::error::Verify;
    use flacenc::source::MemSource;
    use hound::WavReader;

    let mut reader = WavReader::open(wav_path).map_err(|e| PackageError::WavRead(e.to_string()))?;
    let spec = reader.spec();
    let channels = spec.channels;
    let sample_rate = spec.sample_rate;

    // Read all samples as interleaved f32 (regardless of source bit depth).
    let samples_f32: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| PackageError::WavRead(e.to_string()))?,
        hound::SampleFormat::Int => {
            let max_amp = (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| PackageError::WavRead(e.to_string()))?
                .into_iter()
                .map(|v| v as f32 / max_amp)
                .collect()
        }
    };

    if samples_f32.is_empty() {
        return Err(PackageError::WavRead("WAV contains zero samples".into()).into());
    }
    if !samples_f32.len().is_multiple_of(channels as usize) {
        return Err(PackageError::WavRead(format!(
            "sample count {} is not a multiple of channel count {}",
            samples_f32.len(),
            channels
        ))
        .into());
    }

    let n_frames = samples_f32.len() / channels as usize;
    let duration_seconds = n_frames as f32 / sample_rate as f32;

    // Quantize f32 [-1.0, 1.0] → i16 [-32768, 32767], keep as i32 for flacenc.
    let samples_i32: Vec<i32> = samples_f32
        .iter()
        .map(|&s| {
            let clamped = s.clamp(-1.0, 1.0);
            // Standard PCM conversion: multiply by 32767 and round.
            // Negative full-scale -1.0 maps to -32767 (not -32768) to keep symmetry,
            // matching the convention used by most audio tools.
            (clamped * 32767.0).round() as i32
        })
        .collect();

    // Build flacenc source. MemSource takes interleaved i32 samples.
    let source = MemSource::from_samples(
        &samples_i32,
        channels as usize,
        FLAC_BITS_PER_SAMPLE as usize,
        sample_rate as usize,
    );

    // Configure encoder (default = max compression, multi-threaded via `par`).
    let config = Encoder::default()
        .into_verified()
        .map_err(|e| PackageError::FlacEncode(format!("config verification failed: {e:?}")))?;
    let block_size = config.block_size;

    let flac_stream = flacenc::encode_with_fixed_block_size(&config, source, block_size)
        .map_err(|e| PackageError::FlacEncode(format!("encode failed: {e:?}")))?;

    let mut sink = ByteSink::new();
    flac_stream
        .write(&mut sink)
        .map_err(|e| PackageError::FlacEncode(format!("bit write failed: {e:?}")))?;

    Ok((
        sink.as_slice().to_vec(),
        sample_rate,
        channels as u32,
        duration_seconds,
    ))
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/// Generate multilingual classification tags from creation context.
///
/// Extracts descriptive features (caption, lyrics, bpm, key, genre, duration,
/// vocal language) from the AceRequest JSON and produces bilingual tags
/// (format: `zh:标签` / `en:tag`).
///
/// This is a pure rule-based function — no LLM or external service required.
/// The caller (desktop app) can optionally enhance tags with LLM caption
/// before calling `package_song`.
pub fn generate_song_tags(
    creation_request: Option<&serde_json::Value>,
    _title: &str,
    _artist: &str,
    genre: &str,
    duration_seconds: f32,
) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut add = |zh: &str, en: &str| {
        let zh_tag = format!("zh:{}", zh);
        let en_tag = format!("en:{}", en);
        if seen.insert(zh_tag.clone()) {
            tags.push(zh_tag);
        }
        if seen.insert(en_tag.clone()) {
            tags.push(en_tag);
        }
    };

    // Extract fields from creation_request
    if let Some(req) = creation_request {
        // BPM → tempo tags
        let bpm = req.get("bpm").and_then(|v| v.as_i64()).unwrap_or(0);
        if bpm > 0 {
            match bpm {
                0..=70 => add("慢节奏", "slow"),
                71..=100 => add("中速", "mid-tempo"),
                101..=140 => add("快节奏", "fast"),
                _ => add("极速", "very-fast"),
            }
        }

        // Key → mode tags
        let key = req
            .get("keyScale")
            .or_else(|| req.get("keyscale"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !key.is_empty() {
            let key_lower = key.to_lowercase();
            if key_lower.contains("minor") || key_lower.contains("小调") {
                add("小调", "minor-key");
            } else if key_lower.contains("major") || key_lower.contains("大调") {
                add("大调", "major-key");
            }
        }

        // Vocal language tags
        let vocal_lang = req
            .get("vocalLanguage")
            .or_else(|| req.get("vocal_language"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        match vocal_lang.to_lowercase().as_str() {
            "zh" | "chinese" | "中文" => add("中文人声", "chinese-vocal"),
            "en" | "english" | "英文" => add("英文人声", "english-vocal"),
            "ja" | "japanese" | "日文" => add("日文人声", "japanese-vocal"),
            "ko" | "korean" | "韩文" => add("韩文人声", "korean-vocal"),
            _ => {}
        }

        // Lyrics → keyword tags (simple heuristic)
        let lyrics = req.get("lyrics").and_then(|v| v.as_str()).unwrap_or("");
        if lyrics.is_empty() || lyrics.contains("[Instrumental]") {
            add("纯音乐", "instrumental");
        } else {
            // Detect mood from lyrics keywords (basic)
            let lyrics_lower = lyrics.to_lowercase();
            if lyrics_lower.contains("love") || lyrics.contains("爱") || lyrics.contains("恋") {
                add("爱情", "love");
            }
            if lyrics_lower.contains("sad")
                || lyrics_lower.contains("cry")
                || lyrics.contains("悲伤")
                || lyrics.contains("泪")
            {
                add("忧伤", "sad");
            }
            if lyrics_lower.contains("happy") || lyrics.contains("快乐") || lyrics.contains("欢")
            {
                add("快乐", "happy");
            }
            if lyrics_lower.contains("night") || lyrics.contains("夜") || lyrics.contains("晚") {
                add("夜晚", "night");
            }
        }

        // Caption → style tags
        let caption = req.get("caption").and_then(|v| v.as_str()).unwrap_or("");
        if !caption.is_empty() {
            let caption_lower = caption.to_lowercase();
            if caption_lower.contains("electronic")
                || caption_lower.contains("edm")
                || caption.contains("电子")
            {
                add("电子", "electronic");
            }
            if caption_lower.contains("rock") || caption.contains("摇滚") {
                add("摇滚", "rock");
            }
            if caption_lower.contains("jazz") || caption.contains("爵士") {
                add("爵士", "jazz");
            }
            if caption_lower.contains("classical") || caption.contains("古典") {
                add("古典", "classical");
            }
            if caption_lower.contains("pop") || caption.contains("流行") {
                add("流行", "pop");
            }
            if caption_lower.contains("folk") || caption.contains("民谣") {
                add("民谣", "folk");
            }
            if caption_lower.contains("ambient") || caption.contains("氛围") {
                add("氛围", "ambient");
            }
            if caption_lower.contains("dance") || caption.contains("舞曲") {
                add("舞曲", "dance");
            }
        }
    }

    // Duration tags
    if duration_seconds > 0.0 {
        match duration_seconds as i32 {
            0..=120 => add("短曲", "short"),
            121..=300 => add("标准", "standard"),
            _ => add("长曲", "long"),
        }
    }

    // Genre tags (if provided)
    if !genre.is_empty() {
        let genre_lower = genre.to_lowercase();
        // Map common genres to bilingual tags
        match genre_lower.as_str() {
            "pop" | "流行" => add("流行", "pop"),
            "rock" | "摇滚" => add("摇滚", "rock"),
            "electronic" | "edm" | "电子" => add("电子", "electronic"),
            "jazz" | "爵士" => add("爵士", "jazz"),
            "classical" | "古典" => add("古典", "classical"),
            "folk" | "民谣" => add("民谣", "folk"),
            "hip-hop" | "hiphop" | "嘻哈" => add("嘻哈", "hip-hop"),
            "r&b" | "rnb" => add("R&B", "rnb"),
            "ambient" | "氛围" => add("氛围", "ambient"),
            "dance" | "舞曲" => add("舞曲", "dance"),
            _ => {
                // Unknown genre: use as-is for both languages
                add(genre, genre);
            }
        }
    }

    // Limit to 30 tags (15 zh + 15 en)
    tags.truncate(30);
    tags
}

/// Package a song into a `.a00m` archive.
///
/// Reads the source WAV, encodes to FLAC (16bit PCM lossless), then bundles
/// with lyrics, creation context, and metadata into a ZIP container.
pub fn package_song(req: PackageSongRequest) -> Result<PackageSongResult> {
    let audio_path = PathBuf::from(&req.audio_path);
    if !audio_path.exists() {
        return Err(PackageError::AudioNotFound(audio_path).into());
    }

    // 1. Encode WAV → FLAC bytes.
    let (flac_bytes, sample_rate, channels, duration_seconds) = encode_wav_to_flac(&audio_path)?;

    // 2. Resolve lyrics content.
    let lyrics_content: Option<String> = if let Some(lrc) = req.lyrics.as_ref() {
        Some(lrc.clone())
    } else if let Some(lrc_path) = req.lyrics_path.as_ref() {
        let path = PathBuf::from(lrc_path);
        if !path.exists() {
            bail!("lyrics_path not found: {}", path.display());
        }
        Some(
            std::fs::read_to_string(&path)
                .with_context(|| format!("read lyrics file: {}", path.display()))?,
        )
    } else {
        None
    };

    // 2.5. Resolve cover image (if provided). v1.1.0+.
    // Read the file bytes and parse dimensions from the image header
    // (without decoding pixel data) using the `imagesize` crate.
    let cover_meta: Option<(CoverMeta, Vec<u8>)> = if let Some(cp) = req.cover_path.as_ref() {
        let cover_path = PathBuf::from(cp);
        if !cover_path.exists() {
            bail!("cover_path not found: {}", cover_path.display());
        }
        let bytes = std::fs::read(&cover_path)
            .with_context(|| format!("read cover file: {}", cover_path.display()))?;
        let dims = imagesize::blob_size(&bytes)
            .map_err(|e| PackageError::Other(anyhow::anyhow!("read cover dimensions: {e}")))?;
        let ext = cover_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_else(|| "jpg".into());
        let mime = match ext.as_str() {
            "png" => "image/png",
            "webp" => "image/webp",
            _ => "image/jpeg",
        };
        let filename = format!("cover.{ext}");
        Some((
            CoverMeta {
                filename,
                format: mime.to_string(),
                width: dims.width as u32,
                height: dims.height as u32,
            },
            bytes,
        ))
    } else {
        None
    };

    // 3. Determine output path.
    let now = chrono::Utc::now();
    let timestamp_ms = now.timestamp_millis();
    let output_path: PathBuf = if let Some(op) = req.output_path.as_ref() {
        PathBuf::from(op)
    } else {
        let stem = format!("song_{}", timestamp_ms);
        let base_dir = req
            .output_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| audio_path.parent().unwrap_or(Path::new(".")).to_path_buf());
        base_dir.join(format!("{stem}.a00m"))
    };

    // 4. Build metadata.
    let song = SongMeta {
        title: req.song.title.clone(),
        artist: req.song.artist.clone().unwrap_or_default(),
        album: req.song.album.clone().unwrap_or_default(),
        genre: req.song.genre.clone().unwrap_or_default(),
        duration_seconds,
        created_at: timestamp_ms,
        format_version: FORMAT_VERSION.to_string(),
        user: req.song.user.clone(),
        audio: AudioMeta {
            filename: AUDIO_FLAC.to_string(),
            format: "flac".to_string(),
            sample_rate,
            channels,
            bits_per_sample: FLAC_BITS_PER_SAMPLE,
            duration_seconds,
        },
        lyrics: lyrics_content.as_ref().map(|_| LyricsMeta {
            filename: LYRICS_LRC.to_string(),
            format: "enhanced-lrc".to_string(),
            language: req
                .song
                .lyrics_language
                .clone()
                .unwrap_or_else(|| "zh".to_string()),
        }),
        cover: cover_meta.as_ref().map(|(m, _)| m.clone()),
        creation: CreationSummary {
            mode: req
                .song
                .mode
                .clone()
                .unwrap_or_else(|| "text2music".to_string()),
            has_plan: req.creation_plan.is_some(),
            has_lego_state: req.lego_state.is_some(),
            has_chat: req.chat_messages.is_some(),
        },
        score: req.song.score.clone(),
        // v1.3.0+: auto-generate tags if not provided
        tags: {
            if let Some(t) = req.song.tags.as_ref() {
                Some(t.clone())
            } else {
                let generated = generate_song_tags(
                    req.creation_request.as_ref(),
                    &req.song.title,
                    req.song.artist.as_deref().unwrap_or(""),
                    req.song.genre.as_deref().unwrap_or(""),
                    duration_seconds,
                );
                if generated.is_empty() {
                    None
                } else {
                    Some(generated)
                }
            }
        },
        embedding: req.embedding.clone(),
        tags_generated_at: Some(timestamp_ms),
    };

    // Internal trace info: backend fills app_version + packaged_at; the rest
    // comes from the frontend (machine_id / device_name / user_id / user_name
    // / session_id).
    let internal = req.internal.as_ref().map(|i| InternalTrace {
        machine_id: i.machine_id.clone(),
        device_name: i.device_name.clone(),
        user_id: i.user_id.clone(),
        user_name: i.user_name.clone(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        session_id: i.session_id.clone(),
        packaged_at: timestamp_ms,
    });

    let manifest = PackageManifest {
        format: FORMAT_NAME.to_string(),
        version: FORMAT_VERSION.to_string(),
        created_at: timestamp_ms,
        created_at_iso: now.to_rfc3339(),
        producer: PRODUCER.to_string(),
        files: PackageFiles {
            song: SONG_JSON.to_string(),
            audio: AUDIO_FLAC.to_string(),
            lyrics: lyrics_content.as_ref().map(|_| LYRICS_LRC.to_string()),
            creation_request: req
                .creation_request
                .as_ref()
                .map(|_| CREATION_REQUEST_JSON.to_string()),
            creation_plan: req
                .creation_plan
                .as_ref()
                .map(|_| CREATION_PLAN_JSON.to_string()),
            creation_lego_state: req
                .lego_state
                .as_ref()
                .map(|_| CREATION_LEGO_STATE_JSON.to_string()),
            chat: req.chat_messages.as_ref().map(|_| CHAT_JSON.to_string()),
            cover: cover_meta.as_ref().map(|(m, _)| m.filename.clone()),
        },
        internal,
    };

    // 5. Write ZIP archive to an in-memory buffer.
    //
    // v1.2.0+: The ZIP is built in memory first, then either written verbatim
    // to disk (no password → standard ZIP with magic `PK`) or wrapped in the
    // custom `A00M` encrypted container (password provided → AES-256-GCM).
    let mut zip_buf: Vec<u8> = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut zip_buf);
        let mut zip = ZipWriter::new(cursor);

        let deflate_opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        let stored_opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o644);

        // manifest.json
        zip.start_file(MANIFEST_JSON, deflate_opts)?;
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
        zip.write_all(&manifest_bytes)?;

        // song.json
        zip.start_file(SONG_JSON, deflate_opts)?;
        let song_bytes = serde_json::to_vec_pretty(&song)?;
        zip.write_all(&song_bytes)?;

        // audio.flac (Stored — FLAC is already compressed)
        zip.start_file(AUDIO_FLAC, stored_opts)?;
        zip.write_all(&flac_bytes)?;

        // lyrics.lrc
        if let Some(lrc) = lyrics_content.as_ref() {
            zip.start_file(LYRICS_LRC, deflate_opts)?;
            zip.write_all(lrc.as_bytes())?;
        }

        // cover.{ext} (Stored — JPEG/PNG/WebP are already compressed)
        if let Some((meta, bytes)) = cover_meta.as_ref() {
            zip.start_file(meta.filename.as_str(), stored_opts)?;
            zip.write_all(bytes)?;
        }

        // creation/*.json
        if let Some(req_json) = req.creation_request.as_ref() {
            zip.start_file(CREATION_REQUEST_JSON, deflate_opts)?;
            let bytes = serde_json::to_vec_pretty(req_json)?;
            zip.write_all(&bytes)?;
        }
        if let Some(plan_json) = req.creation_plan.as_ref() {
            zip.start_file(CREATION_PLAN_JSON, deflate_opts)?;
            let bytes = serde_json::to_vec_pretty(plan_json)?;
            zip.write_all(&bytes)?;
        }
        if let Some(lego_json) = req.lego_state.as_ref() {
            zip.start_file(CREATION_LEGO_STATE_JSON, deflate_opts)?;
            let bytes = serde_json::to_vec_pretty(lego_json)?;
            zip.write_all(&bytes)?;
        }
        if let Some(chat_json) = req.chat_messages.as_ref() {
            zip.start_file(CHAT_JSON, deflate_opts)?;
            let bytes = serde_json::to_vec_pretty(chat_json)?;
            zip.write_all(&bytes)?;
        }

        zip.finish()?;
    } // drop `zip` cursor borrow so `zip_buf` is usable

    // 6. Write the final archive to disk.
    //
    // Always encrypt with the current version's fixed password from
    // `passwords.rs`. The frontend no longer collects a user password —
    // encryption is automatic and version-based.
    let password = std::str::from_utf8(crate::passwords::current_password())
        .expect("password table entries must be valid UTF-8");
    crate::package_container::write_encrypted_container(&output_path, &zip_buf, password)
        .map_err(PackageError::Other)?;

    let file_size_bytes = std::fs::metadata(&output_path)?.len();
    let output_path_str = output_path.to_string_lossy().to_string();

    log::info!(
        "Packaged .a00m: {} ({} bytes, FLAC {}ch {}Hz {:.1}s)",
        output_path_str,
        file_size_bytes,
        channels,
        sample_rate,
        duration_seconds
    );

    Ok(PackageSongResult {
        output_path: output_path_str,
        file_size_bytes,
        manifest,
        song,
    })
}

/// Unpack a `.a00m` archive to a directory and return parsed contents.
///
/// If `output_dir` is None, defaults to `<archive_stem>/` next to the archive.
///
/// `password` is required when the archive is a v1.2.0+ encrypted container
/// (magic `A00M`). For standard ZIP archives (magic `PK\x03\x04`, i.e. v1.0.0 /
/// v1.1.0 / v1.2.0 packaged without a password), `password` is ignored.
pub fn unpack_song(
    archive_path: &Path,
    output_dir: Option<&Path>,
    password: Option<&str>,
) -> Result<UnpackedSong> {
    // 1. Detect archive type by magic.
    if crate::package_container::is_encrypted_container(archive_path) {
        // v1.2.0+ encrypted container.
        // If an explicit password is provided, use it (backward compat).
        // Otherwise, auto-detect by trying all fixed version passwords from
        // the embedded password table (passwords.rs).
        if let Some(pw) = password.filter(|p| !p.is_empty()) {
            let zip_bytes = crate::package_container::decrypt_container(archive_path, pw)
                .map_err(preserve_decrypt_error)?;
            let cursor = Cursor::new(zip_bytes);
            let zip = ZipArchive::new(cursor)?;
            unpack_zip_impl(zip, archive_path, output_dir)
        } else {
            // Auto-detect: try each version password until one works.
            for (_, pwd_bytes) in crate::passwords::PASSWORDS {
                let pw_str = std::str::from_utf8(pwd_bytes).unwrap_or("");
                if let Ok(zip_bytes) =
                    crate::package_container::decrypt_container(archive_path, pw_str)
                {
                    let cursor = Cursor::new(zip_bytes);
                    let zip = ZipArchive::new(cursor)?;
                    return unpack_zip_impl(zip, archive_path, output_dir);
                }
            }
            Err(PackageError::DecryptionFailed(
                "no matching version password in embedded table".into(),
            )
            .into())
        }
    } else {
        // Standard ZIP (v1.0.0/v1.1.0, or v1.2.0 packaged without password).
        let file = File::open(archive_path)
            .with_context(|| format!("open archive: {}", archive_path.display()))?;
        let zip = ZipArchive::new(file)?;
        unpack_zip_impl(zip, archive_path, output_dir)
    }
}

/// Shared unpacking logic operating on an already-opened `ZipArchive`. Works
/// with both `File` (standard ZIP) and `Cursor<Vec<u8>>` (decrypted container).
fn unpack_zip_impl<R: Read + Seek>(
    mut zip: ZipArchive<R>,
    archive_path: &Path,
    output_dir: Option<&Path>,
) -> Result<UnpackedSong> {
    // 1. Read manifest.
    let manifest: PackageManifest =
        read_zip_json(&mut zip, MANIFEST_JSON).ok_or_else(|| PackageError::ManifestMissing)?;
    if manifest.format != FORMAT_NAME {
        return Err(PackageError::InvalidFormat {
            found: manifest.format.clone(),
            expected: FORMAT_NAME.to_string(),
        }
        .into());
    }

    // 2. Read song metadata.
    let song: SongMeta =
        read_zip_json(&mut zip, SONG_JSON).ok_or_else(|| PackageError::SongMissing)?;

    // 3. Resolve output directory.
    let out_dir = match output_dir {
        Some(d) => d.to_path_buf(),
        None => {
            let stem = archive_path
                .file_stem()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("unpacked"));
            archive_path.parent().unwrap_or(Path::new(".")).join(stem)
        }
    };
    std::fs::create_dir_all(&out_dir)
        .with_context(|| format!("create output dir: {}", out_dir.display()))?;

    // 4. Extract all entries to disk.
    let audio_filename = manifest.files.audio.clone();
    let lyrics_filename = manifest.files.lyrics.clone();
    let creation_request_path = manifest.files.creation_request.clone();
    let creation_plan_path = manifest.files.creation_plan.clone();
    let creation_lego_state_path = manifest.files.creation_lego_state.clone();
    let chat_path = manifest.files.chat.clone();

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let entry_name = entry.name().to_string();
        // Sanitize path: prevent path traversal.
        let dest = out_dir.join(sanitize_zip_path(&entry_name));
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create parent dir for: {}", dest.display()))?;
        }
        let mut out_file =
            File::create(&dest).with_context(|| format!("create file: {}", dest.display()))?;
        std::io::copy(&mut entry, &mut out_file)?;
    }

    // 5. Load creation context JSON into memory (small files).
    let creation_request = load_optional_json(&out_dir, creation_request_path.as_deref())?;
    let creation_plan = load_optional_json(&out_dir, creation_plan_path.as_deref())?;
    let lego_state = load_optional_json(&out_dir, creation_lego_state_path.as_deref())?;
    let chat_messages = load_optional_json(&out_dir, chat_path.as_deref())?;

    let audio_path = out_dir.join(&audio_filename);
    let lyrics_path = lyrics_filename.map(|f| out_dir.join(f).to_string_lossy().to_string());

    Ok(UnpackedSong {
        output_dir: out_dir.to_string_lossy().to_string(),
        manifest,
        song,
        audio_path: audio_path.to_string_lossy().to_string(),
        lyrics_path,
        creation_request,
        creation_plan,
        lego_state,
        chat_messages,
    })
}

/// Check whether an `.a00m` archive uses the v1.2.0+ encrypted container
/// format (magic `A00M`). Returns `false` for standard ZIP archives
/// (v1.0.0/v1.1.0, or v1.2.0 packaged without a password).
pub fn is_archive_encrypted(archive_path: &Path) -> bool {
    crate::package_container::is_encrypted_container(archive_path)
}

/// Scan a directory for `.a00m` files and return one [`SongEntry`] per file,
/// sorted by last-modified time descending (newest first).
///
/// For each file:
/// - Reads `file_size` and `modified_at` from filesystem metadata.
/// - Detects encryption via [`is_archive_encrypted`].
/// - For unencrypted archives, parses `song.json` into `meta`. Metadata read
///   failures are logged and tolerated (the entry still appears with
///   `meta = None`) so a single corrupt file does not break the whole list.
/// - For encrypted archives, `meta` is left as `None` (caller must supply a
///   password via [`read_song_meta_with_password`] to view metadata).
///
/// Non-`.a00m` entries and the `.cache/` subdirectory (used by the player for
/// unpacked audio) are skipped. If `songs_dir` does not exist, returns an
/// empty list rather than an error (a fresh install has no songs yet).
pub fn list_songs(songs_dir: &Path) -> Result<Vec<SongEntry>> {
    if !songs_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<SongEntry> = Vec::new();

    for dir_entry in std::fs::read_dir(songs_dir)
        .with_context(|| format!("read songs dir: {}", songs_dir.display()))?
    {
        let dir_entry = match dir_entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("[list_songs] skipping unreadable dir entry: {e}");
                continue;
            }
        };

        let path = dir_entry.path();
        if !path.is_file() {
            continue;
        }
        // Only consider `.a00m` files (case-insensitive).
        let is_a00m = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("a00m"));
        if !is_a00m {
            continue;
        }

        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("[list_songs] skipping {filename}: metadata read failed: {e}");
                continue;
            }
        };
        let file_size = metadata.len();
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let is_encrypted = is_archive_encrypted(&path);
        // 读取 song.json 元数据：加密容器用固定版本密码表自动解密
        let meta = match read_song_meta_auto(&path) {
            Ok((_, song)) => Some(song),
            Err(e) => {
                log::warn!(
                    "[list_songs] failed to read meta for {filename}: {e} — listing without meta"
                );
                None
            }
        };

        entries.push(SongEntry {
            path: path.to_string_lossy().to_string(),
            filename,
            file_size,
            modified_at,
            is_encrypted,
            meta,
        });
    }

    // Sort by modified_at descending (newest first). Stable sort keeps
    // filesystem order for files with identical timestamps.
    entries.sort_by_key(|e| std::cmp::Reverse(e.modified_at));
    Ok(entries)
}

/// Extract the cover image from a `.a00m` archive into `output_dir`, returning
/// the absolute path to the written cover file, or `None` when the archive
/// has no cover.
///
/// The output filename is taken from `manifest.files.cover` (e.g.
/// `cover.jpg`), so the original extension is preserved. If `output_dir` does
/// not exist, it is created.
///
/// For encrypted v1.2.0+ containers, `password` must be non-empty. For
/// standard ZIP archives, `password` is ignored.
///
/// This is a fast path for library thumbnails: it reads only `manifest.json`
/// and the cover entry, skipping the (much larger) FLAC audio. Use
/// [`unpack_song`] when the full audio is needed.
pub fn extract_cover(
    archive_path: &Path,
    output_dir: &Path,
    password: Option<&str>,
) -> Result<Option<String>> {
    // 1. Open the archive (decrypt if needed) and read manifest + cover bytes.
    let cover_filename: Option<String>;
    let cover_bytes: Option<Vec<u8>>;

    if crate::package_container::is_encrypted_container(archive_path) {
        let pw = password
            .filter(|p| !p.is_empty())
            .ok_or(PackageError::PasswordRequired)?;
        let zip_bytes = crate::package_container::decrypt_container(archive_path, pw)
            .map_err(preserve_decrypt_error)?;
        let cursor = Cursor::new(zip_bytes);
        let mut zip = ZipArchive::new(cursor)?;
        let manifest: PackageManifest =
            read_zip_json(&mut zip, MANIFEST_JSON).ok_or_else(|| PackageError::ManifestMissing)?;
        cover_filename = manifest.files.cover.clone();
        cover_bytes = read_cover_from_zip(&mut zip, cover_filename.as_deref())?;
    } else {
        let file = File::open(archive_path)
            .with_context(|| format!("open archive: {}", archive_path.display()))?;
        let mut zip = ZipArchive::new(file)?;
        let manifest: PackageManifest =
            read_zip_json(&mut zip, MANIFEST_JSON).ok_or_else(|| PackageError::ManifestMissing)?;
        cover_filename = manifest.files.cover.clone();
        cover_bytes = read_cover_from_zip(&mut zip, cover_filename.as_deref())?;
    }

    let Some(filename) = cover_filename else {
        return Ok(None);
    };
    let Some(bytes) = cover_bytes else {
        log::warn!(
            "[extract_cover] manifest references cover '{}' but entry is missing in {}",
            filename,
            archive_path.display()
        );
        return Ok(None);
    };

    // 2. Write cover to output_dir/{filename}.
    std::fs::create_dir_all(output_dir)
        .with_context(|| format!("create cover output dir: {}", output_dir.display()))?;
    let dest = output_dir.join(&filename);
    std::fs::write(&dest, &bytes)
        .with_context(|| format!("write cover file: {}", dest.display()))?;

    Ok(Some(dest.to_string_lossy().to_string()))
}

/// Read a cover entry from an opened `ZipArchive` by filename. Returns
/// `Ok(None)` when `cover_filename` is `None` or the entry does not exist.
fn read_cover_from_zip<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    cover_filename: Option<&str>,
) -> Result<Option<Vec<u8>>> {
    match cover_filename {
        Some(name) => match zip.by_name(name) {
            Ok(mut entry) => {
                let mut buf = Vec::new();
                entry.read_to_end(&mut buf)?;
                Ok(Some(buf))
            }
            Err(zip::result::ZipError::FileNotFound) => Ok(None),
            Err(e) => Err(anyhow::Error::from(e)),
        },
        None => Ok(None),
    }
}

/// Read only `manifest.json` and `song.json` from a `.a00m` archive without
/// extracting the audio. Fast path for previewing a library of songs.
///
/// For v1.2.0+ encrypted containers (magic `A00M`), returns
/// [`PackageError::PasswordRequired`] — callers should switch to
/// [`read_song_meta_with_password`].
pub fn read_song_meta(archive_path: &Path) -> Result<(PackageManifest, SongMeta)> {
    if crate::package_container::is_encrypted_container(archive_path) {
        return Err(PackageError::PasswordRequired.into());
    }
    let file = File::open(archive_path)
        .with_context(|| format!("open archive: {}", archive_path.display()))?;
    let mut zip = ZipArchive::new(file)?;
    read_song_meta_from_zip(&mut zip)
}

/// Read `manifest.json` + `song.json` from a possibly-encrypted `.a00m`
/// archive without extracting audio. Like [`read_song_meta`], but accepts a
/// password for v1.2.0+ encrypted containers.
///
/// For encrypted containers, `password` must be non-empty. For standard ZIP
/// archives, `password` is ignored.
pub fn read_song_meta_with_password(
    archive_path: &Path,
    password: Option<&str>,
) -> Result<(PackageManifest, SongMeta)> {
    if crate::package_container::is_encrypted_container(archive_path) {
        let pw = password
            .filter(|p| !p.is_empty())
            .ok_or(PackageError::PasswordRequired)?;
        let zip_bytes = crate::package_container::decrypt_container(archive_path, pw)
            .map_err(preserve_decrypt_error)?;
        let cursor = Cursor::new(zip_bytes);
        let mut zip = ZipArchive::new(cursor)?;
        read_song_meta_from_zip(&mut zip)
    } else {
        let file = File::open(archive_path)
            .with_context(|| format!("open archive: {}", archive_path.display()))?;
        let mut zip = ZipArchive::new(file)?;
        read_song_meta_from_zip(&mut zip)
    }
}

/// Read `manifest.json` + `song.json` from a possibly-encrypted `.a00m`
/// archive, automatically trying all passwords from the embedded version
/// table (no user input required).
///
/// For encrypted containers, iterates `passwords::PASSWORDS` until one
/// decrypts successfully. For standard ZIP archives, reads directly.
pub fn read_song_meta_auto(archive_path: &Path) -> Result<(PackageManifest, SongMeta)> {
    if crate::package_container::is_encrypted_container(archive_path) {
        for (_, pwd_bytes) in crate::passwords::PASSWORDS {
            let pw_str = std::str::from_utf8(pwd_bytes).unwrap_or("");
            if let Ok(result) = read_song_meta_with_password(archive_path, Some(pw_str)) {
                return Ok(result);
            }
        }
        Err(
            PackageError::DecryptionFailed("no matching version password in embedded table".into())
                .into(),
        )
    } else {
        read_song_meta(archive_path)
    }
}

/// Shared manifest+song reader operating on an already-opened `ZipArchive`.
fn read_song_meta_from_zip<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
) -> Result<(PackageManifest, SongMeta)> {
    let manifest: PackageManifest =
        read_zip_json(zip, MANIFEST_JSON).ok_or_else(|| PackageError::ManifestMissing)?;
    if manifest.format != FORMAT_NAME {
        return Err(PackageError::InvalidFormat {
            found: manifest.format.clone(),
            expected: FORMAT_NAME.to_string(),
        }
        .into());
    }
    let song: SongMeta = read_zip_json(zip, SONG_JSON).ok_or_else(|| PackageError::SongMissing)?;
    Ok((manifest, song))
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

fn read_zip_json<T: for<'de> Deserialize<'de>, R: std::io::Read + std::io::Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
) -> Option<T> {
    let mut entry = zip.by_name(name).ok()?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn sanitize_zip_path(path: &str) -> PathBuf {
    // Strip leading slashes and reject `..` components to prevent path traversal.
    let mut out = PathBuf::new();
    for component in path.split(['/', '\\']) {
        if component.is_empty() || component == "." || component == ".." {
            continue;
        }
        out.push(component);
    }
    out
}

fn load_optional_json(dir: &Path, relative: Option<&str>) -> Result<Option<serde_json::Value>> {
    match relative {
        Some(rel) => {
            let path = dir.join(rel);
            if !path.exists() {
                return Ok(None);
            }
            let data = std::fs::read(&path)
                .with_context(|| format!("read creation context: {}", path.display()))?;
            let value: serde_json::Value = serde_json::from_slice(&data)
                .with_context(|| format!("parse JSON: {}", path.display()))?;
            Ok(Some(value))
        }
        None => Ok(None),
    }
}

// ----------------------------------------------------------------------------
// In-place metadata edit (v1.2.0+)
// ----------------------------------------------------------------------------

/// Field-level updates for [`update_song_meta`]. All fields are optional —
/// `None` means "leave unchanged". `cover_path = Some(new_path)` replaces the
/// embedded cover image; `cover_path = None` keeps the existing cover.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongMetaUpdates {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    /// Absolute path to a new cover image file. `None` = keep existing cover.
    #[serde(default)]
    pub cover_path: Option<String>,
}

/// Edit the metadata of an existing `.a00m` archive **in place**.
///
/// Only `song.json`, `manifest.json` (cover field), and the cover image file
/// are rewritten — the audio FLAC, lyrics, and creation context bytes are
/// copied verbatim from the source archive, so there is no lossy re-encoding.
///
/// # Encryption
///
/// Encrypted archives (magic `A00M`) require the user password to decrypt;
/// after editing, the new ZIP is re-encrypted with the **same** password and
/// the result atomically replaces the original file.
///
/// # Atomicity
///
/// The new archive is written to `{archive}.a00m.tmp` and then renamed over
/// the original path. A crash before rename leaves the original intact.
pub fn update_song_meta(
    archive_path: &Path,
    password: Option<&str>,
    updates: SongMetaUpdates,
) -> Result<()> {
    use crate::package_container::{decrypt_container, write_encrypted_container};

    // 1. Resolve password for encrypted archives (required up-front so we can
    //    re-encrypt with the same key after editing).
    let is_encrypted = is_archive_encrypted(archive_path);
    let pw: Option<&str> = if is_encrypted {
        let pw = password.filter(|p| !p.is_empty());
        if pw.is_none() {
            bail!("password required to edit an encrypted archive");
        }
        pw
    } else {
        None
    };

    // 2. Read the archive into memory as ZIP bytes (decrypt if needed).
    let zip_bytes: Vec<u8> = if is_encrypted {
        let pw = pw.expect("checked above");
        decrypt_container(archive_path, pw).map_err(preserve_decrypt_error)?
    } else {
        std::fs::read(archive_path)
            .with_context(|| format!("read archive: {}", archive_path.display()))?
    };

    // 3. Parse manifest + song.json from the ZIP.
    let cursor = Cursor::new(zip_bytes.as_slice());
    let mut zip = ZipArchive::new(cursor)?;
    let manifest: PackageManifest =
        read_zip_json(&mut zip, MANIFEST_JSON).ok_or_else(|| PackageError::ManifestMissing)?;
    let song: SongMeta =
        read_zip_json(&mut zip, SONG_JSON).ok_or_else(|| PackageError::SongMissing)?;

    // 4. Apply field updates.
    let mut new_song = song.clone();
    if let Some(title) = updates.title {
        new_song.title = title;
    }
    if let Some(artist) = updates.artist {
        new_song.artist = artist;
    }
    if let Some(album) = updates.album {
        new_song.album = album;
    }
    if let Some(genre) = updates.genre {
        new_song.genre = genre;
    }

    // 5. Resolve new cover image (if provided).
    // new_cover: Option<(filename, bytes, CoverMeta)>
    let new_cover: Option<(String, Vec<u8>, CoverMeta)> = match updates.cover_path {
        Some(cp) => {
            let cover_path = PathBuf::from(&cp);
            if !cover_path.exists() {
                bail!("cover_path not found: {}", cover_path.display());
            }
            let bytes = std::fs::read(&cover_path)
                .with_context(|| format!("read cover file: {}", cover_path.display()))?;
            let dims = imagesize::blob_size(&bytes)
                .map_err(|e| PackageError::Other(anyhow::anyhow!("read cover dimensions: {e}")))?;
            let ext = cover_path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_else(|| "jpg".into());
            let mime = match ext.as_str() {
                "png" => "image/png",
                "webp" => "image/webp",
                _ => "image/jpeg",
            };
            let filename = format!("cover.{ext}");
            let cover_meta = CoverMeta {
                filename: filename.clone(),
                format: mime.to_string(),
                width: dims.width as u32,
                height: dims.height as u32,
            };
            Some((filename, bytes, cover_meta))
        }
        None => None,
    };

    // 6. Update song.cover + manifest.files.cover to reflect the new cover.
    let mut new_manifest = manifest.clone();
    if let Some((ref filename, _, ref cover_meta)) = new_cover {
        new_song.cover = Some(cover_meta.clone());
        new_manifest.files.cover = Some(filename.clone());
    }

    // 7. Collect all original entries, skipping the ones we are going to
    //    rewrite (song.json, manifest.json) and the old cover file (when a
    //    new cover is replacing it).
    let old_cover_name: Option<String> = manifest.files.cover.clone();
    let mut entries: Vec<(String, Vec<u8>)> = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry.name().to_string();

        // Always rewrite these two via new content below.
        if name == SONG_JSON || name == MANIFEST_JSON {
            continue;
        }
        // If a new cover is supplied, drop both the old cover (whatever its
        // name was) and any entry that collides with the new cover filename.
        if let Some((ref new_name, _, _)) = new_cover {
            if let Some(ref old_name) = old_cover_name {
                if name == *old_name {
                    continue;
                }
            }
            if name == *new_name {
                continue;
            }
        }

        let mut buf = Vec::new();
        std::io::copy(&mut entry, &mut buf)?;
        entries.push((name, buf));
    }
    // Drop the read cursor before reusing zip_bytes for writing.
    drop(zip);

    // 8. Build the new ZIP in memory.
    let new_zip_bytes: Vec<u8> = {
        let mut out_buf = Cursor::new(Vec::new());
        let mut new_zip = ZipWriter::new(&mut out_buf);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        // Copy through all unchanged entries first.
        for (name, bytes) in &entries {
            new_zip.start_file(name, opts)?;
            new_zip.write_all(bytes)?;
        }

        // Rewrite manifest.json.
        new_zip.start_file(MANIFEST_JSON, opts)?;
        let manifest_bytes = serde_json::to_vec_pretty(&new_manifest)?;
        new_zip.write_all(&manifest_bytes)?;

        // Rewrite song.json.
        new_zip.start_file(SONG_JSON, opts)?;
        let song_bytes = serde_json::to_vec_pretty(&new_song)?;
        new_zip.write_all(&song_bytes)?;

        // Append the new cover image (if any).
        if let Some((ref filename, ref bytes, _)) = new_cover {
            new_zip.start_file(filename, opts)?;
            new_zip.write_all(bytes)?;
        }

        new_zip.finish()?;
        out_buf.into_inner()
    };

    // 9. Atomic replace: write to {archive}.a00m.tmp, then rename over original.
    let tmp_path = archive_path.with_extension("a00m.tmp");
    if let Some(pw) = pw {
        write_encrypted_container(&tmp_path, &new_zip_bytes, pw)?;
    } else {
        std::fs::write(&tmp_path, &new_zip_bytes)
            .with_context(|| format!("write temp archive: {}", tmp_path.display()))?;
    }
    std::fs::rename(&tmp_path, archive_path)
        .with_context(|| format!("replace archive: {}", archive_path.display()))?;

    log::info!(
        "Updated song meta in {}: title='{}', artist='{}', cover_changed={}",
        archive_path.display(),
        new_song.title,
        new_song.artist,
        new_cover.is_some()
    );

    Ok(())
}
