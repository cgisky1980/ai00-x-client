//! AI rules type definitions
//!
//! Rule type definitions based on the `.mdc` file format.

use crate::util::front_matter_markdown::FrontMatterMarkdown;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::path::PathBuf;

/// Rule apply type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleApplyType {
    /// Always apply: `alwaysApply=true`, no `description` and no `globs`.
    AlwaysApply,

    /// Apply intelligently: `alwaysApply=false`, has `description`, no `globs`.
    ApplyIntelligently,

    /// Apply to specific files: `alwaysApply=false`, has `globs`, no `description`.
    ApplyToSpecificFiles,

    /// Apply manually: `alwaysApply=false`, no `description` and no `globs`.
    ApplyManually,
}

impl RuleApplyType {
    /// Determines the rule apply type from the frontmatter fields.
    pub fn from_frontmatter(
        always_apply: bool,
        description: &Option<String>,
        globs: &Option<String>,
    ) -> Self {
        if always_apply {
            RuleApplyType::AlwaysApply
        } else if description.is_some() {
            RuleApplyType::ApplyIntelligently
        } else if globs.is_some() {
            RuleApplyType::ApplyToSpecificFiles
        } else {
            RuleApplyType::ApplyManually
        }
    }

    /// Returns the display name.
    pub fn display_name(&self) -> &'static str {
        match self {
            RuleApplyType::AlwaysApply => "Always Apply",
            RuleApplyType::ApplyIntelligently => "Apply Intelligently",
            RuleApplyType::ApplyToSpecificFiles => "Apply to Specific Files",
            RuleApplyType::ApplyManually => "Apply Manually",
        }
    }
}

/// MDC file frontmatter
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleMetadata {
    /// Rule description (used by `ApplyIntelligently`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Glob patterns (used by `ApplyToSpecificFiles`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub globs: Option<String>,

    /// Whether to always apply.
    #[serde(rename = "alwaysApply")]
    pub always_apply: bool,

    /// Whether enabled (defaults to `true`).
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

impl RuleMetadata {
    /// Creates frontmatter for `AlwaysApply`.
    pub fn always_apply() -> Self {
        Self {
            description: None,
            globs: None,
            always_apply: true,
            enabled: true,
        }
    }

    /// Creates frontmatter for `ApplyIntelligently`.
    pub fn apply_intelligently(description: String) -> Self {
        Self {
            description: Some(description),
            globs: None,
            always_apply: false,
            enabled: true,
        }
    }

    /// Creates frontmatter for `ApplyToSpecificFiles`.
    pub fn apply_to_specific_files(globs: String) -> Self {
        Self {
            description: None,
            globs: Some(globs),
            always_apply: false,
            enabled: true,
        }
    }

    /// Creates frontmatter for `ApplyManually`.
    pub fn apply_manually() -> Self {
        Self {
            description: None,
            globs: None,
            always_apply: false,
            enabled: true,
        }
    }

    /// Returns the rule apply type.
    pub fn apply_type(&self) -> RuleApplyType {
        RuleApplyType::from_frontmatter(self.always_apply, &self.description, &self.globs)
    }

    /// Creates `RuleMetadata` from `serde_yaml::Value`.
    pub fn from_value(value: &Value) -> Result<Self, String> {
        let description = value
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let globs = value
            .get("globs")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let always_apply = value
            .get("alwaysApply")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let enabled = value
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        Ok(Self {
            description,
            globs,
            always_apply,
            enabled,
        })
    }

    /// Converts to `serde_yaml::Value`.
    pub fn to_value(&self) -> Value {
        let mut map = serde_yaml::Mapping::new();

        if let Some(ref desc) = self.description {
            map.insert(
                Value::String("description".to_string()),
                Value::String(desc.clone()),
            );
        }

        if let Some(ref globs) = self.globs {
            map.insert(
                Value::String("globs".to_string()),
                Value::String(globs.clone()),
            );
        }

        map.insert(
            Value::String("alwaysApply".to_string()),
            Value::Bool(self.always_apply),
        );

        if !self.enabled {
            map.insert(
                Value::String("enabled".to_string()),
                Value::Bool(self.enabled),
            );
        }

        Value::Mapping(map)
    }
}

/// Rule level
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleLevel {
    /// User-level (global)
    User,
    /// Project-level (workspace)
    Project,
}

/// AI rule definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIRule {
    /// Rule name (file name without the `.mdc` extension).
    pub name: String,

    /// Rule level
    pub level: RuleLevel,

    /// Rule apply type
    pub apply_type: RuleApplyType,

    /// Rule description (used by `ApplyIntelligently`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Glob patterns (used by `ApplyToSpecificFiles`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub globs: Option<String>,

    /// Rule content
    pub content: String,

    /// Full path to the rule file
    pub file_path: PathBuf,

    /// Whether enabled
    pub enabled: bool,
}

impl AIRule {
    /// Parses a rule from MDC file content.
    pub fn from_mdc(
        name: String,
        level: RuleLevel,
        file_path: PathBuf,
        mdc_content: &str,
    ) -> Result<Self, String> {
        let (frontmatter, content) = parse_mdc_content(mdc_content)?;

        Ok(Self {
            name,
            level,
            apply_type: frontmatter.apply_type(),
            description: frontmatter.description,
            globs: frontmatter.globs,
            content,
            file_path,
            enabled: frontmatter.enabled,
        })
    }

    /// Converts to MDC file content.
    pub fn to_mdc(&self) -> String {
        let frontmatter = RuleMetadata {
            description: self.description.clone(),
            globs: self.globs.clone(),
            always_apply: self.apply_type == RuleApplyType::AlwaysApply,
            enabled: self.enabled,
        };

        format_mdc_content(&frontmatter, &self.content)
    }
}

/// Create rule request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRuleRequest {
    /// Rule name (will be used as the file name).
    pub name: String,

    /// Rule apply type
    pub apply_type: RuleApplyType,

    /// Rule description (used by `ApplyIntelligently`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Glob patterns (used by `ApplyToSpecificFiles`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub globs: Option<String>,

    /// Rule content
    pub content: String,

    /// Whether enabled (defaults to `true`).
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// Update rule request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateRuleRequest {
    /// New rule name (if renaming is needed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// Rule apply type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apply_type: Option<RuleApplyType>,

    /// Rule description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Glob patterns
    #[serde(skip_serializing_if = "Option::is_none")]
    pub globs: Option<String>,

    /// Rule content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,

    /// Whether enabled
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

/// Rule statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleStats {
    /// Total rule count
    pub total_rules: usize,

    /// Enabled rule count
    pub enabled_rules: usize,

    /// Disabled rule count
    pub disabled_rules: usize,

    /// Counts by apply type
    pub by_apply_type: std::collections::HashMap<String, usize>,
}

// ===== MDC parsing helpers =====

/// Parses MDC file content and returns the frontmatter and body.
/// Uses `FrontMatterMarkdown` for parsing.
pub fn parse_mdc_content(content: &str) -> Result<(RuleMetadata, String), String> {
    let (metadata, body) = FrontMatterMarkdown::load_str(content)?;

    let frontmatter = RuleMetadata::from_value(&metadata)?;

    Ok((frontmatter, body))
}

/// Formats MDC file content.
/// Uses the `FrontMatterMarkdown` format.
pub fn format_mdc_content(frontmatter: &RuleMetadata, content: &str) -> String {
    let metadata = frontmatter.to_value();
    let yaml_str =
        serde_yaml::to_string(&metadata).unwrap_or_else(|_| "alwaysApply: true\n".to_string());

    format!("---\n{}---\n\n{}", yaml_str, content.trim_start())
}

/// Returns the rule name from the file name (strip the `.mdc` extension).
pub fn rule_name_from_filename(filename: &str) -> String {
    filename.trim_end_matches(".mdc").to_string()
}

/// Builds a file name from the rule name.
pub fn filename_from_rule_name(name: &str) -> String {
    format!("{}.mdc", name)
}
