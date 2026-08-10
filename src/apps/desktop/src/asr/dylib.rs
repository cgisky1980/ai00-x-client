use std::path::PathBuf;

use crate::runtime::init::{
    find_acestep_lib_dir, find_gguf_lib_dir, get_llama_dir, get_mnn_dir, get_ort_dir,
};

pub fn get_runtime_dir() -> PathBuf {
    get_ort_dir()
}

pub fn get_llama_runtime_dir() -> PathBuf {
    get_llama_dir()
}

pub fn set_library_search_path() -> Result<(), String> {
    let ort_dir = get_ort_dir();
    let llama_dir = get_llama_dir();
    let mnn_dir = get_mnn_dir();
    // GGML DLLs now live in runtime/gguf/ (shared single copy). Both
    // llama.dll and acestep_c.dll load them from there. The acestep dir is
    // still needed for acestep_c.dll itself.
    let gguf_dir = find_gguf_lib_dir();
    let acestep_dir = find_acestep_lib_dir();

    if !ort_dir.exists() && !llama_dir.exists() && !mnn_dir.exists() {
        return Err(format!(
            "No runtime directories found. ONNX: {}, Llama: {}, MNN: {}",
            ort_dir.display(),
            llama_dir.display(),
            mnn_dir.display()
        ));
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;

        // GGUF dir FIRST so that ggml-base.dll / ggml.dll / ggml-cuda.dll are
        // resolved from the single shared location, followed by the acestep
        // dir (for acestep_c.dll) and the llama dir (for llama.dll).
        let mut dirs_to_add = Vec::new();
        if let Some(ref gguf) = gguf_dir {
            dirs_to_add.push(gguf.clone());
        }
        if let Some(ref ace) = acestep_dir {
            dirs_to_add.push(ace.clone());
        }
        if llama_dir.exists() {
            dirs_to_add.push(llama_dir.clone());
        }
        if mnn_dir.exists() {
            dirs_to_add.push(mnn_dir.clone());
        }
        if ort_dir.exists() {
            dirs_to_add.push(ort_dir.clone());
        }

        if let Some(primary) = dirs_to_add.first() {
            let path_wide: Vec<u16> = std::ffi::OsStr::new(primary)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            unsafe {
                let _ = windows::Win32::System::LibraryLoader::SetDllDirectoryW(
                    windows::core::PCWSTR(path_wide.as_ptr()),
                );
            }
        }

        let path_key = "PATH";
        let path_var = std::env::var_os(path_key).unwrap_or_default();
        let mut paths: Vec<_> = std::env::split_paths(&path_var).collect();
        for dir in &dirs_to_add {
            if !paths.contains(dir) {
                paths.insert(0, dir.clone());
            }
        }
        if let Ok(new_path) = std::env::join_paths(paths) {
            std::env::set_var(path_key, new_path);
        }
    }

    #[cfg(target_os = "linux")]
    {
        let ld_path = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
        let mut entries = Vec::new();
        if let Some(ref gguf) = gguf_dir {
            entries.push(gguf.to_string_lossy().to_string());
        }
        if let Some(ref ace) = acestep_dir {
            entries.push(ace.to_string_lossy().to_string());
        }
        if llama_dir.exists() {
            entries.push(llama_dir.to_string_lossy().to_string());
        }
        if mnn_dir.exists() {
            entries.push(mnn_dir.to_string_lossy().to_string());
        }
        if ort_dir.exists() {
            entries.push(ort_dir.to_string_lossy().to_string());
        }
        let new_entries = entries.join(":");
        let new_path = if ld_path.is_empty() {
            new_entries
        } else {
            format!("{}:{}", new_entries, ld_path)
        };
        std::env::set_var("LD_LIBRARY_PATH", new_path);
    }

    #[cfg(target_os = "macos")]
    {
        let dyld_path = std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
        let mut entries = Vec::new();
        if let Some(ref gguf) = gguf_dir {
            entries.push(gguf.to_string_lossy().to_string());
        }
        if let Some(ref ace) = acestep_dir {
            entries.push(ace.to_string_lossy().to_string());
        }
        if llama_dir.exists() {
            entries.push(llama_dir.to_string_lossy().to_string());
        }
        if mnn_dir.exists() {
            entries.push(mnn_dir.to_string_lossy().to_string());
        }
        if ort_dir.exists() {
            entries.push(ort_dir.to_string_lossy().to_string());
        }
        let new_entries = entries.join(":");
        let new_path = if dyld_path.is_empty() {
            new_entries
        } else {
            format!("{}:{}", new_entries, dyld_path)
        };
        std::env::set_var("DYLD_LIBRARY_PATH", new_path);
    }

    Ok(())
}
