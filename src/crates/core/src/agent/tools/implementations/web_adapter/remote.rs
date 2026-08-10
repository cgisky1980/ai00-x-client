use std::path::PathBuf;

use super::parser::parse_yaml_adapter;
use super::registry::WebAdapterRegistry;
use super::types::AdapterSource;

const DEFAULT_GITHUB_REPO: &str = "ai00-x/web-adapters";
const DEFAULT_BRANCH: &str = "main";

const GITHUB_MIRRORS: &[&str] = &[
    "https://ghproxy.com/",
    "https://mirror.ghproxy.com/",
    "https://gh-proxy.com/",
    "https://ghps.cc/",
];

pub struct RemoteAdapterConfig {
    pub repo: String,
    pub branch: String,
    pub use_mirror: bool,
    pub target_dir: Option<PathBuf>,
}

impl Default for RemoteAdapterConfig {
    fn default() -> Self {
        Self {
            repo: DEFAULT_GITHUB_REPO.to_string(),
            branch: DEFAULT_BRANCH.to_string(),
            use_mirror: true,
            target_dir: None,
        }
    }
}

impl RemoteAdapterConfig {
    pub fn with_repo(mut self, repo: String) -> Self {
        self.repo = repo;
        self
    }

    pub fn with_branch(mut self, branch: String) -> Self {
        self.branch = branch;
        self
    }

    pub fn without_mirror(mut self) -> Self {
        self.use_mirror = false;
        self
    }

    pub fn local_cache_dir(&self) -> Option<PathBuf> {
        if let Some(ref dir) = self.target_dir {
            return Some(dir.clone());
        }
        dirs::home_dir().map(|p| {
            p.join(".ai00-x")
                .join("web-adapters")
                .join("_remote")
                .join(&self.repo)
        })
    }
}

pub async fn fetch_remote_adapters(
    config: &RemoteAdapterConfig,
    registry: &mut WebAdapterRegistry,
) -> Result<usize, String> {
    let cache_dir = config
        .local_cache_dir()
        .ok_or("Cannot determine cache directory")?;

    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("Failed to create cache dir: {e}"))?;

    let index_url = format!(
        "https://api.github.com/repos/{}/contents/adapters?ref={}",
        config.repo, config.branch
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("ai00-x/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let index_content = fetch_with_mirrors(&client, &index_url, config.use_mirror).await?;

    let dirs: Vec<GitHubContent> = serde_json::from_str(&index_content)
        .map_err(|e| format!("Failed to parse GitHub API response: {e}"))?;

    let site_dirs: Vec<&GitHubContent> = dirs.iter().filter(|c| c.r#type == "dir").collect();

    let mut count = 0;

    for site_dir in site_dirs {
        let site_name = &site_dir.name;
        let site_cache_dir = cache_dir.join(site_name);
        std::fs::create_dir_all(&site_cache_dir)
            .map_err(|e| format!("Failed to create site cache dir: {e}"))?;

        let listing_url = format!(
            "https://api.github.com/repos/{}/contents/adapters/{}?ref={}",
            config.repo, site_name, config.branch
        );

        let listing_content =
            match fetch_with_mirrors(&client, &listing_url, config.use_mirror).await {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("Failed to fetch listing for site '{}': {}", site_name, e);
                    continue;
                }
            };

        let files: Vec<GitHubContent> = match serde_json::from_str(&listing_content) {
            Ok(f) => f,
            Err(e) => {
                log::warn!("Failed to parse listing for site '{}': {}", site_name, e);
                continue;
            }
        };

        for file in files
            .iter()
            .filter(|c| c.r#type == "file" && is_yaml_name(&c.name))
        {
            let yaml_content =
                match fetch_with_mirrors(&client, &file.download_url, config.use_mirror).await {
                    Ok(c) => c,
                    Err(e) => {
                        log::warn!("Failed to fetch '{}': {}", file.name, e);
                        continue;
                    }
                };

            let local_path = site_cache_dir.join(&file.name);
            if let Err(e) = std::fs::write(&local_path, &yaml_content) {
                log::warn!("Failed to cache '{}': {}", file.name, e);
            }

            match parse_yaml_adapter(&yaml_content) {
                Ok(adapter) => {
                    registry.register(adapter, AdapterSource::Remote);
                    count += 1;
                }
                Err(e) => {
                    log::warn!("Failed to parse remote adapter '{}': {}", file.name, e);
                }
            }
        }
    }

    log::info!("Loaded {} remote adapter(s) from {}", count, config.repo);
    Ok(count)
}

pub async fn load_cached_remote_adapters(
    config: &RemoteAdapterConfig,
    registry: &mut WebAdapterRegistry,
) -> Result<usize, String> {
    let cache_dir = config
        .local_cache_dir()
        .ok_or("Cannot determine cache directory")?;

    if !cache_dir.exists() {
        return Ok(0);
    }

    let mut count = 0;
    let entries =
        std::fs::read_dir(&cache_dir).map_err(|e| format!("Failed to read cache dir: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(sub_entries) = std::fs::read_dir(&path) {
                for sub_entry in sub_entries.flatten() {
                    let sub_path = sub_entry.path();
                    if sub_path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e == "yaml" || e == "yml")
                        .unwrap_or(false)
                    {
                        if let Ok(content) = std::fs::read_to_string(&sub_path) {
                            match parse_yaml_adapter(&content) {
                                Ok(adapter) => {
                                    registry.register(adapter, AdapterSource::Remote);
                                    count += 1;
                                }
                                Err(e) => {
                                    log::warn!(
                                        "Failed to parse cached adapter '{}': {}",
                                        sub_path.display(),
                                        e
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    log::info!("Loaded {} cached remote adapter(s)", count);
    Ok(count)
}

async fn fetch_with_mirrors(
    client: &reqwest::Client,
    url: &str,
    use_mirror: bool,
) -> Result<String, String> {
    if !use_mirror {
        return fetch_url(client, url).await;
    }

    if url.starts_with("https://api.github.com/")
        || url.starts_with("https://raw.githubusercontent.com/")
    {
        for mirror in GITHUB_MIRRORS {
            let mirrored = format!("{}{}", mirror, url);
            match fetch_url(client, &mirrored).await {
                Ok(content) => {
                    log::debug!("Fetched via mirror: {}", mirror);
                    return Ok(content);
                }
                Err(_) => continue,
            }
        }
    }

    fetch_url(client, url).await
}

async fn fetch_url(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {} for {}", status, url));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))
}

fn is_yaml_name(name: &str) -> bool {
    name.ends_with(".yaml") || name.ends_with(".yml")
}

#[derive(serde::Deserialize)]
struct GitHubContent {
    name: String,
    r#type: String,
    #[serde(default)]
    download_url: String,
}
