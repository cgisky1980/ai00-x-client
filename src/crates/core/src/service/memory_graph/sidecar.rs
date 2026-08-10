//! Memory sidecar trait for lightweight relevance verification and memory extraction.
//!
//! The trait is defined in core; the desktop layer injects an RWKV-backed
//! implementation at startup, following the same pattern as EmbeddingProvider.

use std::sync::OnceLock;

/// Result of memory relevance check.
#[derive(Debug, Clone)]
pub struct RelevanceResult {
    pub relevant: bool,
    pub reason: String,
}

/// Result of memory extraction from a conversation transcript.
#[derive(Debug, Clone)]
pub struct ExtractedMemory {
    pub category: String,
    pub content: String,
    pub trust: String,
}

/// Lightweight sidecar for memory operations.
/// Implementations typically use a small/fast LLM (e.g., RWKV) for these tasks.
#[async_trait::async_trait]
pub trait MemorySidecar: Send + Sync {
    /// Check whether a memory entry is relevant to the current conversation context.
    async fn check_relevance(
        &self,
        memory_content: &str,
        context: &str,
    ) -> Result<RelevanceResult, String>;

    /// Extract memories from a conversation transcript.
    async fn extract_memories(
        &self,
        transcript: &str,
        existing_memories: &[String],
    ) -> Result<Vec<ExtractedMemory>, String>;

    /// Check if a new memory contradicts an existing one in the same category.
    async fn check_contradiction(
        &self,
        new_content: &str,
        existing_content: &str,
    ) -> Result<bool, String>;
}

static MEMORY_SIDECAR: OnceLock<Box<dyn MemorySidecar>> = OnceLock::new();

pub fn set_memory_sidecar(sidecar: Box<dyn MemorySidecar>) {
    let _ = MEMORY_SIDECAR.set(sidecar);
}

pub fn get_memory_sidecar() -> Option<&'static dyn MemorySidecar> {
    MEMORY_SIDECAR.get().map(|s| s.as_ref())
}

pub fn is_sidecar_enabled() -> bool {
    MEMORY_SIDECAR.get().is_some()
}
