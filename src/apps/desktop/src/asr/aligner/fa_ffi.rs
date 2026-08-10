//! FFI bindings for qwen3_fa.dll (GPU-accelerated ForcedAligner via ggml).
//!
//! The DLL is built by `src/crates/inference/build.rs` from
//! `src/crates/inference/qwen3-fa-cpp/` and placed in the same directory as
//! the GGML DLLs (`.llama-build/bin/Release/`).
//!
//! At runtime, the DLL is loaded via `libloading` — same pattern as
//! `asr/llama.rs` and `asr/dylib.rs`.

use std::ffi::{c_char, c_void, CString};
use std::os::raw::c_float;
use std::path::Path;
use std::sync::OnceLock;

use libloading::Library;

// ---- C struct mirrors (must match fa_c_api.h exactly) ----

#[repr(C)]
struct FaWordC {
    text: *const c_char,
    start: c_float,
    end: c_float,
}

#[repr(C)]
struct FaResultC {
    success: bool,
    error_msg: *const c_char,
    words: *const FaWordC,
    n_words: usize,
    t_mel_ms: i64,
    t_encode_ms: i64,
    t_decode_ms: i64,
    t_total_ms: i64,
    storage: *mut c_void,
}

type FaCreateFn = unsafe extern "C" fn(*const c_char, *mut *const c_char) -> *mut c_void;
type FaAlignFn = unsafe extern "C" fn(
    *mut c_void,
    *const c_char,
    *const c_char,
    *const c_char,
    Option<unsafe extern "C" fn(*const c_char, c_float, *const c_char, *mut c_void)>,
    *mut c_void,
) -> FaResultC;
type FaAlignSamplesFn = unsafe extern "C" fn(
    *mut c_void,
    *const c_float,
    usize,
    *const c_char,
    *const c_char,
    Option<unsafe extern "C" fn(*const c_char, c_float, *const c_char, *mut c_void)>,
    *mut c_void,
) -> FaResultC;
type FaResultFreeFn = unsafe extern "C" fn(*mut FaResultC);
type FaDestroyFn = unsafe extern "C" fn(*mut c_void);

struct FaFFI {
    _lib: Library,
    fa_create: FaCreateFn,
    fa_align_audio: FaAlignFn,
    fa_align_samples: FaAlignSamplesFn,
    fa_result_free: FaResultFreeFn,
    fa_destroy: FaDestroyFn,
}

static FFI: OnceLock<Result<FaFFI, String>> = OnceLock::new();

/// Loaded ForcedAligner handle. Wrap in a struct to ensure `fa_destroy` is called on drop.
pub struct FaHandle {
    raw: *mut c_void,
}

// The handle is not Send/Sync by default because it's a raw pointer.
// We only use it from a single blocking thread, so this is safe.
unsafe impl Send for FaHandle {}
unsafe impl Sync for FaHandle {}

impl Drop for FaHandle {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe {
                if let Ok(ffi) = get_ffi() {
                    (ffi.fa_destroy)(self.raw);
                }
            }
        }
    }
}

/// Load the qwen3_fa.dll and resolve symbols. Cached for the process lifetime.
fn get_ffi() -> Result<&'static FaFFI, String> {
    FFI.get_or_init(|| unsafe {
        let lib_dir = resolve_lib_dir()?;
        let dll_name = if cfg!(target_os = "windows") {
            "qwen3_fa.dll"
        } else if cfg!(target_os = "macos") {
            "libqwen3_fa.dylib"
        } else {
            "libqwen3_fa.so"
        };

        let dll_path = lib_dir.join(dll_name);
        if !dll_path.exists() {
            return Err(format!(
                "qwen3_fa DLL not found at: {}. \
                 Build it with `cargo build --release -p ai00-x-inference`.",
                dll_path.display()
            ));
        }

        log::info!("[FA-FFI] Loading {}", dll_path.display());

        // Preload GGML DLLs from the same directory
        preload_ggml_dlls(&lib_dir);

        let lib = Library::new(&dll_path)
            .map_err(|e| format!("Failed to load {}: {}", dll_path.display(), e))?;

        let fa_create: FaCreateFn = *lib
            .get(b"fa_create")
            .map_err(|e| format!("Failed to resolve fa_create: {}", e))?;
        let fa_align_audio: FaAlignFn = *lib
            .get(b"fa_align_audio")
            .map_err(|e| format!("Failed to resolve fa_align_audio: {}", e))?;
        let fa_align_samples: FaAlignSamplesFn = *lib
            .get(b"fa_align_samples")
            .map_err(|e| format!("Failed to resolve fa_align_samples: {}", e))?;
        let fa_result_free: FaResultFreeFn = *lib
            .get(b"fa_result_free")
            .map_err(|e| format!("Failed to resolve fa_result_free: {}", e))?;
        let fa_destroy: FaDestroyFn = *lib
            .get(b"fa_destroy")
            .map_err(|e| format!("Failed to resolve fa_destroy: {}", e))?;

        log::info!("[FA-FFI] qwen3_fa.dll loaded successfully");

        Ok(FaFFI {
            _lib: lib,
            fa_create,
            fa_align_audio,
            fa_align_samples,
            fa_result_free,
            fa_destroy,
        })
    })
    .as_ref()
    .map_err(|e| e.clone())
}

/// Resolve the directory where qwen3_fa.dll lives.
///
/// Priority:
/// 1. `QWEN3_FA_LIB_DIR` env var (set by build.rs at compile time)
/// 2. `.llama-build/bin/Release/` relative to the crate root (dev mode)
/// 3. `find_gguf_lib_dir()` from inference runtime (production: runtime/gguf/)
/// 4. Current dir fallback
fn resolve_lib_dir() -> Result<std::path::PathBuf, String> {
    let dll_name = if cfg!(target_os = "windows") {
        "qwen3_fa.dll"
    } else if cfg!(target_os = "macos") {
        "libqwen3_fa.dylib"
    } else {
        "libqwen3_fa.so"
    };

    // 1. Compile-time env var (set by build.rs to .llama-build/bin/Release/)
    if let Some(dir) = option_env!("QWEN3_FA_LIB_DIR") {
        let p = std::path::PathBuf::from(dir);
        if p.join(dll_name).exists() {
            return Ok(p);
        }
    }

    // 2. .llama-build/bin/Release/ relative to CARGO_MANIFEST_DIR (dev mode)
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let p = std::path::PathBuf::from(manifest)
            .join("../../..")
            .join(".llama-build/bin/Release");
        if p.join(dll_name).exists() {
            return Ok(p);
        }
    }

    // 3. Production: runtime/gguf/ (same dir as ggml-base.dll)
    if let Some(gguf_dir) = ai00_x_inference::runtime::find_gguf_lib_dir() {
        if gguf_dir.join(dll_name).exists() {
            return Ok(gguf_dir);
        }
    }

    // 4. Current dir fallback (dev mode)
    let cwd = std::env::current_dir().map_err(|e| format!("Cannot get cwd: {}", e))?;
    let p = cwd.join(".llama-build/bin/Release");
    if p.join(dll_name).exists() {
        return Ok(p);
    }

    Err(format!(
        "Cannot find {} directory. Set QWEN3_FA_LIB_DIR or build from source.",
        dll_name
    ))
}

/// Preload GGML DLLs from the same directory as qwen3_fa.dll.
#[cfg(target_os = "windows")]
fn preload_ggml_dlls(dir: &Path) {
    for dll in &["ggml-base.dll", "ggml.dll", "ggml-cuda.dll", "ggml-cpu.dll"] {
        let p = dir.join(dll);
        if p.exists() {
            match unsafe { Library::new(&p) } {
                Ok(lib) => {
                    std::mem::forget(lib);
                    log::debug!("[FA-FFI] Preloaded {}", dll);
                }
                Err(e) => {
                    log::warn!("[FA-FFI] Failed to preload {}: {}", dll, e);
                }
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn preload_ggml_dlls(_dir: &Path) {}

/// Progress callback type for the C API.
pub type ProgressCallback = Box<dyn Fn(&str, f32, &str) + Send + Sync>;

/// Create a new ForcedAligner handle by loading the GGUF model.
pub fn create(model_path: &Path) -> Result<FaHandle, String> {
    let ffi = get_ffi()?;
    let c_path = CString::new(model_path.to_string_lossy().as_ref())
        .map_err(|e| format!("Invalid path: {}", e))?;

    log::info!("[FA-FFI] fa_create: loading model {}", model_path.display());

    let mut err_ptr: *const c_char = std::ptr::null();
    let raw = unsafe { (ffi.fa_create)(c_path.as_ptr(), &mut err_ptr) };
    log::info!(
        "[FA-FFI] fa_create returned, raw={:p}, err_null={}",
        raw,
        err_ptr.is_null()
    );
    if raw.is_null() {
        let err = unsafe {
            if err_ptr.is_null() {
                "Unknown error".to_string()
            } else {
                std::ffi::CStr::from_ptr(err_ptr)
                    .to_string_lossy()
                    .into_owned()
            }
        };
        return Err(format!("Failed to load ForcedAligner model: {}", err));
    }

    Ok(FaHandle { raw })
}

/// Aligned word returned by the C API.
pub struct AlignedWord {
    pub text: String,
    pub start: f32,
    pub end: f32,
}

/// Align `text` to in-memory audio samples using a loaded handle.
///
/// `samples` must be 32-bit float, mono, 16 kHz. The caller is responsible
/// for loading and resampling the audio (e.g. via symphonia). This bypasses
/// WAV file parsing entirely.
pub fn align_samples(
    handle: &FaHandle,
    samples: &[f32],
    text: &str,
    language: &str,
    progress_cb: Option<ProgressCallback>,
) -> Result<(Vec<AlignedWord>, AlignTiming), String> {
    let ffi = get_ffi()?;

    let c_text = CString::new(text).map_err(|e| format!("Invalid text: {}", e))?;
    let c_lang = CString::new(language).map_err(|e| format!("Invalid language: {}", e))?;

    log::info!(
        "[FA-FFI] fa_align_samples: n_samples={}, text_len={}, lang={}",
        samples.len(),
        text.len(),
        language
    );

    let cb_ptr: *mut ProgressCallback = match progress_cb {
        Some(cb) => Box::into_raw(Box::new(cb)),
        None => std::ptr::null_mut(),
    };

    log::info!("[FA-FFI] calling fa_align_samples (cb_ptr={:p})...", cb_ptr);
    let result: FaResultC = unsafe {
        (ffi.fa_align_samples)(
            handle.raw,
            samples.as_ptr(),
            samples.len(),
            c_text.as_ptr(),
            c_lang.as_ptr(),
            Some(progress_trampoline),
            cb_ptr as *mut c_void,
        )
    };
    log::info!(
        "[FA-FFI] fa_align_samples returned: success={}, n_words={}",
        result.success,
        result.n_words
    );

    let _drop_cb = if !cb_ptr.is_null() {
        Some(unsafe { Box::from_raw(cb_ptr) })
    } else {
        None
    };

    if !result.success {
        let err = unsafe {
            if result.error_msg.is_null() {
                "Unknown error".to_string()
            } else {
                std::ffi::CStr::from_ptr(result.error_msg)
                    .to_string_lossy()
                    .into_owned()
            }
        };
        unsafe { (ffi.fa_result_free)(&result as *const FaResultC as *mut FaResultC) };
        return Err(err);
    }

    let mut words = Vec::with_capacity(result.n_words);
    for i in 0..result.n_words {
        let w = unsafe { &*result.words.add(i) };
        let text = unsafe {
            if w.text.is_null() {
                String::new()
            } else {
                std::ffi::CStr::from_ptr(w.text)
                    .to_string_lossy()
                    .into_owned()
            }
        };
        words.push(AlignedWord {
            text,
            start: w.start,
            end: w.end,
        });
    }

    let timing = AlignTiming {
        mel_ms: result.t_mel_ms,
        encode_ms: result.t_encode_ms,
        decode_ms: result.t_decode_ms,
        total_ms: result.t_total_ms,
    };

    unsafe { (ffi.fa_result_free)(&result as *const FaResultC as *mut FaResultC) };

    Ok((words, timing))
}

/// Align `text` to the audio at `audio_path` using a loaded handle.
///
/// `progress_cb` is called with `(stage, progress, message)` during alignment.
pub fn align_audio(
    handle: &FaHandle,
    audio_path: &str,
    text: &str,
    language: &str,
    progress_cb: Option<ProgressCallback>,
) -> Result<(Vec<AlignedWord>, AlignTiming), String> {
    let ffi = get_ffi()?;

    let c_audio = CString::new(audio_path).map_err(|e| format!("Invalid audio path: {}", e))?;
    let c_text = CString::new(text).map_err(|e| format!("Invalid text: {}", e))?;
    let c_lang = CString::new(language).map_err(|e| format!("Invalid language: {}", e))?;

    log::info!(
        "[FA-FFI] fa_align_audio: audio={}, text_len={}, lang={}",
        audio_path,
        text.len(),
        language
    );

    // The progress callback needs to be passed through a raw pointer.
    // We box it on the heap and pass the pointer to the C code, which passes
    // it back to our trampoline function.
    let cb_ptr: *mut ProgressCallback = match progress_cb {
        Some(cb) => Box::into_raw(Box::new(cb)),
        None => std::ptr::null_mut(),
    };

    log::info!("[FA-FFI] calling fa_align_audio (cb_ptr={:p})...", cb_ptr);
    let result: FaResultC = unsafe {
        (ffi.fa_align_audio)(
            handle.raw,
            c_audio.as_ptr(),
            c_text.as_ptr(),
            c_lang.as_ptr(),
            Some(progress_trampoline),
            cb_ptr as *mut c_void,
        )
    };
    log::info!(
        "[FA-FFI] fa_align_audio returned: success={}, n_words={}",
        result.success,
        result.n_words
    );

    // Reclaim the callback box before returning
    let _drop_cb = if !cb_ptr.is_null() {
        Some(unsafe { Box::from_raw(cb_ptr) })
    } else {
        None
    };

    if !result.success {
        let err = unsafe {
            if result.error_msg.is_null() {
                "Unknown error".to_string()
            } else {
                std::ffi::CStr::from_ptr(result.error_msg)
                    .to_string_lossy()
                    .into_owned()
            }
        };
        // Free the result struct (even on error, in case storage was allocated)
        unsafe { (ffi.fa_result_free)(&result as *const FaResultC as *mut FaResultC) };
        return Err(err);
    }

    // Copy words out
    let mut words = Vec::with_capacity(result.n_words);
    for i in 0..result.n_words {
        let w = unsafe { &*result.words.add(i) };
        let text = unsafe {
            if w.text.is_null() {
                String::new()
            } else {
                std::ffi::CStr::from_ptr(w.text)
                    .to_string_lossy()
                    .into_owned()
            }
        };
        words.push(AlignedWord {
            text,
            start: w.start,
            end: w.end,
        });
    }

    let timing = AlignTiming {
        mel_ms: result.t_mel_ms,
        encode_ms: result.t_encode_ms,
        decode_ms: result.t_decode_ms,
        total_ms: result.t_total_ms,
    };

    // Free the C result
    unsafe { (ffi.fa_result_free)(&result as *const FaResultC as *mut FaResultC) };

    Ok((words, timing))
}

pub struct AlignTiming {
    pub mel_ms: i64,
    pub encode_ms: i64,
    pub decode_ms: i64,
    pub total_ms: i64,
}

/// Trampoline function passed to the C code. It receives a raw `user_data`
/// pointer (our boxed callback) and forwards the call.
unsafe extern "C" fn progress_trampoline(
    stage: *const c_char,
    progress: c_float,
    message: *const c_char,
    user_data: *mut c_void,
) {
    if user_data.is_null() {
        return;
    }
    let cb = &*(user_data as *const ProgressCallback);
    let stage_s = if stage.is_null() {
        "".to_string()
    } else {
        std::ffi::CStr::from_ptr(stage)
            .to_string_lossy()
            .into_owned()
    };
    let msg_s = if message.is_null() {
        "".to_string()
    } else {
        std::ffi::CStr::from_ptr(message)
            .to_string_lossy()
            .into_owned()
    };
    cb(&stage_s, progress, &msg_s);
}
