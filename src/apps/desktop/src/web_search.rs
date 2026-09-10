//! Web search (AnySearch) — minimal self-contained port for non-agent callers
//! (ACE-Step lyrics advisor) after the legacy agent-stack removal; only the
//! `search_simple` path is retained here.

use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

const DEFAULT_ANYSEARCH_URL: &str = "https://api.anysearch.com/v1/search";
const DEFAULT_ANYSEARCH_TIMEOUT: u64 = 30;

/// AnySearch API wraps the payload in `{ code, message, data: { results, metadata } }`.
/// The legacy flat shape is kept as a fallback in case the API ever returns
/// the unwrapped shape.
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
    #[serde(alias = "snippet")]
    description: Option<String>,
    #[serde(default)]
    source: Option<String>,
}

/// Unified search result item from the search backend.
pub struct SearchResultItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: Option<String>,
}

struct AnySearchParams<'a> {
    query: &'a str,
    max_results: usize,
    language: &'a str,
}

fn is_private_ip(url_str: &str) -> bool {
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
    anysearch_url: String,
    anysearch_timeout_secs: u64,
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
            anysearch_url: DEFAULT_ANYSEARCH_URL.to_string(),
            anysearch_timeout_secs: DEFAULT_ANYSEARCH_TIMEOUT,
            anysearch_api_key,
        }
    }

    /// Reads the user-configured AnySearch API key from the global config
    /// service. Returns `None` if the service isn't initialized or the key
    /// isn't set (anonymous mode).
    async fn resolve_api_key(&self) -> Option<String> {
        let service =
            ai00_x_core::service::config::global::GlobalConfigManager::get_service().ok()?;
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

    /// Search using AnySearch API.
    async fn search_anysearch(
        &self,
        params: &AnySearchParams<'_>,
    ) -> Result<Vec<SearchResultItem>, String> {
        let body = json!({
            "query": params.query,
            "max_results": params.max_results,
            "language": params.language,
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(self.anysearch_timeout_secs))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|err| format!("Failed to create HTTP client: {err}"))?;

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
                    // 402 means quota exhausted - propagate as an error
                    return Err(format!("AnySearch HTTP error: {status}"));
                }

                // AnySearch wraps results in `{ data: { results, metadata } }`.
                // Try the wrapper shape first, fall back to the flat shape.
                let results: Vec<AnySearchResult> =
                    match serde_json::from_str::<AnySearchWrapper>(&resp_body) {
                        Ok(w) => w.data.map(|d| d.results).unwrap_or_default(),
                        Err(_) => match serde_json::from_str::<AnySearchResponse>(&resp_body) {
                            Ok(r) => r.results,
                            Err(e) => {
                                return Err(format!("Failed to parse AnySearch response: {e}"));
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
                    });
                }
                Ok(items)
            }
            Ok(Err(e)) => Err(format!("AnySearch request failed: {e}")),
            Err(_) => Err(format!(
                "AnySearch timed out after {} seconds",
                self.anysearch_timeout_secs
            )),
        }
    }

    /// Simplified single-query search for non-agent callers (e.g. ACE-Step
    /// lyrics advisor). Just a plain AnySearch call with snippet extraction.
    pub async fn search_simple(
        &self,
        query: &str,
        language: &str,
        max_results: usize,
    ) -> Result<Vec<SearchResultItem>, String> {
        let params = AnySearchParams {
            query,
            max_results,
            language,
        };
        self.search_anysearch(&params).await
    }
}
