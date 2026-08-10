//! High-level async pipeline for AceStep music generation.
//!
//! Wraps the raw FFI ([`crate::ffi`]) in a safe Rust API:
//! - [`AceStepPipeline`] owns the model store + optional synth/lm contexts.
//! - Long-running C calls run on `tokio::task::spawn_blocking` to avoid
//!   blocking the async runtime.
//! - Cancellation via [`AceStepCancelToken`] (backed by `AtomicBool`).
//! - Progress via a callback closure that receives [`ProgressEvent`]s.
//!
//! # Step-by-step song building
//!
//! ```no_run
//! use acestep::{AceRequest, AceStepPipeline, SynthConfig};
//!
//! # async fn demo() -> anyhow::Result<()> {
//! let mut pipe = AceStepPipeline::new("models/acestep".as_ref(), false)?;
//! pipe.load_synth(&SynthConfig {
//!     text_encoder_path: "models/acestep/text_encoder.gguf".into(),
//!     dit_path: "models/acestep/dit.gguf".into(),
//!     vae_path: "models/acestep/vae.gguf".into(),
//!     ..Default::default()
//! })?;
//!
//! // 1. Generate base instrumental
//! let req = AceRequest::text2music("upbeat electronic dance at 128 BPM", 30.0);
//! let base = pipe.generate(req, None, None, None, None).await?;
//!
//! // 2. Layer melody on top
//! let req = AceRequest::lego("add a guitar melody", "guitar");
//! let with_melody = pipe.generate(req, Some(&base.to_interleaved()), None, None, None).await?;
//! # Ok(())
//! # }
//! ```

use std::ffi::{CString, NulError};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};

use crate::ffi::{self, AceStepAudio, AceStepFFI, LmHandle, StoreHandle, SynthHandle};
use crate::types::{AceRequest, AudioOutput, ProgressEvent};

// ---- Blocking job bundle for spawn_blocking ----

/// Bundle of all data needed by a `spawn_blocking` task.
///
/// `handle` is stored as `usize` (not `*mut c_void`) so that the struct is
/// automatically `Send` without needing `unsafe impl`. The pointer is
/// reconstructed inside the blocking task.
struct BlockingJob {
    ffi: &'static AceStepFFI,
    handle: usize,
    request_json: String,
    src_owned: Option<Vec<f32>>,
    ref_owned: Option<Vec<f32>>,
    cancel_flag: Option<Arc<AtomicBool>>,
    progress_ctx: Option<Box<ProgressCtx>>,
    // For batch generate
    batch_n: i32,
    // For LM generate
    lm_batch_size: i32,
    mode: i32,
}

// ---- Error helpers ----

/// Fetch the C-side thread-local error and convert to `anyhow::Error`.
unsafe fn ffi_error(ffi: &AceStepFFI, fallback: &str) -> anyhow::Error {
    match ffi::last_error(ffi) {
        Some(msg) => anyhow!("{fallback}: {msg}"),
        None => anyhow!("{fallback}"),
    }
}

/// Convert a `CString` NUL error to `anyhow::Error`.
fn nul_error(e: NulError) -> anyhow::Error {
    anyhow!("string contains NUL byte: {e}")
}

// ---- Cancellation ----

/// Cancellation token shared between Rust and the C cancel callback.
///
/// The token is an `Arc<AtomicBool>`; calling [`AceStepCancelToken::cancel`]
/// sets the flag, which the C-side cancel callback polls.
#[derive(Clone, Default)]
pub struct AceStepCancelToken {
    flag: Arc<AtomicBool>,
}

impl AceStepCancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Request cancellation. The running generation will abort at the next
    /// check point and return an error.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    /// Whether cancellation was requested.
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Clone the underlying flag. Used to keep the flag alive across
    /// `spawn_blocking` boundaries (the cloned `Arc` is moved into the
    /// blocking task so it survives even if the async future is dropped).
    fn flag_clone(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.flag)
    }
}

/// `extern "C"` trampoline for cancellation. Reads the `AtomicBool` through
/// the raw pointer passed as `user_data`.
unsafe extern "C" fn cancel_trampoline(user_data: *mut std::ffi::c_void) -> bool {
    if user_data.is_null() {
        return false;
    }
    let flag = &*(user_data as *const AtomicBool);
    flag.load(Ordering::SeqCst)
}

// ---- Progress callback ----

/// User-provided progress callback. Takes a `&ProgressEvent`.
pub type ProgressCallback = Arc<dyn Fn(&ProgressEvent) + Send + Sync>;

/// C-side progress trampoline context (callback + is_stopped flag).
struct ProgressCtx {
    callback: ProgressCallback,
}

unsafe extern "C" fn progress_trampoline(
    stage: i32,
    step: i32,
    total: i32,
    msg: *const std::ffi::c_char,
    user_data: *mut std::ffi::c_void,
) {
    if user_data.is_null() {
        return;
    }
    let ctx = &*(user_data as *const ProgressCtx);
    let msg = if msg.is_null() {
        String::new()
    } else {
        std::ffi::CStr::from_ptr(msg).to_string_lossy().into_owned()
    };
    (ctx.callback)(&ProgressEvent {
        stage,
        step,
        total,
        msg,
    });
}

// ---- Model configs ----

/// Configuration for loading the synth (DiT + text encoder + VAE) pipeline.
#[derive(Debug, Clone, Default)]
pub struct SynthConfig {
    /// Path to the Qwen3 text encoder GGUF (required).
    pub text_encoder_path: PathBuf,
    /// Path to the DiT GGUF (required).
    pub dit_path: PathBuf,
    /// Path to the VAE GGUF (required).
    pub vae_path: PathBuf,
    /// Path to the adapter safetensors/dir (optional).
    pub adapter_path: Option<PathBuf>,
    /// Adapter scale. 1.0 = default.
    pub adapter_scale: f32,
    /// Enable flash attention. Default true.
    pub use_fa: bool,
    /// Clamp hidden states to FP16 range.
    pub clamp_fp16: bool,
    /// Batch cond+uncond in one DiT forward.
    pub use_batch_cfg: bool,
    /// Latent frames per VAE tile. Default 1024.
    pub vae_chunk: i32,
    /// VAE tile overlap per side. Default 64.
    pub vae_overlap: i32,
}

impl SynthConfig {
    /// Create a config with required paths and sensible defaults.
    pub fn new(
        text_encoder_path: impl Into<PathBuf>,
        dit_path: impl Into<PathBuf>,
        vae_path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            text_encoder_path: text_encoder_path.into(),
            dit_path: dit_path.into(),
            vae_path: vae_path.into(),
            use_fa: true,
            vae_chunk: 1024,
            vae_overlap: 64,
            ..Default::default()
        }
    }
}

/// Configuration for loading the LM (Qwen3) pipeline.
#[derive(Debug, Clone, Default)]
pub struct LmConfig {
    /// Path to the LM GGUF (required).
    pub model_path: PathBuf,
    /// KV cache length. 0 = default (8192).
    pub max_seq: i32,
    /// Max batch size for generate. Default 1.
    pub max_batch: i32,
    /// Enable constrained decoding (FSM). Default true.
    pub use_fsm: bool,
    /// Enable flash attention. Default true.
    pub use_fa: bool,
    /// Batch cond+uncond in one forward.
    pub use_batch_cfg: bool,
    /// Clamp hidden states to FP16 range.
    pub clamp_fp16: bool,
}

impl LmConfig {
    pub fn new(model_path: impl Into<PathBuf>) -> Self {
        Self {
            model_path: model_path.into(),
            use_fsm: true,
            use_fa: true,
            max_seq: 8192,
            max_batch: 1,
            ..Default::default()
        }
    }
}

// ---- Pipeline ----

/// High-level AceStep music generation pipeline.
///
/// Owns a model store and optional synth/lm contexts. The C-side handles are
/// freed on `Drop`. The pipeline is `Send` but not `Clone` (each instance
/// owns exclusive C resources).
pub struct AceStepPipeline {
    ffi: &'static AceStepFFI,
    lib_dir: PathBuf,
    store: StoreHandle,
    synth: Option<SynthHandle>,
    lm: Option<LmHandle>,
}

// The raw pointers are owned exclusively by this struct and not shared across
// threads. The underlying C code is thread-safe per-context (each context is
// used from one blocking task at a time). Access is serialised externally via
// a `tokio::sync::Mutex`, so `Sync` is safe — no two threads ever touch the
// same `&AceStepPipeline` concurrently.
unsafe impl Send for AceStepPipeline {}
unsafe impl Sync for AceStepPipeline {}

impl Drop for AceStepPipeline {
    fn drop(&mut self) {
        unsafe {
            if let Some(lm) = self.lm.take() {
                (self.ffi.lm_free)(lm);
            }
            if let Some(synth) = self.synth.take() {
                (self.ffi.synth_free)(synth);
            }
            if !self.store.is_null() {
                (self.ffi.store_free)(self.store);
            }
        }
    }
}

impl AceStepPipeline {
    /// Create a new pipeline.
    ///
    /// `lib_dir` must contain `acestep_c.dll` (and its GGML backend DLLs on
    /// Windows). `keep_loaded` controls the model store's eviction policy:
    /// - `false`: EVICT_STRICT (at most one GPU module resident — lower VRAM)
    /// - `true`: EVICT_NEVER (never evict — faster but uses more VRAM)
    pub fn new(lib_dir: &Path, keep_loaded: bool) -> Result<Self> {
        let ffi = ffi::get_ffi(lib_dir).map_err(|e| anyhow!(e))?;
        let store = unsafe { (ffi.store_create)(keep_loaded) };
        if store.is_null() {
            return Err(unsafe { ffi_error(ffi, "Failed to create model store") });
        }
        Ok(Self {
            ffi,
            lib_dir: lib_dir.to_path_buf(),
            store,
            synth: None,
            lm: None,
        })
    }

    /// Directory containing the AceStep library and models.
    pub fn lib_dir(&self) -> &Path {
        &self.lib_dir
    }

    /// Load the synth (DiT + text encoder + VAE) pipeline.
    pub fn load_synth(&mut self, config: &SynthConfig) -> Result<()> {
        let text_enc = CString::new(config.text_encoder_path.to_string_lossy().as_bytes())
            .map_err(nul_error)?;
        let dit = CString::new(config.dit_path.to_string_lossy().as_bytes()).map_err(nul_error)?;
        let vae = CString::new(config.vae_path.to_string_lossy().as_bytes()).map_err(nul_error)?;
        let adapter = config
            .adapter_path
            .as_ref()
            .map(|p| CString::new(p.to_string_lossy().as_bytes()).map_err(nul_error))
            .transpose()?;

        let mut params = unsafe { std::mem::zeroed::<crate::ffi::SynthParams>() };
        unsafe { (self.ffi.synth_default_params)(&mut params) };
        params.text_encoder_path = text_enc.as_ptr();
        params.dit_path = dit.as_ptr();
        params.vae_path = vae.as_ptr();
        params.adapter_path = match &adapter {
            Some(a) => a.as_ptr(),
            None => std::ptr::null(),
        };
        params.adapter_scale = config.adapter_scale;
        params.use_fa = config.use_fa;
        params.clamp_fp16 = config.clamp_fp16;
        params.use_batch_cfg = config.use_batch_cfg;
        params.vae_chunk = if config.vae_chunk > 0 {
            config.vae_chunk
        } else {
            1024
        };
        params.vae_overlap = if config.vae_overlap > 0 {
            config.vae_overlap
        } else {
            64
        };

        let handle = unsafe { (self.ffi.synth_load)(self.store, &params) };
        if handle.is_null() {
            return Err(unsafe { ffi_error(self.ffi, "Failed to load synth pipeline") });
        }

        // Free old synth if replacing
        if let Some(old) = self.synth.take() {
            unsafe { (self.ffi.synth_free)(old) };
        }
        self.synth = Some(handle);

        // The C wrapper (AceStepSynth) copies the strings into std::string
        // members, so our CStrings can be dropped normally here.
        drop(text_enc);
        drop(dit);
        drop(vae);
        drop(adapter);

        Ok(())
    }

    /// Load the LM (Qwen3) pipeline.
    pub fn load_lm(&mut self, config: &LmConfig) -> Result<()> {
        let model_path =
            CString::new(config.model_path.to_string_lossy().as_bytes()).map_err(nul_error)?;

        let mut params = unsafe { std::mem::zeroed::<crate::ffi::LmParams>() };
        unsafe { (self.ffi.lm_default_params)(&mut params) };
        params.model_path = model_path.as_ptr();
        params.max_seq = if config.max_seq > 0 {
            config.max_seq
        } else {
            8192
        };
        params.max_batch = if config.max_batch > 0 {
            config.max_batch
        } else {
            1
        };
        params.use_fsm = config.use_fsm;
        params.use_fa = config.use_fa;
        params.use_batch_cfg = config.use_batch_cfg;
        params.clamp_fp16 = config.clamp_fp16;

        let handle = unsafe { (self.ffi.lm_load)(self.store, &params) };
        if handle.is_null() {
            return Err(unsafe { ffi_error(self.ffi, "Failed to load LM pipeline") });
        }

        if let Some(old) = self.lm.take() {
            unsafe { (self.ffi.lm_free)(old) };
        }
        self.lm = Some(handle);

        // C wrapper copies the string; drop our CString normally.
        drop(model_path);

        Ok(())
    }

    /// Whether the synth pipeline is loaded.
    pub fn is_synth_loaded(&self) -> bool {
        self.synth.is_some()
    }

    /// Whether the LM pipeline is loaded.
    pub fn is_lm_loaded(&self) -> bool {
        self.lm.is_some()
    }

    /// Generate audio from a single request.
    ///
    /// `src_audio`: interleaved stereo f32 48kHz for cover/lego/repaint.
    ///              `None` for text2music.
    /// `ref_audio`: interleaved stereo f32 48kHz for timbre conditioning.
    ///              `None` = no timbre reference.
    /// `cancel`:    optional cancellation token. Call `cancel()` on it to abort.
    /// `progress`:  optional progress callback.
    pub async fn generate(
        &self,
        request: AceRequest,
        src_audio: Option<&[f32]>,
        ref_audio: Option<&[f32]>,
        cancel: Option<AceStepCancelToken>,
        progress: Option<ProgressCallback>,
    ) -> Result<AudioOutput> {
        let synth = self
            .synth
            .ok_or_else(|| anyhow!("Synth pipeline not loaded"))?;
        let request_json = request.to_json().context("Failed to serialize request")?;

        // Copy audio data to owned Vecs for lifetime safety across spawn_blocking.
        // If the async future is dropped while the blocking task runs, borrowed
        // slices could be freed — owning the data prevents dangling pointers.
        let src_owned: Option<Vec<f32>> = src_audio.map(|s| s.to_vec());
        let ref_owned: Option<Vec<f32>> = ref_audio.map(|s| s.to_vec());

        // Clone the cancel flag Arc so it stays alive inside the blocking task.
        let cancel_flag = cancel.as_ref().map(|t| t.flag_clone());

        // Move progress_ctx into the job (Box<ProgressCtx> is Send).
        let progress_ctx = progress.map(|cb| Box::new(ProgressCtx { callback: cb }));

        let ffi = self.ffi;

        // Bundle all data into a Send struct. The closure captures only this
        // struct, avoiding per-field Send checks on raw pointers.
        let job = BlockingJob {
            ffi,
            handle: synth as usize,
            request_json,
            src_owned,
            ref_owned,
            cancel_flag,
            progress_ctx,
            batch_n: 0,
            lm_batch_size: 0,
            mode: 0,
        };

        let (rc, samples, n_samples, sample_rate) = tokio::task::spawn_blocking(move || unsafe {
            let BlockingJob {
                ffi,
                handle,
                request_json,
                src_owned,
                ref_owned,
                cancel_flag,
                progress_ctx,
                batch_n: _,
                lm_batch_size: _,
                mode: _,
            } = job;
            let synth = handle as *mut std::ffi::c_void;

            let json_cstr = CString::new(request_json.as_bytes()).unwrap();

            // Derive cancel callback inside the closure
            let (cancel_fn, cancel_data) = match &cancel_flag {
                Some(flag) => (
                    Some(cancel_trampoline as ffi::CancelFn),
                    Arc::as_ptr(flag) as *mut _,
                ),
                None => (None, std::ptr::null_mut()),
            };

            // Derive progress callback inside the closure
            let (progress_fn, progress_data) = match &progress_ctx {
                Some(ctx) => (
                    Some(progress_trampoline as ffi::ProgressFn),
                    ctx.as_ref() as *const ProgressCtx as *mut _,
                ),
                None => (None, std::ptr::null_mut()),
            };

            // Derive audio pointers inside the closure
            let (src_ptr, src_len) = match &src_owned {
                Some(v) => (v.as_ptr(), v.len() as i32 / 2),
                None => (std::ptr::null(), 0),
            };
            let (ref_ptr, ref_len) = match &ref_owned {
                Some(v) => (v.as_ptr(), v.len() as i32 / 2),
                None => (std::ptr::null(), 0),
            };

            let mut out = AceStepAudio::default();
            let rc = (ffi.synth_generate)(
                synth,
                json_cstr.as_ptr(),
                src_ptr,
                src_len,
                ref_ptr,
                ref_len,
                &mut out,
                cancel_fn,
                cancel_data,
                progress_fn,
                progress_data,
            );

            // Extract samples and free C buffer inside the closure.
            // Save sample_rate BEFORE audio_free — acestep_audio_free() zeroes
            // the struct (including sample_rate) to prevent use-after-free.
            let sample_rate = out.sample_rate;
            let n = out.n_samples as usize;
            let total = n * 2;
            let samples = if total > 0 && !out.samples.is_null() {
                let mut v = vec![0.0f32; total];
                std::ptr::copy_nonoverlapping(out.samples, v.as_mut_ptr(), total);
                (ffi.audio_free)(&mut out);
                v
            } else {
                Vec::new()
            };

            (rc, samples, n, sample_rate)
        })
        .await
        .context("Generation task panicked")?;

        match rc {
            0 => Ok(AudioOutput {
                samples,
                n_samples,
                sample_rate: sample_rate as u32,
            }),
            -2 => Err(anyhow!("Generation cancelled")),
            _ => Err(unsafe { ffi_error(ffi, "Generation failed") }),
        }
    }

    /// Generate audio from a batch of requests (all must share the same T).
    ///
    /// Returns one `AudioOutput` per request.
    pub async fn generate_batch(
        &self,
        requests: &[AceRequest],
        src_audio: Option<&[f32]>,
        ref_audio: Option<&[f32]>,
        cancel: Option<AceStepCancelToken>,
        progress: Option<ProgressCallback>,
    ) -> Result<Vec<AudioOutput>> {
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        if requests.len() > 9 {
            return Err(anyhow!("Batch size must be 1..9, got {}", requests.len()));
        }

        let synth = self
            .synth
            .ok_or_else(|| anyhow!("Synth pipeline not loaded"))?;
        let batch_n = requests.len() as i32;
        let json_array = serde_json::to_string(requests).context("Failed to serialize requests")?;

        // Copy audio data to owned Vecs for lifetime safety
        let src_owned: Option<Vec<f32>> = src_audio.map(|s| s.to_vec());
        let ref_owned: Option<Vec<f32>> = ref_audio.map(|s| s.to_vec());

        let cancel_flag = cancel.as_ref().map(|t| t.flag_clone());
        let progress_ctx = progress.map(|cb| Box::new(ProgressCtx { callback: cb }));

        let ffi = self.ffi;

        let job = BlockingJob {
            ffi,
            handle: synth as usize,
            request_json: json_array,
            src_owned,
            ref_owned,
            cancel_flag,
            progress_ctx,
            batch_n,
            lm_batch_size: 0,
            mode: 0,
        };

        let (rc, results) = tokio::task::spawn_blocking(move || unsafe {
            let BlockingJob {
                ffi,
                handle,
                request_json: json_array,
                src_owned,
                ref_owned,
                cancel_flag,
                progress_ctx,
                batch_n,
                lm_batch_size: _,
                mode: _,
            } = job;
            let synth = handle as *mut std::ffi::c_void;

            let json_cstr = CString::new(json_array.as_bytes()).unwrap();

            let (cancel_fn, cancel_data) = match &cancel_flag {
                Some(flag) => (
                    Some(cancel_trampoline as ffi::CancelFn),
                    Arc::as_ptr(flag) as *mut _,
                ),
                None => (None, std::ptr::null_mut()),
            };

            let (progress_fn, progress_data) = match &progress_ctx {
                Some(ctx) => (
                    Some(progress_trampoline as ffi::ProgressFn),
                    ctx.as_ref() as *const ProgressCtx as *mut _,
                ),
                None => (None, std::ptr::null_mut()),
            };

            let (src_ptr, src_len) = match &src_owned {
                Some(v) => (v.as_ptr(), v.len() as i32 / 2),
                None => (std::ptr::null(), 0),
            };
            let (ref_ptr, ref_len) = match &ref_owned {
                Some(v) => (v.as_ptr(), v.len() as i32 / 2),
                None => (std::ptr::null(), 0),
            };

            // Create output buffer inside the closure
            let mut out_vec: Vec<AceStepAudio> =
                (0..batch_n).map(|_| AceStepAudio::default()).collect();
            let rc = (ffi.synth_generate_batch)(
                synth,
                json_cstr.as_ptr(),
                batch_n,
                src_ptr,
                src_len,
                ref_ptr,
                ref_len,
                out_vec.as_mut_ptr(),
                cancel_fn,
                cancel_data,
                progress_fn,
                progress_data,
            );

            // Extract samples and free C buffers inside the closure.
            // Save sample_rate BEFORE audio_free — it zeroes the struct.
            let results: Vec<(Vec<f32>, usize, i32)> = out_vec
                .into_iter()
                .map(|mut out| {
                    let sample_rate = out.sample_rate;
                    let n = out.n_samples as usize;
                    let total = n * 2;
                    let samples = if total > 0 && !out.samples.is_null() {
                        let mut v = vec![0.0f32; total];
                        std::ptr::copy_nonoverlapping(out.samples, v.as_mut_ptr(), total);
                        (ffi.audio_free)(&mut out);
                        v
                    } else {
                        Vec::new()
                    };
                    (samples, n, sample_rate)
                })
                .collect();

            (rc, results)
        })
        .await
        .context("Batch generation task panicked")?;

        match rc {
            0 => {
                let outputs = results
                    .into_iter()
                    .map(|(samples, n, sr)| AudioOutput {
                        samples,
                        n_samples: n,
                        sample_rate: sr as u32,
                    })
                    .collect();
                Ok(outputs)
            }
            -2 => Err(anyhow!("Batch generation cancelled")),
            _ => Err(unsafe { ffi_error(ffi, "Batch generation failed") }),
        }
    }

    /// Enrich a request via the LM (text -> metadata + lyrics + audio codes).
    ///
    /// `mode`: 0=generate (full), 1=inspire, 2=format.
    /// `lm_batch_size`: number of variations (1-9).
    ///
    /// Returns the enriched request (parsed from the JSON returned by the C API).
    pub async fn lm_generate(
        &self,
        request: AceRequest,
        lm_batch_size: i32,
        mode: i32,
        cancel: Option<AceStepCancelToken>,
        progress: Option<ProgressCallback>,
    ) -> Result<AceRequest> {
        let lm = self.lm.ok_or_else(|| anyhow!("LM pipeline not loaded"))?;
        let request_json = request.to_json().context("Failed to serialize request")?;

        let cancel_flag = cancel.as_ref().map(|t| t.flag_clone());
        let progress_ctx = progress.map(|cb| Box::new(ProgressCtx { callback: cb }));

        let ffi = self.ffi;

        let job = BlockingJob {
            ffi,
            handle: lm as usize,
            request_json,
            src_owned: None,
            ref_owned: None,
            cancel_flag,
            progress_ctx,
            batch_n: 0,
            lm_batch_size,
            mode,
        };

        let result = tokio::task::spawn_blocking(move || unsafe {
            let BlockingJob {
                ffi,
                handle,
                request_json,
                src_owned: _,
                ref_owned: _,
                cancel_flag,
                progress_ctx,
                batch_n: _,
                lm_batch_size,
                mode,
            } = job;
            let lm = handle as *mut std::ffi::c_void;

            let json_cstr = CString::new(request_json.as_bytes()).unwrap();

            let (cancel_fn, cancel_data) = match &cancel_flag {
                Some(flag) => (
                    Some(cancel_trampoline as ffi::CancelFn),
                    Arc::as_ptr(flag) as *mut _,
                ),
                None => (None, std::ptr::null_mut()),
            };

            let (progress_fn, progress_data) = match &progress_ctx {
                Some(ctx) => (
                    Some(progress_trampoline as ffi::ProgressFn),
                    ctx.as_ref() as *const ProgressCtx as *mut _,
                ),
                None => (None, std::ptr::null_mut()),
            };

            let json_ptr = (ffi.lm_generate)(
                lm,
                json_cstr.as_ptr(),
                lm_batch_size,
                mode,
                cancel_fn,
                cancel_data,
                progress_fn,
                progress_data,
            );
            if json_ptr.is_null() {
                None
            } else {
                let cstr = std::ffi::CStr::from_ptr(json_ptr);
                let json_str = cstr.to_string_lossy().into_owned();
                (ffi.string_free)(json_ptr);
                Some(json_str)
            }
        })
        .await
        .context("LM generate task panicked")?;

        let json_str =
            result.ok_or_else(|| unsafe { ffi_error(ffi, "LM generate returned null") })?;

        let enriched: AceRequest =
            serde_json::from_str(&json_str).context("Failed to parse enriched request JSON")?;
        Ok(enriched)
    }

    /// Write audio to a file.
    ///
    /// `format`: "mp3", "wav16", "wav24", "wav32".
    /// `mp3_bitrate`: kbps for MP3 (ignored for WAV). 0 = default 128.
    pub fn write_audio_file(
        &self,
        path: &Path,
        audio: &AudioOutput,
        format: &str,
        mp3_bitrate: i32,
    ) -> Result<()> {
        let path_c = CString::new(path.to_string_lossy().as_bytes()).map_err(nul_error)?;
        let format_c = CString::new(format).map_err(nul_error)?;
        let bitrate = if mp3_bitrate > 0 { mp3_bitrate } else { 128 };

        let ok = unsafe {
            (self.ffi.audio_write_file)(
                path_c.as_ptr(),
                audio.samples.as_ptr(),
                audio.n_samples as i32,
                format_c.as_ptr(),
                bitrate,
            )
        };

        if ok {
            Ok(())
        } else {
            Err(unsafe { ffi_error(self.ffi, "Failed to write audio file") })
        }
    }

    /// Read an audio file as interleaved stereo f32 48kHz.
    pub fn read_audio_file(&self, path: &Path) -> Result<Vec<f32>> {
        let path_c = CString::new(path.to_string_lossy().as_bytes()).map_err(nul_error)?;
        let mut out_len: i32 = 0;
        let ptr = unsafe { (self.ffi.audio_read_file)(path_c.as_ptr(), &mut out_len) };
        if ptr.is_null() {
            return Err(unsafe { ffi_error(self.ffi, "Failed to read audio file") });
        }
        let total = (out_len as usize) * 2; // interleaved stereo
        let samples = unsafe {
            let mut v = vec![0.0f32; total];
            std::ptr::copy_nonoverlapping(ptr, v.as_mut_ptr(), total);
            (self.ffi.interleaved_free)(ptr);
            v
        };
        Ok(samples)
    }
}
