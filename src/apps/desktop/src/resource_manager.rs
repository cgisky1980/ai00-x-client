//! Split-installer resource management.
//!
//! The installer ships only the exe + loader.zip. The remaining resources
//! (main.zip / underlay.zip / sounds.zip / runtime-*.zip) are published as
//! GitHub Release assets AND mirrored to the unified model repos
//! (ModelScope / HuggingFace, under `resources/`) for CN-friendly CDN
//! speeds. Downloads are guided by a content-addressed
//! `resources-manifest.json` (sha256 per entry); hosts are ordered by a
//! real ranged-download throughput probe (see mirror_hosts.rs).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

use crate::mirror_hosts::{self, MeasuredSpeed};
use crate::model_init::DOWNLOAD_MANAGER;

const RELEASE_BASE: &str = "https://github.com/cgisky1980/ai00-x-client/releases/latest/download";

/// GitHub mirrors (kept in sync with scripts/pack-runtime.mjs).
const MIRRORS: &[&str] = &[
    "https://ghproxy.net",
    "https://mirror.ghproxy.com",
    "https://gh-proxy.com",
];

/// Resource prefix inside the unified model repos (ms first — CN CDN).
const MS_RESOURCE_BASE: &str =
    "https://modelscope.cn/models/cgisky/Ai00-X/resolve/master/resources";
const HF_MIRROR_RESOURCE_BASE: &str = "https://hf-mirror.com/cgisky/ai00-x/resolve/main/resources";
const HF_RESOURCE_BASE: &str = "https://huggingface.co/cgisky/ai00-x/resolve/main/resources";

/// All candidate hosts for a resource file, in static fallback order.
fn host_urls(file: &str) -> Vec<(String, String)> {
    let github = format!("{RELEASE_BASE}/{file}");
    let mut hosts = vec![
        ("ms".to_string(), format!("{MS_RESOURCE_BASE}/{file}")),
        (
            "hf-mirror".to_string(),
            format!("{HF_MIRROR_RESOURCE_BASE}/{file}"),
        ),
        ("hf".to_string(), format!("{HF_RESOURCE_BASE}/{file}")),
        ("github".to_string(), github.clone()),
    ];
    for (i, m) in MIRRORS.iter().enumerate() {
        hosts.push((format!("ghproxy{i}"), format!("{m}/{github}")));
    }
    hosts
}

/// Measured host order, refreshed once per session before downloads.
static HOST_SPEEDS: Mutex<Option<Vec<MeasuredSpeed>>> = Mutex::const_new(None);

/// Probe every candidate host (main.zip is used as the probe file: it always
/// exists in the manifest and is large enough to expose CDN throughput).
/// Best effort — on failure the static order above is kept.
async fn refresh_host_speeds() {
    if HOST_SPEEDS.lock().await.is_some() {
        return; // already measured this session
    }
    let probes = host_urls("main.zip");
    let measured = mirror_hosts::measure_mirror_speeds(probes).await;
    log::info!(
        "[resources] host order: {:?}",
        measured
            .iter()
            .map(|m| (m.host_key.as_str(), m.throughput_bps / 1024))
            .collect::<Vec<_>>()
    );
    let mut guard = HOST_SPEEDS.lock().await;
    if guard.is_none() {
        *guard = Some(measured);
    }
}

/// Candidate URLs for one file, ordered by measured throughput (fastest
/// first); unprobed/unreachable hosts keep the static fallback order.
async fn download_urls(file: &str) -> Vec<String> {
    let hosts = host_urls(file);
    let guard = HOST_SPEEDS.lock().await;
    let Some(speeds) = guard.as_ref() else {
        return hosts.into_iter().map(|(_, url)| url).collect();
    };

    let mut urls = Vec::with_capacity(hosts.len());
    // Measured hosts (sorted fastest-first); skip unreachable ones entirely.
    for speed in speeds {
        if speed.latency_ms == u64::MAX {
            continue;
        }
        if let Some((_, url)) = hosts.iter().find(|(k, _)| *k == speed.host_key) {
            urls.push(url.clone());
        }
    }
    // Any host left unprobed keeps its static order at the end.
    for (key, url) in &hosts {
        if !speeds.iter().any(|s| s.host_key == *key) {
            urls.push(url.clone());
        }
    }
    urls
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceEntry {
    pub file: String,
    pub version: String,
    /// "zip" → place next to the exe; "extract:<dir>" → unzip into <exe>/<dir>.
    pub kind: String,
    pub size: u64,
    pub sha256: String,
    /// Optional P2P magnet (built when the release pipeline has a tracker
    /// configured); absent → HTTP-only download.
    #[serde(default)]
    pub magnet: Option<String>,
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
    match std::fs::read_to_string(&path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(state) => state,
            Err(e) => {
                log::warn!(
                    "[resources] local state {} failed to parse ({e}); content head: {:?}",
                    path.display(),
                    s.chars().take(200).collect::<String>()
                );
                LocalState::default()
            }
        },
        Err(e) => {
            log::info!("[resources] no local state at {} ({e})", path.display());
            LocalState::default()
        }
    }
}

fn save_local_state(state: &LocalState) {
    if let Ok(path) = local_state_path() {
        if let Ok(json) = serde_json::to_string_pretty(state) {
            let _ = std::fs::write(path, json);
        }
    }
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
    // Tiny file: static order is fine (github direct, ghproxies, then the
    // model-repo mirrors where a copy is also published under resources/).
    let github = format!("{RELEASE_BASE}/{manifest_file}");
    let mut urls = vec![github.clone()];
    for m in MIRRORS {
        urls.push(format!("{m}/{github}"));
    }
    urls.push(format!("{MS_RESOURCE_BASE}/{manifest_file}"));
    urls.push(format!("{HF_MIRROR_RESOURCE_BASE}/{manifest_file}"));
    urls.push(format!("{HF_RESOURCE_BASE}/{manifest_file}"));

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
    let state = match entry.kind.as_str() {
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
                            other => {
                                log::info!(
                                    "[resources] {} state=update (size ok, marker={:?}, content={:?})",
                                    key,
                                    local.installed.get(key).map(|s| s.len()),
                                    other.map(|h| h.len())
                                );
                                "update".into()
                            }
                        }
                    }
                },
                other => {
                    log::info!(
                        "[resources] {key} state=missing (zip metadata={other:?}, expected size {})",
                        entry.size
                    );
                    "missing".into()
                }
            }
        }
        kind => {
            // extract:<dir> → the extraction target must exist AND the local
            // record must match (size/hash of the source zip).
            let Some(target) = kind.strip_prefix("extract:") else {
                return "missing".into();
            };
            let marker = local.installed.get(key);
            let marker_ok = marker.is_some_and(|sha| sha == &entry.sha256);
            let dir_ok = dir.join(target).is_dir();
            let state = if marker_ok && dir_ok {
                "ok".into()
            } else {
                log::info!(
                    "[resources] {key} state=missing (marker_ok={marker_ok} dir_ok={dir_ok})",
                );
                "missing".into()
            };
            state
        }
    };
    state
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
        .ok_or_else(|| format!("unknown resource key: {key}"))?
        .clone();

    refresh_host_speeds().await;
    install_resource(&key, &entry).await
}

/// Core download + verify + install for one resource entry. Called in
/// parallel by `resources_download_all` (each task owns its id
/// `resource-<key>` in DOWNLOAD_MANAGER, so progress stays pollable).
///
/// When the manifest entry carries a magnet and the P2P session is up, a
/// BitTorrent download races against the HTTP multi-source download; the
/// first lane to finish wins (see resource_p2p.rs). Either way the winner's
/// bytes are sha256-verified before install.
async fn install_resource(key: &str, entry: &ResourceEntry) -> Result<String, String> {
    let dir = exe_dir()?;
    let tmp_path = dir.join(format!(".{}.download", entry.file));
    let task_id = format!("resource-{key}");

    // ── P2P lane (optional) ─────────────────────────────────────────────
    let (p2p_stop_tx, p2p_stop_rx) = tokio::sync::watch::channel(false);
    let mut p2p_task = match (&entry.magnet, crate::resource_p2p::get()) {
        (Some(magnet), Some(p2p)) if p2p_enabled().await => {
            let magnet = magnet.clone();
            let file = entry.file.clone();
            Some(tokio::spawn(async move {
                p2p.download(
                    &magnet,
                    &file,
                    std::time::Duration::from_secs(600),
                    p2p_stop_rx,
                )
                .await
            }))
        }
        _ => None,
    };

    // ── HTTP lane (always) ──────────────────────────────────────────────
    DOWNLOAD_MANAGER
        .start_with_fallback(
            task_id.clone(),
            download_urls(&entry.file).await,
            tmp_path.clone(),
        )
        .await?;

    let mut http_won = false;
    let winner: Result<PathBuf, String> = loop {
        // poll HTTP
        let task = DOWNLOAD_MANAGER
            .progress(&task_id)
            .await
            .ok_or_else(|| "download task vanished".to_string())?;
        match task.status {
            crate::download_manager::DownloadStatus::Completed => {
                // HTTP won → tell the P2P lane to clean up.
                let _ = p2p_stop_tx.send(true);
                if let Some(t) = p2p_task.as_mut() {
                    let _ = t.await; // joined inside download() cleanup
                }
                http_won = true;
                break Ok(tmp_path.clone());
            }
            crate::download_manager::DownloadStatus::Failed => {
                let _ = p2p_stop_tx.send(true);
                if let Some(t) = p2p_task.as_mut() {
                    let _ = t.await;
                }
                break Err(task.error.unwrap_or_else(|| "download failed".into()));
            }
            _ => {}
        }
        // poll P2P (non-blocking)
        if let Some(t) = p2p_task.as_mut() {
            if t.is_finished() {
                match t.await {
                    Ok(Ok(path)) => {
                        // P2P won → copy into the HTTP tmp slot and verify as
                        // usual; the torrent stays alive in Seeding.
                        tokio::fs::copy(&path, &tmp_path)
                            .await
                            .map_err(|e| format!("copy from p2p: {e}"))?;
                        break Ok(tmp_path.clone());
                    }
                    Ok(Err(e)) => {
                        log::info!("[resources] {key}: p2p lane lost ({e}); http continues");
                        p2p_task = None;
                    }
                    Err(e) => {
                        log::warn!("[resources] {key}: p2p task panicked: {e}");
                        p2p_task = None;
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    };

    // Verify content hash before installing.
    let tmp_path = winner?;
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
            // Parallel installs each own their own staging dir
            // (.<target>-extract), so no cross-task conflict.
            let staging_dir = dir.join(format!(".{}-extract", target));
            let _ = std::fs::remove_dir_all(&staging_dir);
            // Unzip off the async runtime: several hundred-MB zips may be
            // extracted concurrently by resources_download_all.
            let zip = tmp_path.clone();
            let staging_for_unzip = staging_dir.clone();
            tokio::task::spawn_blocking(move || extract_zip(&zip, &staging_for_unzip))
                .await
                .map_err(|e| e.to_string())??;
            let _ = std::fs::remove_dir_all(&dest_dir);
            std::fs::rename(&staging_dir, &dest_dir).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&tmp_path);
        }
    }

    // HTTP lane won & P2P seeding allowed → fetch the small .torrent asset
    // and start seeding from the installed zip (best effort). When P2P won
    // the torrent is already seeding — nothing to do.
    if http_won && p2p_task.is_some() && seeding_allowed().await {
        if let Some(magnet) = &entry.magnet {
            if let Err(e) = start_seeding_after_http(&dir, &entry.file, magnet).await {
                log::info!("[resources] {key}: seeding skipped: {e}");
            }
        }
    }

    // read-modify-write of the shared local state must be serialized when
    // several installs finish at the same time.
    static STATE_LOCK: Mutex<()> = Mutex::const_new(());
    let _guard = STATE_LOCK.lock().await;
    let mut local = load_local_state();
    local
        .installed
        .insert(key.to_string(), entry.sha256.clone());
    save_local_state(&local);
    drop(_guard);

    log::info!(
        "[resources] installed {} v{} ({})",
        key,
        entry.version,
        entry.file
    );
    Ok(entry.version.clone())
}

/// GlobalConfig acestep.p2p.enabled (default true).
async fn p2p_enabled() -> bool {
    read_p2p_config()
        .await
        .map(|c| c.map(|p| p.enabled).unwrap_or(true))
        .unwrap_or(true)
}

/// GlobalConfig acestep.p2p.seed_resources (default true) — also requires
/// the main switch.
async fn seeding_allowed() -> bool {
    read_p2p_config()
        .await
        .map(|c| c.map(|p| p.enabled && p.seed_resources).unwrap_or(true))
        .unwrap_or(true)
}

async fn read_p2p_config() -> Option<Option<ai00_x_core::service::config::types::P2pConfig>> {
    let svc = ai00_x_core::service::config::get_global_config_service().ok()?;
    let cfg = svc
        .get_config::<ai00_x_core::service::config::types::GlobalConfig>(None)
        .await
        .ok()?;
    Some(cfg.acestep.and_then(|ac| ac.p2p))
}

/// After an HTTP-lane win: download `{file}.torrent` from the release
/// (tiny asset), then copy the installed zip into `.p2p-resources/` and
/// add it in SeedMode so this client serves the swarm.
async fn start_seeding_after_http(dir: &Path, file: &str, magnet: &str) -> Result<(), String> {
    let Some(p2p) = crate::resource_p2p::get() else {
        return Err("p2p session not initialized".into());
    };
    // The zip may already be in the seeding dir from a previous run.
    let installed = dir.join(file);

    let mut torrent_bytes: Option<Vec<u8>> = None;
    // Prefer the .torrent published as a release asset.
    let urls = [
        format!("{RELEASE_BASE}/{file}.torrent"),
        format!("https://ghproxy.net/{RELEASE_BASE}/{file}.torrent"),
    ];
    for u in &urls {
        if let Ok(resp) = reqwest::get(u).await {
            if resp.status().is_success() {
                if let Ok(b) = resp.bytes().await {
                    torrent_bytes = Some(b.to_vec());
                    break;
                }
            }
        }
    }

    match torrent_bytes {
        Some(tb) => p2p
            .seed_from_torrent_bytes(&tb, file, &installed)
            .await
            .map_err(|e| e.to_string()),
        None => Err(format!(
            "no .torrent asset available for {file} (magnet {magnet} unused)"
        )),
    }
}

/// Result of one resource inside `resources_download_all`.
#[derive(Debug, Clone, Serialize)]
pub struct ResourceDownloadOutcome {
    pub key: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Overall progress across all resources (for the aggregate progress bar).
#[derive(Debug, Clone, Serialize)]
pub struct ResourcesOverallProgress {
    pub tasks_total: u32,
    pub tasks_done: u32,
    pub total_bytes: u64,
    pub done_bytes: u64,
    /// Sum of the speed of all in-flight downloads (bytes/sec).
    pub speed_bps: u64,
}

/// Download ALL pending resources in parallel (one DOWNLOAD_MANAGER task per
/// resource, task id `resource-<key>`). Single-key failures do not abort the
/// others; outcomes are reported per key.
#[tauri::command]
pub async fn resources_download_all() -> Result<Vec<ResourceDownloadOutcome>, String> {
    let manifest = fetch_remote_manifest().await?;

    let local = load_local_state();
    let mut pending: Vec<(String, ResourceEntry)> = Vec::new();
    for (key, entry) in &manifest.resources {
        if entry_state(key, entry, &local).await != "ok" {
            pending.push((key.clone(), entry.clone()));
        }
    }
    log::info!(
        "[resources] download_all: {} pending of {}",
        pending.len(),
        manifest.resources.len()
    );
    if pending.is_empty() {
        return Ok(Vec::new());
    }

    refresh_host_speeds().await;

    let futures = pending.into_iter().map(|(key, entry)| async move {
        let r = install_resource(&key, &entry).await;
        let outcome = match r {
            Ok(_) => ResourceDownloadOutcome {
                key,
                ok: true,
                error: None,
            },
            Err(e) => {
                log::warn!("[resources] download_all: {key} failed: {e}");
                ResourceDownloadOutcome {
                    key,
                    ok: false,
                    error: Some(e),
                }
            }
        };
        outcome
    });
    Ok(futures::future::join_all(futures).await)
}

/// Aggregate progress of the running `resource-*` downloads + installed
/// resources (denominator = the full manifest sizes; numerator = installed
/// sizes + in-flight progress).
#[tauri::command]
pub async fn resources_overall_progress() -> Result<ResourcesOverallProgress, String> {
    let manifest = fetch_remote_manifest().await?;
    let local = load_local_state();

    let mut total_bytes = 0u64;
    let mut done_bytes = 0u64;
    let mut tasks_done = 0u32;
    let mut speed_bps = 0u64;
    let mut pending_keys = 0u32;

    let all = DOWNLOAD_MANAGER.list().await;
    // P2P lane progress (per file) merged into the same aggregate.
    let p2p_progress = match crate::resource_p2p::get() {
        Some(p2p) => Some(p2p.progress_snapshot().await),
        None => None,
    };
    for (key, entry) in &manifest.resources {
        total_bytes += entry.size;
        let task_id = format!("resource-{key}");
        let task = all.iter().find(|t| t.id == task_id);
        match task {
            Some(t) if matches!(t.status, crate::download_manager::DownloadStatus::Completed) => {
                done_bytes += entry.size;
                tasks_done += 1;
            }
            Some(t) => {
                // In flight: count the larger of the two racing lanes
                // (HTTP task progress vs P2P torrent progress) so the bar
                // never goes backwards.
                let p2p_done = p2p_progress
                    .as_ref()
                    .and_then(|m| m.get(&entry.file))
                    .map(|(d, _)| *d)
                    .unwrap_or(0);
                done_bytes += t.progress.max(p2p_done).min(entry.size);
                speed_bps += t.speed_bps;
                pending_keys += 1;
            }
            None => {
                // Not in flight: installed (marker ok) counts as done.
                if local
                    .installed
                    .get(key)
                    .is_some_and(|sha| sha == &entry.sha256)
                {
                    done_bytes += entry.size;
                    tasks_done += 1;
                } else {
                    pending_keys += 1;
                }
            }
        }
    }

    Ok(ResourcesOverallProgress {
        tasks_total: tasks_done + pending_keys,
        tasks_done,
        total_bytes,
        done_bytes,
        speed_bps,
    })
}
