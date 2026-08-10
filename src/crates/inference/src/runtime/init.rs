use once_cell::sync::OnceCell;
use std::path::{Path, PathBuf};

use super::downloader::{ACESTEP_VERSION, LLAMA_CPP_VERSION, MNN_VERSION, ORT_VERSION};

static ONNX_INITIALIZED: OnceCell<bool> = OnceCell::new();
static LLAMA_INITIALIZED: OnceCell<bool> = OnceCell::new();
static ACESTEP_INITIALIZED: OnceCell<bool> = OnceCell::new();
static RUNTIME_DIR: OnceCell<PathBuf> = OnceCell::new();
static MODELS_DIR: OnceCell<PathBuf> = OnceCell::new();
static ACTIVE_BACKEND: OnceCell<String> = OnceCell::new();

pub fn get_app_root_dir() -> PathBuf {
    let exe_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    exe_dir
}

fn compute_dirs() -> (PathBuf, PathBuf) {
    // Allow environment variable overrides so that models/runtime can live
    // outside the target directory (surviving `cargo clean`).
    let exe_dir = get_app_root_dir();
    let runtime = std::env::var("AI00X_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| exe_dir.join("runtime"));
    let models = std::env::var("AI00X_MODELS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| exe_dir.join("models"));

    (runtime, models)
}

pub fn get_runtime_dir() -> PathBuf {
    RUNTIME_DIR
        .get_or_init(|| {
            let (dir, _) = compute_dirs();
            log::info!("[Runtime] Runtime directory: {}", dir.display());
            dir
        })
        .clone()
}

pub fn get_models_dir() -> PathBuf {
    MODELS_DIR
        .get_or_init(|| {
            let (_, dir) = compute_dirs();
            log::info!("[Models] Models directory: {}", dir.display());
            dir
        })
        .clone()
}

pub fn get_ort_dir() -> PathBuf {
    get_runtime_dir().join("onnx").join(ORT_VERSION)
}

/// Compile-time path to the llama.cpp build output directory, set by
/// `build.rs` via `LLAMA_LIB_DIR`. Returns `None` if llama.cpp was not
/// compiled from source (e.g. `LLAMA_SKIP_BUILD=1`).
pub fn llama_build_lib_dir() -> Option<&'static str> {
    option_env!("LLAMA_LIB_DIR")
}

/// Find the directory that actually contains `llama.dll`.
///
/// Checks the build-time `LLAMA_LIB_DIR` first (from `build.rs` CMake build),
/// then falls back to the runtime download directory.
pub fn find_llama_lib_dir() -> Option<PathBuf> {
    let lib_filename = if cfg!(target_os = "windows") {
        "llama.dll"
    } else if cfg!(target_os = "macos") {
        "libllama.dylib"
    } else {
        "libllama.so"
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(build_dir) = llama_build_lib_dir() {
        candidates.push(PathBuf::from(build_dir));
    }
    candidates.push(get_llama_dir());
    candidates.push(
        get_app_root_dir()
            .join("runtime")
            .join("llama")
            .join(LLAMA_CPP_VERSION),
    );

    for dir in &candidates {
        if dir.join(lib_filename).exists() {
            return Some(dir.clone());
        }
    }
    None
}

pub fn get_llama_dir() -> PathBuf {
    let backend = get_active_backend();
    let segment = if backend == "metal" || backend.is_empty() {
        LLAMA_CPP_VERSION.to_string()
    } else {
        format!("{}-{}", LLAMA_CPP_VERSION, backend)
    };
    get_runtime_dir().join("llama").join(segment)
}

pub fn get_mnn_dir() -> PathBuf {
    get_runtime_dir().join("mnn").join(MNN_VERSION)
}

pub fn get_acestep_dir() -> PathBuf {
    get_runtime_dir().join("acestep").join(ACESTEP_VERSION)
}

/// Directory containing the shared GGML DLLs (`ggml-base.dll`, `ggml.dll`,
/// `ggml-cuda.dll`, etc.).
///
/// Previously GGML DLLs lived in `runtime/acestep/<ver>/` alongside
/// `acestep_c.dll`. They have been moved to a dedicated `runtime/gguf/`
/// directory so that the GGML runtime is shared cleanly between `llama.dll`
/// (used by ASR/TTS) and `acestep_c.dll` (used by music generation) without
/// being tied to the acestep brand.
pub fn get_gguf_dir() -> PathBuf {
    get_runtime_dir().join("gguf")
}

/// Find the directory that actually contains the shared GGML DLLs.
///
/// `get_gguf_dir()` always returns `AI00X_RUNTIME_DIR/gguf/`, but in dev mode
/// `AI00X_RUNTIME_DIR` is overridden by `dev.cjs` to `.ai00-x-dev/runtime/`
/// where no `gguf/` directory exists. The actual GGML DLLs live in the
/// exe-relative fallback (`<exe_dir>/runtime/gguf/`). This function mirrors
/// `find_acestep_lib_dir()` so callers can locate the real directory
/// regardless of which `AI00X_RUNTIME_DIR` points to.
pub fn find_gguf_lib_dir() -> Option<PathBuf> {
    let ggml_filename = if cfg!(target_os = "windows") {
        "ggml-base.dll"
    } else if cfg!(target_os = "macos") {
        "libggml-base.dylib"
    } else {
        "libggml-base.so"
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    // Build-time directories (from build.rs CMake builds) have highest priority.
    if let Some(build_dir) = llama_build_lib_dir() {
        candidates.push(PathBuf::from(build_dir));
    }
    if let Some(build_dir) = acestep::build_lib_dir() {
        candidates.push(PathBuf::from(build_dir));
    }
    // Runtime directories.
    candidates.push(get_gguf_dir());
    candidates.push(get_app_root_dir().join("runtime").join("gguf"));

    for dir in &candidates {
        if dir.join(ggml_filename).exists() {
            return Some(dir.clone());
        }
    }
    None
}

/// Find the directory that actually contains the acestep DLL.
///
/// `get_acestep_dir()` always returns `AI00X_RUNTIME_DIR/acestep/<ver>/`, but
/// in dev mode `AI00X_RUNTIME_DIR` is overridden by `dev.cjs` to
/// `.ai00-x-dev/runtime/` — where no acestep directory exists. The actual
/// acestep_c.dll lives in the exe-relative fallback
/// (`<exe_dir>/runtime/acestep/<ver>/`, i.e. `target/release/runtime/acestep/`).
///
/// This function mirrors the search logic in
/// `acestep_api.rs::resolve_lib_dir()` so that `sync_ggml_dlls()` and
/// `collect_versioned_search_paths()` can find the real directory regardless
/// of which `AI00X_RUNTIME_DIR` points to.
pub fn find_acestep_lib_dir() -> Option<PathBuf> {
    let lib_filename = if cfg!(target_os = "windows") {
        "acestep_c.dll"
    } else if cfg!(target_os = "macos") {
        "libacestep_c.dylib"
    } else {
        "libacestep_c.so"
    };

    let candidates: [PathBuf; 3] = [
        get_acestep_dir(),
        acestep::build_lib_dir()
            .map(PathBuf::from)
            .unwrap_or_default(),
        get_app_root_dir()
            .join("runtime")
            .join("acestep")
            .join(ACESTEP_VERSION),
    ];

    for dir in &candidates {
        if dir.join(lib_filename).exists() {
            return Some(dir.clone());
        }
    }
    None
}

pub fn get_active_backend() -> &'static str {
    ACTIVE_BACKEND.get_or_init(|| {
        if let Some(saved) = super::cuda_detect::load_active_backend() {
            return saved;
        }
        super::cuda_detect::detect_llama_backend().to_string()
    })
}

pub fn set_active_backend(backend: &str) {
    let _ = ACTIVE_BACKEND.set(backend.to_string());
    super::cuda_detect::save_active_backend(backend);
}

fn collect_versioned_search_paths() -> Vec<PathBuf> {
    let runtime_dir = get_runtime_dir();
    let mut paths = Vec::new();

    let ort_dir = get_ort_dir();
    if ort_dir.exists() {
        paths.push(ort_dir);
    } else if runtime_dir.join("onnxruntime.dll").exists()
        || runtime_dir.join("libonnxruntime.so").exists()
        || runtime_dir.join("libonnxruntime.dylib").exists()
    {
        paths.push(runtime_dir.clone());
    }

    // GGUF dir FIRST: shared GGML DLLs (ggml-base/ggml/ggml-cuda) now live
    // in runtime/gguf/ and must be found before llama_dir/acestep_dir so that
    // both llama.dll and acestep_c.dll load the same version.
    // Use find_gguf_lib_dir() (not get_gguf_dir()) because in dev mode
    // AI00X_RUNTIME_DIR is overridden and the actual DLLs live elsewhere.
    if let Some(gguf_dir) = find_gguf_lib_dir() {
        paths.push(gguf_dir);
    }

    // Acestep dir for acestep_c.dll (GGML DLLs no longer live here).
    if let Some(acestep_dir) = find_acestep_lib_dir() {
        paths.push(acestep_dir);
    }

    // Llama dir: check build-time path first (from build.rs), then runtime.
    if let Some(llama_dir) = find_llama_lib_dir() {
        paths.push(llama_dir);
    } else {
        let llama_dir = get_llama_dir();
        if llama_dir.exists() {
            paths.push(llama_dir);
        } else {
            let legacy_dir = runtime_dir.join("llama").join(LLAMA_CPP_VERSION);
            if legacy_dir.exists() {
                paths.push(legacy_dir);
            } else if (runtime_dir.join("llama.dll").exists()
                || runtime_dir.join("libllama.so").exists()
                || runtime_dir.join("libllama.dylib").exists())
                && !paths.contains(&runtime_dir)
            {
                paths.push(runtime_dir.clone());
            }
        }
    }

    let mnn_dir = get_mnn_dir();
    if mnn_dir.exists() {
        paths.push(mnn_dir);
    }

    if paths.is_empty() && runtime_dir.exists() {
        paths.push(runtime_dir);
    }

    paths
}

pub fn set_library_search_path() -> Result<(), String> {
    let search_paths = collect_versioned_search_paths();

    if search_paths.is_empty() {
        return Err(format!(
            "No runtime directories found under: {}",
            get_runtime_dir().display()
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let path_key = "PATH";
        let path_var = std::env::var_os(path_key).unwrap_or_default();
        let mut paths: Vec<_> = std::env::split_paths(&path_var).collect();
        for search_path in &search_paths {
            if !paths.contains(search_path) {
                paths.insert(0, search_path.clone());
            }
        }
        if let Ok(new_path) = std::env::join_paths(paths) {
            std::env::set_var(path_key, new_path);
        }
        log::info!(
            "[Runtime] Set DLL search paths: {}",
            search_paths
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    #[cfg(target_os = "linux")]
    {
        let ld_path = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
        let new_entries: String = search_paths
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(":");
        let new_path = if ld_path.is_empty() {
            new_entries
        } else {
            format!("{}:{}", new_entries, ld_path)
        };
        std::env::set_var("LD_LIBRARY_PATH", new_path);
        log::info!(
            "[Runtime] Set LD_LIBRARY_PATH: {}",
            search_paths
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    #[cfg(target_os = "macos")]
    {
        let dyld_path = std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
        let new_entries: String = search_paths
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(":");
        let new_path = if dyld_path.is_empty() {
            new_entries
        } else {
            format!("{}:{}", new_entries, dyld_path)
        };
        std::env::set_var("DYLD_LIBRARY_PATH", new_path);
        log::info!(
            "[Runtime] Set DYLD_LIBRARY_PATH: {}",
            search_paths
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    Ok(())
}

fn resolve_dll_path(versioned_dir: &Path, dll_name: &str, runtime_dir: &Path) -> PathBuf {
    let versioned = versioned_dir.join(dll_name);
    if versioned.exists() {
        return versioned;
    }
    let legacy = runtime_dir.join(dll_name);
    if legacy.exists() {
        return legacy;
    }
    versioned
}

pub fn init_onnx_runtime() -> Result<(), String> {
    ONNX_INITIALIZED.get_or_try_init(|| {
        log::info!("[Runtime] Initializing ONNX Runtime...");

        set_library_search_path()?;

        let dll_name = if cfg!(target_os = "windows") {
            "onnxruntime.dll"
        } else if cfg!(target_os = "macos") {
            "libonnxruntime.dylib"
        } else {
            "libonnxruntime.so"
        };

        let dll_path = resolve_dll_path(&get_ort_dir(), dll_name, &get_runtime_dir());

        if !dll_path.exists() {
            return Err(format!(
                "ONNX Runtime library not found at: {}",
                dll_path.display()
            ));
        }

        let dll_path_str = dll_path.to_string_lossy().to_string();
        std::env::set_var("ORT_DYLIB_PATH", &dll_path_str);
        log::info!("[Runtime] Set ORT_DYLIB_PATH: {}", dll_path_str);

        log::info!("[Runtime] ONNX Runtime initialized: {}", dll_path.display());
        Ok(true)
    })?;

    Ok(())
}

pub fn init_llama_ffi() -> Result<(), String> {
    LLAMA_INITIALIZED.get_or_try_init(|| {
        log::info!(
            "[Runtime] Initializing Llama Ffi (backend: {})...",
            get_active_backend()
        );
        set_library_search_path()?;

        let llama_dll = if cfg!(target_os = "windows") {
            "llama.dll"
        } else if cfg!(target_os = "macos") {
            "libllama.dylib"
        } else {
            "libllama.so"
        };

        let dll_path = if let Some(llama_dir) = find_llama_lib_dir() {
            llama_dir.join(llama_dll)
        } else {
            resolve_dll_path(&get_llama_dir(), llama_dll, &get_runtime_dir())
        };

        if !dll_path.exists() {
            return Err(format!(
                "Llama library not found at: {}. \
                 Set LLAMA_SKIP_BUILD=1 if you don't need ASR/TTS, or ensure \
                 llama.cpp is compiled via build.rs.",
                dll_path.display()
            ));
        }

        log::info!("[Runtime] Llama Ffi initialized: {}", dll_path.display());
        Ok(true)
    })?;

    Ok(())
}

/// Initialize the AceStep runtime (FFI dynamic library).
///
/// Unlike ONNX/Llama which are required for the core inference stack, AceStep
/// is an optional music-generation feature. If the `acestep_c` library is not
/// present, this function logs a warning and returns `Ok(())` so that the rest
/// of the runtime stack can initialize normally.
pub fn init_acestep_ffi() -> Result<(), String> {
    ACESTEP_INITIALIZED.get_or_try_init(|| -> Result<bool, String> {
        log::info!("[Runtime] Initializing AceStep Ffi...");
        set_library_search_path()?;

        let acestep_dll = if cfg!(target_os = "windows") {
            "acestep_c.dll"
        } else if cfg!(target_os = "macos") {
            "libacestep_c.dylib"
        } else {
            "libacestep_c.so"
        };

        // 1. Check runtime download directory first.
        let dll_path = resolve_dll_path(&get_acestep_dir(), acestep_dll, &get_runtime_dir());
        if dll_path.exists() {
            log::info!(
                "[Runtime] AceStep Ffi initialized (runtime): {}",
                dll_path.display()
            );
            return Ok(true);
        }

        // 2. Fall back to the build-time directory (when built with
        //    ACESTEP_BUILD_FROM_SOURCE=1, build.rs sets ACESTEP_LIB_DIR).
        if let Some(build_dir) = acestep::build_lib_dir() {
            let build_path = Path::new(build_dir).join(acestep_dll);
            if build_path.exists() {
                log::info!(
                    "[Runtime] AceStep Ffi initialized (build dir): {}",
                    build_path.display()
                );
                return Ok(true);
            }
        }

        // 3. Neither location has the DLL — non-fatal, music generation disabled.
        log::warn!(
            "[Runtime] AceStep library not found at: {} or build dir (optional, music generation disabled)",
            dll_path.display()
        );
        Ok(false)
    })?;
    Ok(())
}

/// Verify that GGML DLLs exist in the gguf directory (the single shared
/// location after merging). Previously this function synchronized GGML DLLs
/// between acestep and llama directories; now it only logs a warning if the
/// shared DLLs are missing from `runtime/gguf/`.
pub fn sync_ggml_dlls() {
    let Some(gguf_dir) = find_gguf_lib_dir() else {
        log::debug!(
            "[sync_ggml_dlls] gguf dir not found (runtime={})",
            get_gguf_dir().display()
        );
        return;
    };

    for dll_name in &["ggml-base.dll", "ggml.dll", "ggml-cuda.dll"] {
        let dll_path = gguf_dir.join(dll_name);
        if !dll_path.exists() {
            log::warn!(
                "[sync_ggml_dlls] {} missing from gguf dir: {}",
                dll_name,
                gguf_dir.display()
            );
        } else {
            let size = std::fs::metadata(&dll_path).map(|m| m.len()).unwrap_or(0);
            log::info!("[sync_ggml_dlls] {} OK ({} bytes)", dll_name, size);
        }
    }
}

pub fn init_all_runtimes() -> Result<(), String> {
    // Verify shared GGML DLLs in runtime/gguf/ BEFORE any runtime init so
    // both llama.dll and acestep_c.dll load the same GGML version.
    sync_ggml_dlls();

    init_onnx_runtime()?;
    init_llama_ffi()?;
    // AceStep is optional — its failure must not break the core stack.
    if let Err(e) = init_acestep_ffi() {
        log::warn!("[Runtime] AceStep init failed (non-fatal): {e}");
    }
    log::info!("[Runtime] All runtimes initialized successfully.");
    Ok(())
}
