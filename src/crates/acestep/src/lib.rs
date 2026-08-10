//! AceStep (text-to-music) integration crate.
//!
//! This crate provides FFI bindings to acestep.cpp, a GGML-based music generation
//! pipeline. The C++ source lives under `acestep-cpp/` (upstream MIT-licensed
//! https://github.com/ServeurpersoCom/acestep.cpp).
//!
//! ## Architecture
//!
//! 1. **C wrapper** (`acestep-cpp/c-api/`): `extern "C"` interface that accepts
//!    JSON strings, avoiding `std::string` ABI issues across the FFI boundary.
//! 2. **Rust FFI** ([`ffi`]): loads `acestep_c.dll`/`.so`/`.dylib` via `libloading`.
//! 3. **Types** ([`types`]): Rust mirror of `AceRequest` with serde.
//! 4. **Pipeline** ([`pipeline`]): high-level async API for text2music / lego / cover.
//!
//! ## Quick start
//!
//! ```no_run
//! use acestep::{AceRequest, AceStepPipeline, SynthConfig};
//!
//! # async fn demo() -> anyhow::Result<()> {
//! let mut pipe = AceStepPipeline::new("models/acestep".as_ref(), false)?;
//! pipe.load_synth(&SynthConfig::new(
//!     "text_encoder.gguf",
//!     "dit.gguf",
//!     "vae.gguf",
//! ))?;
//!
//! let req = AceRequest::text2music("upbeat electronic dance at 128 BPM", 30.0);
//! let audio = pipe.generate(req, None, None, None, None).await?;
//! println!("Generated {:.1}s of audio", audio.duration_seconds());
//! # Ok(())
//! # }
//! ```
//!
//! ## Step-by-step song building
//!
//! 1. `text2music` — generate base instrumental backing
//! 2. `lego` — layer melody on top of existing audio
//! 3. `lego` — layer vocals on top of the result
//!
//! ```no_run
//! use acestep::{AceRequest, AceStepPipeline, SynthConfig};
//!
//! # async fn demo() -> anyhow::Result<()> {
//! let mut pipe = AceStepPipeline::new("models/acestep".as_ref(), false)?;
//! pipe.load_synth(&SynthConfig::new("te.gguf", "dit.gguf", "vae.gguf"))?;
//!
//! // 1. Base instrumental
//! let req = AceRequest::text2music("electronic dance at 128 BPM", 30.0);
//! let base = pipe.generate(req, None, None, None, None).await?;
//!
//! // 2. Layer melody
//! let req = AceRequest::lego("add a guitar melody", "guitar");
//! let with_melody = pipe.generate(
//!     req,
//!     Some(&base.to_interleaved()),
//!     None, None, None,
//! ).await?;
//! # Ok(())
//! # }
//! ```

pub mod chunked_crypto;
pub mod drm;
pub mod ffi;
pub mod flac_container;
pub mod package;
pub mod package_container;
pub mod passwords;
pub mod pipeline;
pub mod scoring;
pub mod types;

// Re-export the most commonly used types at the crate root.
pub use pipeline::{AceStepCancelToken, AceStepPipeline, LmConfig, ProgressCallback, SynthConfig};
pub use types::{
    // LM mode numeric values
    lm_mode_val,
    // Stage labels
    stage,
    AceRequest,
    AudioOutput,
    ProgressEvent,
    LM_MODE_FORMAT,
    // LM mode constants
    LM_MODE_GENERATE,
    LM_MODE_INSPIRE,
    // Output format constants
    OUTPUT_FORMAT_MP3,
    OUTPUT_FORMAT_WAV16,
    OUTPUT_FORMAT_WAV24,
    OUTPUT_FORMAT_WAV32,
    // Solver constants
    SOLVER_DPM3M,
    SOLVER_EULER,
    SOLVER_SDE,
    SOLVER_STORK4,
    // Task type constants
    TASK_COMPLETE,
    TASK_COVER,
    TASK_COVER_NOFSQ,
    TASK_EXTRACT,
    TASK_LEGO,
    TASK_REPAINT,
    TASK_TEXT2MUSIC,
};

/// Crate version (delegates to workspace version).
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Returns the build-time library directory if the crate was built with
/// `ACESTEP_BUILD_FROM_SOURCE=1`. Returns `None` otherwise.
///
/// When `build.rs` runs CMake, it sets `ACESTEP_LIB_DIR` to the output
/// directory containing `acestep_c.dll` (and GGML backend DLLs). This
/// function exposes that path at runtime so the inference layer can fall
/// back to it when the runtime-downloaded DLL is not present.
pub fn build_lib_dir() -> Option<&'static str> {
    option_env!("ACESTEP_LIB_DIR")
}
