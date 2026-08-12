// build.rs: CMake build for llama.dll + GGML shared libraries.
//
// Compiles the llama.cpp git submodule at <repo-root>/llama.cpp/ via CMake.
// The built llama.dll and GGML DLLs (ggml-base.dll, ggml.dll, ggml-cuda.dll,
// ...) are placed in the build dir and the path is exposed to Rust via the
// LLAMA_LIB_DIR compile-time env var. At runtime, init.rs checks this path
// before falling back to runtime/llama/<version>/.
//
// Backend selection via LLAMA_BACKEND env var:
//   cpu | cuda | vulkan | cuda+vulkan | auto  (default: auto)
// `auto` detects SDKs:
//   - CUDA  (nvcc + CUDA_PATH)        → adds cuda
//   - Vulkan (glslc + VULKAN_SDK)     → adds vulkan
//   - neither                          → cpu only
//
// Build directory defaults to `<repo-root>/.llama-build/` (a SHORT path)
// instead of `OUT_DIR/llama-build/` (which can exceed 260 chars on Windows,
// causing MSBuild FileTracker FTK1011 errors in vulkan-shaders-gen).
// Override via `LLAMA_BUILD_DIR` env var.
//
// Generator: uses the CMake default (Visual Studio on Windows). Ninja is
// only used when `LLAMA_USE_NINJA=1` is set (requires MSVC env setup).
//
// Set LLAMA_SKIP_BUILD=1 to skip compilation entirely (e.g. for frontend-only
// development where ASR/TTS is not needed).

use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=LLAMA_SKIP_BUILD");
    println!("cargo:rerun-if-env-changed=LLAMA_BACKEND");
    println!("cargo:rerun-if-env-changed=LLAMA_BUILD_DIR");
    println!("cargo:rerun-if-env-changed=LLAMA_BUILD_PARALLEL");

    if env::var("LLAMA_SKIP_BUILD").unwrap_or_default() == "1" {
        log("LLAMA_SKIP_BUILD=1, skipping llama.cpp compilation");
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // inference crate is at src/crates/inference/, llama.cpp is at repo root.
    let llama_cpp_dir = manifest_dir.join("../../..").join("llama.cpp");

    if !llama_cpp_dir.join("CMakeLists.txt").exists() {
        panic!(
            "llama.cpp submodule not found at {}. \
             Run: git submodule update --init llama.cpp",
            llama_cpp_dir.display()
        );
    }

    println!("cargo:rerun-if-changed=../../../llama.cpp/CMakeLists.txt");

    // On Windows, ensure MSVC environment (cl.exe, INCLUDE, LIB) is set up
    // so that CMake and nvcc can find the compiler. When cargo invokes
    // build.rs from a plain PowerShell/CMD shell, cl.exe is typically NOT
    // in PATH — Visual Studio only injects it via vcvars64.bat. Without
    // this, nvcc fails with "Cannot find compiler 'cl.exe' in PATH".
    #[cfg(target_os = "windows")]
    setup_msvc_env();

    // Build directory: defaults to `<repo-root>/.llama-build/` (a SHORT
    // path) to avoid Windows MAX_PATH issues. The previous default
    // (`OUT_DIR/llama-build/`) could exceed 260 chars, causing MSBuild
    // FileTracker FTK1011 errors in vulkan-shaders-gen try-compile.
    //
    // The short path also survives `cargo clean`, enabling fast incremental
    // CMake rebuilds.
    let build_dir = match env::var("LLAMA_BUILD_DIR") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => {
            // <repo-root>/.llama-build/
            // manifest_dir = src/crates/inference/, repo root is 3 levels up.
            manifest_dir.join("../../..").join(".llama-build")
        }
    };

    // Locate Ninja (optional generator). Ninja is only used when explicitly
    // requested via `LLAMA_USE_NINJA=1`, because on Windows the Ninja
    // generator requires MSVC environment variables (INCLUDE, LIB, PATH) to
    // be set up manually (e.g. via vcvars64.bat), whereas the Visual Studio
    // generator handles this automatically.
    //
    // When Ninja is not used, we rely on the Visual Studio generator with a
    // short `LLAMA_BUILD_DIR` to avoid the MAX_PATH issue.
    let ninja_exe = if env::var("LLAMA_USE_NINJA").unwrap_or_default() == "1" {
        find_ninja(&manifest_dir)
    } else {
        None
    };

    // Backend selection — mirrors acestep/build.rs logic.
    let backend_raw = env::var("LLAMA_BACKEND").unwrap_or_else(|_| "auto".to_string());
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
    configure.arg("-S").arg(&llama_cpp_dir);
    configure.arg("-DCMAKE_BUILD_TYPE=Release");

    // Use Ninja generator if available — it produces shorter paths (no
    // multi-config `/Release/` nesting) and parallelizes by default, both
    // of which help avoid the MSBuild FileTracker FTK1011 long-path error
    // that plagues the vulkan-shaders-gen try-compile step.
    let using_ninja = if let Some(ref ninja) = ninja_exe {
        configure.arg("-G");
        configure.arg("Ninja");
        configure.arg(format!("-DCMAKE_MAKE_PROGRAM={}", ninja.display()));
        log(&format!("Using Ninja generator: {}", ninja.display()));
        true
    } else {
        log("Ninja not found, using default generator (Visual Studio on Windows)");
        // Output all DLLs/.so to the build root so they are co-located.
        // (Ninja already does this by default.)
        configure.arg("-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=.");
        configure.arg("-DCMAKE_LIBRARY_OUTPUT_DIRECTORY=.");
        false
    };

    // Only build the shared llama library, not tests/tools/examples/server.
    configure.arg("-DBUILD_SHARED_LIBS=ON");
    configure.arg("-DLLAMA_BUILD_TESTS=OFF");
    configure.arg("-DLLAMA_BUILD_TOOLS=OFF");
    configure.arg("-DLLAMA_BUILD_EXAMPLES=OFF");
    configure.arg("-DLLAMA_BUILD_SERVER=OFF");
    configure.arg("-DLLAMA_BUILD_APP=OFF");
    configure.arg("-DLLAMA_BUILD_COMMON=OFF");
    configure.arg("-DLLAMA_BUILD_UI=OFF");
    configure.arg("-DLLAMA_CURL=OFF");
    configure.arg("-DLLAMA_BUILD_MTMD=OFF");

    for b in &backends {
        match b.as_str() {
            "cuda" => {
                configure.arg("-DGGML_CUDA=ON");
                // Exclude Blackwell (120a/121a) to avoid nvcc errors.
                configure.arg("-DCMAKE_CUDA_ARCHITECTURES=75;80;86;89");
                // Don't let nvcc's host-compiler version check abort the
                // build when CI runners ship a newer Visual Studio than the
                // CUDA release officially supports.
                configure.arg("-DCMAKE_CUDA_FLAGS=--allow-unsupported-compiler");
            }
            "vulkan" => {
                configure.arg("-DGGML_VULKAN=ON");
            }
            "metal" => {
                configure.arg("-DGGML_METAL=ON");
            }
            "cpu" => {}
            _ => continue,
        }
    }

    log(&format!("CMake configure (backend: {})...", backend_str));
    let status = configure
        .status()
        .expect("CMake configure failed — is CMake installed and in PATH?");
    if !status.success() {
        panic!("CMake configure failed with status {}", status);
    }

    // CMake build — only the `llama` target (auto-builds ggml dependencies).
    // Use `--parallel` to speed up compilation (especially CUDA kernels
    // which are compiled once per architecture). Without this flag, the
    // Visual Studio generator compiles files serially by default.
    let mut build = Command::new("cmake");
    build.arg("--build").arg(&build_dir);
    build.arg("--target").arg("llama");
    // `--config` is only meaningful for multi-config generators (Visual
    // Studio). Ninja is single-config and ignores it, but passing it is
    // harmless.
    build.arg("--config").arg("Release");
    build.arg("--parallel");
    if let Ok(n) = env::var("LLAMA_BUILD_PARALLEL") {
        build.arg(&n);
    }

    log("CMake build (target: llama, parallel)...");
    let status = build
        .status()
        .expect("CMake build failed — is a C++ compiler installed?");
    if !status.success() {
        panic!("CMake build failed with status {}", status);
    }

    // Find the actual directory containing the built DLLs.
    //
    // llama.cpp's CMakeLists.txt sets `CMAKE_RUNTIME_OUTPUT_DIRECTORY` to
    // `${CMAKE_BINARY_DIR}/bin` (overriding our `-D` flag because it uses a
    // non-CACHE `set()`).
    //
    // - Visual Studio (multi-config): appends the config name → `<build_dir>/bin/Release/`
    // - Ninja (single-config): no extra suffix → `<build_dir>/bin/`
    //
    // We probe all known locations and expose the one that actually contains
    // llama.dll so that `find_llama_lib_dir()` in init.rs finds it.
    let lib_filename = if cfg!(target_os = "windows") {
        "llama.dll"
    } else if cfg!(target_os = "macos") {
        "libllama.dylib"
    } else {
        "libllama.so"
    };

    let candidates = [
        build_dir.join("bin").join("Release"),
        build_dir.join("bin"),
        build_dir.clone(),
    ];
    let _ = using_ninja; // generator-specific differences already handled above
    let lib_dir = candidates
        .into_iter()
        .find(|d| d.join(lib_filename).exists())
        .unwrap_or_else(|| build_dir.clone());

    println!("cargo:rustc-env=LLAMA_LIB_DIR={}", lib_dir.display());

    log(&format!(
        "llama.dll + GGML DLLs built at {} (backend: {})",
        lib_dir.display(),
        backend_str
    ));

    // Sync GGML DLLs to runtime/gguf/ to avoid version conflicts.
    // If acestep loads an older ggml-base.dll from runtime/gguf/ before
    // qwen3_fa.dll loads the new one, the Windows loader reuses the old
    // version, causing STATUS_ACCESS_VIOLATION due to ABI mismatch.
    sync_ggml_dlls_to_runtime(&lib_dir, &manifest_dir);

    // Build qwen3_fa.dll (ForcedAligner C++ wrapper, GPU-accelerated via ggml).
    // Skip with LLAMA_SKIP_BUILD=1 (same opt-out as llama.cpp).
    let fa_src_dir = manifest_dir.join("qwen3-fa-cpp");
    if fa_src_dir.join("CMakeLists.txt").exists() {
        build_qwen3_fa(&fa_src_dir, &build_dir);
    } else {
        log("qwen3-fa-cpp/ not found, skipping qwen3_fa.dll build");
    }
}

/// Copy GGML DLLs from the build dir to runtime/gguf/ to ensure all
/// components (acestep, qwen3_fa, llama) use the same GGML version.
fn sync_ggml_dlls_to_runtime(lib_dir: &std::path::Path, manifest_dir: &std::path::Path) {
    // repo_root = manifest_dir/../../../  (src/crates/inference -> repo root)
    let repo_root = manifest_dir
        .parent() // crates/
        .and_then(|p| p.parent()) // src/
        .and_then(|p| p.parent()); // repo root
    let Some(repo_root) = repo_root else {
        return;
    };

    let runtime_gguf = repo_root.join("target/release/runtime/gguf");
    if !runtime_gguf.exists() {
        return;
    }

    let ggml_dlls = [
        "ggml-base.dll",
        "ggml.dll",
        "ggml-cuda.dll",
        "ggml-cpu.dll",
        "ggml-vulkan.dll",
    ];
    let mut synced = 0;
    for dll in &ggml_dlls {
        let src = lib_dir.join(dll);
        let dst = runtime_gguf.join(dll);
        if src.exists() {
            // Only copy if content differs (avoid unnecessary writes that
            // trigger cargo rerun and file lock issues).
            let need_copy = !dst.exists()
                || std::fs::metadata(&src).map(|m| m.len()).ok()
                    != std::fs::metadata(&dst).map(|m| m.len()).ok();
            if need_copy {
                if let Err(e) = std::fs::copy(&src, &dst) {
                    log(&format!(
                        "Warning: failed to sync {} to {}: {}",
                        dll,
                        dst.display(),
                        e
                    ));
                } else {
                    synced += 1;
                }
            }
        }
    }
    if synced > 0 {
        log(&format!("Synced {} GGML DLLs to runtime/gguf/", synced));
    }
}

/// Build the qwen3_fa.dll (ForcedAligner shared library) via CMake.
///
/// Links against the GGML DLLs already built by the llama.cpp step.
/// The DLL is placed in the same directory as ggml-base.dll so the
/// runtime loader can find all dependencies.
fn build_qwen3_fa(fa_src_dir: &std::path::Path, llama_build_dir: &std::path::Path) {
    let fa_build_dir = llama_build_dir.join("qwen3-fa-build");
    std::fs::create_dir_all(&fa_build_dir).ok();

    println!(
        "cargo:rerun-if-changed={}/CMakeLists.txt",
        fa_src_dir.display()
    );
    println!(
        "cargo:rerun-if-changed={}/forced_aligner.cpp",
        fa_src_dir.display()
    );
    println!(
        "cargo:rerun-if-changed={}/fa_c_api.cpp",
        fa_src_dir.display()
    );
    println!("cargo:rerun-if-changed={}/fa_c_api.h", fa_src_dir.display());
    println!(
        "cargo:rerun-if-changed={}/mel_spectrogram.cpp",
        fa_src_dir.display()
    );

    // Configure
    let mut configure = Command::new("cmake");
    configure.arg("-S").arg(fa_src_dir);
    configure.arg("-B").arg(&fa_build_dir);
    configure.arg("-DCMAKE_BUILD_TYPE=Release");
    // Pass the GGML build dir so CMakeLists.txt can find the .lib files.
    configure.arg(format!(
        "-DCMAKE_LIBRARY_PATH={}",
        llama_build_dir.join("bin/Release").display()
    ));

    let configure_status = configure.status();
    match configure_status {
        Ok(s) if s.success() => {}
        Ok(s) => panic!("qwen3_fa CMake configure failed: {:?}", s),
        Err(e) => panic!("Failed to run cmake for qwen3_fa: {}", e),
    }

    // Build
    let mut build_cmd = Command::new("cmake");
    build_cmd.arg("--build").arg(&fa_build_dir);
    build_cmd.arg("--config").arg("Release");
    if let Ok(parallel) = env::var("LLAMA_BUILD_PARALLEL") {
        build_cmd.arg("--parallel").arg(parallel);
    }

    let build_status = build_cmd.status();
    match build_status {
        Ok(s) if s.success() => {}
        Ok(s) => panic!("qwen3_fa CMake build failed: {:?}", s),
        Err(e) => panic!("Failed to run cmake --build for qwen3_fa: {}", e),
    }

    // Locate the built DLL.
    // Visual Studio generator creates nested Release/Release/ dirs.
    let candidates = [
        fa_build_dir.join("Release").join("Release"),
        fa_build_dir.join("Release"),
        fa_build_dir.join("bin").join("Release"),
        fa_build_dir.clone(),
    ];
    let dll_name = if cfg!(target_os = "windows") {
        "qwen3_fa.dll"
    } else if cfg!(target_os = "macos") {
        "libqwen3_fa.dylib"
    } else {
        "libqwen3_fa.so"
    };
    let fa_lib_dir = candidates
        .into_iter()
        .find(|d| d.join(dll_name).exists())
        .unwrap_or_else(|| fa_build_dir.clone());

    // Copy DLL next to ggml-base.dll so the loader finds all deps
    let target_dir = llama_build_dir.join("bin/Release");
    let src_dll = fa_lib_dir.join(dll_name);
    let dst_dll = target_dir.join(dll_name);
    if src_dll.exists() {
        std::fs::copy(&src_dll, &dst_dll).ok();
    }

    // Also deploy to <repo-root>/target/release/runtime/gguf/ for production
    // (same dir as ggml-base.dll). This is where find_gguf_lib_dir() looks
    // at runtime when QWEN3_FA_LIB_DIR doesn't exist (e.g. on user machines).
    // fa_src_dir = <manifest_dir>/qwen3-fa-cpp, so manifest_dir = fa_src_dir.parent()
    // repo_root = manifest_dir/../../../  (src/crates/inference -> repo root)
    let repo_root = fa_src_dir
        .parent() // manifest_dir (src/crates/inference)
        .and_then(|p| p.parent()) // src/crates/
        .and_then(|p| p.parent()) // src/
        .and_then(|p| p.parent()); // repo root
    if let Some(repo_root) = repo_root {
        let runtime_gguf = repo_root.join("target/release/runtime/gguf");
        if runtime_gguf.exists() {
            let prod_dll = runtime_gguf.join(dll_name);
            if src_dll.exists() {
                match std::fs::copy(&src_dll, &prod_dll) {
                    Ok(n) => log(&format!(
                        "qwen3_fa.dll deployed to {} ({} bytes)",
                        prod_dll.display(),
                        n
                    )),
                    Err(e) => log(&format!(
                        "Warning: failed to deploy qwen3_fa.dll to {}: {}",
                        prod_dll.display(),
                        e
                    )),
                }
            }
        }
    }

    println!("cargo:rustc-env=QWEN3_FA_LIB_DIR={}", target_dir.display());
    log(&format!(
        "qwen3_fa.dll built at {} (copied to {})",
        fa_lib_dir.display(),
        target_dir.display()
    ));
}

/// Locate the Ninja executable.
///
/// Search order:
///   1. `<repo-root>/.tools/ninja/ninja.exe` (project-local install)
///   2. `ninja` on PATH
///
/// Returns `None` if Ninja is not found, in which case the build falls back
/// to the default CMake generator (Visual Studio on Windows).
fn find_ninja(manifest_dir: &std::path::Path) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "ninja.exe"
    } else {
        "ninja"
    };

    // 1. Project-local install at <repo-root>/.tools/ninja/
    //    manifest_dir = src/crates/inference/, repo root is 3 levels up.
    let local_ninja = manifest_dir
        .join("../../..")
        .join(".tools")
        .join("ninja")
        .join(exe_name);
    if local_ninja.is_file() {
        return Some(local_ninja);
    }

    // 2. On PATH
    which("ninja")
}

/// Set up the MSVC environment (cl.exe, INCLUDE, LIB, PATH) by running
/// `vcvars64.bat` and inheriting its environment variables.
///
/// This is needed because cargo runs build.rs in a shell where `cl.exe`
/// is typically not in PATH. The Visual Studio generator usually handles
/// this internally, but nvcc (CUDA compiler) does not — it shells out to
/// `cl.exe` directly and requires it to be in PATH.
///
/// If cl.exe is already in PATH, this function is a no-op.
#[cfg(target_os = "windows")]
fn setup_msvc_env() {
    // Skip if cl.exe is already accessible.
    if which("cl").is_some() {
        return;
    }

    // Find Visual Studio via vswhere.exe.
    let vswhere = r"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe";
    if !PathBuf::from(vswhere).exists() {
        log(
            "vswhere.exe not found — cannot auto-configure MSVC environment. \
             Run vcvars64.bat before building, or use the Visual Studio Developer Prompt.",
        );
        return;
    }

    let vs_path_output = Command::new(vswhere)
        .args([
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ])
        .output();
    let vs_path = match vs_path_output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => {
            log("vswhere failed to locate a Visual Studio installation with VC tools.");
            return;
        }
    };
    if vs_path.is_empty() {
        log("vswhere returned an empty installation path.");
        return;
    }

    let vcvars = PathBuf::from(&vs_path)
        .join("VC")
        .join("Auxiliary")
        .join("Build")
        .join("vcvars64.bat");
    if !vcvars.exists() {
        log(&format!(
            "vcvars64.bat not found at {} — MSVC environment not configured.",
            vcvars.display()
        ));
        return;
    }

    // Run vcvars64.bat via a temporary batch file to capture the environment
    // variables it sets. We use `call` so that vcvars64.bat returns control
    // to our script, then `set` dumps all environment variables to stdout.
    //
    // We can't use `cmd /c "vcvars64.bat && set"` directly because the
    // quoting rules for paths with spaces are fragile. A temp .bat file
    // avoids this entirely.
    let temp_dir = std::env::temp_dir();
    let temp_bat = temp_dir.join("ai00-x-setup-msvc.bat");
    let bat_content = format!("@echo off\r\ncall \"{}\"\r\nset\r\n", vcvars.display());
    if let Err(e) = std::fs::write(&temp_bat, bat_content) {
        log(&format!("Failed to write temp batch file: {}", e));
        return;
    }

    let output = match Command::new(&temp_bat).output() {
        Ok(o) => o,
        Err(e) => {
            log(&format!("Failed to run vcvars64.bat: {}", e));
            let _ = std::fs::remove_file(&temp_bat);
            return;
        }
    };
    // Clean up the temp file.
    let _ = std::fs::remove_file(&temp_bat);

    if !output.status.success() {
        log("vcvars64.bat exited with a non-zero status — MSVC env may be incomplete.");
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut count = 0usize;
    for line in stdout.lines() {
        if let Some(pos) = line.find('=') {
            let key = &line[..pos];
            let value = &line[pos + 1..];
            // Only set variables that look like environment variables
            // (skip empty keys and obviously bogus lines).
            if !key.is_empty() && !key.contains(' ') {
                env::set_var(key, value);
                count += 1;
            }
        }
    }

    // Remove MinGW/MSYS2 paths from PATH so they don't interfere with MSVC.
    // MinGW's windres.exe, ld.exe, etc. are picked up by MSVC's linker when
    // they appear earlier in PATH, causing bizarre failures like
    // "windres: /fo: unknown option" during CUDA try-compile.
    if let Some(path_var) = env::var_os("PATH") {
        let filtered: Vec<PathBuf> = env::split_paths(&path_var)
            .filter(|p| {
                let s = p.to_string_lossy().to_lowercase();
                // Remove paths containing msys64 or mingw
                !s.contains("msys64") && !s.contains("mingw")
            })
            .collect();
        if let Ok(new_path) = env::join_paths(filtered) {
            env::set_var("PATH", new_path);
        }
    }

    log(&format!(
        "MSVC environment initialized from {} ({} vars set)",
        vcvars.display(),
        count
    ));
}

fn log(msg: &str) {
    println!("cargo:warning=[inference] {}", msg);
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
