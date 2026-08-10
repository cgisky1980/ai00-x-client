//! Unified path management module
//!
//! Provides unified management for all app storage paths, supporting user, project, and temporary levels

use crate::util::errors::*;
use log::{debug, error};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_PROJECT_SLUG_LEN: usize = 120;

/// Storage level
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum StorageLevel {
    /// User: global configuration and data
    User,
    /// Project: configuration for a specific project
    Project,
    /// Session: temporary data for the current session
    Session,
    /// Temporary: cache that can be cleaned
    Temporary,
}

/// Path manager
///
/// Manages all app storage paths consistently across platforms.
///
/// ## Path Layout (v2 — install-dir based, portable-friendly)
///
/// All user data lives under `<exe_dir>/data/`:
/// ```text
/// <install_dir>/
/// ├── ai00-x.exe
/// ├── runtime/                  ← onnx/llama runtimes (inference crate)
/// ├── models/                   ← model files (inference crate)
/// └── data/                     ← all user data root
///     ├── config/               ← app.json global config
///     ├── agents/               ← user-level agent configs
///     ├── profile/              ← portable user profile (sync-able)
///     │   ├── auth_vault/       ← login state (AES)
///     │   ├── kv_vault/         ← sensitive KV (AES)
///     │   ├── ui_prefs.json     ← UI preferences
///     │   ├── ssh/              ← SSH connections (no passwords)
///     │   └── rules/            ← user-level AI rules
///     ├── data/                 ← large local-only data
///     │   ├── usage_stats.db
///     │   ├── token_usage/
///     │   ├── cron/
///     │   └── miniapps/
///     ├── projects/             ← chat history/snapshots/plans
///     ├── remote_ssh/           ← SSH workspace mirrors
///     ├── ssh_secrets/          ← SSH password vault (AES, not migrated)
///     ├── skills/               ← user skills
///     ├── workspaces/           ← scratch/code/task
///     ├── cache/
///     ├── managed_runtimes/     ← node/python runtimes
///     ├── logs/
///     └── temp/
/// ```
///
/// Override: set `AI00X_DATA_DIR` env var to redirect `<exe_dir>/data/` (for tests).
///
/// ## Legacy paths (for migration detection only)
///
/// Old layout used `~/.config/ai00-x/` + `~/.ai00-x/` + platform-specific dirs.
/// Use `legacy_user_config_root()` and `legacy_ai00x_home_dir()` to detect old data.
#[derive(Debug, Clone)]
pub struct PathManager {
    /// Install-dir data root: `<exe_dir>/data/` (or `AI00X_DATA_DIR` override)
    install_data_root: PathBuf,
    /// Legacy user config root `~/.config/ai00-x/` (kept for migration detection)
    legacy_user_root: PathBuf,
    /// Optional override for the install data root, used by tests
    install_data_override: Option<PathBuf>,
    /// Cache of runtime slugs keyed by the original and canonical workspace paths.
    project_runtime_slug_cache: Arc<Mutex<HashMap<PathBuf, String>>>,
}

impl PathManager {
    /// Create a new path manager
    pub fn new() -> Ai00XResult<Self> {
        let install_data_root = Self::compute_install_data_root()?;
        let legacy_user_root = Self::compute_legacy_user_config_root();

        Ok(Self {
            install_data_root,
            legacy_user_root,
            install_data_override: None,
            project_runtime_slug_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Compute install-dir data root: `<exe_dir>/data/` (or `AI00X_DATA_DIR` override)
    fn compute_install_data_root() -> Ai00XResult<PathBuf> {
        // Allow environment variable override (for tests / portable setups)
        if let Ok(dir) = std::env::var("AI00X_DATA_DIR") {
            let path = PathBuf::from(dir);
            if path.is_absolute() {
                return Ok(path);
            }
        }

        // Default: <exe_dir>/data/
        let exe_dir = Self::exe_dir()?;
        Ok(exe_dir.join("data"))
    }

    /// Compute legacy user config root (for migration detection)
    /// - Windows: %APPDATA%\ai00-x\
    /// - macOS: ~/Library/Application Support/ai00-x/
    /// - Linux: ~/.config/ai00-x/
    fn compute_legacy_user_config_root() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ai00-x")
    }

    /// Get install-dir data root: `<exe_dir>/data/`
    pub fn install_data_root(&self) -> PathBuf {
        if let Some(path) = &self.install_data_override {
            return path.clone();
        }
        self.install_data_root.clone()
    }

    /// Legacy user config root (for migration detection only)
    /// - Windows: %APPDATA%\ai00-x\
    /// - macOS: ~/Library/Application Support/ai00-x/
    /// - Linux: ~/.config/ai00-x/
    pub fn legacy_user_config_root(&self) -> PathBuf {
        self.legacy_user_root.clone()
    }

    /// Legacy Ai00-X home directory (for migration detection only): `~/.ai00-x/`
    pub fn legacy_ai00x_home_dir(&self) -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| self.legacy_user_root.clone())
            .join(".ai00-x")
    }

    /// Legacy user skills directory (for migration detection only):
    /// - Windows: C:\Users\xxx\AppData\Roaming\Ai00-X\skills\
    /// - macOS: ~/Library/Application Support/Ai00-X/skills/
    /// - Linux: ~/.local/share/Ai00-X/skills/
    pub fn legacy_user_skills_dir(&self) -> PathBuf {
        if cfg!(target_os = "windows") {
            dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
                .join("Ai00-X")
                .join("skills")
        } else if cfg!(target_os = "macos") {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join("Library")
                .join("Application Support")
                .join("Ai00-X")
                .join("skills")
        } else {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join("Ai00-X")
                .join("skills")
        }
    }

    /// Legacy SSH directory (for migration detection only):
    /// - Windows: %LOCALAPPDATA%\Ai00-X\ssh\
    /// - macOS: ~/Library/Application Support/Ai00-X/ssh/
    /// - Linux: ~/.local/share/Ai00-X/ssh/
    pub fn legacy_ssh_dir(&self) -> PathBuf {
        if cfg!(target_os = "windows") {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
                .join("Ai00-X")
                .join("ssh")
        } else if cfg!(target_os = "macos") {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join("Library")
                .join("Application Support")
                .join("Ai00-X")
                .join("ssh")
        } else {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join("Ai00-X")
                .join("ssh")
        }
    }

    /// Ai00-X home directory: `<exe_dir>/data/` (unified with install data root)
    ///
    /// Note: `ai00x_home_dir()` and `install_data_root()` now return the same path.
    /// Kept as alias for backward compatibility with existing callers.
    pub fn ai00x_home_dir(&self) -> PathBuf {
        self.install_data_root()
    }

    /// Get user config directory: `<exe_dir>/data/config/`
    pub fn user_config_dir(&self) -> PathBuf {
        self.install_data_root().join("config")
    }

    /// Get app config file path: `<exe_dir>/data/config/app.json`
    pub fn app_config_file(&self) -> PathBuf {
        self.user_config_dir().join("app.json")
    }

    /// Get user agent directory: `<exe_dir>/data/agents/`
    pub fn user_agents_dir(&self) -> PathBuf {
        self.install_data_root().join("agents")
    }

    /// Get user skills directory: `<exe_dir>/data/skills/`
    ///
    /// Note: Previously platform-specific (%LOCALAPPDATA%\Ai00-X\skills\ on Windows).
    /// Now unified under install data root. Use `legacy_user_skills_dir()` for migration.
    pub fn user_skills_dir(&self) -> PathBuf {
        self.install_data_root().join("skills")
    }

    /// Get cache root directory: `<exe_dir>/data/cache/`
    pub fn cache_root(&self) -> PathBuf {
        self.install_data_root().join("cache")
    }

    /// Get managed runtimes root directory: `<exe_dir>/data/managed_runtimes/`
    ///
    /// Ai00-X-managed runtime components (e.g. node/python/office) are stored here.
    /// Renamed from `runtimes/` to `managed_runtimes/` to avoid conflict with
    /// the inference crate's `<exe_dir>/runtime/` (onnx/llama).
    pub fn managed_runtimes_dir(&self) -> PathBuf {
        self.install_data_root().join("managed_runtimes")
    }

    /// Get user data directory: `<exe_dir>/data/data/`
    ///
    /// Note: This nested `data/data/` layout separates large local-only data
    /// (usage_stats, token_usage, cron, miniapps) from other user data.
    pub fn user_data_dir(&self) -> PathBuf {
        self.install_data_root().join("data")
    }

    /// Get profile directory (portable, sync-able user data): `<exe_dir>/data/profile/`
    ///
    /// Contains: auth_vault, kv_vault, ui_prefs, ssh connections, ai rules.
    /// Designed for service-side sync across devices.
    pub fn profile_dir(&self) -> PathBuf {
        self.install_data_root().join("profile")
    }

    /// Get SSH secrets directory (not migrated): `<exe_dir>/data/ssh_secrets/`
    ///
    /// Contains: SSH password vault (AES encrypted).
    /// Sensitive data, not synced to server.
    pub fn ssh_secrets_dir(&self) -> PathBuf {
        self.install_data_root().join("ssh_secrets")
    }

    /// Get SSH connections directory (sync-able, no passwords): `<exe_dir>/data/profile/ssh/`
    ///
    /// Contains: ssh_connections.json, known_hosts, remote_workspace.json.
    pub fn ssh_connections_dir(&self) -> PathBuf {
        self.profile_dir().join("ssh")
    }

    /// Root for per-host, per-remote-path workspace mirrors: `<exe_dir>/data/remote_ssh/`.
    ///
    /// Session/chat persistence for SSH workspaces lives under
    /// `{this}/{sanitized_host}/{remote_path_segments}/sessions/`.
    pub fn remote_ssh_mirror_root() -> PathBuf {
        Self::new()
            .map(|pm| pm.install_data_root().join("remote_ssh"))
            .unwrap_or_else(|_| {
                // Fallback: try AI00X_DATA_DIR env var, then <exe_dir>/data/remote_ssh/
                if let Ok(dir) = std::env::var("AI00X_DATA_DIR") {
                    return PathBuf::from(dir).join("remote_ssh");
                }
                std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.join("data").join("remote_ssh")))
                    .unwrap_or_else(|| PathBuf::from(".").join("data").join("remote_ssh"))
            })
    }

    /// Get scheduled jobs directory: `<exe_dir>/data/data/cron/`
    pub fn user_cron_dir(&self) -> PathBuf {
        self.user_data_dir().join("cron")
    }

    /// Get scheduled jobs persistence file: `<exe_dir>/data/data/cron/jobs.json`
    pub fn cron_jobs_file(&self) -> PathBuf {
        self.user_cron_dir().join("jobs.json")
    }

    /// Get miniapps root directory: `<exe_dir>/data/data/miniapps/`
    pub fn miniapps_dir(&self) -> PathBuf {
        self.user_data_dir().join("miniapps")
    }

    /// Get directory for a specific miniapp: `<exe_dir>/data/data/miniapps/{app_id}/`
    pub fn miniapp_dir(&self, app_id: &str) -> PathBuf {
        self.miniapps_dir().join(app_id)
    }

    /// Get the default songs output directory: `<exe_dir>/data/songs/`
    ///
    /// Used by the `.a00m` packaging flow as the default save location when
    /// the user does not pick a custom directory in the PackageDialog.
    pub fn songs_dir(&self) -> PathBuf {
        self.install_data_root().join("songs")
    }

    /// Get user-level rules directory: `<exe_dir>/data/profile/rules/`
    ///
    /// Note: Moved from `data/rules/` to `profile/rules/` for sync support.
    pub fn user_rules_dir(&self) -> PathBuf {
        self.profile_dir().join("rules")
    }

    /// Get logs directory: `<exe_dir>/data/logs/`
    pub fn logs_dir(&self) -> PathBuf {
        self.install_data_root().join("logs")
    }

    /// Get temp directory: `<exe_dir>/data/temp/`
    pub fn temp_dir(&self) -> PathBuf {
        self.install_data_root().join("temp")
    }

    /// Get project config root directory: {project}/.ai00-x/
    pub fn project_root(&self, workspace_path: &Path) -> PathBuf {
        workspace_path.join(".ai00-x")
    }

    /// Get the shared runtime projects root directory: `<exe_dir>/data/projects/`
    pub fn projects_root(&self) -> PathBuf {
        self.install_data_root().join("projects")
    }

    /// Get the runtime root for a workspace: ~/.ai00-x/projects/<workspace-slug>/
    pub fn project_runtime_root(&self, workspace_path: &Path) -> PathBuf {
        self.projects_root()
            .join(self.project_runtime_slug(workspace_path))
    }

    /// Get project internal config directory: {project}/.ai00-x/config/
    pub fn project_internal_config_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_root(workspace_path).join("config")
    }

    /// Get project mode skills file: {project}/.ai00-x/config/mode_skills.json
    pub fn project_mode_skills_file(&self, workspace_path: &Path) -> PathBuf {
        self.project_internal_config_dir(workspace_path)
            .join("mode_skills.json")
    }

    /// Get project agent directory: {project}/.ai00-x/agents/
    pub fn project_agents_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_root(workspace_path).join("agents")
    }

    /// Get project-level rules directory: {project}/.ai00-x/rules/
    pub fn project_rules_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_root(workspace_path).join("rules")
    }

    /// Get project snapshots directory: ~/.ai00-x/projects/<workspace-slug>/snapshots/
    pub fn project_snapshots_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_runtime_root(workspace_path).join("snapshots")
    }

    /// Get project sessions directory: ~/.ai00-x/projects/<workspace-slug>/sessions/
    pub fn project_sessions_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_runtime_root(workspace_path).join("sessions")
    }

    /// Get project plans directory: ~/.ai00-x/projects/<workspace-slug>/plans/
    pub fn project_plans_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_runtime_root(workspace_path).join("plans")
    }

    /// Get project memory directory: ~/.ai00-x/projects/<workspace-slug>/memory/
    pub fn project_memory_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_runtime_root(workspace_path).join("memory")
    }

    /// Get project AI memories file: ~/.ai00-x/projects/<workspace-slug>/ai_memories.json
    pub fn project_ai_memories_file(&self, workspace_path: &Path) -> PathBuf {
        self.project_runtime_root(workspace_path)
            .join("ai_memories.json")
    }

    fn project_runtime_slug(&self, workspace_path: &Path) -> String {
        let requested_path = workspace_path.to_path_buf();
        if let Some(slug) = self.cached_project_runtime_slug(&requested_path) {
            return slug;
        }

        let canonical_path =
            dunce::canonicalize(workspace_path).unwrap_or_else(|_| requested_path.clone());
        if canonical_path != requested_path {
            if let Some(slug) = self.cached_project_runtime_slug(&canonical_path) {
                self.store_project_runtime_slug(&requested_path, &slug);
                return slug;
            }
        }

        let canonical = canonical_path.to_string_lossy().to_string();
        let slug = Self::build_project_runtime_slug(&canonical);

        self.store_project_runtime_slug(&canonical_path, &slug);
        if canonical_path != requested_path {
            self.store_project_runtime_slug(&requested_path, &slug);
        }

        slug
    }

    fn cached_project_runtime_slug(&self, workspace_path: &Path) -> Option<String> {
        self.project_runtime_slug_cache
            .lock()
            .expect("project runtime slug cache poisoned")
            .get(workspace_path)
            .cloned()
    }

    fn store_project_runtime_slug(&self, workspace_path: &Path, slug: &str) {
        self.project_runtime_slug_cache
            .lock()
            .expect("project runtime slug cache poisoned")
            .insert(workspace_path.to_path_buf(), slug.to_string());
    }

    fn build_project_runtime_slug(canonical: &str) -> String {
        let slug: String = canonical
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() {
                    ch.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect();

        let slug = slug.trim_matches('-');
        let slug = if slug.is_empty() { "workspace" } else { slug };

        if slug.len() <= MAX_PROJECT_SLUG_LEN {
            return slug.to_string();
        }

        let hash = hex::encode(Sha256::digest(canonical.as_bytes()));
        let suffix = &hash[..12];
        let max_prefix_len = MAX_PROJECT_SLUG_LEN.saturating_sub(suffix.len() + 1);
        let prefix = slug[..max_prefix_len].trim_end_matches('-');
        format!("{}-{}", prefix, suffix)
    }

    /// Ensure directory exists
    pub async fn ensure_dir(&self, path: &Path) -> Ai00XResult<()> {
        if !path.exists() {
            tokio::fs::create_dir_all(path).await.map_err(|e| {
                Ai00XError::service(format!("Failed to create directory {:?}: {}", path, e))
            })?;
        }
        Ok(())
    }

    /// Get the directory containing the current executable.
    pub fn exe_dir() -> Ai00XResult<PathBuf> {
        std::env::current_exe()
            .map_err(|e| {
                Ai00XError::config(format!("Failed to get current executable path: {}", e))
            })?
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| Ai00XError::config("Executable has no parent directory".to_string()))
    }

    /// Resolve the effective default workspace parent directory.
    ///
    /// If `config_value` is `Some(path)`, returns that path.
    /// Otherwise, defaults to `<exe_dir>/data/workspaces/`.
    ///
    /// Note: Previously defaulted to `<exe_dir>/workspaces/`. Moved under `data/`
    /// for unified storage layout. Old `<exe_dir>/workspaces/` is auto-migrated
    /// by `path_migration` module if detected.
    pub fn effective_default_workspace_parent_dir(
        config_value: Option<&str>,
    ) -> Ai00XResult<PathBuf> {
        if let Some(val) = config_value.filter(|v| !v.trim().is_empty()) {
            return Ok(PathBuf::from(val));
        }
        // Use AI00X_DATA_DIR override if set, else <exe_dir>/data/workspaces/
        if let Ok(dir) = std::env::var("AI00X_DATA_DIR") {
            let path = PathBuf::from(dir);
            if path.is_absolute() {
                return Ok(path.join("workspaces"));
            }
        }
        Self::exe_dir().map(|d| d.join("data").join("workspaces"))
    }

    /// Resolve the effective scratch workspace directory.
    ///
    /// If `config_value` is `Some(path)`, returns that path.
    /// Otherwise, defaults to `<default_workspace_parent_dir>/scratch`.
    pub fn effective_scratch_workspace_dir(
        config_value: Option<&str>,
        parent_dir: Option<&str>,
    ) -> Ai00XResult<PathBuf> {
        if let Some(val) = config_value.filter(|v| !v.trim().is_empty()) {
            return Ok(PathBuf::from(val));
        }
        Self::effective_default_workspace_parent_dir(parent_dir).map(|d| d.join("scratch"))
    }

    /// Resolve the effective code workspace directory.
    ///
    /// Returns `<default_workspace_parent_dir>/code`.
    /// Used as the default parent directory for Code mode new projects.
    pub fn effective_code_workspace_dir(parent_dir: Option<&str>) -> Ai00XResult<PathBuf> {
        Self::effective_default_workspace_parent_dir(parent_dir).map(|d| d.join("code"))
    }

    /// Resolve the effective task workspace directory.
    ///
    /// Returns `<default_workspace_parent_dir>/task`.
    /// Fixed path for Task mode, not configurable.
    pub fn effective_task_workspace_dir(parent_dir: Option<&str>) -> Ai00XResult<PathBuf> {
        Self::effective_default_workspace_parent_dir(parent_dir).map(|d| d.join("task"))
    }

    /// Check whether the given path is the scratch/temp workspace.
    pub fn is_scratch_workspace(
        path: &Path,
        default_workspace: Option<&str>,
        default_workspace_parent_dir: Option<&str>,
    ) -> bool {
        match Self::effective_scratch_workspace_dir(default_workspace, default_workspace_parent_dir)
        {
            Ok(effective) => {
                dunce::canonicalize(path).ok().as_deref()
                    == dunce::canonicalize(&effective).ok().as_deref()
            }
            Err(_) => false,
        }
    }

    /// Check whether the given path is the task workspace.
    pub fn is_task_workspace(path: &Path, parent_dir: Option<&str>) -> bool {
        match Self::effective_task_workspace_dir(parent_dir) {
            Ok(effective) => {
                dunce::canonicalize(path).ok().as_deref()
                    == dunce::canonicalize(&effective).ok().as_deref()
            }
            Err(_) => false,
        }
    }

    /// Ensure all workspace directories exist (code, task).
    ///
    /// Code and task directories are preserved across restarts.
    pub async fn ensure_workspace_dirs(
        default_workspace_parent_dir: Option<&str>,
    ) -> Ai00XResult<()> {
        let parent = Self::effective_default_workspace_parent_dir(default_workspace_parent_dir)?;
        tokio::fs::create_dir_all(&parent).await.map_err(|e| {
            Ai00XError::service(format!(
                "Failed to create workspace parent directory {:?}: {}",
                parent, e
            ))
        })?;

        // Ensure code directory exists (preserved across restarts)
        let code_dir = Self::effective_code_workspace_dir(default_workspace_parent_dir)?;
        tokio::fs::create_dir_all(&code_dir).await.map_err(|e| {
            Ai00XError::service(format!(
                "Failed to create code workspace directory {:?}: {}",
                code_dir, e
            ))
        })?;

        // Ensure task directory exists (preserved across restarts)
        let task_dir = Self::effective_task_workspace_dir(default_workspace_parent_dir)?;
        tokio::fs::create_dir_all(&task_dir).await.map_err(|e| {
            Ai00XError::service(format!(
                "Failed to create task workspace directory {:?}: {}",
                task_dir, e
            ))
        })?;

        debug!(
            "Workspace directories ensured: parent={:?}, code={:?}, task={:?}",
            parent, code_dir, task_dir
        );
        Ok(())
    }

    /// Initialize user-level directory structure
    pub async fn initialize_user_directories(&self) -> Ai00XResult<()> {
        let dirs = vec![
            // Root
            self.install_data_root(),
            self.projects_root(),
            // Config + agents
            self.user_config_dir(),
            self.user_agents_dir(),
            // Profile (sync-able)
            self.profile_dir(),
            self.profile_dir().join("auth_vault"),
            self.profile_dir().join("kv_vault"),
            self.profile_dir().join("ssh"),
            self.profile_dir().join("rules"),
            // SSH secrets (not migrated)
            self.ssh_secrets_dir(),
            // Large local-only data
            self.user_data_dir(),
            self.user_cron_dir(),
            self.miniapps_dir(),
            // Skills
            self.user_skills_dir(),
            // Cache + runtimes + logs + temp
            self.cache_root(),
            self.managed_runtimes_dir(),
            self.logs_dir(),
            self.temp_dir(),
            // Default songs output for the .a00m packaging flow
            self.songs_dir(),
        ];

        for dir in dirs {
            self.ensure_dir(&dir).await?;
        }

        debug!("User-level directories initialized (install-dir layout v2)");
        Ok(())
    }
}

impl Default for PathManager {
    fn default() -> Self {
        match Self::new() {
            Ok(manager) => manager,
            Err(e) => {
                error!(
                    "Failed to create PathManager from exe directory, using temp fallback: {}",
                    e
                );
                Self {
                    install_data_root: std::env::temp_dir().join("ai00-x").join("data"),
                    legacy_user_root: std::env::temp_dir().join("ai00-x"),
                    install_data_override: None,
                    project_runtime_slug_cache: Arc::new(Mutex::new(HashMap::new())),
                }
            }
        }
    }
}

#[cfg(test)]
impl PathManager {
    /// Test helper: create a PathManager with a custom install data root.
    ///
    /// The `install_data_root` parameter is used as the `<exe_dir>/data/` root,
    /// enabling tests to use a temp directory without touching real install dir.
    pub(crate) fn with_install_data_root_for_tests(install_data_root: PathBuf) -> Self {
        let legacy_user_root = install_data_root
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("legacy_config").join("ai00-x"))
            .unwrap_or_else(|| install_data_root.clone());
        Self {
            install_data_root: install_data_root.clone(),
            legacy_user_root,
            install_data_override: Some(install_data_root),
            project_runtime_slug_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Backward-compat alias for tests. Maps to new install_data_root semantics.
    pub(crate) fn with_user_root_for_tests(user_root: PathBuf) -> Self {
        Self::with_install_data_root_for_tests(user_root)
    }
}

use std::sync::OnceLock;

/// Global PathManager instance
static GLOBAL_PATH_MANAGER: OnceLock<Arc<PathManager>> = OnceLock::new();

fn init_global_path_manager() -> Ai00XResult<Arc<PathManager>> {
    PathManager::new().map(Arc::new)
}

/// Get the global PathManager instance (Arc)
///
/// Return a shared Arc to the global PathManager instance
pub fn get_path_manager_arc() -> Arc<PathManager> {
    GLOBAL_PATH_MANAGER
        .get_or_init(|| match init_global_path_manager() {
            Ok(manager) => manager,
            Err(e) => {
                error!(
                    "Failed to create global PathManager from config directory, using fallback: {}",
                    e
                );
                Arc::new(PathManager::default())
            }
        })
        .clone()
}

/// Try to get the global PathManager instance (Arc)
pub fn try_get_path_manager_arc() -> Ai00XResult<Arc<PathManager>> {
    if let Some(manager) = GLOBAL_PATH_MANAGER.get() {
        return Ok(Arc::clone(manager));
    }

    let manager = init_global_path_manager()?;
    match GLOBAL_PATH_MANAGER.set(Arc::clone(&manager)) {
        Ok(()) => Ok(manager),
        Err(_) => Ok(Arc::clone(GLOBAL_PATH_MANAGER.get().expect(
            "GLOBAL_PATH_MANAGER should be initialized after set failure",
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::PathManager;
    use std::path::Path;

    #[test]
    fn project_runtime_root_uses_human_readable_workspace_slug() {
        let pm = PathManager::default();
        let runtime_root = pm.project_runtime_root(Path::new(r"E:\Projects\Ai00-X\Ai00-X"));
        let slug = runtime_root
            .file_name()
            .and_then(|value| value.to_str())
            .expect("runtime root should have terminal component");

        assert!(slug.starts_with("e--projects-ai00-x-ai00-x"));
        assert_eq!(runtime_root.parent(), Some(pm.projects_root().as_path()));
    }
}
