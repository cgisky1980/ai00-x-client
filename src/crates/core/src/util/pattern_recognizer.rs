use crate::service::config::types::GestureTemplateConfig;

#[derive(Debug, Clone)]
pub struct MatchResult {
    pub name: String,
    pub score: f64,
}

pub struct PatternRecognizer {
    templates: Vec<GestureTemplateConfig>,
}

impl PatternRecognizer {
    pub fn new() -> Self {
        Self {
            templates: Vec::new(),
        }
    }

    pub fn add_template(&mut self, template: GestureTemplateConfig) {
        self.templates.retain(|t| t.name != template.name);
        self.templates.push(template);
    }

    pub fn remove_template(&mut self, name: &str) {
        self.templates.retain(|t| t.name != name);
    }

    pub fn clear(&mut self) {
        self.templates.clear();
    }

    pub fn load_templates(&mut self, templates: Vec<GestureTemplateConfig>) {
        self.templates = templates;
    }

    pub fn templates(&self) -> &[GestureTemplateConfig] {
        &self.templates
    }

    pub fn recognize(&self, sequence: &[u32]) -> Option<MatchResult> {
        if sequence.len() < 2 {
            return None;
        }

        let mut best: Option<MatchResult> = None;

        for template in &self.templates {
            let score = self.compute_score(sequence, &template.sequence);
            if score <= 0.0 {
                continue;
            }

            if best.as_ref().is_none_or(|b| score > b.score) {
                best = Some(MatchResult {
                    name: template.name.clone(),
                    score,
                });
            }
        }

        best
    }

    fn compute_score(&self, input: &[u32], template: &[u32]) -> f64 {
        if input == template {
            return 1.0;
        }

        if input.len() == template.len() {
            let matching = input
                .iter()
                .zip(template.iter())
                .filter(|(a, b)| a == b)
                .count();
            let ratio = matching as f64 / input.len() as f64;
            if ratio >= 0.8 {
                return ratio;
            }
        }

        if self.is_subsequence(input, template) {
            let ratio =
                input.len().min(template.len()) as f64 / input.len().max(template.len()) as f64;
            return ratio * 0.7;
        }

        if self.is_subsequence(template, input) {
            let ratio =
                input.len().min(template.len()) as f64 / input.len().max(template.len()) as f64;
            return ratio * 0.6;
        }

        let lcs_len = self.longest_common_subsequence(input, template);
        if lcs_len >= 2 {
            let ratio = lcs_len as f64 / input.len().max(template.len()) as f64;
            if ratio >= 0.6 {
                return ratio * 0.5;
            }
        }

        0.0
    }

    fn is_subsequence(&self, sub: &[u32], full: &[u32]) -> bool {
        let mut sub_iter = sub.iter();
        let mut current = sub_iter.next();
        for item in full {
            if Some(item) == current {
                current = sub_iter.next();
            }
        }
        current.is_none()
    }

    fn longest_common_subsequence(&self, a: &[u32], b: &[u32]) -> usize {
        let m = a.len();
        let n = b.len();
        let mut prev = vec![0usize; n + 1];
        let mut curr = vec![0usize; n + 1];

        for i in 1..=m {
            curr[0] = 0;
            for j in 1..=n {
                if a[i - 1] == b[j - 1] {
                    curr[j] = prev[j - 1] + 1;
                } else {
                    curr[j] = prev[j].max(curr[j - 1]);
                }
            }
            std::mem::swap(&mut prev, &mut curr);
        }

        prev[n]
    }
}

impl Default for PatternRecognizer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exact_match() {
        let mut r = PatternRecognizer::new();
        r.load_templates(vec![GestureTemplateConfig {
            name: "L-shape".into(),
            description: "L shape".into(),
            grid_size: 5,
            sequence: vec![0, 3, 6, 7, 8],
            builtin: true,
        }]);
        let result = r.recognize(&[0, 3, 6, 7, 8]);
        assert!(result.is_some());
        let m = result.unwrap();
        assert_eq!(m.name, "L-shape");
        assert!((m.score - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_partial_match() {
        let mut r = PatternRecognizer::new();
        r.load_templates(vec![GestureTemplateConfig {
            name: "L-shape".into(),
            description: "L shape".into(),
            grid_size: 5,
            sequence: vec![0, 3, 6, 7, 8],
            builtin: true,
        }]);
        let result = r.recognize(&[0, 3, 6, 7]);
        assert!(result.is_some());
        assert!(result.unwrap().score < 1.0);
    }

    #[test]
    fn test_no_match() {
        let mut r = PatternRecognizer::new();
        r.load_templates(vec![GestureTemplateConfig {
            name: "L-shape".into(),
            description: "L shape".into(),
            grid_size: 5,
            sequence: vec![0, 3, 6, 7, 8],
            builtin: true,
        }]);
        let result = r.recognize(&[1, 2, 5, 4]);
        assert!(result.is_none());
    }

    #[test]
    fn test_too_short() {
        let r = PatternRecognizer::new();
        let result = r.recognize(&[0]);
        assert!(result.is_none());
    }

    #[test]
    fn test_lcs() {
        let r = PatternRecognizer::new();
        assert_eq!(
            r.longest_common_subsequence(&[0, 3, 6, 7, 8], &[0, 4, 8]),
            2
        );
        assert_eq!(r.longest_common_subsequence(&[1, 2, 3], &[4, 5, 6]), 0);
    }
}
