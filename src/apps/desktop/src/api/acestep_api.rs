//! AceStep (text-to-music) Tauri command API.
//!
//! Exposes the [`acestep`] crate's pipeline via Tauri commands. The pipeline
//! is stored in a global `OnceCell<tokio::sync::Mutex<Option<AceStepPipeline>>>`
//! — only one pipeline instance exists at a time, serialising all access.
//!
//! # Commands
//!
//! | Command                    | Description                                              |
//! |----------------------------|----------------------------------------------------------|
//! | `acestep_get_status`       | Query pipeline state (loaded / synth / lm)               |
//! | `acestep_load_synth`       | Load DiT + text encoder + VAE                            |
//! | `acestep_load_lm`          | Load Qwen3 LM                                            |
//! | `acestep_unload`           | Unload all models, free VRAM                             |
//! | `acestep_generate`         | Generate audio (text2music / cover / lego)               |
//! | `acestep_cancel`           | Cancel the running generation                            |
//! | `acestep_llm_complete`     | LLM text completion (lyrics/caption writing)             |
//! | `acestep_llm_chat_stream`  | Multi-turn streaming LLM chat with model selection       |
//! | `acestep_web_search`      | Web search for lyrics knowledge expansion                |
//! | `acestep_align_lyrics`    | Generate timestamped LRC via Qwen3-ForcedAligner         |
//!
//! # Events
//!
//! - `acestep_progress` — emitted during generation with progress info.
//! - `acestep_generate_done` — emitted when generation completes successfully.
//! - `acestep_llm_chunk` — emitted for each text delta during `acestep_llm_chat_stream`.
//! - `acestep_llm_done` — emitted when `acestep_llm_chat_stream` finishes (ok or error).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::StreamExt;
use once_cell::sync::{Lazy, OnceCell};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use acestep::{
    AceRequest, AceStepCancelToken, AceStepPipeline, LmConfig, ProgressCallback, SynthConfig,
};
use ai00_x_core::util::types::Message;
use ai00_x_inference::runtime::downloader::ACESTEP_VERSION;
use ai00_x_inference::runtime::find_gguf_lib_dir;
use ai00_x_inference::runtime::get_acestep_dir;
use ai00_x_inference::runtime::get_app_root_dir;
use ai00_x_inference::runtime::get_runtime_dir;

use crate::api::app_state::AppState;

// ---- Global state ----

static PIPELINE: OnceCell<Mutex<Option<AceStepPipeline>>> = OnceCell::new();
static CANCEL_TOKEN: OnceCell<Mutex<Option<AceStepCancelToken>>> = OnceCell::new();

fn pipeline() -> &'static Mutex<Option<AceStepPipeline>> {
    PIPELINE.get_or_init(|| Mutex::new(None))
}

fn cancel_token() -> &'static Mutex<Option<AceStepCancelToken>> {
    CANCEL_TOKEN.get_or_init(|| Mutex::new(None))
}

/// Preload GGML DLLs from `runtime/gguf/` into the process address space so
/// that `acestep_c.dll` (loaded later with `LOAD_LIBRARY_SEARCH_*` flags that
/// bypass PATH) can find `ggml-base.dll` / `ggml.dll` / `ggml-cuda.dll`.
///
/// GGML DLLs used to live in the same directory as `acestep_c.dll` but have
/// been moved to a dedicated `runtime/gguf/` directory. `ffi::get_ffi()`
/// only registers the acestep lib dir via `AddDllDirectory`, so we preload
/// the GGML DLLs here (matching the pattern in `asr/llama.rs::get_ffi()`).
fn preload_ggml_dlls() {
    let Some(gguf_dir) = find_gguf_lib_dir() else {
        log::warn!("[AceStep] gguf dir not found, skipping GGML preload");
        return;
    };

    let dll_names: &[&str] = if cfg!(target_os = "windows") {
        &[
            "ggml-base.dll",
            "ggml.dll",
            "ggml-cuda.dll",
            "ggml-vulkan.dll",
        ]
    } else if cfg!(target_os = "macos") {
        &["libggml-base.dylib", "libggml.dylib", "libggml-metal.dylib"]
    } else {
        &["libggml-base.so", "libggml.so", "libggml-cuda.so"]
    };

    for name in dll_names {
        let path = gguf_dir.join(name);
        if !path.exists() {
            continue;
        }
        match unsafe { libloading::Library::new(&path) } {
            Ok(lib) => {
                // Leak the library so it stays loaded for the lifetime of the
                // process — Windows reuses already-loaded DLLs by name.
                std::mem::forget(lib);
                log::info!("[AceStep] Preloaded GGML DLL: {}", path.display());
            }
            Err(e) => {
                log::warn!("[AceStep] Failed to preload {}: {}", path.display(), e);
            }
        }
    }
}

// ---- DTOs ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepStatus {
    pub loaded: bool,
    pub synth_loaded: bool,
    pub lm_loaded: bool,
    pub lib_dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepSynthLoadRequest {
    pub text_encoder_path: String,
    pub dit_path: String,
    pub vae_path: String,
    pub adapter_path: Option<String>,
    pub adapter_scale: Option<f32>,
    pub use_fa: Option<bool>,
    pub clamp_fp16: Option<bool>,
    pub use_batch_cfg: Option<bool>,
    pub vae_chunk: Option<i32>,
    pub vae_overlap: Option<i32>,
    /// If true, keep all modules in VRAM (EVICT_NEVER). If false (default),
    /// at most one GPU module is resident (EVICT_STRICT, lower VRAM).
    pub keep_loaded: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepLmLoadRequest {
    pub model_path: String,
    pub max_seq: Option<i32>,
    pub max_batch: Option<i32>,
    pub use_fsm: Option<bool>,
    pub use_fa: Option<bool>,
    pub use_batch_cfg: Option<bool>,
    pub clamp_fp16: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepGenerateRequest {
    /// The AceRequest (snake_case fields, matches C++ JSON format).
    pub request: AceRequest,
    /// Path to source audio file (wav, 48kHz stereo) for cover/lego/repaint.
    pub src_audio_path: Option<String>,
    /// Path to reference audio file (wav, 48kHz stereo) for timbre conditioning.
    pub ref_audio_path: Option<String>,
    /// Output directory for the generated wav file. None = temp dir.
    pub output_dir: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AceStepGenerateResult {
    pub output_path: String,
    pub duration_seconds: f32,
    pub sample_rate: u32,
    pub channels: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepProgressEvent {
    pub stage: i32,
    pub stage_name: String,
    pub step: i32,
    pub total: i32,
    pub msg: String,
}

/// A local model file status entry.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepLocalModel {
    /// Pipeline role: "lm" | "text_encoder" | "dit" | "vae".
    pub role: String,
    /// Human-readable variant label (e.g. "4B-Q8_0", "0.6B-Q8_0").
    pub variant: String,
    /// Filename on disk (e.g. "acestep-5Hz-lm-4B-Q8_0.gguf").
    pub filename: String,
    /// Absolute path if the file exists, empty string otherwise.
    pub local_path: String,
    /// True when the file exists on disk.
    pub exists: bool,
    /// File size in bytes (0 if not exists).
    pub size_bytes: u64,
}

/// Catalog of expected ACE-Step model files with their on-disk presence.
///
/// This mirrors the `acestep_catalog.rs` entries in hf-model-manager so the
/// frontend ModelLoader can show which files are present without calling the
/// hf-model-manager HTTP API.
fn expected_models() -> &'static [(&'static str, &'static str, &'static str)] {
    // (role, variant, filename)
    &[
        ("lm", "4B-Q8_0", "acestep-5Hz-lm-4B-Q8_0.gguf"),
        ("lm", "0.6B-Q8_0", "acestep-5Hz-lm-0.6B-Q8_0.gguf"),
        ("text_encoder", "Q8_0", "Qwen3-Embedding-0.6B-Q8_0.gguf"),
        // DiT base: 50 steps, shift=1.0, guidance=7.0 (supports ALL tasks incl. lego/extract/complete)
        ("dit", "base-Q5_K_M", "acestep-v15-base-Q5_K_M.gguf"),
        ("dit", "base-Q8_0", "acestep-v15-base-Q8_0.gguf"),
        ("dit", "xl-base-Q5_K_M", "acestep-v15-xl-base-Q5_K_M.gguf"),
        ("dit", "xl-base-Q8_0", "acestep-v15-xl-base-Q8_0.gguf"),
        ("vae", "BF16", "vae-BF16.gguf"),
    ]
}

/// Resolve the models directory: `AI00X_MODELS_DIR` env var or `<exe>/models/`.
fn resolve_models_dir() -> PathBuf {
    ai00_x_inference::runtime::get_models_dir()
}

// ---- Helpers ----

/// Resolve the lib directory for the AceStep DLL.
///
/// Search order:
/// 1. Runtime download directory (`AI00X_RUNTIME_DIR/acestep/<ver>/`).
/// 2. Build-time directory (when built with `ACESTEP_BUILD_FROM_SOURCE=1`).
/// 3. Exe-relative fallback (`<exe_dir>/runtime/acestep/<ver>/`) — covers dev
///    mode where `AI00X_RUNTIME_DIR` is overridden by `dev.cjs` but the DLL
///    was built/placed under `target/release/runtime/`.
///
/// Each candidate is only accepted if the actual DLL file exists inside it
/// (not just the directory) — otherwise an empty/stale directory would mask
/// later fallbacks that actually contain the library.
fn resolve_lib_dir() -> Result<PathBuf, String> {
    let lib_filename = if cfg!(target_os = "windows") {
        "acestep_c.dll"
    } else if cfg!(target_os = "macos") {
        "libacestep_c.dylib"
    } else {
        "libacestep_c.so"
    };

    // Collect candidate directories with human-readable labels for the error.
    let runtime_dir = get_acestep_dir();
    let build_dir = acestep::build_lib_dir().map(PathBuf::from);
    let exe_fallback = get_app_root_dir()
        .join("runtime")
        .join("acestep")
        .join(ACESTEP_VERSION);

    let candidates: [(PathBuf, &'static str); 3] = [
        (runtime_dir, "runtime dir (AI00X_RUNTIME_DIR/acestep/<ver>)"),
        (
            build_dir.unwrap_or_default(),
            "build-time dir (ACESTEP_LIB_DIR)",
        ),
        (
            exe_fallback,
            "exe-relative runtime dir (<exe>/runtime/acestep/<ver>)",
        ),
    ];

    for (dir, _label) in &candidates {
        if dir.join(lib_filename).exists() {
            return Ok(dir.clone());
        }
    }

    let tried: Vec<String> = candidates
        .iter()
        .map(|(dir, label)| format!("  - {} ({})", dir.join(lib_filename).display(), label))
        .collect();
    Err(format!(
        "AceStep library ({}) not found in any candidate directory.\nTried:\n{}",
        lib_filename,
        tried.join("\n")
    ))
}

/// Read a wav file as interleaved f32 samples.
/// Returns (samples, sample_rate, channels).
fn read_wav_interleaved(path: &str) -> Result<(Vec<f32>, u32, u16), String> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| format!("Failed to open wav file '{path}': {e}"))?;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels;

    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| format!("Failed to read float samples: {e}"))?,
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<Result<_, _>>()
                .map_err(|e| format!("Failed to read int samples: {e}"))?
        }
    };

    Ok((samples, sample_rate, channels))
}

/// Write interleaved f32 samples to a 32-bit float wav file.
fn write_wav_interleaved(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("Failed to create wav file '{}': {e}", path.display()))?;
    for &s in samples {
        writer
            .write_sample(s)
            .map_err(|e| format!("Failed to write sample: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("Failed to finalize wav: {e}"))?;
    Ok(())
}

/// Mix two interleaved audio buffers (element-wise addition with clamping).
///
/// Used for lego post-processing: the DiT generates only the new stem, so we
/// mix it with the source audio (previous layers) to produce a progressive
/// layered output. If lengths differ, the shorter buffer is zero-padded.
fn mix_audio(stem: &[f32], backing: &[f32]) -> Vec<f32> {
    let max_len = stem.len().max(backing.len());
    let mut out = Vec::with_capacity(max_len);
    for i in 0..max_len {
        let s = stem.get(i).copied().unwrap_or(0.0);
        let b = backing.get(i).copied().unwrap_or(0.0);
        out.push((s + b).clamp(-1.0, 1.0));
    }
    out
}

// ---- Commands ----

/// Get the current AceStep pipeline status.
#[tauri::command]
pub async fn acestep_get_status() -> Result<AceStepStatus, String> {
    let guard = pipeline().lock().await;
    let lib_dir = get_acestep_dir();
    Ok(AceStepStatus {
        loaded: guard.is_some(),
        synth_loaded: guard.as_ref().is_some_and(|p| p.is_synth_loaded()),
        lm_loaded: guard.as_ref().is_some_and(|p| p.is_lm_loaded()),
        lib_dir: lib_dir.display().to_string(),
    })
}

/// List local ACE-Step model files and their on-disk presence.
///
/// Returns one entry per expected model file (mirrors the hf-model-manager
/// catalog). The frontend ModelLoader uses this to show which files are
/// present and to pick which variant to load.
#[tauri::command]
pub async fn acestep_list_local_models() -> Result<Vec<AceStepLocalModel>, String> {
    let models_dir = resolve_models_dir();
    let acestep_dir = models_dir.join("acestep");

    // Build filename -> expected size lookup from the catalog so we can flag
    // truncated files as missing (a non-empty but incomplete download must
    // not be reported as a usable model).
    let expected_sizes: std::collections::HashMap<&str, u64> = acestep_catalog()
        .iter()
        .map(|(_, filename, _, _, approx_size, _, _)| (*filename, *approx_size))
        .collect();

    let result: Vec<AceStepLocalModel> = expected_models()
        .iter()
        .map(|(role, variant, filename)| {
            let path = acestep_dir.join(filename);
            let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let expected = expected_sizes.get(filename).copied().unwrap_or(0);
            let exists = size_bytes > 0 && size_bytes >= expected;
            AceStepLocalModel {
                role: role.to_string(),
                variant: variant.to_string(),
                filename: filename.to_string(),
                local_path: if exists {
                    path.display().to_string()
                } else {
                    String::new()
                },
                exists,
                size_bytes,
            }
        })
        .collect();

    Ok(result)
}

/// Load the synth pipeline (DiT + text encoder + VAE).
#[tauri::command]
pub async fn acestep_load_synth(request: AceStepSynthLoadRequest) -> Result<(), String> {
    // Pre-flight: verify model files exist and are not truncated.
    // A common failure mode is an interrupted download leaving a partial
    // GGUF file that causes a cryptic "ace_synth_load failed" error.
    {
        let check = |path_str: &str, label: &str| -> Result<(), String> {
            if path_str.is_empty() {
                return Err(format!("{label} path is empty (model not downloaded?)"));
            }
            let path = std::path::Path::new(path_str);
            if !path.exists() {
                return Err(format!("{label} file not found: {path_str}"));
            }
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            // GGUF files are at least several hundred MB. A file smaller
            // than 50 MB is almost certainly truncated/corrupted.
            if size < 50_000_000 {
                return Err(format!(
                    "{label} file appears truncated ({} bytes, expected much more). Please re-download the model.",
                    size
                ));
            }
            log::info!("[AceStep] {label} file OK: {} ({} bytes)", path_str, size);
            Ok(())
        };
        check(&request.text_encoder_path, "Text Encoder")?;
        check(&request.dit_path, "DiT")?;
        check(&request.vae_path, "VAE")?;
    }

    let lib_dir = resolve_lib_dir()?;
    let keep_loaded = request.keep_loaded.unwrap_or(false);

    let mut guard = pipeline().lock().await;

    // Create pipeline if not yet created.
    if guard.is_none() {
        // Verify shared GGML DLLs exist in runtime/gguf/.
        ai00_x_inference::runtime::sync_ggml_dlls();
        // Preload GGML DLLs into the process so acestep_c.dll (loaded with
        // LOAD_LIBRARY_SEARCH_* flags) can find them — they no longer live
        // in the same directory as acestep_c.dll.
        preload_ggml_dlls();

        let pipe = AceStepPipeline::new(&lib_dir, keep_loaded)
            .map_err(|e| format!("Failed to create AceStep pipeline: {e}"))?;
        *guard = Some(pipe);
    }

    let pipe = guard.as_mut().expect("pipeline was just initialised above");

    let mut config = SynthConfig::new(
        request.text_encoder_path,
        request.dit_path,
        request.vae_path,
    );
    config.adapter_path = request.adapter_path.map(PathBuf::from);
    config.adapter_scale = request.adapter_scale.unwrap_or(0.0);
    config.use_fa = request.use_fa.unwrap_or(true);
    config.clamp_fp16 = request.clamp_fp16.unwrap_or(false);
    config.use_batch_cfg = request.use_batch_cfg.unwrap_or(false);
    config.vae_chunk = request.vae_chunk.unwrap_or(1024);
    config.vae_overlap = request.vae_overlap.unwrap_or(64);

    pipe.load_synth(&config)
        .map_err(|e| format!("Failed to load synth: {e}"))?;

    log::info!("[AceStep] Synth pipeline loaded successfully");
    Ok(())
}

/// Load the LM (Qwen3) pipeline.
#[tauri::command]
pub async fn acestep_load_lm(request: AceStepLmLoadRequest) -> Result<(), String> {
    let mut guard = pipeline().lock().await;

    if guard.is_none() {
        return Err("Pipeline not created. Load synth first.".into());
    }

    let pipe = guard.as_mut().expect("pipeline existence checked above");

    let mut config = LmConfig::new(request.model_path);
    config.max_seq = request.max_seq.unwrap_or(8192);
    config.max_batch = request.max_batch.unwrap_or(1);
    config.use_fsm = request.use_fsm.unwrap_or(true);
    config.use_fa = request.use_fa.unwrap_or(true);
    config.use_batch_cfg = request.use_batch_cfg.unwrap_or(false);
    config.clamp_fp16 = request.clamp_fp16.unwrap_or(false);

    pipe.load_lm(&config)
        .map_err(|e| format!("Failed to load LM: {e}"))?;

    log::info!("[AceStep] LM pipeline loaded successfully");
    Ok(())
}

/// Unload all models and free VRAM.
#[tauri::command]
pub async fn acestep_unload() -> Result<(), String> {
    let mut guard = pipeline().lock().await;
    *guard = None; // Drop the pipeline, which frees all C resources.
    log::info!("[AceStep] Pipeline unloaded");
    Ok(())
}

/// Generate audio.
#[tauri::command]
pub async fn acestep_generate(
    app: AppHandle,
    request: AceStepGenerateRequest,
) -> Result<AceStepGenerateResult, String> {
    let AceStepGenerateRequest {
        request,
        src_audio_path,
        ref_audio_path,
        output_dir,
    } = request;

    // Read source audio if provided.
    let src_audio = match &src_audio_path {
        Some(path) => {
            let (samples, sr, ch) = read_wav_interleaved(path)?;
            if sr != 48000 {
                return Err(format!(
                    "Source audio must be 48kHz, got {sr}Hz. Please resample first."
                ));
            }
            if ch != 2 {
                return Err(format!("Source audio must be stereo, got {ch} channels"));
            }
            Some(samples)
        }
        None => None,
    };

    // Read reference audio if provided.
    let ref_audio = match &ref_audio_path {
        Some(path) => {
            let (samples, sr, ch) = read_wav_interleaved(path)?;
            if sr != 48000 {
                return Err(format!(
                    "Reference audio must be 48kHz, got {sr}Hz. Please resample first."
                ));
            }
            if ch != 2 {
                return Err(format!("Reference audio must be stereo, got {ch} channels"));
            }
            Some(samples)
        }
        None => None,
    };

    // Extract task_type before request is moved into the async block.
    let task_type = request.task_type.clone();

    // Create cancel token and store it so `acestep_cancel` can signal it.
    let token = AceStepCancelToken::new();
    {
        let mut ct = cancel_token().lock().await;
        *ct = Some(token.clone());
    }

    // Progress callback emits Tauri events.
    let app_handle = app.clone();
    let progress: ProgressCallback = Arc::new(move |event: &acestep::ProgressEvent| {
        let payload = AceStepProgressEvent {
            stage: event.stage,
            stage_name: acestep::stage::label(event.stage).to_string(),
            step: event.step,
            total: event.total,
            msg: event.msg.clone(),
        };
        let _ = app_handle.emit("acestep_progress", payload);
    });

    // Acquire pipeline lock and generate. The guard is held across the
    // `.await` — `AceStepPipeline: Sync` makes the guard `Send`.
    let generate_result = async {
        let guard = pipeline().lock().await;
        let pipe = guard
            .as_ref()
            .ok_or_else(|| "Pipeline not loaded. Call acestep_load_synth first.".to_string())?;
        pipe.generate(
            request,
            src_audio.as_deref(),
            ref_audio.as_deref(),
            Some(token),
            Some(progress),
        )
        .await
        .map_err(|e| format!("Generation failed: {e}"))
    }
    .await;

    // Always clear the cancel token, whether generation succeeded or failed.
    {
        let mut ct = cancel_token().lock().await;
        *ct = None;
    }

    let audio_output = generate_result?;

    // Write output wav file.
    let output_dir = output_dir
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let output_file = output_dir.join(format!(
        "acestep_{}.wav",
        chrono::Utc::now().timestamp_millis()
    ));

    let interleaved = audio_output.to_interleaved();

    // Lego post-processing: the DiT generates only the new stem (e.g. vocals),
    // not a merged track. Mix the generated stem with the source audio (previous
    // layers) so the output is a progressive layered mix.
    let final_audio: Vec<f32> = if task_type == "lego" {
        if let Some(src) = src_audio.as_ref() {
            log::info!(
                "[AceStep] Lego mix: merging stem ({} samples) with src ({} samples)",
                interleaved.len(),
                src.len()
            );
            mix_audio(&interleaved, src)
        } else {
            interleaved
        }
    } else {
        interleaved
    };

    write_wav_interleaved(&output_file, &final_audio, audio_output.sample_rate)?;

    let result = AceStepGenerateResult {
        output_path: output_file.display().to_string(),
        duration_seconds: audio_output.duration_seconds(),
        sample_rate: audio_output.sample_rate,
        channels: 2,
    };

    // Emit completion event.
    let _ = app.emit("acestep_generate_done", result.clone());

    log::info!(
        "[AceStep] Generation complete: {} ({:.1}s)",
        result.output_path,
        result.duration_seconds
    );

    Ok(result)
}

/// Cancel the running generation.
#[tauri::command]
pub async fn acestep_cancel() -> Result<bool, String> {
    let ct = cancel_token().lock().await;
    if let Some(token) = ct.as_ref() {
        token.cancel();
        log::info!("[AceStep] Cancellation requested");
        Ok(true)
    } else {
        Ok(false)
    }
}

// ---- LLM completion (for lyrics/caption writing) ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepLlmCompleteRequest {
    /// User prompt (e.g. "Write lyrics about a summer sunset").
    pub prompt: String,
    /// Optional system prompt (e.g. "You are a professional lyricist.").
    pub system_prompt: Option<String>,
    /// Model reference id ("primary" / "fast" or a specific model id). Defaults to "primary".
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepLlmCompleteResponse {
    pub text: String,
}

/// LLM text completion for ACE-Step workflow.
///
/// Uses Ai00-X's existing LLM (via `ai_client_factory`) to generate text
/// for lyrics or caption writing. This is NOT the ACE-Step internal LM
/// (which generates audio codes) — it's the chat LLM for writing text content.
#[tauri::command]
pub async fn acestep_llm_complete(
    state: State<'_, AppState>,
    request: AceStepLlmCompleteRequest,
) -> Result<AceStepLlmCompleteResponse, String> {
    let model_ref = request.model.unwrap_or_else(|| "primary".to_string());

    // Ensure auth token is synced before creating AI client (same reason as
    // acestep_llm_chat_stream).
    let _ = crate::auth::ensure_auth_synced().await;

    let ai_client = state
        .ai_client_factory
        .get_client_resolved(&model_ref)
        .await
        .map_err(|e| format!("Failed to get AI client: {}", e))?;

    let mut messages: Vec<Message> = Vec::new();
    if let Some(sp) = &request.system_prompt {
        if !sp.is_empty() {
            messages.push(Message::system(sp.clone()));
        }
    }
    messages.push(Message::user(request.prompt));

    let stream_response = match ai_client.send_message_stream(messages.clone(), None).await {
        Ok(resp) => resp,
        Err(e) => {
            let err_str = format!("{}", e);
            if !err_str.contains("401") && !err_str.contains("Unauthorized") {
                return Err(format!("AI request failed: {}", e));
            }
            // 401: refresh token and retry once
            log::warn!(
                "[ACE-Step] llm_complete got 401, refreshing token: {}",
                err_str
            );
            crate::auth::refresh_auth_token_impl().await?;
            let ai_client_new = state
                .ai_client_factory
                .get_client_resolved(&model_ref)
                .await
                .map_err(|e| format!("Failed to get AI client after token refresh: {}", e))?;
            ai_client_new
                .send_message_stream(messages, None)
                .await
                .map_err(|e| format!("AI request failed after token refresh: {}", e))?
        }
    };

    let mut stream = stream_response.stream;
    let mut full_text = String::new();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                if let Some(text) = chunk.text {
                    full_text.push_str(&text);
                }
            }
            Err(e) => {
                return Err(format!("AI stream error: {}", e));
            }
        }
    }

    Ok(AceStepLlmCompleteResponse { text: full_text })
}

// ---- LLM chat stream (multi-turn + streaming + model selection) ----

/// A single chat message in a multi-turn conversation.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepChatMessage {
    /// "user" | "assistant" | "system".
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepLlmChatRequest {
    /// Multi-turn message history (oldest first). The last message should be
    /// the new user turn; previous entries provide context.
    pub messages: Vec<AceStepChatMessage>,
    /// Optional system prompt. If supplied, prepended to `messages`.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Model reference id ("primary" / "fast" or a specific model id). Defaults to "primary".
    #[serde(default)]
    pub model: Option<String>,
    /// Optional session id used to scope the streamed Tauri events so multiple
    /// concurrent ACE-Step chat windows don't cross streams.
    #[serde(default)]
    pub session_id: Option<String>,
}

/// Payload for the `acestep_llm_chunk` event.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AceStepLlmChunkEvent {
    /// Session id echoed back so the frontend can filter events.
    pub session_id: Option<String>,
    /// Incremental text delta (append to the assistant message).
    pub delta: String,
}

/// Payload for the `acestep_llm_done` event.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AceStepLlmDoneEvent {
    pub session_id: Option<String>,
    pub full_text: String,
    /// "ok" | "error" — frontend uses this to decide whether to commit the
    /// assistant message or show an error.
    pub status: String,
    /// Present when status == "error".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Multi-turn streaming chat for the ACE-Step conversational creation flow.
///
/// Unlike `acestep_llm_complete` (single-shot, returns full text at end), this
/// command emits `acestep_llm_chunk` events as the model streams, followed by
/// a single `acestep_llm_done` event. The frontend subscribes to these events
/// to render a live chat experience with model selection and message history.
#[tauri::command]
pub async fn acestep_llm_chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    request: AceStepLlmChatRequest,
) -> Result<AceStepLlmCompleteResponse, String> {
    let model_ref = request.model.unwrap_or_else(|| "primary".to_string());
    let session_id = request.session_id.clone();

    // Ensure the member JWT is loaded into AI00S_AUTH_TOKEN before creating
    // an AI client. The ACE-Step window may send requests before the main
    // window triggers the lazy vault restore, causing 401 errors.
    let _ = crate::auth::ensure_auth_synced().await;

    let ai_client = state
        .ai_client_factory
        .get_client_resolved(&model_ref)
        .await
        .map_err(|e| {
            let msg = format!("Failed to get AI client: {}", e);
            let _ = app.emit(
                "acestep_llm_done",
                AceStepLlmDoneEvent {
                    session_id: session_id.clone(),
                    full_text: String::new(),
                    status: "error".to_string(),
                    error: Some(msg.clone()),
                },
            );
            msg
        })?;

    // Build the message list. System prompt first (if any), then the history.
    let mut messages: Vec<Message> = Vec::with_capacity(request.messages.len() + 1);
    if let Some(sp) = &request.system_prompt {
        if !sp.is_empty() {
            messages.push(Message::system(sp.clone()));
        }
    }
    for msg in &request.messages {
        match msg.role.as_str() {
            "user" => messages.push(Message::user(msg.content.clone())),
            "assistant" => messages.push(Message::assistant(msg.content.clone())),
            "system" => messages.push(Message::system(msg.content.clone())),
            other => {
                let msg = format!("Unknown message role: {}", other);
                let _ = app.emit(
                    "acestep_llm_done",
                    AceStepLlmDoneEvent {
                        session_id: session_id.clone(),
                        full_text: String::new(),
                        status: "error".to_string(),
                        error: Some(msg.clone()),
                    },
                );
                return Err(msg);
            }
        }
    }

    let stream_response = match ai_client.send_message_stream(messages.clone(), None).await {
        Ok(resp) => resp,
        Err(e) => {
            let err_str = format!("{}", e);
            let is_401 = err_str.contains("401") || err_str.contains("Unauthorized");
            if !is_401 {
                let msg = format!("AI request failed: {}", e);
                let _ = app.emit(
                    "acestep_llm_done",
                    AceStepLlmDoneEvent {
                        session_id: session_id.clone(),
                        full_text: String::new(),
                        status: "error".to_string(),
                        error: Some(msg.clone()),
                    },
                );
                return Err(msg);
            }

            // 401: refresh token and retry once (same pattern as fetchWithAuth)
            log::warn!(
                "[ACE-Step] AI request returned 401, refreshing token: {}",
                err_str
            );
            match crate::auth::refresh_auth_token_impl().await {
                Ok(_) => {
                    let ai_client_new = match state
                        .ai_client_factory
                        .get_client_resolved(&model_ref)
                        .await
                    {
                        Ok(c) => c,
                        Err(e) => {
                            let msg = format!("Failed to get AI client after token refresh: {}", e);
                            let _ = app.emit(
                                "acestep_llm_done",
                                AceStepLlmDoneEvent {
                                    session_id: session_id.clone(),
                                    full_text: String::new(),
                                    status: "error".to_string(),
                                    error: Some(msg.clone()),
                                },
                            );
                            return Err(msg);
                        }
                    };
                    match ai_client_new.send_message_stream(messages, None).await {
                        Ok(resp) => resp,
                        Err(e2) => {
                            let msg = format!(
                                "Authentication required. Token refresh did not resolve the 401. (detail: {})",
                                e2
                            );
                            let _ = app.emit(
                                "acestep_llm_done",
                                AceStepLlmDoneEvent {
                                    session_id: session_id.clone(),
                                    full_text: String::new(),
                                    status: "error".to_string(),
                                    error: Some(msg.clone()),
                                },
                            );
                            return Err(msg);
                        }
                    }
                }
                Err(refresh_err) => {
                    let msg = format!(
                        "Authentication required. Please log in to Ai00-X first, then reopen the ACE-Step window. (detail: {} | refresh failed: {})",
                        err_str, refresh_err
                    );
                    let _ = app.emit(
                        "acestep_llm_done",
                        AceStepLlmDoneEvent {
                            session_id: session_id.clone(),
                            full_text: String::new(),
                            status: "error".to_string(),
                            error: Some(msg.clone()),
                        },
                    );
                    return Err(msg);
                }
            }
        }
    };

    let mut stream = stream_response.stream;
    let mut full_text = String::new();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                if let Some(text) = chunk.text {
                    if !text.is_empty() {
                        full_text.push_str(&text);
                        let _ = app.emit(
                            "acestep_llm_chunk",
                            AceStepLlmChunkEvent {
                                session_id: session_id.clone(),
                                delta: text,
                            },
                        );
                    }
                }
            }
            Err(e) => {
                let msg = format!("AI stream error: {}", e);
                let _ = app.emit(
                    "acestep_llm_done",
                    AceStepLlmDoneEvent {
                        session_id: session_id.clone(),
                        full_text: full_text.clone(),
                        status: "error".to_string(),
                        error: Some(msg.clone()),
                    },
                );
                return Err(msg);
            }
        }
    }

    let _ = app.emit(
        "acestep_llm_done",
        AceStepLlmDoneEvent {
            session_id: session_id.clone(),
            full_text: full_text.clone(),
            status: "ok".to_string(),
            error: None,
        },
    );

    Ok(AceStepLlmCompleteResponse { text: full_text })
}

// ---- Web search (for lyrics knowledge expansion) ----

/// A single web search result returned to the ACE-Step frontend.
#[derive(Debug, Clone, Serialize)]
pub struct AceStepSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Web search command for the ACE-Step lyrics advisor.
///
/// Reuses `ai00_x_core::agent::tools::WebSearchTool` (AnySearch primary,
/// SearXNG fallback) to gather background knowledge before drafting lyrics.
/// Called by the chat flow when the LLM emits `{"action":"search","query":"..."}`.
#[tauri::command]
pub async fn acestep_web_search(
    query: String,
    language: Option<String>,
    max_results: Option<usize>,
) -> Result<Vec<AceStepSearchResult>, String> {
    let lang = language.unwrap_or_else(|| "zh-CN".to_string());
    let limit = max_results.unwrap_or(8).min(10);

    log::info!(
        "[ACE-Step] Web search: query='{}', lang={}, limit={}",
        query,
        lang,
        limit
    );

    let tool = ai00_x_core::agent::tools::implementations::WebSearchTool::new();
    let items = tool
        .search_simple(&query, &lang, limit)
        .await
        .map_err(|e| format!("Web search failed: {}", e))?;

    let results: Vec<AceStepSearchResult> = items
        .iter()
        .map(|item| AceStepSearchResult {
            title: item.title.clone(),
            url: item.url.clone(),
            snippet: item.snippet.clone(),
        })
        .collect();

    log::info!(
        "[ACE-Step] Web search returned {} results for '{}'",
        results.len(),
        query
    );
    Ok(results)
}

// ---- Lyrics alignment (Qwen3-ForcedAligner-0.6B, pure Rust inference) ----

/// A single aligned word/character with timestamps (seconds).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedWord {
    pub text: String,
    pub start: f32,
    pub end: f32,
}

/// Request payload for `acestep_align_lyrics`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepAlignLyricsRequest {
    /// Path to the generated audio file (wav/mp3/flac).
    pub audio_path: String,
    /// Original lyrics text (with `\n` line breaks).
    pub lyrics: String,
    /// Language: "Chinese", "English", "Japanese", etc.
    pub language: Option<String>,
    /// Optional local model directory. If None, uses default models/asr/ dir.
    pub model_dir: Option<String>,
    /// Optional output directory for the LRC file. If None, uses audio dir.
    pub output_dir: Option<String>,
}

/// Result of `acestep_align_lyrics`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepAlignLyricsResult {
    /// Enhanced LRC-formatted lyrics string.
    ///
    /// Format: `[mm:ss.xx]<mm:ss.xx>word1<mm:ss.xx>word2...`
    /// - Line-level timestamp `[mm:ss.xx]` at the start of each line decides
    ///   when the line is shown.
    /// - Word/char-level timestamps `<mm:ss.xx>` before each word/char decide
    ///   per-word/per-char karaoke highlighting.
    /// - Players that don't understand `<...>` tags will ignore them and fall
    ///   back to plain line-by-line display.
    pub lrc: String,
    /// Path where the LRC file was saved (empty if save failed).
    pub lrc_path: String,
    /// Number of aligned word/character entries.
    pub word_count: usize,
    /// Number of LRC lines emitted.
    pub line_count: usize,
}

/// Resolve the ForcedAligner GGUF model path.
///
/// Search order:
/// 1. `model_dir` (if provided — can be a file path or directory).
/// 2. `<models_dir>/asr/qwen3-forced-aligner-*.gguf`.
pub fn resolve_aligner_gguf(model_dir: Option<&str>) -> Result<PathBuf, String> {
    use ai00_x_inference::runtime::get_models_dir;

    // 1. Caller-specified path.
    if let Some(dir) = model_dir {
        let dir_path = PathBuf::from(dir);
        if dir_path.is_file() {
            return Ok(dir_path);
        }
        if dir_path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&dir_path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                        if name.ends_with(".gguf") && name.contains("forced-aligner") {
                            return Ok(path);
                        }
                    }
                }
            }
        }
    }

    // 2. Default models/asr/ directory.
    let asr_dir = get_models_dir().join("asr");
    if asr_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&asr_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    if name.ends_with(".gguf") && name.contains("forced-aligner") {
                        return Ok(path);
                    }
                }
            }
        }
    }

    Err(format!(
        "Qwen3-ForcedAligner GGUF not found. Download to: {}\n\
         Recommended: OpenVoiceOS/qwen3-forced-aligner-0.6b-q8-0\n\
         Expected filename: qwen3-forced-aligner-0.6b-q8_0.gguf",
        asr_dir.display()
    ))
}

/// Format seconds as the inner part of an LRC timestamp (`mm:ss.xx`), shared
/// by line-level `[mm:ss.xx]` and word-level `<mm:ss.xx>` formatting.
fn format_lrc_time_inner(seconds: f32) -> String {
    let total_cs = (seconds.max(0.0) * 100.0).round() as u64;
    let mm = total_cs / 6000;
    let ss = (total_cs / 100) % 60;
    let cs = total_cs % 100;
    format!("{:02}:{:02}.{:02}", mm, ss, cs)
}

/// Format seconds as LRC line-level timestamp `[mm:ss.xx]`.
fn format_lrc_time(seconds: f32) -> String {
    format!("[{}]", format_lrc_time_inner(seconds))
}

/// Format seconds as LRC word/char-level timestamp `<mm:ss.xx>` (enhanced LRC).
fn format_lrc_word_time(seconds: f32) -> String {
    format!("<{}>", format_lrc_time_inner(seconds))
}

/// Remove pure-label lines from lyrics before alignment and LRC building.
///
/// Label lines are lines that consist entirely of a single `[...]` bracket
/// pair, such as `[Intro - bouncy piano]`, `[Verse 1]`, `[Chorus]`, etc.
/// These are structural markers, not singable lyrics — sending them to the
/// aligner wastes timestamp slots (each bracketed word becomes its own
/// entry) and the lone `-` inside `[Intro - bouncy piano]` is dropped by
/// the C++ `strip_word_punctuation`, which desyncs the LRC builder's
/// character matching.
///
/// LRC timestamp lines like `[00:14.72]Hello` are preserved (the bracket
/// doesn't span the whole line). A pure `[00:14.72]` line is also preserved
/// (inner content is all digits/`:`/`.`).
fn strip_label_lines(lyrics: &str) -> String {
    lyrics
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return true; // keep blank lines (section separators)
            }
            // Pure bracket pair: `[...]` spanning the whole line.
            if trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() >= 3 {
                let inner = &trimmed[1..trimmed.len() - 1];
                // If inner is only digits / ':' / '.', treat as LRC timestamp
                // and keep it; otherwise it's a label — drop it.
                let is_timestamp = inner
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == ':' || c == '.');
                return is_timestamp;
            }
            true
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Check if a char is punctuation/non-speech, mirroring the C++
/// `strip_word_punctuation` logic in forced_aligner.cpp:
///   - ASCII (<= 0x7F): punctuation if NOT alphanumeric
///   - Non-ASCII (> 0x7F): always kept (CJK, accented letters, …)
///
/// The C++ aligner skips pure-punctuation words entirely (e.g. a lone `-`
/// between two space-separated words), so the aligned entries never contain
/// a word whose only content is ASCII punctuation. The LRC builder must
/// therefore skip punctuation when matching lyrics characters to aligned
/// entry text — otherwise a single `-` in the lyrics would stall matching
/// and drop every subsequent line.
fn is_punctuation(ch: char) -> bool {
    let code = ch as u32;
    if code <= 0x7F {
        !ch.is_alphanumeric()
    } else {
        false
    }
}

/// Build enhanced LRC text from aligned words and original lyrics.
///
/// Enhanced LRC (a.k.a. word-by-word LRC) carries both line-level and
/// word/char-level timestamps in a single string:
///
/// ```text
/// [mm:ss.xx]<mm:ss.xx>word1<mm:ss.xx>word2<mm:ss.xx>word3
/// ```
///
/// - `[mm:ss.xx]` at line start decides when the line is shown.
/// - `<mm:ss.xx>` before each word/char decides per-word/per-char karaoke
///   highlighting.
/// - Players that don't understand `<...>` tags ignore them and fall back to
///   plain line-by-line display.
///
/// Walks the aligned entries in order, matching each entry's text to the
/// non-whitespace, non-punctuation characters of the original lyrics. Each
/// `\n`-separated line in the original gets one LRC line, timestamped at the
/// start of its first matched entry. Each matched entry contributes a
/// `<mm:ss.xx>entry.text` segment.
///
/// Punctuation is skipped on both sides (lyrics and entry text) to stay
/// aligned with the C++ aligner's `strip_word_punctuation` behavior — a
/// lyrics line like `[Intro - bouncy piano]` produces entries for
/// `[Intro`, `bouncy`, `piano]` (the lone `-` is dropped), so matching must
/// proceed over `Intro`, `bouncy`, `piano` only.
fn build_enhanced_lrc(aligned: &[AlignedWord], original_lyrics: &str) -> String {
    let lines: Vec<&str> = original_lyrics.split('\n').collect();
    let mut lrc = String::new();

    let mut entry_idx = 0usize;
    for line in &lines {
        let line_trimmed = line.trim();
        if line_trimmed.is_empty() {
            continue;
        }

        // Expected: non-whitespace AND non-punctuation chars (mirrors the C++
        // aligner, which strips ASCII punctuation from each word before BPE
        // encoding and skips pure-punctuation words entirely).
        let expected: Vec<char> = line_trimmed
            .chars()
            .filter(|c| !c.is_whitespace() && !is_punctuation(*c))
            .collect();

        let mut line_start: Option<f32> = None;
        let mut line_words: Vec<&AlignedWord> = Vec::new();
        let mut matched = 0usize;

        if !expected.is_empty() {
            while entry_idx < aligned.len() && matched < expected.len() {
                let entry = &aligned[entry_idx];
                if line_start.is_none() {
                    line_start = Some(entry.start);
                }

                // Track whether this entry contributed at least one matched
                // char — only then do we include it in line_words. This avoids
                // entries that are pure-punctuation (which can't happen given
                // the C++ aligner skips them, but be defensive) or entries
                // whose remaining chars don't match the current expected pos.
                let mut contributed = false;
                for ch in entry.text.chars() {
                    if is_punctuation(ch) {
                        continue;
                    }
                    if matched < expected.len() && ch == expected[matched] {
                        matched += 1;
                        contributed = true;
                    }
                }
                if contributed {
                    line_words.push(entry);
                }
                entry_idx += 1;
            }
        }

        // Emit the line if we found a start time. For pure-punctuation lines
        // (e.g. `---` separators) expected is empty, so we fall back to the
        // next available entry's start time and emit a plain (non-enhanced)
        // line with no word-level timestamps.
        if let Some(start) = line_start {
            lrc.push_str(&format_lrc_time(start));
            for w in &line_words {
                lrc.push_str(&format_lrc_word_time(w.start));
                lrc.push_str(&w.text);
            }
            lrc.push('\n');
        } else if expected.is_empty() && entry_idx < aligned.len() {
            let start = aligned[entry_idx].start;
            lrc.push_str(&format_lrc_time(start));
            lrc.push_str(line_trimmed);
            lrc.push('\n');
        }
    }

    lrc
}

/// Generate timestamped LRC lyrics for a generated song.
///
/// Pure-Rust pipeline:
/// 1. Resolve the Qwen3-ForcedAligner GGUF model file.
/// 2. Read audio + lyrics.
/// 3. Run the pure-Rust aligner (`asr::aligner`) — direct GGUF inference,
///    no Python, no ONNX, no external C++ tool.
/// 4. Group word/char timestamps into LRC lines using the original lyrics'
///    `\n` structure.
///
/// The aligner engine itself is implemented in `src/asr/aligner.rs`.
#[tauri::command]
pub async fn acestep_align_lyrics(
    _app: AppHandle,
    request: AceStepAlignLyricsRequest,
) -> Result<AceStepAlignLyricsResult, String> {
    // Validate audio file.
    let audio_path = Path::new(&request.audio_path);
    if !audio_path.exists() {
        return Err(format!("Audio file not found: {}", request.audio_path));
    }

    if request.lyrics.trim().is_empty() {
        return Err("Lyrics text is empty".to_string());
    }

    // Resolve ForcedAligner GGUF model path.
    let gguf_path = resolve_aligner_gguf(request.model_dir.as_deref())?;
    log::info!(
        "[ACE-Step] ForcedAligner GGUF: {} (audio={})",
        gguf_path.display(),
        request.audio_path
    );

    // Pre-process lyrics: drop pure-label lines like `[Intro - bouncy piano]`,
    // `[Verse 1]`, etc. These are structural markers, not singable lyrics —
    // keeping them would (a) waste aligner timestamp slots and (b) desync the
    // LRC builder because the C++ aligner drops lone `-` inside labels.
    let clean_lyrics = strip_label_lines(&request.lyrics);
    if clean_lyrics.trim().is_empty() {
        return Err(
            "Lyrics text is empty after stripping label lines (e.g. `[Intro ...]`)".to_string(),
        );
    }
    log::info!(
        "[ACE-Step] lyrics preprocessed: {} -> {} chars, {} -> {} non-empty lines",
        request.lyrics.len(),
        clean_lyrics.len(),
        request
            .lyrics
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count(),
        clean_lyrics
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count(),
    );

    // Spawn the pure-Rust aligner on a blocking thread (CPU/GPU heavy).
    let audio_path_owned = request.audio_path.clone();
    let lyrics_owned = clean_lyrics.clone();
    let lang = request.language.unwrap_or_else(|| "Chinese".to_string());
    let app_handle = _app.clone();
    let entries = tokio::task::spawn_blocking(move || {
        crate::asr::aligner::align_lyrics_with_progress(
            &gguf_path,
            &audio_path_owned,
            &lyrics_owned,
            &lang,
            std::sync::Arc::new(move |stage, progress, message| {
                let _ = app_handle.emit(
                    "acestep-align-progress",
                    serde_json::json!({
                        "stage": stage,
                        "progress": progress,
                        "message": message,
                    }),
                );
            }),
        )
    })
    .await
    .map_err(|e| format!("Aligner task panicked: {e}"))??;

    let aligned: Vec<AlignedWord> = entries
        .into_iter()
        .map(|e| AlignedWord {
            text: e.text,
            start: e.start,
            end: e.end,
        })
        .collect();

    if aligned.is_empty() {
        return Err("Alignment returned no word/character entries".to_string());
    }

    log::info!(
        "[ACE-Step] Alignment produced {} entries, building LRC...",
        aligned.len()
    );

    // Debug: dump first few aligned entries and the lyrics line structure so
    // we can verify the LRC builder is matching them correctly.
    {
        let preview: Vec<String> = aligned
            .iter()
            .take(8)
            .map(|w| format!("{:?}@{:.2}s", w.text, w.start))
            .collect();
        log::info!("[ACE-Step] aligned preview: {}", preview.join(", "));
        let lyrics_lines: Vec<&str> = clean_lyrics.split('\n').collect();
        let non_empty = lyrics_lines.iter().filter(|l| !l.trim().is_empty()).count();
        log::info!(
            "[ACE-Step] clean_lyrics: {} lines ({} non-empty), first 3: {:?}",
            lyrics_lines.len(),
            non_empty,
            &lyrics_lines[..lyrics_lines.len().min(3)]
        );
    }

    // Build enhanced LRC from the preprocessed lyrics (label lines already
    // stripped) so aligned entries map 1:1 to lyrics lines. Enhanced LRC
    // carries both line-level `[mm:ss.xx]` and word/char-level `<mm:ss.xx>`
    // timestamps in a single string — see `build_enhanced_lrc` for format.
    let lrc = build_enhanced_lrc(&aligned, &clean_lyrics);
    let line_count = lrc.lines().count();
    log::info!(
        "[ACE-Step] Enhanced LRC built: {} lines (from {} aligned entries)",
        line_count,
        aligned.len()
    );

    // Save LRC file next to the audio file (or in output_dir if provided).
    let audio_stem = audio_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output")
        .to_string();

    let lrc_dir: PathBuf = match &request.output_dir {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => audio_path.parent().unwrap_or(Path::new(".")).to_path_buf(),
    };

    let lrc_path = lrc_dir.join(format!("{}.lrc", audio_stem));
    let lrc_path_str = lrc_path.display().to_string();

    if let Err(e) = std::fs::create_dir_all(&lrc_dir) {
        log::warn!(
            "[ACE-Step] Failed to create LRC output dir {}: {}",
            lrc_dir.display(),
            e
        );
    }

    match std::fs::write(&lrc_path, &lrc) {
        Ok(()) => log::info!("[ACE-Step] LRC saved to {}", lrc_path.display()),
        Err(e) => log::warn!(
            "[ACE-Step] Failed to save LRC to {}: {} (returning content only)",
            lrc_path.display(),
            e
        ),
    }

    Ok(AceStepAlignLyricsResult {
        lrc,
        lrc_path: lrc_path_str,
        word_count: aligned.len(),
        line_count,
    })
}

// ---- Model download (independent, uses ai00-x's DownloadManager) ----

/// Download sources — full URL prefixes into our own unified model repo
/// (cgisky/ai00-x on HF, cgisky/Ai00-X on ModelScope). ACE-Step files live
/// under `acestep/` in the repo, same layout as the local models directory.
/// ModelScope serves from CN CDNs and goes first; hf-mirror / huggingface
/// are fallbacks (no third-party repo dependency).
///
/// Order is NOT fixed; `refresh_mirror_speeds()` sorts them by measured
/// latency before each download session.
const ACESTEP_MIRRORS: &[&str] = &[
    "https://modelscope.cn/models/cgisky/Ai00-X/resolve/master",
    "https://hf-mirror.com/cgisky/ai00-x/resolve/main",
    "https://huggingface.co/cgisky/ai00-x/resolve/main",
];

/// Cached mirror ranking (key = mirror base URL, value = latency in ms).
/// `u64::MAX` means unreachable. Refreshed by `pick_mirrors_by_speed()`.
static MIRROR_SPEEDS: Lazy<Mutex<Vec<(String, u64)>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Test all mirrors concurrently and cache the latency ranking.
///
/// Uses a HEAD request to a small file (`vae-BF16.gguf` — always present on
/// the repo) to measure round-trip time. Mirrors that fail or time out get
/// `u64::MAX` and are placed last.
async fn refresh_mirror_speeds() {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let test_file = "acestep/vae-BF16.gguf";
    let mut handles = Vec::new();

    for mirror in ACESTEP_MIRRORS {
        let mirror = mirror.to_string();
        let url = format!("{}/{}", mirror, test_file);
        let client = client.clone();

        handles.push(tokio::spawn(async move {
            let start = std::time::Instant::now();
            let result = client
                .head(&url)
                .timeout(std::time::Duration::from_secs(8))
                .send()
                .await;
            let elapsed = start.elapsed().as_millis() as u64;

            let latency = match result {
                Ok(resp) if resp.status().is_success() || resp.status().is_redirection() => {
                    log::info!("[AceStep] Mirror speed: {} = {}ms", mirror, elapsed);
                    elapsed
                }
                Ok(resp) => {
                    log::warn!(
                        "[AceStep] Mirror speed: {} = {}ms (status {} not ok)",
                        mirror,
                        elapsed,
                        resp.status()
                    );
                    u64::MAX
                }
                Err(e) => {
                    log::warn!("[AceStep] Mirror speed: {} FAILED: {}", mirror, e);
                    u64::MAX
                }
            };
            (mirror, latency)
        }));
    }

    let mut results = Vec::new();
    for handle in handles {
        if let Ok(pair) = handle.await {
            results.push(pair);
        }
    }

    // Sort by latency (fastest first; unreachable goes last).
    results.sort_by_key(|(_, lat)| *lat);

    let mut speeds = MIRROR_SPEEDS.lock().await;
    *speeds = results;
}

/// Return the download URLs for a filename, sorted by mirror latency
/// (fastest mirror first). Falls back to the static order if speed test
/// hasn't been run yet or all mirrors are unreachable.
async fn hf_urls_sorted(filename: &str) -> Vec<String> {
    let speeds = MIRROR_SPEEDS.lock().await;

    if speeds.is_empty() || speeds.iter().all(|(_, lat)| *lat == u64::MAX) {
        // No speed data or all unreachable — use static order.
        drop(speeds);
        return ACESTEP_MIRRORS
            .iter()
            .map(|m| format!("{}/acestep/{}", m, filename))
            .collect();
    }

    // Use cached ranking (fastest first), skip unreachable mirrors.
    speeds
        .iter()
        .filter(|(_, lat)| *lat != u64::MAX)
        .map(|(mirror, _)| format!("{}/acestep/{}", mirror, filename))
        .collect()
}

/// Extended catalog entry with download metadata.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AceStepCatalogEntry {
    /// Stable identifier used as the download task id.
    pub id: String,
    /// Filename on the HF repo (also the local filename).
    pub filename: String,
    /// Pipeline role: "lm" | "text_encoder" | "dit" | "vae".
    pub role: String,
    /// Human-readable variant label (e.g. "4B-Q8_0", "0.6B-Q8_0").
    pub variant: String,
    /// Approximate size in bytes (for display only).
    pub approx_size_bytes: u64,
    /// True when this is the recommended variant for its role.
    pub recommended: bool,
    /// DiT type: "base" (2B, 50 steps), "xl-base" (4B XL, 50 steps), "common" (LM/TE/VAE).
    pub dit_type: String,
    // ---- On-disk status ----
    /// Absolute local path if the file exists, empty string otherwise.
    pub local_path: String,
    /// True when the file exists on disk.
    pub exists: bool,
    /// File size in bytes (0 if not exists).
    pub local_size: u64,
}

/// The canonical ACE-Step model catalog.
///
/// Tuple: (id, filename, role, variant, approx_size_bytes, recommended, dit_type)
/// dit_type: "base" | "xl-base" | "common" — only DiT entries use "base"/"xl-base".
///
/// We only support the **base** model family because:
/// - base supports ALL tasks (text2music, lego, extract, complete)
/// - turbo does NOT support lego/extract/complete
/// - sft does NOT support lego/extract/complete either
/// - base has good quality (50 steps, with CFG, guidance_scale=7.0)
///
/// Four DiT variants: base Q5/Q8 (2B params) + XL base Q5/Q8 (4B params).
fn acestep_catalog() -> &'static [(
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    u64,
    bool,
    &'static str,
)] {
    &[
        // LM model is NOT included — the chat flow goes directly to DiT,
        // bypassing the ACE-Step LM. Users who want LM can download it manually.
        // ---- Text encoder (caption embedding) ----
        (
            "acestep-text-encoder",
            "Qwen3-Embedding-0.6B-Q8_0.gguf",
            "text_encoder",
            "Q8_0",
            748_000_000,
            true,
            "common",
        ),
        // ---- DiT - base (2B params, 50 steps, with CFG, ALL tasks) ----
        // Q5_K_M: smaller (~1.58GB), for ≤4GB VRAM.
        (
            "acestep-dit-base-q5",
            "acestep-v15-base-Q5_K_M.gguf",
            "dit",
            "base-Q5_K_M",
            1_700_140_160,
            false,
            "base",
        ),
        // Q8_0: standard quality (~2.37GB), recommended for ≥8GB VRAM.
        (
            "acestep-dit-base-q8",
            "acestep-v15-base-Q8_0.gguf",
            "dit",
            "base-Q8_0",
            2_549_527_936,
            true,
            "base",
        ),
        // ---- DiT - XL base (4B params, 50 steps, with CFG, ALL tasks) ----
        // XL models have higher quality but require ≥12GB VRAM.
        // Q5_K_M: (~3.29GB), recommended for ≥12GB VRAM.
        (
            "acestep-dit-xl-base-q5",
            "acestep-v15-xl-base-Q5_K_M.gguf",
            "dit",
            "xl-base-Q5_K_M",
            3_527_566_432,
            false,
            "xl-base",
        ),
        // Q8_0: highest quality (~4.94GB), for ≥16GB VRAM.
        (
            "acestep-dit-xl-base-q8",
            "acestep-v15-xl-base-Q8_0.gguf",
            "dit",
            "xl-base-Q8_0",
            5_305_828_704,
            false,
            "xl-base",
        ),
        // ---- VAE (latent -> waveform) ----
        (
            "acestep-vae",
            "vae-BF16.gguf",
            "vae",
            "BF16",
            322_000_000,
            true,
            "common",
        ),
    ]
}

/// Static download manager for ACE-Step model files.
static ACESTEP_DL_MGR: Lazy<crate::download_manager::DownloadManager> =
    Lazy::new(crate::download_manager::DownloadManager::new);

/// List the ACE-Step model catalog with on-disk presence.
#[tauri::command]
pub async fn acestep_list_catalog() -> Result<Vec<AceStepCatalogEntry>, String> {
    let models_dir = resolve_models_dir().join("acestep");
    let catalog = acestep_catalog();

    let entries: Vec<AceStepCatalogEntry> = catalog
        .iter()
        .map(
            |(id, filename, role, variant, approx_size, recommended, dit_type)| {
                let path = models_dir.join(filename);
                let local_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                // Consider a file "present" only when it is large enough to be a
                // complete model. A truncated download leaves a non-empty but
                // incomplete file that previously showed as "downloaded" in the
                // UI while actually being unusable.
                let exists = local_size >= *approx_size;
                AceStepCatalogEntry {
                    id: id.to_string(),
                    filename: filename.to_string(),
                    role: role.to_string(),
                    variant: variant.to_string(),
                    approx_size_bytes: *approx_size,
                    recommended: *recommended,
                    dit_type: dit_type.to_string(),
                    local_path: if exists {
                        path.display().to_string()
                    } else {
                        String::new()
                    },
                    exists,
                    local_size,
                }
            },
        )
        .collect();

    Ok(entries)
}

/// Download progress DTO (mirrors model_init::DownloadProgress).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AceStepDownloadProgress {
    pub task_id: String,
    pub status: String, // "Pending" | "Downloading" | "Completed" | "Failed"
    pub progress: u64,
    pub total: u64,
    pub error: Option<String>,
}

/// Start downloading a single ACE-Step model file by catalog id.
///
/// Before starting, refreshes mirror speed ranking so the fastest mirror
/// is tried first. Falls back to slower mirrors / static order on failure.
#[tauri::command]
pub async fn acestep_download_model(id: String) -> Result<String, String> {
    let catalog = acestep_catalog();
    let entry = catalog
        .iter()
        .find(|(eid, _, _, _, _, _, _)| eid == &id)
        .ok_or_else(|| format!("Unknown ACE-Step model id: {}", id))?;

    let (_, filename, _, _, approx_size, _, _) = entry;
    let save_dir = resolve_models_dir().join("acestep");
    std::fs::create_dir_all(&save_dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    let save_path = save_dir.join(filename);

    // Skip only if the file already exists AND looks complete. A truncated
    // file (e.g. from an interrupted download) must be re-downloaded; it was
    // previously treated as present because the check only required len > 0.
    if let Ok(meta) = std::fs::metadata(&save_path) {
        if meta.len() >= *approx_size {
            log::info!("[AceStep] Model already exists, skipping: {}", filename);
            return Ok(id);
        }
        log::warn!(
            "[AceStep] Existing file incomplete ({} bytes, expected {}), re-downloading: {}",
            meta.len(),
            approx_size,
            filename
        );
    }

    // Refresh mirror speeds before selecting download URL (network-adaptive).
    refresh_mirror_speeds().await;
    let urls = hf_urls_sorted(filename).await;

    log::info!(
        "[AceStep] Starting download: id={}, file={}, urls={:?}",
        id,
        filename,
        urls
    );

    ACESTEP_DL_MGR
        .start_with_fallback(id.clone(), urls, save_path)
        .await
        .map_err(|e| format!("Failed to start download: {}", e))?;

    Ok(id)
}

/// Start downloading all recommended ACE-Step model files.
///
/// Refreshes mirror speeds once at the start, then uses the cached ranking
/// for all subsequent file downloads in this batch.
#[tauri::command]
pub async fn acestep_download_all_recommended() -> Result<Vec<String>, String> {
    // Test mirror speeds once for the whole batch.
    refresh_mirror_speeds().await;

    let catalog = acestep_catalog();
    let mut started: Vec<String> = Vec::new();
    let mut seen_roles: std::collections::HashSet<&str> = std::collections::HashSet::new();

    for (id, filename, role, _variant, size, recommended, _dit_type) in catalog.iter() {
        if !recommended || !seen_roles.insert(role) {
            continue;
        }
        // Skip only if already exists AND looks complete (see download_model).
        let path = resolve_models_dir().join("acestep").join(filename);
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() >= *size {
                continue;
            }
            log::warn!(
                "[AceStep] Batch: existing file incomplete ({} bytes, expected {}), re-downloading: {}",
                meta.len(),
                size,
                filename
            );
        }

        let urls = hf_urls_sorted(filename).await;
        log::info!("[AceStep] Batch download: id={}, file={}", id, filename);

        match ACESTEP_DL_MGR
            .start_with_fallback(id.to_string(), urls, path)
            .await
        {
            Ok(()) => started.push(id.to_string()),
            Err(e) => log::warn!("[AceStep] Failed to start download for {}: {}", id, e),
        }
    }

    Ok(started)
}

/// Test mirror speeds and return the ranking (for UI display).
///
/// Returns a list of `{ mirror, latencyMs }` objects sorted fastest-first.
/// `latencyMs = null` means the mirror is unreachable.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepMirrorSpeed {
    pub mirror: String,
    pub latency_ms: Option<u64>,
}

#[tauri::command]
pub async fn acestep_test_mirrors() -> Result<Vec<AceStepMirrorSpeed>, String> {
    refresh_mirror_speeds().await;
    let speeds = MIRROR_SPEEDS.lock().await;
    Ok(speeds
        .iter()
        .map(|(mirror, lat)| AceStepMirrorSpeed {
            mirror: mirror.clone(),
            latency_ms: if *lat == u64::MAX { None } else { Some(*lat) },
        })
        .collect())
}

/// Query the download progress for a given task id.
#[tauri::command]
pub async fn acestep_get_download_progress(
    task_id: String,
) -> Result<Option<AceStepDownloadProgress>, String> {
    let task = ACESTEP_DL_MGR.progress(&task_id).await;
    match task {
        Some(t) => {
            let status_str = match t.status {
                crate::download_manager::DownloadStatus::Pending => "Pending",
                crate::download_manager::DownloadStatus::Downloading => "Downloading",
                crate::download_manager::DownloadStatus::Paused => "Paused",
                crate::download_manager::DownloadStatus::Completed => "Completed",
                crate::download_manager::DownloadStatus::Failed => "Failed",
            };
            Ok(Some(AceStepDownloadProgress {
                task_id: t.id,
                status: status_str.to_string(),
                progress: t.progress,
                total: t.total.unwrap_or(0),
                error: t.error,
            }))
        }
        None => Ok(None),
    }
}

// ============================================================================
// GPU detection
// ============================================================================

/// GPU info detected on the user's machine.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepGpuInfo {
    /// GPU name (e.g. "NVIDIA GeForce RTX 3060") or null if unavailable.
    pub gpu_name: Option<String>,
    /// Total VRAM in MB, or null if unavailable.
    pub vram_mb: Option<u64>,
    /// Backend hint: "cuda" if nvidia-smi succeeded, otherwise "unknown".
    pub backend: Option<String>,
}

/// Detect NVIDIA GPU name and VRAM via `nvidia-smi`.
///
/// Runs the query with a 5-second timeout. On any failure (binary not found,
/// non-zero exit, parse error, timeout) returns an `AceStepGpuInfo` with all
/// fields set to `None` so the frontend can fall back to manual selection.
#[tauri::command]
pub async fn acestep_get_gpu_info() -> Result<AceStepGpuInfo, String> {
    let mut cmd = tokio::process::Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=memory.total,name",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(target_os = "windows")]
    {
        // nvidia-smi is a console binary; without this flag each query
        // flashes a terminal window on the desktop. (tokio's Command provides
        // creation_flags as an inherent method on Windows.)
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output()).await;

    let output = match output {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            log::info!("[AceStep] nvidia-smi not available: {}", e);
            return Ok(AceStepGpuInfo {
                gpu_name: None,
                vram_mb: None,
                backend: None,
            });
        }
        Err(_) => {
            log::info!("[AceStep] nvidia-smi timed out");
            return Ok(AceStepGpuInfo {
                gpu_name: None,
                vram_mb: None,
                backend: None,
            });
        }
    };

    if !output.status.success() {
        log::info!("[AceStep] nvidia-smi exit code {:?}", output.status.code());
        return Ok(AceStepGpuInfo {
            gpu_name: None,
            vram_mb: None,
            backend: None,
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next().unwrap_or("").trim();
    // Expected format: "12288, NVIDIA GeForce RTX 3060"
    let parts: Vec<&str> = line.splitn(2, ',').map(|s| s.trim()).collect();
    if parts.len() != 2 {
        log::info!("[AceStep] nvidia-smi unexpected output: {:?}", line);
        return Ok(AceStepGpuInfo {
            gpu_name: None,
            vram_mb: None,
            backend: None,
        });
    }

    let vram_mb = parts[0].parse::<u64>().ok();
    let gpu_name = Some(parts[1].to_string());
    log::info!(
        "[AceStep] GPU detected: {} ({} MB)",
        gpu_name.as_deref().unwrap_or("?"),
        vram_mb.unwrap_or(0)
    );

    Ok(AceStepGpuInfo {
        gpu_name,
        vram_mb,
        backend: Some("cuda".to_string()),
    })
}

// ============================================================================
// Presets — functionality × quantification bundles
// ============================================================================

/// Task flag bits used by presets to declare supported tasks.
const TASK_TEXT2MUSIC: u32 = 1 << 0;
const TASK_COVER: u32 = 1 << 1;
const TASK_REPAINT: u32 = 1 << 2;
const TASK_LEGO: u32 = 1 << 3;
const TASK_EXTRACT: u32 = 1 << 4;
const TASK_COMPLETE: u32 = 1 << 5;

/// Static preset definition (compile-time data).
struct AceStepPresetDef {
    id: &'static str,
    /// "small" or "large" — coarse tier for UI grouping.
    tier: &'static str,
    /// Always "base" — the only supported DiT type.
    dit_type: &'static str,
    /// Sum of approx_size_bytes across all model files in the preset.
    total_size_bytes: u64,
    /// Recommended minimum VRAM in MB.
    recommended_vram_mb: u64,
    /// Number of denoising steps (always 50 for base).
    inference_steps: u32,
    /// Bitmask of TASK_* constants.
    supported_tasks: u32,
    /// Catalog ids that make up this preset.
    model_ids: &'static [&'static str],
}

/// The canonical preset list.
///
/// We only support the **base** DiT model family (supports ALL tasks including
/// lego/extract/complete). Four presets based on model size + quantization:
/// - `base-q5`: 2B base Q5_K_M (~2.77GB total), ≥4GB VRAM.
/// - `base-q8`: 2B base Q8_0 (~3.62GB total), ≥8GB VRAM. [recommended]
/// - `xl-base-q5`: 4B XL base Q5_K_M (~4.60GB total), ≥12GB VRAM.
/// - `xl-base-q8`: 4B XL base Q8_0 (~6.38GB total), ≥16GB VRAM.
fn acestep_presets() -> &'static [AceStepPresetDef] {
    const ALL_TASKS: u32 =
        TASK_TEXT2MUSIC | TASK_COVER | TASK_REPAINT | TASK_LEGO | TASK_EXTRACT | TASK_COMPLETE;
    &[
        AceStepPresetDef {
            id: "base-q5",
            tier: "small",
            dit_type: "base",
            total_size_bytes: 2_770_140_160,
            recommended_vram_mb: 4_096,
            inference_steps: 50,
            supported_tasks: ALL_TASKS,
            model_ids: &["acestep-text-encoder", "acestep-dit-base-q5", "acestep-vae"],
        },
        AceStepPresetDef {
            id: "base-q8",
            tier: "small",
            dit_type: "base",
            total_size_bytes: 3_619_527_936,
            recommended_vram_mb: 8_192,
            inference_steps: 50,
            supported_tasks: ALL_TASKS,
            model_ids: &["acestep-text-encoder", "acestep-dit-base-q8", "acestep-vae"],
        },
        AceStepPresetDef {
            id: "xl-base-q5",
            tier: "large",
            dit_type: "xl-base",
            total_size_bytes: 4_597_566_432,
            recommended_vram_mb: 12_288,
            inference_steps: 50,
            supported_tasks: ALL_TASKS,
            model_ids: &[
                "acestep-text-encoder",
                "acestep-dit-xl-base-q5",
                "acestep-vae",
            ],
        },
        AceStepPresetDef {
            id: "xl-base-q8",
            tier: "large",
            dit_type: "xl-base",
            total_size_bytes: 6_375_828_704,
            recommended_vram_mb: 16_384,
            inference_steps: 50,
            supported_tasks: ALL_TASKS,
            model_ids: &[
                "acestep-text-encoder",
                "acestep-dit-xl-base-q8",
                "acestep-vae",
            ],
        },
    ]
}

/// Convert a task bitmask to a sorted vector of task name strings.
fn task_mask_to_names(mask: u32) -> Vec<String> {
    let mut names = Vec::new();
    if mask & TASK_TEXT2MUSIC != 0 {
        names.push("text2music".to_string());
    }
    if mask & TASK_COVER != 0 {
        names.push("cover".to_string());
    }
    if mask & TASK_REPAINT != 0 {
        names.push("repaint".to_string());
    }
    if mask & TASK_LEGO != 0 {
        names.push("lego".to_string());
    }
    if mask & TASK_EXTRACT != 0 {
        names.push("extract".to_string());
    }
    if mask & TASK_COMPLETE != 0 {
        names.push("complete".to_string());
    }
    names
}

/// Preset DTO returned to the frontend, including on-disk download status.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepPreset {
    pub id: String,
    pub tier: String,
    pub dit_type: String,
    pub total_size_bytes: u64,
    pub recommended_vram_mb: u64,
    pub inference_steps: u32,
    pub supported_tasks: Vec<String>,
    pub model_ids: Vec<String>,
    /// Count of model files in this preset that already exist on disk.
    pub downloaded_count: u32,
    /// Total number of model files in this preset.
    pub total_count: u32,
}

/// List the preset bundles with their current download status.
///
/// For each preset, counts how many of its `model_ids` are already present
/// on disk so the UI can show "3/4 files" or "Ready" badges.
#[tauri::command]
pub async fn acestep_get_presets() -> Result<Vec<AceStepPreset>, String> {
    let catalog = acestep_catalog();
    let models_dir = resolve_models_dir().join("acestep");

    let presets: Vec<AceStepPreset> = acestep_presets()
        .iter()
        .map(|p| {
            let mut downloaded = 0u32;
            for mid in p.model_ids {
                if let Some((_, filename, _, _, _, _, _)) =
                    catalog.iter().find(|(cid, _, _, _, _, _, _)| cid == mid)
                {
                    let path = models_dir.join(filename);
                    if std::fs::metadata(&path)
                        .map(|m| m.len() > 0)
                        .unwrap_or(false)
                    {
                        downloaded += 1;
                    }
                }
            }
            AceStepPreset {
                id: p.id.to_string(),
                tier: p.tier.to_string(),
                dit_type: p.dit_type.to_string(),
                total_size_bytes: p.total_size_bytes,
                recommended_vram_mb: p.recommended_vram_mb,
                inference_steps: p.inference_steps,
                supported_tasks: task_mask_to_names(p.supported_tasks),
                model_ids: p.model_ids.iter().map(|s| s.to_string()).collect(),
                downloaded_count: downloaded,
                total_count: p.model_ids.len() as u32,
            }
        })
        .collect();

    Ok(presets)
}

/// Start downloading all model files for a preset.
///
/// Refreshes mirror speeds once at the start, then iterates the preset's
/// `model_ids`, skipping any file that already exists on disk. Returns the
/// list of download task ids that were actually started (skipped files are
/// not included).
#[tauri::command]
pub async fn acestep_download_preset(preset_id: String) -> Result<Vec<String>, String> {
    let preset = acestep_presets()
        .iter()
        .find(|p| p.id == preset_id)
        .ok_or_else(|| format!("Unknown ACE-Step preset id: {}", preset_id))?;

    let catalog = acestep_catalog();
    let save_dir = resolve_models_dir().join("acestep");
    std::fs::create_dir_all(&save_dir).map_err(|e| format!("Failed to create dir: {}", e))?;

    // One mirror speed refresh for the whole batch.
    refresh_mirror_speeds().await;

    let mut started: Vec<String> = Vec::new();
    for mid in preset.model_ids {
        let (id, filename, _, _, size, _, _) = catalog
            .iter()
            .find(|(cid, _, _, _, _, _, _)| cid == mid)
            .ok_or_else(|| format!("Catalog id '{}' not found in catalog", mid))?;

        let save_path = save_dir.join(filename);

        // Skip only if already exists AND looks complete (see download_model).
        if let Ok(meta) = std::fs::metadata(&save_path) {
            if meta.len() >= *size {
                log::info!(
                    "[AceStep] Preset '{}': skipping existing {}",
                    preset_id,
                    filename
                );
                continue;
            }
            log::warn!(
                "[AceStep] Preset '{}': existing file incomplete ({} bytes, expected {}), re-downloading: {}",
                preset_id,
                meta.len(),
                size,
                filename
            );
        }

        let urls = hf_urls_sorted(filename).await;
        log::info!(
            "[AceStep] Preset '{}': starting download id={}, file={}",
            preset_id,
            id,
            filename
        );

        match ACESTEP_DL_MGR
            .start_with_fallback(id.to_string(), urls, save_path)
            .await
        {
            Ok(()) => started.push(id.to_string()),
            Err(e) => log::warn!("[AceStep] Failed to start download for {}: {}", id, e),
        }
    }

    // The ASR forced aligner is a companion of ACE-Step (audio-text alignment
    // for lego/repaint tasks) — fetch it together with the preset. Best
    // effort: a failure here must not fail the preset download.
    if let Err(e) = crate::api::asr_api::ensure_aligner_downloaded().await {
        log::warn!("[AceStep] Companion aligner download failed: {}", e);
    }

    Ok(started)
}

// ===========================================================================
// Session persistence (chat history + creation plan + audio outputs)
// ===========================================================================

/// Resolve the session storage directory: `{RUNTIME_DIR}/acestep-sessions/`.
fn resolve_sessions_dir() -> PathBuf {
    get_runtime_dir().join("acestep-sessions")
}

/// Lightweight session metadata for list views (no message bodies).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AceStepSessionMeta {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Default session mode for old sessions without the `mode` field.
fn default_session_mode() -> String {
    "text2music".to_string()
}

/// Full session data persisted as JSON on disk.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AceStepSessionData {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// `ChatMessage[]` as opaque JSON (frontend owns the schema).
    pub chat_messages: serde_json::Value,
    /// `CreationPlan | null` as opaque JSON.
    pub creation_plan: Option<serde_json::Value>,
    /// `GeneratedAudio[]` as opaque JSON.
    pub outputs: serde_json::Value,
    /// Session mode: "text2music" | "lego". Defaults to "text2music" for old sessions.
    #[serde(default = "default_session_mode")]
    pub mode: String,
    /// `LegoFlowState | null` as opaque JSON.
    #[serde(default)]
    pub lego_state: Option<serde_json::Value>,
}

/// List all persisted sessions (metadata only — no message bodies).
#[tauri::command]
pub async fn acestep_session_list() -> Result<Vec<AceStepSessionMeta>, String> {
    let dir = resolve_sessions_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut metas = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read_dir failed: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let data = match std::fs::read_to_string(&path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        if let Ok(session) = serde_json::from_str::<AceStepSessionData>(&data) {
            metas.push(AceStepSessionMeta {
                id: session.id,
                title: session.title,
                created_at: session.created_at,
                updated_at: session.updated_at,
            });
        }
    }
    // Newest first.
    metas.sort_by_key(|m| std::cmp::Reverse(m.updated_at));
    Ok(metas)
}

/// Load a single session's full data by id.
#[tauri::command]
pub async fn acestep_session_load(id: String) -> Result<AceStepSessionData, String> {
    let path = resolve_sessions_dir().join(format!("{}.json", id));
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read session {}: {}", id, e))?;
    serde_json::from_str::<AceStepSessionData>(&data)
        .map_err(|e| format!("Failed to parse session {}: {}", id, e))
}

/// Save (create or overwrite) a session.
#[tauri::command]
pub async fn acestep_session_save(session: AceStepSessionData) -> Result<(), String> {
    let dir = resolve_sessions_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
    let path = dir.join(format!("{}.json", session.id));
    let json = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("Failed to serialize session {}: {}", session.id, e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write session: {}", e))?;
    log::info!("[AceStep] Session '{}' saved", session.id);
    Ok(())
}

/// Delete a session by id.
#[tauri::command]
pub async fn acestep_session_delete(id: String) -> Result<(), String> {
    let path = resolve_sessions_dir().join(format!("{}.json", id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete session: {}", e))?;
        log::info!("[AceStep] Session '{}' deleted", id);
    }
    Ok(())
}

// ===========================================================================
// .a00m package format (Ai00 Music)
//
// Bundles a generated song with its full creation context into a single ZIP
// container. Audio is encoded from WAV (32bit float, acestep_generate output)
// to FLAC (16bit PCM, lossless) using the pure-Rust `flacenc` crate. The
// original WAV on disk is left untouched.
//
// Archive layout (v1.0.0):
//   manifest.json, song.json, audio.flac, lyrics.lrc,
//   creation/{request,plan,lego_state}.json, chat.json
// ===========================================================================

/// Package a song into a `.a00m` archive.
///
/// Reads the source WAV (from `acestep_generate` output), encodes to FLAC
/// lossless 16bit PCM, then bundles with lyrics, creation context, and
/// metadata into a ZIP container.
#[tauri::command]
pub async fn acestep_package_song(
    mut request: acestep::package::PackageSongRequest,
) -> Result<acestep::package::PackageSongResult, String> {
    // v1.3.0+: generate embedding from tags + title + genre before packaging.
    // EmbeddingService runs on the desktop side (model2vec 256-dim).
    if request.embedding.is_none() {
        // Pre-generate tags if not provided, so embedding can use them.
        let tags = if let Some(t) = request.song.tags.as_ref() {
            t.clone()
        } else {
            acestep::package::generate_song_tags(
                request.creation_request.as_ref(),
                &request.song.title,
                request.song.artist.as_deref().unwrap_or(""),
                request.song.genre.as_deref().unwrap_or(""),
                0.0, // duration unknown yet, will be filled by package_song
            )
        };

        if !tags.is_empty() {
            let combined = format!(
                "{} {} {} {}",
                request.song.title,
                request.song.artist.as_deref().unwrap_or(""),
                request.song.genre.as_deref().unwrap_or(""),
                tags.join(" ")
            );
            match crate::embedding::embed_text(&combined) {
                Ok(emb) => {
                    request.embedding = Some(emb);
                    log::info!(
                        "[acestep] Generated embedding for song ({} tags)",
                        tags.len()
                    );
                }
                Err(e) => {
                    log::warn!("[acestep] Failed to generate embedding: {}", e.0);
                    // Continue without embedding — song.json will omit the field.
                }
            }
        }
    }

    // spawn_blocking: WAV read + FLAC encode + ZIP write are all CPU/IO heavy.
    tokio::task::spawn_blocking(move || {
        acestep::package::package_song(request).map_err(|e| format!("Failed to package song: {e}"))
    })
    .await
    .map_err(|e| format!("Package task panicked: {e}"))?
}

/// Unpack a `.a00m` archive to a directory.
///
/// If `outputDir` is null, defaults to `<archive_stem>/` next to the archive.
/// Returns the parsed manifest, song metadata, and creation context. Audio is
/// extracted to disk; small JSON files are loaded into memory.
///
/// `password` is required when the archive is a v1.2.0+ encrypted container
/// (magic `A00M`). For standard ZIP archives it is ignored.
#[tauri::command]
pub async fn acestep_unpack_song(
    path: String,
    output_dir: Option<String>,
    password: Option<String>,
) -> Result<acestep::package::UnpackedSong, String> {
    tokio::task::spawn_blocking(move || {
        let archive = std::path::Path::new(&path);
        let out = output_dir.map(std::path::PathBuf::from);
        acestep::package::unpack_song(archive, out.as_deref(), password.as_deref())
            .map_err(|e| format!("Failed to unpack song: {e}"))
    })
    .await
    .map_err(|e| format!("Unpack task panicked: {e}"))?
}

/// Read only the metadata (manifest + song.json) from a `.a00m` archive
/// without extracting the audio. Fast path for previewing a song library.
///
/// For v1.2.0+ encrypted containers, returns an error containing
/// "password required" — frontend should detect this and re-call
/// `acestep_read_song_meta_with_password` (or pre-check with
/// `acestep_is_archive_encrypted`).
#[tauri::command]
pub async fn acestep_read_song_meta(path: String) -> Result<acestep::package::SongMeta, String> {
    tokio::task::spawn_blocking(move || {
        let archive = std::path::Path::new(&path);
        acestep::package::read_song_meta(archive)
            .map(|(_, song)| song)
            .map_err(|e| format!("Failed to read song meta: {e}"))
    })
    .await
    .map_err(|e| format!("Read meta task panicked: {e}"))?
}

/// Read metadata from a possibly-encrypted `.a00m` archive. Same as
/// `acestep_read_song_meta` but accepts a `password` for v1.2.0+ encrypted
/// containers.
#[tauri::command]
pub async fn acestep_read_song_meta_with_password(
    path: String,
    password: Option<String>,
) -> Result<acestep::package::SongMeta, String> {
    tokio::task::spawn_blocking(move || {
        let archive = std::path::Path::new(&path);
        acestep::package::read_song_meta_with_password(archive, password.as_deref())
            .map(|(_, song)| song)
            .map_err(|e| format!("Failed to read song meta: {e}"))
    })
    .await
    .map_err(|e| format!("Read meta task panicked: {e}"))?
}

/// Check whether a `.a00m` archive is a v1.2.0+ encrypted container
/// (magic `A00M`). Returns `false` for standard ZIP archives.
#[tauri::command]
pub async fn acestep_is_archive_encrypted(path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let archive = std::path::Path::new(&path);
        Ok(acestep::package::is_archive_encrypted(archive))
    })
    .await
    .map_err(|e| format!("Is-encrypted task panicked: {e}"))?
}

/// Return the default songs output directory (`<exe_dir>/data/songs/`),
/// creating it if missing. Used by the PackageDialog to prefill the
/// output directory input.
#[tauri::command]
pub async fn acestep_get_songs_dir() -> Result<String, String> {
    let pm = ai00_x_core::infrastructure::get_path_manager_arc();
    let dir = pm.songs_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create songs dir: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// List every `.a00m` file in the songs directory.
///
/// Returns one [`SongEntry`] per file, sorted newest-first by mtime. Each
/// entry carries filesystem info (size / mtime / encryption flag); for
/// unencrypted archives the parsed `song.json` metadata is attached. Encrypted
/// archives return `meta = null` — the frontend must prompt for a password
/// and call `acestep_read_song_meta_with_password` to view their metadata.
#[tauri::command]
pub async fn acestep_list_songs() -> Result<Vec<acestep::package::SongEntry>, String> {
    let pm = ai00_x_core::infrastructure::get_path_manager_arc();
    let dir = pm.songs_dir();
    tokio::task::spawn_blocking(move || {
        acestep::package::list_songs(&dir).map_err(|e| format!("Failed to list songs: {e}"))
    })
    .await
    .map_err(|e| format!("List songs task panicked: {e}"))?
}

/// Delete a `.a00m` file from the songs directory, together with its unpack
/// cache directory (`<songs_dir>/.cache/<stem>`).
///
/// Safety: only files *directly inside* the songs directory with the `.a00m`
/// extension may be deleted — path traversal, subdirectories and foreign
/// paths are refused. The cache cleanup is best-effort (a locked file while
/// the song is playing only logs a warning).
#[tauri::command]
pub async fn acestep_delete_song(path: String) -> Result<(), String> {
    let pm = ai00_x_core::infrastructure::get_path_manager_arc();
    let songs_dir = pm.songs_dir();
    tokio::task::spawn_blocking(move || {
        let target = std::path::Path::new(&path);

        // Extension must be .a00m
        let is_a00m = target
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case("a00m"))
            .unwrap_or(false);
        if !is_a00m {
            return Err(format!("Not a .a00m file: {path}"));
        }

        // Must live directly inside songs_dir (canonicalized comparison).
        let parent = target
            .parent()
            .ok_or_else(|| format!("Invalid path: {path}"))?;
        let canon_parent = parent
            .canonicalize()
            .map_err(|e| format!("Failed to resolve parent dir: {e}"))?;
        let canon_songs = songs_dir
            .canonicalize()
            .map_err(|e| format!("Failed to resolve songs dir: {e}"))?;
        if canon_parent != canon_songs {
            return Err(format!("Refusing to delete file outside songs dir: {path}"));
        }

        std::fs::remove_file(target).map_err(|e| format!("Failed to delete song: {e}"))?;

        // Best-effort cache cleanup (`<songs_dir>/.cache/<stem>`).
        if let Some(stem) = target.file_stem() {
            let cache_dir = canon_songs.join(".cache").join(stem);
            if cache_dir.exists() {
                if let Err(e) = std::fs::remove_dir_all(&cache_dir) {
                    log::warn!(
                        "[acestep] failed to clean cache dir {}: {}",
                        cache_dir.display(),
                        e
                    );
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Delete song task panicked: {e}"))?
}

/// Extract just the cover image from a `.a00m` archive into `output_dir`,
/// returning the absolute path to the written cover file (or `null` when the
/// archive has no cover).
///
/// Fast path for library thumbnails: skips the (much larger) FLAC audio.
/// For encrypted v1.2.0+ containers, `password` must be non-empty.
///
/// When `password` is `None`, the current version's fixed password
/// (`passwords::current_password()`) is used automatically. This lets the
/// library view extract covers from auto-encrypted `.a00m` files without
/// exposing the password to the frontend.
#[tauri::command]
pub async fn acestep_extract_cover(
    path: String,
    output_dir: String,
    password: Option<String>,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let archive = std::path::Path::new(&path);
        let out = std::path::Path::new(&output_dir);
        // Fall back to the current version's password for locally-packaged
        // auto-encrypted archives. Unencrypted archives ignore the password.
        let pw = password.unwrap_or_else(|| {
            String::from_utf8_lossy(acestep::passwords::current_password()).to_string()
        });
        acestep::package::extract_cover(archive, out, Some(&pw))
            .map_err(|e| format!("Failed to extract cover: {e}"))
    })
    .await
    .map_err(|e| format!("Extract cover task panicked: {e}"))?
}

/// Score a generated song's audio quality via pure-Rust signal analysis.
///
/// Reads the WAV file at `audio_path` and computes 5 objective quality
/// metrics (loudness, dynamic range, clipping, tempo stability, spectral
/// balance) plus a weighted overall score.
#[tauri::command]
pub async fn acestep_score_song(audio_path: String) -> Result<acestep::scoring::SongScore, String> {
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&audio_path);
        acestep::scoring::score_audio(path).map_err(|e| format!("Scoring failed: {e}"))
    })
    .await
    .map_err(|e| format!("Score song task panicked: {e}"))?
}

// ===========================================================================
// v0x51 chunked encryption inspection / streaming commands
// ===========================================================================

/// DTO for a single block index entry (mirrors
/// [`acestep::chunked_crypto::BlockIndexEntry`]).
///
/// `nonce` and `block_aad_hash` are base64-encoded because they are small
/// fixed-length byte arrays (12 bytes each) — base64 keeps the JSON payload
/// compact and human-readable during debugging.
#[derive(Debug, Clone, Serialize)]
pub struct BlockIndexEntryDto {
    /// Absolute offset of this block's ciphertext (excluding the 16-byte tag)
    /// within the A00MPayload ciphertext region.
    pub offset: u32,
    /// Ciphertext length in bytes (excluding the 16-byte tag).
    pub length: u32,
    /// Algorithm ID (1 = AES-256-GCM, 2 = ChaCha20-Poly1305).
    pub algo_id: u8,
    /// Key ID (= password_version, redundant for diagnostics).
    pub key_id: u8,
    /// Flag bits. Bit 0 = is_decoy.
    pub flags: u8,
    /// Whether this block is a decoy (random ciphertext, undecryptable).
    pub is_decoy: bool,
    /// Base64-encoded per-block random nonce (12 bytes).
    pub nonce_base64: String,
    /// Base64-encoded truncated SHA-256 used as part of the AAD (12 bytes).
    pub block_aad_hash_base64: String,
}

impl From<&acestep::chunked_crypto::BlockIndexEntry> for BlockIndexEntryDto {
    fn from(e: &acestep::chunked_crypto::BlockIndexEntry) -> Self {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        Self {
            offset: e.offset,
            length: e.length,
            algo_id: e.algo_id,
            key_id: e.key_id,
            flags: e.flags,
            is_decoy: e.is_decoy(),
            nonce_base64: STANDARD.encode(e.nonce),
            block_aad_hash_base64: STANDARD.encode(e.block_aad_hash),
        }
    }
}

/// DTO for the chunk index of a v0x51 shareable FLAC file.
#[derive(Debug, Clone, Serialize)]
pub struct ChunkIndexDto {
    pub chunk_size: u32,
    pub block_count: u32,
    pub real_block_count: u32,
    pub decoy_ratio_permil: u16,
    pub entries: Vec<BlockIndexEntryDto>,
}

impl From<&acestep::chunked_crypto::ChunkIndex> for ChunkIndexDto {
    fn from(idx: &acestep::chunked_crypto::ChunkIndex) -> Self {
        Self {
            chunk_size: idx.chunk_size,
            block_count: idx.block_count,
            real_block_count: idx.real_block_count,
            decoy_ratio_permil: idx.decoy_ratio_permil,
            entries: idx.entries.iter().map(BlockIndexEntryDto::from).collect(),
        }
    }
}

/// Read the chunk index from a v0x51 shareable FLAC file (`.flac` produced by
/// `write_flac_preview_container_chunked`).
///
/// Returns `Ok(None)` when:
/// - The file has no A00X APPLICATION block.
/// - The file is v0x50 (uses whole-file AES-256 ZIP, no chunk index).
///
/// Frontend uses this to plan streaming downloads: the index tells the client
/// which blocks are real vs decoy and their byte offsets in the ciphertext
/// region (used to compute HTTP Range headers for Phase D/E).
#[tauri::command]
pub async fn acestep_read_chunk_index(path: String) -> Result<Option<ChunkIndexDto>, String> {
    tokio::task::spawn_blocking(move || {
        let flac_bytes =
            std::fs::read(&path).map_err(|e| format!("Failed to read FLAC file '{path}': {e}"))?;
        acestep::flac_container::read_chunk_index(&flac_bytes)
            .map(|opt| opt.as_ref().map(ChunkIndexDto::from))
            .map_err(|e| format!("Failed to read chunk index: {e}"))
    })
    .await
    .map_err(|e| format!("Read chunk index task panicked: {e}"))?
}

/// Decrypt a contiguous range of real blocks `[block_start..=block_end]` from
/// a v0x51 shareable FLAC file.
///
/// `block_start` and `block_end` are **real-block indices** (0-based, ignoring
/// decoy blocks). `block_end` is inclusive.
///
/// Returns the decrypted bytes as a **base64-encoded string** (Tauri IPC does
/// not efficiently transport large `Vec<u8>`; base64 keeps the JSON payload
/// self-contained for testing and small ranges. For full-song streaming, the
/// frontend should call this multiple times with smaller ranges or use the
/// future Phase D streaming proxy endpoint).
///
/// # Errors
///
/// Returns an error string when:
/// - The file path cannot be read.
/// - The file has no A00X APPLICATION block.
/// - The file is v0x50 (no chunked encryption).
/// - The block range is empty or out of bounds.
/// - Any block's AEAD tag fails to verify (wrong password or tampered).
#[tauri::command]
pub async fn acestep_decrypt_block_range(
    path: String,
    password: String,
    block_start: u32,
    block_end: u32,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let flac_bytes =
            std::fs::read(&path).map_err(|e| format!("Failed to read FLAC file '{path}': {e}"))?;
        let plaintext = acestep::flac_container::decrypt_block_range(
            &flac_bytes,
            password.as_bytes(),
            block_start,
            block_end,
        )
        .map_err(|e| format!("Failed to decrypt block range: {e}"))?;
        Ok(STANDARD.encode(&plaintext))
    })
    .await
    .map_err(|e| format!("Decrypt block range task panicked: {e}"))?
}

/// Edit the metadata of an existing `.a00m` archive in place.
///
/// Only `song.json`, `manifest.json` (cover field), and the cover image are
/// rewritten — the audio FLAC and creation context bytes are copied verbatim,
/// so there is no lossy re-encoding. Encrypted archives are re-encrypted with
/// the same password after editing. The original file is atomically replaced.
///
/// # Parameters
///
/// - `path`: absolute path to the `.a00m` file.
/// - `password`: user password (required for encrypted archives; ignored for
///   standard ZIP archives).
/// - `updates`: JSON object with optional `title` / `artist` / `album` /
///   `genre` / `coverPath` fields. `null`/absent fields are left unchanged.
#[tauri::command]
pub async fn acestep_update_song_meta(
    path: String,
    password: Option<String>,
    updates: serde_json::Value,
) -> Result<(), String> {
    let updates: acestep::package::SongMetaUpdates =
        serde_json::from_value(updates).map_err(|e| format!("Invalid updates payload: {e}"))?;
    tokio::task::spawn_blocking(move || {
        let archive_path = std::path::Path::new(&path);
        acestep::package::update_song_meta(archive_path, password.as_deref(), updates)
            .map_err(|e| format!("Failed to update song meta: {e}"))
    })
    .await
    .map_err(|e| format!("Update meta task panicked: {e}"))?
}
