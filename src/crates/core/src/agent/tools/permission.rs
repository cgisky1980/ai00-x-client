use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum PermissionLevel {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl fmt::Display for PermissionLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PermissionLevel::ReadOnly => write!(f, "ReadOnly"),
            PermissionLevel::WorkspaceWrite => write!(f, "WorkspaceWrite"),
            PermissionLevel::DangerFullAccess => write!(f, "DangerFullAccess"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PermissionRuleMatcher {
    Command(String),
    Path(String),
    ToolName(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRule {
    pub raw: String,
    pub matcher: PermissionRuleMatcher,
}

impl PermissionRule {
    pub fn command(pattern: impl Into<String>) -> Self {
        let raw = pattern.into();
        Self {
            raw: raw.clone(),
            matcher: PermissionRuleMatcher::Command(raw),
        }
    }

    pub fn path(pattern: impl Into<String>) -> Self {
        let raw = pattern.into();
        Self {
            raw: raw.clone(),
            matcher: PermissionRuleMatcher::Path(raw),
        }
    }

    pub fn tool_name(name: impl Into<String>) -> Self {
        let raw = name.into();
        Self {
            raw: raw.clone(),
            matcher: PermissionRuleMatcher::ToolName(raw),
        }
    }

    pub fn matches(&self, subject: &str) -> bool {
        match &self.matcher {
            PermissionRuleMatcher::Command(pattern) => glob_match(subject, pattern),
            PermissionRuleMatcher::Path(pattern) => glob_match(subject, pattern),
            PermissionRuleMatcher::ToolName(name) => subject == name,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionOutcome {
    Allow,
    Deny { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionPolicy {
    pub active_mode: PermissionLevel,
    pub tool_requirements: BTreeMap<String, PermissionLevel>,
    pub deny_rules: Vec<PermissionRule>,
    pub allow_rules: Vec<PermissionRule>,
    pub ask_rules: Vec<PermissionRule>,
}

impl Default for PermissionPolicy {
    fn default() -> Self {
        let mut tool_requirements = BTreeMap::new();
        tool_requirements.insert("Read".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("Glob".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("Grep".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("LS".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("WebFetch".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("WebSearch".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("GetFileDiff".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("SessionHistory".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("Log".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("Skill".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("ListMCPResources".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("ReadMCPResource".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("ListMCPPrompts".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("GetMCPPrompt".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("MermaidInteractive".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("GenerativeUI".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("Playbook".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("submit_code_review".to_string(), PermissionLevel::ReadOnly);
        // Wallpaper tools — list is readonly
        tool_requirements.insert("ListMyWallpapers".to_string(), PermissionLevel::ReadOnly);
        tool_requirements.insert("Write".to_string(), PermissionLevel::WorkspaceWrite);
        tool_requirements.insert("Edit".to_string(), PermissionLevel::WorkspaceWrite);
        tool_requirements.insert("Delete".to_string(), PermissionLevel::WorkspaceWrite);
        tool_requirements.insert("Bash".to_string(), PermissionLevel::WorkspaceWrite);
        tool_requirements.insert("TodoWrite".to_string(), PermissionLevel::WorkspaceWrite);
        tool_requirements.insert("CreatePlan".to_string(), PermissionLevel::WorkspaceWrite);
        tool_requirements.insert("Task".to_string(), PermissionLevel::WorkspaceWrite);
        tool_requirements.insert(
            "AskUserQuestion".to_string(),
            PermissionLevel::WorkspaceWrite,
        );

        Self {
            active_mode: PermissionLevel::WorkspaceWrite,
            tool_requirements,
            deny_rules: Vec::new(),
            allow_rules: Vec::new(),
            ask_rules: Vec::new(),
        }
    }
}

impl PermissionPolicy {
    pub fn new(active_mode: PermissionLevel) -> Self {
        Self {
            active_mode,
            ..Self::default()
        }
    }

    pub fn with_deny_rule(mut self, rule: PermissionRule) -> Self {
        self.deny_rules.push(rule);
        self
    }

    pub fn with_allow_rule(mut self, rule: PermissionRule) -> Self {
        self.allow_rules.push(rule);
        self
    }

    pub fn with_ask_rule(mut self, rule: PermissionRule) -> Self {
        self.ask_rules.push(rule);
        self
    }

    pub fn with_tool_requirement(
        mut self,
        tool: impl Into<String>,
        level: PermissionLevel,
    ) -> Self {
        self.tool_requirements.insert(tool.into(), level);
        self
    }

    pub fn authorize(&self, tool_name: &str, input: &Value) -> PermissionOutcome {
        let subject = extract_permission_subject(tool_name, input);

        for rule in &self.deny_rules {
            if rule.matches(&subject) {
                return PermissionOutcome::Deny {
                    reason: format!("denied by rule: {}", rule.raw),
                };
            }
        }

        for rule in &self.allow_rules {
            if rule.matches(&subject) {
                return PermissionOutcome::Allow;
            }
        }

        let required = self
            .tool_requirements
            .get(tool_name)
            .copied()
            .unwrap_or(PermissionLevel::DangerFullAccess);

        if self.active_mode >= required {
            return PermissionOutcome::Allow;
        }

        PermissionOutcome::Deny {
            reason: format!(
                "requires {} but active mode is {}",
                required, self.active_mode
            ),
        }
    }
}

pub fn extract_permission_subject(tool_name: &str, input: &Value) -> String {
    match tool_name {
        "bash" => input
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "read_file" | "write_file" | "edit_file" | "delete_file" => input
            .get("path")
            .or_else(|| input.get("file_path"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => tool_name.to_string(),
    }
}

fn glob_match(text: &str, pattern: &str) -> bool {
    if pattern == "*" || pattern == "**" {
        return true;
    }
    if let Some(rest) = pattern.strip_prefix("*.") {
        return text.ends_with(rest) || text.ends_with(&format!(".{}", rest));
    }
    if let Some(rest) = pattern.strip_suffix("/*") {
        return text.starts_with(rest) || text.starts_with(&format!("{}/", rest));
    }
    if let Some(rest) = pattern.strip_prefix("*") {
        return text.ends_with(rest);
    }
    if let Some(rest) = pattern.strip_suffix("*") {
        return text.starts_with(rest);
    }
    text == pattern
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_permission_level_ordering() {
        assert!(PermissionLevel::ReadOnly < PermissionLevel::WorkspaceWrite);
        assert!(PermissionLevel::WorkspaceWrite < PermissionLevel::DangerFullAccess);
        assert!(PermissionLevel::ReadOnly < PermissionLevel::DangerFullAccess);
    }

    #[test]
    fn test_permission_level_display() {
        assert_eq!(format!("{}", PermissionLevel::ReadOnly), "ReadOnly");
        assert_eq!(
            format!("{}", PermissionLevel::WorkspaceWrite),
            "WorkspaceWrite"
        );
        assert_eq!(
            format!("{}", PermissionLevel::DangerFullAccess),
            "DangerFullAccess"
        );
    }

    #[test]
    fn test_deny_rule_takes_priority() {
        let policy = PermissionPolicy::new(PermissionLevel::DangerFullAccess)
            .with_deny_rule(PermissionRule::command("rm -rf*"));

        let input = serde_json::json!({"command": "rm -rf /"});
        let result = policy.authorize("bash", &input);
        assert!(matches!(result, PermissionOutcome::Deny { .. }));
    }

    #[test]
    fn test_allow_rule_overrides_mode() {
        let policy = PermissionPolicy::new(PermissionLevel::ReadOnly)
            .with_allow_rule(PermissionRule::tool_name("Bash"));

        let input = serde_json::json!({"command": "ls"});
        let result = policy.authorize("Bash", &input);
        assert!(matches!(result, PermissionOutcome::Allow));
    }

    #[test]
    fn test_mode_insufficient_denies() {
        let policy = PermissionPolicy::new(PermissionLevel::ReadOnly);
        let input = serde_json::json!({"path": "/tmp/test.txt"});
        let result = policy.authorize("Write", &input);
        assert!(matches!(result, PermissionOutcome::Deny { .. }));
    }

    #[test]
    fn test_mode_sufficient_allows() {
        let policy = PermissionPolicy::new(PermissionLevel::WorkspaceWrite);
        let input = serde_json::json!({"path": "/tmp/test.txt"});
        let result = policy.authorize("Write", &input);
        assert!(matches!(result, PermissionOutcome::Allow));
    }

    #[test]
    fn test_extract_subject_bash() {
        let input = serde_json::json!({"command": "ls -la"});
        assert_eq!(extract_permission_subject("bash", &input), "ls -la");
    }

    #[test]
    fn test_extract_subject_file() {
        let input = serde_json::json!({"path": "/home/user/file.txt"});
        assert_eq!(
            extract_permission_subject("read_file", &input),
            "/home/user/file.txt"
        );
    }

    #[test]
    fn test_glob_match() {
        assert!(glob_match("/etc/passwd", "/etc/*"));
        assert!(glob_match("test.rs", "*.rs"));
        assert!(glob_match("/home/user/file.txt", "/home/*"));
        assert!(!glob_match("/var/log/app.log", "/etc/*"));
        assert!(glob_match("anything", "*"));
    }

    #[test]
    fn test_default_policy_readonly() {
        let policy = PermissionPolicy::new(PermissionLevel::ReadOnly);
        let input = serde_json::json!({"path": "/tmp/test.txt"});

        assert!(matches!(
            policy.authorize("Read", &input),
            PermissionOutcome::Allow
        ));
        assert!(matches!(
            policy.authorize("Glob", &input),
            PermissionOutcome::Allow
        ));
        assert!(matches!(
            policy.authorize("Write", &input),
            PermissionOutcome::Deny { .. }
        ));
    }
}
