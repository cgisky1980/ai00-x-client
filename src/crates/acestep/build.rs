// build.rs: Optional CMake build for acestep_c shared library.
//
// By default, this script does nothing — the library is downloaded at
// runtime by the RuntimeDownloader (same pattern as llama.cpp).
//
// To build from source (for development/testing), set:
//   ACESTEP_BUILD_FROM_SOURCE=1
//   ACESTEP_BACKEND=cpu|cuda|vulkan|metal|auto  (optional, default: cpu)
//
// Multi-backend: use `+` to combine, e.g. `ACESTEP_BACKEND=cuda+vulkan`
//   - GGML will pick the best available backend at runtime.
//
// `auto` detects available SDKs and enables: cuda > vulkan > cpu
//
// The built library path is exposed via ACESTEP_LIB_DIR env var at
// compile time, which the Rust FFI layer checks before falling back to
// the runtime downloader path.

use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=ACESTEP_BUILD_FROM_SOURCE");
    println!("cargo:rerun-if-env-changed=ACESTEP_BACKEND");

    let build_from_source = env::var("ACESTEP_BUILD_FROM_SOURCE").unwrap_or_default() == "1";

    if !build_from_source {
        // Default: library will be downloaded at runtime.
        // No build steps needed here.
        return;
    }

    println!("cargo:rerun-if-changed=acestep-cpp/CMakeLists.txt");
    println!("cargo:rerun-if-changed=acestep-cpp/c-api/acestep_c.h");
    println!("cargo:rerun-if-changed=acestep-cpp/c-api/acestep_c.cpp");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let acestep_cpp_dir = manifest_dir.join("acestep-cpp");
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let build_dir = out_dir.join("acestep-build");

    // Backend selection — supports `+`-combined backends and `auto`.
    //   cpu | cuda | vulkan | metal | cuda+vulkan | auto
    // `auto` detects SDKs and picks cuda > vulkan > cpu.
    let backend_raw = env::var("ACESTEP_BACKEND").unwrap_or_else(|_| "cpu".to_string());
    let backends: Vec<String> = if backend_raw == "auto" {
        let mut detected: Vec<String> = Vec::new();
        if env::var("CUDA_PATH").is_ok() && which("nvcc").is_some() {
            detected.push("cuda".to_string());
        }
        if which("glslc").is_some() || env::var("VULKAN_SDK").is_ok() {
            detected.push("vulkan".to_string());
        }
        if detected.is_empty() {
            vec!["cpu".to_string()]
        } else {
            detected
        }
    } else {
        backend_raw
            .split('+')
            .map(|s| s.trim().to_lowercase())
            .collect()
    };
    let backend_str = backends.join("+");

    // CMake configure
    let mut configure = Command::new("cmake");
    configure.arg("-B").arg(&build_dir);
    configure.arg("-S").arg(&acestep_cpp_dir);
    configure.arg("-DCMAKE_BUILD_TYPE=Release");
    // All DLLs/.so go to the build root so ggml backends are found at runtime
    configure.arg("-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=.");
    configure.arg("-DCMAKE_LIBRARY_OUTPUT_DIRECTORY=.");

    for b in &backends {
        match b.as_str() {
            "cuda" => configure.arg("-DGGML_CUDA=ON"),
            "vulkan" => configure.arg("-DGGML_VULKAN=ON"),
            "metal" => configure.arg("-DGGML_METAL=ON"),
            _ => continue,
        };
    }

    let status = configure
        .status()
        .expect("CMake configure failed — is CMake installed and in PATH?");
    if !status.success() {
        panic!("CMake configure failed with status {}", status);
    }

    // CMake build (only the acestep_c target, not the CLI executables)
    let mut build = Command::new("cmake");
    build.arg("--build").arg(&build_dir);
    build.arg("--target").arg("acestep_c");
    build.arg("--config").arg("Release");

    let status = build
        .status()
        .expect("CMake build failed — is a C++ compiler installed?");
    if !status.success() {
        panic!("CMake build failed with status {}", status);
    }

    // The library is in build_dir (because CMAKE_LIBRARY_OUTPUT_DIRECTORY=.)
    // Expose the path to Rust via env var
    println!("cargo:rustc-env=ACESTEP_LIB_DIR={}", build_dir.display());

    log(&format!(
        "acestep_c built successfully at {} (backend: {})",
        build_dir.display(),
        backend_str
    ));
}

fn log(msg: &str) {
    println!("cargo:warning=[acestep] {}", msg);
}

/// Check if a command exists in PATH.
fn which(cmd: &str) -> Option<PathBuf> {
    let cmd = if cfg!(windows) {
        format!("{}.exe", cmd)
    } else {
        cmd.to_string()
    };
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths).find_map(|dir| {
            let full = dir.join(&cmd);
            if full.is_file() {
                Some(full)
            } else {
                None
            }
        })
    })
}
