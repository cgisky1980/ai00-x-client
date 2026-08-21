//! Conversation coordinator
//!
//! Top-level component that integrates all subsystems and provides a unified interface

use super::{scheduler::DialogSubmissionPolicy, turn_outcome::TurnOutcome};
use crate::agent::agents::get_agent_registry;
use crate::agent::core::{
    has_prompt_markup, Message, MessageContent, ProcessingPhase, PromptEnvelope, Session,
    SessionConfig, SessionKind, SessionState, SessionSummary, TurnStats, WorkflowPhaseState,
};
use crate::agent::events::{AgentEvent, EventPriority, EventQueue, EventRouter, EventSubscriber};
use crate::agent::execution::{
    ContextCompactionOutcome, ExecutionContext, ExecutionEngine, WorkflowPhase,
};
use crate::agent::image_analysis::ImageContextData;
use crate::agent::round_preempt::DialogRoundPreemptSource;
use crate::agent::session::SessionManager;
use crate::agent::tools::pipeline::{SubagentParentInfo, ToolPipeline};
use crate::agent::WorkspaceBinding;
use crate::infrastructure::try_get_path_manager_arc;
use crate::service::config::get_global_config_service;
use crate::util::errors::{Ai00XError, Ai00XResult};
use futures::FutureExt;
use log::{debug, error, info, warn};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration, Instant};
use tokio_util::sync::CancellationToken;

const MANUAL_COMPACTION_COMMAND: &str = "/compact";
const CONTEXT_COMPRESSION_TOOL_NAME: &str = "ContextCompression";

/// Subagent execution result
///
/// Contains the text response after subagent execution
#[derive(Debug, Clone)]
pub struct SubagentResult {
    /// AI text response
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogTriggerSource {
    DesktopUi,
    DesktopApi,
    AgentSession,
    ScheduledJob,
    RemoteRelay,
    Bot,
    Cli,
}

/// Cancel token cleanup guard
///
/// Automatically cleans up cancel tokens in ExecutionEngine when dropped
struct CancelTokenGuard {
    execution_engine: Arc<ExecutionEngine>,
    dialog_turn_id: String,
}

impl Drop for CancelTokenGuard {
    fn drop(&mut self) {
        let execution_engine = self.execution_engine.clone();
        let dialog_turn_id = self.dialog_turn_id.clone();

        tokio::spawn(async move {
            execution_engine.cleanup_cancel_token(&dialog_turn_id).await;
        });
    }
}

/// Conversation coordinator
pub struct ConversationCoordinator {
    session_manager: Arc<SessionManager>,
    execution_engine: Arc<ExecutionEngine>,
    tool_pipeline: Arc<ToolPipeline>,
    event_queue: Arc<EventQueue>,
    event_router: Arc<EventRouter>,
    /// Notifies DialogScheduler of turn outcomes; injected after construction
    scheduler_notify_tx: OnceLock<mpsc::Sender<(String, TurnOutcome)>>,
    /// Round-boundary yield (same source as scheduler's yield flags); injected after construction
    round_preempt_source: OnceLock<Arc<dyn DialogRoundPreemptSource>>,
}

impl ConversationCoordinator {
    /// Build a workspace binding that is remote-aware.
    /// If the global remote workspace is active and matches the session path,
    /// returns a `WorkspaceBinding` with remote metadata and correct local
    /// session storage path.
    async fn build_workspace_binding(config: &SessionConfig) -> Option<WorkspaceBinding> {
        let workspace_path = config.workspace_path.as_ref()?;
        let mut path_buf = PathBuf::from(workspace_path);

        if let Some(branch) = config.sandbox_branch.as_deref() {
            let task_checkout_path = path_buf.join(".tasks").join(branch.replace('/', "-"));
            if tokio::fs::metadata(&task_checkout_path).await.is_ok() {
                path_buf = task_checkout_path;
            } else {
                warn!(
                    "build_workspace_binding: task checkout directory missing for branch '{}' at {:?}, refusing to bind workspace",
                    branch, task_checkout_path
                );
                return None;
            }
        }

        let identity =
            crate::service::remote_ssh::workspace_state::resolve_workspace_session_identity(
                workspace_path,
                config.remote_connection_id.as_deref(),
                config.remote_ssh_host.as_deref(),
            )
            .await?;

        if let Some(rid) = identity.remote_connection_id.as_deref() {
            let connection_name =
                crate::service::remote_ssh::workspace_state::lookup_remote_connection_with_hint(
                    workspace_path,
                    Some(rid),
                )
                .await
                .map(|e| e.connection_name)
                .unwrap_or_else(|| rid.to_string());

            return Some(WorkspaceBinding::new_remote(
                None,
                path_buf,
                rid.to_string(),
                connection_name,
                identity,
            ));
        }

        Some(WorkspaceBinding::new(None, path_buf))
    }

    /// Build `WorkspaceServices` from a resolved `WorkspaceBinding`.
    /// For remote bindings, wires up SSH-backed FS/shell; for local ones,
    /// returns local implementations.
    async fn build_workspace_services(
        binding: &Option<WorkspaceBinding>,
    ) -> Option<crate::agent::workspace::WorkspaceServices> {
        let binding = binding.as_ref()?;

        if binding.is_remote() {
            let manager =
                match crate::service::remote_ssh::workspace_state::get_remote_workspace_manager() {
                    Some(m) => m,
                    None => {
                        log::warn!(
                            "build_workspace_services: RemoteWorkspaceStateManager not initialized"
                        );
                        return None;
                    }
                };
            let ssh_manager = match manager.get_ssh_manager().await {
                Some(m) => m,
                None => {
                    log::warn!(
                        "build_workspace_services: SSH manager not available in state manager"
                    );
                    return None;
                }
            };
            let file_service = match manager.get_file_service().await {
                Some(f) => f,
                None => {
                    log::warn!(
                        "build_workspace_services: File service not available in state manager"
                    );
                    return None;
                }
            };
            let connection_id = match binding.connection_id() {
                Some(id) => id.to_string(),
                None => {
                    log::warn!("build_workspace_services: No connection_id in workspace binding");
                    return None;
                }
            };
            log::info!(
                "build_workspace_services: Built remote services for connection_id={}",
                connection_id
            );
            Some(crate::agent::workspace::remote_workspace_services(
                connection_id,
                file_service,
                ssh_manager,
                binding.root_path_string(),
            ))
        } else {
            Some(crate::agent::workspace::local_workspace_services())
        }
    }

    fn normalize_agent_type(agent_type: &str) -> String {
        let trimmed = agent_type.trim();
        if trimmed.is_empty() {
            return "Code".to_string();
        }
        match trimmed {
            "agentic" | "Agentic" | "AGENTIC" | "Cowork" | "cowork" | "code" | "Core" => {
                "Code".to_string()
            }
            "task" => "Task".to_string(),
            "wall" => "Wallpaper".to_string(),
            _ => trimmed.to_string(),
        }
    }

    fn ensure_user_message_metadata_object(
        metadata: Option<serde_json::Value>,
    ) -> serde_json::Value {
        match metadata {
            Some(value) if value.is_object() => value,
            Some(value) => serde_json::json!({ "raw_metadata": value }),
            None => serde_json::json!({}),
        }
    }

    fn estimate_context_tokens(messages: &[Message]) -> usize {
        let mut cloned = messages.to_vec();
        cloned.iter_mut().map(|message| message.get_tokens()).sum()
    }

    fn manual_compaction_metadata() -> serde_json::Value {
        serde_json::json!({
            "kind": "manual_compaction",
            "command": MANUAL_COMPACTION_COMMAND,
        })
    }

    fn build_manual_compaction_round_completed(
        turn_id: &str,
        outcome: &ContextCompactionOutcome,
        context_window: usize,
        threshold: f32,
    ) -> crate::service::session::ModelRoundData {
        use crate::service::session::{ModelRoundData, ToolCallData, ToolItemData, ToolResultData};

        let completed_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let started_at = completed_at.saturating_sub(outcome.duration_ms);

        ModelRoundData {
            id: format!("{}-manual-compaction-round", turn_id),
            turn_id: turn_id.to_string(),
            round_index: 0,
            timestamp: started_at,
            text_items: Vec::new(),
            tool_items: vec![ToolItemData {
                id: outcome.compression_id.clone(),
                tool_name: CONTEXT_COMPRESSION_TOOL_NAME.to_string(),
                tool_call: ToolCallData {
                    input: serde_json::json!({
                        "trigger": "manual",
                        "tokens_before": outcome.tokens_before,
                        "context_window": context_window,
                        "threshold": threshold,
                    }),
                    id: outcome.compression_id.clone(),
                },
                tool_result: Some(ToolResultData {
                    result: serde_json::json!({
                        "compression_count": outcome.compression_count,
                        "tokens_before": outcome.tokens_before,
                        "tokens_after": outcome.tokens_after,
                        "compression_ratio": outcome.compression_ratio,
                        "duration": outcome.duration_ms,
                        "applied": outcome.applied,
                        "has_summary": outcome.has_summary,
                        "summary_source": outcome.summary_source,
                    }),
                    success: true,
                    result_for_assistant: None,
                    error: None,
                    duration_ms: Some(outcome.duration_ms),
                }),
                ai_intent: None,
                start_time: started_at,
                end_time: Some(completed_at),
                duration_ms: Some(outcome.duration_ms),
                order_index: Some(0),
                is_subagent_item: None,
                parent_task_tool_id: None,
                subagent_session_id: None,
                status: Some("completed".to_string()),
            }],
            thinking_items: Vec::new(),
            start_time: started_at,
            end_time: Some(completed_at),
            status: "completed".to_string(),
            model_id: None,
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
        }
    }

    fn build_manual_compaction_round_failed(
        turn_id: &str,
        compression_id: String,
        error: &str,
        context_window: usize,
        threshold: f32,
    ) -> crate::service::session::ModelRoundData {
        use crate::service::session::{ModelRoundData, ToolCallData, ToolItemData, ToolResultData};

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        ModelRoundData {
            id: format!("{}-manual-compaction-round", turn_id),
            turn_id: turn_id.to_string(),
            round_index: 0,
            timestamp,
            text_items: Vec::new(),
            tool_items: vec![ToolItemData {
                id: compression_id.clone(),
                tool_name: CONTEXT_COMPRESSION_TOOL_NAME.to_string(),
                tool_call: ToolCallData {
                    input: serde_json::json!({
                        "trigger": "manual",
                        "context_window": context_window,
                        "threshold": threshold,
                        "summary_source": "none",
                    }),
                    id: compression_id,
                },
                tool_result: Some(ToolResultData {
                    result: serde_json::Value::Null,
                    success: false,
                    result_for_assistant: None,
                    error: Some(error.to_string()),
                    duration_ms: None,
                }),
                ai_intent: None,
                start_time: timestamp,
                end_time: Some(timestamp),
                duration_ms: Some(0),
                order_index: Some(0),
                is_subagent_item: None,
                parent_task_tool_id: None,
                subagent_session_id: None,
                status: Some("error".to_string()),
            }],
            thinking_items: Vec::new(),
            start_time: timestamp,
            end_time: Some(timestamp),
            status: "error".to_string(),
            model_id: None,
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
        }
    }

    pub fn new(
        session_manager: Arc<SessionManager>,
        execution_engine: Arc<ExecutionEngine>,
        tool_pipeline: Arc<ToolPipeline>,
        event_queue: Arc<EventQueue>,
        event_router: Arc<EventRouter>,
    ) -> Self {
        Self {
            session_manager,
            execution_engine,
            tool_pipeline,
            event_queue,
            event_router,
            scheduler_notify_tx: OnceLock::new(),
            round_preempt_source: OnceLock::new(),
        }
    }

    /// Inject the DialogScheduler notification channel after construction.
    /// Called once during app initialization after the scheduler is created.
    pub fn set_scheduler_notifier(&self, tx: mpsc::Sender<(String, TurnOutcome)>) {
        let _ = self.scheduler_notify_tx.set(tx);
    }

    /// Wire round-boundary preempt (typically the scheduler's [`SessionRoundYieldFlags`](crate::agent::round_preempt::SessionRoundYieldFlags)).
    pub fn set_round_preempt_source(&self, source: Arc<dyn DialogRoundPreemptSource>) {
        let _ = self.round_preempt_source.set(source);
    }

    /// Create a new session with optional session ID and workspace binding.
    /// `workspace_path` is forwarded in the `SessionCreated` event and also stored
    /// in the session's in-memory config so it can be retrieved without disk access.
    pub async fn create_session_with_workspace(
        &self,
        session_id: Option<String>,
        session_name: String,
        agent_type: String,
        config: SessionConfig,
        workspace_path: String,
    ) -> Ai00XResult<Session> {
        self.create_session_with_workspace_and_creator(
            session_id,
            session_name,
            agent_type,
            config,
            workspace_path,
            None,
        )
        .await
    }

    pub async fn update_session_model(&self, session_id: &str, model_id: &str) -> Ai00XResult<()> {
        let normalized_model_id = model_id.trim();
        let normalized_model_id = if normalized_model_id.is_empty() {
            "auto"
        } else {
            normalized_model_id
        };

        self.session_manager
            .update_session_model_id(session_id, normalized_model_id)
            .await?;

        info!(
            "Coordinator updated session model: session_id={}, model_id={}",
            session_id, normalized_model_id
        );

        Ok(())
    }

    /// Create a new session with explicit creator identity.
    pub async fn create_session_with_workspace_and_creator(
        &self,
        session_id: Option<String>,
        session_name: String,
        agent_type: String,
        mut config: SessionConfig,
        workspace_path: String,
        created_by: Option<String>,
    ) -> Ai00XResult<Session> {
        // Persist the workspace binding inside the session config so execution can
        // consistently restore the correct workspace regardless of the entry point.
        config.workspace_path = Some(workspace_path.clone());
        let agent_type = Self::normalize_agent_type(&agent_type);
        let session = self
            .session_manager
            .create_session_with_id_and_creator(
                session_id,
                session_name,
                agent_type,
                config,
                created_by,
            )
            .await?;

        // SessionManager::create_session_with_id_and_creator already persists the
        // session into the effective workspace session storage path. Avoid writing
        // a second copy here using the raw workspace path, because remote workspaces
        // resolve to a different effective storage path and double-writing can leave
        // metadata/turn files split across two locations.

        // Generate default PLAN.md for the new session
        let plan_file_name = "PLAN.md".to_string();
        let now_iso = chrono::Utc::now().to_rfc3339();
        let default_plan_content = format!(
            "---\nname: {}\noverview: {}\nstatus: planning\ncreated_at: {}\nupdated_at: {}\ntodos: []\n---\n\n# {}\n\n> This is a default plan template. Call `CreatePlan` to create a proper plan.\n\n## Background\n\n_TODO: Describe why this task is needed_\n\n## Implementation Plan\n\n_TODO: Fill in the implementation approach_\n\n## Execution Strategy\n\n_TODO: List the steps and identify tasks suitable for parallel execution_\n\n## File Changes\n\n_TODO: List files that will be modified_\n\n## Open Questions\n\n_TODO: List questions clarified through user communication_\n",
            session.session_name,
            session.session_name,
            now_iso,
            now_iso,
            session.session_name,
        );

        if let Ok(path_manager) = try_get_path_manager_arc() {
            let sessions_dir = path_manager.project_sessions_dir(Path::new(&workspace_path));
            let session_dir = sessions_dir.join(&session.session_id);
            if tokio::fs::create_dir_all(&session_dir).await.is_ok() {
                let plan_file_abs = session_dir.join(&plan_file_name);
                if tokio::fs::write(&plan_file_abs, &default_plan_content)
                    .await
                    .is_ok()
                {
                    let plan_ref = format!("sessions/{}/{}", session.session_id, plan_file_name);
                    let plans_dir = path_manager.project_plans_dir(Path::new(&workspace_path));
                    let _ = self
                        .session_manager
                        .update_workflow_phase(
                            &session.session_id,
                            Some(WorkflowPhaseState {
                                phase: WorkflowPhase::Planning,
                                plan_file_path: Some(plan_ref),
                                plans_dir: Some(plans_dir.to_string_lossy().to_string()),
                                updated_at: Some(std::time::SystemTime::now()),
                            }),
                        )
                        .await;
                }
            }
        }

        self.emit_event(AgentEvent::SessionCreated {
            session_id: session.session_id.clone(),
            session_name: session.session_name.clone(),
            agent_type: session.agent_type.clone(),
            workspace_path: Some(workspace_path),
        })
        .await;
        Ok(session)
    }

    /// Ensure the completed/failed/cancelled turn is persisted to the workspace
    /// session storage. If the frontend already saved a richer version
    /// during streaming, we only update the final status; otherwise we create
    /// a minimal record with the user message so the turn is never lost.
    /// Safety-net persistence: only creates a minimal record when the frontend
    /// has not saved anything yet.  The frontend's PersistenceModule is the
    /// authoritative writer for turn content (model rounds, text, tools, etc.)
    /// and final status.  This function must NOT overwrite frontend-managed
    /// data, because the spawned task always runs before the frontend receives
    /// the DialogTurnCompleted event via the transport layer, and the existing
    /// disk data from debounced saves may have incomplete model rounds.
    async fn finalize_turn_in_workspace(
        session_id: &str,
        turn_id: &str,
        turn_index: usize,
        user_input: &str,
        workspace_path: &str,
        status: crate::service::session::TurnStatus,
        user_message_metadata: Option<serde_json::Value>,
    ) {
        use crate::agent::persistence::PersistenceManager;
        use crate::infrastructure::PathManager;
        use crate::service::session::{
            DialogTurnData, SessionMetadata, SessionStatus, UserMessageData,
        };

        let path_manager = match PathManager::new() {
            Ok(pm) => std::sync::Arc::new(pm),
            Err(_) => return,
        };

        let workspace_path_buf = {
            let identity =
                crate::service::remote_ssh::workspace_state::resolve_workspace_session_identity(
                    workspace_path,
                    None,
                    None,
                )
                .await;
            identity
                .as_ref()
                .map(|id| id.session_storage_path().to_path_buf())
                .unwrap_or_else(|| std::path::PathBuf::from(workspace_path))
        };
        let persistence_manager = match PersistenceManager::new(path_manager) {
            Ok(manager) => manager,
            Err(_) => return,
        };

        if let Ok(Some(_existing)) = persistence_manager
            .load_dialog_turn(&workspace_path_buf, session_id, turn_index)
            .await
        {
            return;
        }

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        if let Ok(None) = persistence_manager
            .load_session_metadata(&workspace_path_buf, session_id)
            .await
        {
            let metadata = SessionMetadata {
                session_id: session_id.to_string(),
                session_name: "Recovered Task".to_string(),
                agent_type: "Core".to_string(),
                created_by: None,
                session_kind: SessionKind::Standard,
                model_name: "default".to_string(),
                created_at: now_ms,
                last_active_at: now_ms,
                turn_count: 0,
                message_count: 0,
                tool_call_count: 0,
                status: SessionStatus::Active,
                terminal_session_id: None,
                snapshot_session_id: None,
                tags: Vec::new(),
                custom_metadata: None,
                todos: None,
                plan_rating: None,
                plan_feedback: None,
                complete_rating: None,
                complete_feedback: None,
                rated_at: None,
                workspace_path: Some(workspace_path.to_string()),
                workspace_hostname: None,
                sandbox_branch: None,
            };
            if let Err(e) = persistence_manager
                .save_session_metadata(&workspace_path_buf, &metadata)
                .await
            {
                warn!(
                    "Failed to create fallback session metadata during turn finalization: session_id={}, error={}",
                    session_id, e
                );
                // Do not return: on read-only or transient IO errors we still try to persist the
                // minimal dialog turn so local/remote UI history is not silently empty.
            }
        }

        let mut turn_data = DialogTurnData::new(
            turn_id.to_string(),
            turn_index,
            session_id.to_string(),
            UserMessageData {
                id: format!("{}-user", turn_id),
                content: user_input.to_string(),
                timestamp: now_ms,
                metadata: user_message_metadata,
            },
        );
        turn_data.status = status;
        turn_data.end_time = Some(now_ms);
        turn_data.duration_ms = Some(now_ms.saturating_sub(turn_data.start_time));

        if let Err(e) = persistence_manager
            .save_dialog_turn(&workspace_path_buf, &turn_data)
            .await
        {
            warn!(
                "Failed to finalize turn in workspace: session_id={}, turn_index={}, error={}",
                session_id, turn_index, e
            );
        }
    }

    /// Create a subagent session for internal AI execution.
    /// Unlike `create_session`, this does NOT emit `SessionCreated` to the transport layer,
    /// because subagent sessions are internal implementation details of the execution engine
    /// and must never appear as top-level items in the UI.
    async fn create_subagent_session(
        &self,
        session_name: String,
        agent_type: String,
        config: SessionConfig,
        parent_info: &SubagentParentInfo,
    ) -> Ai00XResult<Session> {
        self.session_manager
            .create_session_with_id_and_details(
                None,
                session_name,
                agent_type,
                config,
                Some(format!("session-{}", parent_info.session_id)),
                SessionKind::Subagent,
            )
            .await
    }

    async fn wrap_user_input(
        &self,
        agent_type: &str,
        user_input: String,
        workspace: Option<&WorkspaceBinding>,
    ) -> Ai00XResult<String> {
        let agent_registry = get_agent_registry();
        if let Some(workspace) = workspace {
            agent_registry
                .load_custom_subagents(workspace.root_path())
                .await;
        }
        let current_agent = agent_registry
            .get_agent(agent_type, workspace.map(|binding| binding.root_path()))
            .ok_or_else(|| Ai00XError::NotFound(format!("Agent not found: {}", agent_type)))?;
        let system_reminder = current_agent.get_system_reminder(0).await?;

        let mut wrapped_user_input = if has_prompt_markup(&user_input) {
            user_input
        } else {
            let mut envelope = PromptEnvelope::new();
            envelope.push_user_query(user_input);
            envelope.render()
        };
        if !system_reminder.is_empty() {
            let mut envelope = PromptEnvelope::new();
            envelope.push_system_reminder(system_reminder);
            if !wrapped_user_input.is_empty() {
                wrapped_user_input.push('\n');
            }
            wrapped_user_input.push_str(&envelope.render());
        }
        Ok(wrapped_user_input)
    }

    /// Start a new dialog turn
    /// Note: Events are sent to frontend via EventLoop, no Stream returned.
    /// Submission behavior is controlled by `submission_policy`, which provides
    /// default per-source behavior while still allowing selective overrides.
    #[allow(clippy::too_many_arguments)]
    pub async fn start_dialog_turn(
        &self,
        session_id: String,
        user_input: String,
        original_user_input: Option<String>,
        turn_id: Option<String>,
        agent_type: String,
        workspace_path: Option<String>,
        submission_policy: DialogSubmissionPolicy,
    ) -> Ai00XResult<()> {
        self.start_dialog_turn_internal(
            session_id,
            user_input,
            original_user_input,
            None,
            turn_id,
            agent_type,
            workspace_path,
            submission_policy,
            None,
            false,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_dialog_turn_with_image_contexts(
        &self,
        session_id: String,
        user_input: String,
        original_user_input: Option<String>,
        image_contexts: Vec<ImageContextData>,
        turn_id: Option<String>,
        agent_type: String,
        workspace_path: Option<String>,
        submission_policy: DialogSubmissionPolicy,
    ) -> Ai00XResult<()> {
        self.start_dialog_turn_internal(
            session_id,
            user_input,
            original_user_input,
            Some(image_contexts),
            turn_id,
            agent_type,
            workspace_path,
            submission_policy,
            None,
            false,
        )
        .await
    }

    /// Compact the active session context as a persisted maintenance turn.
    pub async fn compact_session_manually(&self, session_id: String) -> Ai00XResult<()> {
        let session = self
            .session_manager
            .get_session(&session_id)
            .ok_or_else(|| Ai00XError::NotFound(format!("Task not found: {}", session_id)))?;

        match &session.state {
            SessionState::Idle => {}
            SessionState::Processing {
                current_turn_id,
                phase,
            } => {
                return Err(Ai00XError::Validation(format!(
                    "Task is still processing: current_turn_id={}, phase={:?}",
                    current_turn_id, phase
                )));
            }
            SessionState::Error { error, .. } => {
                return Err(Ai00XError::Validation(format!(
                    "Task must be idle before manual compaction: {}",
                    error
                )));
            }
        }

        let context_messages = self
            .session_manager
            .get_context_messages(&session_id)
            .await?;
        let needs_restore = if context_messages.is_empty() {
            true
        } else {
            context_messages.len() == 1 && !session.dialog_turn_ids.is_empty()
        };

        if needs_restore {
            let workspace_path = session.config.workspace_path.as_deref().ok_or_else(|| {
                Ai00XError::Validation(format!(
                    "workspace_path is required when restoring task: {}",
                    session_id
                ))
            })?;
            self.session_manager
                .restore_session(Path::new(workspace_path), &session_id)
                .await?;
        }

        let context_messages = self
            .session_manager
            .get_context_messages(&session_id)
            .await?;
        let turn_index = self.session_manager.get_turn_count(&session_id);
        let user_message_metadata = Some(Self::manual_compaction_metadata());
        let turn_id = self
            .session_manager
            .start_maintenance_turn(
                &session_id,
                MANUAL_COMPACTION_COMMAND.to_string(),
                None,
                user_message_metadata.clone(),
            )
            .await?;

        self.emit_event(AgentEvent::DialogTurnStarted {
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            turn_index,
            user_input: MANUAL_COMPACTION_COMMAND.to_string(),
            original_user_input: None,
            user_message_metadata: user_message_metadata.clone(),
            subagent_parent_info: None,
        })
        .await;

        let current_tokens = Self::estimate_context_tokens(&context_messages);
        let session_max_tokens = session.config.max_context_tokens;

        // Unify context_window: min(model capability, session config)
        let model_context_window =
            match crate::infrastructure::ai::get_global_ai_client_factory().await {
                Ok(factory) => {
                    let model_id = session.config.model_id.as_deref().unwrap_or("default");
                    match factory.get_client_resolved(model_id).await {
                        Ok(client) => Some(client.config.context_window as usize),
                        Err(_) => None,
                    }
                }
                Err(_) => None,
            };
        let context_window = match model_context_window {
            Some(mcw) => mcw.min(session_max_tokens),
            None => session_max_tokens,
        };
        let compression_threshold = session.config.compression_threshold;

        match self
            .execution_engine
            .compact_session_context(
                &session_id,
                &turn_id,
                context_messages,
                current_tokens,
                context_window,
                "manual",
                crate::agent::session::CompressionTailPolicy::CollapseAll,
            )
            .await
        {
            Ok(outcome) => {
                let model_round = Self::build_manual_compaction_round_completed(
                    &turn_id,
                    &outcome,
                    context_window,
                    compression_threshold,
                );
                self.session_manager
                    .complete_maintenance_turn(
                        &session_id,
                        &turn_id,
                        vec![model_round],
                        outcome.duration_ms,
                    )
                    .await?;
                self.session_manager
                    .update_session_state(&session_id, SessionState::Idle)
                    .await?;

                self.emit_event(AgentEvent::DialogTurnCompleted {
                    session_id,
                    turn_id,
                    total_rounds: 1,
                    total_tools: 1,
                    duration_ms: outcome.duration_ms,
                    subagent_parent_info: None,
                })
                .await;

                Ok(())
            }
            Err(err) => {
                let error_text = err.to_string();
                let compression_id = format!("compression_{}", uuid::Uuid::new_v4());
                let model_round = Self::build_manual_compaction_round_failed(
                    &turn_id,
                    compression_id,
                    &error_text,
                    context_window,
                    compression_threshold,
                );
                let _ = self
                    .session_manager
                    .fail_maintenance_turn(
                        &session_id,
                        &turn_id,
                        error_text.clone(),
                        vec![model_round],
                    )
                    .await;
                let _ = self
                    .session_manager
                    .update_session_state(&session_id, SessionState::Idle)
                    .await;
                self.emit_event(AgentEvent::DialogTurnFailed {
                    session_id,
                    turn_id,
                    error: error_text.clone(),
                    subagent_parent_info: None,
                })
                .await;
                Err(err)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn start_dialog_turn_internal(
        &self,
        session_id: String,
        user_input: String,
        original_user_input: Option<String>,
        image_contexts: Option<Vec<ImageContextData>>,
        turn_id: Option<String>,
        agent_type: String,
        workspace_path: Option<String>,
        submission_policy: DialogSubmissionPolicy,
        extra_user_message_metadata: Option<serde_json::Value>,
        suppress_session_title_generation: bool,
    ) -> Ai00XResult<()> {
        // Get latest session, restoring from persistence on demand so every entry
        // point can use the same start_dialog_turn flow.
        let session = match self.session_manager.get_session(&session_id) {
            Some(session) => session,
            None => {
                debug!(
                    "Session not found in memory, attempting restore before starting dialog: session_id={}",
                    session_id
                );
                let workspace_path = workspace_path.clone().ok_or_else(|| {
                    Ai00XError::Validation(format!(
                        "workspace_path is required when restoring task: {}",
                        session_id
                    ))
                })?;
                self.session_manager
                    .restore_session(Path::new(&workspace_path), &session_id)
                    .await?
            }
        };

        let requested_agent_type = agent_type.trim().to_string();
        let provisional_agent_type = if !requested_agent_type.is_empty() {
            requested_agent_type.clone()
        } else if !session.agent_type.is_empty() {
            session.agent_type.clone()
        } else {
            "Core".to_string()
        };
        let effective_agent_type = Self::normalize_agent_type(&provisional_agent_type);

        debug!(
            "Resolved dialog turn agent type: session_id={}, turn_id={}, requested_agent_type={}, session_agent_type={}, effective_agent_type={}, trigger_source={:?}, queue_priority={:?}, skip_tool_confirmation={}",
            session_id,
            turn_id.as_deref().unwrap_or(""),
            if requested_agent_type.is_empty() {
                "<empty>"
            } else {
                requested_agent_type.as_str()
            },
            if session.agent_type.is_empty() {
                "<empty>"
            } else {
                session.agent_type.as_str()
            },
            effective_agent_type,
            submission_policy.trigger_source,
            submission_policy.queue_priority,
            submission_policy.skip_tool_confirmation
        );

        if session.agent_type != effective_agent_type {
            self.session_manager
                .update_session_agent_type(&session_id, &effective_agent_type)
                .await?;
        }

        debug!(
            "Checking session state: session_id={}, state={:?}",
            session_id, session.state
        );

        // Check session state
        // Allow Idle or any error state (user can retry after error)
        // If Processing, cancel request hasn't arrived yet, reject new dialog
        match &session.state {
            SessionState::Idle => {
                debug!(
                    "Session state is Idle, allowing new dialog: session_id={}",
                    session_id
                );
            }
            SessionState::Error { .. } => {
                debug!(
                    "Session in error state, allowing new dialog (user retry): session_id={}",
                    session_id
                );
            }
            SessionState::Processing {
                current_turn_id,
                phase,
            } => {
                warn!(
                    "Session still processing, rejecting new dialog: session_id={}, current_turn_id={}, phase={:?}",
                    session_id,
                    current_turn_id,
                    phase
                );
                return Err(Ai00XError::Validation(format!(
                    "Task state does not allow starting new dialog: {:?}",
                    session.state
                )));
            }
        }

        if let Some(ref wp) = session.workflow_phase {
            if wp.phase == WorkflowPhase::AwaitingPlanConfirmation {
                warn!(
                    "Session is awaiting plan confirmation, rejecting new dialog: session_id={}",
                    session_id
                );
                return Err(Ai00XError::Validation(
                    "Plan is awaiting confirmation. Please confirm or revise the plan first."
                        .to_string(),
                ));
            }
        }

        // Ensure session history is loaded into memory
        // Critical fix: prevent unloaded history after app restart
        let context_messages = self
            .session_manager
            .get_context_messages(&session_id)
            .await?;

        // Check if restore is needed:
        // - Empty context needs restore
        // - Only 1 message (likely just system prompt) with existing turns needs restore
        // - Sessions with multiple turns should have > 1 messages (at least system + user + assistant)
        let needs_restore = if context_messages.is_empty() {
            debug!(
                "Session {} context is empty, restoring from persistence",
                session_id
            );
            true
        } else if context_messages.len() == 1 && !session.dialog_turn_ids.is_empty() {
            debug!(
                "Session {} has {} turns but only {} messages, restoring history",
                session_id,
                session.dialog_turn_ids.len(),
                context_messages.len()
            );
            true
        } else {
            debug!(
                "Session {} context exists ({} messages, {} turns), no restore needed",
                session_id,
                context_messages.len(),
                session.dialog_turn_ids.len()
            );
            false
        };

        if needs_restore {
            debug!(
                "Starting session history restore: session_id={}",
                session_id
            );
            match self
                .session_manager
                .restore_session(
                    Path::new(
                        session
                            .config
                            .workspace_path
                            .as_deref()
                            .or(workspace_path.as_deref())
                            .ok_or_else(|| {
                                Ai00XError::Validation(format!(
                                    "workspace_path is required when restoring task: {}",
                                    session_id
                                ))
                            })?,
                    ),
                    &session_id,
                )
                .await
            {
                Ok(_) => {
                    let restored_messages = self
                        .session_manager
                        .get_context_messages(&session_id)
                        .await?;
                    info!(
                        "Session history restored from persistence: session_id={}, messages: {} -> {}",
                        session_id,
                        context_messages.len(),
                        restored_messages.len()
                    );
                }
                Err(e) => {
                    debug!(
                        "Failed to restore session history (may be new session): session_id={}, error={}",
                        session_id,
                        e
                    );
                }
            }
        }

        let original_user_input = original_user_input.unwrap_or_else(|| user_input.clone());

        let mut user_message_metadata = extra_user_message_metadata;

        // Build image metadata for workspace turn persistence (before image_contexts is consumed)
        // Also stores original_text so the UI can display the user's actual input
        // instead of the vision-enhanced text.
        if let Some(imgs) = image_contexts.as_ref().filter(|imgs| !imgs.is_empty()) {
            let image_meta: Vec<serde_json::Value> = imgs
                .iter()
                .map(|img| {
                    let name = img
                        .metadata
                        .as_ref()
                        .and_then(|m| m.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("image.png");
                    let mut meta = serde_json::json!({
                        "id": &img.id,
                        "name": name,
                        "mime_type": &img.mime_type,
                    });
                    if let Some(url) = &img.data_url {
                        meta["data_url"] = serde_json::json!(url);
                    }
                    if let Some(path) = &img.image_path {
                        meta["image_path"] = serde_json::json!(path);
                    }
                    meta
                })
                .collect();

            let mut metadata =
                Self::ensure_user_message_metadata_object(user_message_metadata.take());
            if let Some(obj) = metadata.as_object_mut() {
                obj.insert("images".to_string(), serde_json::json!(image_meta));
                obj.insert(
                    "original_text".to_string(),
                    serde_json::json!(original_user_input.clone()),
                );
            }
            user_message_metadata = Some(metadata);
        }

        let session_workspace = Self::build_workspace_binding(&session.config).await;

        // Build WorkspaceServices based on the workspace type
        let workspace_services = Self::build_workspace_services(&session_workspace).await;

        info!(
            "Dialog turn workspace context: session_id={}, workspace_path={:?}, is_remote={}, workspace_services={}",
            session_id,
            session.config.workspace_path,
            session_workspace.as_ref().map(|ws| ws.is_remote()).unwrap_or(false),
            if workspace_services.is_some() { "available" } else { "NONE" }
        );

        let wrapped_user_input = self
            .wrap_user_input(
                &effective_agent_type,
                user_input,
                session_workspace.as_ref(),
            )
            .await?;

        if original_user_input != wrapped_user_input {
            let mut metadata =
                Self::ensure_user_message_metadata_object(user_message_metadata.take());
            if let Some(obj) = metadata.as_object_mut() {
                obj.insert(
                    "original_text".to_string(),
                    serde_json::json!(original_user_input.clone()),
                );
            }
            user_message_metadata = Some(metadata);
        }

        // Start new dialog turn (sets state to Processing internally)
        let turn_index = self.session_manager.get_turn_count(&session_id);
        // Pass frontend turnId, generate if not provided
        let turn_id = self
            .session_manager
            .start_dialog_turn(
                &session_id,
                wrapped_user_input.clone(),
                turn_id,
                image_contexts,
                user_message_metadata.clone(),
            )
            .await?;

        error!(
            "[AI00X-DIAG] turn created, about to spawn: session={}, turn={}",
            session_id, turn_id
        );

        // Send dialog turn started event with original input and image metadata
        // so all frontends (desktop, mobile, bot) can display correctly.
        self.emit_event(AgentEvent::DialogTurnStarted {
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            turn_index,
            user_input: wrapped_user_input.clone(),
            original_user_input: if original_user_input != wrapped_user_input {
                Some(original_user_input.clone())
            } else {
                None
            },
            user_message_metadata: user_message_metadata.clone(),
            subagent_parent_info: None,
        })
        .await;

        // Get context messages (re-fetch as history may have been restored)
        let messages = match self.session_manager.get_context_messages(&session_id).await {
            Ok(msgs) => msgs,
            Err(e) => {
                error!(
                    "Failed to get context messages after turn creation: session={}, turn={}, error={}",
                    session_id, turn_id, e
                );
                if let Err(fe) = self
                    .session_manager
                    .fail_dialog_turn(
                        &session_id,
                        &turn_id,
                        format!("context message load failed: {}", e),
                    )
                    .await
                {
                    error!(
                        "Failed to fail dialog turn as fallback: session={}, turn={}, error={}",
                        session_id, turn_id, fe
                    );
                }
                return Err(e);
            }
        };

        // Create execution context (pass full config and resource IDs)
        let mut context_vars = std::collections::HashMap::new();
        context_vars.insert(
            "max_context_tokens".to_string(),
            session.config.max_context_tokens.to_string(),
        );
        context_vars.insert(
            "enable_tools".to_string(),
            session.config.enable_tools.to_string(),
        );
        context_vars.insert(
            "original_user_input".to_string(),
            original_user_input.clone(),
        );

        // Pass model_id for token usage tracking
        if let Some(model_id) = &session.config.model_id {
            context_vars.insert("model_name".to_string(), model_id.clone());
        }

        // Pass snapshot session ID
        if let Some(snapshot_id) = &session.snapshot_session_id {
            context_vars.insert("snapshot_session_id".to_string(), snapshot_id.clone());
        }

        // Pass turn_index (for operation history/rollback)
        context_vars.insert("turn_index".to_string(), turn_index.to_string());
        let session_workspace_path = session.config.workspace_path.clone().or_else(|| {
            session_workspace
                .as_ref()
                .map(|workspace| workspace.root_path_string())
        });

        let execution_context = ExecutionContext {
            session_id: session_id.clone(),
            dialog_turn_id: turn_id.clone(),
            turn_index,
            agent_type: effective_agent_type.clone(),
            workspace: session_workspace,
            context: context_vars,
            subagent_parent_info: None,
            skip_tool_confirmation: submission_policy.skip_tool_confirmation,
            workspace_services,
            round_preempt: self.round_preempt_source.get().cloned(),
        };

        // Auto-generate session title on first message
        if turn_index == 0 && !suppress_session_title_generation {
            let sm = self.session_manager.clone();
            let eq = self.event_queue.clone();
            let sid = session_id.clone();
            let msg = original_user_input;
            let expected_title = self
                .session_manager
                .get_session(&session_id)
                .map(|session| session.session_name)
                .unwrap_or_default();
            tokio::spawn(async move {
                let allow_ai = is_ai_session_title_generation_enabled().await;
                let resolved = sm.resolve_session_title(&msg, Some(20), allow_ai).await;

                match sm
                    .update_session_title_if_current(&sid, &expected_title, &resolved.title)
                    .await
                {
                    Ok(true) => {
                        let _ = eq
                            .enqueue(
                                AgentEvent::SessionTitleGenerated {
                                    session_id: sid,
                                    title: resolved.title,
                                    method: resolved.method.as_str().to_string(),
                                },
                                Some(EventPriority::Normal),
                            )
                            .await;
                    }
                    Ok(false) => {
                        debug!("Skipped auto session title update because title changed");
                    }
                    Err(error) => {
                        debug!("Auto session title generation failed to apply: {error}");
                    }
                }
            });
        }

        // Start async execution task
        let session_manager = self.session_manager.clone();
        let execution_engine = self.execution_engine.clone();
        let event_queue = self.event_queue.clone();
        let session_id_clone = session_id.clone();
        let turn_id_clone = turn_id.clone();
        let user_input_for_workspace = wrapped_user_input.clone();
        let effective_agent_type_clone = effective_agent_type.clone();
        let user_message_metadata_clone = user_message_metadata;
        let scheduler_notify_tx = self.scheduler_notify_tx.get().cloned();

        tokio::spawn(async move {
            eprintln!("[TRACE] SPAWN_ENTER");
            let result = std::panic::AssertUnwindSafe(async {
                // Note: Don't check cancellation here as cancel token hasn't been created yet
                // Cancel token is created in execute_dialog_turn -> execute_round
                // execute_dialog_turn has proper cancellation checks internally

                if let Err(e) = session_manager
                    .update_session_state(
                        &session_id_clone,
                        SessionState::Processing {
                            current_turn_id: turn_id_clone.clone(),
                            phase: ProcessingPhase::Thinking,
                        },
                    )
                    .await
                {
                    error!(
                        "Failed to update session state to Processing: session={}, error={}",
                        session_id_clone, e
                    );
                }

                let workspace_turn_status = {
                    eprintln!("[TRACE] BEFORE_EXEC");
                    match execution_engine
                        .execute_dialog_turn(
                            effective_agent_type_clone,
                            messages,
                            execution_context,
                        )
                        .await
                    {
                        Ok(execution_result) => {
                            let final_response = match &execution_result.final_message.content {
                                MessageContent::Text(text) => text.clone(),
                                MessageContent::Mixed { text, .. } => text.clone(),
                                _ => String::new(),
                            };
                            info!(
                                "Dialog turn completed: session={}, turn={}, rounds={}",
                                session_id_clone, turn_id_clone, execution_result.total_rounds
                            );

                            if let Err(e) = session_manager
                                .complete_dialog_turn(
                                    &session_id_clone,
                                    &turn_id_clone,
                                    final_response.clone(),
                                    TurnStats {
                                        total_rounds: execution_result.total_rounds,
                                        total_tools: 0,
                                        total_tokens: 0,
                                        duration_ms: 0,
                                    },
                                )
                                .await
                            {
                                error!(
                                    "Failed to complete dialog turn: session={}, turn={}, error={}",
                                    session_id_clone, turn_id_clone, e
                                );
                                if let Err(e2) = session_manager
                                    .fail_dialog_turn(
                                        &session_id_clone,
                                        &turn_id_clone,
                                        e.to_string(),
                                    )
                                    .await
                                {
                                    error!(
                                "Failed to fail dialog turn as fallback: session={}, turn={}, error={}",
                                session_id_clone, turn_id_clone, e2
                            );
                                }
                            }

                            if let Err(e) = session_manager
                                .update_session_state(&session_id_clone, SessionState::Idle)
                                .await
                            {
                                error!(
                                    "Failed to update session state to Idle: session={}, error={}",
                                    session_id_clone, e
                                );
                            }

                            if let Some(tx) = &scheduler_notify_tx {
                                let _ = tx.try_send((
                                    session_id_clone.clone(),
                                    TurnOutcome::Completed {
                                        turn_id: turn_id_clone.clone(),
                                        final_response,
                                    },
                                ));
                            }

                            Some(crate::service::session::TurnStatus::Completed)
                        }
                        Err(e) => {
                            let is_cancellation = matches!(&e, Ai00XError::Cancelled(_));

                            if is_cancellation {
                                info!(
                                    "Dialog turn cancelled: session={}, turn={}",
                                    session_id_clone, turn_id_clone
                                );

                                // The execution engine only emits DialogTurnCancelled when
                                // cancellation is detected between rounds.  If cancellation
                                // interrupted streaming mid-round, no event was emitted.
                                // Emit it here unconditionally (duplicates are harmless).
                                let _ = event_queue
                                    .enqueue(
                                        AgentEvent::DialogTurnCancelled {
                                            session_id: session_id_clone.clone(),
                                            turn_id: turn_id_clone.clone(),
                                            subagent_parent_info: None,
                                        },
                                        Some(EventPriority::Critical),
                                    )
                                    .await;

                                // Mark the turn as completed in persistence so its partial
                                // content appears in historical messages (turns_to_chat_messages
                                // skips InProgress turns).
                                if let Err(e) = session_manager
                                    .complete_dialog_turn(
                                        &session_id_clone,
                                        &turn_id_clone,
                                        String::new(),
                                        TurnStats {
                                            total_rounds: 0,
                                            total_tools: 0,
                                            total_tokens: 0,
                                            duration_ms: 0,
                                        },
                                    )
                                    .await
                                {
                                    error!(
                                "Failed to complete dialog turn (cancellation): session={}, turn={}, error={}",
                                session_id_clone, turn_id_clone, e
                            );
                                    if let Err(e2) = session_manager
                                        .fail_dialog_turn(
                                            &session_id_clone,
                                            &turn_id_clone,
                                            e.to_string(),
                                        )
                                        .await
                                    {
                                        error!(
                                    "Failed to fail dialog turn as fallback (cancellation): session={}, turn={}, error={}",
                                    session_id_clone, turn_id_clone, e2
                                );
                                    }
                                }

                                if let Err(e) = session_manager
                                    .update_session_state(&session_id_clone, SessionState::Idle)
                                    .await
                                {
                                    error!(
                                "Failed to update session state to Idle (cancellation): session={}, error={}",
                                session_id_clone, e
                            );
                                }

                                if let Some(tx) = &scheduler_notify_tx {
                                    let _ = tx.try_send((
                                        session_id_clone.clone(),
                                        TurnOutcome::Cancelled {
                                            turn_id: turn_id_clone.clone(),
                                        },
                                    ));
                                }

                                Some(crate::service::session::TurnStatus::Cancelled)
                            } else {
                                let error_text = e.to_string();
                                error!("Dialog turn execution failed: {}", error_text);

                                let recoverable =
                                    !matches!(&e, Ai00XError::AIClient(_) | Ai00XError::Timeout(_));

                                let _ = event_queue
                                    .enqueue(
                                        AgentEvent::DialogTurnFailed {
                                            session_id: session_id_clone.clone(),
                                            turn_id: turn_id_clone.clone(),
                                            error: error_text.clone(),
                                            subagent_parent_info: None,
                                        },
                                        Some(EventPriority::Critical),
                                    )
                                    .await;

                                if let Err(e) = session_manager
                                    .fail_dialog_turn(
                                        &session_id_clone,
                                        &turn_id_clone,
                                        error_text.clone(),
                                    )
                                    .await
                                {
                                    error!(
                                "Failed to mark dialog turn as failed: session={}, turn={}, error={}",
                                session_id_clone, turn_id_clone, e
                            );
                                }

                                if let Err(e) = session_manager
                                    .update_session_state(
                                        &session_id_clone,
                                        SessionState::Error {
                                            error: error_text.clone(),
                                            recoverable,
                                        },
                                    )
                                    .await
                                {
                                    error!(
                                    "Failed to update session state to Error: session={}, error={}",
                                    session_id_clone, e
                                );
                                }

                                if let Some(tx) = &scheduler_notify_tx {
                                    let _ = tx.try_send((
                                        session_id_clone.clone(),
                                        TurnOutcome::Failed {
                                            turn_id: turn_id_clone.clone(),
                                            error: error_text,
                                        },
                                    ));
                                }

                                Some(crate::service::session::TurnStatus::Error)
                            }
                        }
                    }
                };

                if let (Some(ref wp), Some(status)) =
                    (&session_workspace_path, workspace_turn_status)
                {
                    Self::finalize_turn_in_workspace(
                        &session_id_clone,
                        &turn_id_clone,
                        turn_index,
                        &user_input_for_workspace,
                        wp,
                        status,
                        user_message_metadata_clone,
                    )
                    .await;
                }
            });
            match result.catch_unwind().await {
                Ok(()) => {}
                Err(panic_err) => {
                    let panic_msg = if let Some(s) = panic_err.downcast_ref::<&str>() {
                        s.to_string()
                    } else if let Some(s) = panic_err.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "unknown panic".to_string()
                    };
                    error!(
                        "Dialog turn spawn panicked: session={}, turn={}, panic={}",
                        session_id_clone, turn_id_clone, panic_msg
                    );
                    let _ = session_manager
                        .fail_dialog_turn(
                            &session_id_clone,
                            &turn_id_clone,
                            format!("panic: {}", panic_msg),
                        )
                        .await;
                    let _ = session_manager
                        .update_session_state(&session_id_clone, SessionState::Idle)
                        .await;
                }
            }
        });

        Ok(())
    }

    /// Cancel dialog turn execution
    /// Immediately set state to Idle to allow new dialog, old turn ends naturally via cancel token
    pub async fn cancel_dialog_turn(
        &self,
        session_id: &str,
        dialog_turn_id: &str,
    ) -> Ai00XResult<()> {
        info!(
            "Received cancel request: dialog_turn_id={}, session_id={}",
            dialog_turn_id, session_id
        );

        let old_state = self
            .session_manager
            .get_session(session_id)
            .map(|s| format!("{:?}", s.state))
            .unwrap_or_else(|| "Unknown".to_string());
        debug!("Current state: {}", old_state);

        // Step 1: Immediately update session state to Idle (non-blocking, allows immediate new dialog)
        debug!("Updating session state to Idle");
        self.session_manager
            .update_session_state(session_id, SessionState::Idle)
            .await?;

        let new_state = self
            .session_manager
            .get_session(session_id)
            .map(|s| format!("{:?}", s.state))
            .unwrap_or_else(|| "Unknown".to_string());
        debug!("State updated: {} -> {}", old_state, new_state);

        // Step 2: Immediately send state change event (notify frontend can start new dialog)
        self.emit_event(AgentEvent::SessionStateChanged {
            session_id: session_id.to_string(),
            new_state: "idle".to_string(),
        })
        .await;
        debug!("Session state change event sent");

        // Step 3: Async cleanup of old turn (let it end naturally via cancel token, non-blocking)
        let execution_engine = self.execution_engine.clone();
        let tool_pipeline = self.tool_pipeline.clone();
        let dialog_turn_id_clone = dialog_turn_id.to_string();

        tokio::spawn(async move {
            debug!(
                "Starting async cleanup for cancelled turn: {}",
                dialog_turn_id_clone
            );

            if let Err(e) = execution_engine
                .cancel_dialog_turn(&dialog_turn_id_clone)
                .await
            {
                warn!("Failed to cancel execution engine: {}", e);
            }

            if let Err(e) = tool_pipeline
                .cancel_dialog_turn_tools(&dialog_turn_id_clone)
                .await
            {
                warn!("Failed to cancel tool execution: {}", e);
            }

            debug!("Async cleanup completed: {}", dialog_turn_id_clone);
        });

        Ok(())
    }

    pub async fn cancel_active_turn_for_session(
        &self,
        session_id: &str,
        wait_timeout: Duration,
    ) -> Ai00XResult<Option<String>> {
        let Some(session) = self.session_manager.get_session(session_id) else {
            return Ok(None);
        };

        let SessionState::Processing {
            current_turn_id, ..
        } = session.state
        else {
            return Ok(None);
        };

        self.cancel_dialog_turn(session_id, &current_turn_id)
            .await?;

        let deadline = Instant::now() + wait_timeout;
        while self.execution_engine.has_active_turn(&current_turn_id) {
            if Instant::now() >= deadline {
                warn!(
                    "Timed out waiting for active turn cancellation: session_id={}, dialog_turn_id={}, timeout_ms={}",
                    session_id,
                    current_turn_id,
                    wait_timeout.as_millis()
                );
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }

        Ok(Some(current_turn_id))
    }

    /// Delete session
    pub async fn delete_session(&self, workspace_path: &Path, session_id: &str) -> Ai00XResult<()> {
        self.session_manager
            .delete_session(workspace_path, session_id)
            .await?;
        self.emit_event(AgentEvent::SessionDeleted {
            session_id: session_id.to_string(),
        })
        .await;
        Ok(())
    }

    /// Restore session
    pub async fn restore_session(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> Ai00XResult<Session> {
        self.session_manager
            .restore_session(workspace_path, session_id)
            .await
    }

    /// List all sessions
    pub async fn list_sessions(&self, workspace_path: &Path) -> Ai00XResult<Vec<SessionSummary>> {
        self.session_manager.list_sessions(workspace_path).await
    }

    /// Get a best-effort message view for a session.
    pub async fn get_messages(&self, session_id: &str) -> Ai00XResult<Vec<Message>> {
        self.session_manager.get_messages(session_id).await
    }

    /// Get a paginated best-effort message view for a session.
    pub async fn get_messages_paginated(
        &self,
        session_id: &str,
        limit: usize,
        before_message_id: Option<&str>,
    ) -> Ai00XResult<(Vec<Message>, bool)> {
        self.session_manager
            .get_messages_paginated(session_id, limit, before_message_id)
            .await
    }

    /// Subscribe to internal events
    ///
    /// For internal systems to subscribe to events (e.g., logging, monitoring)
    pub fn subscribe_internal<H>(&self, subscriber_id: String, handler: H)
    where
        H: EventSubscriber + 'static,
    {
        self.event_router
            .subscribe_internal(subscriber_id, Arc::new(handler));
    }

    /// Unsubscribe from internal events
    ///
    /// Remove subscriber previously added via subscribe_internal
    pub fn unsubscribe_internal(&self, subscriber_id: &str) {
        self.event_router.unsubscribe_internal(subscriber_id);
    }

    /// Confirm tool execution
    pub async fn confirm_tool(
        &self,
        tool_id: &str,
        updated_input: Option<serde_json::Value>,
    ) -> Ai00XResult<()> {
        self.tool_pipeline
            .confirm_tool(tool_id, updated_input)
            .await
    }

    /// Reject tool execution
    pub async fn reject_tool(&self, tool_id: &str, reason: String) -> Ai00XResult<()> {
        self.tool_pipeline.reject_tool(tool_id, reason).await
    }

    /// Cancel tool execution
    pub async fn cancel_tool(&self, tool_id: &str, reason: String) -> Ai00XResult<()> {
        self.tool_pipeline.cancel_tool(tool_id, reason).await
    }

    /// Confirm plan (user clicked "Confirm" on PlanConfirmationCard)
    pub fn confirm_plan(&self) -> Ai00XResult<()> {
        info!("[DIAG] confirm_plan called");
        self.execution_engine
            .plan_confirmation_sender()
            .send(Some(
                crate::agent::execution::execution_engine::PlanDecision::Confirm,
            ))
            .map_err(|e| Ai00XError::agent(format!("Failed to send plan confirmation: {}", e)))
    }

    /// Reject plan (user clicked "Revise" on PlanConfirmationCard)
    pub fn reject_plan(&self) -> Ai00XResult<()> {
        self.execution_engine
            .plan_confirmation_sender()
            .send(Some(
                crate::agent::execution::execution_engine::PlanDecision::Revise { feedback: None },
            ))
            .map_err(|e| Ai00XError::agent(format!("Failed to send plan rejection: {}", e)))
    }

    /// Revise plan with user feedback
    pub fn revise_plan(&self, feedback: String) -> Ai00XResult<()> {
        self.execution_engine
            .plan_confirmation_sender()
            .send(Some(
                crate::agent::execution::execution_engine::PlanDecision::Revise {
                    feedback: Some(feedback),
                },
            ))
            .map_err(|e| Ai00XError::agent(format!("Failed to send plan revision: {}", e)))
    }

    /// Request AI to auto-review the plan from multiple angles
    pub fn auto_review_plan(&self) -> Ai00XResult<()> {
        self.execution_engine
            .plan_confirmation_sender()
            .send(Some(
                crate::agent::execution::execution_engine::PlanDecision::AutoReview,
            ))
            .map_err(|e| Ai00XError::agent(format!("Failed to send auto-review request: {}", e)))
    }

    /// Execute subagent task directly
    /// DialogTurnStarted event not needed for now
    ///
    /// Parameters:
    /// - agent_type: Agent type
    /// - task_description: Task description
    /// - subagent_parent_info: Parent info (tool call context)
    /// - context: Additional context
    /// - cancel_token: Optional cancel token (for async cancellation)
    ///
    /// Returns SubagentResult with the final text response
    pub async fn execute_subagent(
        &self,
        agent_type: String,
        task_description: String,
        subagent_parent_info: SubagentParentInfo,
        workspace_path: Option<String>,
        context: Option<std::collections::HashMap<String, String>>,
        cancel_token: Option<&CancellationToken>,
    ) -> Ai00XResult<SubagentResult> {
        // Check cancel token (before creating session)
        if let Some(token) = cancel_token {
            if token.is_cancelled() {
                debug!("Subagent task cancelled before execution");
                return Err(Ai00XError::Cancelled(
                    "Subagent task has been cancelled".to_string(),
                ));
            }
        }

        // Create independent subagent session.
        // Use create_subagent_session (not create_session) so that no SessionCreated
        // event is emitted to the transport layer — subagent sessions are internal
        // implementation details and must not appear in the UI session list.
        let workspace_path = workspace_path.ok_or_else(|| {
            Ai00XError::Validation(
                "workspace_path is required when creating a subagent task".to_string(),
            )
        })?;
        let subagent_config = SessionConfig {
            workspace_path: Some(workspace_path),
            ..SessionConfig::default()
        };
        let session = self
            .create_subagent_session(
                format!("Subagent: {}", task_description),
                agent_type.clone(),
                subagent_config,
                &subagent_parent_info,
            )
            .await?;

        // Subagents execute tasks directly without plan confirmation.
        // Set workflow phase to Executing so all tools are available.
        self.session_manager
            .update_workflow_phase(
                &session.session_id,
                Some(WorkflowPhaseState {
                    phase: WorkflowPhase::Executing,
                    plan_file_path: None,
                    plans_dir: None,
                    updated_at: Some(std::time::SystemTime::now()),
                }),
            )
            .await?;

        // Check cancel token (after creating session, before execution)
        if let Some(token) = cancel_token {
            if token.is_cancelled() {
                debug!("Subagent task cancelled before AI call, cleaning up resources");
                let _ = self.cleanup_subagent_resources(&session.session_id).await;
                return Err(Ai00XError::Cancelled(
                    "Subagent task has been cancelled".to_string(),
                ));
            }
        }

        // Generate unique dialog_turn_id for cancel token management
        let dialog_turn_id = format!("subagent-{}", uuid::Uuid::new_v4());
        debug!(
            "Generated unique dialog_turn_id for subagent: {}",
            dialog_turn_id
        );

        // If external cancel_token provided, create child_token and register to RoundExecutor
        // This allows execute_dialog_turn internal checks to detect external cancellation
        let _cleanup_guard = if let Some(parent_token) = cancel_token {
            // Create child_token, cancelled when parent_token is cancelled
            let child_token = parent_token.child_token();

            // Register to ExecutionEngine (forwarded to RoundExecutor), using dialog_turn_id as key
            self.execution_engine
                .register_cancel_token(&dialog_turn_id, child_token.clone());

            debug!(
                "Registered cancel token to RoundExecutor: dialog_turn_id={}",
                dialog_turn_id
            );

            // Create cleanup guard to ensure token cleanup on function exit
            Some(CancelTokenGuard {
                execution_engine: self.execution_engine.clone(),
                dialog_turn_id: dialog_turn_id.clone(),
            })
        } else {
            None
        };

        let subagent_workspace = Self::build_workspace_binding(&session.config).await;
        let subagent_services = Self::build_workspace_services(&subagent_workspace).await;
        let execution_context = ExecutionContext {
            session_id: session.session_id.clone(),
            dialog_turn_id: dialog_turn_id.clone(),
            turn_index: 0,
            agent_type: agent_type.clone(),
            workspace: subagent_workspace,
            context: context.unwrap_or_default(),
            subagent_parent_info: Some(subagent_parent_info),
            // Subagents run autonomously without user interaction; always skip
            // tool confirmation to prevent them from blocking indefinitely on a
            // confirmation channel that nobody will ever respond to.
            skip_tool_confirmation: true,
            workspace_services: subagent_services,
            round_preempt: self.round_preempt_source.get().cloned(),
        };

        let initial_messages = vec![Message::user(task_description.clone())];

        // ====== 新增：在 execute_dialog_turn 之前启动 turn ======
        // Start persisted turn for tracking (start_persisted_turn 内部自行处理 enable_persistence)
        let turn_id_for_persist = self
            .session_manager
            .start_subagent_turn(
                &session.session_id,
                task_description.clone(),
                Some(dialog_turn_id.clone()),
            )
            .await
            .ok();

        // 更新 session state 为 Processing
        let _ = self
            .session_manager
            .update_session_state(
                &session.session_id,
                SessionState::Processing {
                    current_turn_id: dialog_turn_id.clone(),
                    phase: ProcessingPhase::Thinking,
                },
            )
            .await;

        let result = self
            .execution_engine
            .execute_dialog_turn(agent_type, initial_messages, execution_context)
            .await;

        // cleanup_guard automatically cleans up token on scope exit (via Drop trait)

        // ====== 修改：处理成功/失败 → 持久化 + 更新状态 ======
        let response_text = match result {
            Ok(exec_result) => {
                let text = match exec_result.final_message.content {
                    MessageContent::Mixed { text, .. } => text,
                    MessageContent::Text(text) => text,
                    _ => String::new(),
                };

                // Complete persisted turn
                if let Some(turn_id) = &turn_id_for_persist {
                    if let Err(e) = self
                        .session_manager
                        .complete_dialog_turn(
                            &session.session_id,
                            turn_id,
                            text.clone(),
                            TurnStats {
                                total_rounds: exec_result.total_rounds,
                                total_tools: 0,
                                total_tokens: 0,
                                duration_ms: 0,
                            },
                        )
                        .await
                    {
                        warn!("Failed to complete subagent turn: {}", e);
                    }
                }

                // Update session state to Idle
                let _ = self
                    .session_manager
                    .update_session_state(&session.session_id, SessionState::Idle)
                    .await;

                text
            }
            Err(e) => {
                let error_text = e.to_string();
                let is_cancellation = matches!(&e, Ai00XError::Cancelled(_));

                error!(
                    "Subagent execution failed: session={}, error={}",
                    session.session_id, error_text
                );

                // Fail persisted turn
                if let Some(turn_id) = &turn_id_for_persist {
                    if let Err(e2) = self
                        .session_manager
                        .fail_dialog_turn(&session.session_id, turn_id, error_text.clone())
                        .await
                    {
                        warn!("Failed to fail subagent turn: {}", e2);
                    }
                }

                // Update session state
                let state = if is_cancellation {
                    SessionState::Idle
                } else {
                    SessionState::Error {
                        error: error_text.clone(),
                        recoverable: false,
                    }
                };
                let _ = self
                    .session_manager
                    .update_session_state(&session.session_id, state)
                    .await;

                // Cleanup and return error
                if let Err(cleanup_err) = self.cleanup_subagent_resources(&session.session_id).await
                {
                    warn!(
                        "Failed to cleanup subagent resources: session={}, error={}",
                        session.session_id, cleanup_err
                    );
                }

                return Err(e);
            }
        };

        // Clean up subagent session resources after successful execution
        debug!(
            "Starting subagent resource cleanup: session={}",
            session.session_id
        );
        if let Err(e) = self.cleanup_subagent_resources(&session.session_id).await {
            warn!(
                "Failed to cleanup subagent resources: session={}, error={}",
                session.session_id, e
            );
        } else {
            debug!(
                "Subagent resource cleanup completed: session={}",
                session.session_id
            );
        }

        Ok(SubagentResult {
            text: response_text,
        })
    }

    /// Clean up subagent session resources
    ///
    /// Release resources occupied by subagent session (sandbox, etc.) and delete session
    async fn cleanup_subagent_resources(&self, session_id: &str) -> Ai00XResult<()> {
        debug!(
            "Starting subagent resource cleanup: session_id={}",
            session_id
        );

        // Clean up snapshot system resources
        if let Some(workspace_path) = self
            .session_manager
            .get_session(session_id)
            .and_then(|session| session.config.workspace_path.map(std::path::PathBuf::from))
        {
            if let Ok(snapshot_manager) =
                crate::service::snapshot::ensure_snapshot_manager_for_workspace(&workspace_path)
            {
                let snapshot_service = snapshot_manager.get_snapshot_service();
                let snapshot_service = snapshot_service.read().await;
                if let Err(e) = snapshot_service.accept_session(session_id).await {
                    warn!(
                        "Failed to cleanup snapshot system resources: session={}, error={}",
                        session_id, e
                    );
                } else {
                    debug!(
                        "Snapshot system resources cleaned up: session={}",
                        session_id
                    );
                }
            }
        }

        // Delete the subagent session itself, including runtime context and persisted turn data.
        let workspace_path = self
            .session_manager
            .get_session(session_id)
            .and_then(|session| session.config.workspace_path.map(std::path::PathBuf::from));

        if let Some(workspace_path) = workspace_path {
            if let Err(e) = self
                .session_manager
                .delete_session(&workspace_path, session_id)
                .await
            {
                warn!(
                    "Failed to delete subagent session: session={}, error={}",
                    session_id, e
                );
            } else {
                debug!("Subagent session deleted: session={}", session_id);
            }
        } else {
            warn!(
                "Failed to delete subagent session because workspace_path is missing: session={}",
                session_id
            );
        }

        debug!(
            "Subagent resource cleanup completed: session_id={}",
            session_id
        );
        Ok(())
    }

    /// Generate session title
    ///
    /// Use AI to generate a concise and accurate session title based on user message content.
    /// Also persists the title to the session backend. Callers that go through
    /// `start_dialog_turn` do NOT need to call this separately — first-message
    /// title generation is handled automatically inside `start_dialog_turn`.
    pub async fn generate_session_title(
        &self,
        session_id: &str,
        user_message: &str,
        max_length: Option<usize>,
    ) -> Ai00XResult<String> {
        let allow_ai = is_ai_session_title_generation_enabled().await;
        let resolved = self
            .session_manager
            .resolve_session_title(user_message, max_length, allow_ai)
            .await;

        self.session_manager
            .update_session_title(session_id, &resolved.title)
            .await?;

        let event = AgentEvent::SessionTitleGenerated {
            session_id: session_id.to_string(),
            title: resolved.title.clone(),
            method: resolved.method.as_str().to_string(),
        };
        self.emit_event(event).await;

        debug!(
            "Session title generation event sent: session_id={}, title={}",
            session_id, resolved.title
        );

        Ok(resolved.title)
    }

    pub async fn update_session_title(&self, session_id: &str, title: &str) -> Ai00XResult<String> {
        let normalized = title.trim().to_string();
        if normalized.is_empty() {
            return Err(Ai00XError::validation(
                "Task title must not be empty".to_string(),
            ));
        }

        self.session_manager
            .update_session_title(session_id, &normalized)
            .await?;

        Ok(normalized)
    }

    /// Emit event
    async fn emit_event(&self, event: AgentEvent) {
        let _ = self
            .event_queue
            .enqueue(event, Some(EventPriority::Normal))
            .await;
    }

    /// Get SessionManager reference (for advanced features like mode management)
    pub fn get_session_manager(&self) -> &Arc<SessionManager> {
        &self.session_manager
    }

    /// Persist a completed `/btw` side-question turn into an existing child session.
    #[allow(clippy::too_many_arguments)]
    pub async fn persist_btw_turn(
        &self,
        workspace_path: &Path,
        child_session_id: &str,
        request_id: &str,
        question: &str,
        full_text: &str,
        parent_session_id: &str,
        parent_dialog_turn_id: Option<&str>,
        parent_turn_index: Option<usize>,
    ) -> Ai00XResult<()> {
        self.session_manager
            .persist_btw_turn(
                workspace_path,
                child_session_id,
                request_id,
                question,
                full_text,
                parent_session_id,
                parent_dialog_turn_id,
                parent_turn_index,
            )
            .await
    }

    /// Set global coordinator (called during initialization)
    ///
    /// Skips if global coordinator already exists
    pub fn set_global(coordinator: Arc<ConversationCoordinator>) {
        match GLOBAL_COORDINATOR.set(coordinator) {
            Ok(_) => {
                debug!("Global coordinator set");
            }
            Err(_) => {
                debug!("Global coordinator already exists, skipping set");
            }
        }
    }
}

async fn is_ai_session_title_generation_enabled() -> bool {
    match get_global_config_service() {
        Ok(service) => service
            .get_config::<bool>(Some("app.ai_experience.enable_session_title_generation"))
            .await
            .unwrap_or(true),
        Err(_) => true,
    }
}

// Global coordinator singleton
static GLOBAL_COORDINATOR: OnceLock<Arc<ConversationCoordinator>> = OnceLock::new();

/// Get global coordinator
///
/// Returns `None` if coordinator hasn't been initialized
pub fn get_global_coordinator() -> Option<Arc<ConversationCoordinator>> {
    GLOBAL_COORDINATOR.get().cloned()
}
