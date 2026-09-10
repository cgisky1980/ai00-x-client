//! Service layer module
//!
//! Contains core business logic: Workspace, Config, FileSystem, Git, AIRules, MCP.

pub mod ai_memory; // AI memory point management
pub mod ai_rules; // AI rules management
pub mod config; // Config management
pub mod diff;
pub mod file_watch;
pub mod filesystem; // FileSystem management
pub mod git; // Git service
#[cfg(feature = "i18n")]
pub mod i18n; // I18n service
pub mod lsp; // LSP (Language Server Protocol) system
pub mod mcp; // MCP (Model Context Protocol) system
pub mod remote_ssh; // Remote SSH (desktop → server)
pub mod runtime; // Managed runtime and capability management
pub mod system; // System command detection and execution
pub mod workspace; // Workspace management // Diff calculation and merge service
pub mod workspace_runtime; // Workspace runtime layout / migration / initialization

// Terminal is a standalone crate; re-export it here.
pub use terminal_core as terminal;

// Re-export main components.
pub use ai_memory::{AIMemory, AIMemoryManager, MemoryType};
pub use ai_rules::AIRulesService;
pub use config::{ConfigManager, ConfigProvider, ConfigService};
pub use diff::{
    DiffConfig, DiffHunk, DiffLine, DiffLineType, DiffOptions, DiffResult, DiffService,
};
pub use file_watch::{
    get_global_file_watch_service, get_watched_paths, initialize_file_watch_service,
    start_file_watch, stop_file_watch, FileWatchEvent, FileWatchEventKind, FileWatchService,
    FileWatcherConfig,
};
pub use filesystem::{DirectoryStats, FileSystemService, FileSystemServiceFactory};
pub use git::GitService;
#[cfg(feature = "i18n")]
pub use i18n::{get_global_i18n_service, I18nConfig, I18nService, LocaleId, LocaleMetadata};
pub use lsp::LspManager;
pub use mcp::MCPService;
pub use runtime::{ResolvedCommand, RuntimeCommandCapability, RuntimeManager, RuntimeSource};
pub use system::{
    check_command, check_commands, run_command, run_command_simple, CheckCommandResult,
    CommandOutput, SystemError,
};
pub use workspace::{WorkspaceManager, WorkspaceProvider, WorkspaceService};
pub use workspace_runtime::{
    get_workspace_runtime_service_arc, try_get_workspace_runtime_service_arc,
    RuntimeMigrationRecord, WorkspaceRuntimeContext, WorkspaceRuntimeEnsureResult,
    WorkspaceRuntimeService, WorkspaceRuntimeTarget,
};
