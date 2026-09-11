//! Web search: AnySearch primary + SearXNG fallback.
//!
//! Standalone search client for non-agent callers (e.g. ACE-Step lyrics
//! advisor). Extracted from the retired agent tool stack — no `Tool` trait
//! plumbing, just plain async methods.

use crate::util::errors::{Ai00XError, Ai00XResult};
use log::{info, warn};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

const DEFAULT_SEARXNG_TIMEOUT: u64 = 15;
const DEFAULT_ANYSEARCH_URL: &str = "https://api.anysearch.com/v1/search";
const DEFAULT_ANYSEARCH_TIMEOUT: u64 = 30;

#[derive(Debug, Deserialize)]
struct SearXNGResponse {
    results: Vec<SearXNGResult>,
}

#[derive(Debug, Deserialize)]
struct SearXNGResult {
    url: String,
    title: String,
    content: Option<String>,
    engine: Option<String>,
}

/// AnySearch API wraps the payload in `{ code, message, data: { results, metadata } }`.
/// The legacy flat shape (`results` at top level) is kept as a fallback in
/// case the API ever returns the unwrapped form.
#[derive(Debug, Deserialize)]
struct AnySearchWrapper {
    data: Option<AnySearchData>,
}

#[derive(Debug, Deserialize)]
struct AnySearchData {
    results: Vec<AnySearchResult>,
}

#[derive(Debug, Deserialize)]
struct AnySearchResponse {
    results: Vec<AnySearchResult>,
}

#[derive(Debug, Deserialize)]
struct AnySearchResult {
    title: String,
    url: String,
    // API returns `snippet`; keep `description` as the field name for compat.
    #[serde(alias = "snippet")]
    description: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
}

/// Unified search result item from any search backend.
pub struct SearchResultItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: Option<String>,
    pub published_at: Option<String>,
}

/// Parameters for AnySearch API requests.
struct AnySearchParams<'a> {
    query: &'a str,
    max_results: usize,
    language: &'a str,
}

/// 私网/回环地址判定（SSRF 防护）：web_extract 抓取复用同口径。
pub fn is_private_ip(url_str: &str) -> bool {
    let parsed: reqwest::Url = match url_str.parse() {
        Ok(u) => u,
        Err(_) => return true,
    };
    let host = match parsed.host_str() {
        Some(h) => h,
        None => return true,
    };

    match host {
        "localhost" | "127.0.0.1" | "0.0.0.0" | "::1" => true,
        h if h.starts_with("10.") => true,
        h if h.starts_with("192.168.") => true,
        h if h.starts_with("169.254.") => true,
        h => {
            if h.starts_with("172.") {
                if let Ok(second) = h.split('.').nth(1).unwrap_or("0").parse::<u8>() {
                    return (16..=31).contains(&second);
                }
            }
            false
        }
    }
}

#[derive(Clone)]
pub struct WebSearchTool {
    base_url: String,
    timeout_secs: u64,
    anysearch_url: String,
    anysearch_timeout_secs: u64,
    /// Whether SearXNG fallback is enabled. Defaults to false — AnySearch runs
    /// standalone until a self-hosted SearXNG instance is configured.
    searxng_enabled: bool,
    /// Optional API key for AnySearch (sent as `Authorization: Bearer <key>`).
    /// When absent, anonymous access is used (lower rate limit: 10 req/min).
    anysearch_api_key: Option<String>,
}

impl Default for WebSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WebSearchTool {
    pub fn new() -> Self {
        // Anonymous access by default — each client IP gets its own 10 req/min
        // quota. Set the ANYSEARCH_API_KEY env var to switch to authenticated
        // mode (e.g. for testing).
        let anysearch_api_key = std::env::var("ANYSEARCH_API_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string());
        Self {
            base_url: crate::service::config::server_endpoints::searxng_url(),
            timeout_secs: DEFAULT_SEARXNG_TIMEOUT,
            anysearch_url: DEFAULT_ANYSEARCH_URL.to_string(),
            anysearch_timeout_secs: DEFAULT_ANYSEARCH_TIMEOUT,
            searxng_enabled: false,
            anysearch_api_key,
        }
    }

    pub fn with_base_url(mut self, url: String) -> Self {
        self.base_url = url;
        self
    }

    pub fn with_timeout(mut self, secs: u64) -> Self {
        self.timeout_secs = secs;
        self
    }

    /// Enable SearXNG as a fallback backend. When disabled (the default),
    /// AnySearch runs standalone — failures return empty results instead of
    /// falling through to SearXNG.
    pub fn with_searxng_enabled(mut self, enabled: bool) -> Self {
        self.searxng_enabled = enabled;
        self
    }

    /// Set the AnySearch API key explicitly (overrides env var).
    pub fn with_anysearch_api_key(mut self, key: String) -> Self {
        self.anysearch_api_key = Some(key);
        self
    }

    /// Reads the user-configured AnySearch API key from the global config
    /// service. Returns `None` if the service isn't initialized or the key
    /// isn't set (anonymous mode).
    async fn resolve_api_key(&self) -> Option<String> {
        let service = crate::service::config::global::GlobalConfigManager::get_service().ok()?;
        let key: Option<String> = service
            .get_config(Some("ai.anysearch_api_key"))
            .await
            .ok()?;
        key.filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
    }

    fn snippet(text: &str, max_chars: usize) -> String {
        let text = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .filter(|line| !line.starts_with('#'))
            .collect::<Vec<_>>()
            .join(" ");

        if text.chars().count() <= max_chars {
            return text;
        }

        let mut out = String::new();
        for ch in text.chars().take(max_chars - 3) {
            out.push(ch);
        }
        out.push_str("...");
        out
    }

    /// Search using AnySearch API (primary backend).
    async fn search_anysearch(
        &self,
        params: &AnySearchParams<'_>,
    ) -> Ai00XResult<Vec<SearchResultItem>> {
        let body = json!({
            "query": params.query,
            "max_results": params.max_results,
            "language": params.language,
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(self.anysearch_timeout_secs))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|err| Ai00XError::tool(format!("Failed to create HTTP client: {}", err)))?;

        let result = tokio::time::timeout(
            Duration::from_secs(self.anysearch_timeout_secs + 5),
            async {
                let mut req = client
                    .post(&self.anysearch_url)
                    .header("Content-Type", "application/json")
                    .json(&body);
                // Attach API key if configured. User-configured key (from
                // settings) takes precedence over the env var.
                let effective_key = self
                    .resolve_api_key()
                    .await
                    .or_else(|| self.anysearch_api_key.clone());
                if let Some(key) = effective_key {
                    req = req.header("Authorization", format!("Bearer {}", key));
                }
                let response = req.send().await?;
                let status = response.status();
                let resp_body = response.text().await?;
                Ok::<(reqwest::StatusCode, String), reqwest::Error>((status, resp_body))
            },
        )
        .await;

        match result {
            Ok(Ok((status, resp_body))) => {
                if !status.is_success() {
                    // 402 means quota exhausted - return error to trigger fallback
                    return Err(Ai00XError::tool(format!(
                        "AnySearch HTTP error: {}",
                        status
                    )));
                }

                // AnySearch wraps results in `{ data: { results, metadata } }`.
                // Try the wrapper shape first, fall back to the flat shape.
                let results: Vec<AnySearchResult> =
                    match serde_json::from_str::<AnySearchWrapper>(&resp_body) {
                        Ok(w) => w.data.map(|d| d.results).unwrap_or_default(),
                        Err(_) => match serde_json::from_str::<AnySearchResponse>(&resp_body) {
                            Ok(r) => r.results,
                            Err(e) => {
                                return Err(Ai00XError::tool(format!(
                                    "Failed to parse AnySearch response: {}",
                                    e
                                )));
                            }
                        },
                    };

                let mut items = Vec::new();
                for result in results.iter() {
                    if is_private_ip(&result.url) {
                        continue;
                    }
                    let snippet = result
                        .description
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .map(|s| Self::snippet(s, 320))
                        .unwrap_or_default();

                    items.push(SearchResultItem {
                        title: result.title.clone(),
                        url: result.url.clone(),
                        snippet,
                        source: result.source.clone(),
                        published_at: result.published_at.clone(),
                    });
                }
                Ok(items)
            }
            Ok(Err(e)) => Err(Ai00XError::tool(format!("AnySearch request failed: {}", e))),
            Err(_) => Err(Ai00XError::tool(format!(
                "AnySearch timed out after {} seconds",
                self.anysearch_timeout_secs
            ))),
        }
    }

    /// Simplified single-query search for non-agent callers (e.g. ACE-Step
    /// lyrics advisor). Just a plain AnySearch call with snippet extraction.
    ///
    /// Falls back to SearXNG if AnySearch returns empty and SearXNG is enabled.
    pub async fn search_simple(
        &self,
        query: &str,
        language: &str,
        max_results: usize,
    ) -> Ai00XResult<Vec<SearchResultItem>> {
        let params = AnySearchParams {
            query,
            max_results,
            language,
        };
        match self.search_anysearch(&params).await {
            Ok(results) if !results.is_empty() => Ok(results),
            Ok(_) if self.searxng_enabled => {
                warn!("WebSearch::search_simple: AnySearch empty, falling back to SearXNG");
                self.search_searxng(query, max_results, language, "general")
                    .await
            }
            Ok(_) => Ok(Vec::new()),
            Err(e) => {
                warn!(
                    "WebSearch::search_simple: AnySearch failed: {}, trying SearXNG fallback",
                    e
                );
                if self.searxng_enabled {
                    self.search_searxng(query, max_results, language, "general")
                        .await
                } else {
                    Err(e)
                }
            }
        }
    }

    /// Search using SearXNG API (fallback backend).
    async fn search_searxng(
        &self,
        query: &str,
        max_results: usize,
        language: &str,
        categories: &str,
    ) -> Ai00XResult<Vec<SearchResultItem>> {
        let encoded_query = urlencoding::encode(query);
        let encoded_language = urlencoding::encode(language);
        let encoded_categories = urlencoding::encode(categories);
        let api_url = format!(
            "{}/search?q={}&format=json&language={}&categories={}",
            self.base_url.trim_end_matches('/'),
            encoded_query,
            encoded_language,
            encoded_categories
        );

        info!(
            "WebSearch SearXNG fallback: query='{}', limit={}, language={}, categories={}",
            query, max_results, language, categories
        );

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(self.timeout_secs))
            .connect_timeout(Duration::from_secs(10))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .build()
            .map_err(|err| Ai00XError::tool(format!("Failed to create HTTP client: {}", err)))?;

        let result = tokio::time::timeout(Duration::from_secs(self.timeout_secs + 5), async {
            let response = client.get(&api_url).send().await?;
            let status = response.status();
            let body = response.text().await?;
            Ok::<(reqwest::StatusCode, String), reqwest::Error>((status, body))
        })
        .await;

        match result {
            Ok(Ok((status, body))) => {
                if !status.is_success() {
                    return Err(Ai00XError::tool(format!("SearXNG HTTP error: {}", status)));
                }

                let searx_response: Result<SearXNGResponse, _> = serde_json::from_str(&body);
                match searx_response {
                    Ok(resp) => {
                        let mut items = Vec::new();
                        for result in resp.results.iter().take(max_results) {
                            if is_private_ip(&result.url) {
                                continue;
                            }
                            let snippet = result
                                .content
                                .as_deref()
                                .filter(|s| !s.is_empty())
                                .map(|s| Self::snippet(s, 320))
                                .unwrap_or_default();

                            items.push(SearchResultItem {
                                title: result.title.clone(),
                                url: result.url.clone(),
                                snippet,
                                source: result.engine.clone(),
                                published_at: None,
                            });
                        }
                        Ok(items)
                    }
                    Err(e) => Err(Ai00XError::tool(format!(
                        "Failed to parse SearXNG response: {}",
                        e
                    ))),
                }
            }
            Ok(Err(e)) => Err(Ai00XError::tool(format!("SearXNG request failed: {}", e))),
            Err(_) => Err(Ai00XError::tool(format!(
                "SearXNG timed out after {} seconds",
                self.timeout_secs
            ))),
        }
    }
}
