//! Rust mirror of the C++ `AceRequest` struct.
//!
//! Serializes to the same JSON format that acestep.cpp's `request_parse_json`
//! consumes (see `acestep-cpp/src/request.cpp`). All field names are
//! snake_case and match the C++ field names exactly.
//!
//! # Defaults
//!
//! `Default` impls match `request_init()` in `request.cpp` so that a
//! freshly-constructed `AceRequest` behaves identically on both sides.
//!
//! # Missing fields
//!
//! `#[serde(default)]` on the struct means missing JSON fields fall back to
//! the Rust defaults, matching the C parser's behavior (init-then-override).

use serde::{Deserialize, Serialize};

// ---- Task type constants (match `task-types.h`) ----

pub const TASK_TEXT2MUSIC: &str = "text2music";
pub const TASK_COVER: &str = "cover";
pub const TASK_COVER_NOFSQ: &str = "cover-nofsq";
pub const TASK_REPAINT: &str = "repaint";
pub const TASK_LEGO: &str = "lego";
pub const TASK_EXTRACT: &str = "extract";
pub const TASK_COMPLETE: &str = "complete";

// ---- Solver constants ----

pub const SOLVER_EULER: &str = "euler";
pub const SOLVER_SDE: &str = "sde";
pub const SOLVER_DPM3M: &str = "dpm3m";
pub const SOLVER_STORK4: &str = "stork4";

// ---- LM mode constants ----

pub const LM_MODE_GENERATE: &str = "generate";
pub const LM_MODE_INSPIRE: &str = "inspire";
pub const LM_MODE_FORMAT: &str = "format";

/// LM mode numeric values passed to `acestep_lm_generate`'s `mode` parameter.
pub mod lm_mode_val {
    pub const GENERATE: i32 = 0;
    pub const INSPIRE: i32 = 1;
    pub const FORMAT: i32 = 2;
}

// ---- Audio output format constants ----

pub const OUTPUT_FORMAT_MP3: &str = "mp3";
pub const OUTPUT_FORMAT_WAV16: &str = "wav16";
pub const OUTPUT_FORMAT_WAV24: &str = "wav24";
pub const OUTPUT_FORMAT_WAV32: &str = "wav32";

// ---- DCW mode constants ----

pub const DCW_MODE_LOW: &str = "low";
pub const DCW_MODE_HIGH: &str = "high";
pub const DCW_MODE_DOUBLE: &str = "double";
pub const DCW_MODE_PIX: &str = "pix";

/// AceStep generation request.
///
/// Mirrors `AceRequest` from `acestep-cpp/src/request.h`. Serialized to JSON
/// and passed to the C API via `acestep_synth_generate` / `acestep_lm_generate`.
///
/// All fields have sensible defaults (see `Default` impl); users typically
/// only set `caption`, `duration`, and optionally `lyrics` / `bpm`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AceRequest {
    // ---- Text content ----
    /// Text description of the desired music (e.g. "upbeat electronic dance").
    pub caption: String,
    /// Lyrics text. Use "[Instrumental]" for instrumental tracks.
    pub lyrics: String,

    // ---- Metadata (user-provided or LLM-enriched) ----
    /// Tempo in BPM. 0 = unset (model decides).
    pub bpm: i32,
    /// Duration in seconds. 0 = unset (model decides).
    pub duration: f32,
    /// Musical key, e.g. "C major". "" = unset.
    pub keyscale: String,
    /// Time signature, e.g. "4/4". "" = unset.
    pub timesignature: String,
    /// Vocal language hint, e.g. "en", "zh". "" = unset.
    pub vocal_language: String,

    // ---- Generation ----
    /// Number of LLM variations to generate. Default 1.
    pub lm_batch_size: i32,
    /// Number of DiT variations per request (synth batch). Default 1.
    pub synth_batch_size: i32,
    /// Random seed. -1 = random. DiT Philox noise consumes the low 32 bits.
    pub seed: i64,

    // ---- LM control ----
    /// LM sampling temperature. Default 0.85.
    pub lm_temperature: f32,
    /// LM classifier-free guidance scale. Default 2.0.
    pub lm_cfg_scale: f32,
    /// LM top-p sampling. Default 0.9.
    pub lm_top_p: f32,
    /// LM top-k sampling. 0 = disabled.
    pub lm_top_k: i32,
    /// LM negative prompt. "" = none.
    pub lm_negative_prompt: String,
    /// LM seed. -1 = random.
    pub lm_seed: i64,
    /// Whether the LM should enrich the caption via chain-of-thought.
    pub use_cot_caption: bool,

    // ---- Audio codes (for cover mode) ----
    /// Python-compatible string: "3101,11837,27514,...".
    /// Empty = text2music (silence context), non-empty = cover mode.
    pub audio_codes: String,

    // ---- DiT control (0 = auto-detect from model) ----
    /// Inference steps. 0 = auto (turbo: 8, base/sft: 50).
    pub inference_steps: i32,
    /// Guidance scale. 0 = auto (1.0 for all models).
    pub guidance_scale: f32,
    /// Flow matching shift. 0 = auto (turbo: 3.0, base/sft: 1.0).
    pub shift: f32,

    // ---- Differential Correction in Wavelet domain (CVPR 2026) ----
    /// DCW scaler. 0.0 = disabled. Paper recommends 0.1 as starting value.
    pub dcw_scaler: f32,
    /// DCW high-band scaler (only used in "double" mode).
    pub dcw_high_scaler: f32,
    /// DCW mode: "low" | "high" | "double" | "pix".
    pub dcw_mode: String,

    // ---- Cover mode (active when source audio is provided) ----
    /// Fraction of DiT steps using source context (0-1). Default 1.0.
    pub audio_cover_strength: f32,
    /// How close to source: 0=pure noise, 1=source. Default 0.0.
    pub cover_noise_strength: f32,

    // ---- Repaint region (requires source audio) ----
    /// Start offset in seconds. 0 = source start. Negative = outpaint before.
    pub repainting_start: f32,
    /// End offset in seconds. Negative = source duration (sentinel).
    pub repainting_end: f32,

    // ---- Latent post-processing (after DiT, before VAE) ----
    /// `pred = pred * latent_rescale + latent_shift`. Default 0.0.
    pub latent_shift: f32,
    /// Default 1.0 (no-op).
    pub latent_rescale: f32,

    // ---- Custom flow matching schedule ----
    /// Comma-separated floats overriding inference_steps and shift.
    /// e.g. "0.97,0.76,0.615,0.5,0.395,0.28,0.18,0.085,0"
    pub custom_timesteps: String,

    // ---- Task type ----
    /// One of: text2music, cover, cover-nofsq, repaint, lego, extract, complete.
    pub task_type: String,
    /// Track name for lego/extract/complete (e.g. "vocals", "drums").
    pub track: String,

    // ---- Solver ----
    /// Solver name: "euler", "sde", "dpm3m", "stork4".
    pub solver: String,
    /// Sub-stepping count for the "stork4" solver. Default 10.
    pub stork_substeps: i32,

    // ---- LM mode ----
    /// "generate" (full), "inspire" (short query -> metadata+lyrics),
    /// "format" (caption+lyrics -> metadata+lyrics).
    pub lm_mode: String,

    // ---- Audio output ----
    /// Output format: "mp3", "wav16", "wav24", "wav32".
    pub output_format: String,
    /// Peak clip percentile. 0 = no clip, 10 = default, 999 = max.
    pub peak_clip: i32,
    /// MP3 bitrate in kbps (ignored for WAV).
    pub mp3_bitrate: i32,

    // ---- Model selection (empty = first matching registry entry) ----
    /// Synth (DiT) model name.
    pub synth_model: String,
    /// LM model name.
    pub lm_model: String,
    /// Adapter name.
    pub adapter: String,
    /// Adapter scale. Default 1.0.
    pub adapter_scale: f32,
    /// VAE model name.
    pub vae: String,
}

impl Default for AceRequest {
    fn default() -> Self {
        Self {
            caption: String::new(),
            lyrics: String::new(),

            bpm: 0,
            duration: 0.0,
            keyscale: String::new(),
            timesignature: String::new(),
            vocal_language: String::new(),

            lm_batch_size: 1,
            synth_batch_size: 1,
            seed: -1,

            lm_temperature: 0.85,
            lm_cfg_scale: 2.0,
            lm_top_p: 0.9,
            lm_top_k: 0,
            lm_negative_prompt: String::new(),
            lm_seed: -1,
            use_cot_caption: true,

            audio_codes: String::new(),

            inference_steps: 0,
            guidance_scale: 0.0,
            shift: 0.0,

            dcw_scaler: 0.0,
            dcw_high_scaler: 0.0,
            dcw_mode: DCW_MODE_LOW.to_string(),

            audio_cover_strength: 1.0,
            cover_noise_strength: 0.0,

            repainting_start: 0.0,
            repainting_end: -1.0,

            latent_shift: 0.0,
            latent_rescale: 1.0,

            custom_timesteps: String::new(),

            task_type: TASK_TEXT2MUSIC.to_string(),
            track: String::new(),

            solver: SOLVER_EULER.to_string(),
            stork_substeps: 10,

            lm_mode: LM_MODE_GENERATE.to_string(),

            output_format: OUTPUT_FORMAT_MP3.to_string(),
            peak_clip: 10,
            mp3_bitrate: 128,

            synth_model: String::new(),
            lm_model: String::new(),
            adapter: String::new(),
            adapter_scale: 1.0,
            vae: String::new(),
        }
    }
}

impl AceRequest {
    /// Create a text2music request with just a caption and duration.
    pub fn text2music(caption: impl Into<String>, duration: f32) -> Self {
        Self {
            caption: caption.into(),
            duration,
            ..Default::default()
        }
    }

    /// Create a lego request that layers a new track on top of source audio.
    pub fn lego(caption: impl Into<String>, track: impl Into<String>) -> Self {
        Self {
            caption: caption.into(),
            track: track.into(),
            task_type: TASK_LEGO.to_string(),
            ..Default::default()
        }
    }

    /// Serialize to JSON string for passing to the C API.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

// ---- Audio output ----

/// Generated audio in planar stereo f32 48kHz format: `[L0..LN, R0..RN]`.
///
/// The samples vector has length `2 * n_samples` (L channel first, then R).
/// Use [`AudioOutput::to_interleaved`] to convert to `[L0,R0,L1,R1,...]`
/// for playback with most audio libraries.
pub struct AudioOutput {
    /// Planar stereo samples: `[L0, L1, ..., LN, R0, R1, ..., RN]`
    pub samples: Vec<f32>,
    /// Samples per channel.
    pub n_samples: usize,
    /// Always 48000.
    pub sample_rate: u32,
}

impl AudioOutput {
    /// Duration in seconds.
    pub fn duration_seconds(&self) -> f32 {
        self.n_samples as f32 / self.sample_rate as f32
    }

    /// Convert planar `[L.., R..]` to interleaved `[L,R,L,R,...]`.
    pub fn to_interleaved(&self) -> Vec<f32> {
        let n = self.n_samples;
        let mut out = Vec::with_capacity(n * 2);
        for i in 0..n {
            out.push(self.samples[i]); // L
            out.push(self.samples[n + i]); // R
        }
        out
    }

    /// Left channel samples.
    pub fn left(&self) -> &[f32] {
        &self.samples[..self.n_samples]
    }

    /// Right channel samples.
    pub fn right(&self) -> &[f32] {
        &self.samples[self.n_samples..]
    }
}

// ---- Progress ----

/// Progress event from the generation pipeline.
#[derive(Debug, Clone)]
pub struct ProgressEvent {
    /// 0=LM, 1=DiT (denoising), 2=VAE (decode)
    pub stage: i32,
    /// Current step within stage (0-based).
    pub step: i32,
    /// Total steps in this stage.
    pub total: i32,
    /// Human-readable detail (may be empty).
    pub msg: String,
}

/// Pipeline stage labels for [`ProgressEvent::stage`].
pub mod stage {
    pub const LM: i32 = 0;
    pub const DIT: i32 = 1;
    pub const VAE: i32 = 2;

    pub fn label(stage: i32) -> &'static str {
        match stage {
            0 => "LM",
            1 => "DiT",
            2 => "VAE",
            _ => "Unknown",
        }
    }
}
