//! Split-installer resource management.
//!
//! The installer ships only the exe + loader.zip. The remaining resources
//! (main.zip / underlay.zip / sounds.zip / runtime-*.zip) are published as
//! GitHub Release assets and downloaded on first run / update, guided by a
//! content-addressed `resources-manifest.json` (sha256 per entry).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const RELEASE_BASE: &str = "https://github.com/cgisky1980/ai00-x-client/releases/latest/download";

/// GitHub mirrors (kept in sync with scripts/pack-runtime.mjs).
const MIRRORS: &[&str] = &[
    "https://ghproxy.net",
    "https://mirror.ghproxy.com",
    "https://gh-proxy.com",
];

use crate::model_init::DOWNLOAD_MANAGER;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceEntry {
    pub file: String,
    pub version: String,
    /// "zip" → place next to the exe; "extract:<dir>" → unzip into <exe>/<dir>.
    pub kind: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourcesManifest {
    #[serde(rename = "manifestVersion")]
    pub manifest_version: String,
    pub resources: HashMap<String, ResourceEntry>,
}

/// Local record of installed resources (next to the exe), same shape as the
/// remote manifest but only tracking what has been installed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LocalState {
    installed: HashMap<String, String>, // key → sha256
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceStatus {
    pub key: String,
    pub version: String,
    pub size: u64,
    /// "ok" | "missing" | "update"
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourcesCheckResult {
    pub manifest_version: String,
    pub statuses: Vec<ResourceStatus>,
    pub all_ok: bool,
}

fn exe_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .ok_or_else(|| "failed to resolve exe dir".to_string())
}

fn local_state_path() -> Result<PathBuf, String> {
    Ok(exe_dir()?.join("resources-manifest.json"))
}

fn load_local_state() -> LocalState {
    let path = match local_state_path() {
        Ok(p) => p,
        Err(_) => return LocalState::default(),
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_local_state(state: &LocalState) {
    if let Ok(path) = local_state_path() {
        if let Ok(json) = serde_json::to_string_pretty(state) {
            let _ = std::fs::write(path, json);
        }
    }
}

fn download_urls(file: &str) -> Vec<String> {
    let direct = format!("{RELEASE_BASE}/{file}");
    let mut urls = vec![direct.clone()];
    for m in MIRRORS {
        urls.push(format!("{m}/{direct}"));
    }
    urls
}

async fn sha256_file(path: &Path) -> Result<String, String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut hasher = Sha256::new();
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut reader = std::io::BufReader::new(file);
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            use std::io::Read;
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn fetch_remote_manifest() -> Result<ResourcesManifest, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // Per-platform manifest (release assets share one flat namespace).
    let manifest_file = format!(
        "resources-manifest-{}-{}.json",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    let mut urls = download_urls(&manifest_file);
    // Direct GitHub first (manifest is tiny); mirrors as fallback.
    let mut last_err = String::from("no manifest urls");
    for url in urls.drain(..) {
        match client
            .get(&url)
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let text = resp.text().await.map_err(|e| e.to_string())?;
                return serde_json::from_str(&text)
                    .map_err(|e| format!("invalid resources-manifest.json: {e}"));
            }
            Ok(resp) => last_err = format!("{url}: HTTP {}", resp.status()),
            Err(e) => last_err = format!("{url}: {e}"),
        }
    }
    Err(last_err)
}

/// Download a zip and extract it into `dest_dir` (zip contents at root).
fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("open zip failed: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;
        // Zip-slip guard: only allow paths that stay inside dest_dir.
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest_dir.join(enclosed);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&out_path)
                .map_err(|e| format!("create {}: {e}", out_path.display()))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Determine the local state of one resource entry.
async fn entry_state(key: &str, entry: &ResourceEntry, local: &LocalState) -> String {
    let dir = match exe_dir() {
        Ok(d) => d,
        Err(_) => return "missing".into(),
    };
    match entry.kind.as_str() {
        "zip" => {
            let path = dir.join(&entry.file);
            match std::fs::metadata(&path) {
                Ok(m) if m.len() == entry.size => match local.installed.get(key) {
                    Some(sha) if sha == &entry.sha256 => "ok".into(),
                    _ => {
                        // Size matches but no local record (e.g. dev copy):
                        // trust the content hash.
                        match sha256_file(&path).await {
                            Ok(sha) if sha == entry.sha256 => "ok".into(),
                            _ => "update".into(),
                        }
                    }
                },
                _ => "missing".into(),
            }
        }
        kind => {
            // extract:<dir> → the extraction target must exist AND the local
            // record must match (size/hash of the source zip).
            let Some(target) = kind.strip_prefix("extract:") else {
                return "missing".into();
            };
            let marker_ok = local
                .installed
                .get(key)
                .map(|sha| sha == &entry.sha256)
                .unwrap_or(false);
            if marker_ok && dir.join(target).is_dir() {
                "ok".into()
            } else {
                "missing".into()
            }
        }
    }
}

#[tauri::command]
pub async fn resources_check() -> Result<ResourcesCheckResult, String> {
    let manifest = fetch_remote_manifest().await?;
    let local = load_local_state();

    let mut statuses = Vec::new();
    let mut all_ok = true;
    for (key, entry) in &manifest.resources {
        let state = entry_state(key, entry, &local).await;
        if state != "ok" {
            all_ok = false;
        }
        statuses.push(ResourceStatus {
            key: key.clone(),
            version: entry.version.clone(),
            size: entry.size,
            state,
        });
    }
    statuses.sort_by(|a, b| a.key.cmp(&b.key));

    Ok(ResourcesCheckResult {
        manifest_version: manifest.manifest_version.clone(),
        statuses,
        all_ok,
    })
}

/// Download one resource (by key), verify sha256 and put it in place.
/// Progress can be polled via `get_download_progress` with task id
/// `resource-<key>` while this command runs.
#[tauri::command]
pub async fn resources_download(key: String) -> Result<String, String> {
    let manifest = fetch_remote_manifest().await?;
    let entry = manifest
        .resources
        .get(&key)
        .ok_or_else(|| format!("unknown resource key: {key}"))?;

    let dir = exe_dir()?;
    let tmp_path = dir.join(format!(".{}.download", entry.file));
    let task_id = format!("resource-{key}");

    DOWNLOAD_MANAGER
        .start_with_fallback(
            task_id.clone(),
            download_urls(&entry.file),
            tmp_path.clone(),
        )
        .await?;

    // Wait for the download to finish (progress pollable via the task id).
    loop {
        let task = DOWNLOAD_MANAGER
            .progress(&task_id)
            .await
            .ok_or_else(|| "download task vanished".to_string())?;
        match task.status {
            crate::download_manager::DownloadStatus::Completed => break,
            crate::download_manager::DownloadStatus::Failed => {
                return Err(task.error.unwrap_or_else(|| "download failed".into()));
            }
            _ => tokio::time::sleep(std::time::Duration::from_millis(300)).await,
        }
    }

    // Verify content hash before installing.
    let actual = sha256_file(&tmp_path).await?;
    if actual != entry.sha256 {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "sha256 mismatch for {}: expected {}, got {}",
            entry.file, entry.sha256, actual
        ));
    }

    match entry.kind.as_str() {
        "zip" => {
            let dest = dir.join(&entry.file);
            let staged = dir.join(format!(".{}.staged", entry.file));
            std::fs::rename(&tmp_path, &staged).map_err(|e| e.to_string())?;
            // Replace (best effort on Windows: existing file may be in use
            // after an update — remove first).
            if dest.exists() {
                let _ = std::fs::remove_file(&dest);
            }
            std::fs::rename(&staged, &dest).map_err(|e| e.to_string())?;
        }
        kind => {
            let target = kind
                .strip_prefix("extract:")
                .ok_or_else(|| format!("invalid kind: {kind}"))?;
            let dest_dir = dir.join(target);
            // Extract to a sibling temp dir first, then swap for atomicity.
            let staging_dir = dir.join(format!(".{}-extract", target));
            let _ = std::fs::remove_dir_all(&staging_dir);
            extract_zip(&tmp_path, &staging_dir)?;
            let _ = std::fs::remove_dir_all(&dest_dir);
            std::fs::rename(&staging_dir, &dest_dir).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&tmp_path);
        }
    }

    let mut local = load_local_state();
    local.installed.insert(key.clone(), entry.sha256.clone());
    save_local_state(&local);

    log::info!(
        "[resources] installed {} v{} ({})",
        key,
        entry.version,
        entry.file
    );
    Ok(entry.version.clone())
}
