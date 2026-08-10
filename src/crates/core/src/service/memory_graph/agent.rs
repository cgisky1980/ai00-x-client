//! MemoryAgent — Background agent for automatic memory retrieval and injection.
//!
//! Architecture:
//! - Singleton (OnceLock), one instance per process
//! - Receives context updates from main agent via mpsc channel (try_send, non-blocking)
//! - Uses embeddings for fast similarity search
//! - Optionally uses a sidecar LLM for relevance verification
//! - Results arrive one turn behind (stored in Pending queue)

use super::activity::{add_event, set_state};
use super::manager::MemoryManager;
use super::pending::{self, begin_memory_check, finish_memory_check};
use super::prompt::{
    format_context_for_extraction, format_context_for_relevance, format_relevant_display_prompt,
    format_relevant_prompt, EMBEDDING_MAX_HITS, EMBEDDING_SIMILARITY_THRESHOLD,
    MAX_MEMORIES_PER_TURN,
};
use super::sidecar::{get_memory_sidecar, is_sidecar_enabled};
use super::types::{MemoryEntry, MemoryEventKind, MemoryState};

use crate::agent::core::Message;
use crate::util::errors::Ai00XResult;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

/// Channel capacity for context updates.
const CONTEXT_CHANNEL_CAPACITY: usize = 256;

/// Similarity threshold for topic change detection.
const TOPIC_CHANGE_THRESHOLD: f32 = 0.3;

/// Reset surfaced memories every N turns.
const TURN_RESET_INTERVAL: usize = 50;

/// Minimum turns before considering extraction on topic change.
const MIN_TURNS_FOR_EXTRACTION: usize = 4;

/// Trigger periodic incremental extraction every N turns.
const PERIODIC_EXTRACTION_INTERVAL: usize = 12;

/// Skip repeated relevance checks when the context is unchanged.
const RELEVANCE_CONTEXT_REPEAT_SUPPRESSION_SECS: u64 = 30;

static MEMORY_AGENT: tokio::sync::OnceCell<MemoryAgentHandle> = tokio::sync::OnceCell::const_new();

// ==================== Public Handle ====================

#[derive(Clone)]
pub struct MemoryAgentHandle {
    tx: mpsc::Sender<AgentMessage>,
}

impl MemoryAgentHandle {
    /// Send a context update to the memory agent (non-blocking).
    pub fn update_context_sync(&self, session_id: &str, messages: Arc<[Message]>) {
        let msg = AgentMessage::Context {
            session_id: session_id.to_string(),
            messages,
            timestamp: Instant::now(),
        };
        if self.tx.try_send(msg).is_err() {
            log::warn!(
                "memory agent: context channel full (capacity={}), dropping context for session {}",
                CONTEXT_CHANNEL_CAPACITY,
                session_id
            );
        }
    }

    /// Reset all memory agent state (call on agent reset).
    pub fn reset(&self) {
        let _ = self.tx.try_send(AgentMessage::Reset);
    }

    /// Clean up all per-session memory-graph state. Call on session delete/close.
    pub fn cleanup_session(&self, session_id: &str) {
        let _ = self.tx.try_send(AgentMessage::CleanupSession {
            session_id: session_id.to_string(),
        });
    }
}

/// Convenience: clean up all memory-graph state for a session.
/// Calls MemoryAgent internally if running, and always cleans pending maps.
pub fn cleanup_session(session_id: &str) {
    if let Some(agent) = try_get_agent() {
        agent.cleanup_session(session_id);
    }
    pending::cleanup_session(session_id);
}

// ==================== Internal Messages ====================

enum AgentMessage {
    Context {
        session_id: String,
        messages: Arc<[Message]>,
        #[allow(dead_code)]
        timestamp: Instant,
    },
    Reset,
    CleanupSession {
        session_id: String,
    },
}

// ==================== Per-Session State ====================

#[derive(Default)]
struct SessionState {
    /// Last context embedding for topic change detection.
    last_context_embedding: Option<Vec<f32>>,
    /// Last context string for extraction when topic changes.
    last_context_string: Option<String>,
    /// Signature of the last relevance-check context.
    last_relevance_context_signature: Option<String>,
    /// When the last relevance check was started.
    last_relevance_check_at: Option<Instant>,
    /// IDs of memories already surfaced to this session.
    surfaced_memories: HashSet<String>,
    /// Conversation turn count.
    turn_count: usize,
    /// Turn count since last extraction.
    turns_since_extraction: usize,
}

// ==================== The Agent ====================

pub struct MemoryAgent {
    rx: mpsc::Receiver<AgentMessage>,
    memory_manager: Option<Arc<MemoryManager>>,
    sessions: HashMap<String, SessionState>,
}

impl MemoryAgent {
    fn new(rx: mpsc::Receiver<AgentMessage>) -> Self {
        Self {
            rx,
            memory_manager: None,
            sessions: HashMap::new(),
        }
    }

    fn reset(&mut self) {
        log::debug!(
            "MemoryAgent reset: clearing {} sessions",
            self.sessions.len()
        );
        self.sessions.clear();
        pending::clear_all_pending_memory();
    }

    fn session_state(&mut self, session_id: &str) -> &mut SessionState {
        self.sessions.entry(session_id.to_string()).or_default()
    }

    async fn ensure_manager(&mut self) -> Ai00XResult<Arc<MemoryManager>> {
        if let Some(mgr) = &self.memory_manager {
            return Ok(Arc::clone(mgr));
        }
        let mgr = MemoryManager::global().await?;
        self.memory_manager = Some(Arc::clone(&mgr));
        Ok(mgr)
    }

    /// Run the memory agent loop.
    async fn run(mut self) {
        log::debug!("MemoryAgent started");

        while let Some(msg) = self.rx.recv().await {
            match msg {
                AgentMessage::Reset => self.reset(),
                AgentMessage::Context {
                    session_id,
                    messages,
                    timestamp: _,
                } => {
                    {
                        let ss = self.session_state(&session_id);
                        ss.turn_count = ss.turn_count.saturating_add(1);
                    }

                    // Periodic surfaced reset
                    {
                        let ss = self.session_state(&session_id);
                        if ss.turn_count.is_multiple_of(TURN_RESET_INTERVAL) {
                            ss.surfaced_memories.clear();
                        }
                    }

                    if let Err(e) = self.process_context(&session_id, messages).await {
                        log::error!("MemoryAgent error: {}", e);
                    }
                }
                AgentMessage::CleanupSession { session_id } => {
                    self.sessions.remove(&session_id);
                    pending::cleanup_session(&session_id);
                }
            }
        }

        log::debug!("MemoryAgent stopped");
    }

    /// Process a context update through the full pipeline.
    async fn process_context(
        &mut self,
        session_id: &str,
        messages: Arc<[Message]>,
    ) -> Ai00XResult<()> {
        // Guard: only one memory check per session at a time
        if !begin_memory_check(session_id) {
            return Ok(());
        }

        // Use inner function so finish_memory_check is always called on exit
        let result = self.process_context_inner(session_id, messages).await;
        finish_memory_check(session_id);
        result
    }

    /// Inner logic of process_context. Errors are logged, not propagated,
    /// to ensure finish_memory_check is always called.
    async fn process_context_inner(
        &mut self,
        session_id: &str,
        messages: Arc<[Message]>,
    ) -> Ai00XResult<()> {
        let context = format_context_for_relevance(&messages);
        if context.is_empty() {
            return Ok(());
        }

        // Suppress repeated identical context checks
        let context_sig = relevance_context_signature(&context);
        {
            let ss = self.session_state(session_id);
            if ss.last_relevance_context_signature.as_deref() == Some(context_sig.as_str())
                && ss.last_relevance_check_at.is_some_and(|at| {
                    at.elapsed().as_secs() < RELEVANCE_CONTEXT_REPEAT_SUPPRESSION_SECS
                })
            {
                return Ok(());
            }
            ss.last_relevance_context_signature = Some(context_sig);
            ss.last_relevance_check_at = Some(Instant::now());
        }

        self.session_state(session_id).turns_since_extraction = self
            .session_state(session_id)
            .turns_since_extraction
            .saturating_add(1);

        // Step 1: Embed current context
        set_state(MemoryState::Embedding);
        add_event(MemoryEventKind::EmbeddingStarted);

        let context_embedding = match embed_text(&context).await {
            Some(emb) => emb,
            None => {
                set_state(MemoryState::Idle);
                return Ok(());
            }
        };

        // Topic change detection
        {
            let ss = self.session_state(session_id);
            if let Some(ref last_emb) = ss.last_context_embedding {
                let similarity = cosine_similarity(&context_embedding, last_emb);
                if similarity < TOPIC_CHANGE_THRESHOLD {
                    log::debug!(
                        "[{}] Topic change detected (sim={:.2})",
                        session_id,
                        similarity
                    );
                    if ss.turns_since_extraction >= MIN_TURNS_FOR_EXTRACTION {
                        if let Some(prev_context) = ss.last_context_string.clone() {
                            let _ = ss;
                            self.extract_from_context(session_id, &prev_context).await;
                            let ss = self.session_state(session_id);
                            ss.turns_since_extraction = 0;
                            ss.surfaced_memories.clear();
                            pending::clear_injected_memories(session_id);
                        }
                    } else {
                        let ss = self.session_state(session_id);
                        ss.surfaced_memories.clear();
                        pending::clear_injected_memories(session_id);
                    }
                }
            }
        }

        // Store current context
        {
            let ss = self.session_state(session_id);
            ss.last_context_embedding = Some(context_embedding.clone());
            ss.last_context_string = Some(context.clone());
        }

        // Periodic extraction
        {
            let ss = self.session_state(session_id);
            if ss.turns_since_extraction >= PERIODIC_EXTRACTION_INTERVAL {
                let extraction_ctx = format_context_for_extraction(&messages);
                if extraction_ctx.len() >= 200 {
                    ss.turns_since_extraction = 0;
                    let _ = ss;
                    self.extract_from_context(session_id, &extraction_ctx).await;
                }
            }
        }

        // Step 2: Find similar memories by embedding
        let manager = match self.ensure_manager().await {
            Ok(m) => m,
            Err(e) => {
                log::error!("MemoryAgent: failed to get manager: {}", e);
                set_state(MemoryState::Idle);
                return Ok(());
            }
        };
        let candidates = match manager
            .find_similar(
                &context_embedding,
                EMBEDDING_SIMILARITY_THRESHOLD,
                EMBEDDING_MAX_HITS,
            )
            .await
        {
            Ok(c) => c,
            Err(e) => {
                log::error!("MemoryAgent: find_similar failed: {}", e);
                set_state(MemoryState::Idle);
                return Ok(());
            }
        };

        add_event(MemoryEventKind::EmbeddingComplete {
            latency_ms: 0,
            hits: candidates.len(),
        });

        if candidates.is_empty() {
            set_state(MemoryState::Idle);
            return Ok(());
        }

        // Filter out already surfaced and injected memories
        let new_candidates: Vec<_> = {
            let ss = self.session_state(session_id);
            candidates
                .into_iter()
                .filter(|(entry, _)| {
                    !ss.surfaced_memories.contains(&entry.id)
                        && !pending::is_memory_injected(session_id, &entry.id)
                })
                .collect()
        };

        if new_candidates.is_empty() {
            set_state(MemoryState::Idle);
            return Ok(());
        }

        // Step 3: Sidecar verification (or simple scoring if no sidecar)
        set_state(MemoryState::SidecarChecking {
            count: new_candidates.len(),
        });
        add_event(MemoryEventKind::SidecarStarted);

        let relevant = evaluate_candidates(session_id, &context, new_candidates).await;

        // Step 4: Format and store for main agent (one turn delayed)
        if !relevant.is_empty() {
            let ids: Vec<String> = relevant.iter().map(|e| e.id.clone()).collect();
            {
                let ss = self.session_state(session_id);
                for entry in &relevant {
                    ss.surfaced_memories.insert(entry.id.clone());
                }
            }

            if let Some(prompt) = format_relevant_prompt(&relevant, MAX_MEMORIES_PER_TURN) {
                let display_prompt =
                    format_relevant_display_prompt(&relevant, MAX_MEMORIES_PER_TURN);
                let count = relevant.len();

                pending::set_pending_memory_with_ids_and_display(
                    session_id,
                    prompt,
                    count,
                    ids,
                    display_prompt,
                );
                set_state(MemoryState::FoundRelevant { count });
            } else {
                set_state(MemoryState::Idle);
            }
        } else {
            set_state(MemoryState::Idle);
        }

        Ok(())
    }

    /// Extract memories from a context string (topic change or periodic).
    async fn extract_from_context(&mut self, session_id: &str, context: &str) {
        if !is_sidecar_enabled() {
            return;
        }

        if context.len() < 200 {
            return;
        }

        set_state(MemoryState::Extracting {
            reason: "incremental".to_string(),
        });
        add_event(MemoryEventKind::ExtractionStarted {
            reason: "incremental".to_string(),
        });

        let Some(sidecar) = get_memory_sidecar() else {
            set_state(MemoryState::Idle);
            return;
        };

        let manager = match self.ensure_manager().await {
            Ok(m) => m,
            Err(_) => {
                set_state(MemoryState::Idle);
                return;
            }
        };

        // Get existing memories for dedup context
        let existing: Vec<String> = manager
            .get_active_memories()
            .await
            .into_iter()
            .map(|e| e.content)
            .collect();

        let context_owned = context.to_string();
        let sidecar_ref = sidecar;

        let result = sidecar_ref
            .extract_memories(&context_owned, &existing)
            .await;

        match result {
            Ok(extracted) if !extracted.is_empty() => {
                // Batch-embed all extracted contents
                let contents: Vec<String> = extracted.iter().map(|m| m.content.clone()).collect();
                let embeddings = embed_batch(&contents).await;

                let mut stored_count = 0;
                for (i, mem) in extracted.into_iter().enumerate() {
                    let category: super::types::MemoryCategory =
                        mem.category.as_str().parse().unwrap_or_default();
                    let trust = match mem.trust.as_str() {
                        "high" => super::types::TrustLevel::High,
                        "low" => super::types::TrustLevel::Low,
                        _ => super::types::TrustLevel::Medium,
                    };

                    let mut entry = MemoryEntry::new(category, &mem.content)
                        .with_source(session_id)
                        .with_trust(trust);

                    if let Some(ref emb_list) = embeddings {
                        if let Some(emb) = emb_list.get(i) {
                            entry = entry.with_embedding(emb.clone());
                        }
                    }

                    manager.add_memory_no_save(entry).await;
                    stored_count += 1;
                }

                if stored_count > 0 {
                    if let Err(e) = manager.flush().await {
                        log::error!("MemoryAgent: extraction flush failed: {}", e);
                        add_event(MemoryEventKind::Error {
                            message: format!("Flush failed: {}", e),
                        });
                    } else {
                        add_event(MemoryEventKind::ExtractionComplete {
                            count: stored_count,
                        });
                    }
                }
            }
            Ok(_) => { /* no memories extracted */ }
            Err(e) => {
                log::debug!("[{}] Incremental extraction failed: {}", session_id, e);
                add_event(MemoryEventKind::Error { message: e });
            }
        }

        set_state(MemoryState::Idle);
    }
}

// ==================== Candidate Evaluation ====================

async fn evaluate_candidates(
    session_id: &str,
    context: &str,
    candidates: Vec<(MemoryEntry, f32)>,
) -> Vec<MemoryEntry> {
    if !is_sidecar_enabled() {
        // No sidecar: use simple similarity threshold
        return candidates
            .into_iter()
            .take(MAX_MEMORIES_PER_TURN)
            .map(|(entry, sim)| {
                log::debug!(
                    "[{}] Memory relevant (sim={:.2}): {}",
                    session_id,
                    sim,
                    &entry.content[..entry.content.len().min(40)]
                );
                entry
            })
            .collect();
    }

    let Some(sidecar) = get_memory_sidecar() else {
        return Vec::new();
    };

    let mut relevant = Vec::new();
    let taken = candidates.into_iter().take(MAX_MEMORIES_PER_TURN);

    // Check each candidate; sidecar truncates context/memory internally
    for (entry, sim) in taken {
        match sidecar.check_relevance(&entry.content, context).await {
            Ok(result) => {
                if result.relevant {
                    log::debug!(
                        "[{}] Memory relevant (sim={:.2}): {}",
                        session_id,
                        sim,
                        &entry.content[..entry.content.len().min(40)]
                    );
                    add_event(MemoryEventKind::SidecarRelevant {
                        memory_preview: entry.content[..entry.content.len().min(30)].to_string(),
                    });
                    relevant.push(entry);
                } else {
                    add_event(MemoryEventKind::SidecarNotRelevant);
                }
            }
            Err(e) => {
                log::debug!("[{}] Sidecar check failed: {}", session_id, e);
                add_event(MemoryEventKind::Error { message: e });
            }
        }

        if relevant.len() >= MAX_MEMORIES_PER_TURN {
            break;
        }
    }

    relevant
}

// ==================== Startup ====================

/// Get or create the global MemoryAgent handle.
pub async fn ensure_agent() -> MemoryAgentHandle {
    MEMORY_AGENT
        .get_or_init(|| async {
            let (tx, rx) = mpsc::channel(CONTEXT_CHANNEL_CAPACITY);
            let agent = MemoryAgent::new(rx);
            tokio::spawn(agent.run());
            MemoryAgentHandle { tx }
        })
        .await
        .clone()
}

/// Try to get the existing MemoryAgent handle without creating one.
pub fn try_get_agent() -> Option<MemoryAgentHandle> {
    MEMORY_AGENT.get().cloned()
}

// ==================== Embedding Helpers ====================

async fn embed_text(text: &str) -> Option<Vec<f32>> {
    let provider =
        crate::agent::tools::implementations::skills::embedding_provider::get_embedding_provider()?;
    let text = text.to_string();
    match tokio::task::spawn_blocking(move || provider.embed_text(&text)).await {
        Ok(Ok(emb)) => Some(emb),
        Ok(Err(e)) => {
            log::debug!("Embedding failed: {}", e);
            None
        }
        Err(e) => {
            log::debug!("Embedding spawn failed: {}", e);
            None
        }
    }
}

async fn embed_batch(texts: &[String]) -> Option<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Some(Vec::new());
    }
    let provider =
        crate::agent::tools::implementations::skills::embedding_provider::get_embedding_provider()?;
    let texts = texts.to_vec();
    match tokio::task::spawn_blocking(move || provider.embed_batch(&texts)).await {
        Ok(Ok(embs)) => Some(embs),
        Ok(Err(e)) => {
            log::debug!("Batch embedding failed: {}", e);
            None
        }
        Err(e) => {
            log::debug!("Batch embedding spawn failed: {}", e);
            None
        }
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    super::manager::cosine_similarity(a, b)
}

pub(super) fn context_signature(context: &str) -> String {
    context
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join("\n")
}

fn relevance_context_signature(context: &str) -> String {
    context_signature(context)
}
