//! Keyword inverted index for skill matching
//!
//! Builds an inverted index from skill name, description, and keywords.
//! Uses weighted TF scoring:
//!   name × 3.0, keywords × 2.0, description × 1.0

use std::collections::{HashMap, HashSet};

pub struct SkillKeywordIndex {
    inverted: HashMap<String, Vec<(String, f32)>>,
    skills: HashMap<String, (String, String, Vec<String>)>,
    stopwords: HashSet<String>,
}

impl Default for SkillKeywordIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillKeywordIndex {
    pub fn new() -> Self {
        let stopwords: HashSet<String> = [
            "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
            "by", "from", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
            "do", "does", "did", "will", "would", "could", "should", "may", "might", "can",
            "shall", "you", "your", "we", "our", "they", "their", "it", "its", "this", "that",
            "these", "those", "not", "no", "if", "then", "else", "when", "where", "how", "what",
            "which", "who", "whom", "help", "me", "need", "want", "get", "make", "use", "using",
            "like", "just",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        Self {
            inverted: HashMap::new(),
            skills: HashMap::new(),
            stopwords,
        }
    }

    pub fn build(&mut self, skills: &[(String, String, Vec<String>, String)]) {
        self.inverted.clear();
        self.skills.clear();

        for (name, desc, keywords, when_to_use) in skills {
            self.skills
                .insert(name.clone(), (name.clone(), desc.clone(), keywords.clone()));

            let mut tokens: HashMap<String, f32> = HashMap::new();

            for word in tokenize(name) {
                *tokens.entry(word).or_insert(0.0) += 3.0;
            }
            for word in tokenize(when_to_use) {
                *tokens.entry(word).or_insert(0.0) += 2.0;
            }
            for kw in keywords {
                for word in tokenize(kw) {
                    *tokens.entry(word).or_insert(0.0) += 1.5;
                }
            }
            for word in tokenize(desc) {
                *tokens.entry(word).or_insert(0.0) += 1.0;
            }

            for (word, weight) in tokens {
                if self.stopwords.contains(&word) {
                    continue;
                }
                self.inverted
                    .entry(word)
                    .or_default()
                    .push((name.clone(), weight));
            }
        }
    }

    pub fn search(&self, query: &str) -> Vec<(String, f32)> {
        let mut scores: HashMap<String, f32> = HashMap::new();

        let query_tokens: Vec<String> = tokenize(query)
            .into_iter()
            .filter(|w| !self.stopwords.contains(w))
            .collect();

        let num_skills = self.skills.len().max(1) as f32;

        for token in &query_tokens {
            if let Some(postings) = self.inverted.get(token) {
                let doc_count = postings.len() as f32;
                let idf = (num_skills / (doc_count + 1.0)).ln() + 1.0;

                for (name, weight) in postings {
                    *scores.entry(name.clone()).or_insert(0.0) += weight * idf;
                }
            }
        }

        let mut results: Vec<_> = scores.into_iter().collect();
        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        results
    }
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.len() >= 2)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_filters_short_and_punctuation() {
        let tokens = tokenize("Hello, World! A");
        assert_eq!(tokens, vec!["hello", "world"]);
    }

    #[test]
    fn builds_index_and_searches() {
        let skills = vec![
            (
                "pdf".to_string(),
                "Handle PDF files".to_string(),
                vec!["export".to_string()],
                String::new(),
            ),
            (
                "xlsx".to_string(),
                "Handle Excel spreadsheets".to_string(),
                vec!["csv".to_string()],
                String::new(),
            ),
        ];
        let mut idx = SkillKeywordIndex::new();
        idx.build(&skills);

        let results = idx.search("pdf export");
        assert!(!results.is_empty());
        let top = &results[0];
        assert_eq!(top.0, "pdf");
        assert!(top.1 > 0.0);
    }
}
