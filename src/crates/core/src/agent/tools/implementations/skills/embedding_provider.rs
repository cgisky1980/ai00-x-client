//! Embedding provider trait bridge
//!
//! Allows the desktop layer to inject its embedding service into the core crate.

use std::sync::{Arc, OnceLock};

pub trait EmbeddingProvider: Send + Sync {
    fn embed_text(&self, text: &str) -> Result<Vec<f32>, String>;
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String>;
    fn dimension(&self) -> usize;
}

static PROVIDER: OnceLock<Arc<dyn EmbeddingProvider>> = OnceLock::new();

pub fn set_embedding_provider(provider: Arc<dyn EmbeddingProvider>) {
    let _ = PROVIDER.set(provider);
}

pub fn get_embedding_provider() -> Option<Arc<dyn EmbeddingProvider>> {
    PROVIDER.get().cloned()
}
