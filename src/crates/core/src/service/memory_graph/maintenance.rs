//! Background maintenance for the memory graph.
//!
//! Multi-tier maintenance tasks that run asynchronously:
//!
//! | Frequency | Task |
//! |-----------|------|
//! | Every retrieval | Boost verified / Decay rejected |
//! | Every 50 retrievals | Prune weak memories (confidence < 0.05 & strength <= 1) |
//! | Every 200 retrievals | Repair integrity: remove dangling edges |
//! | Every 500 retrievals | Global dedup: merge memories with similarity > 0.95 |

use super::manager::MemoryManager;
use crate::util::errors::Ai00XResult;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Counter for periodic maintenance triggers.
pub static MAINTENANCE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Try-locks to prevent concurrent execution of the same maintenance tier.
static PRUNE_LOCK: AtomicBool = AtomicBool::new(false);
static REPAIR_LOCK: AtomicBool = AtomicBool::new(false);
static DEDUP_LOCK: AtomicBool = AtomicBool::new(false);

/// Run minor maintenance tasks after a retrieval operation.
/// This is intentionally non-blocking by spawning.
pub fn spawn_retrieval_maintenance(
    manager: std::sync::Arc<MemoryManager>,
    verified_ids: Vec<String>,
    rejected_ids: Vec<String>,
) {
    tokio::spawn(async move {
        if let Err(e) = run_retrieval_maintenance(&manager, &verified_ids, &rejected_ids).await {
            log::debug!("memory maintenance: retrieval upkeep failed: {}", e);
        }
    });
}

async fn run_retrieval_maintenance(
    manager: &MemoryManager,
    verified_ids: &[String],
    rejected_ids: &[String],
) -> Ai00XResult<()> {
    // Phase 1: Read all entries to update
    let mut updates = Vec::new();
    for id in verified_ids {
        if let Some(mut entry) = manager.get_memory(id).await {
            entry.boost_confidence(0.05);
            updates.push(entry);
        }
    }
    for id in rejected_ids {
        if let Some(mut entry) = manager.get_memory(id).await {
            entry.decay_confidence(0.02);
            updates.push(entry);
        }
    }

    // Phase 2: Batch write all updates (multiple write locks, but flush only once)
    for entry in updates {
        manager.add_memory_no_save(entry).await;
    }

    let count = MAINTENANCE_COUNTER.fetch_add(1, Ordering::AcqRel) + 1;

    // Tier 1: Every 50 retrievals — prune weak memories
    if count.is_multiple_of(50)
        && PRUNE_LOCK
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_ok()
    {
        prune_weak_memories(manager).await;
        PRUNE_LOCK.store(false, Ordering::Release);
    }

    // Tier 2: Every 200 retrievals — repair graph integrity
    if count.is_multiple_of(200)
        && REPAIR_LOCK
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_ok()
    {
        repair_integrity(manager).await;
        REPAIR_LOCK.store(false, Ordering::Release);
    }

    // Tier 3: Every 500 retrievals — global dedup
    if count.is_multiple_of(500)
        && DEDUP_LOCK
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_ok()
    {
        global_dedup(manager).await;
        DEDUP_LOCK.store(false, Ordering::Release);
    }

    // Single flush after all batch operations
    manager.flush().await?;

    Ok(())
}

async fn prune_weak_memories(manager: &MemoryManager) {
    let memories = manager.get_active_memories().await;
    let mut pruned = 0usize;
    for entry in memories {
        if entry.strength <= 1 && entry.effective_confidence() < 0.05 {
            log::debug!("memory maintenance: pruning weak memory {}", entry.id);
            manager.remove_memory_no_save(&entry.id).await;
            pruned += 1;
        }
    }
    if pruned > 0 {
        log::debug!("memory maintenance: pruned {} weak memories", pruned);
    }
}

async fn repair_integrity(manager: &MemoryManager) {
    let all_entries = manager.get_all_memories().await;
    let active_ids: std::collections::HashSet<String> = all_entries
        .iter()
        .filter(|e| e.active)
        .map(|e| e.id.clone())
        .collect();

    let mut repaired = 0usize;

    for mut entry in all_entries {
        if !entry.active {
            if let Some(ref superseder) = entry.superseded_by {
                if !active_ids.contains(superseder) {
                    entry.superseded_by = None;
                    entry.active = true;
                    manager.add_memory_no_save(entry).await;
                    repaired += 1;
                }
            }
        }
    }

    if repaired > 0 {
        log::debug!(
            "memory maintenance: repaired {} dangling supersede references",
            repaired
        );
    }
    // Tag count drift is prevented by graph.rs add_memory's self.contains_key → remove_memory fix
}

async fn global_dedup(manager: &MemoryManager) {
    let memories = manager.get_active_memories().await;
    if memories.len() < 2 {
        return;
    }

    let mut merged = 0usize;
    let with_emb: Vec<_> = memories.iter().filter(|e| e.embedding.is_some()).collect();

    let mut to_merge: Vec<(String, String)> = Vec::new();
    let threshold: f32 = 0.95;

    for i in 0..with_emb.len() {
        for j in (i + 1)..with_emb.len() {
            let (emb_a, emb_b) = match (&with_emb[i].embedding, &with_emb[j].embedding) {
                (Some(a), Some(b)) => (a, b),
                _ => continue,
            };
            let sim = super::manager::cosine_similarity(emb_a, emb_b);
            if sim >= threshold {
                if with_emb[i].strength >= with_emb[j].strength {
                    to_merge.push((with_emb[i].id.clone(), with_emb[j].id.clone()));
                } else {
                    to_merge.push((with_emb[j].id.clone(), with_emb[i].id.clone()));
                }
            }
        }
    }

    // Prevent cascading supersede: skip if keeper itself is already superseded
    let superseded_ids: std::collections::HashSet<String> = memories
        .iter()
        .filter(|e| !e.active && e.superseded_by.is_some())
        .map(|e| e.id.clone())
        .collect();

    for (keeper_id, stale_id) in to_merge {
        if superseded_ids.contains(&keeper_id) {
            continue;
        }
        if let Some(mut keeper) = manager.get_memory(&keeper_id).await {
            keeper.reinforce("global-dedup");
            keeper.superseded_by = None;
            manager.add_memory_no_save(keeper).await;
        }
        if let Some(mut stale) = manager.get_memory(&stale_id).await {
            stale.active = false;
            stale.superseded_by = Some(keeper_id.clone());
            manager.add_memory_no_save(stale).await;
            merged += 1;
        }
        log::debug!(
            "memory maintenance: merged duplicate {} -> {}",
            stale_id,
            keeper_id
        );
    }

    if merged > 0 {
        log::debug!("memory maintenance: merged {} duplicate pairs", merged);
    }
}
