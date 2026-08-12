// build.rs: Optional CMake build for acestep_c shared library.
//
// By default, this script compiles acestep_c.dll from the bundled
// acestep-cpp source so the library is self-contained and does NOT depend
// on a runtime download from GitHub (which is unreliable for many users).
// The compiled library + GGML backends are found at runtime via the
// `ACESTEP_LIB_DIR` env var baked in at compile time.
//
// To skip the build (fall back to runtime download), set:
//   ACESTEP_SKIP_BUILD=1
//
// Backend selection (optional, default: cpu):
//   ACESTEP_BACKEND=cpu|cuda|vulkan|metal|auto
//   Multi-backend: use `+` to combine, e.g. `ACESTEP_BACKEND=cuda+vulkan`
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
    println!("cargo:rerun-if-env-changed=ACESTEP_SKIP_BUILD");
    println!("cargo:rerun-if-env-changed=ACESTEP_BACKEND");

    let skip_build = env::var("ACESTEP_SKIP_BUILD").unwrap_or_default() == "1";

    if skip_build {
        // Explicit opt-out: library will be downloaded at runtime.
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

    // Verify the bundled source is complete before running CMake.
    let cmake_lists = acestep_cpp_dir.join("CMakeLists.txt");
    if !cmake_lists.exists() {
        panic!(
            "acestep source tree is incomplete: {} not found. \
             The bundled acestep-cpp source appears to be missing; \
             re-clone or restore the repository.",
            cmake_lists.display()
        );
    }

    // Share the single ggml source with llama.cpp so that acestep_c, llama,
    // and qwen3_fa all link the exact same GGML version (AVOIDS ABI drift).
    // The ggml source lives at <repo-root>/llama.cpp/ggml (llama.cpp is a git
    // submodule). acestep-cpp/ggml is a symlink/junction pointing to it; it is
    // NOT committed to git (a junction cannot be tracked), so we (re)create it
    // here on every build. This keeps the workspace self-healing after clone.
    let llama_cpp_dir = manifest_dir.join("../../..").join("llama.cpp");
    // Resolve to an absolute path: `mklink /J` / `symlink` reject relative
    // targets containing `..` segments.
    let shared_ggml = llama_cpp_dir
        .canonicalize()
        .unwrap_or_else(|_| llama_cpp_dir.clone())
        .join("ggml");
    let acestep_ggml = acestep_cpp_dir.join("ggml");
    let shared_ggml_cmake = shared_ggml.join("CMakeLists.txt");
    if !shared_ggml_cmake.exists() {
        panic!(
            "shared ggml source not found: {}. \
             llama.cpp is a git submodule; run:\n  \
             git submodule update --init --recursive\nthen rebuild.",
            shared_ggml_cmake.display()
        );
    }
    ensure_ggml_link(&acestep_ggml, &shared_ggml);

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

    // Locate the actual library directory. On Windows, CMake defaults to the
    // MSVC multi-config generator, which appends a per-config subdirectory
    // (e.g. `Release/`) to the output directory even though
    // `CMAKE_RUNTIME_OUTPUT_DIRECTORY=.` was requested. On single-config
    // generators (Unix Makefiles / Ninja) the library is in build_dir itself.
    let lib_filename = if cfg!(target_os = "windows") {
        "acestep_c.dll"
    } else if cfg!(target_os = "macos") {
        "libacestep_c.dylib"
    } else {
        "libacestep_c.so"
    };
    let lib_dir = if build_dir.join("Release").join(lib_filename).exists() {
        build_dir.join("Release")
    } else if build_dir.join(lib_filename).exists() {
        build_dir.clone()
    } else {
        // Fall back to the build root; the FFI layer will still search the
        // runtime-downloaded directories if nothing is found here.
        build_dir.clone()
    };

    // Expose the path to Rust via env var
    println!("cargo:rustc-env=ACESTEP_LIB_DIR={}", lib_dir.display());

    log(&format!(
        "acestep_c built successfully at {} (backend: {})",
        lib_dir.display(),
        backend_str
    ));
}

fn log(msg: &str) {
    println!("cargo:warning=[acestep] {}", msg);
}

/// Ensure `link` is a symlink/junction pointing to `target`.
///
/// acestep-cpp/ggml is not committed to git (a symlink/junction cannot be
/// versioned reliably across platforms), so we recreate it on every build to
/// share the llama.cpp ggml source. On Windows this uses a directory junction
/// (works without admin privileges); on Unix it uses a symlink.
fn ensure_ggml_link(link: &std::path::Path, target: &std::path::Path) {
    // If it already exists as a symlink/junction, leave it alone.
    if let Ok(meta) = std::fs::symlink_metadata(link) {
        if meta.file_type().is_symlink() {
            return;
        }
        // It exists as a plain directory (e.g. an old committed ggml copy copied
        // back by a user). Replace it.
        let _ = std::fs::remove_dir_all(link);
    }

    #[cfg(target_os = "windows")]
    {
        let parent = link.parent().unwrap_or_else(|| std::path::Path::new("."));
        let _ = std::fs::create_dir_all(parent);
        // Directory junction: `cmd /c mklink /J <link> <target>`. Junctions
        // work without admin privileges on Windows.
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .status();
        match status {
            Ok(s) if s.success() => log(&format!(
                "ggml junction created: {} -> {}",
                link.display(),
                target.display()
            )),
            _ => panic!(
                "failed to create ggml junction {} -> {} (mklink returned {:?}). \
                 Ensure the target exists and you have permission to create links.",
                link.display(),
                target.display(),
                status
            ),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::fs::create_dir_all(target);
        let _ = std::fs::remove_file(link);
        std::os::unix::fs::symlink(target, link)
            .unwrap_or_else(|e| panic!("failed to create ggml symlink: {}", e));
        log(&format!(
            "ggml symlink created: {} -> {}",
            link.display(),
            target.display()
        ));
    }
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
