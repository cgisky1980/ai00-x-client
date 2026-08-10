use super::graph::MemoryGraph;
use super::types::{MemoryCategory, MemoryEntry, TrustLevel};
use crate::infrastructure::get_path_manager_arc;
use crate::util::errors::{Ai00XError, Ai00XResult};
use log::debug;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::RwLock;

pub struct MemoryManager {
    graph: Arc<RwLock<MemoryGraph>>,
    graph_path: PathBuf,
    #[allow(dead_code)]
    project_dir: Option<PathBuf>,
}

/// Global singleton MemoryManager, shared by MemoryAgent and MemoryTool.
static GLOBAL_MANAGER: std::sync::OnceLock<Arc<MemoryManager>> = std::sync::OnceLock::new();

impl MemoryManager {
    pub async fn new() -> Ai00XResult<Self> {
        let pm = get_path_manager_arc();
        let graph_path = pm.user_data_dir().join("memory_graph.json");
        Self::from_path(graph_path, None).await
    }

    /// Get or create the process-global MemoryManager instance.
    /// MemoryAgent and MemoryTool must use this to avoid data races.
    pub async fn global() -> Ai00XResult<Arc<MemoryManager>> {
        if let Some(mgr) = GLOBAL_MANAGER.get() {
            return Ok(Arc::clone(mgr));
        }
        let mgr = Arc::new(MemoryManager::new().await?);
        let _ = GLOBAL_MANAGER.set(Arc::clone(&mgr));
        Ok(mgr)
    }

    pub async fn new_project(workspace_path: &Path) -> Ai00XResult<Self> {
        let pm = get_path_manager_arc();
        let graph_path = pm
            .project_memory_dir(workspace_path)
            .join("memory_graph.json");
        Self::from_path(graph_path, Some(workspace_path.to_path_buf())).await
    }

    #[doc(hidden)]
    pub async fn with_temp_dir(dir: &std::path::Path) -> Ai00XResult<Self> {
        let graph_path = dir.join("memory_graph.json");
        Self::from_path(graph_path, None).await
    }

    async fn from_path(graph_path: PathBuf, project_dir: Option<PathBuf>) -> Ai00XResult<Self> {
        if let Some(parent) = graph_path.parent() {
            fs::create_dir_all(parent).await.map_err(|e| {
                Ai00XError::io(format!("Failed to create memory graph directory: {}", e))
            })?;
        }

        let graph = Self::load_graph(&graph_path).await.unwrap_or_default();

        debug!(
            "Loaded memory graph: {} memories, path={}",
            graph.memory_count(),
            graph_path.display()
        );

        Ok(Self {
            graph: Arc::new(RwLock::new(graph)),
            graph_path,
            project_dir,
        })
    }

    async fn load_graph(path: &PathBuf) -> Ai00XResult<MemoryGraph> {
        if !path.exists() {
            return Ok(MemoryGraph::new());
        }
        let content = fs::read_to_string(path)
            .await
            .map_err(|e| Ai00XError::io(format!("Failed to read memory graph file: {}", e)))?;
        let graph: MemoryGraph = serde_json::from_str(&content).map_err(|e| {
            Ai00XError::Deserialization(format!("Failed to deserialize memory graph: {}", e))
        })?;
        Ok(graph)
    }

    async fn save_graph(&self) -> Ai00XResult<()> {
        let graph = self.graph.read().await;
        let content = serde_json::to_string_pretty(&*graph)
            .map_err(|e| Ai00XError::service(format!("Failed to serialize memory graph: {}", e)))?;
        fs::write(&self.graph_path, content)
            .await
            .map_err(|e| Ai00XError::io(format!("Failed to write memory graph file: {}", e)))?;
        debug!(
            "Memory graph saved: {} memories to {}",
            graph.memory_count(),
            self.graph_path.display()
        );
        Ok(())
    }

    pub fn get_storage_path(&self) -> &PathBuf {
        &self.graph_path
    }

    pub async fn memory_count(&self) -> usize {
        self.graph.read().await.memory_count()
    }

    pub async fn add_memory(&self, entry: MemoryEntry) -> Ai00XResult<String> {
        let mut graph = self.graph.write().await;
        let id = graph.add_memory(entry);
        drop(graph);
        self.save_graph().await?;
        Ok(id)
    }

    /// Remember a memory with automatic embedding-based dedup.
    /// Threshold of 0.85 means similar enough → reinforce existing instead of creating new.
    pub async fn remember(&self, entry: MemoryEntry) -> Ai00XResult<String> {
        let mut graph = self.graph.write().await;

        if let Some(ref emb) = entry.embedding {
            if let Some(existing_id) = Self::find_duplicate(&graph, emb, 0.85) {
                if let Some(existing) = graph.get_memory_mut(&existing_id) {
                    existing.reinforce(entry.source.as_deref().unwrap_or("dedup"));
                    let result = existing.id.clone();
                    drop(graph);
                    self.save_graph().await?;
                    return Ok(result);
                }
            }
        }

        let id = graph.add_memory(entry);
        drop(graph);
        self.save_graph().await?;
        Ok(id)
    }

    fn find_duplicate(graph: &MemoryGraph, query_emb: &[f32], threshold: f32) -> Option<String> {
        let mut best: Option<(String, f32)> = None;
        for entry in graph.active_memories() {
            if let Some(ref emb) = entry.embedding {
                let sim = cosine_similarity(query_emb, emb);
                if sim >= threshold && best.as_ref().map(|(_, s)| sim > *s).unwrap_or(true) {
                    best = Some((entry.id.clone(), sim));
                }
            }
        }
        best.map(|(id, _)| id)
    }

    pub async fn remove_memory(&self, id: &str) -> Ai00XResult<Option<MemoryEntry>> {
        let mut graph = self.graph.write().await;
        let removed = graph.remove_memory(id);
        drop(graph);
        self.save_graph().await?;
        Ok(removed)
    }

    pub async fn get_memory(&self, id: &str) -> Option<MemoryEntry> {
        self.graph.read().await.get_memory(id).cloned()
    }

    pub async fn get_all_memories(&self) -> Vec<MemoryEntry> {
        self.graph.read().await.all_memories().cloned().collect()
    }

    pub async fn get_active_memories(&self) -> Vec<MemoryEntry> {
        self.graph.read().await.active_memories().cloned().collect()
    }

    /// Add a memory without saving to disk (for batch operations).
    /// Caller must call `flush()` afterwards.
    pub async fn add_memory_no_save(&self, entry: MemoryEntry) -> String {
        let mut graph = self.graph.write().await;
        graph.add_memory(entry)
    }

    /// Remove a memory without saving to disk (for batch operations).
    /// Caller must call `flush()` afterwards.
    pub async fn remove_memory_no_save(&self, id: &str) -> Option<MemoryEntry> {
        let mut graph = self.graph.write().await;
        graph.remove_memory(id)
    }

    /// Persist the current graph state to disk.
    pub async fn flush(&self) -> Ai00XResult<()> {
        self.save_graph().await
    }

    /// Find memories similar to the given embedding.
    /// Ranks by composite score: 70% embedding similarity + 30% memory quality score.
    pub async fn find_similar(
        &self,
        query_embedding: &[f32],
        threshold: f32,
        limit: usize,
    ) -> Ai00XResult<Vec<(MemoryEntry, f32)>> {
        let graph = self.graph.read().await;
        let mut scored: Vec<(MemoryEntry, f32)> = Vec::new();

        for entry in graph.active_memories() {
            if let Some(ref emb) = entry.embedding {
                let sim = cosine_similarity(query_embedding, emb);
                if sim >= threshold {
                    // Composite: 70% similarity + 30% quality score
                    let quality = (memory_score(entry) / 200.0).min(1.0) as f32;
                    let composite = sim * 0.7 + quality * 0.3;
                    scored.push((entry.clone(), composite));
                }
            }
        }

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);

        Ok(scored)
    }

    /// Keyword search across all memories
    pub async fn search(&self, query: &str) -> Vec<MemoryEntry> {
        let graph = self.graph.read().await;
        let query_lower = query.to_lowercase();

        if query_lower.is_empty() {
            return Vec::new();
        }

        graph
            .active_memories()
            .filter(|e| e.searchable_text().contains(&query_lower))
            .cloned()
            .collect()
    }

    /// Tag a memory
    pub async fn tag_memory(&self, memory_id: &str, tag_name: &str) -> Ai00XResult<()> {
        let mut graph = self.graph.write().await;
        graph.tag_memory(memory_id, tag_name);
        drop(graph);
        self.save_graph().await?;
        Ok(())
    }

    /// Link two memories
    pub async fn link_memories(&self, from: &str, to: &str, weight: f32) -> Ai00XResult<()> {
        let mut graph = self.graph.write().await;
        graph.link_memories(from, to, weight);
        drop(graph);
        self.save_graph().await?;
        Ok(())
    }

    /// Get related memories via cascade retrieval
    pub async fn get_related(
        &self,
        memory_id: &str,
        depth: usize,
    ) -> Ai00XResult<Vec<MemoryEntry>> {
        let graph = self.graph.read().await;
        let results = graph.cascade_retrieve_no_count(&[memory_id.to_string()], &[1.0], depth, 10);
        let entries: Vec<MemoryEntry> = results
            .into_iter()
            .filter_map(|(id, _)| graph.get_memory(&id).cloned())
            .collect();
        Ok(entries)
    }

    /// Format recent relevant memories for prompt injection
    pub async fn get_relevant_for_prompt(&self, limit: usize) -> Option<String> {
        let graph = self.graph.read().await;
        let relevant: Vec<&MemoryEntry> = graph
            .active_memories()
            .filter(|e| e.effective_confidence() > 0.1)
            .collect();

        if relevant.is_empty() {
            return None;
        }

        let mut scored: Vec<(&MemoryEntry, f64)> =
            relevant.into_iter().map(|e| (e, memory_score(e))).collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);

        if scored.is_empty() {
            return None;
        }

        let mut output = String::from("# Memory\n\n");
        let category_order = [
            MemoryCategory::Correction,
            MemoryCategory::Fact,
            MemoryCategory::Preference,
            MemoryCategory::Entity,
        ];

        for cat in &category_order {
            let items: Vec<_> = scored.iter().filter(|(e, _)| e.category == *cat).collect();
            if items.is_empty() {
                continue;
            }
            let title = match cat {
                MemoryCategory::Correction => "Corrections",
                MemoryCategory::Fact => "Facts",
                MemoryCategory::Preference => "Preferences",
                MemoryCategory::Entity => "Entities",
                MemoryCategory::Custom(_) => "Custom",
            };
            output.push_str(&format!("## {}\n", title));
            for (idx, (entry, _)) in items.into_iter().enumerate() {
                output.push_str(&format!("{}. {}\n", idx + 1, entry.content.trim()));
            }
            output.push('\n');
        }

        Some(output.trim().to_string())
    }
}

fn memory_score(entry: &MemoryEntry) -> f64 {
    if !entry.active {
        return 0.0;
    }
    let mut score = 0.0;

    let age_hours = (chrono::Utc::now() - entry.updated_at).num_hours().max(0) as f64; // guard against clock skew
    score += 100.0 / (1.0 + age_hours / 24.0);

    score += (entry.access_count as f64).sqrt() * 10.0;

    score += entry.category.category_importance();

    score *= match entry.trust {
        TrustLevel::High => 1.5,
        TrustLevel::Medium => 1.0,
        TrustLevel::Low => 0.7,
    };

    score += (entry.strength.max(1) as f64).ln() * 5.0;

    score
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: create a temp-dir backed MemoryManager for isolated tests.
    async fn new_test_manager() -> MemoryManager {
        let dir = std::env::temp_dir().join(format!("ai00x-memory-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create test dir");
        MemoryManager::with_temp_dir(&dir)
            .await
            .expect("test manager")
    }

    #[tokio::test]
    async fn add_and_retrieve_memory() {
        let manager = new_test_manager().await;
        let entry = MemoryEntry::new(MemoryCategory::Fact, "Rust uses cargo for builds");
        let id = manager.add_memory(entry).await.unwrap();
        assert!(id.starts_with("mem:"));

        let retrieved = manager.get_memory(&id).await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().content, "Rust uses cargo for builds");
    }

    #[tokio::test]
    async fn remove_memory() {
        let manager = new_test_manager().await;
        let before = manager.memory_count().await;
        let entry = MemoryEntry::new(MemoryCategory::Fact, "temporary-remove-test");
        let id = manager.add_memory(entry).await.unwrap();
        assert_eq!(manager.memory_count().await, before + 1);

        manager.remove_memory(&id).await.unwrap();
        assert_eq!(manager.memory_count().await, before);
    }

    #[tokio::test]
    async fn search_by_keyword() {
        let manager = new_test_manager().await;
        manager
            .add_memory(MemoryEntry::new(
                MemoryCategory::Fact,
                "PostgreSQL is the database",
            ))
            .await
            .unwrap();
        manager
            .add_memory(MemoryEntry::new(
                MemoryCategory::Preference,
                "Use tabs not spaces",
            ))
            .await
            .unwrap();

        let results = manager.search("postgresql").await;
        assert_eq!(results.len(), 1);
        assert!(results[0].content.contains("PostgreSQL"));
    }

    #[tokio::test]
    async fn get_relevant_for_prompt() {
        let manager = new_test_manager().await;
        manager
            .add_memory(MemoryEntry::new(
                MemoryCategory::Correction,
                "Never use println for logging",
            ))
            .await
            .unwrap();
        manager
            .add_memory(MemoryEntry::new(
                MemoryCategory::Preference,
                "Prefers 4-space indentation",
            ))
            .await
            .unwrap();

        let prompt = manager.get_relevant_for_prompt(5).await;
        assert!(prompt.is_some());
        let prompt = prompt.unwrap();
        assert!(prompt.contains("Corrections"));
        assert!(prompt.contains("Preferences"));
    }

    #[test]
    fn cosine_similarity_same_vector() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &b) - 1.0).abs() < 0.001);
    }

    #[test]
    fn cosine_similarity_orthogonal() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert!(cosine_similarity(&a, &b).abs() < 0.001);
    }

    #[test]
    fn memory_score_favors_recent_corrections() {
        let old_fact = MemoryEntry::new(MemoryCategory::Fact, "old");
        let new_correction = MemoryEntry::new(MemoryCategory::Correction, "new");
        assert!(memory_score(&new_correction) > memory_score(&old_fact));
    }
}
