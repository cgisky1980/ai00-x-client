//! FFI bindings to `acestep_c.dll` / `.so` / `.dylib`.
//!
//! Loads the C ABI shared library (built from `acestep-cpp/c-api/`) via
//! `libloading` and exposes typed function pointers. The library is loaded
//! once and cached in a `OnceLock`; callers obtain it via [`get_ffi`].
//!
//! # Layout
//!
//! - `#[repr(C)]` structs mirror `acestep_c.h` exactly.
//! - Opaque C handles (`AceStepStore *` etc.) are represented as `*mut c_void`.
//! - Callbacks are `extern "C" fn` pointers; see [`CancelFn`] / [`ProgressFn`].
//!
//! # Safety
//!
//! All functions in this module are `unsafe` because they call into native
//! code through raw pointers. The caller is responsible for upholding the
//! invariants documented in `acestep_c.h`.

use std::ffi::{c_char, c_float, c_int, c_void};
use std::path::Path;
use std::sync::OnceLock;

// C99 `_Bool` (from <stdbool.h>) is layout-compatible with Rust's `bool`.
// We keep the alias for clarity in the param structs below.
#[allow(non_camel_case_types)]
type c_bool = bool;

// ---------------------------------------------------------------------
// Opaque handles (forward-declared in C as `typedef struct X X;`)
// ---------------------------------------------------------------------

pub type StoreHandle = *mut c_void;
pub type SynthHandle = *mut c_void;
pub type LmHandle = *mut c_void;

// ---------------------------------------------------------------------
// Audio output (planar stereo, 48 kHz)
// ---------------------------------------------------------------------

/// C-side `AceStepAudio`. Planar stereo f32 48kHz `[L0..LN, R0..RN]`.
///
/// `samples` is heap-allocated by the C side and must be freed via
/// [`AceStepFFI::audio_free`].
#[repr(C)]
#[derive(Default)]
pub struct AceStepAudio {
    pub samples: *mut c_float,
    pub n_samples: c_int,
    pub sample_rate: c_int,
}

// ---------------------------------------------------------------------
// Params structs
// ---------------------------------------------------------------------

/// Mirror of `AceStepSynthParams` from `acestep_c.h`.
#[repr(C)]
pub struct SynthParams {
    pub text_encoder_path: *const c_char,
    pub dit_path: *const c_char,
    pub vae_path: *const c_char,
    pub adapter_path: *const c_char,
    pub adapter_scale: c_float,
    pub use_fa: c_bool,
    pub clamp_fp16: c_bool,
    pub use_batch_cfg: c_bool,
    pub vae_chunk: c_int,
    pub vae_overlap: c_int,
}

/// Mirror of `AceStepLmParams` from `acestep_c.h`.
#[repr(C)]
pub struct LmParams {
    pub model_path: *const c_char,
    pub max_seq: c_int,
    pub max_batch: c_int,
    pub use_fsm: c_bool,
    pub use_fa: c_bool,
    pub use_batch_cfg: c_bool,
    pub clamp_fp16: c_bool,
}

// ---------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------

/// Cancellation callback function pointer type. Return `true` to abort.
pub type CancelFn = unsafe extern "C" fn(user_data: *mut c_void) -> c_bool;

/// Progress callback function pointer type.
///   stage: 0=LM, 1=DiT, 2=VAE
///   step:  0-based step within stage
///   total: total steps in this stage
///   msg:   optional human-readable detail (may be null)
pub type ProgressFn = unsafe extern "C" fn(
    stage: c_int,
    step: c_int,
    total: c_int,
    msg: *const c_char,
    user_data: *mut c_void,
);

// ---------------------------------------------------------------------
// Function pointer types
// ---------------------------------------------------------------------

type StoreCreateFn = unsafe extern "C" fn(keep_loaded: c_bool) -> StoreHandle;
type StoreFreeFn = unsafe extern "C" fn(store: StoreHandle);

type SynthDefaultParamsFn = unsafe extern "C" fn(params: *mut SynthParams);
type SynthLoadFn =
    unsafe extern "C" fn(store: StoreHandle, params: *const SynthParams) -> SynthHandle;
type SynthFreeFn = unsafe extern "C" fn(synth: SynthHandle);

type SynthGenerateFn = unsafe extern "C" fn(
    synth: SynthHandle,
    request_json: *const c_char,
    src_audio: *const c_float,
    src_len: c_int,
    ref_audio: *const c_float,
    ref_len: c_int,
    out: *mut AceStepAudio,
    cancel_fn: Option<CancelFn>,
    cancel_data: *mut c_void,
    progress_fn: Option<ProgressFn>,
    progress_data: *mut c_void,
) -> c_int;

type SynthGenerateBatchFn = unsafe extern "C" fn(
    synth: SynthHandle,
    request_json_array: *const c_char,
    batch_n: c_int,
    src_audio: *const c_float,
    src_len: c_int,
    ref_audio: *const c_float,
    ref_len: c_int,
    out: *mut AceStepAudio,
    cancel_fn: Option<CancelFn>,
    cancel_data: *mut c_void,
    progress_fn: Option<ProgressFn>,
    progress_data: *mut c_void,
) -> c_int;

type LmDefaultParamsFn = unsafe extern "C" fn(params: *mut LmParams);
type LmLoadFn = unsafe extern "C" fn(store: StoreHandle, params: *const LmParams) -> LmHandle;
type LmFreeFn = unsafe extern "C" fn(lm: LmHandle);

type LmGenerateFn = unsafe extern "C" fn(
    lm: LmHandle,
    request_json: *const c_char,
    lm_batch_size: c_int,
    mode: c_int,
    cancel_fn: Option<CancelFn>,
    cancel_data: *mut c_void,
    progress_fn: Option<ProgressFn>,
    progress_data: *mut c_void,
) -> *mut c_char;

type AudioReadFileFn =
    unsafe extern "C" fn(path: *const c_char, out_len: *mut c_int) -> *mut c_float;
type InterleavedFreeFn = unsafe extern "C" fn(buf: *mut c_float);

type AudioWriteFileFn = unsafe extern "C" fn(
    path: *const c_char,
    planar_samples: *const c_float,
    n_samples: c_int,
    format: *const c_char,
    mp3_bitrate: c_int,
) -> c_bool;

type PlanarToInterleavedFn =
    unsafe extern "C" fn(planar: *const c_float, n_samples: c_int) -> *mut c_float;
type InterleavedToPlanarFn =
    unsafe extern "C" fn(interleaved: *const c_float, n_samples: c_int) -> *mut c_float;

type AudioFreeFn = unsafe extern "C" fn(audio: *mut AceStepAudio);
type StringFreeFn = unsafe extern "C" fn(s: *mut c_char);
type LastErrorFn = unsafe extern "C" fn() -> *const c_char;
type VersionFn = unsafe extern "C" fn() -> *const c_char;

// ---------------------------------------------------------------------
// FFI struct
// ---------------------------------------------------------------------

/// Resolved symbol table for `acestep_c`.
///
/// All fields are raw function pointers obtained via `libloading`. The
/// underlying `Library` is leaked (`std::mem::forget`) so the symbols stay
/// valid for the process lifetime — matches the `LlamaFFI` pattern.
pub struct AceStepFFI {
    // Store
    pub store_create: StoreCreateFn,
    pub store_free: StoreFreeFn,

    // Synth
    pub synth_default_params: SynthDefaultParamsFn,
    pub synth_load: SynthLoadFn,
    pub synth_free: SynthFreeFn,
    pub synth_generate: SynthGenerateFn,
    pub synth_generate_batch: SynthGenerateBatchFn,

    // LM
    pub lm_default_params: LmDefaultParamsFn,
    pub lm_load: LmLoadFn,
    pub lm_free: LmFreeFn,
    pub lm_generate: LmGenerateFn,

    // Audio I/O
    pub audio_read_file: AudioReadFileFn,
    pub interleaved_free: InterleavedFreeFn,
    pub audio_write_file: AudioWriteFileFn,
    pub planar_to_interleaved: PlanarToInterleavedFn,
    pub interleaved_to_planar: InterleavedToPlanarFn,

    // Utilities
    pub audio_free: AudioFreeFn,
    pub string_free: StringFreeFn,
    pub last_error: LastErrorFn,
    pub version: VersionFn,
}

// Function pointers are `Send`+`Sync` (they point into native code that does
// not mutate Rust-owned state). `Library` itself is not stored here because
// we leak it after resolving symbols.
unsafe impl Send for AceStepFFI {}
unsafe impl Sync for AceStepFFI {}

static FFI: OnceLock<Result<AceStepFFI, String>> = OnceLock::new();

/// Library file name on the current platform.
fn lib_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "acestep_c.dll"
    } else if cfg!(target_os = "macos") {
        "libacestep_c.dylib"
    } else {
        "libacestep_c.so"
    }
}

/// Load (and cache) the AceStep C ABI library.
///
/// `lib_dir` should point to the directory containing `acestep_c.dll` and its
/// GGML backend dependencies (`ggml-base.dll`, `ggml-cpu.dll`, ...). On
/// Windows, this directory is added to the DLL search path before loading so
/// the GGML backends resolve correctly.
///
/// Subsequent calls return the cached result (success or error) without
/// re-loading. Matched to `get_ffi()` in `asr/llama.rs`.
pub fn get_ffi(lib_dir: &Path) -> Result<&'static AceStepFFI, String> {
    FFI.get_or_init(|| unsafe {
        let lib_path = lib_dir.join(lib_name());
        if !lib_path.exists() {
            return Err(format!(
                "AceStep library not found at: {}",
                lib_path.display()
            ));
        }

        log::info!("[AceStepFFI] Loading library: {}", lib_path.display());

        // On Windows, register the lib dir via AddDllDirectory and load with
        // LOAD_LIBRARY_SEARCH_USER_DIRS so ggml-base.dll / ggml-cpu.dll
        // (siblings of acestep_c.dll) resolve. SetDllDirectoryW is bypassed
        // when libloading uses LOAD_LIBRARY_SEARCH_* flags, so we must use
        // AddDllDirectory instead.
        #[cfg(target_os = "windows")]
        let lib: libloading::Library = {
            use std::os::windows::ffi::OsStrExt;
            fn to_wide(s: &std::ffi::OsStr) -> Vec<u16> {
                s.encode_wide().chain(std::iter::once(0)).collect()
            }
            extern "system" {
                fn AddDllDirectory(lpDirectoryName: *const u16) -> *mut std::ffi::c_void;
                fn GetLastError() -> u32;
            }
            // AddDllDirectory requires the path WITHOUT a trailing slash.
            let wide = to_wide(lib_dir.as_os_str());
            let cookie = AddDllDirectory(wide.as_ptr());
            if cookie.is_null() {
                let err = GetLastError();
                log::warn!(
                    "[AceStepFFI] AddDllDirectory failed for {} (GetLastError={})",
                    lib_dir.display(),
                    err
                );
            } else {
                log::info!(
                    "[AceStepFFI] AddDllDirectory registered: {}",
                    lib_dir.display()
                );
            }

            // ggml-base.dll conflict is resolved at startup by `sync_ggml_dlls()`
            // in init.rs — it deletes llama's older copy so both runtimes share
            // acestep's newer version via the DLL search path. No preload needed.

            const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
            const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x0000_1000;
            const LOAD_LIBRARY_SEARCH_USER_DIRS: u32 = 0x0000_0400;
            let flags = LOAD_LIBRARY_SEARCH_DEFAULT_DIRS
                | LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR
                | LOAD_LIBRARY_SEARCH_USER_DIRS;

            libloading::os::windows::Library::load_with_flags(&lib_path, flags)
                .map_err(|e| {
                    // libloading::Error::LoadLibraryExW's Display only says
                    // "LoadLibraryExW failed". The human-readable Windows
                    // message (e.g. "The specified procedure could not be
                    // found" for error 127) lives in the source chain.
                    // Calling GetLastError() here is unreliable because the
                    // error code may be stale by the time the closure runs.
                    let mut detail = format!("{}", e);
                    let mut source = std::error::Error::source(&e);
                    while let Some(s) = source {
                        detail.push_str(": ");
                        detail.push_str(&s.to_string());
                        source = s.source();
                    }
                    format!(
                        "Failed to load {}: {}. \
                         Common causes: (1) a dependency DLL (ggml-base.dll, \
                         ggml-cpu.dll) is missing from the directory; \
                         (2) error 127 means a function imported by \
                         acestep_c.dll was not found in an already-loaded \
                         ggml-base.dll — this is a version conflict with \
                         llama's older ggml-base.dll, fixed by preloading \
                         acestep's version first.",
                        lib_path.display(),
                        detail
                    )
                })?
                .into()
        };

        #[cfg(not(target_os = "windows"))]
        let lib: libloading::Library = {
            libloading::Library::new(&lib_path)
                .map_err(|e| format!("Failed to load {}: {}", lib_name(), e))?
        };

        macro_rules! resolve {
            ($name:expr) => {
                *lib.get($name)
                    .map_err(|e| format!("Failed to resolve symbol {}: {}", stringify!($name), e))?
            };
        }

        let ffi = AceStepFFI {
            store_create: resolve!(b"acestep_store_create"),
            store_free: resolve!(b"acestep_store_free"),

            synth_default_params: resolve!(b"acestep_synth_default_params"),
            synth_load: resolve!(b"acestep_synth_load"),
            synth_free: resolve!(b"acestep_synth_free"),
            synth_generate: resolve!(b"acestep_synth_generate"),
            synth_generate_batch: resolve!(b"acestep_synth_generate_batch"),

            lm_default_params: resolve!(b"acestep_lm_default_params"),
            lm_load: resolve!(b"acestep_lm_load"),
            lm_free: resolve!(b"acestep_lm_free"),
            lm_generate: resolve!(b"acestep_lm_generate"),

            audio_read_file: resolve!(b"acestep_audio_read_file"),
            interleaved_free: resolve!(b"acestep_interleaved_free"),
            audio_write_file: resolve!(b"acestep_audio_write_file"),
            planar_to_interleaved: resolve!(b"acestep_planar_to_interleaved"),
            interleaved_to_planar: resolve!(b"acestep_interleaved_to_planar"),

            audio_free: resolve!(b"acestep_audio_free"),
            string_free: resolve!(b"acestep_string_free"),
            last_error: resolve!(b"acestep_last_error"),
            version: resolve!(b"acestep_version"),
        };

        let version_cstr = {
            let raw = (ffi.version)();
            if raw.is_null() {
                "<unknown>".to_string()
            } else {
                std::ffi::CStr::from_ptr(raw).to_string_lossy().into_owned()
            }
        };
        log::info!("[AceStepFFI] Loaded acestep version: {}", version_cstr);

        // Leak the Library so the function pointers stay valid for the
        // process lifetime. Same approach as LlamaFFI.
        std::mem::forget(lib);
        Ok(ffi)
    })
    .as_ref()
    .map_err(|e| e.clone())
}

/// Fetch the last thread-local error message from the C side.
///
/// Returns `None` if no error is set (null pointer). The returned string is
/// borrowed from thread-local storage on the C side and is only valid until
/// the next AceStep call on this thread.
///
/// # Safety
///
/// Caller must ensure no other AceStep call happens between fetching and
/// reading the string.
pub unsafe fn last_error(ffi: &AceStepFFI) -> Option<String> {
    let raw = (ffi.last_error)();
    if raw.is_null() {
        return None;
    }
    Some(std::ffi::CStr::from_ptr(raw).to_string_lossy().into_owned())
}
