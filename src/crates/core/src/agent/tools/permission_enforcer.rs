use super::permission::{PermissionLevel, PermissionOutcome, PermissionPolicy};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EnforcementResult {
    Allowed,
    Denied {
        tool: String,
        active_mode: PermissionLevel,
        required_mode: PermissionLevel,
        reason: String,
    },
}

impl EnforcementResult {
    pub fn is_allowed(&self) -> bool {
        matches!(self, EnforcementResult::Allowed)
    }
}

pub struct PermissionEnforcer {
    policy: PermissionPolicy,
}

impl PermissionEnforcer {
    pub fn new(policy: PermissionPolicy) -> Self {
        Self { policy }
    }

    pub fn readonly() -> Self {
        Self::new(PermissionPolicy::new(PermissionLevel::ReadOnly))
    }

    pub fn workspace_write() -> Self {
        Self::new(PermissionPolicy::new(PermissionLevel::WorkspaceWrite))
    }

    pub fn full_access() -> Self {
        Self::new(PermissionPolicy::new(PermissionLevel::DangerFullAccess))
    }

    pub fn check(&self, tool_name: &str, input: &str) -> EnforcementResult {
        let value = serde_json::from_str(input).unwrap_or(serde_json::Value::Null);
        let outcome = self.policy.authorize(tool_name, &value);

        match outcome {
            PermissionOutcome::Allow => EnforcementResult::Allowed,
            PermissionOutcome::Deny { reason } => {
                let required = self
                    .policy
                    .tool_requirements
                    .get(tool_name)
                    .copied()
                    .unwrap_or(PermissionLevel::DangerFullAccess);
                EnforcementResult::Denied {
                    tool: tool_name.to_string(),
                    active_mode: self.policy.active_mode,
                    required_mode: required,
                    reason,
                }
            }
        }
    }

    pub fn check_file_write(&self, path: &str, workspace_root: &str) -> EnforcementResult {
        match self.policy.active_mode {
            PermissionLevel::ReadOnly => EnforcementResult::Denied {
                tool: "file_write".to_string(),
                active_mode: PermissionLevel::ReadOnly,
                required_mode: PermissionLevel::WorkspaceWrite,
                reason: "file writes are not allowed in ReadOnly mode".to_string(),
            },
            PermissionLevel::WorkspaceWrite => {
                let canonical_path = Path::new(path);
                let canonical_root = Path::new(workspace_root);
                match canonical_path.strip_prefix(canonical_root) {
                    Ok(_) => EnforcementResult::Allowed,
                    Err(_) => EnforcementResult::Denied {
                        tool: "file_write".to_string(),
                        active_mode: PermissionLevel::WorkspaceWrite,
                        required_mode: PermissionLevel::DangerFullAccess,
                        reason: format!(
                            "path '{}' is outside workspace root '{}'",
                            path, workspace_root
                        ),
                    },
                }
            }
            PermissionLevel::DangerFullAccess => EnforcementResult::Allowed,
        }
    }

    pub fn check_bash(&self, command: &str) -> EnforcementResult {
        match self.policy.active_mode {
            PermissionLevel::ReadOnly => {
                let allowed_commands = [
                    "cat", "head", "tail", "ls", "find", "grep", "rg", "ag", "wc", "sort", "uniq",
                    "diff", "file", "stat", "du", "echo", "pwd", "whoami", "hostname", "uname",
                    "date", "which", "type", "env", "printenv", "id", "df",
                ];

                let cmd_part = command.split_whitespace().next().unwrap_or("");
                if allowed_commands.contains(&cmd_part) && !contains_dangerous_pattern(command) {
                    EnforcementResult::Allowed
                } else {
                    EnforcementResult::Denied {
                        tool: "bash".to_string(),
                        active_mode: PermissionLevel::ReadOnly,
                        required_mode: PermissionLevel::WorkspaceWrite,
                        reason: format!("command '{}' is not allowed in ReadOnly mode", cmd_part),
                    }
                }
            }
            PermissionLevel::WorkspaceWrite | PermissionLevel::DangerFullAccess => {
                EnforcementResult::Allowed
            }
        }
    }

    pub fn is_allowed(&self, tool_name: &str, input: &str) -> bool {
        self.check(tool_name, input).is_allowed()
    }

    pub fn active_mode(&self) -> PermissionLevel {
        self.policy.active_mode
    }
}

fn contains_dangerous_pattern(command: &str) -> bool {
    let dangerous_patterns = [" -i", " --in-place", " >>", " > "];
    dangerous_patterns.iter().any(|p| command.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_readonly_allows_read_tools() {
        let enforcer = PermissionEnforcer::readonly();
        let input = r#"{"path": "/tmp/test.txt"}"#;
        assert!(enforcer.is_allowed("Read", input));
    }

    #[test]
    fn test_readonly_denies_write_tools() {
        let enforcer = PermissionEnforcer::readonly();
        let input = r#"{"path": "/tmp/test.txt"}"#;
        assert!(!enforcer.is_allowed("write_file", input));
    }

    #[test]
    fn test_workspace_write_allows_workspace_files() {
        let enforcer = PermissionEnforcer::workspace_write();
        let result = enforcer.check_file_write("/workspace/src/main.rs", "/workspace");
        assert!(result.is_allowed());
    }

    #[test]
    fn test_workspace_write_denies_outside_files() {
        let enforcer = PermissionEnforcer::workspace_write();
        let result = enforcer.check_file_write("/etc/passwd", "/workspace");
        assert!(!result.is_allowed());
    }

    #[test]
    fn test_readonly_bash_allows_ls() {
        let enforcer = PermissionEnforcer::readonly();
        let result = enforcer.check_bash("ls -la");
        assert!(result.is_allowed());
    }

    #[test]
    fn test_readonly_bash_denies_rm() {
        let enforcer = PermissionEnforcer::readonly();
        let result = enforcer.check_bash("rm -rf /tmp/test");
        assert!(!result.is_allowed());
    }

    #[test]
    fn test_readonly_bash_denies_redirect() {
        let enforcer = PermissionEnforcer::readonly();
        let result = enforcer.check_bash("echo hello > /tmp/file");
        assert!(!result.is_allowed());
    }

    #[test]
    fn test_full_access_allows_all() {
        let enforcer = PermissionEnforcer::full_access();
        let result = enforcer.check_file_write("/etc/passwd", "/workspace");
        assert!(result.is_allowed());
    }

    #[test]
    fn test_active_mode_accessor() {
        let enforcer = PermissionEnforcer::readonly();
        assert_eq!(enforcer.active_mode(), PermissionLevel::ReadOnly);
    }

    #[test]
    fn test_enforcement_result_is_allowed() {
        assert!(EnforcementResult::Allowed.is_allowed());
        assert!(!EnforcementResult::Denied {
            tool: "test".to_string(),
            active_mode: PermissionLevel::ReadOnly,
            required_mode: PermissionLevel::WorkspaceWrite,
            reason: "test".to_string(),
        }
        .is_allowed());
    }
}
