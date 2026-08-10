use std::collections::HashMap;
use std::sync::Arc;

use super::types::{AdapterMatch, AdapterSource, WebAdapter};

#[derive(Debug, Default)]
pub struct WebAdapterRegistry {
    by_domain: HashMap<String, Vec<Arc<WebAdapter>>>,
    by_site: HashMap<String, Vec<Arc<WebAdapter>>>,
    all: Vec<Arc<WebAdapter>>,
}

impl WebAdapterRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, adapter: WebAdapter, _source: AdapterSource) {
        let adapter = Arc::new(adapter);
        let domain = adapter
            .domain
            .clone()
            .unwrap_or_else(|| adapter.site.clone());

        self.by_domain
            .entry(domain.clone())
            .or_default()
            .push(adapter.clone());

        self.by_site
            .entry(adapter.site.clone())
            .or_default()
            .push(adapter.clone());

        self.all.push(adapter);
    }

    pub fn find_by_url(&self, url: &str) -> Option<AdapterMatch> {
        let domain = extract_domain(url)?;
        let candidates = self.by_domain.get(&domain)?;
        candidates.first().map(|a| AdapterMatch {
            adapter: a.clone(),
            source: AdapterSource::Builtin,
        })
    }

    pub fn find_by_domain(&self, domain: &str) -> Option<&Vec<Arc<WebAdapter>>> {
        self.by_domain.get(domain)
    }

    pub fn find_by_site(&self, site: &str) -> Option<&Vec<Arc<WebAdapter>>> {
        self.by_site.get(site)
    }

    pub fn all_adapters(&self) -> &[Arc<WebAdapter>] {
        &self.all
    }

    pub fn site_count(&self) -> usize {
        self.by_site.len()
    }

    pub fn adapter_count(&self) -> usize {
        self.all.len()
    }

    pub fn list_sites(&self) -> Vec<&str> {
        self.by_site.keys().map(|s| s.as_str()).collect()
    }

    pub fn list_all(&self) -> Vec<&WebAdapter> {
        self.all.iter().map(|a| a.as_ref()).collect()
    }

    pub fn clear(&mut self) {
        self.by_domain.clear();
        self.by_site.clear();
        self.all.clear();
    }
}

fn extract_domain(url: &str) -> Option<String> {
    let url_str = if !url.starts_with("http://") && !url.starts_with("https://") {
        format!("https://{}", url)
    } else {
        url.to_string()
    };
    reqwest::Url::parse(&url_str)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
}
