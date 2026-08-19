use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DownloadStatus {
    Pending,
    Downloading,
    Paused,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    pub id: String,
    pub url: String,
    pub path: PathBuf,
    pub progress: u64,
    pub total: Option<u64>,
    pub status: DownloadStatus,
    pub error: Option<String>,
    /// Sliding-window download speed (bytes/sec), sampled every 500 ms.
    #[serde(default)]
    pub speed_bps: u64,
}

pub struct DownloadManager {
    tasks: Arc<RwLock<HashMap<String, DownloadTask>>>,
    client: reqwest::Client,
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(RwLock::new(HashMap::new())),
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    pub async fn start(&self, id: String, url: String, path: PathBuf) -> Result<(), String> {
        self.start_with_fallback(id, vec![url], path).await
    }

    pub async fn start_with_fallback(
        &self,
        id: String,
        urls: Vec<String>,
        path: PathBuf,
    ) -> Result<(), String> {
        let tasks = self.tasks.clone();

        {
            if let Some(t) = tasks.write().await.get_mut(&id) {
                if matches!(t.status, DownloadStatus::Downloading) {
                    return Ok(());
                }
            }
        }

        let task = DownloadTask {
            id: id.clone(),
            url: urls.first().cloned().unwrap_or_default(),
            path: path.clone(),
            progress: 0,
            total: None,
            status: DownloadStatus::Pending,
            error: None,
            speed_bps: 0,
        };

        self.tasks.write().await.insert(id.clone(), task);

        let tasks = self.tasks.clone();
        let client = self.client.clone();

        tokio::spawn(async move {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }

            let mut last_error = String::new();

            // Number of attempts per mirror. Network errors on flaky mirrors
            // (e.g. hf-mirror.com) are transient, so retry before giving up.
            const MAX_ATTEMPTS_PER_MIRROR: usize = 3;

            for (attempt, url) in urls.iter().enumerate() {
                log::info!(
                    "[DownloadManager] start download: id={}, attempt={}/{}, url={}",
                    id,
                    attempt + 1,
                    urls.len(),
                    url
                );

                if attempt > 0 {
                    if let Some(t) = tasks.write().await.get_mut(&id) {
                        t.progress = 0;
                        t.total = None;
                        t.status = DownloadStatus::Pending;
                        t.error = None;
                        t.url = url.clone();
                    }
                }

                let mut attempt_error = String::new();
                let mut succeeded = false;

                for retry in 0..MAX_ATTEMPTS_PER_MIRROR {
                    if retry > 0 {
                        // Backoff before retrying the same mirror.
                        tokio::time::sleep(std::time::Duration::from_millis(800 * retry as u64))
                            .await;
                        if let Some(t) = tasks.write().await.get_mut(&id) {
                            t.progress = 0;
                            t.total = None;
                            t.status = DownloadStatus::Pending;
                            t.error = None;
                        }
                    }

                    let res = client.get(url).send().await;

                    match res {
                        Ok(response) => {
                            if !response.status().is_success() {
                                attempt_error = format!("HTTP {} from {}", response.status(), url);
                                log::warn!(
                                    "[DownloadManager] download failed: id={}, error={}",
                                    id,
                                    attempt_error
                                );
                                if path.exists() {
                                    let _ = std::fs::remove_file(&path);
                                }
                                continue;
                            }

                            let total = response.content_length();
                            if let Some(t) = tasks.write().await.get_mut(&id) {
                                t.total = total;
                                t.status = DownloadStatus::Downloading;
                            }

                            use futures::StreamExt;

                            let file_result = tokio::fs::File::create(&path).await;
                            if let Err(e) = file_result {
                                if let Some(t) = tasks.write().await.get_mut(&id) {
                                    t.status = DownloadStatus::Failed;
                                    t.error = Some(e.to_string());
                                }
                                return;
                            }
                            let mut file = file_result.unwrap();

                            use tokio::io::AsyncWriteExt;
                            let mut stream = response.bytes_stream();
                            let mut stream_error: Option<String> = None;
                            // Speed sampling state (sliding window).
                            let mut speed_mark = std::time::Instant::now();
                            let mut speed_base: u64 = 0;
                            while let Some(chunk_result) = stream.next().await {
                                match chunk_result {
                                    Ok(data) => {
                                        if let Err(e) = file.write_all(&data).await {
                                            if let Some(t) = tasks.write().await.get_mut(&id) {
                                                t.status = DownloadStatus::Failed;
                                                t.error = Some(e.to_string());
                                            }
                                            return;
                                        }
                                        let now = std::time::Instant::now();
                                        let elapsed_ms =
                                            now.duration_since(speed_mark).as_millis().max(1);
                                        if elapsed_ms >= 500 {
                                            if let Some(t) = tasks.write().await.get_mut(&id) {
                                                t.progress += data.len() as u64;
                                                t.speed_bps =
                                                    (t.progress.saturating_sub(speed_base)) * 1000
                                                        / elapsed_ms as u64;
                                            }
                                            if let Some(t) = tasks.read().await.get(&id) {
                                                speed_base = t.progress;
                                            }
                                            speed_mark = now;
                                        } else if let Some(t) = tasks.write().await.get_mut(&id) {
                                            t.progress += data.len() as u64;
                                        }
                                    }
                                    Err(e) => {
                                        attempt_error = e.to_string();
                                        stream_error = Some(e.to_string());
                                        log::warn!(
                                            "[DownloadManager] stream error: id={}, error={}",
                                            id,
                                            attempt_error
                                        );
                                        break;
                                    }
                                }
                            }

                            let bytes_written =
                                std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

                            // Verify the download actually completed: a network error
                            // mid-stream leaves a partial file that must NOT be treated
                            // as a successful download.
                            let complete = stream_error.is_none()
                                && bytes_written > 0
                                && total.map(|t| bytes_written >= t).unwrap_or(true);

                            if complete {
                                if let Err(e) = file.sync_all().await {
                                    if let Some(t) = tasks.write().await.get_mut(&id) {
                                        t.status = DownloadStatus::Failed;
                                        t.error = Some(format!("Sync error: {}", e));
                                    }
                                    return;
                                }

                                if let Some(t) = tasks.write().await.get_mut(&id) {
                                    t.status = DownloadStatus::Completed;
                                }
                                log::info!(
                                    "[DownloadManager] download completed: id={}, size={}",
                                    id,
                                    bytes_written
                                );
                                succeeded = true;
                                break;
                            }

                            // Incomplete download (truncated or stream error): remove the
                            // partial file and retry the same mirror before moving on.
                            log::warn!(
                                "[DownloadManager] download incomplete: id={}, size={}, total={:?}, error={:?}",
                                id,
                                bytes_written,
                                total,
                                stream_error
                            );

                            if path.exists() {
                                let _ = std::fs::remove_file(&path);
                            }
                        }
                        Err(e) => {
                            attempt_error = e.to_string();
                            log::warn!(
                                "[DownloadManager] download failed: id={}, error={}",
                                id,
                                attempt_error
                            );
                            if path.exists() {
                                let _ = std::fs::remove_file(&path);
                            }
                        }
                    }
                }

                if succeeded {
                    return;
                }
                last_error = attempt_error;
            }

            if let Some(t) = tasks.write().await.get_mut(&id) {
                t.status = DownloadStatus::Failed;
                t.error = Some(last_error);
            }
            log::error!("[DownloadManager] all sources failed: id={}", id);
        });

        Ok(())
    }

    pub async fn progress(&self, id: &str) -> Option<DownloadTask> {
        let tasks = self.tasks.read().await;
        tasks.get(id).cloned()
    }

    pub async fn list(&self) -> Vec<DownloadTask> {
        let tasks = self.tasks.read().await;
        tasks.values().cloned().collect()
    }
}
