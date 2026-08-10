use super::types::{Edge, EdgeKind, GraphMetadata, MemoryEntry, TagEntry};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};

/// Current graph format version for migration detection
pub const GRAPH_VERSION: u32 = 1;

/// The memory graph — HashMap-based for clean JSON serialization.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MemoryGraph {
    /// Format version for migration detection
    pub graph_version: u32,

    /// Memory nodes by ID
    pub memories: HashMap<String, MemoryEntry>,

    /// Tag nodes by ID (format: "tag:{name}")
    pub tags: HashMap<String, TagEntry>,

    /// Forward edges: source_id → Vec<Edge>
    #[serde(default)]
    pub edges: HashMap<String, Vec<Edge>>,

    /// Reverse edges for efficient lookups: target_id → Vec<source_id>
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub reverse_edges: HashMap<String, Vec<String>>,

    /// Graph statistics and metadata
    #[serde(default)]
    pub metadata: GraphMetadata,
}

impl Default for MemoryGraph {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryGraph {
    pub fn new() -> Self {
        Self {
            graph_version: GRAPH_VERSION,
            memories: HashMap::new(),
            tags: HashMap::new(),
            edges: HashMap::new(),
            reverse_edges: HashMap::new(),
            metadata: GraphMetadata::default(),
        }
    }

    pub fn memory_count(&self) -> usize {
        self.memories.len()
    }

    // ==================== Memory Operations ====================

    pub fn add_memory(&mut self, mut entry: MemoryEntry) -> String {
        entry.refresh_search_text();
        let id = entry.id.clone();

        // If re-adding an existing entry (e.g. maintenance update), clean old edges first
        if self.memories.contains_key(&id) {
            self.remove_memory(&id);
        }

        for tag_name in &entry.tags {
            self.ensure_tag(tag_name);
            let tag_id = format!("tag:{}", tag_name);
            self.add_edge_internal(&id, &tag_id, EdgeKind::HasTag);
            if let Some(tag) = self.tags.get_mut(&tag_id) {
                tag.count += 1;
            }
        }

        if let Some(ref newer_id) = entry.superseded_by {
            self.add_edge_internal(newer_id, &id, EdgeKind::Supersedes);
        }

        self.memories.insert(id.clone(), entry);
        id
    }

    pub fn get_memory(&self, id: &str) -> Option<&MemoryEntry> {
        self.memories.get(id)
    }

    pub fn get_memory_mut(&mut self, id: &str) -> Option<&mut MemoryEntry> {
        self.memories.get_mut(id)
    }

    pub fn remove_memory(&mut self, id: &str) -> Option<MemoryEntry> {
        if let Some(edges) = self.edges.remove(id) {
            for edge in edges {
                if let Some(reverse) = self.reverse_edges.get_mut(&edge.target) {
                    reverse.retain(|src| src != id);
                }
                if matches!(edge.kind, EdgeKind::HasTag) {
                    if let Some(tag) = self.tags.get_mut(&edge.target) {
                        tag.count = tag.count.saturating_sub(1);
                    }
                }
            }
        }

        if let Some(sources) = self.reverse_edges.remove(id) {
            for source in sources {
                if let Some(edges) = self.edges.get_mut(&source) {
                    edges.retain(|e| e.target != id);
                }
            }
        }

        self.memories.remove(id)
    }

    pub fn all_memories(&self) -> impl Iterator<Item = &MemoryEntry> {
        self.memories.values()
    }

    pub fn active_memories(&self) -> impl Iterator<Item = &MemoryEntry> {
        self.memories.values().filter(|m| m.active)
    }

    // ==================== Tag Operations ====================

    pub fn ensure_tag(&mut self, name: &str) -> &TagEntry {
        let tag_id = format!("tag:{}", name);
        self.tags
            .entry(tag_id.clone())
            .or_insert_with(|| TagEntry::new(name))
    }

    pub fn tag_memory(&mut self, memory_id: &str, tag_name: &str) {
        self.ensure_tag(tag_name);
        let tag_id = format!("tag:{}", tag_name);

        let already_tagged = self
            .edges
            .get(memory_id)
            .map(|edges| {
                edges
                    .iter()
                    .any(|e| e.target == tag_id && matches!(e.kind, EdgeKind::HasTag))
            })
            .unwrap_or(false);
        if already_tagged {
            return;
        }

        self.add_edge_internal(memory_id, &tag_id, EdgeKind::HasTag);

        if let Some(tag) = self.tags.get_mut(&tag_id) {
            tag.count += 1;
        }

        if let Some(memory) = self.memories.get_mut(memory_id) {
            if !memory.tags.contains(&tag_name.to_string()) {
                memory.tags.push(tag_name.to_string());
                memory.refresh_search_text();
            }
        }
    }

    pub fn untag_memory(&mut self, memory_id: &str, tag_name: &str) {
        let tag_id = format!("tag:{}", tag_name);

        if let Some(edges) = self.edges.get_mut(memory_id) {
            edges.retain(|e| !(e.target == tag_id && matches!(e.kind, EdgeKind::HasTag)));
        }

        if let Some(sources) = self.reverse_edges.get_mut(&tag_id) {
            sources.retain(|s| s != memory_id);
        }

        if let Some(tag) = self.tags.get_mut(&tag_id) {
            tag.count = tag.count.saturating_sub(1);
        }

        if let Some(memory) = self.memories.get_mut(memory_id) {
            memory.tags.retain(|t| t != tag_name);
            memory.refresh_search_text();
        }
    }

    pub fn get_memories_by_tag(&self, tag_name: &str) -> Vec<&MemoryEntry> {
        let tag_id = format!("tag:{}", tag_name);
        self.reverse_edges
            .get(&tag_id)
            .map(|sources| {
                sources
                    .iter()
                    .filter_map(|id| self.memories.get(id))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn all_tags(&self) -> impl Iterator<Item = &TagEntry> {
        self.tags.values()
    }

    // ==================== Edge Operations ====================

    fn add_edge_internal(&mut self, from: &str, to: &str, kind: EdgeKind) {
        self.edges
            .entry(from.to_string())
            .or_default()
            .push(Edge::new(to, kind));

        self.reverse_edges
            .entry(to.to_string())
            .or_default()
            .push(from.to_string());
    }

    pub fn add_edge(&mut self, from: &str, to: &str, kind: EdgeKind) {
        let already_connected = self
            .edges
            .get(from)
            .map(|edges| edges.iter().any(|e| e.target == to && e.kind == kind))
            .unwrap_or(false);
        if already_connected {
            return;
        }
        self.add_edge_internal(from, to, kind);
    }

    pub fn remove_edge(&mut self, from: &str, to: &str, kind: &EdgeKind) {
        if let Some(edges) = self.edges.get_mut(from) {
            edges.retain(|e| !(e.target == to && &e.kind == kind));
        }
        if let Some(sources) = self.reverse_edges.get_mut(to) {
            sources.retain(|s| s != from);
        }
    }

    pub fn get_edges(&self, node_id: &str) -> &[Edge] {
        self.edges.get(node_id).map(|v| v.as_slice()).unwrap_or(&[])
    }

    pub fn get_incoming(&self, node_id: &str) -> Vec<&str> {
        self.reverse_edges
            .get(node_id)
            .map(|v| v.iter().map(|s| s.as_str()).collect())
            .unwrap_or_default()
    }

    pub fn link_memories(&mut self, from: &str, to: &str, weight: f32) {
        self.add_edge(from, to, EdgeKind::RelatesTo { weight });
        self.metadata.link_discovery_count += 1;
    }

    pub fn supersede(&mut self, newer_id: &str, older_id: &str) {
        self.add_edge(newer_id, older_id, EdgeKind::Supersedes);
        if let Some(older) = self.memories.get_mut(older_id) {
            older.active = false;
            older.superseded_by = Some(newer_id.to_string());
        }
    }

    pub fn mark_contradiction(&mut self, id_a: &str, id_b: &str) {
        self.add_edge(id_a, id_b, EdgeKind::Contradicts);
        self.add_edge(id_b, id_a, EdgeKind::Contradicts);
    }

    // ==================== Cascade Retrieval ====================

    /// Perform BFS cascade retrieval starting from seed memories.
    /// Returns (memory_id, score) pairs sorted by score descending.
    pub fn cascade_retrieve(
        &mut self,
        seed_ids: &[String],
        seed_scores: &[f32],
        max_depth: usize,
        max_results: usize,
    ) -> Vec<(String, f32)> {
        self.metadata.retrieval_count += 1;
        cascade_retrieve_impl(
            &self.memories,
            &self.edges,
            &self.reverse_edges,
            seed_ids,
            seed_scores,
            max_depth,
            max_results,
        )
    }

    /// Same as cascade_retrieve but without incrementing retrieval counter (for read-only access).
    pub fn cascade_retrieve_no_count(
        &self,
        seed_ids: &[String],
        seed_scores: &[f32],
        max_depth: usize,
        max_results: usize,
    ) -> Vec<(String, f32)> {
        cascade_retrieve_impl(
            &self.memories,
            &self.edges,
            &self.reverse_edges,
            seed_ids,
            seed_scores,
            max_depth,
            max_results,
        )
    }
}

// ==================== Cascade Retrieve Implementation ====================

fn cascade_retrieve_impl(
    memories: &HashMap<String, MemoryEntry>,
    edges: &HashMap<String, Vec<Edge>>,
    reverse_edges: &HashMap<String, Vec<String>>,
    seed_ids: &[String],
    seed_scores: &[f32],
    max_depth: usize,
    max_results: usize,
) -> Vec<(String, f32)> {
    let mut visited: HashSet<String> = HashSet::new();
    let mut results: HashMap<String, f32> = HashMap::new();
    let mut queue: VecDeque<(String, f32, usize)> = VecDeque::new();

    for (id, score) in seed_ids.iter().zip(seed_scores.iter()) {
        if memories.contains_key(id) {
            queue.push_back((id.clone(), *score, 0));
            results.insert(id.clone(), *score);
        }
    }

    while let Some((node_id, score, depth)) = queue.pop_front() {
        if !visited.insert(node_id.clone()) {
            continue;
        }
        if depth >= max_depth {
            continue;
        }

        let node_edges: Vec<&Edge> = edges
            .get(&node_id)
            .map(|v| v.iter().collect())
            .unwrap_or_default();
        for edge in node_edges {
            if visited.contains(&edge.target) {
                continue;
            }
            let edge_weight = edge.kind.traversal_weight();
            let decay = 0.7_f32.powi(depth as i32 + 1);
            let new_score = score * edge_weight * decay;

            if edge.target.starts_with("tag:") {
                if let Some(sources) = reverse_edges.get(&edge.target) {
                    for source_id in sources {
                        if !visited.contains(source_id) && memories.contains_key(source_id) {
                            let existing = results.get(source_id).copied().unwrap_or(0.0);
                            if new_score > existing {
                                results.insert(source_id.clone(), new_score);
                                queue.push_back((source_id.clone(), new_score, depth + 1));
                            }
                        }
                    }
                }
            } else if memories.contains_key(&edge.target) {
                let existing = results.get(&edge.target).copied().unwrap_or(0.0);
                if new_score > existing {
                    results.insert(edge.target.clone(), new_score);
                    queue.push_back((edge.target.clone(), new_score, depth + 1));
                }
            }
        }
    }

    top_k_scored(results, max_results)
}

// ==================== Top-K Heap Utility ====================

struct TopKItem<T> {
    score: f32,
    ordinal: usize,
    value: T,
}

impl<T> PartialEq for TopKItem<T> {
    fn eq(&self, other: &Self) -> bool {
        self.score.to_bits() == other.score.to_bits() && self.ordinal == other.ordinal
    }
}

impl<T> Eq for TopKItem<T> {}

impl<T> PartialOrd for TopKItem<T> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl<T> Ord for TopKItem<T> {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.score
            .total_cmp(&other.score)
            .then_with(|| self.ordinal.cmp(&other.ordinal))
    }
}

fn top_k_scored<T>(items: impl IntoIterator<Item = (T, f32)>, limit: usize) -> Vec<(T, f32)> {
    if limit == 0 {
        return Vec::new();
    }

    let mut heap: BinaryHeap<Reverse<TopKItem<T>>> = BinaryHeap::new();
    for (ordinal, (value, score)) in items.into_iter().enumerate() {
        let candidate = Reverse(TopKItem {
            score,
            ordinal,
            value,
        });

        if heap.len() < limit {
            heap.push(candidate);
            continue;
        }

        let replace = heap
            .peek()
            .map(|smallest| score > smallest.0.score)
            .unwrap_or(false);
        if replace {
            heap.pop();
            heap.push(candidate);
        }
    }

    let mut results: Vec<_> = heap
        .into_iter()
        .map(|Reverse(item)| (item.value, item.score, item.ordinal))
        .collect();
    results.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.2.cmp(&b.2)));
    results
        .into_iter()
        .map(|(value, score, _)| (value, score))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::types::MemoryCategory;
    use super::*;

    fn make_entry(category: MemoryCategory, content: &str) -> MemoryEntry {
        MemoryEntry::new(category, content)
    }

    #[test]
    fn add_and_get_memory() {
        let mut graph = MemoryGraph::new();
        let id = graph.add_memory(make_entry(MemoryCategory::Fact, "test"));
        assert_eq!(graph.memory_count(), 1);
        assert!(graph.get_memory(&id).is_some());
    }

    #[test]
    fn remove_memory_cleans_edges() {
        let mut graph = MemoryGraph::new();
        let id = graph.add_memory(make_entry(MemoryCategory::Fact, "test"));
        graph.tag_memory(&id, "rust");
        assert!(graph.all_tags().count() > 0);

        graph.remove_memory(&id);
        assert_eq!(graph.memory_count(), 0);
    }

    #[test]
    fn tag_operations() {
        let mut graph = MemoryGraph::new();
        let id = graph.add_memory(make_entry(MemoryCategory::Preference, "4-space indent"));
        graph.tag_memory(&id, "style");

        let tagged = graph.get_memories_by_tag("style");
        assert_eq!(tagged.len(), 1);
        assert_eq!(tagged[0].id, id);

        graph.untag_memory(&id, "style");
        let tagged = graph.get_memories_by_tag("style");
        assert_eq!(tagged.len(), 0);
    }

    #[test]
    fn link_and_supersede() {
        let mut graph = MemoryGraph::new();
        let id_a = graph.add_memory(make_entry(MemoryCategory::Fact, "old fact"));
        let id_b = graph.add_memory(make_entry(MemoryCategory::Fact, "new fact"));

        graph.link_memories(&id_a, &id_b, 0.8);
        graph.supersede(&id_b, &id_a);

        assert!(!graph.get_memory(&id_a).unwrap().active);
        assert!(graph.get_memory(&id_b).unwrap().active);
    }

    #[test]
    fn cascade_retrieve_basic() {
        let mut graph = MemoryGraph::new();
        let tags = vec!["test-topic".to_string()];
        let id1 = graph.add_memory(
            MemoryEntry::new(MemoryCategory::Fact, "memory one").with_tags(tags.clone()),
        );
        let _id2 = graph
            .add_memory(MemoryEntry::new(MemoryCategory::Preference, "memory two").with_tags(tags));

        let results = graph.cascade_retrieve(std::slice::from_ref(&id1), &[1.0], 2, 5);
        assert!(!results.is_empty());
        assert!(results.iter().any(|(id, _)| id == &id1));
    }

    #[test]
    fn empty_graph_operations() {
        let graph = MemoryGraph::new();
        assert_eq!(graph.memory_count(), 0);
        assert!(graph.all_memories().next().is_none());
        assert!(graph.active_memories().next().is_none());
    }
}
