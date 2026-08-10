use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

fn default_weight() -> f32 {
    1.0
}

/// Edge relationship types between nodes
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EdgeKind {
    /// Memory has this explicit tag
    HasTag,
    /// Memory belongs to auto-discovered cluster (reserved)
    InCluster,
    /// Semantic relationship with weight (0.0-1.0)
    RelatesTo {
        #[serde(default = "default_weight")]
        weight: f32,
    },
    /// Newer memory replaces older one
    Supersedes,
    /// Conflicting information (both kept, flagged)
    Contradicts,
    /// Procedural knowledge derived from facts
    DerivedFrom,
}

impl EdgeKind {
    pub fn traversal_weight(&self) -> f32 {
        match self {
            EdgeKind::HasTag => 0.8,
            EdgeKind::InCluster => 0.6,
            EdgeKind::RelatesTo { weight } => *weight,
            EdgeKind::Supersedes => 0.9,
            EdgeKind::Contradicts => 0.3,
            EdgeKind::DerivedFrom => 0.7,
        }
    }
}

/// Trust levels for memories
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TrustLevel {
    /// User explicitly stated this
    High,
    /// Observed from user behavior
    #[default]
    Medium,
    /// Inferred by the agent
    Low,
}

/// A reinforcement breadcrumb tracking when/where a memory was reinforced
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reinforcement {
    pub session_id: String,
    pub timestamp: DateTime<Utc>,
}

/// Memory category
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum MemoryCategory {
    #[default]
    Fact,
    Preference,
    Entity,
    Correction,
    Custom(String),
}

impl std::fmt::Display for MemoryCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MemoryCategory::Fact => write!(f, "fact"),
            MemoryCategory::Preference => write!(f, "preference"),
            MemoryCategory::Entity => write!(f, "entity"),
            MemoryCategory::Correction => write!(f, "correction"),
            MemoryCategory::Custom(s) => write!(f, "{}", s),
        }
    }
}

impl std::str::FromStr for MemoryCategory {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s.to_lowercase().as_str() {
            "fact" | "facts" => MemoryCategory::Fact,
            "preference" | "preferences" | "pref" => MemoryCategory::Preference,
            "correction" | "corrections" | "fix" | "bug" => MemoryCategory::Correction,
            "entity" | "entities" => MemoryCategory::Entity,
            "observation" | "lesson" | "learning" => MemoryCategory::Fact,
            other => MemoryCategory::Custom(other.to_string()),
        })
    }
}

impl MemoryCategory {
    pub fn half_life_days(&self) -> f32 {
        match self {
            MemoryCategory::Correction => 365.0,
            MemoryCategory::Preference => 90.0,
            MemoryCategory::Fact => 30.0,
            MemoryCategory::Entity => 60.0,
            MemoryCategory::Custom(_) => 45.0,
        }
    }

    pub fn category_importance(&self) -> f64 {
        match self {
            MemoryCategory::Correction => 50.0,
            MemoryCategory::Preference => 30.0,
            MemoryCategory::Fact => 20.0,
            MemoryCategory::Entity => 10.0,
            MemoryCategory::Custom(_) => 5.0,
        }
    }
}

fn default_confidence() -> f32 {
    1.0
}

fn default_active() -> bool {
    true
}

/// A single memory entry in the graph
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub category: MemoryCategory,
    pub content: String,
    pub tags: Vec<String>,
    /// Pre-normalized lowercase search text for content + tags
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub search_text: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub access_count: u32,
    pub source: Option<String>,
    /// Trust level for this memory
    #[serde(default)]
    pub trust: TrustLevel,
    /// Consolidation strength (how many times this was reinforced)
    #[serde(default)]
    pub strength: u32,
    /// Whether this memory is active or superseded
    #[serde(default = "default_active")]
    pub active: bool,
    /// ID of memory that superseded this one
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    /// Reinforcement provenance (breadcrumbs of when/where this was reinforced)
    #[serde(default)]
    pub reinforcements: Vec<Reinforcement>,
    /// Embedding vector for similarity search (256-dim model2vec)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,
    /// Confidence score (0.0-1.0) - decays over time, boosted by use
    #[serde(default = "default_confidence")]
    pub confidence: f32,
}

fn normalize_search_text(content: &str, tags: &[String]) -> String {
    let lower = content.to_lowercase();
    let mut normalized = String::with_capacity(lower.len());
    let mut last_was_space = true;

    for ch in lower.chars() {
        let mapped = if ch.is_whitespace() || matches!(ch, '-' | '_' | '/' | '\\' | '.' | ':') {
            ' '
        } else {
            ch
        };
        if mapped == ' ' {
            if !last_was_space {
                normalized.push(' ');
                last_was_space = true;
            }
        } else {
            normalized.push(mapped);
            last_was_space = false;
        }
    }

    let base = normalized.trim().to_string();

    let tag_text: Vec<String> = tags
        .iter()
        .map(|t| t.to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();

    if tag_text.is_empty() {
        return base;
    }
    if base.is_empty() {
        return tag_text.join(" ");
    }
    format!("{} {}", base, tag_text.join(" "))
}

impl MemoryEntry {
    pub fn new(category: MemoryCategory, content: impl Into<String>) -> Self {
        let now = Utc::now();
        let content = content.into();
        let search_text = normalize_search_text(&content, &[]);
        Self {
            id: format!("mem:{}", uuid::Uuid::new_v4()),
            category,
            search_text,
            content,
            tags: Vec::new(),
            created_at: now,
            updated_at: now,
            access_count: 0,
            source: None,
            trust: TrustLevel::default(),
            strength: 1,
            active: true,
            superseded_by: None,
            reinforcements: Vec::new(),
            embedding: None,
            confidence: 1.0,
        }
    }

    pub fn refresh_search_text(&mut self) {
        self.search_text = normalize_search_text(&self.content, &self.tags);
    }

    pub fn searchable_text(&self) -> std::borrow::Cow<'_, str> {
        if self.search_text.is_empty() {
            std::borrow::Cow::Owned(normalize_search_text(&self.content, &self.tags))
        } else {
            std::borrow::Cow::Borrowed(&self.search_text)
        }
    }

    /// Get effective confidence after time-based decay
    pub fn effective_confidence(&self) -> f32 {
        if !self.active {
            return 0.0;
        }
        let age_days = (Utc::now() - self.created_at).num_days() as f32;
        let half_life = self.category.half_life_days();
        let decay = (-age_days / half_life * std::f32::consts::LN_2).exp();
        let access_boost = 1.0 + 0.1 * (self.access_count.max(1) as f32).ln();
        (self.confidence * decay * access_boost).min(1.0)
    }

    /// Boost confidence (called when memory was useful)
    pub fn boost_confidence(&mut self, amount: f32) {
        self.confidence = (self.confidence + amount).min(1.0);
        self.access_count += 1;
        self.updated_at = Utc::now();
    }

    /// Decay confidence (called when memory was retrieved but not relevant)
    pub fn decay_confidence(&mut self, amount: f32) {
        self.confidence = (self.confidence - amount).max(0.0);
    }

    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = tags;
        self.refresh_search_text();
        self
    }

    pub fn with_source(mut self, source: impl Into<String>) -> Self {
        self.source = Some(source.into());
        self
    }

    pub fn with_trust(mut self, trust: TrustLevel) -> Self {
        self.trust = trust;
        self
    }

    pub fn with_embedding(mut self, embedding: Vec<f32>) -> Self {
        self.embedding = Some(embedding);
        self
    }

    pub fn reinforce(&mut self, session_id: &str) {
        self.strength += 1;
        self.updated_at = Utc::now();
        self.reinforcements.push(Reinforcement {
            session_id: session_id.to_string(),
            timestamp: Utc::now(),
        });
    }

    pub fn supersede(&mut self, new_id: &str) {
        self.active = false;
        self.superseded_by = Some(new_id.to_string());
    }

    pub fn has_embedding(&self) -> bool {
        self.embedding.is_some()
    }

    /// Generate and set embedding if not already present.
    /// Returns true if embedding was generated.
    pub fn ensure_embedding(&mut self, provider: &dyn super::EmbeddingProviderTrait) -> bool {
        if self.embedding.is_some() {
            return false;
        }
        match provider.embed_text(&self.content) {
            Ok(emb) => {
                self.embedding = Some(emb);
                true
            }
            Err(e) => {
                log::error!("Failed to generate embedding: {}", e);
                false
            }
        }
    }
}

/// Memory scope for storage and retrieval
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryScope {
    Project,
    Global,
    All,
}

impl MemoryScope {
    pub fn includes_project(self) -> bool {
        matches!(self, Self::Project | Self::All)
    }

    pub fn includes_global(self) -> bool {
        matches!(self, Self::Global | Self::All)
    }
}

/// Memory state for UI activity tracking
#[derive(Debug, Clone)]
pub enum MemoryState {
    Idle,
    Embedding,
    SidecarChecking { count: usize },
    FoundRelevant { count: usize },
    Extracting { reason: String },
    Maintaining { phase: String },
    ToolAction { action: String, detail: String },
}

/// Memory activity event for logging
#[derive(Debug, Clone)]
pub enum MemoryEventKind {
    EmbeddingStarted,
    EmbeddingComplete { latency_ms: u64, hits: usize },
    SidecarStarted,
    SidecarComplete { latency_ms: u64 },
    SidecarRelevant { memory_preview: String },
    SidecarNotRelevant,
    MemoryInjected { count: usize, prompt_chars: usize },
    ExtractionStarted { reason: String },
    ExtractionComplete { count: usize },
    MaintenanceStarted { verified: usize, rejected: usize },
    MaintenanceComplete,
    Error { message: String },
}

/// Statistical metadata for the graph
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GraphMetadata {
    /// Total retrieval operations
    #[serde(default)]
    pub retrieval_count: u64,
    /// Total links discovered via co-relevance
    #[serde(default)]
    pub link_discovery_count: u64,
}

/// An edge in the memory graph
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    /// Target node ID
    pub target: String,
    /// Type of relationship
    #[serde(flatten)]
    pub kind: EdgeKind,
}

impl Edge {
    pub fn new(target: impl Into<String>, kind: EdgeKind) -> Self {
        Self {
            target: target.into(),
            kind,
        }
    }
}

/// A tag node in the graph
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagEntry {
    /// Unique ID (format: "tag:{name}")
    pub id: String,
    /// Display name
    pub name: String,
    /// Optional description
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Number of memories with this tag
    pub count: u32,
    /// When the tag was first created
    pub created_at: DateTime<Utc>,
}

impl TagEntry {
    pub fn new(name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            id: format!("tag:{}", name),
            name,
            description: None,
            count: 0,
            created_at: Utc::now(),
        }
    }
}

/// Embedding provider trait for memory graph operations
pub trait EmbeddingProviderTrait: Send + Sync {
    fn embed_text(&self, text: &str) -> Result<Vec<f32>, String>;
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String>;
    fn dimension(&self) -> usize;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_memory_entry_has_defaults() {
        let entry = MemoryEntry::new(MemoryCategory::Fact, "test content");
        assert!(entry.id.starts_with("mem:"));
        assert_eq!(entry.content, "test content");
        assert_eq!(entry.category, MemoryCategory::Fact);
        assert_eq!(entry.trust, TrustLevel::Medium);
        assert_eq!(entry.strength, 1);
        assert!(entry.active);
        assert_eq!(entry.confidence, 1.0);
        assert!(!entry.search_text.is_empty());
    }

    #[test]
    fn effective_confidence_decays() {
        let entry = MemoryEntry::new(MemoryCategory::Fact, "old fact");
        assert!(entry.effective_confidence() <= 1.0);
        assert!(entry.effective_confidence() > 0.0);
    }

    #[test]
    fn correction_has_longer_half_life() {
        assert!(
            MemoryCategory::Correction.half_life_days() > MemoryCategory::Fact.half_life_days()
        );
    }

    #[test]
    fn boost_and_decay_confidence() {
        let mut entry = MemoryEntry::new(MemoryCategory::Preference, "test");
        entry.boost_confidence(0.05);
        assert!(entry.confidence <= 1.0);
        entry.decay_confidence(0.1);
        assert!(entry.confidence < 1.0);
        assert!(entry.access_count >= 1);
    }

    #[test]
    fn reinforce_adds_breadcrumb() {
        let mut entry = MemoryEntry::new(MemoryCategory::Fact, "test");
        entry.reinforce("session-1");
        assert_eq!(entry.strength, 2);
        assert_eq!(entry.reinforcements.len(), 1);
        assert_eq!(entry.reinforcements[0].session_id, "session-1");
    }

    #[test]
    fn supersede_marks_inactive() {
        let mut entry = MemoryEntry::new(MemoryCategory::Fact, "old");
        entry.supersede("mem:new");
        assert!(!entry.active);
        assert_eq!(entry.superseded_by, Some("mem:new".to_string()));
    }

    #[test]
    fn parse_category_from_str() {
        assert_eq!(
            "fact".parse::<MemoryCategory>().unwrap(),
            MemoryCategory::Fact
        );
        assert_eq!(
            "correction".parse::<MemoryCategory>().unwrap(),
            MemoryCategory::Correction
        );
        assert!(matches!(
            "unknown".parse::<MemoryCategory>().unwrap(),
            MemoryCategory::Custom(_)
        ));
    }

    #[test]
    fn memory_scope_includes() {
        assert!(MemoryScope::All.includes_global());
        assert!(MemoryScope::All.includes_project());
        assert!(MemoryScope::Global.includes_global());
        assert!(!MemoryScope::Global.includes_project());
        assert!(MemoryScope::Project.includes_project());
        assert!(!MemoryScope::Project.includes_global());
    }
}
