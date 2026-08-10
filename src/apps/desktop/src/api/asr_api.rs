//! ASR (Automatic Speech Recognition) Tauri command API.
//!
//! Currently provides:
//! - `asr_inspect_gguf` — inspect any GGUF file's metadata + tensor structure.
//!   Used to understand model layout before implementing inference.
//! - `asr_download_aligner` — download the Qwen3-ForcedAligner-0.6B Q8_0 GGUF
//!   model from HuggingFace to `<models_dir>/asr/`.
//! - `asr_get_aligner_status` — query the local aligner model file's presence
//!   and on-disk size, plus live download progress if a download is running.

use once_cell::sync::Lazy;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

use crate::asr::gguf::{GgufReader, MetaValue, TensorMeta};
use crate::download_manager::{DownloadManager, DownloadStatus, DownloadTask};

/// Simplified metadata entry for the frontend.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GgufMetaEntry {
    pub key: String,
    pub value: String,
}

/// Simplified tensor info for the frontend.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GgufTensorInfo {
    pub name: String,
    pub shape: Vec<usize>,
    pub type_name: String,
    pub type_id: u32,
    pub num_elems: usize,
    /// Estimated byte size in the GGUF file (quantized).
    pub byte_size: usize,
}

/// Result of inspecting a GGUF file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GgufInspectResult {
    pub path: String,
    pub architecture: Option<String>,
    pub tensor_count: usize,
    pub metadata: Vec<GgufMetaEntry>,
    pub tensors: Vec<GgufTensorInfo>,
    /// Tensors grouped by prefix (e.g. "blk.0", "audio", "token_embd").
    pub tensor_groups: Vec<(String, usize)>,
}

/// Inspect a GGUF file: return all metadata and tensor info.
///
/// This is a read-only operation — it only parses the GGUF header, not the
/// tensor data. Safe to call on large model files.
#[tauri::command]
pub async fn asr_inspect_gguf(path: String) -> Result<GgufInspectResult, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }

    let reader = GgufReader::open(p).map_err(|e| format!("Failed to open GGUF: {}", e))?;

    let architecture = reader.architecture().map(|s| s.to_string());

    // Serialize metadata to string representations.
    let mut metadata: Vec<GgufMetaEntry> = reader
        .metadata()
        .iter()
        .map(|(k, v)| GgufMetaEntry {
            key: k.clone(),
            value: meta_value_to_string(v),
        })
        .collect();
    metadata.sort_by(|a, b| a.key.cmp(&b.key));

    // Serialize tensor info.
    let tensors: Vec<GgufTensorInfo> = reader
        .list_tensors()
        .iter()
        .map(|t| GgufTensorInfo {
            name: t.name.clone(),
            shape: t.shape.clone(),
            type_name: t.type_name().to_string(),
            type_id: t.type_id,
            num_elems: t.num_elems(),
            byte_size: GgufReader::tensor_byte_size(t.type_id, t.num_elems()),
        })
        .collect();

    // Group tensors by prefix (everything before the last '.').
    let mut groups: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for t in reader.list_tensors() {
        let prefix = t
            .name
            .rsplit_once('.')
            .map(|(p, _)| p)
            .unwrap_or("(root)")
            .to_string();
        *groups.entry(prefix).or_insert(0) += 1;
    }
    let mut tensor_groups: Vec<(String, usize)> = groups.into_iter().collect();
    tensor_groups.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    Ok(GgufInspectResult {
        path,
        architecture,
        tensor_count: reader.tensors().len(),
        metadata,
        tensors,
        tensor_groups,
    })
}

fn meta_value_to_string(v: &MetaValue) -> String {
    match v {
        MetaValue::UInt8(x) => x.to_string(),
        MetaValue::Int8(x) => x.to_string(),
        MetaValue::UInt16(x) => x.to_string(),
        MetaValue::Int16(x) => x.to_string(),
        MetaValue::UInt32(x) => x.to_string(),
        MetaValue::Int32(x) => x.to_string(),
        MetaValue::UInt64(x) => x.to_string(),
        MetaValue::Int64(x) => x.to_string(),
        MetaValue::Float32(x) => format!("{:.6}", x),
        MetaValue::Float64(x) => format!("{:.6}", x),
        MetaValue::Bool(x) => x.to_string(),
        MetaValue::String(s) => s.clone(),
        MetaValue::Array(arr) => {
            if arr.is_empty() {
                "[]".to_string()
            } else if arr.len() <= 5 {
                format!(
                    "[{}]",
                    arr.iter()
                        .map(meta_value_to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            } else {
                format!(
                    "[{}, ... ({} items)]",
                    arr.iter()
                        .take(3)
                        .map(meta_value_to_string)
                        .collect::<Vec<_>>()
                        .join(", "),
                    arr.len()
                )
            }
        }
    }
}

// Suppress unused import warning for TensorMeta — used in type annotations.
#[allow(unused_imports)]
use TensorMeta as _TensorMeta;

// ---- ForcedAligner GGUF download ----

/// HuggingFace repo that hosts the Qwen3-ForcedAligner-0.6B Q8_0 GGUF.
const ASR_ALIGNER_HF_REPO: &str = "OpenVoiceOS/qwen3-forced-aligner-0.6b-q8-0";

/// Filename inside the repo (also the local filename).
const ASR_ALIGNER_FILENAME: &str = "qwen3-forced-aligner-0.6b-q8_0.gguf";

/// Download mirrors — same format as ACE-Step's. HF first, hf-mirror.com as
/// fallback for users in regions where huggingface.co is slow/blocked.
const ASR_ALIGNER_MIRRORS: &[&str] = &["https://huggingface.co", "https://hf-mirror.com"];

/// Expected file size in bytes (~994 MB). Used only for display; the actual
/// downloaded size may differ slightly.
const ASR_ALIGNER_EXPECTED_SIZE: u64 = 994_404_608;

/// Stable download task id (also used as the cancel/progress key).
const ASR_ALIGNER_TASK_ID: &str = "asr-aligner-q8-0";

/// Dedicated DownloadManager instance for ASR models (kept separate from
/// ACE-Step's so concurrent downloads don't interfere).
static ASR_DL_MGR: Lazy<DownloadManager> = Lazy::new(DownloadManager::new);

/// Cached mirror latency ranking (key = mirror base URL, value = latency in ms).
/// `u64::MAX` means unreachable. Refreshed by `refresh_asr_mirror_speeds()`.
static ASR_MIRROR_SPEEDS: Lazy<Mutex<Vec<(String, u64)>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Resolve the local save path for the ForcedAligner GGUF:
/// `<models_dir>/asr/qwen3-forced-aligner-0.6b-q8_0.gguf`.
pub fn resolve_aligner_local_path() -> PathBuf {
    ai00_x_inference::runtime::get_models_dir()
        .join("asr")
        .join(ASR_ALIGNER_FILENAME)
}

/// Test all mirrors concurrently and cache the latency ranking.
async fn refresh_asr_mirror_speeds() {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // HEAD on the README.md — small, always present.
    let test_file = "README.md";
    let mut handles = Vec::new();
    for mirror in ASR_ALIGNER_MIRRORS {
        let mirror = mirror.to_string();
        let url = format!(
            "{}/{}/resolve/main/{}",
            mirror, ASR_ALIGNER_HF_REPO, test_file
        );
        let client = client.clone();
        handles.push(tokio::spawn(async move {
            let start = std::time::Instant::now();
            let result = client
                .head(&url)
                .timeout(std::time::Duration::from_secs(8))
                .send()
                .await;
            let latency = match result {
                Ok(resp) if resp.status().is_success() => start.elapsed().as_millis() as u64,
                Ok(resp) => {
                    log::warn!(
                        "[ASR] Mirror speed: {} HTTP {} — treating as unreachable",
                        mirror,
                        resp.status()
                    );
                    u64::MAX
                }
                Err(e) => {
                    log::warn!("[ASR] Mirror speed: {} FAILED: {}", mirror, e);
                    u64::MAX
                }
            };
            (mirror, latency)
        }));
    }

    let mut results = Vec::new();
    for handle in handles {
        if let Ok(pair) = handle.await {
            results.push(pair);
        }
    }
    results.sort_by_key(|(_, lat)| *lat);
    let mut speeds = ASR_MIRROR_SPEEDS.lock().await;
    *speeds = results;
}

/// Build the per-mirror download URLs, sorted by cached latency (fastest
/// first). Falls back to static order if no speed data.
async fn aligner_download_urls() -> Vec<String> {
    let speeds = ASR_MIRROR_SPEEDS.lock().await;
    if speeds.is_empty() || speeds.iter().all(|(_, lat)| *lat == u64::MAX) {
        drop(speeds);
        return ASR_ALIGNER_MIRRORS
            .iter()
            .map(|m| {
                format!(
                    "{}/{}/resolve/main/{}",
                    m, ASR_ALIGNER_HF_REPO, ASR_ALIGNER_FILENAME
                )
            })
            .collect();
    }
    speeds
        .iter()
        .filter(|(_, lat)| *lat != u64::MAX)
        .map(|(mirror, _)| {
            format!(
                "{}/{}/resolve/main/{}",
                mirror, ASR_ALIGNER_HF_REPO, ASR_ALIGNER_FILENAME
            )
        })
        .collect()
}

/// Status of the ForcedAligner model file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrAlignerStatus {
    /// Absolute local path where the file is expected.
    pub local_path: String,
    /// True when the file exists on disk.
    pub exists: bool,
    /// File size in bytes (0 if not exists).
    pub local_size: u64,
    /// Expected file size in bytes (for progress display).
    pub expected_size: u64,
    /// Current download state: "idle" | "pending" | "downloading" | "completed" | "failed".
    pub download_state: String,
    /// Download progress in bytes (0 if no download in progress).
    pub download_progress: u64,
    /// Download total in bytes (None if unknown / no download in progress).
    pub download_total: Option<u64>,
    /// Last error message if the download failed.
    pub download_error: Option<String>,
}

/// Query the local ForcedAligner GGUF file's presence + live download progress.
#[tauri::command]
pub async fn asr_get_aligner_status() -> Result<AsrAlignerStatus, String> {
    let path = resolve_aligner_local_path();
    let (exists, local_size) = std::fs::metadata(&path)
        .map(|m| (true, m.len()))
        .unwrap_or((false, 0));

    let task = ASR_DL_MGR.progress(ASR_ALIGNER_TASK_ID).await;
    let (download_state, download_progress, download_total, download_error) = match &task {
        Some(t) => (
            match t.status {
                DownloadStatus::Pending => "pending",
                DownloadStatus::Downloading => "downloading",
                DownloadStatus::Paused => "paused",
                DownloadStatus::Completed => "completed",
                DownloadStatus::Failed => "failed",
            }
            .to_string(),
            t.progress,
            t.total,
            t.error.clone(),
        ),
        None => ("idle".to_string(), 0, None, None),
    };

    Ok(AsrAlignerStatus {
        local_path: path.display().to_string(),
        exists,
        local_size,
        expected_size: ASR_ALIGNER_EXPECTED_SIZE,
        download_state,
        download_progress,
        download_total,
        download_error,
    })
}

/// Start downloading the Qwen3-ForcedAligner-0.6B Q8_0 GGUF model.
///
/// Downloads from HuggingFace (with hf-mirror.com fallback) to
/// `<models_dir>/asr/qwen3-forced-aligner-0.6b-q8_0.gguf` (~994 MB).
///
/// If the file already exists with non-zero size, returns immediately without
/// re-downloading. If a download is already running, returns the existing
/// task id.
#[tauri::command]
pub async fn asr_download_aligner() -> Result<String, String> {
    let save_path = resolve_aligner_local_path();
    if let Some(parent) = save_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create dir {}: {}", parent.display(), e))?;
    }

    // Skip if already exists with non-zero size.
    if let Ok(meta) = std::fs::metadata(&save_path) {
        if meta.len() > 0 {
            log::info!(
                "[ASR] ForcedAligner GGUF already exists ({} bytes), skipping download",
                meta.len()
            );
            return Ok(ASR_ALIGNER_TASK_ID.to_string());
        }
    }

    // Refresh mirror speeds (best-effort, ignore failures).
    refresh_asr_mirror_speeds().await;
    let urls = aligner_download_urls().await;

    log::info!(
        "[ASR] Starting ForcedAligner download: file={}, urls={:?}",
        ASR_ALIGNER_FILENAME,
        urls
    );

    ASR_DL_MGR
        .start_with_fallback(ASR_ALIGNER_TASK_ID.to_string(), urls, save_path)
        .await
        .map_err(|e| format!("Failed to start download: {}", e))?;

    Ok(ASR_ALIGNER_TASK_ID.to_string())
}

/// Live download progress payload for the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrAlignerProgress {
    pub task_id: String,
    pub state: String,
    pub progress: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

/// Poll the live download progress of the ForcedAligner GGUF.
///
/// Returns `None` (serialized as `null`) when no download has been started.
#[tauri::command]
pub async fn asr_poll_aligner_progress() -> Result<Option<AsrAlignerProgress>, String> {
    let task = ASR_DL_MGR.progress(ASR_ALIGNER_TASK_ID).await;
    Ok(task.map(|t| AsrAlignerProgress {
        task_id: t.id,
        state: match t.status {
            DownloadStatus::Pending => "pending",
            DownloadStatus::Downloading => "downloading",
            DownloadStatus::Paused => "paused",
            DownloadStatus::Completed => "completed",
            DownloadStatus::Failed => "failed",
        }
        .to_string(),
        progress: t.progress,
        total: t.total,
        error: t.error,
    }))
}

// Suppress unused import warning for DownloadTask — used in match arms above
// via `task.as_ref()` (we read fields off `&DownloadTask`).
#[allow(unused_imports)]
use DownloadTask as _DownloadTask;
