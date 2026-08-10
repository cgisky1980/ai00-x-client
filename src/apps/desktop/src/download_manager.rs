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
        };

        self.tasks.write().await.insert(id.clone(), task);

        let tasks = self.tasks.clone();
        let client = self.client.clone();

        tokio::spawn(async move {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }

            let mut last_error = String::new();

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

                let res = client.get(url).send().await;

                match res {
                    Ok(response) => {
                        if !response.status().is_success() {
                            last_error = format!("HTTP {} from {}", response.status(), url);
                            log::warn!(
                                "[DownloadManager] download failed: id={}, error={}",
                                id,
                                last_error
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
                                    if let Some(t) = tasks.write().await.get_mut(&id) {
                                        t.progress += data.len() as u64;
                                    }
                                }
                                Err(e) => {
                                    last_error = e.to_string();
                                    log::warn!(
                                        "[DownloadManager] stream error: id={}, error={}",
                                        id,
                                        last_error
                                    );
                                    break;
                                }
                            }
                        }

                        if let Ok(metadata) = std::fs::metadata(&path) {
                            if metadata.len() > 0 {
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
                                    metadata.len()
                                );
                                return;
                            }
                        }

                        if path.exists() {
                            let _ = std::fs::remove_file(&path);
                        }
                        continue;
                    }
                    Err(e) => {
                        last_error = e.to_string();
                        log::warn!(
                            "[DownloadManager] download failed: id={}, error={}",
                            id,
                            last_error
                        );
                        if path.exists() {
                            let _ = std::fs::remove_file(&path);
                        }
                        continue;
                    }
                }
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
