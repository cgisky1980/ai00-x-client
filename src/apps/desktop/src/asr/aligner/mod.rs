//! Pure-Rust Qwen3-ForcedAligner inference.
//!
//! Ported from `参考/qwen3-asr.cpp/` (femelo/qwen3-asr.cpp). Reads the GGUF
//! model file directly via [`super::gguf::GgufReader`] and implements the
//! full Qwen3 audio-encoder + LLM-decoder forward pass in pure Rust — no
//! Python, no ONNX, no external C++ tool, no llama.cpp FFI.
//!
//! # Pipeline
//!
//! 1. Load audio (any format supported by symphonia) → 16 kHz mono f32.
//! 2. Compute log-mel spectrogram (128 mels, 400 FFT, 160 hop, Hann window,
//!    reflect padding, slaney-normalized filterbank, log10, clamp/normalize).
//! 3. Run audio encoder: 3× Conv2d (stride 2) → sinusoidal PE → 24-layer
//!    transformer with **windowed** (block-diagonal) attention → ln_post →
//!    proj1+GELU → proj2.
//! 4. Build alignment prompt: `<audio_start>` + N×`<audio_pad>` + `<audio_end>`
//!    + BPE(tokens) of the lyrics with two `<timestamp>` tokens per word.
//! 5. Run LLM decoder: single non-autoregressive forward pass through a
//!    28-layer Qwen3 transformer (RoPE + GQA + q/k_norm + SwiGLU + RMSNorm)
//!    with audio embeddings injected in place of the `<audio_pad>` slots.
//!    Output = 5000-class logits at each position.
//! 6. For every `<timestamp>` position, take the argmax → timestamp class.
//!    Run LIS-based anomaly correction, then convert classes to seconds
//!    (`class * 80 ms`). Pair classes (start, end) per word.
//!
//! # Module layout
//!
//! | submodule      | responsibility                                         |
//! |----------------|--------------------------------------------------------|
//! | [`math`]       | matmul, RMSNorm, LayerNorm, GELU, SiLU, RoPE, softmax  |
//! | [`mel`]        | log-mel spectrogram + mel filterbank                   |
//! | [`tokenizer`]  | BPE tokenizer loaded from GGUF vocab + merges          |
//! | [`model`]      | GGUF model loader (hparams + tensor cache)             |
//! | [`encoder`]    | audio encoder forward pass                             |
//! | [`decoder`]    | text decoder forward pass                              |
//! | [`timestamps`] | argmax + LIS correction + class→seconds                |

pub mod decoder;
pub mod encoder;
pub mod fa_ffi;
pub mod math;
pub mod mel;
pub mod model;
pub mod timestamps;
pub mod tokenizer;

use std::path::Path;
use std::sync::Arc;

use encoder::encode_audio;
use mel::log_mel_spectrogram;
use model::ForcedAlignerModel;
use tokenizer::tokenize_with_timestamps;

/// A single aligned word/character with timestamps (seconds).
///
/// Returned as a plain struct (no serde derive) so this module stays free
/// of `serde` dependencies — callers wrap it into their own DTOs.
#[derive(Debug, Clone)]
pub struct AlignedEntry {
    pub text: String,
    pub start: f32,
    pub end: f32,
}

/// Align `lyrics` to the audio at `audio_path` using the ForcedAligner GGUF
/// model at `model_path`.
///
/// `language` is a hint (e.g. "Chinese", "English", "Japanese") — currently
/// only affects Korean word segmentation (requires a separate dict file,
/// not yet wired up); for all other languages it is unused.
/// Progress callback: `(stage, progress 0..1, message)`.
/// `stage` is a short stable string the frontend can switch on.
pub type ProgressFn = Arc<dyn Fn(&str, f32, &str) + Send + Sync>;

/// Align `lyrics` to the audio at `audio_path` using the ForcedAligner GGUF
/// model at `model_path`, emitting progress events via `progress_cb`.
///
/// `progress_cb(stage, progress, message)`:
/// - stage: stable string tag (e.g. "load_model", "encode_audio", "decode")
/// - progress: 0.0..=1.0 (best-effort, may stay at 0.0 for long stages)
/// - message: human-readable description (English, for log/debug)
pub fn align_lyrics_with_progress(
    model_path: &Path,
    audio_path: &str,
    lyrics: &str,
    language: &str,
    progress_cb: ProgressFn,
) -> Result<Vec<AlignedEntry>, String> {
    progress_cb("start", 0.0, "Starting alignment");
    log::info!(
        "[FA] align_lyrics: model={}, audio={}, lyrics_len={}, lang={}",
        model_path.display(),
        audio_path,
        lyrics.len(),
        language
    );

    // Try GPU-accelerated C++ DLL first (qwen3_fa.dll)
    match try_align_with_gpu_dll(model_path, audio_path, lyrics, language, &progress_cb) {
        Ok(entries) => return Ok(entries),
        Err(e) => {
            log::warn!(
                "[FA] GPU DLL path failed: {}. Falling back to pure Rust CPU.",
                e
            );
            progress_cb(
                "gpu_fallback",
                0.0,
                &format!("GPU unavailable ({}), using CPU", e),
            );
        }
    }

    // Fallback: pure Rust CPU implementation
    align_lyrics_cpu(model_path, audio_path, lyrics, language, progress_cb)
}

/// Try the GPU-accelerated qwen3_fa.dll. Falls back to CPU on any error.
fn try_align_with_gpu_dll(
    model_path: &Path,
    audio_path: &str,
    lyrics: &str,
    language: &str,
    progress_cb: &ProgressFn,
) -> Result<Vec<AlignedEntry>, String> {
    progress_cb("load_model", 0.05, "Loading ForcedAligner model (GPU DLL)");
    let handle = fa_ffi::create(model_path)?;

    // Load + resample audio in Rust (supports all formats via symphonia),
    // then pass samples directly to the C DLL — bypasses WAV file parsing
    // entirely (avoids WAVE_FORMAT_EXTENSIBLE / float WAV incompatibilities).
    progress_cb("load_audio", 0.10, "Loading audio");
    let (samples, sample_rate) = super::audio::load_audio(audio_path)?;
    let samples = if sample_rate != 16_000 {
        super::audio::resample(&samples, sample_rate, 16_000)
    } else {
        samples
    };
    log::info!(
        "[FA] audio loaded for GPU path: {} samples ({:.2}s) at {} Hz",
        samples.len(),
        samples.len() as f32 / 16_000.0,
        sample_rate
    );

    progress_cb("running", 0.15, "Running GPU-accelerated alignment");
    let pc = Arc::clone(progress_cb);
    let cb: fa_ffi::ProgressCallback =
        Box::new(move |stage: &str, progress: f32, message: &str| {
            pc(stage, progress, message);
        });

    let (words, timing) = fa_ffi::align_samples(&handle, &samples, lyrics, language, Some(cb))?;

    log::info!(
        "[FA] GPU alignment done: mel={}ms, encode={}ms, decode={}ms, total={}ms",
        timing.mel_ms,
        timing.encode_ms,
        timing.decode_ms,
        timing.total_ms
    );

    let entries: Vec<AlignedEntry> = words
        .into_iter()
        .map(|w| AlignedEntry {
            text: w.text,
            start: w.start,
            end: w.end,
        })
        .collect();

    Ok(entries)
}

/// Pure Rust CPU implementation (fallback when qwen3_fa.dll is unavailable).
fn align_lyrics_cpu(
    model_path: &Path,
    audio_path: &str,
    lyrics: &str,
    language: &str,
    progress_cb: ProgressFn,
) -> Result<Vec<AlignedEntry>, String> {
    progress_cb("load_model", 0.05, "Loading ForcedAligner model (CPU)");
    let model = ForcedAlignerModel::load(model_path)?;
    let hp = model.hparams();

    // 2. Load + resample audio to 16 kHz mono.
    progress_cb("load_audio", 0.10, "Loading audio");
    let (samples, sample_rate) = super::audio::load_audio(audio_path)?;
    let samples = if sample_rate != 16_000 {
        super::audio::resample(&samples, sample_rate, 16_000)
    } else {
        samples
    };
    let audio_duration = samples.len() as f32 / 16_000.0_f32;
    log::info!(
        "[FA] audio loaded: {} samples ({:.2}s) at {} Hz → 16 kHz",
        samples.len(),
        audio_duration,
        sample_rate
    );

    // 3. Log-mel spectrogram.
    progress_cb("mel", 0.15, "Computing mel spectrogram");
    let mel = log_mel_spectrogram(&samples, hp)?;
    log::info!("[FA] mel: {} mels × {} frames", mel.n_mel, mel.n_len);

    // 4. Audio encoder (heaviest CPU stage — 24-layer transformer).
    progress_cb(
        "encode_audio",
        0.20,
        "Encoding audio (24-layer transformer, this is slow on CPU)",
    );
    let audio_features = encode_audio(model, &mel)?;
    let n_audio_frames = audio_features.len() / hp.text_hidden_size as usize;
    log::info!(
        "[FA] encoder: {} frames × {} hidden",
        n_audio_frames,
        hp.text_hidden_size
    );

    // 5. Tokenize lyrics with timestamp markers (2 per word).
    progress_cb("tokenize", 0.40, "Tokenizing lyrics");
    let (words, text_tokens) = tokenize_with_timestamps(model, lyrics, language);
    if words.is_empty() {
        return Err("Lyrics produced no words after tokenization".into());
    }
    log::info!(
        "[FA] tokens: {} words, {} text tokens",
        words.len(),
        text_tokens.len()
    );

    // 6. Build input: <audio_start> <audio_pad>×N <audio_end> <text_tokens>
    let n_audio_pads = timestamps::feat_extract_output_lengths(mel.n_len as i32);
    let input_tokens = build_input_tokens(hp, &text_tokens, n_audio_pads);
    let audio_start_pos = find_audio_start_pos(&input_tokens, hp.audio_start_token_id)
        .ok_or_else(|| "audio_start token not found in input".to_string())?;
    log::info!(
        "[FA] input: {} tokens (audio_start_pos={}, n_audio_pads={})",
        input_tokens.len(),
        audio_start_pos,
        n_audio_pads
    );

    // 7. Decoder forward pass (also heavy — 28-layer transformer).
    progress_cb(
        "decode",
        0.50,
        "Running decoder (28-layer transformer, this is slow on CPU)",
    );
    let logits = decoder::forward_decoder(
        model,
        &input_tokens,
        &audio_features,
        n_audio_frames as i32,
        audio_start_pos,
    )?;
    log::info!(
        "[FA] decoder: {} logit rows × {} classes",
        input_tokens.len(),
        hp.classify_num
    );

    // 8. Extract + fix + convert timestamp classes.
    progress_cb("timestamps", 0.90, "Extracting timestamps");
    let classes = timestamps::extract_timestamp_classes(
        &logits,
        &input_tokens,
        hp.timestamp_token_id,
        hp.classify_num,
    );
    let fixed = timestamps::fix_timestamp_classes(&classes);
    let mut ts = timestamps::classes_to_timestamps(&fixed, hp.timestamp_segment_time_ms);
    // Clamp to audio duration.
    for t in ts.iter_mut() {
        if *t > audio_duration {
            *t = audio_duration;
        }
    }

    // 9. Pair (start, end) per word: ts[2i]=start, ts[2i+1]=end.
    let mut entries = Vec::with_capacity(words.len());
    for (i, word) in words.iter().enumerate() {
        let start = ts.get(i * 2).copied().unwrap_or(0.0);
        let end = ts.get(i * 2 + 1).copied().unwrap_or(audio_duration);
        entries.push(AlignedEntry {
            text: word.clone(),
            start,
            end,
        });
    }
    log::info!("[FA] alignment produced {} entries", entries.len());
    progress_cb("done", 1.0, "Alignment complete");
    Ok(entries)
}

/// Align `lyrics` to the audio at `audio_path` using the ForcedAligner GGUF
/// model at `model_path`.
///
/// `language` is a hint (e.g. "Chinese", "English", "Japanese") — currently
/// only affects Korean word segmentation (requires a separate dict file,
/// not yet wired up); for all other languages it is unused.
pub fn align_lyrics(
    model_path: &Path,
    audio_path: &str,
    lyrics: &str,
    language: &str,
) -> Result<Vec<AlignedEntry>, String> {
    align_lyrics_with_progress(
        model_path,
        audio_path,
        lyrics,
        language,
        Arc::new(|_, _, _| {}),
    )
}

/// Build the input token sequence: `<audio_start>` + N×`<audio_pad>` +
/// `<audio_end>` + `text_tokens`. (No chat template — the ForcedAligner
/// was trained on this bare format.)
fn build_input_tokens(hp: &model::HParams, text_tokens: &[i32], n_audio_pads: i32) -> Vec<i32> {
    let mut tokens = Vec::with_capacity(n_audio_pads as usize + text_tokens.len() + 2);
    tokens.push(hp.audio_start_token_id);
    for _ in 0..n_audio_pads {
        tokens.push(hp.audio_pad_token_id);
    }
    tokens.push(hp.audio_end_token_id);
    tokens.extend_from_slice(text_tokens);
    tokens
}

/// Find the position immediately after `<audio_start>` in the input sequence
/// — this is where audio embeddings should be injected.
fn find_audio_start_pos(tokens: &[i32], audio_start_id: i32) -> Option<i32> {
    for (i, &t) in tokens.iter().enumerate() {
        if t == audio_start_id {
            return Some(i as i32 + 1);
        }
    }
    None
}
