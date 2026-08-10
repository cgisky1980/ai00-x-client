//! Web tool implementation - WebSearchTool (SearXNG) and WebFetchTool (Chromium + Readability)

use crate::agent::tools::framework::{Tool, ToolResult, ToolUseContext, ValidationResult};
use crate::agent::tools::implementations::web_adapter::{
    execute_adapter, get_global_adapter_registry,
};
use crate::util::errors::{Ai00XError, Ai00XResult};
use async_trait::async_trait;
use headless_chrome::browser::default_executable;
use headless_chrome::{Browser, LaunchOptionsBuilder};
use htmd::HtmlToMarkdown;
use log::{error, info, warn};
use regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::thread;
use std::time::Duration;

const DEFAULT_SEARXNG_TIMEOUT: u64 = 15;
const DEFAULT_ANYSEARCH_URL: &str = "https://api.anysearch.com/v1/search";
const DEFAULT_ANYSEARCH_TIMEOUT: u64 = 30;
const DEFAULT_FETCH_WAIT_SECS: u64 = 3;
const DEFAULT_FETCH_MAX_LENGTH: usize = 50000;
const RWKV_ORGANIZE_CHUNK_CHARS: usize = 2000;
const RWKV_ORGANIZE_MAX_TOTAL_CHARS: usize = 60000;
const RWKV_ORGANIZE_MAX_TOKENS: u32 = 300;

const READABILITY_JS: &str = include_str!("resources/Readability.js");

#[derive(Debug, Deserialize)]
struct SearXNGResponse {
    results: Vec<SearXNGResult>,
    #[allow(dead_code)]
    number_of_results: Option<i64>,
    #[allow(dead_code)]
    suggestions: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct SearXNGResult {
    url: String,
    title: String,
    content: Option<String>,
    engine: Option<String>,
    #[allow(dead_code)]
    score: Option<f64>,
    #[allow(dead_code)]
    category: Option<String>,
}

/// AnySearch API wraps the payload in `{ code, message, data: { results, metadata } }`.
/// The legacy `AnySearchResponse` (flat `results` at top level) is kept as a
/// fallback in case the API ever returns the unwrapped shape.
#[derive(Debug, Deserialize)]
struct AnySearchWrapper {
    #[allow(dead_code)]
    code: i64,
    #[allow(dead_code)]
    message: String,
    data: Option<AnySearchData>,
}

#[derive(Debug, Deserialize)]
struct AnySearchData {
    results: Vec<AnySearchResult>,
    #[allow(dead_code)]
    metadata: Option<AnySearchMetadata>,
}

#[derive(Debug, Deserialize)]
struct AnySearchResponse {
    results: Vec<AnySearchResult>,
    #[allow(dead_code)]
    metadata: Option<AnySearchMetadata>,
}

#[derive(Debug, Deserialize)]
struct AnySearchResult {
    title: String,
    url: String,
    // API returns `snippet`; keep `description` as the field name for compat.
    #[serde(alias = "snippet")]
    description: Option<String>,
    content: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    score: Option<f64>,
    #[allow(dead_code)]
    #[serde(default)]
    quality_score: Option<f64>,
    #[serde(default)]
    published_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnySearchMetadata {
    #[allow(dead_code)]
    total_results: Option<i64>,
    #[allow(dead_code)]
    search_time_ms: Option<i64>,
    #[allow(dead_code)]
    request_id: Option<String>,
}

/// Unified search result item from any search backend.
/// Public so non-agent callers (e.g. ACE-Step lyrics advisor) can use the
/// `WebSearchTool::search_simple` method without a full `ToolUseContext`.
pub struct SearchResultItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub content: Option<String>,
    pub source: Option<String>,
    pub published_at: Option<String>,
}

/// Parameters for AnySearch API requests.
/// v2.1.0 removed content_types/zone/freshness — the backend now handles
/// these automatically via hybrid ranking (semantic relevance + freshness).
struct AnySearchParams<'a> {
    query: &'a str,
    max_results: usize,
    language: &'a str,
    domains: &'a Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
enum SearchResultCategory {
    Relevant,
    NeedsDetail,
    Irrelevant,
}

#[derive(Debug, Clone)]
struct FilteredResult {
    index: usize,
    category: SearchResultCategory,
    reason: String,
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
        // quota, which scales better than a single shared API key (20 req/min
        // total) when many users are concurrent. Set the ANYSEARCH_API_KEY env
        // var to switch to authenticated mode (e.g. for testing).
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
    /// falling through to SearXNG. Enable after deploying a self-hosted
    /// SearXNG instance with `search.formats: [html, json]`.
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

    /// Search using AnySearch API (primary backend)
    async fn search_anysearch(
        &self,
        params: &AnySearchParams<'_>,
    ) -> Ai00XResult<Vec<SearchResultItem>> {
        let mut body = json!({
            "query": params.query,
            "max_results": params.max_results,
            "language": params.language,
        });

        if let Some(ref domains) = params.domains {
            body.as_object_mut()
                .map(|m| m.insert("domains".to_string(), json!(domains)));
        }

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
                        content: result.content.clone(),
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
    /// lyrics advisor). Does NOT use RWKV query expansion or result
    /// organization — just a plain AnySearch call with snippet extraction.
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
            domains: &None,
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

    /// Fire multiple AnySearch queries concurrently and merge + de-duplicate
    /// results by URL. Returns a single merged vector.
    async fn search_anysearch_concurrent(
        &self,
        queries: &[String],
        per_query: usize,
        language: &str,
        domains: &Option<Vec<String>>,
    ) -> Ai00XResult<Vec<SearchResultItem>> {
        if queries.is_empty() {
            return Ok(Vec::new());
        }
        // Single query — skip the concurrency overhead.
        if queries.len() == 1 {
            let params = AnySearchParams {
                query: &queries[0],
                max_results: per_query,
                language,
                domains,
            };
            return self.search_anysearch(&params).await;
        }

        let mut handles = Vec::with_capacity(queries.len());
        for q in queries {
            // Each task owns its query + language + domains so the spawned
            // future is 'static (AnySearchParams borrows from these owned values).
            let q_owned = q.clone();
            let lang_owned = language.to_string();
            let domains_owned = domains.clone();
            let this = self.clone();
            let handle = tokio::spawn(async move {
                let params = AnySearchParams {
                    query: &q_owned,
                    max_results: per_query,
                    language: &lang_owned,
                    domains: &domains_owned,
                };
                (q_owned.clone(), this.search_anysearch(&params).await)
            });
            handles.push(handle);
        }

        let mut merged: Vec<SearchResultItem> = Vec::new();
        let mut seen_urls: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut errors = 0usize;
        for handle in handles {
            match handle.await {
                Ok((_, Ok(results))) => {
                    for item in results {
                        if seen_urls.insert(item.url.clone()) {
                            merged.push(item);
                        }
                    }
                }
                Ok((q, Err(e))) => {
                    errors += 1;
                    warn!("WebSearch: concurrent query '{}' failed: {}", q, e);
                }
                Err(e) => {
                    errors += 1;
                    warn!("WebSearch: concurrent query task join error: {}", e);
                }
            }
        }

        if merged.is_empty() && errors == queries.len() {
            return Err(Ai00XError::tool(
                "All concurrent AnySearch queries failed".to_string(),
            ));
        }
        Ok(merged)
    }

    /// Search using SearXNG API (fallback backend)
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
                                content: None, // SearXNG has no cleaned content
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

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "WebSearch"
    }

    async fn description(&self) -> Ai00XResult<String> {
        Ok(
            r#"- Allows Ai00-X to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Uses AnySearch as the primary search engine (with SearXNG as fallback)
- Returns search results including cleaned page content (no need to WebFetch separately)
- Results are filtered and organized by AI for relevance before being returned
- Use this tool for accessing information beyond Ai00-X's knowledge cutoff

Usage notes:
- Use when you need current information not in training data
- Effective for recent news, current events, product updates, or real-time data
- Search queries should be specific and well-targeted for best results
- Results include title, URL, snippet, and cleaned page content
- Supports 16 vertical domains (v2.1.0): general, resource, social_media, finance, academic, legal, health, business, security, ip, code, energy, environment, agriculture, travel, film, gaming
- Hybrid ranking (v2.1.0): semantic relevance + real-time freshness signals, handled automatically by the backend
- Supports language selection for localized results
- Search results include cleaned content, so you usually do NOT need to use WebFetchTool to get page content

CRITICAL: When WebSearch fails or reports that a domain cannot be fetched, you must NOT attempt to retrieve the content through alternative means. Specifically:
- Do NOT use bash commands (curl, wget, lynx, etc.) to fetch URLs
- Do NOT use Python (requests, urllib, httpx, aiohttp, etc.) to fetch URLs
- Do NOT use any other programming language or library to make HTTP requests
- Do NOT attempt to access cached versions, archive sites, or mirrors of blocked content
These restrictions apply to ALL web fetching. If content cannot be retrieved through WebSearch or WebFetch, inform the user and offer alternative approaches."#
                .to_string(),
        )
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query keywords"
                },
                "num_results": {
                    "type": "number",
                    "description": "Number of search results to return (1-10, default: 10)",
                    "default": 10,
                    "minimum": 1,
                    "maximum": 10
                },
                "categories": {
                    "type": "string",
                    "description": "Search category for SearXNG fallback: general, images, news, videos, music, files, it, science, social media (default: general)",
                    "default": "general"
                },
                "language": {
                    "type": "string",
                    "description": "Search language code, e.g. zh-CN, en-US, ja-JP (default: zh-CN)",
                    "default": "zh-CN"
                },
                "domains": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Vertical domain filters (AnySearch v2.1.0): general, resource, social_media, finance, academic, legal, health, business, security, ip, code, energy, environment, agriculture, travel, film, gaming"
                },
                "expand_query": {
                    "type": "boolean",
                    "description": "When true (default), uses RWKV to generate Chinese/English query variants and fires up to 4 concurrent searches for broader coverage. Set to false for a single-query search.",
                    "default": true
                }
            },
            "required": ["query"]
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn needs_permissions(&self, _input: Option<&Value>) -> bool {
        false
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        let query = input
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| Ai00XError::tool("query is required".to_string()))?;

        let do_organize = input
            .get("organize")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let expand_query = input
            .get("expand_query")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let session_id = context.session_id.clone().unwrap_or_default();
        let turn_id = context.dialog_turn_id.clone().unwrap_or_default();

        let limit = input
            .get("num_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(10)
            .clamp(1, 10) as usize;

        let language = input
            .get("language")
            .and_then(|v| v.as_str())
            .unwrap_or("zh-CN");

        let categories = input
            .get("categories")
            .and_then(|v| v.as_str())
            .unwrap_or("general");

        let domains: Option<Vec<String>> =
            input.get("domains").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            });

        // 1. Try AnySearch first (primary backend).
        // When expand_query is enabled, use RWKV to generate Chinese/English
        // query variants, then fire up to MAX_CONCURRENT_QUERIES concurrent
        // searches (limited by the anonymous rate limit of 10/min).
        let mut provider = "anysearch";
        let mut queries: Vec<String> = vec![query.to_string()];
        let mut expanded = false;

        if expand_query && do_organize {
            let variants =
                generate_search_variants_with_rwkv(query, language, &session_id, &turn_id).await;
            if !variants.is_empty() {
                info!(
                    "WebSearch: RWKV generated {} query variants for '{}'",
                    variants.len(),
                    query
                );
                queries.extend(variants);
                queries.truncate(MAX_CONCURRENT_QUERIES);
                expanded = true;
            }
        }

        let search_results = if expanded {
            // Concurrent multi-query search: each query gets a small result set,
            // merged and de-duplicated by URL.
            match self
                .search_anysearch_concurrent(&queries, EXPAND_PER_QUERY_RESULTS, language, &domains)
                .await
            {
                Ok(results) if !results.is_empty() => {
                    info!(
                        "WebSearch: concurrent search ({} queries) returned {} merged results for '{}'",
                        queries.len(),
                        results.len(),
                        query
                    );
                    results
                }
                Ok(_) if self.searxng_enabled => {
                    warn!("WebSearch: concurrent search returned empty, falling back to SearXNG");
                    provider = "searxng";
                    self.search_searxng(query, limit, language, categories)
                        .await?
                }
                Ok(_) => {
                    warn!(
                        "WebSearch: concurrent search returned empty for '{}' (SearXNG fallback disabled)",
                        query
                    );
                    Vec::new()
                }
                Err(e) => {
                    warn!(
                        "WebSearch: concurrent search failed: {}, falling back to single query",
                        e
                    );
                    let anysearch_params = AnySearchParams {
                        query,
                        max_results: limit,
                        language,
                        domains: &domains,
                    };
                    self.search_anysearch(&anysearch_params)
                        .await
                        .unwrap_or_default()
                }
            }
        } else {
            // Single-query search (original path).
            let anysearch_params = AnySearchParams {
                query,
                max_results: limit,
                language,
                domains: &domains,
            };
            match self.search_anysearch(&anysearch_params).await {
                Ok(results) if !results.is_empty() => {
                    info!(
                        "WebSearch: AnySearch returned {} results for '{}'",
                        results.len(),
                        query
                    );
                    results
                }
                Ok(_) if self.searxng_enabled => {
                    warn!("WebSearch: AnySearch returned empty, falling back to SearXNG");
                    provider = "searxng";
                    self.search_searxng(query, limit, language, categories)
                        .await?
                }
                Ok(_) => {
                    warn!(
                        "WebSearch: AnySearch returned empty for '{}' (SearXNG fallback disabled)",
                        query
                    );
                    Vec::new()
                }
                Err(e) => {
                    warn!("WebSearch: AnySearch error: {}, falling back to SearXNG", e);
                    if self.searxng_enabled {
                        provider = "searxng";
                        self.search_searxng(query, limit, language, categories)
                            .await?
                    } else {
                        Vec::new()
                    }
                }
            }
        };

        // 2. Build JSON results for filtering.
        // With 4 queries × 10 results = 40 raw → ~20-30 after de-dup.
        // Feed limit×3 to the RWKV filter so it picks the best subset.
        let candidate_pool = limit.saturating_mul(3);
        let mut results_json = Vec::new();
        let mut formatted = format!("Search results for: '{}'\n\n", query);
        let mut idx = 0;

        for item in search_results.iter().take(candidate_pool) {
            idx += 1;

            let snippet_for_filter = if let Some(ref content) = item.content {
                Self::snippet(content, 500)
            } else {
                item.snippet.clone()
            };

            results_json.push(json!({
                "title": item.title,
                "url": item.url,
                "snippet": snippet_for_filter,
                "source": item.source,
                "has_content": item.content.is_some()
            }));

            formatted.push_str(&format!("{}. {}\n   URL: {}\n", idx, item.title, item.url));
            if !item.snippet.is_empty() {
                formatted.push_str(&format!("   {}\n", item.snippet));
            }
            if let Some(ref source) = item.source {
                formatted.push_str(&format!("   [{}]\n", source));
            }
            if let Some(ref published) = item.published_at {
                formatted.push_str(&format!("   Published: {}\n", published));
            }
            formatted.push('\n');
        }

        if results_json.is_empty() {
            let msg = format!("No results found for: {}", query);
            let result = ToolResult::Result {
                data: json!({
                    "query": query,
                    "results": [],
                    "result_count": 0,
                    "provider": provider,
                    "message": msg
                }),
                result_for_assistant: Some(msg),
                image_attachments: None,
            };
            return Ok(vec![result]);
        }

        // 3. RWKV filtering + content organizing
        let mut result_data = json!({
            "query": query,
            "results": results_json,
            "result_count": idx,
            "provider": provider
        });

        let result_for_assistant = if do_organize && idx > 0 {
            match filter_search_results_with_rwkv(query, &results_json, &session_id, &turn_id).await
            {
                Ok(Some(filter_results)) => {
                    let mut filtered_formatted = format!("Search results for: '{}'\n\n", query);
                    let mut kept_results = Vec::new();
                    let mut filter_info = Vec::new();

                    for fr in &filter_results {
                        let category_label = match fr.category {
                            SearchResultCategory::Relevant => "RELEVANT",
                            SearchResultCategory::NeedsDetail => "NEEDS_DETAIL",
                            SearchResultCategory::Irrelevant => "IRRELEVANT",
                        };
                        filter_info.push(json!({
                            "index": fr.index,
                            "category": category_label,
                            "reason": fr.reason
                        }));

                        if fr.category == SearchResultCategory::Irrelevant {
                            continue;
                        }

                        // Find the corresponding SearchResultItem
                        let item_index = fr.index.wrapping_sub(1);
                        if item_index >= search_results.len() {
                            continue;
                        }
                        let item = &search_results[item_index];

                        let category_tag = match fr.category {
                            SearchResultCategory::Relevant => "[RELEVANT]",
                            SearchResultCategory::NeedsDetail => "[NEEDS_DETAIL]",
                            SearchResultCategory::Irrelevant => unreachable!(),
                        };

                        let new_idx = kept_results.len() + 1;
                        filtered_formatted.push_str(&format!(
                            "{}. {} {}\n   URL: {}\n",
                            new_idx, item.title, category_tag, item.url
                        ));
                        if !item.snippet.is_empty() {
                            filtered_formatted.push_str(&format!("   {}\n", item.snippet));
                        }
                        if let Some(ref source) = item.source {
                            filtered_formatted.push_str(&format!("   [{}]\n", source));
                        }
                        if let Some(ref published) = item.published_at {
                            filtered_formatted.push_str(&format!("   Published: {}\n", published));
                        }
                        if !fr.reason.is_empty() {
                            filtered_formatted
                                .push_str(&format!("   Filter reason: {}\n", fr.reason));
                        }

                        // If content is available, organize and include it
                        if let Some(ref content) = item.content {
                            if content.len() > 200 {
                                match organize_content_with_rwkv(content, &session_id, &turn_id)
                                    .await
                                {
                                    Ok(Some(organized)) => {
                                        filtered_formatted
                                            .push_str(&format!("   Content:\n   {}\n", organized));
                                    }
                                    _ => {
                                        filtered_formatted.push_str(&format!(
                                            "   Content: {}\n",
                                            Self::snippet(content, 2000)
                                        ));
                                    }
                                }
                            } else if !content.is_empty() {
                                filtered_formatted.push_str(&format!("   Content: {}\n", content));
                            }
                        }

                        filtered_formatted.push('\n');
                        kept_results.push(results_json[item_index].clone());
                    }

                    if let serde_json::Value::Object(ref mut map) = result_data {
                        map.insert(
                            "organized".to_string(),
                            json!({
                                "filter_method": "rwkv_filter",
                                "filter_results": filter_info,
                                "relevant_count": filter_results.iter().filter(|f| f.category == SearchResultCategory::Relevant).count(),
                                "needs_detail_count": filter_results.iter().filter(|f| f.category == SearchResultCategory::NeedsDetail).count(),
                                "irrelevant_count": filter_results.iter().filter(|f| f.category == SearchResultCategory::Irrelevant).count(),
                            }),
                        );
                    }

                    if kept_results.is_empty() {
                        formatted
                    } else {
                        filtered_formatted
                    }
                }
                _ => {
                    warn!("WebSearch: RWKV filter failed, using raw results");
                    formatted
                }
            }
        } else {
            formatted
        };

        let result = ToolResult::Result {
            data: result_data,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        };

        Ok(vec![result])
    }
}

const CONTENT_EXTRACT_SCRIPT: &str = r#"
(function() {
    const selectors = [
        'article',
        '[role="article"]',
        'main',
        '[role="main"]',
        '.post-content',
        '.article-content',
        '.entry-content',
        '.post-body',
        '.article-body',
        '.content-body',
        '.story-body',
        '.markdown-body',
        '.prose',
        '#article-content',
        '#post-content',
        '#content',
        '.main-content',
        '.page-content',
        '.post',
        '.article',
    ];
    let root = null;
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length > 200) {
            root = el;
            break;
        }
    }
    if (!root) {
        root = document.body;
    }
    const clone = root.cloneNode(true);
    const removeSelectors = [
        'nav', 'header', 'footer',
        '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
        '[role="complementary"]',
        'aside',
        '.sidebar', '.side-bar', '.side_panel',
        '.nav', '.navigation', '.navbar', '.menu',
        '.footer', '.foot',
        '.header',
        '.ad', '.ads', '.advertisement', '.ad-container', '.ad-wrapper',
        '.sponsor', '.sponsored',
        '.social', '.social-share', '.share-buttons', '.share-bar',
        '.comment', '.comments', '#comments',
        '.related', '.related-posts', '.recommend',
        '.cookie', '.cookie-banner', '.cookie-notice', '.cookie-consent',
        '.popup', '.modal', '.overlay',
        '.breadcrumb',
        '.pagination', '.pager',
        '.toc', '.table-of-contents',
        'iframe', 'noscript',
        'svg', 'canvas',
        'script', 'style', 'link[rel="stylesheet"]', 'noscript',
    ];
    for (const sel of removeSelectors) {
        const els = clone.querySelectorAll(sel);
        for (const el of els) {
            el.remove();
        }
    }
    const allEls = clone.querySelectorAll('*');
    for (const el of allEls) {
        el.removeAttribute('style');
        el.removeAttribute('class');
        el.removeAttribute('id');
        el.removeAttribute('data-testid');
        const attrs = el.attributes;
        const toRemove = [];
        for (let i = 0; i < attrs.length; i++) {
            const name = attrs[i].name;
            if (name.startsWith('data-') || name.startsWith('aria-') || name.startsWith('on')) {
                toRemove.push(name);
            }
        }
        for (const name of toRemove) {
            el.removeAttribute(name);
        }
    }
    return clone.innerHTML;
})()
"#;

const PAGE_STATE_SCRIPT: &str = r#"
(function() {
    function bodyText() {
        return ((document.body && document.body.innerText) || "").toLowerCase();
    }

    function includesAny(text, keywords) {
        return keywords.some(function(keyword) { return text.includes(keyword); });
    }

    const text = bodyText();
    const title = document.title || "";
    const lowerTitle = title.toLowerCase();

    const passwordInputs = document.querySelectorAll('input[type="password"]').length;
    const captchaSelectors = [
        '.g-recaptcha', '#recaptcha', '[data-sitekey]',
        '.h-captcha', '#hcaptcha', '[data-hcaptcha-sitekey]',
        'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
        'iframe[src*="captcha"]', '#captcha', '.captcha',
        '.cf-turnstile', '[data-turnstile-sitekey]',
        '#challenge-running', '#challenge-stage',
        '.challenge-running', '.challenge-platform',
        '#cf-challenge-running', '.cf-browser-verification',
        '#turnstile-wrapper'
    ];

    const challengeTitles = ['just a moment', 'attention required', 'please wait', '验证', '安全检查'];
    const loginKeywords = ['sign in', 'log in', 'login', '登录', '登入', '登陆'];

    let reason = null;
    if (passwordInputs > 0) {
        reason = 'login_form';
    } else if (captchaSelectors.some((selector) => document.querySelector(selector))) {
        reason = 'captcha_or_challenge';
    } else if (includesAny(lowerTitle, challengeTitles)) {
        reason = 'challenge_title';
    } else if (
        (document.querySelector('form[action*="login"]') || document.querySelector('form[action*="signin"]'))
        && includesAny(text, loginKeywords)
    ) {
        reason = 'login_page';
    }

    return JSON.stringify({
        title,
        needs_interaction: reason !== null,
        interaction_reason: reason,
    });
})()
"#;

const READABILITY_EXTRACT_SCRIPT: &str = r#"
(function() {
    try {
        var R = (typeof Readability !== 'undefined') ? Readability : null;
        if (!R) return JSON.stringify({ __err: 'Readability not loaded' });
        var docClone = document.cloneNode(true);
        var article = new R(docClone).parse();
        if (!article) return JSON.stringify({ __err: 'Readability could not extract an article from this page' });
        return JSON.stringify({
            title: article.title || '',
            byline: article.byline || null,
            dir: article.dir || null,
            lang: article.lang || null,
            content: article.content || '',
            textContent: article.textContent || '',
            length: article.length || 0,
            excerpt: article.excerpt || '',
            siteName: article.siteName || null,
            publishedTime: article.publishedTime || null
        });
    } catch (e) {
        return JSON.stringify({ __err: 'Readability error: ' + e.message });
    }
})()
"#;

#[derive(Debug, Deserialize)]
struct PageState {
    title: String,
    needs_interaction: bool,
    interaction_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReadArticle {
    #[serde(default)]
    title: String,
    #[serde(default)]
    byline: Option<String>,
    #[serde(default)]
    content: String,
    #[serde(default, rename = "textContent")]
    #[allow(dead_code)]
    text_content: String,
    #[serde(default)]
    #[allow(dead_code)]
    length: u64,
    #[serde(default)]
    #[allow(dead_code)]
    excerpt: String,
    #[serde(default)]
    site_name: Option<String>,
    #[serde(default)]
    published_time: Option<String>,
}

fn normalize_url_input(raw: &str) -> String {
    let mut normalized = raw.trim().to_string();
    loop {
        let next = normalized
            .trim()
            .trim_matches('`')
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string();
        if next == normalized {
            return next;
        }
        normalized = next;
    }
}

fn strip_html_to_text(html: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    let mut in_script = false;
    let mut in_style = false;
    let mut tag_buffer = String::new();

    let mut chars = html.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '<' {
            in_tag = true;
            tag_buffer.clear();
            tag_buffer.push(ch);
            continue;
        }
        if in_tag {
            tag_buffer.push(ch);
            if ch == '>' {
                in_tag = false;
                let tag = tag_buffer.to_lowercase();
                if tag.starts_with("<script") {
                    in_script = true;
                } else if tag.starts_with("</script") {
                    in_script = false;
                } else if tag.starts_with("<style") {
                    in_style = true;
                } else if tag.starts_with("</style") {
                    in_style = false;
                } else if !in_script && !in_style {
                    if tag.starts_with("<br")
                        || tag.starts_with("</p")
                        || tag.starts_with("</div")
                        || tag.starts_with("</h")
                    {
                        result.push('\n');
                    } else if tag.starts_with("<li") {
                        result.push_str("\n- ");
                    } else if tag.starts_with("<h1") {
                        result.push_str("\n# ");
                    } else if tag.starts_with("<h2") {
                        result.push_str("\n## ");
                    } else if tag.starts_with("<h3") {
                        result.push_str("\n### ");
                    } else if tag.starts_with("<h4") {
                        result.push_str("\n#### ");
                    }
                }
                tag_buffer.clear();
            }
            continue;
        }
        if in_script || in_style {
            continue;
        }
        match ch {
            '&' => {
                let mut entity = String::new();
                while let Some(&next) = chars.peek() {
                    if next == ';' {
                        chars.next();
                        break;
                    }
                    entity.push(chars.next().unwrap_or_default());
                    if entity.len() > 10 {
                        break;
                    }
                }
                match entity.as_str() {
                    "amp" => result.push('&'),
                    "lt" => result.push('<'),
                    "gt" => result.push('>'),
                    "quot" => result.push('"'),
                    "nbsp" => result.push(' '),
                    _ => result.push(' '),
                }
            }
            _ => result.push(ch),
        }
    }

    let mut lines: Vec<&str> = result.lines().collect();
    let mut prev_empty = false;
    lines.retain(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if prev_empty {
                false
            } else {
                prev_empty = true;
                true
            }
        } else {
            prev_empty = false;
            true
        }
    });
    let mut cleaned = String::new();
    for line in &lines {
        cleaned.push_str(line.trim());
        cleaned.push('\n');
    }
    cleaned
}

fn clean_web_content(raw: &str) -> String {
    let re_comment = regex::Regex::new(r"<!--[\s\S]*?-->").unwrap();
    let re_script = regex::Regex::new(r"<script[\s\S]*?</script>").unwrap();
    let re_style = regex::Regex::new(r"<style[\s\S]*?</style>").unwrap();
    let re_tag = regex::Regex::new(r"<[^>]*>").unwrap();
    let re_multiline = regex::Regex::new(r"\n{3,}").unwrap();

    let mut content = re_comment.replace_all(raw, "").to_string();
    content = re_script.replace_all(&content, "").to_string();
    content = re_style.replace_all(&content, "").to_string();
    content = re_tag.replace_all(&content, "").to_string();
    content = re_multiline.replace_all(&content, "\n\n").to_string();

    let lines: Vec<&str> = content
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    lines.join("\n")
}

const ORGANIZE_SYSTEM_PROMPT: &str = "You are a content extraction engine. Input: raw web page text. Output: clean Markdown. ABSOLUTE RULES: 1. OUTPUT MUST BE THE ACTUAL RESTRUCTURED CONTENT, not a description of what you will do. 2. NEVER explain your process, never describe your approach, never say 'I will' or 'Let me'. 3. ONLY use information from the raw text. Do NOT add, infer, or fabricate. 4. Do NOT add emojis, decorative symbols, or formatting not in the source. 5. Do NOT summarize - restructure into Markdown preserving original meaning and detail. 6. If raw text is empty or unreadable, output exactly: [EXTRACTION_FAILED] 7. Preserve ALL factual data: numbers, prices, dates, names, URLs, percentages, tables. 8. Remove navigation menus, ads, cookie notices, and boilerplate noise. 9. Use proper Markdown headings, lists, and tables. 10. Start output directly with the first heading or content - no preamble.";

const ORGANIZE_USER_PROMPT: &str = "Restructure the following raw web page text into clean Markdown. Output the content directly - do NOT describe what you are doing.\n<raw_web_content>\n{content}\n</raw_web_content>";

const ORGANIZE_USER_PROMPT_TRUNCATED: &str = "Restructure the following truncated raw web page text into clean Markdown. Focus on key information. Output the content directly - do NOT describe what you are doing.\n<raw_web_content>\n{content}\n</raw_web_content>";

const ORGANIZE_ASSISTANT_MD_PREFILL: &str = "<think></think>\n```markdown\n";

const ORGANIZE_ASSISTANT_JSON_PREFILL: &str = "<thinks></thinks>\n```json\n";

async fn organize_content_with_rwkv(
    content: &str,
    session_id: &str,
    turn_id: &str,
) -> Ai00XResult<Option<String>> {
    let trimmed = content.trim();
    if trimmed.is_empty() || trimmed.len() < 200 {
        return Ok(None);
    }

    let factory = crate::infrastructure::ai::client_factory::get_global_ai_client_factory().await?;
    let client = match factory.get_client_resolved("fast").await {
        Ok(c) => c,
        Err(e) => {
            warn!(
                "WebFetch: fast model not available for content organization: {}",
                e
            );
            return Ok(None);
        }
    };

    let organize_client = client
        .with_max_tokens(RWKV_ORGANIZE_MAX_TOKENS)
        .with_stop(vec![
            "\n\nUser:".to_string(),
            "\n\nSystem:".to_string(),
            "```".to_string(),
        ]);

    let capped: String = if trimmed.len() > RWKV_ORGANIZE_MAX_TOTAL_CHARS {
        trimmed
            .chars()
            .take(RWKV_ORGANIZE_MAX_TOTAL_CHARS)
            .collect()
    } else {
        trimmed.to_string()
    };

    let chunks = split_content_into_chunks(&capped, RWKV_ORGANIZE_CHUNK_CHARS);
    if chunks.is_empty() {
        return Ok(None);
    }

    if chunks.len() == 1 {
        let user_prompt = ORGANIZE_USER_PROMPT.replace("{content}", &chunks[0]);
        let system_msg =
            crate::util::types::message::Message::system(ORGANIZE_SYSTEM_PROMPT.to_string());
        let user_msg = crate::util::types::message::Message::user(user_prompt);
        let assistant_prefill = crate::util::types::message::Message::assistant(
            ORGANIZE_ASSISTANT_MD_PREFILL.to_string(),
        );
        return match organize_client
            .send_message(vec![system_msg, user_msg, assistant_prefill], None)
            .await
        {
            Ok(response) => {
                let text = response.text.trim().to_string();
                if text.is_empty() || text == "[EXTRACTION_FAILED]" || text.len() < 50 {
                    warn!("WebFetch: RWKV organized content too short or failed, discarding");
                    return Ok(None);
                }
                record_organize_usage(&response, session_id, turn_id).await;
                Ok(Some(text))
            }
            Err(e) => {
                warn!("WebFetch: RWKV content organization failed: {}", e);
                Ok(None)
            }
        };
    }

    let mut handles = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let user_prompt = if i == chunks.len() - 1 {
            ORGANIZE_USER_PROMPT_TRUNCATED.replace("{content}", chunk)
        } else {
            ORGANIZE_USER_PROMPT.replace("{content}", chunk)
        };
        let system_msg =
            crate::util::types::message::Message::system(ORGANIZE_SYSTEM_PROMPT.to_string());
        let user_msg = crate::util::types::message::Message::user(user_prompt);
        let assistant_prefill = crate::util::types::message::Message::assistant(
            ORGANIZE_ASSISTANT_MD_PREFILL.to_string(),
        );
        let oc = organize_client.clone();
        let sid = session_id.to_string();
        let tid = turn_id.to_string();
        let chunk_index = i;

        let handle = tokio::spawn(async move {
            let response = oc
                .send_message(vec![system_msg, user_msg, assistant_prefill], None)
                .await?;
            let text = response.text.trim().to_string();
            if !text.is_empty() && text != "[EXTRACTION_FAILED]" && text.len() >= 50 {
                record_organize_usage(&response, &sid, &tid).await;
                Ok::<Option<String>, anyhow::Error>(Some(text))
            } else {
                Ok(None)
            }
        });

        handles.push((chunk_index, handle));
    }

    let mut organized_parts: Vec<(usize, String)> = Vec::new();
    for (chunk_index, handle) in handles {
        match handle.await {
            Ok(Ok(Some(text))) => {
                organized_parts.push((chunk_index, text));
            }
            Ok(Ok(None)) => {
                warn!(
                    "WebFetch: RWKV organized chunk {} too short or failed, discarding",
                    chunk_index
                );
            }
            Ok(Err(e)) => {
                warn!(
                    "WebFetch: RWKV organize chunk {} task failed: {}",
                    chunk_index, e
                );
            }
            Err(e) => {
                warn!(
                    "WebFetch: RWKV organize chunk {} join error: {}",
                    chunk_index, e
                );
            }
        }
    }

    if organized_parts.is_empty() {
        return Ok(None);
    }

    organized_parts.sort_by_key(|(i, _)| *i);
    let combined = organized_parts
        .iter()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    Ok(Some(combined))
}

fn split_content_into_chunks(content: &str, max_chars: usize) -> Vec<String> {
    if content.len() <= max_chars {
        return vec![content.to_string()];
    }

    let splitter = text_splitter::TextSplitter::new(max_chars);
    splitter.chunks(content).map(|s| s.to_string()).collect()
}

async fn record_organize_usage(
    response: &ai00_x_ai_adapters::types::GeminiResponse,
    session_id: &str,
    turn_id: &str,
) {
    if let Some(usage) = &response.usage {
        if let Some(svc) = crate::service::token_usage::get_global_token_usage_service() {
            let _ = svc
                .record_usage(
                    "rwkv-local".to_string(),
                    session_id.to_string(),
                    turn_id.to_string(),
                    usage.prompt_token_count,
                    usage.candidates_token_count,
                    0,
                    false,
                )
                .await;
        }
    }
}

const FILTER_SINGLE_SYSTEM_PROMPT: &str = "Classify a search result against a query. Output ONLY a JSON object: {\"category\":\"...\",\"reason\":\"...\"} Categories: RELEVANT (directly answers or relates to the query), NEEDS_DETAIL (may contain relevant info but needs full page fetch to confirm), IRRELEVANT (completely unrelated to the query). Default to RELEVANT if the topic matches even partially. Only use IRRELEVANT for clearly unrelated results (different topic entirely). No other output.";

const FILTER_SINGLE_USER_PROMPT: &str = "Query: {query}\nResult {index}: Title: {title} | URL: {url} | Snippet: {snippet}\nIs this result relevant to the query? JSON:";

const RWKV_FILTER_MAX_TOKENS: u32 = 150;

// Query expansion: generate Chinese + English search term variants so we
// can fire up to 4 concurrent searches and get broader coverage.
const QUERY_EXPAND_SYSTEM_PROMPT: &str = "You are a search query expansion assistant. Given a user query, generate up to 3 variant search queries that mix Chinese and English, synonyms, and rephrasings to maximize search coverage. Output ONLY a JSON array of strings, no explanation. Example: [\"query1\",\"query2\",\"query3\"]. Keep each query concise (under 60 chars).";

const QUERY_EXPAND_USER_PROMPT: &str =
    "Original query: {query}\nLanguage: {language}\nGenerate up to 3 variant search queries \
(mix Chinese and English, use synonyms and alternative phrasings). JSON array:";

const RWKV_QUERY_EXPAND_MAX_TOKENS: u32 = 256;

/// Maximum number of concurrent search queries (original + variants).
/// Kept at 4 to stay well under the anonymous 10 req/min rate limit —
/// a single search leaves 6 req of headroom for other tools.
const MAX_CONCURRENT_QUERIES: usize = 4;

/// Per-query result count when expanding (each query gets 10 results, merged
/// and de-duplicated later, then RWKV-filtered down to `limit`).
const EXPAND_PER_QUERY_RESULTS: usize = 10;

/// Generate search query variants (Chinese + English mix) using the RWKV fast
/// model. Returns a list of query strings (without the original). On any
/// failure, returns an empty vec — the caller falls back to the original query.
async fn generate_search_variants_with_rwkv(
    query: &str,
    language: &str,
    session_id: &str,
    turn_id: &str,
) -> Vec<String> {
    let factory =
        match crate::infrastructure::ai::client_factory::get_global_ai_client_factory().await {
            Ok(f) => f,
            Err(e) => {
                warn!(
                    "WebSearch: AI client factory not available for query expansion: {}",
                    e
                );
                return Vec::new();
            }
        };
    let client = match factory.get_client_resolved("fast").await {
        Ok(c) => c,
        Err(e) => {
            warn!(
                "WebSearch: fast model not available for query expansion: {}",
                e
            );
            return Vec::new();
        }
    };

    let expand_client = client
        .with_max_tokens(RWKV_QUERY_EXPAND_MAX_TOKENS)
        .with_stop(vec!["```".to_string(), "\n\nUser:".to_string()]);

    let user_prompt = QUERY_EXPAND_USER_PROMPT
        .replace("{query}", query)
        .replace("{language}", language);
    let system_msg =
        crate::util::types::message::Message::system(QUERY_EXPAND_SYSTEM_PROMPT.to_string());
    let user_msg = crate::util::types::message::Message::user(user_prompt);
    let assistant_prefill =
        crate::util::types::message::Message::assistant("<thinks></thinks>\n```json\n".to_string());

    let response = match expand_client
        .send_message(vec![system_msg, user_msg, assistant_prefill], None)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            warn!("WebSearch: RWKV query expansion failed: {}", e);
            return Vec::new();
        }
    };

    if let Some(usage) = response.usage {
        if let Some(svc) = crate::service::token_usage::get_global_token_usage_service() {
            let _ = svc
                .record_usage(
                    "rwkv-local".to_string(),
                    session_id.to_string(),
                    turn_id.to_string(),
                    usage.prompt_token_count,
                    usage.candidates_token_count,
                    0,
                    false,
                )
                .await;
        }
    }

    // The model returns a JSON array inside a ```json block. Extract and parse it.
    let text = response.text.trim();
    let json_str = extract_json_array(text);
    match serde_json::from_str::<Vec<String>>(json_str) {
        Ok(variants) => {
            // Clean up: dedupe, cap at MAX_CONCURRENT_QUERIES-1 (original is prepended later),
            // strip empty/overly-long queries.
            let mut seen = std::collections::HashSet::new();
            let mut out = Vec::new();
            for v in variants.into_iter() {
                let trimmed = v.trim().to_string();
                if trimmed.is_empty() || trimmed.len() > 200 {
                    continue;
                }
                if !seen.insert(trimmed.clone()) {
                    continue;
                }
                out.push(trimmed);
                if out.len() >= MAX_CONCURRENT_QUERIES.saturating_sub(1) {
                    break;
                }
            }
            if out.is_empty() {
                warn!(
                    "WebSearch: RWKV query expansion returned no usable variants: {}",
                    &text[..text
                        .char_indices()
                        .take(120)
                        .last()
                        .map(|(i, c)| i + c.len_utf8())
                        .unwrap_or(0)]
                );
            }
            out
        }
        Err(e) => {
            warn!(
                "WebSearch: Failed to parse query variants JSON: {} | raw: {}",
                e,
                &text[..text
                    .char_indices()
                    .take(120)
                    .last()
                    .map(|(i, c)| i + c.len_utf8())
                    .unwrap_or(0)]
            );
            Vec::new()
        }
    }
}

/// Extract the JSON array text from a model response that may be wrapped in
/// a ```json code fence.
fn extract_json_array(text: &str) -> &str {
    let trimmed = text.trim();
    // Strip ```json ... ``` fence if present.
    if let Some(start) = trimmed.find("```json") {
        let after = &trimmed[start + "```json".len()..];
        if let Some(end) = after.rfind("```") {
            return after[..end].trim();
        }
        return after.trim();
    }
    // Try to find the JSON array boundaries directly.
    if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            return &trimmed[start..=end];
        }
    }
    trimmed
}

async fn filter_search_results_with_rwkv(
    query: &str,
    results: &[serde_json::Value],
    session_id: &str,
    turn_id: &str,
) -> Ai00XResult<Option<Vec<FilteredResult>>> {
    if results.is_empty() {
        return Ok(None);
    }

    let factory = crate::infrastructure::ai::client_factory::get_global_ai_client_factory().await?;
    let client = match factory.get_client_resolved("fast").await {
        Ok(c) => c,
        Err(e) => {
            warn!(
                "WebSearch: fast model not available for results filtering: {}",
                e
            );
            return Ok(None);
        }
    };

    let filter_client = client
        .with_max_tokens(RWKV_FILTER_MAX_TOKENS)
        .with_stop(vec![
            "```".to_string(),
            "\n\nUser:".to_string(),
            "\n\nSystem:".to_string(),
        ]);

    let mut handles = Vec::new();

    for (i, result_val) in results.iter().enumerate() {
        let index = i + 1;
        let title = result_val
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let url = result_val
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let snippet = result_val
            .get("snippet")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let user_prompt = FILTER_SINGLE_USER_PROMPT
            .replace("{query}", query)
            .replace("{index}", &index.to_string())
            .replace("{title}", &title)
            .replace("{url}", &url)
            .replace("{snippet}", &snippet);

        let system_msg =
            crate::util::types::message::Message::system(FILTER_SINGLE_SYSTEM_PROMPT.to_string());
        let user_msg = crate::util::types::message::Message::user(user_prompt);
        let assistant_prefill = crate::util::types::message::Message::assistant(
            ORGANIZE_ASSISTANT_JSON_PREFILL.to_string(),
        );
        let fc = filter_client.clone();
        let sid = session_id.to_string();
        let tid = turn_id.to_string();

        let handle = tokio::spawn(async move {
            let response = fc
                .send_message(vec![system_msg, user_msg, assistant_prefill], None)
                .await?;
            let text = response.text.trim().to_string();
            if let Some(usage) = response.usage {
                if let Some(svc) = crate::service::token_usage::get_global_token_usage_service() {
                    let _ = svc
                        .record_usage(
                            "rwkv-local".to_string(),
                            sid,
                            tid,
                            usage.prompt_token_count,
                            usage.candidates_token_count,
                            0,
                            false,
                        )
                        .await;
                }
            }
            Ok::<(usize, String), anyhow::Error>((index, text))
        });

        handles.push(handle);
    }

    let mut filter_results = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(Ok((index, text))) => {
                if let Some(fr) = parse_single_filter_response(index, &text) {
                    filter_results.push(fr);
                } else {
                    warn!(
                        "WebSearch: RWKV filter for result {} returned unparseable, discarding: {}",
                        index,
                        &text[..text
                            .char_indices()
                            .take(100)
                            .last()
                            .map(|(i, c)| i + c.len_utf8())
                            .unwrap_or(0)]
                    );
                }
            }
            Ok(Err(e)) => {
                warn!("WebSearch: RWKV filter task failed: {}", e);
            }
            Err(e) => {
                warn!("WebSearch: RWKV filter task join error: {}", e);
            }
        }
    }

    if filter_results.is_empty() {
        warn!("WebSearch: RWKV filter returned no results");
        Ok(None)
    } else {
        Ok(Some(filter_results))
    }
}

fn parse_single_filter_response(index: usize, text: &str) -> Option<FilteredResult> {
    let json_str = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => {
            if let Some(start) = text.find('{') {
                if let Some(end) = text.rfind('}') {
                    match serde_json::from_str::<serde_json::Value>(&text[start..=end]) {
                        Ok(v) => v,
                        Err(_) => return None,
                    }
                } else {
                    return None;
                }
            } else {
                return None;
            }
        }
    };

    let category_str = parsed.get("category")?.as_str()?.to_uppercase();
    let category = match category_str.as_str() {
        "RELEVANT" => SearchResultCategory::Relevant,
        "NEEDS_DETAIL" => SearchResultCategory::NeedsDetail,
        _ => SearchResultCategory::Irrelevant,
    };
    let reason = parsed
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Some(FilteredResult {
        index,
        category,
        reason,
    })
}

fn html_to_markdown(html: &str) -> String {
    let converter = HtmlToMarkdown::builder()
        .skip_tags(vec!["script", "style", "noscript"])
        .build();
    if let Ok(md) = converter.convert(html) {
        let trimmed = md.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    strip_html_to_text(html)
}

fn render_article_markdown(article: &ReadArticle) -> String {
    let body = html_to_markdown(&article.content);

    let mut out = String::new();
    if !article.title.is_empty() {
        out.push_str("# ");
        out.push_str(&article.title);
        out.push_str("\n\n");
    }

    let mut meta_lines: Vec<String> = Vec::new();
    if let Some(byline) = article.byline.as_deref().filter(|s| !s.is_empty()) {
        meta_lines.push(format!("**By:** {}", byline));
    }
    if let Some(site) = article.site_name.as_deref().filter(|s| !s.is_empty()) {
        meta_lines.push(format!("**Site:** {}", site));
    }
    if let Some(published) = article.published_time.as_deref().filter(|s| !s.is_empty()) {
        meta_lines.push(format!("**Published:** {}", published));
    }
    if !meta_lines.is_empty() {
        out.push_str(&meta_lines.join("  \n"));
        out.push_str("\n\n---\n\n");
    }

    out.push_str(body.trim());
    out.push('\n');
    out
}

fn build_browser(visible: bool, wait_secs: u64) -> Result<Browser, String> {
    let executable = default_executable().map_err(|e| format!("Failed to find Chromium: {}", e))?;
    let mut builder = LaunchOptionsBuilder::default();
    builder
        .path(Some(executable))
        .headless(!visible)
        .window_size(Some((1280, 800)))
        .idle_browser_timeout(Duration::from_secs(wait_secs + 30));

    #[cfg(target_os = "linux")]
    {
        builder.sandbox(false);
    }

    let options = builder
        .build()
        .map_err(|e| format!("Failed to build browser launch options: {}", e))?;

    Browser::new(options).map_err(|e| format!("Failed to launch Chromium: {}", e))
}

fn interaction_message(url: &str, visible: bool, title: &str, reason: Option<&str>) -> String {
    let mut message = format!(
        "Page requires user interaction before content can be extracted: {}",
        url
    );
    if !title.is_empty() {
        message.push_str(&format!("\nTitle: {}", title));
    }
    if let Some(reason) = reason {
        message.push_str(&format!("\nDetected: {}", reason));
    }
    if visible {
        message.push_str(
            "\nThe browser was opened in visible mode. Increase `wait_secs` and complete the login or challenge before extraction runs.",
        );
    } else {
        message.push_str(
            "\nRetry with `visible: true` and a larger `wait_secs` if you need time to manually complete login or a verification challenge.",
        );
    }
    message
}

/// WebFetch tool - uses Chromium headless browser with Readability.js for content extraction
pub struct WebFetchTool {
    default_wait_secs: u64,
    default_max_length: usize,
}

impl Default for WebFetchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WebFetchTool {
    pub fn new() -> Self {
        Self {
            default_wait_secs: DEFAULT_FETCH_WAIT_SECS,
            default_max_length: DEFAULT_FETCH_MAX_LENGTH,
        }
    }
}

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        "WebFetch"
    }

    async fn description(&self) -> Ai00XResult<String> {
        Ok(r#"Fetch and extract content from a URL using a Chromium browser with Readability.js.

Use this tool to:
- Read documentation and articles from websites
- Extract main article content with automatic noise removal
- Fetch pages that require JavaScript rendering
- Access online resources with high-quality content extraction

Features:
- Uses Chromium headless browser for full JavaScript rendering
- Injects Mozilla Readability.js for intelligent article extraction
- Falls back to CSS selector-based extraction when Readability fails
- Detects login forms, CAPTCHAs, and Cloudflare challenges
- Converts HTML to high-quality Markdown using htmd
- Supports visible browser mode for manual interaction (login, CAPTCHA)
- Content truncation with configurable max length

Parameters:
- url: The URL to fetch (required)
- wait_secs: Seconds to wait for page rendering (default: 3, max: 120)
- max_length: Maximum characters to return (default: 50000, max: 200000)
- visible: Launch visible browser window for manual interaction (default: false)

CRITICAL: When WebFetch fails or reports that a domain cannot be fetched, you must NOT attempt to retrieve the content through alternative means. Specifically:
- Do NOT use bash commands (curl, wget, lynx, etc.) to fetch URLs
- Do NOT use Python (requests, urllib, httpx, aiohttp, etc.) to fetch URLs
- Do NOT use any other programming language or library to make HTTP requests
- Do NOT attempt to access cached versions, archive sites, or mirrors of blocked content
If content cannot be retrieved through WebSearch or WebFetch, inform the user and offer alternative approaches."#
            .to_string())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to fetch"
                },
                "wait_secs": {
                    "type": "integer",
                    "description": "Seconds to wait for page rendering before extracting (default: 3, max: 120)",
                    "default": DEFAULT_FETCH_WAIT_SECS
                },
                "max_length": {
                    "type": "integer",
                    "description": "Maximum characters to return (default: 50000, max: 200000)",
                    "default": DEFAULT_FETCH_MAX_LENGTH
                },
                "visible": {
                    "type": "boolean",
                    "description": "Launch a visible Chromium window instead of headless mode for manual interaction (default: false)",
                    "default": false
                },
                "adapter_args": {
                    "type": "object",
                    "description": "Optional arguments for a web adapter matching the URL's domain. If a matching adapter exists, it will be used for structured extraction instead of generic content fetching.",
                    "additionalProperties": true
                }
            },
            "required": ["url"]
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn needs_permissions(&self, _input: Option<&Value>) -> bool {
        false
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if let Some(url) = input.get("url").and_then(|v| v.as_str()) {
            let normalized = normalize_url_input(url);
            if normalized.is_empty() {
                return ValidationResult {
                    result: false,
                    message: Some("URL cannot be empty".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }

            if !normalized.starts_with("http://") && !normalized.starts_with("https://") {
                return ValidationResult {
                    result: false,
                    message: Some("URL must start with http:// or https://".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }

            if is_private_ip(&normalized) {
                return ValidationResult {
                    result: false,
                    message: Some(
                        "Access to private/local network addresses is not allowed".to_string(),
                    ),
                    error_code: Some(400),
                    meta: None,
                };
            }
        } else {
            return ValidationResult {
                result: false,
                message: Some("url is required".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        let raw_url = input
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| Ai00XError::tool("url is required".to_string()))?;

        let url = normalize_url_input(raw_url);
        if url.is_empty() {
            return Err(Ai00XError::tool("URL cannot be empty".to_string()));
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(Ai00XError::tool(
                "URL must start with http:// or https://".to_string(),
            ));
        }
        if is_private_ip(&url) {
            return Err(Ai00XError::tool(
                "Access to private/local network addresses is not allowed".to_string(),
            ));
        }

        let wait_secs = input
            .get("wait_secs")
            .and_then(|v| v.as_u64())
            .unwrap_or(self.default_wait_secs)
            .min(120);

        let max_length = input
            .get("max_length")
            .and_then(|v| v.as_u64())
            .unwrap_or(self.default_max_length as u64)
            .min(200_000) as usize;

        let visible = input
            .get("visible")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let adapter_args = input
            .get("adapter_args")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();

        info!(
            "WebFetch call: url='{}', wait_secs={}, max_length={}, visible={}",
            url, wait_secs, max_length, visible
        );

        let session_id = context.session_id.clone().unwrap_or_default();
        let turn_id = context.dialog_turn_id.clone().unwrap_or_default();

        if !adapter_args.is_empty() || should_try_adapter(&url) {
            match try_adapter_fetch(&url, &adapter_args).await {
                Ok(content) => {
                    let cleaned = clean_web_content(&content);
                    let organized = organize_content_with_rwkv(&cleaned, &session_id, &turn_id)
                        .await
                        .unwrap_or(None);
                    let display_content = if let Some(ref org) = organized {
                        if org.len() > max_length {
                            let mut s = org.clone();
                            s.truncate(max_length);
                            s.push_str("\n\n...(truncated)");
                            s
                        } else {
                            org.clone()
                        }
                    } else if cleaned.len() > max_length {
                        let mut s = cleaned;
                        s.truncate(max_length);
                        s.push_str("\n\n...(truncated)");
                        s
                    } else {
                        cleaned
                    };
                    let result = ToolResult::Result {
                        data: json!({
                            "url": url,
                            "content_length": display_content.len(),
                            "provider": "web_adapter",
                            "organized": organized,
                        }),
                        result_for_assistant: Some(display_content),
                        image_attachments: None,
                    };
                    return Ok(vec![result]);
                }
                Err(e) => {
                    warn!(
                        "Adapter fetch failed for '{}', falling back to chromium: {}",
                        url, e
                    );
                }
            }
        }

        let url_owned = url.clone();
        let task = tokio::task::spawn_blocking(move || -> Result<String, String> {
            let browser = build_browser(visible, wait_secs)?;
            let tab = browser
                .new_tab()
                .map_err(|e| format!("Failed to create browser page: {}", e))?;

            tab.navigate_to(&url_owned)
                .map_err(|e| format!("Failed to navigate to page: {}", e))?;

            thread::sleep(Duration::from_secs(wait_secs));

            let _ = tab.evaluate(READABILITY_JS, false);

            let page_state_json = tab
                .evaluate(PAGE_STATE_SCRIPT, true)
                .map_err(|e| format!("Failed to evaluate page state: {}", e))?
                .value
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .ok_or_else(|| {
                    "Failed to evaluate page state: browser returned no JSON string".to_string()
                })?;
            let page_state: PageState = serde_json::from_str(&page_state_json)
                .map_err(|e| format!("Failed to decode page state: {}", e))?;

            if page_state.needs_interaction {
                return Err(interaction_message(
                    &url_owned,
                    visible,
                    &page_state.title,
                    page_state.interaction_reason.as_deref(),
                ));
            }

            let readability_result = tab
                .evaluate(READABILITY_EXTRACT_SCRIPT, true)
                .map_err(|e| format!("Failed to run Readability: {}", e))?
                .value
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_default();

            let mut output = String::new();

            if !readability_result.trim().is_empty() {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&readability_result) {
                    if parsed.get("__err").is_none() {
                        if let Ok(article) = serde_json::from_value::<ReadArticle>(parsed) {
                            if !article.content.trim().is_empty() {
                                output = render_article_markdown(&article);
                            }
                        }
                    }
                }
            }

            if output.trim().is_empty() {
                let content_html = tab
                    .evaluate(CONTENT_EXTRACT_SCRIPT, true)
                    .map_err(|e| format!("Failed to extract page content: {}", e))?
                    .value
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .unwrap_or_default();

                let html = if content_html.trim().is_empty() {
                    tab.get_content()
                        .map_err(|e| format!("Failed to read page content: {}", e))?
                } else {
                    content_html
                };

                let markdown = html_to_markdown(&html);
                if !page_state.title.trim().is_empty() {
                    output.push_str(&format!("# {}\n\n", page_state.title.trim()));
                }
                output.push_str(&markdown);
            }

            if output.len() > max_length {
                output.truncate(max_length);
                output.push_str("\n\n...(truncated)");
            }

            Ok(output)
        });

        match task.await {
            Ok(Ok(content)) => {
                let cleaned = clean_web_content(&content);
                let organized = organize_content_with_rwkv(&cleaned, &session_id, &turn_id)
                    .await
                    .unwrap_or(None);
                let display_content = if let Some(ref org) = organized {
                    org.clone()
                } else {
                    cleaned
                };
                let result = ToolResult::Result {
                    data: json!({
                        "url": url,
                        "content_length": display_content.len(),
                        "provider": "chromium_readability",
                        "organized": organized,
                    }),
                    result_for_assistant: Some(display_content),
                    image_attachments: None,
                };
                Ok(vec![result])
            }
            Ok(Err(message)) => {
                if message.starts_with("Page requires user interaction") {
                    Err(Ai00XError::tool(message))
                } else {
                    error!("WebFetch error: {}", message);
                    Err(Ai00XError::tool(message))
                }
            }
            Err(e) => {
                error!("WebFetch task error: {}", e);
                Err(Ai00XError::tool(format!("Web fetch task failed: {}", e)))
            }
        }
    }
}

fn should_try_adapter(url: &str) -> bool {
    let registry = get_global_adapter_registry();
    let guard = match registry.try_read() {
        Ok(g) => g,
        Err(_) => return false,
    };
    guard.find_by_url(url).is_some()
}

async fn try_adapter_fetch(
    url: &str,
    adapter_args: &serde_json::Map<String, Value>,
) -> Ai00XResult<String> {
    let registry = get_global_adapter_registry();
    let guard = registry.read().await;
    let adapter_match = guard
        .find_by_url(url)
        .ok_or_else(|| Ai00XError::Service(format!("No adapter found for URL: {}", url)))?;

    let adapter = &adapter_match.adapter;
    info!(
        "Using adapter '{}/{}' (strategy: {}) for URL: {}",
        adapter.site, adapter.name, adapter.strategy, url
    );

    let result = execute_adapter(adapter, adapter_args, None, None, None).await?;

    let content = format_adapter_result(&result, adapter);

    Ok(content)
}

fn format_adapter_result(
    result: &Value,
    adapter: &crate::agent::tools::implementations::web_adapter::WebAdapter,
) -> String {
    let mut output = String::new();

    output.push_str(&format!("# Adapter: {}/{}\n\n", adapter.site, adapter.name));

    if let Some(desc) = &adapter.description {
        output.push_str(desc);
        output.push_str("\n\n---\n\n");
    }

    match result {
        Value::Array(items) => {
            if items.is_empty() {
                output.push_str("No results found.\n");
            } else {
                output.push_str(&format!("Found {} results:\n\n", items.len()));

                if let Some(columns) = &adapter.columns {
                    let header: Vec<&str> = columns.iter().map(|s| s.as_str()).collect();
                    output.push_str(&format!("| {} |", header.join(" | ")));
                    output.push_str("\n|");
                    for _ in columns {
                        output.push_str(" --- |");
                    }
                    output.push('\n');

                    for item in items {
                        if let Some(obj) = item.as_object() {
                            output.push('|');
                            for col in columns {
                                let val = obj.get(col).and_then(|v| v.as_str()).unwrap_or("-");
                                output.push_str(&format!(" {} |", val));
                            }
                            output.push('\n');
                        }
                    }
                } else {
                    for (i, item) in items.iter().enumerate() {
                        output.push_str(&format!("{}. {}\n\n", i + 1, format_value_compact(item)));
                    }
                }
            }
        }
        Value::Object(obj) => {
            for (key, val) in obj {
                output.push_str(&format!("**{}:** {}\n\n", key, format_value_compact(val)));
            }
        }
        other => {
            output.push_str(&format_value_compact(other));
            output.push('\n');
        }
    }

    output
}

fn format_value_compact(val: &Value) -> String {
    match val {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(format_value_compact).collect();
            items.join(", ")
        }
        Value::Object(obj) => {
            let pairs: Vec<String> = obj
                .iter()
                .map(|(k, v)| format!("{}={}", k, format_value_compact(v)))
                .collect();
            pairs.join(", ")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_private_ip_detects_private_addresses() {
        assert!(is_private_ip("http://localhost/test"));
        assert!(is_private_ip("http://127.0.0.1/test"));
        assert!(is_private_ip("http://10.0.0.1/test"));
        assert!(is_private_ip("http://192.168.1.1/test"));
        assert!(is_private_ip("http://172.16.0.1/test"));
        assert!(is_private_ip("http://172.31.255.255/test"));
        assert!(is_private_ip("http://169.254.1.1/test"));
        assert!(!is_private_ip("http://8.8.8.8/test"));
        assert!(!is_private_ip("http://1.1.1.1/test"));
        assert!(!is_private_ip("http://172.15.0.1/test"));
        assert!(!is_private_ip("http://172.32.0.1/test"));
        assert!(!is_private_ip("https://example.com/test"));
    }

    #[test]
    fn normalize_url_input_strips_quotes() {
        assert_eq!(
            normalize_url_input("`https://example.com`"),
            "https://example.com"
        );
        assert_eq!(
            normalize_url_input("\"https://example.com\""),
            "https://example.com"
        );
        assert_eq!(
            normalize_url_input("'https://example.com'"),
            "https://example.com"
        );
        assert_eq!(
            normalize_url_input("  https://example.com  "),
            "https://example.com"
        );
        assert_eq!(
            normalize_url_input("`\"'https://example.com'\"`"),
            "https://example.com"
        );
    }

    #[test]
    fn strip_html_to_text_extracts_plain_text() {
        let html = r#"<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
<script>alert('ignore me');</script>
<style>.hidden { display: none; }</style>
<h1>Hello World</h1>
<p>This is a paragraph with <strong>bold</strong> text.</p>
<ul><li>Item one</li><li>Item two</li></ul>
</body>
</html>"#;

        let text = strip_html_to_text(html);
        assert!(!text.contains("<script>"));
        assert!(!text.contains("alert("));
        assert!(!text.contains(".hidden"));
        assert!(text.contains("Hello World"));
        assert!(text.contains("Item one"));
        assert!(text.contains("Item two"));
    }

    #[test]
    fn html_to_markdown_converts_html() {
        let html = "<h1>Title</h1><p>Hello <strong>world</strong></p><ul><li>item1</li><li>item2</li></ul>";
        let md = html_to_markdown(html);
        assert!(md.contains("Title"));
        assert!(md.contains("Hello"));
        assert!(md.contains("world"));
    }

    #[test]
    fn snippet_truncates_long_text() {
        let long_text = "a".repeat(500);
        let result = WebSearchTool::snippet(&long_text, 320);
        assert!(result.len() <= 323);
        assert!(result.ends_with("..."));

        let short_text = "hello world";
        let result = WebSearchTool::snippet(short_text, 320);
        assert_eq!(result, "hello world");
    }

    #[test]
    fn render_article_markdown_formats_correctly() {
        let article = ReadArticle {
            title: "Test Article".to_string(),
            byline: Some("John Doe".to_string()),
            content: "<p>This is the article body.</p>".to_string(),
            text_content: "This is the article body.".to_string(),
            length: 26,
            excerpt: "This is the article body.".to_string(),
            site_name: Some("TestSite".to_string()),
            published_time: Some("2025-01-01".to_string()),
        };
        let md = render_article_markdown(&article);
        assert!(md.starts_with("# Test Article"));
        assert!(md.contains("**By:** John Doe"));
        assert!(md.contains("**Site:** TestSite"));
        assert!(md.contains("**Published:** 2025-01-01"));
        assert!(md.contains("article body"));
    }
}
