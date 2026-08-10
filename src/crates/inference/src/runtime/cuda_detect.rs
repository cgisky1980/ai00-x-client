use std::path::PathBuf;

static DETECTED_BACKEND: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn detect_cuda_available() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        return detect_cuda_windows();
    }
    #[cfg(target_os = "linux")]
    {
        return detect_cuda_linux();
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(target_os = "windows")]
fn detect_cuda_windows() -> Option<String> {
    let nvcuda = unsafe { libloading::Library::new("nvcuda.dll").ok() };
    if nvcuda.is_none() {
        log::info!("[CudaDetect] nvcuda.dll not found, no NVIDIA GPU driver");
        return None;
    }
    std::mem::forget(nvcuda);
    log::info!("[CudaDetect] nvcuda.dll found, NVIDIA GPU driver present");

    if unsafe { libloading::Library::new("cudart64_13.dll").ok() }.is_some() {
        log::info!("[CudaDetect] cudart64_13.dll found, CUDA 13.x available");
        return Some("cuda-13.1".to_string());
    }

    if unsafe { libloading::Library::new("cudart64_12.dll").ok() }.is_some() {
        log::info!("[CudaDetect] cudart64_12.dll found, CUDA 12.x available");
        return Some("cuda-12.4".to_string());
    }

    log::info!("[CudaDetect] No cudart found, but nvcuda.dll present - will use bundled cudart");
    Some("cuda-12.4".to_string())
}

#[cfg(target_os = "linux")]
fn detect_cuda_linux() -> Option<String> {
    let cuda_home = std::path::Path::new("/usr/local/cuda");
    if cuda_home.exists() {
        log::info!("[CudaDetect] /usr/local/cuda found");
        return Some("cuda-12.4".to_string());
    }

    if let Ok(output) = std::process::Command::new("ldconfig").arg("-p").output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.contains("libcudart.so") {
            log::info!("[CudaDetect] libcudart.so found via ldconfig");
            return Some("cuda-12.4".to_string());
        }
    }

    None
}

pub fn detect_llama_backend() -> &'static str {
    DETECTED_BACKEND.get_or_init(|| {
        if let Some(cuda_ver) = detect_cuda_available() {
            log::info!("[CudaDetect] Using CUDA backend: {}", cuda_ver);
            cuda_ver
        } else if cfg!(target_os = "macos") {
            "metal".to_string()
        } else {
            "vulkan".to_string()
        }
    })
}

pub fn get_llama_backend_dir_segment(backend: &str) -> String {
    if backend == "metal" {
        LLAMA_CPP_VERSION.to_string()
    } else {
        format!("{}-{}", LLAMA_CPP_VERSION, backend)
    }
}

pub fn get_active_backend_file_path() -> PathBuf {
    let runtime_dir = super::init::get_runtime_dir();
    runtime_dir.join("llama").join(".active_backend")
}

pub fn save_active_backend(backend: &str) {
    let path = get_active_backend_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, backend);
    log::info!(
        "[CudaDetect] Saved active backend: {} -> {}",
        backend,
        path.display()
    );
}

pub fn load_active_backend() -> Option<String> {
    let path = get_active_backend_file_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            let backend = content.trim().to_string();
            if !backend.is_empty() {
                log::info!("[CudaDetect] Loaded active backend from file: {}", backend);
                return Some(backend);
            }
        }
    }
    None
}

use super::downloader::LLAMA_CPP_VERSION;
