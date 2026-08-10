//! In-memory vector index for skill matching
//!
//! Stores pre-computed embeddings for all skills and performs
//! cosine similarity search against a query embedding.

use super::embedding_provider::EmbeddingProvider;
use std::collections::HashMap;

pub struct SkillVectorIndex {
    name_to_row: HashMap<String, usize>,
    matrix: Vec<f32>,
    dim: usize,
    initialized: bool,
}

impl Default for SkillVectorIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillVectorIndex {
    pub fn new() -> Self {
        Self {
            name_to_row: HashMap::new(),
            matrix: Vec::new(),
            dim: 0,
            initialized: false,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.initialized
    }

    pub async fn build(
        &mut self,
        skills: &[(String, String, Vec<String>, String)],
        provider: &dyn EmbeddingProvider,
    ) {
        self.dim = provider.dimension();
        let n = skills.len();
        self.matrix = vec![0.0; n * self.dim];
        self.name_to_row.clear();

        let texts: Vec<String> = skills
            .iter()
            .map(|(name, desc, keywords, when_to_use)| {
                let kw = keywords.join(", ");
                format!(
                    "{}: {}\nKeywords: {}\nWhen to use: {}",
                    name, desc, kw, when_to_use
                )
            })
            .collect();

        if let Ok(embeddings) = provider.embed_batch(&texts) {
            for (i, emb) in embeddings.iter().enumerate() {
                if emb.len() == self.dim {
                    let offset = i * self.dim;
                    self.matrix[offset..offset + self.dim].copy_from_slice(emb);
                    self.name_to_row.insert(skills[i].0.clone(), i);
                }
            }
            self.initialized = !self.name_to_row.is_empty();
        }
    }

    fn dot_product(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    fn l2_norm(v: &[f32]) -> f32 {
        v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-10)
    }

    pub fn search(&self, query_emb: &[f32]) -> Vec<(String, f32)> {
        let mut results: Vec<(String, f32)> = Vec::with_capacity(self.name_to_row.len());

        let query_norm = Self::l2_norm(query_emb);

        for (name, &row) in &self.name_to_row {
            let offset = row * self.dim;
            let emb = &self.matrix[offset..offset + self.dim];
            let dot = Self::dot_product(emb, query_emb);
            let sim = dot / (Self::l2_norm(emb) * query_norm);
            results.push((name.clone(), sim));
        }

        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        results
    }
}
