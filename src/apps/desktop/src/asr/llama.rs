use std::ffi::{c_char, c_float, c_void};
use std::os::raw::{c_int, c_uint};
use std::path::Path;
use std::sync::Arc;

/// llama.cpp b10369 的 llama_model_params ABI。
/// 注意：`load_mode`（替代旧版 use_mmap/use_direct_io/use_mlock 三个 bool）与
/// `load_mtp` 为新版新增；字段布局必须与 llama.h 严格一致，否则按值传参错位。
#[repr(C)]
pub struct llama_model_params {
    pub devices: *mut c_void,
    pub tensor_buft_overrides: *mut c_void,
    pub n_gpu_layers: c_int,
    pub split_mode: c_int,
    /// enum llama_load_mode: -1=Auto 0=None 1=Mmap 2=Mlock 3=MmapMlock 4=DirectIO
    pub load_mode: c_int,
    pub main_gpu: c_int,
    pub tensor_split: *mut c_float,
    pub progress_callback: *mut c_void,
    pub progress_callback_user_data: *mut c_void,
    pub kv_overrides: *mut c_void,
    pub vocab_only: bool,
    pub check_tensors: bool,
    pub use_extra_bufts: bool,
    pub no_host: bool,
    pub no_alloc: bool,
    pub load_mtp: bool,
}

/// llama.cpp b10369 的 llama_context_params ABI。
/// 注意：`n_outputs_max_per_seq` 为新版新增（位于 n_outputs_max 之后）；
/// 缺失会导致 flash_attn_type / embeddings / offload_kqv 等字段全部错位，
/// 曾引发 ASR/TTS 推理输出乱码。
#[repr(C)]
pub struct llama_context_params {
    pub n_ctx: c_uint,
    pub n_batch: c_uint,
    pub n_ubatch: c_uint,
    pub n_seq_max: c_uint,
    pub n_rs_seq: c_uint,
    pub n_outputs_max: c_uint,
    pub n_outputs_max_per_seq: c_uint,
    pub n_threads: c_int,
    pub n_threads_batch: c_int,
    pub ctx_type: c_int,
    pub rope_scaling_type: c_int,
    pub pooling_type: c_int,
    pub attention_type: c_int,
    pub flash_attn_type: c_int,
    pub rope_freq_base: c_float,
    pub rope_freq_scale: c_float,
    pub yarn_ext_factor: c_float,
    pub yarn_attn_factor: c_float,
    pub yarn_beta_fast: c_float,
    pub yarn_beta_slow: c_float,
    pub yarn_orig_ctx: c_uint,
    pub defrag_thold: c_float,
    pub cb_eval: *mut c_void,
    pub cb_eval_user_data: *mut c_void,
    pub type_k: c_int,
    pub type_v: c_int,
    pub abort_callback: *mut c_void,
    pub abort_callback_data: *mut c_void,
    pub embeddings: bool,
    pub offload_kqv: bool,
    pub no_perf: bool,
    pub op_offload: bool,
    pub swa_full: bool,
    pub kv_unified: bool,
    pub samplers: *mut c_void,
    pub n_samplers: usize,
    pub ctx_other: *mut c_void,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct llama_batch {
    pub n_tokens: c_int,
    pub token: *mut c_int,
    pub embd: *mut c_float,
    pub pos: *mut c_int,
    pub n_seq_id: *mut c_int,
    pub seq_id: *mut *mut c_int,
    pub logits: *mut i8,
}

pub type LlamaToken = c_int;
pub type LlamaModelPtr = *mut c_void;
pub type LlamaContextPtr = *mut c_void;
pub type LlamaVocabPtr = *mut c_void;
pub type LlamaSamplerPtr = *mut c_void;

type LlamaBackendInitFn = unsafe extern "C" fn();
type LlamaBackendFreeFn = unsafe extern "C" fn();
type LlamaModelDefaultParamsFn = unsafe extern "C" fn() -> llama_model_params;
type LlamaModelLoadFromFileFn =
    unsafe extern "C" fn(*const c_char, llama_model_params) -> LlamaModelPtr;
type LlamaModelFreeFn = unsafe extern "C" fn(LlamaModelPtr);
type LlamaModelGetVocabFn = unsafe extern "C" fn(LlamaModelPtr) -> LlamaVocabPtr;
type LlamaModelNEmbdfn = unsafe extern "C" fn(LlamaModelPtr) -> c_int;
type LlamaModelNHeadFn = unsafe extern "C" fn(LlamaModelPtr) -> c_int;
type LlamaModelNLayerFn = unsafe extern "C" fn(LlamaModelPtr) -> c_int;
type LlamaModelNCtxFn = unsafe extern "C" fn() -> c_int;
type LlamaModelNVocabFn = unsafe extern "C" fn() -> c_int;
type LlamaVocabNTokensFn = unsafe extern "C" fn(LlamaVocabPtr) -> c_int;
type LlamaVocabEosFn = unsafe extern "C" fn(LlamaVocabPtr) -> LlamaToken;
type LlamaContextDefaultParamsFn = unsafe extern "C" fn() -> llama_context_params;
type LlamaInitFromModelFn =
    unsafe extern "C" fn(LlamaModelPtr, llama_context_params) -> LlamaContextPtr;
type LlamaFreeFn = unsafe extern "C" fn(LlamaContextPtr);
type LlamaBatchInitFn = unsafe extern "C" fn(c_int, c_int, c_int) -> llama_batch;
type LlamaBatchFreeFn = unsafe extern "C" fn(llama_batch);
type LlamaBatchGetOneFn = unsafe extern "C" fn(*const LlamaToken, c_int) -> llama_batch;
type LlamaDecodeFn = unsafe extern "C" fn(LlamaContextPtr, llama_batch) -> c_int;
type LlamaGetEmbeddingsFn = unsafe extern "C" fn(LlamaContextPtr) -> *mut c_float;
type LlamaGetLogitsFn = unsafe extern "C" fn(LlamaContextPtr) -> *mut c_float;
type LlamaGetMemoryFn = unsafe extern "C" fn(LlamaContextPtr) -> *mut c_void;
type LlamaMemoryClearFn = unsafe extern "C" fn(*mut c_void, bool);
type LlamaMemorySeqRmFn = unsafe extern "C" fn(*mut c_void, c_int, c_int, c_int) -> bool;
type LlamaMemorySeqPosMaxFn = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type LlamaSamplerInitTempFn = unsafe extern "C" fn(c_float) -> LlamaSamplerPtr;
type LlamaSamplerSampleFn =
    unsafe extern "C" fn(LlamaSamplerPtr, LlamaContextPtr, c_int) -> LlamaToken;
type LlamaSamplerFreeFn = unsafe extern "C" fn(LlamaSamplerPtr);
type GgmlBackendLoadAllFn = unsafe extern "C" fn();
type LlamaTokenizeFn = unsafe extern "C" fn(
    LlamaVocabPtr,
    *const u8,
    c_int,
    *mut LlamaToken,
    c_int,
    bool,
    bool,
) -> c_int;
type LlamaTokenToPieceFn =
    unsafe extern "C" fn(LlamaVocabPtr, LlamaToken, *mut c_char, c_int, c_int, bool) -> c_int;

pub struct LlamaFFI {
    pub llama_backend_init: LlamaBackendInitFn,
    pub llama_backend_free: LlamaBackendFreeFn,
    pub llama_model_default_params: LlamaModelDefaultParamsFn,
    pub llama_model_load_from_file: LlamaModelLoadFromFileFn,
    pub llama_model_free: LlamaModelFreeFn,
    pub llama_model_get_vocab: LlamaModelGetVocabFn,
    pub llama_model_n_embd: LlamaModelNEmbdfn,
    pub llama_model_n_head: LlamaModelNHeadFn,
    pub llama_model_n_layer: LlamaModelNLayerFn,
    pub llama_model_n_ctx: LlamaModelNCtxFn,
    pub llama_model_n_vocab: LlamaModelNVocabFn,
    pub llama_vocab_n_tokens: LlamaVocabNTokensFn,
    pub llama_vocab_eos: LlamaVocabEosFn,
    pub llama_context_default_params: LlamaContextDefaultParamsFn,
    pub llama_init_from_model: LlamaInitFromModelFn,
    pub llama_free: LlamaFreeFn,
    pub llama_batch_init: LlamaBatchInitFn,
    pub llama_batch_free: LlamaBatchFreeFn,
    pub llama_batch_get_one: LlamaBatchGetOneFn,
    pub llama_decode: LlamaDecodeFn,
    pub llama_get_embeddings: LlamaGetEmbeddingsFn,
    pub llama_get_logits: LlamaGetLogitsFn,
    pub llama_get_memory: LlamaGetMemoryFn,
    pub llama_memory_clear: LlamaMemoryClearFn,
    pub llama_memory_seq_rm: LlamaMemorySeqRmFn,
    pub llama_memory_seq_pos_max: LlamaMemorySeqPosMaxFn,
    pub llama_sampler_init_temp: LlamaSamplerInitTempFn,
    pub llama_sampler_sample: LlamaSamplerSampleFn,
    pub llama_sampler_free: LlamaSamplerFreeFn,
    pub ggml_backend_load_all: GgmlBackendLoadAllFn,
    pub llama_tokenize: LlamaTokenizeFn,
    pub llama_token_to_piece: LlamaTokenToPieceFn,
}

static FFI: std::sync::OnceLock<Result<LlamaFFI, String>> = std::sync::OnceLock::new();

pub fn get_ffi() -> Result<&'static LlamaFFI, String> {
    FFI.get_or_init(|| unsafe {
        let ort_path = super::dylib::get_runtime_dir();
        let llama_dir = super::dylib::get_llama_runtime_dir();
        let _ = super::dylib::set_library_search_path();

        let backend = crate::runtime::init::get_active_backend();
        log::info!("[LlamaFFI] Loading FFI with backend: {}", backend);

        let (ggml_name, llama_name, libomp_name) = if cfg!(target_os = "windows") {
            ("ggml.dll", "llama.dll", Some("libomp140.x86_64.dll"))
        } else if cfg!(target_os = "macos") {
            ("libggml.dylib", "libllama.dylib", None)
        } else {
            ("libggml.so", "libllama.so", None)
        };

        if let Some(omp_name) = libomp_name {
            let libomp_path = llama_dir.join(omp_name);
            if !libomp_path.exists() {
                let libomp_alt = ort_path.join(omp_name);
                if libomp_alt.exists() {
                    let _libomp = libloading::Library::new(&libomp_alt).ok();
                }
            } else {
                let _libomp = libloading::Library::new(&libomp_path).ok();
            }
        }

        if backend.starts_with("cuda") && cfg!(target_os = "windows") {
            let cudart_path = llama_dir.join("cudart64_12.dll");
            if cudart_path.exists() {
                log::info!("[LlamaFFI] Loading CUDA runtime: {}", cudart_path.display());
                match libloading::Library::new(&cudart_path) {
                    Ok(cudart_lib) => {
                        std::mem::forget(cudart_lib);
                        log::info!("[LlamaFFI] CUDA runtime loaded successfully");
                    }
                    Err(e) => {
                        log::warn!("[LlamaFFI] Failed to load CUDA runtime: {}", e);
                    }
                }
            } else {
                log::warn!(
                    "[LlamaFFI] CUDA runtime not found at: {}",
                    cudart_path.display()
                );
            }

            let cublas_path = llama_dir.join("cublas64_12.dll");
            if cublas_path.exists() {
                match libloading::Library::new(&cublas_path) {
                    Ok(cublas_lib) => {
                        std::mem::forget(cublas_lib);
                        log::info!("[LlamaFFI] cuBLAS loaded successfully");
                    }
                    Err(e) => {
                        log::warn!("[LlamaFFI] Failed to load cuBLAS: {}", e);
                    }
                }
            }

            let cublasLt_path = llama_dir.join("cublasLt64_12.dll");
            if cublasLt_path.exists() {
                match libloading::Library::new(&cublasLt_path) {
                    Ok(cublasLt_lib) => {
                        std::mem::forget(cublasLt_lib);
                        log::info!("[LlamaFFI] cuBLASLt loaded successfully");
                    }
                    Err(e) => {
                        log::warn!("[LlamaFFI] Failed to load cuBLASLt: {}", e);
                    }
                }
            }
        }

        // GGML DLLs live in the shared runtime/gguf/ directory.
        // Fallback to llama_dir for legacy layouts.
        let gguf_dir = crate::runtime::init::find_gguf_lib_dir();
        let resolve_ggml = |name: &str| -> Option<std::path::PathBuf> {
            if let Some(ref gguf) = gguf_dir {
                let p = gguf.join(name);
                if p.exists() {
                    return Some(p);
                }
            }
            let p = llama_dir.join(name);
            if p.exists() {
                Some(p)
            } else {
                None
            }
        };

        let ggml_path = resolve_ggml(ggml_name);

        let llama_path = llama_dir.join(llama_name);
        if !llama_path.exists() {
            return Err(format!(
                "{} not found at: {}",
                llama_name,
                llama_path.display()
            ));
        }
        let lib = libloading::Library::new(&llama_path)
            .map_err(|e| format!("Failed to load {}: {}", llama_name, e))?;

        let ggml_lib = ggml_path
            .as_ref()
            .and_then(|p| libloading::Library::new(p).ok());

        if backend.starts_with("cuda") {
            let ggml_cuda_name = if cfg!(target_os = "windows") {
                "ggml-cuda.dll"
            } else if cfg!(target_os = "macos") {
                "libggml-cuda.dylib"
            } else {
                "libggml-cuda.so"
            };
            let ggml_cuda_path = resolve_ggml(ggml_cuda_name);
            if let Some(ref cuda_path) = ggml_cuda_path {
                log::info!("[LlamaFFI] Loading CUDA backend: {}", cuda_path.display());
                match libloading::Library::new(cuda_path) {
                    Ok(cuda_lib) => {
                        std::mem::forget(cuda_lib);
                        log::info!("[LlamaFFI] CUDA backend loaded successfully");
                    }
                    Err(e) => {
                        log::warn!("[LlamaFFI] Failed to load CUDA backend: {}", e);
                    }
                }
            } else {
                log::warn!("[LlamaFFI] CUDA backend not found in acestep or llama dirs");
            }
        }

        unsafe extern "C" fn dummy_fn() {}

        let load_all_fn: GgmlBackendLoadAllFn = if let Some(ref glib) = ggml_lib {
            match glib.get(b"ggml_backend_load_all") {
                Ok(symbol) => *symbol,
                Err(_) => dummy_fn,
            }
        } else {
            lib.get(b"ggml_backend_load_all")
                .map(|s| *s)
                .unwrap_or(dummy_fn)
        };

        macro_rules! resolve {
            ($lib:expr, $name:expr) => {
                *$lib
                    .get($name)
                    .map_err(|_| format!("Failed to resolve symbol: {}", stringify!($name)))?
            };
        }

        let ffi = LlamaFFI {
            llama_backend_init: resolve!(lib, b"llama_backend_init"),
            llama_backend_free: resolve!(lib, b"llama_backend_free"),
            llama_model_default_params: resolve!(lib, b"llama_model_default_params"),
            llama_model_load_from_file: resolve!(lib, b"llama_model_load_from_file"),
            llama_model_free: resolve!(lib, b"llama_model_free"),
            llama_model_get_vocab: resolve!(lib, b"llama_model_get_vocab"),
            llama_model_n_embd: resolve!(lib, b"llama_model_n_embd"),
            llama_model_n_head: resolve!(lib, b"llama_model_n_head"),
            llama_model_n_layer: resolve!(lib, b"llama_model_n_layer"),
            llama_model_n_ctx: resolve!(lib, b"llama_n_ctx"),
            llama_model_n_vocab: resolve!(lib, b"llama_n_vocab"),
            llama_vocab_n_tokens: resolve!(lib, b"llama_vocab_n_tokens"),
            llama_vocab_eos: resolve!(lib, b"llama_vocab_eos"),
            llama_context_default_params: resolve!(lib, b"llama_context_default_params"),
            llama_init_from_model: resolve!(lib, b"llama_init_from_model"),
            llama_free: resolve!(lib, b"llama_free"),
            llama_batch_init: resolve!(lib, b"llama_batch_init"),
            llama_batch_free: resolve!(lib, b"llama_batch_free"),
            llama_batch_get_one: resolve!(lib, b"llama_batch_get_one"),
            llama_decode: resolve!(lib, b"llama_decode"),
            llama_get_embeddings: resolve!(lib, b"llama_get_embeddings"),
            llama_get_logits: resolve!(lib, b"llama_get_logits"),
            llama_get_memory: resolve!(lib, b"llama_get_memory"),
            llama_memory_clear: resolve!(lib, b"llama_memory_clear"),
            llama_memory_seq_rm: resolve!(lib, b"llama_memory_seq_rm"),
            llama_memory_seq_pos_max: resolve!(lib, b"llama_memory_seq_pos_max"),
            llama_sampler_init_temp: resolve!(lib, b"llama_sampler_init_temp"),
            llama_sampler_sample: resolve!(lib, b"llama_sampler_sample"),
            llama_sampler_free: resolve!(lib, b"llama_sampler_free"),
            ggml_backend_load_all: load_all_fn,
            llama_tokenize: resolve!(lib, b"llama_tokenize"),
            llama_token_to_piece: resolve!(lib, b"llama_token_to_piece"),
        };

        let original_cwd = std::env::current_dir().ok();
        if original_cwd.is_some() {
            let _ = std::env::set_current_dir(&llama_dir);
        }

        (ffi.ggml_backend_load_all)();
        log::info!(
            "[LlamaFFI] ggml_backend_load_all done (backend: {})",
            backend
        );
        (ffi.llama_backend_init)();
        log::info!("[LlamaFFI] llama_backend_init done");

        if let Some(cwd) = original_cwd {
            let _ = std::env::set_current_dir(cwd);
        }

        std::mem::forget(lib);
        if let Some(glib) = ggml_lib {
            std::mem::forget(glib);
        }
        Ok(ffi)
    })
    .as_ref()
    .map_err(|e| e.clone())
}

pub fn cleanup() {
    if let Some(Ok(ffi)) = FFI.get() {
        unsafe {
            (ffi.llama_backend_free)();
        }
    }
}

pub struct LlamaModel {
    pub ptr: LlamaModelPtr,
    pub vocab: LlamaVocabPtr,
    pub n_embd: usize,
    pub n_head: usize,
    pub n_layer: usize,
    pub n_ctx: usize,
    pub n_vocab: usize,
    pub eos_token: LlamaToken,
    _not_clone: std::marker::PhantomData<()>,
}

unsafe impl Send for LlamaModel {}
unsafe impl Sync for LlamaModel {}

impl LlamaModel {
    pub fn load(path: &Path, n_gpu_layers: i32) -> Result<Self, String> {
        let ffi = get_ffi()?;
        let c_path = std::ffi::CString::new(
            path.to_str()
                .ok_or_else(|| "Invalid path: non-UTF8".to_string())?,
        )
        .map_err(|e| e.to_string())?;

        log::info!(
            "[LlamaModel] Loading model from: {:?}, n_gpu_layers: {}",
            path,
            n_gpu_layers
        );

        let try_load = |use_mmap: bool| -> Option<LlamaModelPtr> {
            unsafe {
                let mut params = (ffi.llama_model_default_params)();
                params.n_gpu_layers = n_gpu_layers;
                params.split_mode = 0;
                // llama.cpp b10369: use_mmap/use_mlock bools → enum llama_load_mode
                // 1=Mmap, 0=None
                params.load_mode = if use_mmap { 1 } else { 0 };
                let ptr = (ffi.llama_model_load_from_file)(c_path.as_ptr(), params);
                if ptr.is_null() {
                    None
                } else {
                    Some(ptr)
                }
            }
        };

        let max_rounds = 3;
        let mut last_round = 1;
        for round in 1..=max_rounds {
            if round > 1 {
                log::warn!(
                    "[LlamaModel] Full load retry round {}/{}, waiting 3s...",
                    round,
                    max_rounds
                );
                std::thread::sleep(std::time::Duration::from_secs(3));
            }
            match try_load(true) {
                Some(p) => {
                    log::info!("[LlamaModel] Loaded with use_mmap=true (round {})", round);
                    return unsafe {
                        let vocab = (ffi.llama_model_get_vocab)(p);
                        let n_vocab = (ffi.llama_vocab_n_tokens)(vocab) as usize;
                        let n_embd = (ffi.llama_model_n_embd)(p) as usize;
                        let n_head = (ffi.llama_model_n_head)(p) as usize;
                        let n_layer = (ffi.llama_model_n_layer)(p) as usize;
                        let eos_token = (ffi.llama_vocab_eos)(vocab);
                        Ok(Self {
                            ptr: p,
                            vocab,
                            n_embd,
                            n_head,
                            n_layer,
                            n_ctx: 0,
                            n_vocab,
                            eos_token,
                            _not_clone: std::marker::PhantomData,
                        })
                    };
                }
                None => {
                    log::warn!(
                        "[LlamaModel] use_mmap=true failed (round {}), trying use_mmap=false after 1s...",
                        round
                    );
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    match try_load(false) {
                        Some(p) => {
                            log::info!("[LlamaModel] Loaded with use_mmap=false (round {})", round);
                            return unsafe {
                                let vocab = (ffi.llama_model_get_vocab)(p);
                                let n_vocab = (ffi.llama_vocab_n_tokens)(vocab) as usize;
                                let n_embd = (ffi.llama_model_n_embd)(p) as usize;
                                let n_head = (ffi.llama_model_n_head)(p) as usize;
                                let n_layer = (ffi.llama_model_n_layer)(p) as usize;
                                let eos_token = (ffi.llama_vocab_eos)(vocab);
                                Ok(Self {
                                    ptr: p,
                                    vocab,
                                    n_embd,
                                    n_head,
                                    n_layer,
                                    n_ctx: 0,
                                    n_vocab,
                                    eos_token,
                                    _not_clone: std::marker::PhantomData,
                                })
                            };
                        }
                        None => {
                            last_round = round;
                            log::warn!(
                                "[LlamaModel] Both mmap=true and mmap=false failed (round {}/{})",
                                round,
                                max_rounds
                            );
                        }
                    }
                }
            };
        }

        Err(format!(
            "Failed to load model from: {:?} (n_gpu_layers={}) after {} rounds. Both mmap=true and mmap=false returned null.",
            path, n_gpu_layers, last_round
        ))
    }

    pub fn tokenize(&self, text: &str, add_special: bool, parse_special: bool) -> Vec<i32> {
        let ffi = get_ffi().expect("FFI not initialized");
        let text_bytes = text.as_bytes();
        let mut tokens = vec![0i32; text.len() + 64];

        unsafe {
            let n = (ffi.llama_tokenize)(
                self.vocab,
                text_bytes.as_ptr(),
                text_bytes.len() as c_int,
                tokens.as_mut_ptr(),
                tokens.len() as c_int,
                add_special,
                parse_special,
            );

            if n > 0 {
                tokens.truncate(n as usize);
            } else {
                tokens.clear();
            }
        }

        tokens
    }

    pub fn token_to_piece(&self, token_id: i32) -> Option<String> {
        let ffi = get_ffi().expect("FFI not initialized");
        let mut buf = vec![0i8; 256];

        unsafe {
            let n = (ffi.llama_token_to_piece)(
                self.vocab,
                token_id,
                buf.as_mut_ptr(),
                buf.len() as c_int,
                0,
                true,
            );

            if n > 0 {
                let bytes = std::slice::from_raw_parts(buf.as_ptr() as *const u8, n as usize);
                Some(String::from_utf8_lossy(bytes).into_owned())
            } else {
                None
            }
        }
    }

    pub fn token_to_piece_bytes(&self, token_id: i32) -> Option<Vec<u8>> {
        let ffi = get_ffi().expect("FFI not initialized");
        let mut buf = vec![0i8; 256];

        unsafe {
            let n = (ffi.llama_token_to_piece)(
                self.vocab,
                token_id,
                buf.as_mut_ptr(),
                buf.len() as c_int,
                0,
                true,
            );

            if n > 0 {
                let bytes = std::slice::from_raw_parts(buf.as_ptr() as *const u8, n as usize);
                Some(bytes.to_vec())
            } else {
                None
            }
        }
    }
}

impl Drop for LlamaModel {
    fn drop(&mut self) {
        unsafe {
            if let Some(Ok(ffi)) = FFI.get() {
                if !self.ptr.is_null() {
                    (ffi.llama_model_free)(self.ptr);
                }
            }
        }
    }
}

pub struct LlamaContext {
    pub ptr: LlamaContextPtr,
    pub model: Arc<LlamaModel>,
    pub n_tokens: std::cell::Cell<i32>,
}

unsafe impl Send for LlamaContext {}
unsafe impl Sync for LlamaContext {}

impl LlamaContext {
    pub fn new(
        model: &Arc<LlamaModel>,
        n_ctx: u32,
        n_batch: u32,
        embeddings: i32,
        n_threads: i32,
    ) -> Result<Self, String> {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            let mut params = (ffi.llama_context_default_params)();
            params.n_ctx = n_ctx;
            params.n_batch = n_batch;
            params.n_ubatch = n_batch;
            params.n_seq_max = 1;
            params.embeddings = embeddings != 0;
            params.flash_attn_type = 1;
            params.offload_kqv = true;
            params.no_perf = true;
            params.n_threads = n_threads;
            params.n_threads_batch = n_threads;

            let ptr = (ffi.llama_init_from_model)(model.ptr, params);
            if ptr.is_null() {
                return Err("Failed to create context".to_string());
            }
            Ok(Self {
                ptr,
                model: Arc::clone(model),
                n_tokens: std::cell::Cell::new(0),
            })
        }
    }

    pub fn decode(&mut self, batch: &mut LlamaBatch) -> Result<(), String> {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            let result = (ffi.llama_decode)(self.ptr, batch.batch);
            if result != 0 {
                return Err(format!("llama_decode failed: {}", result));
            }
            self.n_tokens
                .set(self.n_tokens.get() + batch.batch.n_tokens);
            Ok(())
        }
    }

    #[allow(clippy::needless_range_loop)]
    pub fn decode_tokens(&mut self, tokens: &[LlamaToken]) -> Result<(), String> {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            let pos = self.n_tokens.get();
            let n = tokens.len() as c_int;

            // llama_batch_get_one returns nullptr for pos, n_seq_id, seq_id
            // We need to use llama_batch_init to get proper batch with allocated arrays
            let mut batch = (ffi.llama_batch_init)(n, 0, 1);

            for i in 0..n as usize {
                *batch.token.add(i) = tokens[i];
                *batch.pos.add(i) = pos + i as c_int;
                *batch.n_seq_id.add(i) = 1;
                let seq_ids = *batch.seq_id.add(i);
                *seq_ids = 0;
                *batch.logits.add(i) = 0;
            }
            // Set logits for last token
            if n > 0 {
                *batch.logits.add(n as usize - 1) = 1;
            }
            batch.n_tokens = n;

            let result = (ffi.llama_decode)(self.ptr, batch);
            (ffi.llama_batch_free)(batch);

            if result != 0 {
                return Err(format!("llama_decode failed: {}", result));
            }
            self.n_tokens.set(pos + n);
            Ok(())
        }
    }

    pub fn decode_token(&mut self, token: i32) -> Result<(), String> {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            let pos = self.n_tokens.get();

            let mut batch = (ffi.llama_batch_init)(1, 0, 1);
            *batch.token = token;
            *batch.pos = pos;
            *batch.n_seq_id = 1;
            let seq_ids = *batch.seq_id;
            *seq_ids = 0;
            *batch.logits = 1;
            batch.n_tokens = 1;

            let result = (ffi.llama_decode)(self.ptr, batch);
            (ffi.llama_batch_free)(batch);

            if result != 0 {
                return Err(format!("llama_decode failed: {}", result));
            }
            self.n_tokens.set(pos + 1);
            Ok(())
        }
    }

    pub fn get_embeddings(&self) -> &[f32] {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            std::slice::from_raw_parts((ffi.llama_get_embeddings)(self.ptr), self.model.n_embd)
        }
    }

    pub fn get_embedding_at(&self, batch_index: usize) -> &[f32] {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            let base_ptr = (ffi.llama_get_embeddings)(self.ptr);
            let offset = batch_index * self.model.n_embd;
            std::slice::from_raw_parts(base_ptr.add(offset), self.model.n_embd)
        }
    }

    pub fn get_logits(&self) -> &[f32] {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe { std::slice::from_raw_parts((ffi.llama_get_logits)(self.ptr), self.model.n_vocab) }
    }

    pub fn get_logits_ith(&self, i: usize) -> &[f32] {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            let base_ptr = (ffi.llama_get_logits)(self.ptr);
            std::slice::from_raw_parts(base_ptr.add(i * self.model.n_vocab), self.model.n_vocab)
        }
    }

    pub fn clear_kv_cache(&self) -> bool {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            let mem = (ffi.llama_get_memory)(self.ptr);
            (ffi.llama_memory_seq_rm)(mem, -1, 0, -1)
        }
    }

    pub fn debug_seq_pos_max(&self, seq_id: c_int) -> c_int {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            let mem = (ffi.llama_get_memory)(self.ptr);
            (ffi.llama_memory_seq_pos_max)(mem, seq_id)
        }
    }
}

impl Drop for LlamaContext {
    fn drop(&mut self) {
        unsafe {
            if let Some(Ok(ffi)) = FFI.get() {
                if !self.ptr.is_null() {
                    (ffi.llama_free)(self.ptr);
                }
            }
        }
    }
}

pub struct LlamaBatch {
    batch: llama_batch,
    n_tokens_max: usize,
    n_embd: usize,
    _n_pos_per_embd: usize,
    _embd_buffer: Vec<c_float>,
    _pos_buffer: Vec<c_int>,
    _seq_id_buffers: Vec<Vec<c_int>>,
    _n_seq_id_buffer: Vec<c_int>,
    _logits_buffer: Vec<i8>,
}

impl LlamaBatch {
    pub fn new(
        n_tokens_max: usize,
        n_embd: usize,
        n_seq_max: usize,
        n_pos_per_embd: usize,
    ) -> Self {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            let batch =
                (ffi.llama_batch_init)(n_tokens_max as c_int, n_embd as c_int, n_seq_max as c_int);

            Self {
                batch,
                n_tokens_max,
                n_embd,
                _n_pos_per_embd: n_pos_per_embd,
                _embd_buffer: Vec::new(),
                _pos_buffer: Vec::new(),
                _seq_id_buffers: Vec::new(),
                _n_seq_id_buffer: Vec::new(),
                _logits_buffer: Vec::new(),
            }
        }
    }

    pub fn set_embd(&mut self, prompt_embeds: &[f32], pos_arr: &[i32], seq_id: i32) {
        let n_tokens = prompt_embeds.len() / self.n_embd;
        unsafe {
            std::ptr::copy_nonoverlapping(
                prompt_embeds.as_ptr(),
                self.batch.embd,
                prompt_embeds.len(),
            );

            let max_pos = self.n_tokens_max;

            if pos_arr.len() > max_pos {
                // eprintln!(
                //     "WARNING: pos_arr length {} exceeds batch capacity {}. Truncating!",
                //     pos_arr.len(),
                //     max_pos
                // );
            }
            std::ptr::copy_nonoverlapping(
                pos_arr.as_ptr(),
                self.batch.pos,
                pos_arr.len().min(max_pos),
            );
        }

        for i in 0..n_tokens {
            unsafe {
                *self.batch.n_seq_id.add(i) = 1;

                let seq_ids = *self.batch.seq_id.add(i);
                *seq_ids.add(0) = seq_id;

                *self.batch.logits.add(i) = if i == n_tokens - 1 { 1 } else { 0 };
            }
        }
        self.batch.n_tokens = n_tokens as c_int;
    }

    pub fn clear(&mut self) {
        self.batch.n_tokens = 0;
    }

    pub fn n_tokens(&self) -> usize {
        self.batch.n_tokens as usize
    }

    pub fn batch_ptr(&mut self) -> *mut llama_batch {
        &mut self.batch
    }
}

impl Drop for LlamaBatch {
    fn drop(&mut self) {
        if let Some(Ok(ffi)) = FFI.get() {
            unsafe {
                (ffi.llama_batch_free)(self.batch);
            }
        }
    }
}

pub struct LlamaSampler {
    _ptr: LlamaSamplerPtr,
    n_vocab: usize,
    temperature: f32,
    top_k: usize,
    top_p: f32,
    min_p: f32,
    repeat_penalty: f32,
    frequency_penalty: f32,
    presence_penalty: f32,
    penalty_last_n: usize,
    rng: std::cell::RefCell<rand::rngs::StdRng>,
    candidates_buf: std::cell::RefCell<Vec<(usize, f32)>>,
}

impl LlamaSampler {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        n_vocab: usize,
        temperature: f32,
        top_k: i32,
        top_p: f32,
        min_p: f32,
        repeat_penalty: f32,
        frequency_penalty: f32,
        presence_penalty: f32,
        penalty_last_n: usize,
        seed: u64,
    ) -> Self {
        use rand::SeedableRng;
        Self {
            _ptr: std::ptr::null_mut(),
            n_vocab,
            temperature,
            top_k: top_k as usize,
            top_p,
            min_p,
            repeat_penalty,
            frequency_penalty,
            presence_penalty,
            penalty_last_n,
            rng: std::cell::RefCell::new(rand::rngs::StdRng::seed_from_u64(seed)),
            candidates_buf: std::cell::RefCell::new(Vec::with_capacity(n_vocab)),
        }
    }

    pub fn greedy(n_vocab: usize) -> Self {
        use rand::SeedableRng;
        Self {
            _ptr: std::ptr::null_mut(),
            n_vocab,
            temperature: 0.0,
            top_k: 0,
            top_p: 1.0,
            min_p: 0.0,
            repeat_penalty: 1.0,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
            penalty_last_n: 64,
            rng: std::cell::RefCell::new(rand::rngs::StdRng::seed_from_u64(42)),
            candidates_buf: std::cell::RefCell::new(Vec::with_capacity(n_vocab)),
        }
    }

    pub fn with_min_p(mut self, min_p: f32) -> Self {
        self.min_p = min_p;
        self
    }

    pub fn set_temperature(&mut self, temp: f32) {
        self.temperature = temp;
    }

    pub fn set_repeat_penalty(&mut self, penalty: f32) {
        self.repeat_penalty = penalty;
    }
}

impl LlamaSampler {
    /// top_k 过滤：保留 logit 最高的 k 个 token
    /// 参考 llama-sampling.cpp 的 llama_sampler_top_k_apply
    fn apply_top_k(candidates: &mut Vec<(usize, f32)>, k: usize) {
        if k == 0 || k >= candidates.len() {
            return;
        }
        candidates.select_nth_unstable_by(k - 1, |a, b| {
            b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(k);
    }

    /// top_p (nucleus) 过滤：先 softmax 计算概率，然后累积概率截断
    /// 参考 llama-sampling.cpp 第 1378-1431 行
    /// 注意：candidates 在调用前应该已经按 logit 降序排序
    fn apply_top_p(candidates: &mut Vec<(usize, f32)>, p: f32) {
        if p >= 1.0 || candidates.is_empty() {
            return;
        }

        let max_logit = candidates
            .iter()
            .map(|(_, l)| *l)
            .fold(f32::NEG_INFINITY, f32::max);

        let mut sum: f64 = 0.0;
        for (_, logit) in candidates.iter_mut() {
            let prob = (*logit - max_logit).exp() as f64;
            *logit = prob as f32;
            sum += prob;
        }

        let inv_sum = 1.0 / sum;
        for (_, prob) in candidates.iter_mut() {
            *prob = (*prob as f64 * inv_sum) as f32;
        }

        let mut cumsum: f32 = 0.0;
        let mut cutoff_idx = candidates.len();
        for (i, (_, prob)) in candidates.iter().enumerate() {
            cumsum += *prob;
            if cumsum >= p {
                cutoff_idx = i + 1;
                break;
            }
        }
        candidates.truncate(cutoff_idx);
    }

    /// min_p 过滤：在 logit 空间执行
    /// 参考 llama-sampling.cpp 第 1570-1622 行
    /// 计算 min_logit = max_logit + log(p)，过滤 logit < min_logit 的 token
    fn apply_min_p(candidates: &mut Vec<(usize, f32)>, p: f32) {
        if p <= 0.0 || candidates.is_empty() {
            return;
        }

        let max_logit = candidates
            .iter()
            .map(|(_, l)| *l)
            .fold(f32::NEG_INFINITY, f32::max);

        let min_logit = max_logit + p.ln();

        candidates.retain(|(_, logit)| *logit >= min_logit);
    }

    /// 温度缩放：在 logit 空间执行
    /// 参考 llama-sampling.cpp 的 llama_sampler_temp_apply
    fn apply_temp(candidates: &mut [(usize, f32)], temp: f32) {
        if temp == 1.0 || candidates.is_empty() {
            return;
        }

        let inv_temp = 1.0 / temp;
        for (_, logit) in candidates.iter_mut() {
            *logit *= inv_temp;
        }
    }

    /// 随机采样：从概率分布中采样一个 token
    /// 参考 llama-sampling.cpp 第 1076-1101 行
    /// 使用 sum_tgt = sum_cum * rnd 方法
    fn sample_dist(candidates: &[(usize, f32)], rng: &mut rand::rngs::StdRng) -> usize {
        use rand::Rng;

        if candidates.is_empty() {
            return 0;
        }

        if candidates.len() == 1 {
            return candidates[0].0;
        }

        let max_logit = candidates
            .iter()
            .map(|(_, l)| *l)
            .fold(f32::NEG_INFINITY, f32::max);

        let mut sum_cum: f64 = 0.0;
        for (_, logit) in candidates.iter() {
            let prob = (*logit - max_logit).exp() as f64;
            sum_cum += prob;
        }

        let rnd: f64 = rng.gen();
        let sum_tgt = sum_cum * rnd;

        let mut sum_run: f64 = 0.0;
        for (idx, logit) in candidates.iter() {
            let prob = (*logit - max_logit).exp() as f64;
            sum_run += prob;
            if sum_run >= sum_tgt {
                return *idx;
            }
        }

        candidates.last().map(|(idx, _)| *idx).unwrap_or(0)
    }

    pub fn sample(
        &self,
        ctx: &LlamaContext,
        idx: i32,
        limit_start: Option<usize>,
        limit_end: Option<usize>,
    ) -> LlamaToken {
        self.sample_with_allow(ctx, idx, limit_start, limit_end, None, None)
    }

    #[allow(clippy::needless_range_loop)]
    pub fn sample_with_allow(
        &self,
        ctx: &LlamaContext,
        _idx: i32,
        limit_start: Option<usize>,
        limit_end: Option<usize>,
        allow_tokens: Option<&[LlamaToken]>,
        history: Option<&[LlamaToken]>,
    ) -> LlamaToken {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            let base_ptr = (ffi.llama_get_logits)(ctx.ptr);
            if base_ptr.is_null() {
                eprintln!("[Sampler] ERROR: llama_get_logits returned null!");
                return 0;
            }
            let logits_raw = std::slice::from_raw_parts(base_ptr, self.n_vocab);

            let start = limit_start.unwrap_or(0);
            let end = limit_end.unwrap_or(self.n_vocab).min(self.n_vocab);

            let mut counts = std::collections::HashMap::new();
            let use_penalty = (self.repeat_penalty != 1.0
                || self.frequency_penalty != 0.0
                || self.presence_penalty != 0.0)
                && history.is_some();

            if use_penalty {
                if let Some(hist) = history {
                    let start_idx = if hist.len() > self.penalty_last_n {
                        hist.len() - self.penalty_last_n
                    } else {
                        0
                    };
                    for &token in &hist[start_idx..] {
                        *counts.entry(token).or_insert(0) += 1;
                    }
                }
            }

            if self.temperature <= 0.0 {
                let mut max_val = f32::NEG_INFINITY;
                let mut max_idx = start;

                for i in start..end {
                    let mut logit = logits_raw[i];
                    if use_penalty {
                        if let Some(&count) = counts.get(&(i as i32)) {
                            if self.frequency_penalty != 0.0 {
                                logit -= self.frequency_penalty * count as f32;
                            }
                            if self.presence_penalty != 0.0 {
                                logit -= self.presence_penalty;
                            }
                            if self.repeat_penalty != 1.0 {
                                if logit > 0.0 {
                                    logit /= self.repeat_penalty;
                                } else {
                                    logit *= self.repeat_penalty;
                                }
                            }
                        }
                    }

                    if logit > max_val {
                        max_val = logit;
                        max_idx = i;
                    }
                }
                if let Some(allow) = allow_tokens {
                    for &token in allow {
                        let t = token as usize;
                        if t < self.n_vocab {
                            let mut logit = logits_raw[t];
                            if use_penalty {
                                if let Some(&count) = counts.get(&(t as i32)) {
                                    if self.frequency_penalty != 0.0 {
                                        logit -= self.frequency_penalty * count as f32;
                                    }
                                    if self.presence_penalty != 0.0 {
                                        logit -= self.presence_penalty;
                                    }
                                    if self.repeat_penalty != 1.0 {
                                        if logit > 0.0 {
                                            logit /= self.repeat_penalty;
                                        } else {
                                            logit *= self.repeat_penalty;
                                        }
                                    }
                                }
                            }

                            if logit > max_val {
                                max_val = logit;
                                max_idx = t;
                            }
                        }
                    }
                }
                return max_idx as LlamaToken;
            }

            let mut candidates = self.candidates_buf.borrow_mut();
            candidates.clear();

            for i in start..end {
                let mut logit = logits_raw[i];
                if use_penalty {
                    if let Some(&count) = counts.get(&(i as i32)) {
                        if self.frequency_penalty != 0.0 {
                            logit -= self.frequency_penalty * count as f32;
                        }
                        if self.presence_penalty != 0.0 {
                            logit -= self.presence_penalty;
                        }
                        if self.repeat_penalty != 1.0 {
                            if logit > 0.0 {
                                logit /= self.repeat_penalty;
                            } else {
                                logit *= self.repeat_penalty;
                            }
                        }
                    }
                }

                if logit > f32::NEG_INFINITY / 2.0 {
                    candidates.push((i, logit));
                }
            }
            if let Some(allow) = allow_tokens {
                for &token in allow {
                    let t = token as usize;
                    if t < self.n_vocab {
                        let mut logit = logits_raw[t];
                        if use_penalty {
                            if let Some(&count) = counts.get(&(t as i32)) {
                                if self.frequency_penalty != 0.0 {
                                    logit -= self.frequency_penalty * count as f32;
                                }
                                if self.presence_penalty != 0.0 {
                                    logit -= self.presence_penalty;
                                }
                                if self.repeat_penalty != 1.0 {
                                    if logit > 0.0 {
                                        logit /= self.repeat_penalty;
                                    } else {
                                        logit *= self.repeat_penalty;
                                    }
                                }
                            }
                        }

                        if logit > f32::NEG_INFINITY / 2.0 {
                            candidates.push((t, logit));
                        }
                    }
                }
            }

            Self::apply_top_k(&mut candidates, self.top_k);

            if let Some(allow) = allow_tokens {
                for &token in allow {
                    let t = token as usize;
                    if t < self.n_vocab && !candidates.iter().any(|(idx, _)| *idx == t) {
                        let mut logit = logits_raw[t];
                        if use_penalty {
                            if let Some(&count) = counts.get(&(t as i32)) {
                                if self.frequency_penalty != 0.0 {
                                    logit -= self.frequency_penalty * count as f32;
                                }
                                if self.presence_penalty != 0.0 {
                                    logit -= self.presence_penalty;
                                }
                                if self.repeat_penalty != 1.0 {
                                    if logit > 0.0 {
                                        logit /= self.repeat_penalty;
                                    } else {
                                        logit *= self.repeat_penalty;
                                    }
                                }
                            }
                        }

                        if logit > f32::NEG_INFINITY / 2.0 {
                            candidates.push((t, logit));
                        }
                    }
                }
            }

            candidates.sort_unstable_by(|a, b| {
                b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
            });

            Self::apply_top_p(&mut candidates, self.top_p);

            Self::apply_min_p(&mut candidates, self.min_p);

            Self::apply_temp(&mut candidates, self.temperature);

            let selected_idx = Self::sample_dist(&candidates, &mut self.rng.borrow_mut());
            selected_idx as LlamaToken
        }
    }

    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::needless_range_loop)]
    pub fn sample_with_silent_penalty(
        &self,
        ctx: &LlamaContext,
        idx: i32,
        limit_start: Option<usize>,
        limit_end: Option<usize>,
        allow_tokens: Option<&[LlamaToken]>,
        silent_penalty: f32,
        silent_threshold: usize,
        extra_silent_tokens: Option<&[i32]>,
        history: Option<&[LlamaToken]>,
    ) -> LlamaToken {
        let ffi = get_ffi().expect("FFI not initialized");
        unsafe {
            let offset = if idx >= 0 { idx as usize } else { 0 };
            let base_ptr = (ffi.llama_get_logits)(ctx.ptr);
            let logits_ptr = base_ptr.add(offset * self.n_vocab);

            let logits_raw = std::slice::from_raw_parts(logits_ptr, self.n_vocab);

            let start = limit_start.unwrap_or(0);
            let end = limit_end.unwrap_or(self.n_vocab).min(self.n_vocab);
            let silent_threshold = silent_threshold.min(end);

            let mut counts = std::collections::HashMap::new();
            let use_penalty = (self.repeat_penalty != 1.0
                || self.frequency_penalty != 0.0
                || self.presence_penalty != 0.0)
                && history.is_some();

            if use_penalty {
                if let Some(hist) = history {
                    let start_idx = if hist.len() > self.penalty_last_n {
                        hist.len() - self.penalty_last_n
                    } else {
                        0
                    };
                    for &token in &hist[start_idx..] {
                        *counts.entry(token).or_insert(0) += 1;
                    }
                }
            }

            if self.temperature <= 0.0 {
                let mut max_val = f32::NEG_INFINITY;
                let mut max_idx = start;

                for i in start..end {
                    let mut logit = logits_raw[i];
                    let is_silent = i < silent_threshold
                        || extra_silent_tokens.is_some_and(|tokens| tokens.contains(&(i as i32)));
                    if silent_penalty > 0.0 && i >= start && is_silent {
                        logit -= silent_penalty;
                    }

                    if use_penalty {
                        if let Some(&count) = counts.get(&(i as i32)) {
                            if self.frequency_penalty != 0.0 {
                                logit -= self.frequency_penalty * count as f32;
                            }
                            if self.presence_penalty != 0.0 {
                                logit -= self.presence_penalty;
                            }
                            if self.repeat_penalty != 1.0 {
                                if logit > 0.0 {
                                    logit /= self.repeat_penalty;
                                } else {
                                    logit *= self.repeat_penalty;
                                }
                            }
                        }
                    }

                    if logit > max_val {
                        max_val = logit;
                        max_idx = i;
                    }
                }
                if let Some(allow) = allow_tokens {
                    for &token in allow {
                        let t = token as usize;
                        if t < self.n_vocab {
                            let mut logit = logits_raw[t];
                            let is_silent = t < silent_threshold
                                || extra_silent_tokens
                                    .is_some_and(|tokens| tokens.contains(&(t as i32)));
                            if silent_penalty > 0.0 && t >= start && is_silent {
                                logit -= silent_penalty;
                            }

                            if use_penalty {
                                if let Some(&count) = counts.get(&(t as i32)) {
                                    if self.frequency_penalty != 0.0 {
                                        logit -= self.frequency_penalty * count as f32;
                                    }
                                    if self.presence_penalty != 0.0 {
                                        logit -= self.presence_penalty;
                                    }
                                    if self.repeat_penalty != 1.0 {
                                        if logit > 0.0 {
                                            logit /= self.repeat_penalty;
                                        } else {
                                            logit *= self.repeat_penalty;
                                        }
                                    }
                                }
                            }

                            if logit > max_val {
                                max_val = logit;
                                max_idx = t;
                            }
                        }
                    }
                }
                return max_idx as LlamaToken;
            }

            let mut candidates = self.candidates_buf.borrow_mut();
            candidates.clear();

            for i in start..end {
                let mut logit = logits_raw[i];
                let is_silent = i < silent_threshold
                    || extra_silent_tokens.is_some_and(|tokens| tokens.contains(&(i as i32)));
                if silent_penalty > 0.0 && i >= start && is_silent {
                    logit -= silent_penalty;
                }

                if use_penalty {
                    if let Some(&count) = counts.get(&(i as i32)) {
                        if self.frequency_penalty != 0.0 {
                            logit -= self.frequency_penalty * count as f32;
                        }
                        if self.presence_penalty != 0.0 {
                            logit -= self.presence_penalty;
                        }
                        if self.repeat_penalty != 1.0 {
                            if logit > 0.0 {
                                logit /= self.repeat_penalty;
                            } else {
                                logit *= self.repeat_penalty;
                            }
                        }
                    }
                }

                if logit > f32::NEG_INFINITY / 2.0 {
                    candidates.push((i, logit));
                }
            }
            if let Some(allow) = allow_tokens {
                for &token in allow {
                    let t = token as usize;
                    if t < self.n_vocab {
                        let mut logit = logits_raw[t];
                        let is_silent = t < silent_threshold
                            || extra_silent_tokens
                                .is_some_and(|tokens| tokens.contains(&(t as i32)));
                        if silent_penalty > 0.0 && t >= start && is_silent {
                            logit -= silent_penalty;
                        }

                        if use_penalty {
                            if let Some(&count) = counts.get(&(t as i32)) {
                                if self.frequency_penalty != 0.0 {
                                    logit -= self.frequency_penalty * count as f32;
                                }
                                if self.presence_penalty != 0.0 {
                                    logit -= self.presence_penalty;
                                }
                                if self.repeat_penalty != 1.0 {
                                    if logit > 0.0 {
                                        logit /= self.repeat_penalty;
                                    } else {
                                        logit *= self.repeat_penalty;
                                    }
                                }
                            }
                        }

                        if logit > f32::NEG_INFINITY / 2.0 {
                            candidates.push((t, logit));
                        }
                    }
                }
            }

            Self::apply_top_k(&mut candidates, self.top_k);

            if let Some(allow) = allow_tokens {
                for &token in allow {
                    let t = token as usize;
                    if t < self.n_vocab && !candidates.iter().any(|(idx, _)| *idx == t) {
                        let mut logit = logits_raw[t];
                        let is_silent = t < silent_threshold
                            || extra_silent_tokens
                                .is_some_and(|tokens| tokens.contains(&(t as i32)));
                        if silent_penalty > 0.0 && t >= start && is_silent {
                            logit -= silent_penalty;
                        }

                        if use_penalty {
                            if let Some(&count) = counts.get(&(t as i32)) {
                                if self.frequency_penalty != 0.0 {
                                    logit -= self.frequency_penalty * count as f32;
                                }
                                if self.presence_penalty != 0.0 {
                                    logit -= self.presence_penalty;
                                }
                                if self.repeat_penalty != 1.0 {
                                    if logit > 0.0 {
                                        logit /= self.repeat_penalty;
                                    } else {
                                        logit *= self.repeat_penalty;
                                    }
                                }
                            }
                        }

                        if logit > f32::NEG_INFINITY / 2.0 {
                            candidates.push((t, logit));
                        }
                    }
                }
            }

            candidates.sort_unstable_by(|a, b| {
                b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
            });

            Self::apply_top_p(&mut candidates, self.top_p);

            Self::apply_min_p(&mut candidates, self.min_p);

            Self::apply_temp(&mut candidates, self.temperature);

            let selected_idx = Self::sample_dist(&candidates, &mut self.rng.borrow_mut());
            selected_idx as LlamaToken
        }
    }
}

impl Drop for LlamaSampler {
    fn drop(&mut self) {}
}
