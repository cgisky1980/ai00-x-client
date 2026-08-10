use futures::StreamExt;
use indicatif::{ProgressBar, ProgressStyle};
use reqwest::Client;
use std::fs::File;
use std::io::Write;
use std::path::Path;

pub const ORT_VERSION: &str = "1.23.2";
pub const LLAMA_CPP_VERSION: &str = "b9113";
pub const MNN_VERSION: &str = "1.0.0";
pub const ACESTEP_VERSION: &str = "0.0.1";

const GITHUB_MIRRORS: &[&str] = &[
    "",
    "https://ghproxy.net",
    "https://mirror.ghproxy.com",
    "https://gh-proxy.com",
    "https://gitclone.com/github.com",
];

pub struct RuntimeDownloader {
    client: Client,
    preferred_mirror: Option<String>,
}

impl RuntimeDownloader {
    pub async fn new() -> Self {
        let client = Client::builder()
            .user_agent("Ai00-X Runtime Downloader")
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new());

        let preferred_mirror = Self::detect_best_mirror(&client).await;

        Self {
            client,
            preferred_mirror,
        }
    }

    async fn detect_best_mirror(client: &Client) -> Option<String> {
        for (i, mirror) in GITHUB_MIRRORS.iter().enumerate() {
            let url = if mirror.is_empty() {
                "https://github.com".to_string()
            } else {
                format!("{}/https://github.com", mirror)
            };
            log::info!(
                "[Runtime] Testing mirror {}/{}: {}",
                i + 1,
                GITHUB_MIRRORS.len(),
                url
            );
            match Self::check_connectivity(client, &url).await {
                true => {
                    if mirror.is_empty() {
                        log::info!("[Runtime] Using direct GitHub connection");
                        return None;
                    } else {
                        log::info!("[Runtime] Using mirror: {}", mirror);
                        return Some(mirror.to_string());
                    }
                }
                false => {
                    log::warn!("[Runtime] Mirror unreachable: {}", url);
                    continue;
                }
            }
        }
        log::warn!("[Runtime] All mirrors unreachable, will try all on demand");
        None
    }

    async fn check_connectivity(client: &Client, url: &str) -> bool {
        let result = client
            .head(url)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
        result.is_ok()
    }

    pub async fn download_all(
        &self,
        runtime_dir: &Path,
        _backend: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if !runtime_dir.exists() {
            std::fs::create_dir_all(runtime_dir)?;
        }

        self.download_onnx_runtime(runtime_dir).await?;
        // llama.cpp is compiled from source via build.rs (LLAMA_LIB_DIR).
        // No runtime download needed.
        self.download_mnn(runtime_dir).await?;
        self.download_acestep(runtime_dir).await?;
        Ok(())
    }

    pub fn get_ort_dir(runtime_dir: &Path) -> std::path::PathBuf {
        runtime_dir.join("onnx").join(ORT_VERSION)
    }

    pub fn get_llama_dir(runtime_dir: &Path, backend: &str) -> std::path::PathBuf {
        let segment = if backend == "metal" || backend.is_empty() {
            LLAMA_CPP_VERSION.to_string()
        } else {
            format!("{}-{}", LLAMA_CPP_VERSION, backend)
        };
        runtime_dir.join("llama").join(segment)
    }

    pub fn get_mnn_dir(runtime_dir: &Path) -> std::path::PathBuf {
        runtime_dir.join("mnn").join(MNN_VERSION)
    }

    pub fn get_acestep_dir(runtime_dir: &Path) -> std::path::PathBuf {
        runtime_dir.join("acestep").join(ACESTEP_VERSION)
    }

    pub async fn download_onnx_runtime(
        &self,
        runtime_dir: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (os, arch) = self.get_platform_info()?;

        let ort_dll_name = if os == "win" {
            "onnxruntime.dll"
        } else if os == "osx" {
            "libonnxruntime.dylib"
        } else {
            "libonnxruntime.so"
        };

        let ort_dir = Self::get_ort_dir(runtime_dir);
        if ort_dir.join(ort_dll_name).exists() {
            log::info!(
                "[Runtime] ONNX Runtime {} already exists, skipping download.",
                ORT_VERSION
            );
            return Ok(());
        }

        if runtime_dir.join(ort_dll_name).exists() {
            log::info!(
                "[Runtime] ONNX Runtime found in legacy path, migrating to versioned path..."
            );
            std::fs::create_dir_all(&ort_dir)?;
            if let Err(e) = Self::migrate_legacy_files(runtime_dir, &ort_dir, ort_dll_name) {
                log::warn!("[Runtime] Migration failed: {}, will re-download", e);
            } else {
                log::info!("[Runtime] Migration completed successfully.");
                return Ok(());
            }
        }

        let ort_ext = if os == "win" { "zip" } else { "tgz" };
        let ort_filename = format!("onnxruntime-{}-{}-{}.{}", os, arch, ORT_VERSION, ort_ext);

        log::info!(
            "[Runtime] Downloading ONNX Runtime {} ({}-{})...",
            ORT_VERSION,
            os,
            arch
        );

        let ort_url = format!(
            "https://github.com/microsoft/onnxruntime/releases/download/v{}/{}",
            ORT_VERSION, ort_filename
        );

        std::fs::create_dir_all(&ort_dir)?;
        let tmp_file = ort_dir.join("ort_runtime.tmp");
        self.download_with_fallback(&ort_url, &tmp_file).await?;

        log::info!("[Runtime] Extracting ONNX Runtime...");
        let extract_prefix = format!("onnxruntime-{}-{}-{}", os, arch, ORT_VERSION);
        if ort_ext == "zip" {
            self.extract_zip(&tmp_file, &ort_dir, &extract_prefix, "lib")?;
        } else {
            self.extract_targz(&tmp_file, &ort_dir, &extract_prefix)?;
        }

        let _ = std::fs::remove_file(&tmp_file);
        log::info!(
            "[Runtime] ONNX Runtime {} installed successfully.",
            ORT_VERSION
        );
        Ok(())
    }

    /// Download MNN runtime DLLs (mnn_dit_bridge.dll + MNN.dll) to runtime/mnn/{VERSION}/
    /// TODO: Implement actual download from GitHub Release or custom server.
    /// For now, just checks if the DLLs already exist locally.
    pub async fn download_mnn(&self, runtime_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let mnn_dir = Self::get_mnn_dir(runtime_dir);

        let bridge_dll = if cfg!(target_os = "windows") {
            "mnn_dit_bridge.dll"
        } else if cfg!(target_os = "macos") {
            "libmnn_dit_bridge.dylib"
        } else {
            "libmnn_dit_bridge.so"
        };

        if mnn_dir.join(bridge_dll).exists() {
            log::info!(
                "[Runtime] MNN {} already exists, skipping download.",
                MNN_VERSION
            );
            return Ok(());
        }

        log::info!(
            "[Runtime] MNN {} not found at {}. Download not yet implemented - please place DLLs manually.",
            MNN_VERSION,
            mnn_dir.display()
        );

        // TODO: Implement download logic when release URL is available
        // Example:
        // let mnn_url = format!(
        //     "https://github.com/{owner}/{repo}/releases/download/v{MNN_VERSION}/mnn-{os}-{arch}.zip"
        // );
        // std::fs::create_dir_all(&mnn_dir)?;
        // let tmp_file = mnn_dir.join("mnn_runtime.tmp");
        // self.download_with_fallback(&mnn_url, &tmp_file).await?;
        // self.extract_zip(&tmp_file, &mnn_dir, "", "")?;
        // let _ = std::fs::remove_file(&tmp_file);

        Ok(())
    }

    /// Download AceStep runtime DLL (acestep_c.dll + GGML backends) from the
    /// upstream GitHub Release to `runtime/acestep/{VERSION}/`.
    ///
    /// Asset naming follows `.github/workflows/release.yml`:
    ///   Windows: `acestep-windows-x64.zip`
    ///   Linux:   `acestep-linux-x64.tar.gz`
    ///   macOS:   `acestep-macos-arm64-metal.tar.gz`
    ///
    /// Uses `releases/latest/download/` so the URL stays stable across
    /// upstream releases. If the DLL already exists, the download is skipped.
    pub async fn download_acestep(
        &self,
        runtime_dir: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let acestep_dir = Self::get_acestep_dir(runtime_dir);

        let acestep_dll = if cfg!(target_os = "windows") {
            "acestep_c.dll"
        } else if cfg!(target_os = "macos") {
            "libacestep_c.dylib"
        } else {
            "libacestep_c.so"
        };

        if acestep_dir.join(acestep_dll).exists() {
            log::info!(
                "[Runtime] AceStep {} already exists, skipping download.",
                ACESTEP_VERSION
            );
            return Ok(());
        }

        // Upstream release asset naming (from .github/workflows/release.yml):
        //   Windows: acestep-windows-x64.zip
        //   Linux:   acestep-linux-x64.tar.gz
        //   macOS:   acestep-macos-arm64-metal.tar.gz
        let (asset_name, is_zip) = if cfg!(target_os = "windows") {
            ("acestep-windows-x64.zip", true)
        } else if cfg!(target_os = "macos") {
            ("acestep-macos-arm64-metal.tar.gz", false)
        } else {
            ("acestep-linux-x64.tar.gz", false)
        };

        // Use latest release — ACESTEP_VERSION is internal and doesn't map
        // to an upstream tag. The asset names are stable across releases.
        let base_url = "https://github.com/ServeurpersoCom/acestep.cpp/releases/latest/download";
        let acestep_url = format!("{}/{}", base_url, asset_name);

        log::info!(
            "[Runtime] Downloading AceStep {} from {}...",
            ACESTEP_VERSION,
            acestep_url
        );

        std::fs::create_dir_all(&acestep_dir)?;
        let tmp_file = acestep_dir.join("acestep_runtime.tmp");

        self.download_with_fallback(&acestep_url, &tmp_file).await?;

        if is_zip {
            // lib_subdir="acestep_c" keeps the C ABI DLL + all .dll backends,
            // skipping CLI executables (.exe) and static libs (.lib).
            self.extract_zip(&tmp_file, &acestep_dir, "", "acestep_c")?;
        } else {
            self.extract_targz(&tmp_file, &acestep_dir, "")?;
        }

        let _ = std::fs::remove_file(&tmp_file);

        // Verify the DLL actually landed where we expect.
        if !acestep_dir.join(acestep_dll).exists() {
            return Err(format!(
                "Download succeeded but {} not found in archive. \
                 Archive contents may have changed.",
                acestep_dll
            )
            .into());
        }

        log::info!(
            "[Runtime] AceStep {} installed successfully.",
            ACESTEP_VERSION
        );
        Ok(())
    }

    /// Download SA3 model files (.mnn, .json) to models/sa3/
    /// TODO: Implement actual download from GitHub Release or custom server.
    /// For now, just checks if the model files already exist locally.
    pub async fn download_sa3_models(
        &self,
        models_dir: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let sa3_dir = models_dir.join("sa3");

        if sa3_dir.join("tokenizer.json").exists() {
            log::info!("[Runtime] SA3 models already exist, skipping download.");
            return Ok(());
        }

        log::info!(
            "[Runtime] SA3 models not found at {}. Download not yet implemented - please place model files manually.",
            sa3_dir.display()
        );

        // TODO: Implement download logic when release URL is available
        // std::fs::create_dir_all(&sa3_dir)?;
        // let sa3_url = format!(
        //     "https://github.com/{owner}/{repo}/releases/download/sa3-models/sa3-int8.zip"
        // );
        // let tmp_file = sa3_dir.join("sa3_models.tmp");
        // self.download_with_fallback(&sa3_url, &tmp_file).await?;
        // self.extract_zip(&tmp_file, &sa3_dir, "", "")?;
        // let _ = std::fs::remove_file(&tmp_file);

        Ok(())
    }

    fn migrate_legacy_files(
        runtime_dir: &Path,
        versioned_dir: &Path,
        primary_dll: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        for entry in std::fs::read_dir(runtime_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file() {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if matches!(ext, "dll" | "so" | "dylib") {
                    let file_name = path.file_name().unwrap();
                    std::fs::rename(&path, versioned_dir.join(file_name))?;
                }
            }
        }
        let _ = primary_dll;
        Ok(())
    }

    fn get_platform_info(&self) -> Result<(String, String), Box<dyn std::error::Error>> {
        let os = if cfg!(target_os = "windows") {
            "win"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "macos") {
            "osx"
        } else {
            return Err("Unsupported OS for auto-runtime download".into());
        };

        let arch = if cfg!(target_arch = "x86_64") {
            "x64"
        } else if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            return Err("Unsupported Architecture for auto-runtime download".into());
        };

        Ok((os.to_string(), arch.to_string()))
    }

    fn build_urls(&self, original_url: &str) -> Vec<String> {
        let mut urls = Vec::with_capacity(GITHUB_MIRRORS.len());

        if let Some(ref pref) = self.preferred_mirror {
            urls.push(format!("{}/{}", pref, original_url));
        }

        for mirror in GITHUB_MIRRORS.iter() {
            if mirror.is_empty() {
                urls.push(original_url.to_string());
            } else {
                if let Some(ref pref) = self.preferred_mirror {
                    if *mirror == pref.as_str() {
                        continue;
                    }
                }
                urls.push(format!("{}/{}", mirror, original_url));
            }
        }

        urls.dedup();
        urls
    }

    async fn download_with_fallback(
        &self,
        original_url: &str,
        path: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let urls = self.build_urls(original_url);
        let mut last_error = String::from("No mirrors available");

        for (i, url) in urls.iter().enumerate() {
            log::info!("[Runtime] Trying mirror {}/{}: {}", i + 1, urls.len(), url);
            match self.do_download(url, path).await {
                Ok(()) => {
                    log::info!("[Runtime] Download successful from: {}", url);
                    return Ok(());
                }
                Err(e) => {
                    last_error = e.to_string();
                    log::warn!("[Runtime] Mirror {} failed: {}", url, e);
                    if path.exists() {
                        let _ = std::fs::remove_file(path);
                    }
                    continue;
                }
            }
        }

        Err(last_error.into())
    }

    async fn do_download(&self, url: &str, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let res = self.client.get(url).send().await?;

        if !res.status().is_success() {
            return Err(format!("HTTP {} for {}", res.status(), url).into());
        }

        let total = res.content_length().unwrap_or(0);
        let pb = ProgressBar::new(total);
        pb.set_style(
            ProgressStyle::default_bar()
                .template(
                    "{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {bytes}/{total_bytes} ({eta})",
                )?
                .progress_chars("#>-"),
        );

        let mut file = File::create(path)?;
        let mut stream = res.bytes_stream();

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result?;
            file.write_all(&chunk)?;
            pb.inc(chunk.len() as u64);
        }

        pb.finish();
        Ok(())
    }

    fn extract_zip(
        &self,
        zip_path: &Path,
        dest: &Path,
        prefix: &str,
        lib_subdir: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let file = File::open(zip_path)?;
        let mut archive = zip::ZipArchive::new(file)?;

        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            let outpath = match file.enclosed_name() {
                Some(path) => path.to_owned(),
                None => continue,
            };

            let path_str = outpath.to_string_lossy();

            if !prefix.is_empty() && !path_str.starts_with(prefix) {
                continue;
            }

            if !lib_subdir.is_empty()
                && !path_str.contains(lib_subdir)
                && !path_str.ends_with(".dll")
                && !path_str.ends_with(".so")
                && !path_str.ends_with(".dylib")
            {
                continue;
            }

            let file_name = outpath.file_name().unwrap();
            let dest_file = dest.join(file_name);

            if file.is_dir() {
                std::fs::create_dir_all(&dest_file)?;
            } else {
                let mut outfile = File::create(&dest_file)?;
                std::io::copy(&mut file, &mut outfile)?;
            }
        }

        Ok(())
    }

    fn extract_targz(
        &self,
        tar_path: &Path,
        dest: &Path,
        prefix: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let tar_gz = File::open(tar_path)?;
        let tar = flate2::read::GzDecoder::new(tar_gz);
        let mut archive = tar::Archive::new(tar);

        for entry in archive.entries()? {
            let mut entry = entry?;
            let path = entry.path()?.into_owned();
            let path_str = path.to_string_lossy();

            if !prefix.is_empty() && !path_str.starts_with(prefix) {
                continue;
            }

            if path_str.ends_with(".so")
                || path_str.ends_with(".dylib")
                || path_str.ends_with(".dll")
            {
                let file_name = path.file_name().unwrap();
                let dest_file = dest.join(file_name);
                entry.unpack(dest_file)?;
            }
        }

        Ok(())
    }
}
