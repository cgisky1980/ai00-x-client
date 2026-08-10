//! Hybrid skill search: vector similarity + keyword matching → RRF fusion
//!
//! Dynamically-weighted Reciprocal Rank Fusion (RRF):
//! weights are computed per-query from text characteristics (specificity,
//! length, term entropy), not from a hardcoded intent lookup table.
//! The intent provides only a base bias — the final weights are a blend.
//!
//! Reference: "Hybrid Retrieval for Hallucination Mitigation in LLMs"
//! (arXiv 2504.05324)

use super::embedding_provider::get_embedding_provider;
use super::keyword_index::SkillKeywordIndex;
use super::rrf::{merge_weighted_rankings, WeightedRanking};
use super::vector_index::SkillVectorIndex;

const RRF_K: f32 = 60.0;
const BASE_VECTOR_WEIGHT: f32 = 0.50;
const BASE_KEYWORD_WEIGHT: f32 = 0.50;
const MIN_WEIGHT: f32 = 0.15;
const MAX_WEIGHT: f32 = 0.80;

#[derive(Debug, Clone)]
pub struct SkillMatch {
    pub name: String,
    pub score: f32,
}

#[derive(Debug)]
pub enum QueryIntent {
    TaskOriented,
    CapabilityAsk,
    Exploratory,
}

pub struct IntentWeights {
    pub vector: f32,
    pub keyword: f32,
}

impl QueryIntent {
    pub fn detect(query: &str) -> Self {
        let trimmed = query.trim();
        let alphanum_count = trimmed.chars().filter(|c| c.is_alphanumeric()).count();

        let ends_with_question = trimmed.ends_with('?') || trimmed.ends_with('\u{ff1f}');

        let has_question =
            trimmed.contains('?') || trimmed.contains('\u{ff1f}') || trimmed.contains('\u{061f}');

        if (ends_with_question || has_question) && alphanum_count <= 30 {
            return Self::CapabilityAsk;
        }

        if alphanum_count <= 4 {
            return Self::Exploratory;
        }

        Self::TaskOriented
    }

    fn base_bias(&self) -> (f32, f32) {
        match self {
            Self::TaskOriented => (0.10, -0.10),
            Self::CapabilityAsk => (-0.15, 0.15),
            Self::Exploratory => (0.0, 0.0),
        }
    }
}

fn query_specificity(query: &str) -> f32 {
    let alphanums: String = query.chars().filter(|c| c.is_alphanumeric()).collect();

    let total = alphanums.len() as f32;
    if total == 0.0 {
        return 0.0;
    }

    let length_factor = (total / 60.0).min(1.0);

    let unique_ratio = {
        let mut chars: Vec<char> = alphanums.chars().collect();
        chars.sort();
        chars.dedup();
        chars.len() as f32 / total
    };

    let cjk_count = alphanums
        .chars()
        .filter(|c| {
            let u = *c as u32;
            (0x4E00..=0x9FFF).contains(&u)
                || (0x3400..=0x4DBF).contains(&u)
                || (0x20000..=0x2A6DF).contains(&u)
                || (0x3040..=0x30FF).contains(&u)
                || (0xAC00..=0xD7AF).contains(&u)
        })
        .count() as f32;

    let cjk_density = if total > 0.0 {
        (cjk_count / total).min(1.0)
    } else {
        0.0
    };

    let specificity = length_factor * 0.5 + unique_ratio * 0.2 + cjk_density * 0.3;
    specificity.clamp(0.0, 1.0)
}

fn compute_dynamic_weights(query: &str, intent: &QueryIntent) -> IntentWeights {
    let specificity = query_specificity(query);

    let (vec_bias, kw_bias) = intent.base_bias();

    let base_vec = BASE_VECTOR_WEIGHT - specificity * 0.35;
    let base_kw = BASE_KEYWORD_WEIGHT + specificity * 0.35;

    let vector = (base_vec + vec_bias).clamp(MIN_WEIGHT, MAX_WEIGHT);
    let keyword = (base_kw + kw_bias).clamp(MIN_WEIGHT, MAX_WEIGHT);

    IntentWeights { vector, keyword }
}

pub struct HybridSkillSearch {
    pub vector_index: SkillVectorIndex,
    pub keyword_index: SkillKeywordIndex,
}

impl Default for HybridSkillSearch {
    fn default() -> Self {
        Self::new()
    }
}

impl HybridSkillSearch {
    pub fn new() -> Self {
        Self {
            vector_index: SkillVectorIndex::new(),
            keyword_index: SkillKeywordIndex::new(),
        }
    }

    pub fn build_keyword_index(&mut self, skills: &[(String, String, Vec<String>, String)]) {
        self.keyword_index.build(skills);
    }

    pub async fn build_vector_index(&mut self, skills: &[(String, String, Vec<String>, String)]) {
        if let Some(provider) = get_embedding_provider() {
            self.vector_index.build(skills, provider.as_ref()).await;
        }
    }

    pub async fn search(&self, query: &str, top_k: usize) -> Vec<SkillMatch> {
        let intent = QueryIntent::detect(query);
        let weights = compute_dynamic_weights(query, &intent);

        let vector_rankings: Vec<(String, f32)> = if self.vector_index.is_ready() {
            if let Some(provider) = get_embedding_provider() {
                if let Ok(emb) = provider.embed_text(query) {
                    self.vector_index.search(&emb)
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        let keyword_rankings = self.keyword_index.search(query);

        let rankings = vec![
            WeightedRanking {
                items: &vector_rankings,
                weight: weights.vector,
            },
            WeightedRanking {
                items: &keyword_rankings,
                weight: weights.keyword,
            },
        ];

        let mut fused = merge_weighted_rankings(&rankings, RRF_K);

        for (name, score) in &mut fused {
            let lower = query.to_lowercase();
            if lower.contains(&name.to_lowercase()) {
                *score += 0.10;
            }
        }

        fused.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let k = top_k.min(fused.len());
        fused[..k]
            .iter()
            .map(|(name, score)| SkillMatch {
                name: name.clone(),
                score: *score,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn question_mark_detects_capability() {
        assert!(matches!(
            QueryIntent::detect("can you handle PDF?"),
            QueryIntent::CapabilityAsk
        ));
        assert!(matches!(
            QueryIntent::detect("PDF\u{ff1f}"),
            QueryIntent::CapabilityAsk
        ));
        assert!(matches!(
            QueryIntent::detect("\u{062a}\u{0633}\u{062a}\u{0637}\u{064a}\u{0639} PDF\u{061f}"),
            QueryIntent::CapabilityAsk
        ));
    }

    #[test]
    fn short_query_is_exploratory() {
        assert!(matches!(
            QueryIntent::detect("list"),
            QueryIntent::Exploratory
        ));
        assert!(matches!(
            QueryIntent::detect("\u{5217}\u{51fa}"),
            QueryIntent::Exploratory
        ));
    }

    #[test]
    fn long_descriptive_is_task() {
        assert!(matches!(
            QueryIntent::detect("extract all text from this PDF report and convert to Excel"),
            QueryIntent::TaskOriented
        ));
    }

    #[test]
    fn longer_specific_query_boosts_keyword() {
        let w = compute_dynamic_weights(
            "extract text and tables from PDF export document",
            &QueryIntent::TaskOriented,
        );
        assert!(
            w.keyword > BASE_KEYWORD_WEIGHT,
            "specific query → keyword up"
        );
        assert!(
            w.vector < BASE_VECTOR_WEIGHT,
            "specific query → vector down"
        );
    }

    #[test]
    fn short_vague_query_boosts_vector_relatively() {
        let w_specific = compute_dynamic_weights(
            "extract text and tables from PDF",
            &QueryIntent::TaskOriented,
        );
        let w_vague = compute_dynamic_weights("hi help me", &QueryIntent::TaskOriented);
        assert!(
            w_vague.vector > w_specific.vector,
            "vague query → more vector weight"
        );
        assert!(
            w_specific.keyword > w_vague.keyword,
            "specific query → more keyword weight"
        );
    }

    #[test]
    fn capability_ask_keep_keyword_lead() {
        let w = compute_dynamic_weights("can you handle PDF files", &QueryIntent::CapabilityAsk);
        assert!(
            w.keyword > w.vector,
            "capability ask → keyword still dominates"
        );
    }

    #[test]
    fn exploratory_without_domain_terms_nears_equal() {
        let w = compute_dynamic_weights("what can help", &QueryIntent::Exploratory);
        let diff = (w.vector - w.keyword).abs();
        assert!(
            diff < 0.20,
            "vague exploratory → near equal, got vec={} kw={}",
            w.vector,
            w.keyword
        );
    }

    #[test]
    fn all_weights_in_bounds() {
        let cases = [
            ("a", QueryIntent::TaskOriented),
            (
                "extract text from complex PDF documents with tables",
                QueryIntent::TaskOriented,
            ),
            ("can you help me", QueryIntent::CapabilityAsk),
            ("list all", QueryIntent::Exploratory),
        ];
        for (q, i) in cases {
            let w = compute_dynamic_weights(q, &i);
            assert!(
                w.vector >= MIN_WEIGHT && w.vector <= MAX_WEIGHT,
                "vector out of bounds: {}",
                w.vector
            );
            assert!(
                w.keyword >= MIN_WEIGHT && w.keyword <= MAX_WEIGHT,
                "keyword out of bounds: {}",
                w.keyword
            );
        }
    }
}
