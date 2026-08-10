//! Weighted Reciprocal Rank Fusion (RRF)
//!
//! score[id] = Σ weight_i / (k + rank_i + 1)
//!
//! RRF naturally handles heterogeneous score scales (e.g. cosine similarity
//! vs raw TF counts) by only considering rank order, not raw magnitudes.

use std::collections::HashMap;

pub struct WeightedRanking<'a> {
    pub items: &'a [(String, f32)],
    pub weight: f32,
}

pub fn merge_weighted_rankings(rankings: &[WeightedRanking<'_>], rrf_k: f32) -> Vec<(String, f32)> {
    let mut scores: HashMap<String, f32> = HashMap::new();
    for ranking in rankings {
        for (rank, (id, _raw)) in ranking.items.iter().enumerate() {
            let contribution = ranking.weight / (rrf_k + rank as f32 + 1.0);
            *scores.entry(id.clone()).or_insert(0.0) += contribution;
        }
    }
    let mut result: Vec<_> = scores.into_iter().collect();
    result.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    result
}
