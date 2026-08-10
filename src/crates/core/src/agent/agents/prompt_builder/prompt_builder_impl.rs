//! System prompts module providing main dialogue and agent dialogue prompts
use super::request_context::{RequestContextPolicy, RequestContextSection};
use crate::infrastructure::try_get_path_manager_arc;
use crate::service::agent_memory::{
    build_workspace_agent_memory_prompt, build_workspace_instruction_files_context,
    build_workspace_memory_files_context,
};
use crate::service::ai_memory::AIMemoryManager;
use crate::service::ai_rules::get_global_ai_rules_service;
use crate::service::config::get_app_language_code;
use crate::service::config::get_global_config_service;
use crate::service::filesystem::get_formatted_directory_listing;
use crate::util::errors::{Ai00XError, Ai00XResult};
use crate::util::process_manager;
use log::{debug, warn};
use std::path::Path;

/// Placeholder constants
const PLACEHOLDER_ENV_INFO: &str = "{ENV_INFO}";
const PLACEHOLDER_LANGUAGE_PREFERENCE: &str = "{LANGUAGE_PREFERENCE}";
const PLACEHOLDER_AGENT_MEMORY: &str = "{AGENT_MEMORY}";
const PLACEHOLDER_VISUAL_MODE: &str = "{VISUAL_MODE}";
const PLACEHOLDER_CURRENT_DATE: &str = "{CURRENT_DATE}";

pub const SYSTEM_PROMPT_DYNAMIC_BOUNDARY: &str = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

/// SSH remote host facts for system prompt (workspace tools run here, not on the local client).
#[derive(Debug, Clone)]
pub struct RemoteExecutionHints {
    pub connection_display_name: String,
    pub kernel_name: String,
    pub hostname: String,
}

#[derive(Debug, Clone)]
pub struct PromptBuilderContext {
    pub workspace_path: String,
    pub session_id: Option<String>,
    pub model_name: Option<String>,
    /// When set, file/shell tools target this remote environment; OS and path instructions follow it.
    pub remote_execution: Option<RemoteExecutionHints>,
    /// Pre-built tree text for `{PROJECT_LAYOUT}` when the workspace is not on the local disk.
    pub remote_project_layout: Option<String>,
    /// When `Some(false)`, system prompt append Computer use text-only guidance (no screenshot tool output).
    pub supports_image_understanding: Option<bool>,
}

impl PromptBuilderContext {
    pub fn new(
        workspace_path: impl Into<String>,
        session_id: Option<String>,
        model_name: Option<String>,
    ) -> Self {
        Self {
            workspace_path: workspace_path.into().replace("\\", "/"),
            session_id,
            model_name,
            remote_execution: None,
            remote_project_layout: None,
            supports_image_understanding: None,
        }
    }

    pub fn with_supports_image_understanding(mut self, supports: bool) -> Self {
        self.supports_image_understanding = Some(supports);
        self
    }

    pub fn with_remote_prompt_overlay(
        mut self,
        execution: RemoteExecutionHints,
        project_layout: Option<String>,
    ) -> Self {
        self.remote_execution = Some(execution);
        self.remote_project_layout = project_layout;
        self
    }
}

pub struct PromptBuilder {
    pub context: PromptBuilderContext,
    pub file_tree_max_entries: usize,
}

impl PromptBuilder {
    pub fn new(context: PromptBuilderContext) -> Self {
        Self {
            context,
            file_tree_max_entries: 200,
        }
    }

    /// Provide complete environment information
    pub fn get_env_info(&self) -> String {
        let host_os = std::env::consts::OS;
        let host_family = std::env::consts::FAMILY;
        let host_arch = std::env::consts::ARCH;

        let now = chrono::Local::now();
        let current_date = now.format("%Y-%m-%d").to_string();

        let bash_hint = match host_os {
            "windows" => "**Bash tool runs in PowerShell by default.** Use PowerShell syntax: `Get-ChildItem` (not `ls`), `Get-Content` (not `cat`), `Select-String` (not `grep`), `Remove-Item` (not `rm`), `Get-Location` (not `pwd`). For git/npm/docker/cargo use the same commands cross-platform. Use `;` not `&&` for chaining.",
            "macos" => "Bash tool runs in zsh by default. Use standard Unix/POSIX commands.",
            "linux" => "Bash tool runs in bash by default. Use standard Unix/POSIX commands.",
            _ => "Use the default shell for this platform.",
        };

        if let Some(remote) = &self.context.remote_execution {
            format!(
                r#"# Environment Information
<environment_details>
- Workspace root: {}
- Execution environment: **Remote SSH** — connection "{}"
- Remote host: {} (kernel: {})
- **Remote shell:** POSIX/Unix — use bash/sh syntax, forward slashes. Do NOT use PowerShell or cmd.exe for workspace operations.
- Local Ai00-X client: {} ({}) — applies to local-only operations, not workspace.
- Local architecture: {}
- Current Date: {}
- {}
</environment_details>

"#,
                self.context.workspace_path,
                remote.connection_display_name.replace('"', "'"),
                remote.hostname.replace('"', "'"),
                remote.kernel_name.replace('"', "'"),
                host_os,
                host_family,
                host_arch,
                current_date,
                bash_hint
            )
        } else {
            format!(
                r#"# Environment Information
<environment_details>
- Current Working Directory: {}
- Operating System: {} ({})
- Shell: {} (current terminal is already opened)
- Architecture: {}
- Current Date: {}
- {}
</environment_details>

"#,
                self.context.workspace_path,
                host_os,
                host_family,
                if cfg!(target_os = "windows") {
                    "PowerShell"
                } else {
                    "bash/zsh"
                },
                host_arch,
                current_date,
                bash_hint
            )
        }
    }

    /// Get the current date formatted as YYYY-MM-DD
    pub fn get_current_date(&self) -> String {
        let now = chrono::Local::now();
        now.format("%Y-%m-%d").to_string()
    }

    /// Get workspace file list
    pub fn get_project_layout(&self) -> String {
        if let Some(remote_layout) = &self.context.remote_project_layout {
            let mut project_layout = "# Workspace Layout\n<project_layout>\n".to_string();
            project_layout.push_str(
                "Below is a snapshot of the current workspace's file structure on the **remote** host.\n\n",
            );
            project_layout.push_str(remote_layout);
            project_layout.push_str("\n</project_layout>\n\n");
            return project_layout;
        }

        let formatted_listing = get_formatted_directory_listing(
            &self.context.workspace_path,
            self.file_tree_max_entries,
        )
        .unwrap_or_else(|e| crate::service::filesystem::FormattedDirectoryListing {
            reached_limit: false,
            text: format!("Error listing directory: {}", e),
        });
        let mut project_layout = "# Workspace Layout\n<project_layout>\n".to_string();
        if formatted_listing.reached_limit {
            project_layout.push_str(&format!("Below is a snapshot of the current workspace's file structure (showing up to {} entries).\n\n", self.file_tree_max_entries));
        } else {
            project_layout
                .push_str("Below is a snapshot of the current workspace's file structure.\n\n");
        }
        project_layout.push_str(&formatted_listing.text);
        project_layout.push_str("\n</project_layout>\n\n");
        project_layout
    }

    pub fn get_git_context(&self) -> Option<String> {
        let workspace = Path::new(&self.context.workspace_path);
        let git_dir = workspace.join(".git");
        if !git_dir.exists() {
            return None;
        }

        let mut sections = Vec::new();

        if let Ok(output) = process_manager::create_command("git")
            .args(["--no-optional-locks", "status", "--short", "--branch"])
            .current_dir(workspace)
            .output()
        {
            if output.status.success() {
                if let Ok(stdout) = String::from_utf8(output.stdout) {
                    let trimmed = stdout.trim();
                    if !trimmed.is_empty() {
                        sections.push(format!("Git status:\n{}", trimmed));
                    }
                }
            }
        }

        if let Ok(output) = process_manager::create_command("git")
            .args(["diff", "--cached", "--stat"])
            .current_dir(workspace)
            .output()
        {
            if output.status.success() {
                if let Ok(stdout) = String::from_utf8(output.stdout) {
                    let trimmed = stdout.trim();
                    if !trimmed.is_empty() {
                        sections.push(format!("Staged changes:\n{}", trimmed));
                    }
                }
            }
        }

        if let Ok(output) = process_manager::create_command("git")
            .args(["diff", "--stat"])
            .current_dir(workspace)
            .output()
        {
            if output.status.success() {
                if let Ok(stdout) = String::from_utf8(output.stdout) {
                    let trimmed = stdout.trim();
                    if !trimmed.is_empty() {
                        sections.push(format!("Unstaged changes:\n{}", trimmed));
                    }
                }
            }
        }

        if sections.is_empty() {
            None
        } else {
            Some(format!("# Git context\n{}", sections.join("\n\n")))
        }
    }

    /// Load AI memories from disk and format as prompt
    pub async fn load_ai_memories(&self) -> Option<String> {
        let path_manager = match try_get_path_manager_arc() {
            Ok(pm) => pm,
            Err(e) => {
                warn!("Failed to create PathManager: {}", e);
                return None;
            }
        };

        let memory_manager = match AIMemoryManager::new(path_manager).await {
            Ok(mm) => mm,
            Err(e) => {
                warn!("Failed to create AIMemoryManager: {}", e);
                return None;
            }
        };

        match memory_manager.get_memories_for_prompt().await {
            Ok(Some(prompt)) => Some(prompt),
            Ok(None) => None,
            Err(e) => {
                warn!("Failed to load memories: {}", e);
                None
            }
        }
    }

    pub async fn build_request_context_reminder(
        &self,
        policy: &RequestContextPolicy,
    ) -> Option<String> {
        let mut sections = Vec::new();
        let mut instruction_sections = Vec::new();
        let mut override_sections = Vec::new();
        let mut trailing_sections = Vec::new();

        if self.context.remote_execution.is_none() {
            let workspace = Path::new(&self.context.workspace_path);
            if policy.includes(RequestContextSection::WorkspaceInstructions) {
                match build_workspace_instruction_files_context(workspace).await {
                    Ok(Some(prompt)) => instruction_sections.push(prompt),
                    Ok(None) => {}
                    Err(e) => warn!(
                        "Failed to build workspace instruction context: path={} error={}",
                        workspace.display(),
                        e
                    ),
                }
            }
            if policy.includes(RequestContextSection::WorkspaceMemoryFiles) {
                match build_workspace_memory_files_context(workspace).await {
                    Ok(Some(prompt)) => override_sections.push(prompt),
                    Ok(None) => {}
                    Err(e) => warn!(
                        "Failed to build workspace memory context: path={} error={}",
                        workspace.display(),
                        e
                    ),
                }
            }
        }

        if policy.includes(RequestContextSection::AIRules) {
            if let Some(rules_prompt) = self.load_ai_rules().await {
                override_sections.push(rules_prompt);
            }
        }

        if policy.includes(RequestContextSection::AIMemories) {
            if let Some(memory_prompt) = self.load_ai_memories().await {
                override_sections.push(memory_prompt);
            }
        }

        if policy.includes(RequestContextSection::AgentMemoryInject) {
            if let Some(ref session_id) = self.context.session_id {
                if let Some(pending) =
                    crate::service::memory_graph::pending::take_pending_memory(session_id)
                {
                    override_sections.push(pending.prompt);
                }
            }
        }

        if policy.includes(RequestContextSection::ProjectLayout) {
            trailing_sections.push(self.get_project_layout());
        }

        if let Some(git_context) = self.get_git_context() {
            trailing_sections.push(git_context);
        }

        sections.extend(instruction_sections);

        if policy.has_override_sections() && !override_sections.is_empty() {
            sections.push("Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.".to_string());
            sections.extend(override_sections);
        }

        sections.extend(trailing_sections);

        if sections.is_empty() {
            None
        } else {
            Some(sections.join("\n\n"))
        }
    }

    /// Load AI rules from disk and format as prompt
    pub async fn load_ai_rules(&self) -> Option<String> {
        let rules_service = match get_global_ai_rules_service().await {
            Ok(service) => service,
            Err(e) => {
                warn!("Failed to get AIRulesService: {}", e);
                return None;
            }
        };

        let workspace_pathbuf = std::path::PathBuf::from(&self.context.workspace_path);
        match rules_service
            .build_system_prompt_for(Some(&workspace_pathbuf))
            .await
        {
            Ok(prompt) => {
                if prompt.is_empty() {
                    None
                } else {
                    Some(prompt)
                }
            }
            Err(e) => {
                warn!("Failed to build AI rules system prompt: {}", e);
                None
            }
        }
    }

    /// Get visual mode instruction from user config
    ///
    /// Reads `app.ai_experience.enable_visual_mode` from global config.
    /// Returns a prompt snippet when enabled, or empty string when disabled.
    async fn get_visual_mode_instruction(&self) -> String {
        let enabled = match get_global_config_service() {
            Ok(service) => service
                .get_config::<bool>(Some("app.ai_experience.enable_visual_mode"))
                .await
                .unwrap_or(false),
            Err(e) => {
                debug!("Failed to read visual mode config: {}", e);
                false
            }
        };

        if enabled {
            r"# Visualizing complex logic as you explain
Use Mermaid diagrams to visualize complex logic, workflows, architectures, and data flows whenever it helps clarify the explanation.
Prefer MermaidInteractive tool when available, otherwise output Mermaid code blocks directly.
".to_string()
        } else {
            String::new()
        }
    }

    /// Get user language preference instruction
    ///
    /// Read app.language from global config, generate simple language instruction
    /// Returns empty string if config cannot be read
    /// Returns error if language code is unsupported
    async fn get_language_preference(&self) -> Ai00XResult<String> {
        let language_code = get_app_language_code().await;
        Self::format_language_instruction(&language_code)
    }

    /// Format language instruction based on language code
    fn format_language_instruction(lang_code: &str) -> Ai00XResult<String> {
        let language = match lang_code {
            "zh-CN" => "**Simplified Chinese**",
            "en-US" => "**English**",
            _ => {
                return Err(Ai00XError::config(format!(
                    "Unknown language code: {}",
                    lang_code
                )));
            }
        };
        Ok(format!("# Language Preference\nYou MUST respond in {} regardless of the user's input language. This is the system language setting and should be followed unless the user explicitly specifies a different language. This is crucial for smooth communication and user experience\n", language))
    }

    /// Build prompt from template, automatically fill content based on placeholders
    ///
    /// Supported placeholders:
    /// - `{LANGUAGE_PREFERENCE}` - User language preference (read from global config)
    /// - `{ENV_INFO}` - Environment information
    /// - `{AGENT_MEMORY}` - Agent memory instructions + auto-loaded memory index
    /// - `{VISUAL_MODE}` - Visual mode instruction (Mermaid diagrams, read from global config)
    ///
    /// If a placeholder is not in the template, corresponding content will not be added
    pub async fn build_prompt_from_template(&self, template: &str) -> Ai00XResult<String> {
        let mut static_part = template.to_string();

        let mut dynamic_sections = Vec::new();

        if static_part.contains(PLACEHOLDER_LANGUAGE_PREFERENCE) {
            let language_preference = self.get_language_preference().await?;
            dynamic_sections.push(language_preference);
            static_part = static_part.replace(PLACEHOLDER_LANGUAGE_PREFERENCE, "");
        }

        if static_part.contains(PLACEHOLDER_CURRENT_DATE) {
            let current_date = self.get_current_date();
            static_part = static_part.replace(PLACEHOLDER_CURRENT_DATE, &current_date);
        }

        if static_part.contains(PLACEHOLDER_ENV_INFO) {
            let env_info = self.get_env_info();
            dynamic_sections.push(env_info);
            static_part = static_part.replace(PLACEHOLDER_ENV_INFO, "");
        }

        if static_part.contains(PLACEHOLDER_AGENT_MEMORY) {
            let agent_memory = if self.context.remote_execution.is_some() {
                "# Agent memory\nSession memory under `.ai00-x/` is stored on the **remote** host for this workspace. Use file tools with POSIX paths under the workspace root if you need to read it.\n\n"
                    .to_string()
            } else {
                let workspace = Path::new(&self.context.workspace_path);
                match build_workspace_agent_memory_prompt(workspace).await {
                    Ok(prompt) => prompt,
                    Err(e) => {
                        warn!(
                            "Failed to build workspace agent memory prompt: path={} error={}",
                            workspace.display(),
                            e
                        );
                        String::new()
                    }
                }
            };
            dynamic_sections.push(agent_memory);
            static_part = static_part.replace(PLACEHOLDER_AGENT_MEMORY, "");
        }

        if static_part.contains(PLACEHOLDER_VISUAL_MODE) {
            let visual_mode = self.get_visual_mode_instruction().await;
            if !visual_mode.is_empty() {
                dynamic_sections.push(visual_mode);
            }
            static_part = static_part.replace(PLACEHOLDER_VISUAL_MODE, "");
        }

        if self.context.supports_image_understanding == Some(false) {
            dynamic_sections.push(
                "# Computer use (text-only primary model)\n\n\
The configured **primary model does not accept image inputs**. When using **ComputerUse**:\n\
- **Do not** use **`screenshot`** or **`click_label`**.\n\
- **ACTION PRIORITY:** 1) Terminal/CLI/system commands (Bash tool) 2) Keyboard shortcuts (**`key_chord`**, **`type_text`**) 3) UI control: **`click_element`** (AX) → **`locate`** → **`move_to_text`** (use **`move_to_text_match_index`** when multiple OCR hits listed) → **`mouse_move`** (**`use_screen_coordinates`: true** with coordinates from tool JSON) → **`click`**.\n\
- **Never guess coordinates** — always use precise methods (AX, OCR, system coordinates from tool results).\n".to_string(),
            );
        }

        let system_reminder_note = "Tool results and user messages may include <system_reminder> tags. These <system_reminder> tags contain useful information and reminders. Please heed them, but don't mention them in your response to the user.";

        let mut result = static_part.trim().to_string();
        result = format!("{}\n\n{}", system_reminder_note, result);
        result.push_str("\n\n");
        result.push_str(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
        result.push_str("\n\n");
        result.push_str(&dynamic_sections.join("\n\n"));

        Ok(result.trim().to_string())
    }

    pub async fn build_prompt_sections(&self, template: &str) -> Ai00XResult<(String, String)> {
        let full = self.build_prompt_from_template(template).await?;
        if let Some(idx) = full.find(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) {
            let static_part = full[..idx].trim().to_string();
            let dynamic_part = full[idx + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.len()..]
                .trim()
                .to_string();
            Ok((static_part, dynamic_part))
        } else {
            Ok((full, String::new()))
        }
    }
}
