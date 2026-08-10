use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    pub size: u64,
    pub hash: String,
    pub url: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub legacy_key: Option<String>,
    #[serde(default)]
    pub download_urls: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentManifest {
    #[serde(default)]
    pub version: String,
    pub models: HashMap<String, ModelInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedManifest {
    pub version: String,
    pub updated_at: String,
    pub components: HashMap<String, ComponentManifest>,
    #[serde(default)]
    pub hosts: HashMap<String, HostConfig>,
    #[serde(default)]
    pub aliases: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostConfig {
    pub name: String,
    pub base: String,
}

impl Default for UnifiedManifest {
    fn default() -> Self {
        Self::new()
    }
}

impl UnifiedManifest {
    pub fn new() -> Self {
        Self {
            version: "2.0.0".to_string(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            components: HashMap::new(),
            hosts: HashMap::new(),
            aliases: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUpdateInfo {
    pub component: String,
    pub name: String,
    pub key: String,
    pub url: String,
    pub download_url: String,
    #[serde(default)]
    pub available_hosts: HashMap<String, String>,
    pub local_hash: Option<String>,
    pub remote_hash: String,
    pub needs_update: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckResult {
    pub has_update: bool,
    pub updates: Vec<ModelUpdateInfo>,
}

#[derive(Debug, Clone)]
struct HostSpeed {
    host_key: String,
    latency_ms: u64,
}

pub struct ModelChecker {
    client: reqwest::Client,
    host_speeds: Arc<Mutex<Vec<HostSpeed>>>,
}

impl Default for ModelChecker {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelChecker {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .unwrap_or_else(|_| {
                    log::warn!(
                        "[model_checker] Failed to build HTTP client with timeout, using default"
                    );
                    reqwest::Client::new()
                }),
            host_speeds: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn get_cached_manifest_path() -> std::path::PathBuf {
        super::runtime::get_models_dir().join("manifest.json")
    }

    fn load_cached_manifest() -> Option<UnifiedManifest> {
        let path = Self::get_cached_manifest_path();
        if !path.exists() {
            return None;
        }
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<UnifiedManifest>(&text) {
                Ok(manifest) => {
                    log::info!("[model_checker] Loaded cached manifest from {:?}", path);
                    Some(manifest)
                }
                Err(e) => {
                    log::warn!("[model_checker] Failed to parse cached manifest: {}", e);
                    None
                }
            },
            Err(e) => {
                log::warn!("[model_checker] Failed to read cached manifest: {}", e);
                None
            }
        }
    }

    pub fn save_cached_manifest(manifest: &UnifiedManifest) {
        let path = Self::get_cached_manifest_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string_pretty(manifest) {
            Ok(text) => {
                if let Err(e) = std::fs::write(&path, text) {
                    log::warn!("[model_checker] Failed to save cached manifest: {}", e);
                } else {
                    log::info!("[model_checker] Saved cached manifest to {:?}", path);
                }
            }
            Err(e) => {
                log::warn!("[model_checker] Failed to serialize manifest: {}", e);
            }
        }
    }

    pub async fn check_updates(&self, manifest_url: Option<&str>) -> Result<CheckResult, String> {
        let remote_manifest = self.fetch_remote_manifest(manifest_url).await?;

        Self::save_cached_manifest(&remote_manifest);

        self.run_speed_test(&remote_manifest).await;

        let cached_manifest = Self::load_cached_manifest();
        let models_dir = super::runtime::get_models_dir();
        let mut updates = Vec::new();

        log::info!(
            "[model_checker] check_updates: remote components: {:?}",
            remote_manifest.components.keys().collect::<Vec<_>>()
        );

        for (component_name, component) in &remote_manifest.components {
            log::info!(
                "[model_checker] check_updates: component {} has {} models",
                component_name,
                component.models.len()
            );
            for (model_name, remote_info) in &component.models {
                let local_path = models_dir.join(&remote_info.url);
                let cached_hash = cached_manifest.as_ref().and_then(|cm| {
                    cm.components
                        .get(component_name)
                        .and_then(|c| c.models.get(model_name))
                        .map(|m| m.hash.clone())
                });

                let needs_update = if !local_path.exists() {
                    log::info!(
                        "[model_checker] {} not found, needs download",
                        remote_info.url
                    );
                    true
                } else {
                    let local_size = std::fs::metadata(&local_path).map(|m| m.len()).unwrap_or(0);

                    if remote_info.size > 0 && local_size != remote_info.size {
                        log::info!(
                            "[model_checker] {} size mismatch: local={} remote={}, needs re-download",
                            remote_info.url,
                            local_size,
                            remote_info.size
                        );
                        true
                    } else if let Some(ref cached) = cached_hash {
                        if cached != &remote_info.hash {
                            log::info!(
                                "[model_checker] {} hash changed, needs update",
                                remote_info.url
                            );
                            true
                        } else {
                            log::info!(
                                "[model_checker] {} up-to-date (size+hash matched), skipping",
                                remote_info.url
                            );
                            false
                        }
                    } else {
                        log::info!(
                            "[model_checker] {} exists (size ok) but no cached hash, needs verify",
                            remote_info.url
                        );
                        true
                    }
                };

                if needs_update {
                    let available_hosts = build_available_hosts(&remote_manifest, remote_info);
                    let download_url = choose_download_url(
                        &available_hosts,
                        &remote_manifest,
                        remote_info,
                        &self.host_speeds,
                    )
                    .await?;
                    updates.push(ModelUpdateInfo {
                        component: component_name.clone(),
                        name: model_name.clone(),
                        key: model_name.clone(),
                        url: remote_info.url.clone(),
                        download_url,
                        available_hosts,
                        local_hash: cached_hash,
                        remote_hash: remote_info.hash.clone(),
                        needs_update,
                    });
                }
            }
        }

        Ok(CheckResult {
            has_update: !updates.is_empty(),
            updates,
        })
    }

    async fn run_speed_test(&self, manifest: &UnifiedManifest) {
        let all_hosts = collect_all_hosts(manifest);

        if all_hosts.is_empty() {
            log::warn!("[model_checker] No hosts available for speed test");
            return;
        }

        log::info!(
            "[model_checker] Starting speed test for {} hosts",
            all_hosts.len()
        );

        let test_path = "asr/tokenizer.json";
        let mut results: Vec<HostSpeed> = Vec::new();

        let mut handles = Vec::new();

        for (host_key, base_url) in &all_hosts {
            let host_key = host_key.clone();
            let test_url = format!("{}/{}", base_url.trim_end_matches('/'), test_path);
            let client = self.client.clone();

            handles.push(tokio::spawn(async move {
                let start = std::time::Instant::now();
                let result = client
                    .head(&test_url)
                    .timeout(std::time::Duration::from_secs(8))
                    .send()
                    .await;
                let elapsed = start.elapsed().as_millis() as u64;

                match result {
                    Ok(resp) => {
                        if resp.status().is_success() || resp.status().is_redirection() {
                            log::info!(
                                "[model_checker] Speed test: host={} latency={}ms status={}",
                                host_key,
                                elapsed,
                                resp.status()
                            );
                            Some(HostSpeed {
                                host_key,
                                latency_ms: elapsed,
                            })
                        } else {
                            log::warn!(
                                "[model_checker] Speed test: host={} latency={}ms status={} (not ok)",
                                host_key,
                                elapsed,
                                resp.status()
                            );
                            Some(HostSpeed {
                                host_key,
                                latency_ms: u64::MAX,
                            })
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "[model_checker] Speed test: host={} FAILED: {}",
                            host_key,
                            e
                        );
                        Some(HostSpeed {
                            host_key,
                            latency_ms: u64::MAX,
                        })
                    }
                }
            }));
        }

        for handle in handles {
            if let Ok(Some(speed)) = handle.await {
                results.push(speed);
            }
        }

        results.sort_by_key(|s| s.latency_ms);

        for speed in &results {
            if speed.latency_ms == u64::MAX {
                log::warn!(
                    "[model_checker] Speed ranking: host={} UNREACHABLE",
                    speed.host_key
                );
            } else {
                log::info!(
                    "[model_checker] Speed ranking: host={} latency={}ms",
                    speed.host_key,
                    speed.latency_ms
                );
            }
        }

        let mut speeds = self.host_speeds.lock().await;
        *speeds = results;
    }

    async fn fetch_remote_manifest(
        &self,
        manifest_url: Option<&str>,
    ) -> Result<UnifiedManifest, String> {
        let candidates = if let Some(url) = manifest_url {
            vec![url.to_string()]
        } else {
            vec![
                "https://hf-mirror.com/cgisky/ai00-x/resolve/main/manifest.json".to_string(),
                "https://modelscope.cn/models/cgisky/Ai00-X/resolve/master/manifest.json"
                    .to_string(),
                "https://huggingface.co/cgisky/ai00-x/resolve/main/manifest.json".to_string(),
            ]
        };

        let mut last_error = String::from("No manifest candidates configured");
        for url in candidates {
            match self.fetch_manifest_url(&url).await {
                Ok(manifest) => return Ok(manifest),
                Err(err) => {
                    last_error = format!("{url}: {err}");
                    log::warn!(
                        "[model_checker] fetch_remote_manifest failed: {}",
                        last_error
                    );
                }
            }
        }

        Err(last_error)
    }

    async fn fetch_manifest_url(&self, url: &str) -> Result<UnifiedManifest, String> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch manifest: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("HTTP error: {}", response.status()));
        }

        let text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        serde_json::from_str(&text).map_err(|e| format!("Failed to parse manifest: {}", e))
    }
}

fn collect_all_hosts(manifest: &UnifiedManifest) -> Vec<(String, String)> {
    let mut hosts: Vec<(String, String)> = manifest
        .hosts
        .iter()
        .map(|(k, v)| (k.clone(), v.base.clone()))
        .collect();

    let has_hf_mirror = hosts.iter().any(|(k, _)| k == "hf-mirror");
    if !has_hf_mirror {
        hosts.push((
            "hf-mirror".to_string(),
            "https://hf-mirror.com/cgisky/ai00-x/resolve/main".to_string(),
        ));
    }

    hosts
}

fn build_available_hosts(
    manifest: &UnifiedManifest,
    remote_info: &ModelInfo,
) -> HashMap<String, String> {
    if !remote_info.download_urls.is_empty() {
        let mut urls = remote_info.download_urls.clone();
        if !urls.contains_key("hf-mirror") {
            urls.insert(
                "hf-mirror".to_string(),
                format!(
                    "https://hf-mirror.com/cgisky/ai00-x/resolve/main/{}",
                    remote_info.url
                ),
            );
        }
        return urls;
    }

    let mut hosts = manifest
        .hosts
        .iter()
        .map(|(host, config)| {
            (
                host.clone(),
                format!("{}/{}", config.base.trim_end_matches('/'), remote_info.url),
            )
        })
        .collect::<HashMap<_, _>>();

    if !hosts.contains_key("hf-mirror") {
        hosts.insert(
            "hf-mirror".to_string(),
            format!(
                "https://hf-mirror.com/cgisky/ai00-x/resolve/main/{}",
                remote_info.url
            ),
        );
    }

    hosts
}

async fn choose_download_url(
    available_hosts: &HashMap<String, String>,
    manifest: &UnifiedManifest,
    remote_info: &ModelInfo,
    host_speeds: &Arc<Mutex<Vec<HostSpeed>>>,
) -> Result<String, String> {
    let speeds = host_speeds.lock().await;

    if !speeds.is_empty() {
        for speed in speeds.iter() {
            if speed.latency_ms == u64::MAX {
                continue;
            }
            if let Some(url) = available_hosts.get(&speed.host_key) {
                log::info!(
                    "[model_checker] Selected host {} (latency={}ms) for {}",
                    speed.host_key,
                    speed.latency_ms,
                    remote_info.url
                );
                return Ok(url.clone());
            }
        }
    }

    drop(speeds);

    for preferred in ["hf-mirror", "ms", "hf"] {
        if let Some(url) = available_hosts.get(preferred) {
            return Ok(url.clone());
        }
    }

    if let Some(url) = available_hosts.values().next() {
        return Ok(url.clone());
    }

    if let Some(host) = manifest.hosts.values().next() {
        return Ok(format!(
            "{}/{}",
            host.base.trim_end_matches('/'),
            remote_info.url
        ));
    }

    Err(format!("No download url available for {}", remote_info.url))
}
