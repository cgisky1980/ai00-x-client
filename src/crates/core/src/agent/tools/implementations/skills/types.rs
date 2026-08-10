//! Skill type definitions

use crate::util::errors::{Ai00XError, Ai00XResult};
use crate::util::front_matter_markdown::FrontMatterMarkdown;
use serde::{Deserialize, Serialize};

/// Skill location
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillLocation {
    /// User-level (global)
    User,
    /// Project-level
    Project,
}

impl SkillLocation {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkillLocation::User => "user",
            SkillLocation::Project => "project",
        }
    }
}

/// Complete skill information (for API return)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    /// Runtime-unique identifier derived from source slot + directory name.
    pub key: String,
    /// Skill name (read from SKILL.md, used by the model to invoke the skill)
    pub name: String,
    /// Description (read from SKILL.md)
    pub description: String,
    /// Skill folder path
    pub path: String,
    /// Level (project-level/user-level)
    pub level: SkillLocation,
    /// Source slot that discovered this skill.
    pub source_slot: String,
    /// Directory name under the slot's `skills/` root.
    pub dir_name: String,
    /// Whether this skill is bundled with Ai00-X as a built-in skill.
    #[serde(default)]
    pub is_builtin: bool,
    /// Optional logical group for built-in skills.
    #[serde(default)]
    pub group_key: Option<String>,
    /// Optional keywords for hybrid search matching.
    #[serde(default)]
    pub keywords: Vec<String>,
    /// Optional "when to use" trigger conditions.
    #[serde(default)]
    pub when_to_use: String,
}

impl SkillInfo {
    pub fn to_index_input(&self) -> (String, String, Vec<String>, String) {
        (
            self.name.clone(),
            self.description.clone(),
            self.keywords.clone(),
            self.when_to_use.clone(),
        )
    }

    pub fn needs_enhancement(&self) -> bool {
        self.keywords.is_empty() || self.when_to_use.is_empty()
    }

    /// Convert to XML description (for tool description)
    pub fn to_xml_desc(&self) -> String {
        format!(
            r#"<skill>
<name>
{}
</name>
<description>
{}
</description>
<location>
{}
</location>
</skill>
"#,
            self.name, self.description, self.path
        )
    }
}

/// Skill data (contains content, for execution)
#[derive(Debug, Clone)]
pub struct SkillData {
    pub key: String,
    pub name: String,
    pub description: String,
    pub content: String,
    pub location: SkillLocation,
    pub path: String,
    pub source_slot: String,
    pub dir_name: String,
    pub keywords: Vec<String>,
    pub when_to_use: String,
}

impl SkillData {
    /// Parse Skill from SKILL.md file content
    pub fn from_markdown(
        path: String,
        content: &str,
        location: SkillLocation,
        with_content: bool,
    ) -> Ai00XResult<Self> {
        let (metadata, body) = FrontMatterMarkdown::load_str(content)
            .map_err(|e| Ai00XError::tool(format!("Invalid SKILL.md format: {}", e)))?;

        let name = metadata
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                Ai00XError::tool("Missing required field 'name' in SKILL.md".to_string())
            })?;

        let description = metadata
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                Ai00XError::tool("Missing required field 'description' in SKILL.md".to_string())
            })?;

        let when_to_use: String = metadata
            .get("when_to_use")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();

        let mut keywords: Vec<String> = metadata
            .get("keywords")
            .and_then(|v| match v {
                serde_yaml::Value::String(s) => Some(
                    s.split(',')
                        .map(|k| k.trim().to_string())
                        .filter(|k| !k.is_empty())
                        .collect(),
                ),
                serde_yaml::Value::Sequence(seq) => Some(
                    seq.iter()
                        .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                        .filter(|k| !k.is_empty())
                        .collect(),
                ),
                _ => None,
            })
            .unwrap_or_default();

        if keywords.is_empty() {
            keywords = auto_extract_keywords(&name, &description);
        }

        let skill_content = if with_content { body } else { String::new() };
        let dir_name = std::path::Path::new(&path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| Ai00XError::tool(format!("Invalid skill path: {}", path)))?
            .to_string();

        Ok(SkillData {
            key: String::new(),
            name,
            description,
            content: skill_content,
            location,
            path,
            source_slot: String::new(),
            dir_name,
            keywords,
            when_to_use,
        })
    }
}

fn auto_extract_keywords(name: &str, description: &str) -> Vec<String> {
    let stopwords: std::collections::HashSet<&str> = [
        "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
        "from", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do",
        "does", "did", "will", "would", "could", "should", "may", "might", "can", "shall", "you",
        "your", "we", "our", "they", "their", "it", "its", "this", "that", "these", "those", "not",
        "no", "if", "then", "else", "when", "where", "how", "what", "which", "who", "whom", "use",
        "using", "like", "just", "also", "any", "into", "only", "more", "some", "such", "than",
        "skill", "skills", "file", "files", "want", "need",
    ]
    .iter()
    .copied()
    .collect();

    let text = format!("{} {}", name, description);
    let mut freq: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for word in text.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
        let word = word.trim();
        if word.len() < 3 || stopwords.contains(word) {
            continue;
        }
        *freq.entry(word.to_string()).or_insert(0) += 1;
    }

    let mut pairs: Vec<_> = freq.into_iter().collect();
    pairs.sort_by_key(|b| std::cmp::Reverse(b.1));
    pairs.truncate(10);
    pairs.into_iter().map(|(w, _)| w).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_extract_from_pdf_description() {
        let kw = auto_extract_keywords(
            "pdf",
            "Extract text and tables from PDF documents, merge and split files",
        );
        assert!(kw.contains(&"extract".to_string()));
        assert!(kw.contains(&"text".to_string()));
        assert!(kw.contains(&"tables".to_string()));
        assert!(kw.contains(&"pdf".to_string()));
        assert!(kw.contains(&"documents".to_string()));
        assert!(kw.contains(&"merge".to_string()));
        assert!(kw.contains(&"split".to_string()));
    }

    #[test]
    fn auto_extract_empty_for_short_desc() {
        let kw = auto_extract_keywords("a", "b");
        assert!(kw.is_empty());
    }

    #[test]
    fn keyword_parsing_fallback() {
        let data = SkillData::from_markdown(
            "/test-skill".to_string(),
            "---\nname: example\ndescription: Extract text from PDF and convert to Excel\n---\n# Body\n",
            SkillLocation::User,
            false,
        )
        .unwrap();

        assert_eq!(data.name, "example");
        assert!(
            !data.keywords.is_empty(),
            "auto-extracted keywords should not be empty"
        );
        assert!(data.keywords.contains(&"extract".to_string()));
        assert!(data.keywords.contains(&"text".to_string()));
    }
}
