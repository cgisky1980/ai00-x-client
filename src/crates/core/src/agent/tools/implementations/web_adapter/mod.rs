pub mod browser_page;
pub mod executor;
pub mod parser;
pub mod registry;
pub mod remote;
pub mod steps;
pub mod template;
pub mod types;
pub mod user;

pub use browser_page::{
    create_browser_page, BrowserPage, BrowserPageInstance, BrowserPageType, CdpBrowserPage,
    CookieInfo, DaemonBrowserPage, HeadlessBrowserPage,
};
pub use executor::{execute_adapter, PipelineExecutor};
pub use parser::parse_yaml_adapter;
pub use registry::WebAdapterRegistry;
pub use remote::{fetch_remote_adapters, load_cached_remote_adapters, RemoteAdapterConfig};
pub use template::PipelineContext;
pub use types::{AdapterMatch, AdapterSource, ArgDef, ArgType, Strategy, WebAdapter};
pub use user::discover_user_adapters;

use std::sync::{Arc, OnceLock};
use tokio::sync::RwLock;

static GLOBAL_ADAPTER_REGISTRY: OnceLock<Arc<RwLock<WebAdapterRegistry>>> = OnceLock::new();

pub fn get_global_adapter_registry() -> Arc<RwLock<WebAdapterRegistry>> {
    GLOBAL_ADAPTER_REGISTRY
        .get_or_init(|| {
            let mut registry = WebAdapterRegistry::new();
            discover_builtin_adapters(&mut registry);
            let _ = user::discover_user_adapters(&mut registry);
            let _ = load_cached_remote_adapters_sync(&mut registry);
            Arc::new(RwLock::new(registry))
        })
        .clone()
}

pub fn discover_builtin_adapters(registry: &mut WebAdapterRegistry) {
    let builtin_adapters: &[(&str, &str)] = &[
        (
            "hackernews/search",
            include_str!("builtin/hackernews/search.yaml"),
        ),
        (
            "hackernews/top",
            include_str!("builtin/hackernews/top.yaml"),
        ),
        (
            "hackernews/best",
            include_str!("builtin/hackernews/best.yaml"),
        ),
        ("reddit/search", include_str!("builtin/reddit/search.yaml")),
        ("reddit/hot", include_str!("builtin/reddit/hot.yaml")),
        (
            "stackoverflow/search",
            include_str!("builtin/stackoverflow/search.yaml"),
        ),
        (
            "stackoverflow/hot",
            include_str!("builtin/stackoverflow/hot.yaml"),
        ),
        ("wikipedia", include_str!("builtin/wikipedia/search.yaml")),
        ("arxiv", include_str!("builtin/arxiv/search.yaml")),
        ("github", include_str!("builtin/github/search.yaml")),
        ("devto/top", include_str!("builtin/devto/top.yaml")),
        ("lobsters/hot", include_str!("builtin/lobsters/hot.yaml")),
        ("linux-do/hot", include_str!("builtin/linux-do/hot.yaml")),
        ("v2ex/hot", include_str!("builtin/v2ex/hot.yaml")),
        ("v2ex/latest", include_str!("builtin/v2ex/latest.yaml")),
        ("medium/feed", include_str!("builtin/medium/feed.yaml")),
        ("hf/trending", include_str!("builtin/hf/trending.yaml")),
        (
            "steam/top-sellers",
            include_str!("builtin/steam/top-sellers.yaml"),
        ),
        ("bilibili/hot", include_str!("builtin/bilibili/hot.yaml")),
        (
            "bilibili/search",
            include_str!("builtin/bilibili/search.yaml"),
        ),
        ("zhihu/hot", include_str!("builtin/zhihu/hot.yaml")),
        ("weibo/hot", include_str!("builtin/weibo/hot.yaml")),
        (
            "xiaohongshu/search",
            include_str!("builtin/xiaohongshu/search.yaml"),
        ),
        (
            "douban/movie-hot",
            include_str!("builtin/douban/movie-hot.yaml"),
        ),
        ("douban/search", include_str!("builtin/douban/search.yaml")),
        (
            "twitter/search",
            include_str!("builtin/twitter/search.yaml"),
        ),
        (
            "twitter/trending",
            include_str!("builtin/twitter/trending.yaml"),
        ),
        (
            "youtube/search",
            include_str!("builtin/youtube/search.yaml"),
        ),
        (
            "youtube/transcript",
            include_str!("builtin/youtube/transcript.yaml"),
        ),
        ("bbc/news", include_str!("builtin/bbc/news.yaml")),
        ("xueqiu/hot", include_str!("builtin/xueqiu/hot.yaml")),
        (
            "sinafinance/news",
            include_str!("builtin/sinafinance/news.yaml"),
        ),
    ];

    for (site, yaml_content) in builtin_adapters {
        match parse_yaml_adapter(yaml_content) {
            Ok(adapter) => registry.register(adapter, AdapterSource::Builtin),
            Err(e) => log::warn!("Failed to parse builtin adapter '{}': {}", site, e),
        }
    }
}

fn load_cached_remote_adapters_sync(registry: &mut WebAdapterRegistry) -> Result<(), String> {
    let config = RemoteAdapterConfig::default();
    let cache_dir = match config.local_cache_dir() {
        Some(d) => d,
        None => return Ok(()),
    };

    if !cache_dir.exists() {
        return Ok(());
    }

    let mut count = 0;
    let entries = std::fs::read_dir(&cache_dir)
        .map_err(|e| format!("Failed to read remote cache dir: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(sub_entries) = std::fs::read_dir(&path) {
                for sub_entry in sub_entries.flatten() {
                    let sub_path = sub_entry.path();
                    if is_yaml_ext(&sub_path) {
                        if let Ok(content) = std::fs::read_to_string(&sub_path) {
                            match parse_yaml_adapter(&content) {
                                Ok(adapter) => {
                                    registry.register(adapter, AdapterSource::Remote);
                                    count += 1;
                                }
                                Err(e) => {
                                    log::warn!(
                                        "Failed to parse cached remote adapter '{}': {}",
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

    if count > 0 {
        log::info!("Loaded {} cached remote adapter(s)", count);
    }
    Ok(())
}

fn is_yaml_ext(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e == "yaml" || e == "yml")
        .unwrap_or(false)
}
