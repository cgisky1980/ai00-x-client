use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const FNV_OFFSET_BASIS: u64 = 0xcbf29ce48422325;
const FNV_PRIME: u64 = 0x00000100000001b3;

fn fnv1a_64(data: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for &byte in data {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PromptCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub writes: u64,
    pub invalidations: u64,
    pub breaks: u64,
    pub cached_input_tokens: u64,
    pub cached_output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheBreakEvent {
    pub unexpected: bool,
    pub reason: String,
    pub token_drop: u32,
}

#[derive(Debug)]
pub struct CachedResponse {
    pub fingerprint: u64,
    pub created_at: Instant,
    pub ttl: Duration,
}

impl CachedResponse {
    pub fn is_expired(&self) -> bool {
        self.created_at.elapsed() > self.ttl
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptCacheConfig {
    pub session_id: String,
    #[serde(default = "default_completion_ttl")]
    pub completion_ttl_secs: u64,
    #[serde(default = "default_prompt_ttl")]
    pub prompt_ttl_secs: u64,
}

fn default_completion_ttl() -> u64 {
    30
}

fn default_prompt_ttl() -> u64 {
    300
}

impl Default for PromptCacheConfig {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            completion_ttl_secs: default_completion_ttl(),
            prompt_ttl_secs: default_prompt_ttl(),
        }
    }
}

struct PromptCacheInner {
    completions: HashMap<u64, CachedResponse>,
    stats: PromptCacheStats,
    last_fingerprint: u64,
    config: PromptCacheConfig,
}

pub struct PromptCache {
    inner: Arc<Mutex<PromptCacheInner>>,
}

impl PromptCache {
    pub fn new(config: PromptCacheConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(PromptCacheInner {
                completions: HashMap::new(),
                stats: PromptCacheStats::default(),
                last_fingerprint: 0,
                config,
            })),
        }
    }

    pub fn compute_fingerprint(system_prompt: &str, tools_json: &str) -> u64 {
        let mut data = Vec::with_capacity(system_prompt.len() + tools_json.len() + 1);
        data.extend_from_slice(system_prompt.as_bytes());
        data.push(0xff);
        data.extend_from_slice(tools_json.as_bytes());
        fnv1a_64(&data)
    }

    pub fn lookup_completion(&self, fingerprint: u64) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if let Some(cached) = inner.completions.get(&fingerprint) {
            if cached.is_expired() {
                inner.completions.remove(&fingerprint);
                inner.stats.misses += 1;
                return false;
            }
            inner.stats.hits += 1;
            return true;
        }
        inner.stats.misses += 1;
        false
    }

    pub fn record_fingerprint(&self, fingerprint: u64) {
        let mut inner = self.inner.lock().unwrap();
        let prompt_ttl_secs = inner.config.prompt_ttl_secs;
        if inner.last_fingerprint != 0 && fingerprint != inner.last_fingerprint {
            inner.stats.breaks += 1;
        }
        inner.completions.insert(
            fingerprint,
            CachedResponse {
                fingerprint,
                created_at: Instant::now(),
                ttl: Duration::from_secs(prompt_ttl_secs),
            },
        );
        inner.stats.writes += 1;
        inner.last_fingerprint = fingerprint;
    }

    pub fn stats(&self) -> PromptCacheStats {
        let inner = self.inner.lock().unwrap();
        inner.stats.clone()
    }

    pub fn invalidate(&self) {
        let mut inner = self.inner.lock().unwrap();
        let count = inner.completions.len() as u64;
        inner.completions.clear();
        inner.stats.invalidations += count;
        inner.last_fingerprint = 0;
    }
}

impl Clone for PromptCache {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}
