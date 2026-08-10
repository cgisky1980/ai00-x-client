//! Execution Engine
//!
//! Executes complete dialog turns, managing loops of multiple model rounds

use super::round_executor::RoundExecutor;
use super::types::{ExecutionContext, ExecutionResult, RoundContext};
use super::workflow_phase::WorkflowPhaseMachine;
use crate::agent::agents::{
    get_agent_registry, PromptBuilder, PromptBuilderContext, RemoteExecutionHints,
};
use crate::agent::core::{
    render_system_reminder, Message, MessageContent, MessageHelper, MessageSemanticKind,
    RequestReasoningTokenPolicy, Session, ToolCall,
};
use crate::agent::events::{AgentEvent, EventPriority, EventQueue};
use crate::agent::image_analysis::{
    build_multimodal_message_with_images, process_image_contexts_for_provider, ImageContextData,
    ImageLimits,
};
use crate::agent::session::{CompressionTailPolicy, ContextCompressor, SessionManager};
use crate::agent::tools::permission::{PermissionLevel, PermissionPolicy};
use crate::agent::tools::pipeline::ToolExecutionContext;
use crate::agent::tools::{get_all_registered_tools, SubagentParentInfo};
use crate::agent::util::build_remote_workspace_layout_preview;
use crate::agent::{WorkspaceBackend, WorkspaceBinding};
use crate::infrastructure::ai::get_global_ai_client_factory;
use crate::service::config::get_global_config_service;
use crate::service::config::types::{ModelCapability, ModelCategory};
use crate::service::remote_ssh::workspace_state::get_remote_workspace_manager;
use crate::util::errors::{Ai00XError, Ai00XResult};
use crate::util::token_counter::TokenCounter;
use crate::util::types::Message as AIMessage;
use crate::util::types::ToolDefinition;
use log::{debug, error, info, trace, warn};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Execution engine configuration
#[derive(Debug, Clone)]
pub struct ExecutionEngineConfig {
    pub max_rounds: usize, // Maximum number of rounds to prevent infinite loops
    /// Maximum consecutive rounds where ALL tool calls are WebSearch/WebFetch
    /// without meaningful text output. When exceeded, the loop breaks to prevent
    /// infinite search loops (e.g., when a target platform is inaccessible).
    pub max_consecutive_search_rounds: usize,
}

impl Default for ExecutionEngineConfig {
    fn default() -> Self {
        Self {
            max_rounds: 200,
            max_consecutive_search_rounds: 5,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ContextCompactionOutcome {
    pub compression_id: String,
    pub compression_count: usize,
    pub tokens_before: usize,
    pub tokens_after: usize,
    pub compression_ratio: f64,
    pub duration_ms: u64,
    pub has_summary: bool,
    pub summary_source: String,
    pub applied: bool,
}

/// Plan confirmation decision from the user
#[derive(Debug, Clone)]
pub enum PlanDecision {
    Confirm,
    Revise { feedback: Option<String> },
    AutoReview,
}

/// Execution engine
pub struct ExecutionEngine {
    round_executor: Arc<RoundExecutor>,
    event_queue: Arc<EventQueue>,
    session_manager: Arc<SessionManager>,
    context_compressor: Arc<ContextCompressor>,
    config: ExecutionEngineConfig,
    plan_confirmation_tx: tokio::sync::watch::Sender<Option<PlanDecision>>,
    plan_confirmation_rx: tokio::sync::watch::Receiver<Option<PlanDecision>>,
}

impl ExecutionEngine {
    pub fn new(
        round_executor: Arc<RoundExecutor>,
        event_queue: Arc<EventQueue>,
        session_manager: Arc<SessionManager>,
        context_compressor: Arc<ContextCompressor>,
        config: ExecutionEngineConfig,
    ) -> Self {
        let (plan_confirmation_tx, plan_confirmation_rx) = tokio::sync::watch::channel(None);
        Self {
            round_executor,
            event_queue,
            session_manager,
            context_compressor,
            config,
            plan_confirmation_tx,
            plan_confirmation_rx,
        }
    }

    pub fn plan_confirmation_sender(&self) -> tokio::sync::watch::Sender<Option<PlanDecision>> {
        self.plan_confirmation_tx.clone()
    }

    fn estimate_request_tokens_internal(
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
    ) -> usize {
        MessageHelper::estimate_request_tokens(
            messages,
            tools,
            RequestReasoningTokenPolicy::LatestTurnOnly,
        )
    }

    /// Emergency truncation: drop oldest API rounds (assistant+tool pairs)
    /// from the front of the message list until estimated tokens fit within
    /// `context_window`.  System messages and the first user message are
    /// always preserved.
    fn emergency_truncate_messages(
        messages: Vec<Message>,
        context_window: usize,
        tools: Option<&[ToolDefinition]>,
    ) -> Vec<Message> {
        use crate::agent::core::MessageRole;

        // Separate preserved head (system + first user) from droppable body.
        let mut preserved: Vec<Message> = Vec::new();
        let mut droppable: Vec<Message> = Vec::new();
        let mut seen_first_user = false;

        for msg in messages {
            if !seen_first_user {
                let is_user = msg.role == MessageRole::User;
                preserved.push(msg);
                if is_user {
                    seen_first_user = true;
                }
            } else {
                droppable.push(msg);
            }
        }

        if droppable.is_empty() {
            return preserved;
        }

        // Group droppable messages into API rounds.
        // An API round starts with an Assistant message and includes all
        // following Tool messages until the next Assistant or User message.
        let mut rounds: Vec<Vec<Message>> = Vec::new();
        for msg in droppable {
            match msg.role {
                MessageRole::Assistant => {
                    rounds.push(vec![msg]);
                }
                MessageRole::Tool => {
                    if let Some(last_round) = rounds.last_mut() {
                        last_round.push(msg);
                    } else {
                        rounds.push(vec![msg]);
                    }
                }
                _ => {
                    rounds.push(vec![msg]);
                }
            }
        }

        // Drop rounds from the front until we fit.
        let tool_tokens = tools
            .map(TokenCounter::estimate_tool_definitions_tokens)
            .unwrap_or(0);
        let preserved_tokens: usize = preserved
            .iter()
            .map(|m| m.estimate_tokens_with_reasoning(true))
            .sum::<usize>()
            + tool_tokens
            + 3;

        let mut kept_start = 0;
        let mut total_tokens = preserved_tokens
            + rounds
                .iter()
                .flat_map(|r| r.iter())
                .map(|m| m.estimate_tokens_with_reasoning(true))
                .sum::<usize>();

        while total_tokens > context_window && kept_start < rounds.len() {
            let round_tokens: usize = rounds[kept_start]
                .iter()
                .map(|m| m.estimate_tokens_with_reasoning(true))
                .sum();
            total_tokens -= round_tokens;
            kept_start += 1;
        }

        if kept_start > 0 {
            warn!(
                "Emergency truncation dropped {} API round(s) from context head",
                kept_start
            );
        }

        let mut result = preserved;
        for round in rounds.into_iter().skip(kept_start) {
            result.extend(round);
        }
        result
    }

    fn is_redacted_image_context(image: &ImageContextData) -> bool {
        let missing_path = image
            .image_path
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        let missing_data_url = image
            .data_url
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        let has_redaction_hint = image
            .metadata
            .as_ref()
            .and_then(|m| m.get("has_data_url"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        missing_path && missing_data_url && has_redaction_hint
    }

    fn is_recoverable_historical_image_error(err: &Ai00XError) -> bool {
        match err {
            Ai00XError::Io(_) | Ai00XError::Deserialization(_) => true,
            Ai00XError::Validation(msg) => {
                msg.starts_with("Failed to decode image data")
                    || msg.starts_with("Unsupported or unrecognized image format")
                    || msg.starts_with("Invalid data URL format")
                    || msg.starts_with("Data URL format error")
            }
            _ => false,
        }
    }

    fn can_fallback_to_text_only(
        images: &[ImageContextData],
        err: &Ai00XError,
        is_current_turn_message: bool,
    ) -> bool {
        let is_redacted_payload_error = matches!(
            err,
            Ai00XError::Validation(msg) if msg.starts_with("Image context missing image_path/data_url")
        ) && !images.is_empty()
            && images.iter().all(Self::is_redacted_image_context);

        if is_redacted_payload_error {
            return true;
        }

        if is_current_turn_message {
            return false;
        }

        Self::is_recoverable_historical_image_error(err)
    }

    fn resolve_configured_model_id(
        ai_config: &crate::service::config::types::AIConfig,
        model_id: &str,
    ) -> String {
        let trimmed = model_id.trim();
        if trimmed.is_empty() || trimmed == "auto" || trimmed == "default" {
            return "auto".to_string();
        }
        ai_config
            .resolve_model_selection(trimmed)
            .unwrap_or_else(|| "auto".to_string())
    }

    async fn build_prompt_context(
        context: &ExecutionContext,
        model_name: &str,
        supports_image_understanding: bool,
    ) -> Option<PromptBuilderContext> {
        let workspace_path = context
            .workspace
            .as_ref()
            .map(|workspace| workspace.root_path_string())?;

        let base = PromptBuilderContext::new(
            workspace_path.clone(),
            Some(context.session_id.clone()),
            Some(model_name.to_string()),
        )
        .with_supports_image_understanding(supports_image_understanding);

        let Some(workspace) = context.workspace.as_ref() else {
            return Some(base);
        };
        if !workspace.is_remote() {
            return Some(base);
        }

        let Some(connection_id) = workspace.connection_id() else {
            return Some(base);
        };
        let Some(manager) = get_remote_workspace_manager() else {
            warn!(
                "Remote workspace active but RemoteWorkspaceStateManager is missing; using client OS hints only"
            );
            return Some(base);
        };

        let ssh_manager = manager.get_ssh_manager().await;
        let file_service = manager.get_file_service().await;
        let (kernel_name, hostname) = if let Some(ref ssh) = ssh_manager {
            if let Some(info) = ssh.get_server_info(connection_id).await {
                (info.os_type, info.hostname)
            } else {
                ("Linux".to_string(), "remote".to_string())
            }
        } else {
            ("Linux".to_string(), "remote".to_string())
        };
        let connection_display_name = match &workspace.backend {
            WorkspaceBackend::Remote {
                connection_name, ..
            } => connection_name.clone(),
            _ => connection_id.to_string(),
        };
        let remote_layout = if let Some(ref fs) = file_service {
            match build_remote_workspace_layout_preview(fs, connection_id, &workspace_path, 200)
                .await
            {
                Ok((_, preview)) => Some(preview),
                Err(e) => {
                    warn!("Remote workspace layout for prompt failed: {}", e);
                    None
                }
            }
        } else {
            None
        };

        Some(base.with_remote_prompt_overlay(
            RemoteExecutionHints {
                connection_display_name,
                kernel_name,
                hostname,
            },
            remote_layout,
        ))
    }

    pub(crate) async fn resolve_model_id_for_turn(
        &self,
        session: &Session,
        agent_type: &str,
        workspace: Option<&WorkspaceBinding>,
        _original_user_input: &str,
        turn_index: usize,
    ) -> Ai00XResult<String> {
        let agent_registry = get_agent_registry();
        let fallback_model_id = agent_registry
            .get_model_id_for_agent(agent_type, workspace.map(|binding| binding.root_path()))
            .await
            .map_err(|e| Ai00XError::AIClient(format!("Failed to get model ID: {}", e)))?;
        let config_service = get_global_config_service().map_err(|e| {
            Ai00XError::AIClient(format!(
                "Failed to get config service for model resolution: {}",
                e
            ))
        })?;
        let ai_config: crate::service::config::types::AIConfig = config_service
            .get_config(Some("ai"))
            .await
            .unwrap_or_default();
        let configured_model_id = session
            .config
            .model_id
            .as_ref()
            .map(|model_id| model_id.trim())
            .filter(|model_id| !model_id.is_empty())
            .map(str::to_string)
            .unwrap_or(fallback_model_id.clone());
        let resolved_configured_model_id =
            Self::resolve_configured_model_id(&ai_config, &configured_model_id);

        let model_id = if configured_model_id == "auto" || resolved_configured_model_id == "auto" {
            let resolved_model_id = ai_config.resolve_model_selection("primary");

            if let Some(resolved_model_id) = resolved_model_id {
                info!(
                    "Auto model resolved to primary: session_id={}, turn_index={}, resolved_model_id={}",
                    session.session_id,
                    turn_index,
                    resolved_model_id
                );

                resolved_model_id
            } else {
                warn!(
                    "Auto model strategy unresolved, falling back to primary: session_id={}",
                    session.session_id
                );
                "primary".to_string()
            }
        } else {
            resolved_configured_model_id
        };

        Ok(model_id)
    }

    /// Omit from model request: UI-only verification frames and legacy auto desktop snapshots.
    fn skip_message_for_model_send(msg: &Message) -> bool {
        matches!(
            msg.metadata.semantic_kind.as_ref(),
            Some(MessageSemanticKind::ComputerUseVerificationScreenshot)
                | Some(MessageSemanticKind::ComputerUsePostActionSnapshot)
        )
    }

    /// True if this message would contribute at least one image to the model (before pruning).
    fn message_bears_images(msg: &Message) -> bool {
        if Self::skip_message_for_model_send(msg) {
            return false;
        }
        match &msg.content {
            MessageContent::Multimodal { images, .. } => !images.is_empty(),
            MessageContent::ToolResult {
                image_attachments, ..
            } => image_attachments.as_ref().is_some_and(|a| !a.is_empty()),
            _ => false,
        }
    }

    /// Indices of the last `max_rounds` messages that bear images (`max_rounds` = 2 → keep images only there).
    fn image_bearing_indices_to_keep(messages: &[Message], max_rounds: usize) -> HashSet<usize> {
        let with_images: Vec<usize> = messages
            .iter()
            .enumerate()
            .filter(|(_, m)| Self::message_bears_images(m))
            .map(|(i, _)| i)
            .collect();
        let n = with_images.len();
        if n <= max_rounds {
            return with_images.into_iter().collect();
        }
        with_images[n - max_rounds..].iter().copied().collect()
    }

    async fn build_ai_messages_for_send(
        messages: &[Message],
        provider: &str,
        workspace_path: Option<&Path>,
        current_turn_id: &str,
        attach_images: bool,
        prepended_user_context: Option<&str>,
    ) -> Ai00XResult<Vec<AIMessage>> {
        eprintln!(
            "[TRACE] BUILD_AI_MSGS_START provider={} msg_count={}",
            provider,
            messages.len()
        );

        /// Only the last this many **messages** that contain images keep their images for the API.
        const MAX_IMAGE_BEARING_MESSAGE_ROUNDS: usize = 2;

        let limits = ImageLimits::for_provider(provider);

        let trimmed_user_context = prepended_user_context.and_then(|text| {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });
        let mut result =
            Vec::with_capacity(messages.len() + usize::from(trimmed_user_context.is_some()));
        let mut attached_image_count = 0usize;
        let first_non_system_index = messages
            .iter()
            .position(|msg| msg.role != crate::agent::core::MessageRole::System)
            .unwrap_or(messages.len());
        let mut user_context_injected = false;

        let keep_image_messages = if attach_images {
            Self::image_bearing_indices_to_keep(messages, MAX_IMAGE_BEARING_MESSAGE_ROUNDS)
        } else {
            HashSet::new()
        };

        for (msg_idx, msg) in messages.iter().enumerate() {
            if !user_context_injected && msg_idx == first_non_system_index {
                if let Some(user_context) = trimmed_user_context {
                    result.push(AIMessage::user(render_system_reminder(user_context)));
                }
                user_context_injected = true;
            }

            if Self::skip_message_for_model_send(msg) {
                continue;
            }
            let keep_this_message_images = attach_images && keep_image_messages.contains(&msg_idx);
            match &msg.content {
                MessageContent::Multimodal { text, images } => {
                    if !attach_images {
                        // Primary model is text-only (or images are disabled). Convert to text-only
                        // placeholder so providers that don't support image inputs won't error.
                        result.push(AIMessage::from(msg));
                        continue;
                    }

                    let (filtered_images, dropped_count): (Vec<ImageContextData>, usize) =
                        if images.is_empty() {
                            (Vec::new(), 0)
                        } else if keep_this_message_images {
                            (images.clone(), 0)
                        } else {
                            (Vec::new(), images.len())
                        };

                    let prompt = if text.trim().is_empty() {
                        "(image attached)".to_string()
                    } else {
                        text.clone()
                    };
                    let prompt = if dropped_count > 0 {
                        format!(
                            "{}\n\n[{} image(s) from this message omitted: only the latest {} message(s) in the conversation that contain images are sent to the model.]",
                            prompt.trim_end(),
                            dropped_count,
                            MAX_IMAGE_BEARING_MESSAGE_ROUNDS
                        )
                    } else {
                        prompt
                    };

                    match process_image_contexts_for_provider(
                        &filtered_images,
                        provider,
                        workspace_path,
                    )
                    .await
                    {
                        Ok(processed) => {
                            let next_count = attached_image_count + processed.len();
                            if next_count > limits.max_images_per_request {
                                return Err(Ai00XError::validation(format!(
                                    "Too many images in one request: {} > {}",
                                    next_count, limits.max_images_per_request
                                )));
                            }
                            attached_image_count = next_count;

                            let multimodal = build_multimodal_message_with_images(
                                &prompt, &processed, provider,
                            )?;
                            result.extend(multimodal);
                        }
                        Err(err) => {
                            if matches!(&err, Ai00XError::Validation(msg) if msg.starts_with("Too many images in one request"))
                            {
                                return Err(err);
                            }
                            let is_current_turn_message =
                                msg.metadata.turn_id.as_deref() == Some(current_turn_id);
                            if Self::can_fallback_to_text_only(
                                images,
                                &err,
                                is_current_turn_message,
                            ) {
                                warn!(
                                    "Failed to rebuild multimodal payload, falling back to text-only message: message_id={}, provider={}, turn_id={:?}, current_turn_id={}, error={}",
                                    msg.id, provider, msg.metadata.turn_id, current_turn_id, err
                                );
                                result.push(AIMessage::from(msg));
                            } else {
                                return Err(err);
                            }
                        }
                    }
                }
                MessageContent::ToolResult { .. } => {
                    if !attach_images {
                        result.push(AIMessage::from(msg));
                        continue;
                    }
                    let mut ai = AIMessage::from(msg.clone());
                    if let Some(atts) = ai.tool_image_attachments.take() {
                        if !atts.is_empty() {
                            if keep_this_message_images {
                                let next_count = attached_image_count + atts.len();
                                if next_count > limits.max_images_per_request {
                                    return Err(Ai00XError::validation(format!(
                                        "Too many images in one request: {} > {}",
                                        next_count, limits.max_images_per_request
                                    )));
                                }
                                attached_image_count = next_count;
                                ai.tool_image_attachments = Some(atts);
                            } else {
                                let dropped = atts.len();
                                let content_str = ai.content.as_deref().unwrap_or("");
                                ai.content = Some(format!(
                                    "{}\n\n[{} image(s) from this tool result omitted: only the latest {} message(s) in the conversation that contain images are sent to the model.]",
                                    content_str.trim_end(),
                                    dropped,
                                    MAX_IMAGE_BEARING_MESSAGE_ROUNDS
                                ));
                                ai.tool_image_attachments = None;
                            }
                        }
                    }
                    result.push(ai);
                }
                _ => result.push(AIMessage::from(msg)),
            }
        }

        if !user_context_injected {
            if let Some(user_context) = trimmed_user_context {
                result.push(AIMessage::user(render_system_reminder(user_context)));
            }
        }

        eprintln!("[TRACE] BUILD_AI_MSGS_END result_len={}", result.len());

        Ok(result)
    }

    fn render_multimodal_as_text(text: &str, images: &[ImageContextData]) -> String {
        let mut content = text.to_string();

        if images.is_empty() {
            return content;
        }

        content.push_str("\n\n[Attached image(s):\n");
        for image in images {
            let name = image
                .metadata
                .as_ref()
                .and_then(|m| m.get("name"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| image.image_path.as_ref().filter(|s| !s.is_empty()).cloned())
                .unwrap_or_else(|| image.id.clone());

            content.push_str(&format!(
                "- {} ({}, image_id={})\n",
                name, image.mime_type, image.id
            ));
        }
        content.push_str("]\n");

        content.push_str("Note: image inspection is not available for this session.\n");

        content
    }

    /// Compress context, will emit compression events (Started, Completed, and Failed)
    #[allow(clippy::too_many_arguments)]
    pub async fn compress_messages(
        &self,
        session_id: &str,
        dialog_turn_id: &str,
        subagent_parent_info: Option<SubagentParentInfo>,
        messages: Vec<Message>,
        current_tokens: usize,
        context_window: usize,
        tool_definitions: &Option<Vec<ToolDefinition>>,
        system_prompt_message: Message,
        tail_policy: CompressionTailPolicy,
    ) -> Ai00XResult<Option<(usize, Vec<Message>)>> {
        let event_subagent_parent_info = subagent_parent_info.map(|info| info.clone().into());
        let mut session = self
            .session_manager
            .get_session(session_id)
            .ok_or_else(|| Ai00XError::NotFound(format!("Session not found: {}", session_id)))?;

        // Record start time
        let start_time = std::time::Instant::now();

        let old_messages_len = messages.len();
        // Preprocess turns
        let (turn_index_to_keep, turns) = self
            .context_compressor
            .preprocess_turns(session_id, context_window, messages)
            .await?;
        if turn_index_to_keep == 0 {
            return Ok(None);
        }

        // Generate compression ID
        let compression_id = format!("compression_{}", uuid::Uuid::new_v4());

        // Emit compression started event
        self.emit_event(
            AgentEvent::ContextCompressionStarted {
                session_id: session_id.to_string(),
                turn_id: dialog_turn_id.to_string(),
                compression_id: compression_id.clone(),
                trigger: "auto".to_string(),
                tokens_before: current_tokens,
                context_window,
                threshold: session.config.compression_threshold,
                subagent_parent_info: event_subagent_parent_info.clone(),
            },
            EventPriority::Normal,
        )
        .await;

        // Execute compression
        match self
            .context_compressor
            .compress_turns(
                session_id,
                context_window,
                turn_index_to_keep,
                turns,
                tail_policy,
            )
            .await
        {
            Ok(compression_result) => {
                self.session_manager
                    .replace_context_messages(session_id, compression_result.messages.clone())
                    .await;
                let mut new_messages = vec![system_prompt_message];
                new_messages.extend(compression_result.messages);
                // Update session compression state
                session.compression_state.increment_compression_count();

                info!(
                    "Compression completed: messages {} -> {}, compression_count={}",
                    old_messages_len,
                    new_messages.len(),
                    session.compression_state.compression_count
                );

                // Update session state
                let _ = self
                    .session_manager
                    .update_compression_state(session_id, session.compression_state.clone())
                    .await;

                // Calculate duration
                let duration_ms = start_time.elapsed().as_millis() as u64;

                // Recalculate tokens after compression
                let compressed_tokens = Self::estimate_request_tokens_internal(
                    &new_messages,
                    tool_definitions.as_deref(),
                );

                // Emit compression completed event
                self.emit_event(
                    AgentEvent::ContextCompressionCompleted {
                        session_id: session_id.to_string(),
                        turn_id: dialog_turn_id.to_string(),
                        compression_id: compression_id.clone(),
                        compression_count: session.compression_state.compression_count,
                        tokens_before: current_tokens,
                        tokens_after: compressed_tokens,
                        compression_ratio: (compressed_tokens as f64) / (current_tokens as f64),
                        duration_ms,
                        has_summary: compression_result.has_model_summary,
                        summary_source: if compression_result.has_model_summary {
                            "model".to_string()
                        } else {
                            "local_fallback".to_string()
                        },
                        subagent_parent_info: event_subagent_parent_info.clone(),
                    },
                    EventPriority::Normal,
                )
                .await;

                Ok(Some((compressed_tokens, new_messages)))
            }
            Err(e) => {
                // Emit compression failed event
                self.emit_event(
                    AgentEvent::ContextCompressionFailed {
                        session_id: session_id.to_string(),
                        turn_id: dialog_turn_id.to_string(),
                        compression_id: compression_id.clone(),
                        error: e.to_string(),
                        subagent_parent_info: event_subagent_parent_info.clone(),
                    },
                    EventPriority::High,
                )
                .await;

                Err(Ai00XError::Session(e.to_string()))
            }
        }
    }

    /// Compact the current session context outside the normal dialog execution loop.
    /// Always emits compression started/completed/failed events for the provided turn.
    #[allow(clippy::too_many_arguments)]
    pub async fn compact_session_context(
        &self,
        session_id: &str,
        dialog_turn_id: &str,
        messages: Vec<Message>,
        current_tokens: usize,
        context_window: usize,
        trigger: &str,
        tail_policy: CompressionTailPolicy,
    ) -> Ai00XResult<ContextCompactionOutcome> {
        let mut session = self
            .session_manager
            .get_session(session_id)
            .ok_or_else(|| Ai00XError::NotFound(format!("Session not found: {}", session_id)))?;
        let start_time = std::time::Instant::now();
        let compression_id = format!("compression_{}", uuid::Uuid::new_v4());

        self.emit_event(
            AgentEvent::ContextCompressionStarted {
                session_id: session_id.to_string(),
                turn_id: dialog_turn_id.to_string(),
                compression_id: compression_id.clone(),
                trigger: trigger.to_string(),
                tokens_before: current_tokens,
                context_window,
                threshold: session.config.compression_threshold,
                subagent_parent_info: None,
            },
            EventPriority::Normal,
        )
        .await;

        let turns = self
            .context_compressor
            .collect_all_turns_for_manual_compaction(session_id, messages)?;

        if turns.is_empty() {
            let duration_ms = start_time.elapsed().as_millis() as u64;
            let tokens_after = current_tokens;
            let compression_ratio = if current_tokens == 0 {
                1.0
            } else {
                (tokens_after as f64) / (current_tokens as f64)
            };

            self.emit_event(
                AgentEvent::ContextCompressionCompleted {
                    session_id: session_id.to_string(),
                    turn_id: dialog_turn_id.to_string(),
                    compression_id: compression_id.clone(),
                    compression_count: session.compression_state.compression_count,
                    tokens_before: current_tokens,
                    tokens_after,
                    compression_ratio,
                    duration_ms,
                    has_summary: false,
                    summary_source: "none".to_string(),
                    subagent_parent_info: None,
                },
                EventPriority::Normal,
            )
            .await;

            return Ok(ContextCompactionOutcome {
                compression_id,
                compression_count: session.compression_state.compression_count,
                tokens_before: current_tokens,
                tokens_after,
                compression_ratio,
                duration_ms,
                has_summary: false,
                summary_source: "none".to_string(),
                applied: false,
            });
        }

        match self
            .context_compressor
            .compress_turns(session_id, context_window, turns.len(), turns, tail_policy)
            .await
        {
            Ok(compression_result) => {
                let mut compressed_messages = compression_result.messages;
                self.session_manager
                    .replace_context_messages(session_id, compressed_messages.clone())
                    .await;

                session.compression_state.increment_compression_count();
                let compression_count = session.compression_state.compression_count;
                let _ = self
                    .session_manager
                    .update_compression_state(session_id, session.compression_state.clone())
                    .await;

                let duration_ms = start_time.elapsed().as_millis() as u64;
                let tokens_after = compressed_messages
                    .iter_mut()
                    .map(|message| message.get_tokens())
                    .sum::<usize>();
                let compression_ratio = if current_tokens == 0 {
                    1.0
                } else {
                    (tokens_after as f64) / (current_tokens as f64)
                };

                self.emit_event(
                    AgentEvent::ContextCompressionCompleted {
                        session_id: session_id.to_string(),
                        turn_id: dialog_turn_id.to_string(),
                        compression_id: compression_id.clone(),
                        compression_count,
                        tokens_before: current_tokens,
                        tokens_after,
                        compression_ratio,
                        duration_ms,
                        has_summary: compression_result.has_model_summary,
                        summary_source: if compression_result.has_model_summary {
                            "model".to_string()
                        } else {
                            "local_fallback".to_string()
                        },
                        subagent_parent_info: None,
                    },
                    EventPriority::Normal,
                )
                .await;

                Ok(ContextCompactionOutcome {
                    compression_id,
                    compression_count,
                    tokens_before: current_tokens,
                    tokens_after,
                    compression_ratio,
                    duration_ms,
                    has_summary: compression_result.has_model_summary,
                    summary_source: if compression_result.has_model_summary {
                        "model".to_string()
                    } else {
                        "local_fallback".to_string()
                    },
                    applied: true,
                })
            }
            Err(err) => {
                self.emit_event(
                    AgentEvent::ContextCompressionFailed {
                        session_id: session_id.to_string(),
                        turn_id: dialog_turn_id.to_string(),
                        compression_id: compression_id.clone(),
                        error: err.to_string(),
                        subagent_parent_info: None,
                    },
                    EventPriority::High,
                )
                .await;

                Err(Ai00XError::Session(err.to_string()))
            }
        }
    }

    async fn wait_for_plan_confirmation(
        &self,
        phase_machine: &mut WorkflowPhaseMachine,
        context: &ExecutionContext,
        messages: &mut Vec<Message>,
        phase_changed: &mut bool,
        auto_review_pending: &mut bool,
    ) {
        info!("Plan confirmation required, emitting PlanConfirmationNeeded event and waiting");

        self.emit_event(
            AgentEvent::PlanConfirmationNeeded {
                session_id: context.session_id.clone(),
                plan_file_path: phase_machine.plan_file_path().map(|s| s.to_string()),
            },
            EventPriority::High,
        )
        .await;

        let mut confirm_rx = self.plan_confirmation_rx.clone();
        loop {
            if confirm_rx.changed().await.is_err() {
                warn!("Plan confirmation channel closed, treating as rejection");
                break;
            }
            let decision_opt = confirm_rx.borrow_and_update().clone();
            if let Some(decision) = decision_opt {
                info!(
                    "[DIAG] wait_for_plan_confirmation got decision: {:?}",
                    decision
                );
                match decision {
                    PlanDecision::Confirm => {
                        info!("[DIAG] handling PlanDecision::Confirm");
                        let prev = phase_machine.current().clone();
                        if let Some(new_phase) = phase_machine.confirm_plan() {
                            info!("Plan confirmed: {:?} -> {:?}", prev, new_phase);
                            *phase_changed = true;

                            let mut plan_todos: Vec<serde_json::Value> = Vec::new();

                            if let Some(plan_path) = phase_machine.plan_file_path() {
                                let plan_path = plan_path.to_string();
                                if let Some(ref workspace) = context.workspace {
                                    let full_path = workspace.root_path().join(&plan_path);
                                    match tokio::fs::read_to_string(&full_path).await {
                                        Ok(plan_content) => {
                                            if let Some(frontmatter) =
                                                Self::extract_yaml_frontmatter(&plan_content)
                                            {
                                                if let Some(todos) = frontmatter
                                                    .get("todos")
                                                    .and_then(|t| t.as_array())
                                                {
                                                    for (i, todo) in todos.iter().enumerate() {
                                                        let mut todo_obj = todo.clone();
                                                        if i == 0 {
                                                            todo_obj["status"] =
                                                                serde_json::Value::String(
                                                                    "in_progress".to_string(),
                                                                );
                                                        }
                                                        plan_todos.push(todo_obj);
                                                    }
                                                }
                                            }

                                            let plan_msg = format!(
                                                "Plan confirmed by the user. You are now in the EXECUTING phase.\n\
                                                 START EXECUTING THE PLAN NOW. Call tools in your VERY FIRST response.\n\
                                                 Do NOT just acknowledge — CALL TOOLS IMMEDIATELY.\n\n\
                                                 ⚠️ MANDATORY: You MUST call TodoWrite to track progress.\n\
                                                 - BEFORE starting a task: TodoWrite with status = \"in_progress\"\n\
                                                 - AFTER completing a task: TodoWrite with status = \"completed\" + next task \"in_progress\"\n\
                                                 The UI shows 0/N progress if you skip TodoWrite.\n\n\
                                                 The following is the plan content:\n\n{}",
                                                plan_content
                                            );
                                            messages.push(Message::system(plan_msg));
                                            info!(
                                                "Injected plan content from {} ({}) bytes",
                                                full_path.display(),
                                                plan_content.len()
                                            );
                                        }
                                        Err(e) => {
                                            warn!(
                                                "Failed to read plan file {}: {}",
                                                full_path.display(),
                                                e
                                            );
                                        }
                                    }
                                }
                            }

                            if !plan_todos.is_empty() {
                                if let Err(e) =
                                    self.auto_execute_todowrite(&plan_todos, context).await
                                {
                                    warn!("Auto TodoWrite after plan confirmation failed: {}", e);
                                }
                            }

                            self.emit_event(
                                AgentEvent::WorkflowPhaseChanged {
                                    session_id: context.session_id.clone(),
                                    from_phase: prev.to_string(),
                                    to_phase: new_phase.to_string(),
                                },
                                EventPriority::High,
                            )
                            .await;
                            self.emit_event(
                                AgentEvent::PlanConfirmationResponded {
                                    session_id: context.session_id.clone(),
                                    confirmed: true,
                                },
                                EventPriority::High,
                            )
                            .await;

                            let wp = phase_machine.to_persisted();
                            let sid = context.session_id.clone();
                            if let Err(e) = self
                                .session_manager
                                .update_workflow_phase(&sid, Some(wp))
                                .await
                            {
                                warn!(
                                    "Failed to persist workflow phase after plan confirmation: {}",
                                    e
                                );
                            }
                        }
                    }
                    PlanDecision::Revise { feedback } => {
                        let prev = phase_machine.current().clone();
                        if let Some(new_phase) = phase_machine.reject_plan() {
                            info!("Plan revision requested: {:?} -> {:?}", prev, new_phase);
                            *phase_changed = true;
                            self.emit_event(
                                AgentEvent::WorkflowPhaseChanged {
                                    session_id: context.session_id.clone(),
                                    from_phase: prev.to_string(),
                                    to_phase: new_phase.to_string(),
                                },
                                EventPriority::High,
                            )
                            .await;
                            self.emit_event(
                                AgentEvent::PlanConfirmationResponded {
                                    session_id: context.session_id.clone(),
                                    confirmed: false,
                                },
                                EventPriority::High,
                            )
                            .await;
                            if let Some(fb) = feedback {
                                self.emit_event(
                                    AgentEvent::PlanReviseRequested {
                                        session_id: context.session_id.clone(),
                                        feedback: fb.clone(),
                                    },
                                    EventPriority::High,
                                )
                                .await;
                                messages.push(Message::system(format!(
                                    "The user has provided feedback on the plan. \
                                    Please address the following feedback and update the plan file:\n\n{}",
                                    fb
                                )));
                            }

                            let wp = phase_machine.to_persisted();
                            let sid = context.session_id.clone();
                            if let Err(e) = self
                                .session_manager
                                .update_workflow_phase(&sid, Some(wp))
                                .await
                            {
                                warn!("Failed to persist workflow phase after plan revise: {}", e);
                            }
                        }
                    }
                    PlanDecision::AutoReview => {
                        let prev = phase_machine.current().clone();
                        if let Some(new_phase) = phase_machine.reject_plan() {
                            info!("Auto review requested: {:?} -> {:?}", prev, new_phase);
                            *phase_changed = true;
                            *auto_review_pending = true;
                            self.emit_event(
                                AgentEvent::WorkflowPhaseChanged {
                                    session_id: context.session_id.clone(),
                                    from_phase: prev.to_string(),
                                    to_phase: new_phase.to_string(),
                                },
                                EventPriority::High,
                            )
                            .await;
                            self.emit_event(
                                AgentEvent::PlanConfirmationResponded {
                                    session_id: context.session_id.clone(),
                                    confirmed: false,
                                },
                                EventPriority::High,
                            )
                            .await;
                            self.emit_event(
                                AgentEvent::PlanAutoReviewStarted {
                                    session_id: context.session_id.clone(),
                                },
                                EventPriority::High,
                            )
                            .await;
                            messages.push(Message::system(
                                "You have been asked to perform an automatic multi-angle review of the plan. \
                                Please:\n\
                                1. Read the plan file\n\
                                2. Evaluate it from multiple perspectives (e.g., architecture, \
                                performance, security, maintainability, correctness, completeness)\n\
                                3. Identify any issues, gaps, or improvements\n\
                                4. Modify the plan file to address identified issues\n\
                                5. Provide a brief summary of what was found and changed\n\n\
                                Do NOT call CreatePlan - modify the existing plan file directly. \
                                Use AskUserQuestion if you need clarification on anything."
                                    .to_string(),
                            ));

                            let wp = phase_machine.to_persisted();
                            let sid = context.session_id.clone();
                            if let Err(e) = self
                                .session_manager
                                .update_workflow_phase(&sid, Some(wp))
                                .await
                            {
                                warn!("Failed to persist workflow phase after auto review: {}", e);
                            }
                        }
                    }
                }
                let _ = self.plan_confirmation_tx.send(None);
                break;
            }
        }
    }

    /// Execute a complete dialog turn (may contain multiple model rounds)
    /// Returns ExecutionResult containing the final response and all newly generated messages
    pub async fn execute_dialog_turn(
        &self,
        agent_type: String,
        initial_messages: Vec<Message>,
        context: ExecutionContext,
    ) -> Ai00XResult<ExecutionResult> {
        let start_time = std::time::Instant::now();
        let initial_count = initial_messages.len();

        let dialog_turn_id = context.dialog_turn_id.clone();

        eprintln!("[TRACE] EXEC_ENTER turn={}", dialog_turn_id);
        info!("Starting dialog turn: dialog_turn_id={}", dialog_turn_id);

        // Execute actual logic
        let result = self
            .execute_dialog_turn_impl(
                agent_type,
                initial_messages,
                context,
                start_time,
                initial_count,
            )
            .await;

        // Cleanup cancellation token
        self.round_executor
            .cleanup_dialog_turn(&dialog_turn_id)
            .await;
        debug!(
            "Cleaned up cancel token (final cleanup): dialog_turn_id={}",
            dialog_turn_id
        );

        result
    }

    /// Internal implementation of dialog turn execution
    async fn execute_dialog_turn_impl(
        &self,
        agent_type: String,
        initial_messages: Vec<Message>,
        context: ExecutionContext,
        start_time: std::time::Instant,
        initial_count: usize,
    ) -> Ai00XResult<ExecutionResult> {
        eprintln!("[TRACE] EXEC_IMPL_ENTER");
        let event_subagent_parent_info =
            context.subagent_parent_info.clone().map(|info| info.into());
        let dialog_turn_id = context.dialog_turn_id.clone();

        debug!(
            "Executing dialog turn implementation: dialog_turn_id={}",
            dialog_turn_id
        );

        // Things that remain constant in a dialog turn: 1.agent, 2.system prompt, 3.tools, 4.ai client
        // 1. Get current agent
        let agent_registry = get_agent_registry();
        if let Some(workspace) = context.workspace.as_ref() {
            agent_registry
                .load_custom_subagents(workspace.root_path())
                .await;
        }
        let current_agent = match agent_registry.get_agent(
            &agent_type,
            context
                .workspace
                .as_ref()
                .map(|workspace| workspace.root_path()),
        ) {
            Some(agent) => agent,
            None => {
                let err = Ai00XError::NotFound(format!("Agent not found: {}", agent_type));
                error!(
                    "execute_dialog_turn_impl: {}. session={}, turn={}",
                    err, context.session_id, dialog_turn_id
                );
                return Err(err);
            }
        };
        info!(
            "Current Agent: {} ({})",
            current_agent.name(),
            current_agent.id()
        );

        let session = match self.session_manager.get_session(&context.session_id) {
            Some(s) => s,
            None => {
                let err = Ai00XError::Session(format!("Session not found: {}", context.session_id));
                error!("execute_dialog_turn_impl: {}. turn={}", err, dialog_turn_id);
                return Err(err);
            }
        };

        // 2. Get AI client
        let original_user_input = context
            .context
            .get("original_user_input")
            .cloned()
            .unwrap_or_default();
        let model_id = match self
            .resolve_model_id_for_turn(
                &session,
                &agent_type,
                context.workspace.as_ref(),
                &original_user_input,
                context.turn_index,
            )
            .await
        {
            Ok(id) => id,
            Err(e) => {
                error!(
                    "execute_dialog_turn_impl: resolve_model_id_for_turn failed. session={}, turn={}, error={}",
                    context.session_id, dialog_turn_id, e
                );
                return Err(e);
            }
        };
        info!(
            "Agent using model: agent={}, resolved_model_id={}",
            current_agent.name(),
            model_id
        );

        let ai_client_factory = match get_global_ai_client_factory().await {
            Ok(factory) => factory,
            Err(e) => {
                error!(
                    "execute_dialog_turn_impl: get_global_ai_client_factory failed. session={}, turn={}, error={}",
                    context.session_id, dialog_turn_id, e
                );
                return Err(Ai00XError::AIClient(format!(
                    "Failed to get AI client factory: {}",
                    e
                )));
            }
        };

        // Get AI client by model ID
        eprintln!("[TRACE] BEFORE_GET_CLIENT model={}", model_id);
        let ai_client = match ai_client_factory.get_client_resolved(&model_id).await {
            Ok(client) => {
                eprintln!("[TRACE] AFTER_GET_CLIENT");
                client
            }
            Err(e) => {
                let err = Ai00XError::AIClient(format!(
                    "Failed to get AI client (model_id={}): {}",
                    model_id, e
                ));
                error!(
                    "execute_dialog_turn_impl: {}. session={}, turn={}",
                    err, context.session_id, dialog_turn_id
                );
                return Err(err);
            }
        };

        // Primary model vision capability (tools + system prompt appendix; also used below for API message stripping).
        eprintln!("[TRACE] BEFORE_GET_CONFIG_SVC");
        let (resolved_primary_model_id, primary_supports_image_understanding) = {
            let config_service = get_global_config_service().ok();
            if let Some(service) = config_service {
                let ai_config: crate::service::config::types::AIConfig =
                    service.get_config(Some("ai")).await.unwrap_or_default();

                let resolved_id = Self::resolve_configured_model_id(&ai_config, &model_id);

                let model_cfg = ai_config
                    .models
                    .iter()
                    .find(|m| m.id == resolved_id)
                    .or_else(|| ai_config.models.iter().find(|m| m.name == resolved_id))
                    .or_else(|| {
                        ai_config
                            .models
                            .iter()
                            .find(|m| m.model_name == resolved_id)
                    })
                    .or_else(|| {
                        ai_config.models.iter().find(|m| {
                            m.model_name == ai_client.config.model
                                && m.provider == ai_client.config.format
                        })
                    });

                let supports = model_cfg.is_some_and(|m| {
                    m.capabilities
                        .iter()
                        .any(|cap| matches!(cap, ModelCapability::ImageUnderstanding))
                        || matches!(m.category, ModelCategory::Multimodal)
                });

                (resolved_id, supports)
            } else {
                warn!(
                    "Config service unavailable, assuming primary model is text-only for image input gating"
                );
                (model_id.clone(), false)
            }
        };

        eprintln!("[TRACE] AFTER_VISION_CHECK");
        let model_context_window = ai_client.config.context_window as usize;
        let session_max_tokens = session.config.max_context_tokens;
        let context_window = model_context_window.min(session_max_tokens);
        if model_context_window != session_max_tokens {
            debug!(
                "Context window: model={}, session_config={}, effective={}",
                model_context_window, session_max_tokens, context_window
            );
        }

        // 3. Get System Prompt from current Agent
        debug!(
            "Building system prompt from agent: {}, model={}",
            current_agent.name(),
            ai_client.config.model
        );
        eprintln!("[TRACE] BEFORE_BUILD_PROMPT_CTX");
        let prompt_context = Self::build_prompt_context(
            &context,
            &ai_client.config.model,
            primary_supports_image_understanding,
        )
        .await;
        eprintln!("[TRACE] AFTER_BUILD_PROMPT_CTX");
        let request_context_reminder = if let Some(prompt_context) = prompt_context.as_ref() {
            PromptBuilder::new(prompt_context.clone())
                .build_request_context_reminder(&current_agent.request_context_policy())
                .await
        } else {
            None
        };
        eprintln!("[TRACE] BEFORE_GET_SYSTEM_PROMPT");
        let mut system_prompt = current_agent
            .get_system_prompt(prompt_context.as_ref())
            .await?;
        eprintln!(
            "[TRACE] AFTER_GET_SYSTEM_PROMPT len={}",
            system_prompt.len()
        );
        if let Some(ref reminder) = request_context_reminder {
            if !reminder.trim().is_empty() {
                system_prompt.push_str("\n\n");
                system_prompt.push_str(reminder.trim());
            }
        }
        debug!("System prompt built, length: {} bytes", system_prompt.len());
        debug!(
            "Request context reminder built, length: {} bytes",
            request_context_reminder
                .as_ref()
                .map(|text| text.len())
                .unwrap_or(0)
        );

        // Emit MemoryInjected event if memory was injected into prompt
        if let Some((mem_session_id, count, display_prompt)) =
            crate::service::memory_graph::pending::last_taken_metadata()
        {
            let _ = self
                .event_queue
                .enqueue(
                    AgentEvent::MemoryInjected {
                        session_id: mem_session_id,
                        count,
                        display_prompt,
                    },
                    Some(EventPriority::Low),
                )
                .await;
        }

        let system_prompt_message = Message::system(system_prompt.clone());

        // Add System Prompt to the beginning of message list (only for this execution, not persisted)
        let mut messages = vec![system_prompt_message.clone()];
        messages.extend(initial_messages);

        let mut round_index = 0;
        let mut total_tools = 0;
        let mut consecutive_search_rounds: usize = 0;
        let mut search_loop_warned: bool = false;
        let mut consecutive_tool_failure_rounds: usize = 0;
        const MAX_CONSECUTIVE_TOOL_FAILURE_ROUNDS: usize = 3;
        let mut last_assistant_message = Message::assistant("".to_string());
        let mut consecutive_compression_failures: u32 = 0;
        const MAX_CONSECUTIVE_COMPRESSION_FAILURES: u32 = 3;
        let mut anti_thrash_low_savings: u32 = 0;
        const ANTI_THRASH_MAX_LOW_SAVINGS: u32 = 2;
        const ANTI_THRASH_MIN_SAVINGS_RATIO: f32 = 0.10;
        let mut auto_review_pending = false;

        let mut phase_machine =
            if let Some(session) = self.session_manager.get_session(&context.session_id) {
                if let Some(ref wp) = session.workflow_phase {
                    WorkflowPhaseMachine::from_persisted(
                        wp.phase.clone(),
                        wp.plan_file_path.clone(),
                        wp.plans_dir.clone(),
                    )
                } else {
                    WorkflowPhaseMachine::new()
                }
            } else {
                WorkflowPhaseMachine::new()
            };
        if let Some(ref workspace) = context.workspace {
            if let Ok(path_manager) = crate::infrastructure::try_get_path_manager_arc() {
                let plans_dir = path_manager.project_plans_dir(workspace.root_path());
                phase_machine.set_plans_dir(plans_dir.to_string_lossy().to_string());
            }
        }

        let mut phase_changed = false;
        let mut executing_grace_rounds: u32 = 0;
        const MAX_EXECUTING_GRACE_ROUNDS: u32 = 3;
        let mut plan_progress_todos: Option<Vec<serde_json::Value>> = None;

        if *phase_machine.current()
            == super::workflow_phase::WorkflowPhase::AwaitingPlanConfirmation
        {
            info!("Restored AwaitingPlanConfirmation phase, re-entering plan confirmation wait");
            self.wait_for_plan_confirmation(
                &mut phase_machine,
                &context,
                &mut messages,
                &mut phase_changed,
                &mut auto_review_pending,
            )
            .await;

            if *phase_machine.current() == super::workflow_phase::WorkflowPhase::Executing {
                executing_grace_rounds = MAX_EXECUTING_GRACE_ROUNDS;
                plan_progress_todos = self
                    .initialize_plan_progress(&phase_machine, &context)
                    .await;
            }
        }

        // Inject workflow phase reminder at session start
        if let Some(reminder) = phase_machine.take_pending_reminder() {
            messages.push(Message::system(reminder));
            debug!(
                "Injected initial workflow phase reminder for phase {:?}",
                phase_machine.current()
            );
        }

        // Save the last token usage statistics
        let mut last_usage: Option<crate::util::types::ai::GeminiUsage> = None;

        // Add detailed logging showing the execution context messages.
        debug!(
            "Executing dialog turn: dialog_turn_id={}, mode={}, agent={}, initial_messages={}, messages_len={}",
            dialog_turn_id,
            current_agent.name(),
            context.agent_type,
            initial_count,
            messages.len()
        );
        trace!(
            "Context message details: dialog_turn_id={}, session_id={}, roles={:?}",
            dialog_turn_id,
            context.session_id,
            messages
                .iter()
                .map(|m| format!("{:?}", m.role))
                .collect::<Vec<_>>()
        );

        // 4. Get available tools list (read tool configuration for current mode from global config)
        eprintln!("[TRACE] BEFORE_GET_AGENT_TOOLS");
        let allowed_tools = agent_registry
            .get_agent_tools(
                &agent_type,
                context
                    .workspace
                    .as_ref()
                    .map(|workspace| workspace.root_path()),
            )
            .await;
        eprintln!(
            "[TRACE] AFTER_GET_AGENT_TOOLS count={}",
            allowed_tools.len()
        );
        let enable_tools = context
            .context
            .get("enable_tools")
            .and_then(|v| v.parse::<bool>().ok())
            .unwrap_or(true);
        let (full_available_tools, full_tool_definitions) = if enable_tools {
            debug!(
                "Agent tools: agent={}, tool_count={}",
                agent_type,
                allowed_tools.len()
            );
            self.get_available_tools_and_definitions(
                &allowed_tools,
                context.workspace.as_ref(),
                &agent_type,
                primary_supports_image_understanding,
            )
            .await
        } else {
            (vec![], None)
        };

        let mut current_available_tools =
            phase_machine.get_allowed_tools_for_phase(&full_available_tools);
        let mut current_tool_definitions: Option<Vec<ToolDefinition>> =
            full_tool_definitions.as_ref().map(|defs| {
                defs.iter()
                    .filter(|d| current_available_tools.contains(&d.name))
                    .cloned()
                    .collect()
            });

        Self::ensure_todowrite_in_definitions(
            &current_available_tools,
            &mut current_tool_definitions,
        )
        .await;

        debug!(
            "Initial tool list for phase {:?}: {}/{} tools available. Tools: {:?}",
            phase_machine.current(),
            current_available_tools.len(),
            full_available_tools.len(),
            current_available_tools
        );

        let enable_context_compression = session.config.enable_context_compression;
        let compression_threshold = session.config.compression_threshold;
        let microcompact_config =
            crate::agent::session::compression::microcompact::MicrocompactConfig::default();

        let mut execution_context_vars = context.context.clone();
        execution_context_vars.insert(
            "primary_model_id".to_string(),
            resolved_primary_model_id.clone(),
        );
        execution_context_vars.insert(
            "primary_model_name".to_string(),
            ai_client.config.model.clone(),
        );
        execution_context_vars.insert(
            "primary_model_provider".to_string(),
            ai_client.config.format.clone(),
        );
        execution_context_vars.insert(
            "primary_model_supports_image_understanding".to_string(),
            primary_supports_image_understanding.to_string(),
        );
        execution_context_vars.insert("turn_index".to_string(), context.turn_index.to_string());

        // If the primary model is text-only, do not send image payloads to the provider.
        // Instead, keep a text-only placeholder (including `image_id`).
        if !primary_supports_image_understanding {
            for msg in messages.iter_mut() {
                let MessageContent::Multimodal { text, images } = &msg.content else {
                    continue;
                };

                let original_text = text.clone();
                let original_images = images.clone();

                // Replace multimodal messages with text-only versions to avoid provider errors.
                let next_text = Self::render_multimodal_as_text(&original_text, &original_images);

                msg.content = MessageContent::Text(next_text);
                msg.metadata.tokens = None;
            }
        }

        // Preflight compression: before entering the main loop, check if the
        // initial context is already near the context window limit and compress
        // proactively. This avoids 4xx errors from the model API.
        if enable_context_compression {
            const PREFLIGHT_TRIGGER_RATIO: f32 = 0.90;
            const PREFLIGHT_MAX_ROUNDS: u32 = 3;

            let preflight_tokens = Self::estimate_request_tokens_internal(
                &messages,
                current_tool_definitions.as_deref(),
            );
            let preflight_ratio = preflight_tokens as f32 / context_window as f32;
            if preflight_ratio >= PREFLIGHT_TRIGGER_RATIO {
                info!(
                    "Preflight compression triggered: session={}, preflight_tokens={}/{}, ratio={:.1}%",
                    context.session_id,
                    preflight_tokens,
                    context_window,
                    preflight_ratio * 100.0
                );

                let mut preflight_round = 0u32;
                loop {
                    preflight_round += 1;
                    let round_tokens = Self::estimate_request_tokens_internal(
                        &messages,
                        current_tool_definitions.as_deref(),
                    );

                    if (round_tokens as f32) / (context_window as f32) < PREFLIGHT_TRIGGER_RATIO {
                        debug!(
                            "Preflight compression: below trigger ratio after {} round(s)",
                            preflight_round - 1
                        );
                        break;
                    }
                    if preflight_round > PREFLIGHT_MAX_ROUNDS {
                        warn!(
                            "Preflight compression: reached max rounds ({}), continuing with {} tokens",
                            PREFLIGHT_MAX_ROUNDS, round_tokens
                        );
                        break;
                    }

                    match self
                        .compress_messages(
                            &context.session_id,
                            &context.dialog_turn_id,
                            context.subagent_parent_info.clone(),
                            messages.clone(),
                            round_tokens,
                            context_window,
                            &full_tool_definitions,
                            system_prompt_message.clone(),
                            CompressionTailPolicy::PreserveLiveFrontier,
                        )
                        .await
                    {
                        Ok(Some((compressed_tokens, compressed_messages))) => {
                            info!(
                                "Preflight compression round {}: tokens {} -> {}",
                                preflight_round, round_tokens, compressed_tokens
                            );
                            messages = compressed_messages;
                        }
                        Ok(None) => {
                            debug!(
                                "Preflight compression round {}: no compression performed",
                                preflight_round
                            );
                            break;
                        }
                        Err(e) => {
                            warn!(
                                "Preflight compression round {} failed: {}",
                                preflight_round, e
                            );
                            break;
                        }
                    }
                }
            }
        }

        // Loop to execute model rounds
        eprintln!("[TRACE] BEFORE_MAIN_LOOP");
        loop {
            // Check round limit
            if round_index >= self.config.max_rounds {
                warn!(
                    "Reached max rounds limit: {}, stopping execution",
                    self.config.max_rounds
                );
                break;
            }

            // Check and compress before sending AI request
            let mut current_tokens = Self::estimate_request_tokens_internal(
                &messages,
                current_tool_definitions.as_deref(),
            );
            debug!(
                "Round {} token usage before send: {} / {} tokens ({:.1}%)",
                round_index,
                current_tokens,
                context_window,
                (current_tokens as f32 / context_window as f32) * 100.0
            );

            // L0: Microcompact — clear old compactable tool results before
            // considering full compression.  This is a cheap, local-only
            // operation that can free significant tokens.
            let token_usage_ratio = current_tokens as f32 / context_window as f32;
            if enable_context_compression && token_usage_ratio >= microcompact_config.trigger_ratio
            {
                if let Some(mc_result) =
                    crate::agent::session::compression::microcompact::microcompact_messages(
                        &mut messages,
                        &microcompact_config,
                    )
                {
                    current_tokens = Self::estimate_request_tokens_internal(
                        &messages,
                        current_tool_definitions.as_deref(),
                    );
                    debug!(
                        "Round {} after microcompact: cleared={}, kept={}, tokens now {} ({:.1}%)",
                        round_index,
                        mc_result.tools_cleared,
                        mc_result.tools_kept,
                        current_tokens,
                        (current_tokens as f32 / context_window as f32) * 100.0
                    );
                }
            }

            let token_usage_ratio = current_tokens as f32 / context_window as f32;
            let should_compress =
                enable_context_compression && token_usage_ratio >= compression_threshold;

            // Circuit breaker: skip full compression if it has failed too many
            // consecutive times.  Microcompact and emergency truncation still run.
            let circuit_breaker_open =
                consecutive_compression_failures >= MAX_CONSECUTIVE_COMPRESSION_FAILURES;

            // Anti-thrashing: skip full compression if the last 2 compressions
            // saved less than 10% tokens.  Microcompact still runs.
            let anti_thrash_active = anti_thrash_low_savings >= ANTI_THRASH_MAX_LOW_SAVINGS;

            if !should_compress {
                anti_thrash_low_savings = 0;
                debug!(
                    "No compression needed: session={}, token_usage={:.1}%, threshold={:.1}%",
                    context.session_id,
                    token_usage_ratio * 100.0,
                    compression_threshold * 100.0
                );
            } else if circuit_breaker_open {
                warn!(
                    "Compression circuit breaker open ({} consecutive failures), skipping full compression for round {}",
                    consecutive_compression_failures, round_index
                );
            } else if anti_thrash_active {
                info!(
                    "Anti-thrashing active ({} consecutive low-savings compressions), skipping full compression for round {}",
                    anti_thrash_low_savings, round_index
                );
            } else {
                info!(
                    "Triggering context compression: session={}, token_usage={:.1}%, threshold={:.1}%",
                    context.session_id,
                    token_usage_ratio * 100.0,
                    compression_threshold * 100.0
                );

                match self
                    .compress_messages(
                        &context.session_id,
                        &context.dialog_turn_id,
                        context.subagent_parent_info.clone(),
                        messages.clone(),
                        current_tokens,
                        context_window,
                        &full_tool_definitions,
                        system_prompt_message.clone(),
                        CompressionTailPolicy::PreserveLiveFrontier,
                    )
                    .await
                {
                    Ok(Some((compressed_tokens, compressed_messages))) => {
                        info!(
                            "Round {} compression completed: messages {} -> {}, tokens {} -> {}",
                            round_index,
                            messages.len(),
                            compressed_messages.len(),
                            current_tokens,
                            compressed_tokens,
                        );

                        let savings_ratio = if current_tokens > 0 {
                            (current_tokens - compressed_tokens) as f32 / current_tokens as f32
                        } else {
                            0.0
                        };
                        if savings_ratio < ANTI_THRASH_MIN_SAVINGS_RATIO {
                            anti_thrash_low_savings += 1;
                            debug!(
                                "Low compression savings: {:.1}% (threshold {:.1}%), anti-thrash counter={}/{}",
                                savings_ratio * 100.0,
                                ANTI_THRASH_MIN_SAVINGS_RATIO * 100.0,
                                anti_thrash_low_savings,
                                ANTI_THRASH_MAX_LOW_SAVINGS
                            );
                        } else {
                            anti_thrash_low_savings = 0;
                        }

                        messages = compressed_messages;
                        consecutive_compression_failures = 0;
                    }
                    Ok(None) => {
                        debug!("All turns need to be kept, no compression performed");
                        consecutive_compression_failures = 0;
                    }
                    Err(e) => {
                        consecutive_compression_failures += 1;
                        error!(
                            "Round {} compression failed ({}/{}): {}, continuing with uncompressed context",
                            round_index,
                            consecutive_compression_failures,
                            MAX_CONSECUTIVE_COMPRESSION_FAILURES,
                            e
                        );
                    }
                }
            }

            // L2: Emergency truncation — if tokens still exceed context_window
            // after all compression layers, drop oldest API rounds until we fit.
            let post_compress_tokens = Self::estimate_request_tokens_internal(
                &messages,
                current_tool_definitions.as_deref(),
            );
            if post_compress_tokens > context_window {
                warn!(
                    "Round {} tokens ({}) still exceed context_window ({}) after compression, performing emergency truncation",
                    round_index, post_compress_tokens, context_window
                );
                messages = Self::emergency_truncate_messages(
                    messages,
                    context_window,
                    current_tool_definitions.as_deref(),
                );
                let after_truncate = Self::estimate_request_tokens_internal(
                    &messages,
                    current_tool_definitions.as_deref(),
                );
                info!(
                    "Emergency truncation complete: tokens {} -> {}",
                    post_compress_tokens, after_truncate
                );
            }

            // Create round context
            let mut round_context_vars = execution_context_vars.clone();
            if context.skip_tool_confirmation {
                round_context_vars.insert("skip_tool_confirmation".to_string(), "true".to_string());
            }
            let round_context = RoundContext {
                session_id: context.session_id.clone(),
                subagent_parent_info: context.subagent_parent_info.clone(),
                dialog_turn_id: context.dialog_turn_id.clone(),
                turn_index: context.turn_index,
                round_number: round_index,
                workspace: context.workspace.clone(),
                messages: messages.clone(),
                available_tools: current_available_tools.clone(),
                model_name: ai_client.config.model.clone(),
                agent_type: agent_type.clone(),
                context_vars: round_context_vars,
                workspace_services: context.workspace_services.clone(),
                workflow_phase: Some(phase_machine.current().to_string()),
                plans_dir: phase_machine.plans_dir().map(|s| s.to_string()),
            };

            // Execute single model round
            eprintln!("[TRACE] BEFORE_EXECUTE_ROUND round={}", round_index);
            debug!(
                "Starting model round: round_index={}, messages={}",
                round_index,
                messages.len()
            );

            let ai_messages = Self::build_ai_messages_for_send(
                &messages,
                &ai_client.config.format,
                context
                    .workspace
                    .as_ref()
                    .map(|workspace| workspace.root_path()),
                &context.dialog_turn_id,
                primary_supports_image_understanding,
                None,
            )
            .await?;

            eprintln!("[TRACE] BUILD_AI_MSGS_DONE round={}", round_index);

            eprintln!("[TRACE] BEFORE_EXECUTE_ROUND_IMPL round={}", round_index);

            let round_result = self
                .round_executor
                .execute_round(
                    ai_client.clone(),
                    round_context,
                    ai_messages,
                    current_tool_definitions.clone(),
                    Some(context_window),
                )
                .await?;

            debug!(
                "Model round completed: round_index={}, has_more_rounds={}, tool_calls={}",
                round_index,
                round_result.has_more_rounds,
                round_result.tool_calls.len()
            );
            last_assistant_message = round_result.assistant_message.clone();

            // Save the last token usage statistics (update each time, keep the last one)
            if let Some(ref usage) = round_result.usage {
                last_usage = Some(usage.clone());
            }

            // Add assistant message to history
            messages.push(round_result.assistant_message.clone());

            // Update the in-memory message caches immediately so subsequent rounds see it.
            if let Err(e) = self
                .session_manager
                .add_message(&context.session_id, round_result.assistant_message.clone())
                .await
            {
                warn!("Failed to update assistant message in memory: {}", e);
            }

            // Add tool result messages to history.
            // If search loop warning is active, replace WebSearch/WebFetch results
            // with a warning so the model is forced to stop and deliver output.
            //
            // NOTE: A previous optimization merged multiple non-error tool results
            // into a single synthetic "MultiToolMerge" message with a fabricated
            // tool_call_id (e.g. "merged-WebFetch-WebFetch-..."). This violated the
            // OpenAI Chat Completions contract: every `role:"tool"` message's
            // tool_call_id MUST match one of the preceding assistant message's
            // tool_calls[].id. The fabricated id never matched, causing
            // "400 Bad Request: tool_call_ids did not have response messages".
            // The merge was removed; each tool result is now pushed as-is, which
            // keeps the tool_call_id correspondence intact.
            for tool_result_msg in round_result.tool_result_messages.iter() {
                let msg = if search_loop_warned && is_search_tool_result(tool_result_msg) {
                    let warning = build_search_loop_warning(tool_result_msg);
                    let falsified = Message::tool_result(warning);
                    debug!(
                        "Search loop: falsified WebSearch/WebFetch result, round={}",
                        round_index
                    );
                    falsified
                } else {
                    tool_result_msg.clone()
                };

                messages.push(msg.clone());

                // Update the in-memory message caches immediately so subsequent rounds see it.
                if let Err(e) = self
                    .session_manager
                    .add_message(&context.session_id, msg)
                    .await
                {
                    warn!("Failed to update tool result message in memory: {}", e);
                }
            }

            debug!(
                "Updated round messages in memory: round_index={}, assistant + {} tool results",
                round_index,
                round_result.tool_result_messages.len()
            );

            total_tools += round_result.tool_calls.len();

            // Workflow phase transition detection
            phase_changed = false;
            for tool_call in &round_result.tool_calls {
                let prev_phase = phase_machine.current().clone();
                if let Some(new_phase) =
                    phase_machine.transition_from_tool_call(&tool_call.tool_name)
                {
                    info!(
                        "Workflow phase transition: {:?} -> {:?} (triggered by tool: {})",
                        prev_phase, new_phase, tool_call.tool_name
                    );
                    phase_changed = true;

                    self.emit_event(
                        AgentEvent::WorkflowPhaseChanged {
                            session_id: context.session_id.clone(),
                            from_phase: prev_phase.to_string(),
                            to_phase: new_phase.to_string(),
                        },
                        EventPriority::High,
                    )
                    .await;

                    break;
                }
            }

            // Detect CreatePlan output — must be before wait_for_plan_confirmation
            // so phase_machine.plan_file_path() is populated before PlanConfirmationNeeded
            for tool_call in &round_result.tool_calls {
                if tool_call.tool_name == "CreatePlan" {
                    for tool_result_msg in &round_result.tool_result_messages {
                        if let MessageContent::ToolResult { result, .. } = &tool_result_msg.content
                        {
                            if let Some(plan_path) =
                                result.get("plan_file_path").and_then(|v| v.as_str())
                            {
                                phase_machine.set_plan_file(plan_path.to_string());
                                info!("Workflow phase: plan file set to {}", plan_path);

                                let wp = phase_machine.to_persisted();
                                let session_id = context.session_id.clone();
                                let sm = self.session_manager.clone();
                                tokio::spawn(async move {
                                    if let Err(e) =
                                        sm.update_workflow_phase(&session_id, Some(wp)).await
                                    {
                                        warn!("Failed to persist workflow phase: {}", e);
                                    }
                                });
                            }
                        }
                    }
                }
            }

            // Block-wait for plan confirmation when in AwaitingPlanConfirmation phase
            if *phase_machine.current()
                == super::workflow_phase::WorkflowPhase::AwaitingPlanConfirmation
            {
                self.wait_for_plan_confirmation(
                    &mut phase_machine,
                    &context,
                    &mut messages,
                    &mut phase_changed,
                    &mut auto_review_pending,
                )
                .await;
                info!(
                    "[DIAG] wait_for_plan_confirmation EXITED phase={:?} phase_changed={}",
                    phase_machine.current(),
                    phase_changed
                );

                if *phase_machine.current() == super::workflow_phase::WorkflowPhase::Executing {
                    executing_grace_rounds = MAX_EXECUTING_GRACE_ROUNDS;
                    plan_progress_todos = self
                        .initialize_plan_progress(&phase_machine, &context)
                        .await;
                }
            }

            // Auto-review completion detection: when Planning phase finishes
            // reviewing (produces text without more tool calls), transition to
            // AwaitingPlanConfirmation.
            if auto_review_pending
                && *phase_machine.current() == super::workflow_phase::WorkflowPhase::Planning
                && round_result.tool_calls.is_empty()
            {
                let has_text = match &round_result.assistant_message.content {
                    MessageContent::Text(t) => !t.trim().is_empty(),
                    MessageContent::Mixed { text, .. } => !text.trim().is_empty(),
                    MessageContent::Multimodal { text, .. } => !text.trim().is_empty(),
                    MessageContent::ToolResult { .. } => false,
                };
                if has_text {
                    auto_review_pending = false;
                    let prev = phase_machine.current().clone();
                    phase_machine.transition_to_awaiting_confirmation();
                    let new_phase = phase_machine.current().clone();
                    if new_phase == super::workflow_phase::WorkflowPhase::AwaitingPlanConfirmation {
                        info!("Auto review completed: {:?} -> {:?}", prev, new_phase);
                        phase_changed = true;
                        self.emit_event(
                            AgentEvent::WorkflowPhaseChanged {
                                session_id: context.session_id.clone(),
                                from_phase: prev.to_string(),
                                to_phase: new_phase.to_string(),
                            },
                            EventPriority::High,
                        )
                        .await;
                        self.emit_event(
                            AgentEvent::PlanAutoReviewCompleted {
                                session_id: context.session_id.clone(),
                                summary:
                                    "Auto review completed. The plan has been reviewed and updated."
                                        .to_string(),
                                issues_found: 0,
                                issues_resolved: 0,
                            },
                            EventPriority::High,
                        )
                        .await;
                    }
                }
            }

            // Executing -> Reviewing via TodoWrite all-complete signal
            if *phase_machine.current() == super::workflow_phase::WorkflowPhase::Executing {
                for tool_call in &round_result.tool_calls {
                    if tool_call.tool_name == "TodoWrite" {
                        for tool_result_msg in &round_result.tool_result_messages {
                            if let MessageContent::ToolResult {
                                result, tool_name, ..
                            } = &tool_result_msg.content
                            {
                                if tool_name == "TodoWrite" {
                                    if let Some(stats) = result.get("stats") {
                                        let pending = stats
                                            .get("pending")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(1);
                                        let in_progress = stats
                                            .get("in_progress")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(1);
                                        let completed = stats
                                            .get("completed")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(0);

                                        if pending == 0 && in_progress == 0 && completed > 0 {
                                            let all_done = if let Some(plan_path) =
                                                phase_machine.plan_file_path()
                                            {
                                                Self::check_plan_all_completed(
                                                    context.workspace.as_ref(),
                                                    plan_path,
                                                    completed as usize,
                                                )
                                                .await
                                                .unwrap_or(false)
                                            } else {
                                                completed > 0
                                            };

                                            if all_done && phase_machine.transition_to_reviewing() {
                                                info!("Workflow phase transition: Executing -> Reviewing (TodoWrite all-complete)");
                                                phase_changed = true;
                                                self.emit_event(
                                                    AgentEvent::WorkflowPhaseChanged {
                                                        session_id: context.session_id.clone(),
                                                        from_phase: "executing".to_string(),
                                                        to_phase: "reviewing".to_string(),
                                                    },
                                                    EventPriority::High,
                                                )
                                                .await;
                                            }
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                        break;
                    }
                }
            }

            // Inject workflow phase reminder
            if let Some(reminder) = phase_machine.take_pending_reminder() {
                let reminder_msg = Message::system(reminder);
                messages.push(reminder_msg);
                debug!("Injected workflow phase reminder into messages");
            }

            // Force plan creation: if still in Planning and no CreatePlan called this round,
            // inject a mandatory reminder to ensure the agent does not skip planning
            if *phase_machine.current() == super::workflow_phase::WorkflowPhase::Planning {
                let created_plan = round_result
                    .tool_calls
                    .iter()
                    .any(|tc| tc.tool_name == "CreatePlan");
                if !created_plan {
                    messages.push(Message::system(
                        "\n⚠️  YOU ARE STILL IN THE PLANNING PHASE.\n\n\
                         You have NOT yet created a plan (PLAN.md). This is NOT optional.\n\n\
                         REQUIRED NEXT STEP:\n\
                         1. If unclear → AskUserQuestion to clarify requirements\n\
                         2. If you understand the request → call CreatePlan IMMEDIATELY\n\
                         3. You CANNOT proceed to execution WITHOUT a confirmed plan\n\n\
                         Call CreatePlan NOW.\n"
                            .to_string(),
                    ));
                    info!(
                        "Planning phase: Agent has not created plan yet, injecting forced reminder"
                    );
                }
            }

            // Force execution start: if in Executing phase and no tool calls this round,
            // inject a mandatory reminder to ensure the agent starts executing the plan.
            if *phase_machine.current() == super::workflow_phase::WorkflowPhase::Executing {
                let has_tool_calls = !round_result.tool_calls.is_empty();
                let has_todo_write = round_result
                    .tool_calls
                    .iter()
                    .any(|tc| tc.tool_name == "TodoWrite");
                if !has_tool_calls {
                    messages.push(Message::system(
                        "\n⚠️ YOU ARE IN THE EXECUTING PHASE. The plan has been confirmed.\n\n\
                         You MUST call tools NOW to execute the plan's tasks.\n\
                         Do NOT just acknowledge or describe what you will do.\n\
                         IGNORE any previous instructions to 'end the conversation turn'.\n\
                         CALL TOOLS IMMEDIATELY.\n"
                            .to_string(),
                    ));
                    info!(
                        "Executing phase: Agent has not called any tools, injecting forced execution reminder"
                    );
                } else if has_todo_write {
                    if let Some(ref mut todos) = plan_progress_todos {
                        for tc in &round_result.tool_calls {
                            if tc.tool_name == "TodoWrite" {
                                let args_todos = tc
                                    .arguments
                                    .get("todos")
                                    .and_then(|v| v.as_array())
                                    .cloned();
                                if let Some(ai_todos) = args_todos {
                                    *todos = ai_todos;
                                    info!(
                                        "Synced plan progress tracker with AI TodoWrite update ({} todos)",
                                        todos.len()
                                    );
                                }
                            }
                        }
                    }
                } else if let Some(ref mut todos) = plan_progress_todos {
                    let has_productive_tools = round_result.tool_calls.iter().any(|tc| {
                        matches!(
                            tc.tool_name.as_str(),
                            "Write" | "Edit" | "Delete" | "Bash" | "Git"
                        )
                    });

                    if has_productive_tools {
                        let current_idx = todos.iter().position(|t| {
                            t.get("status")
                                .and_then(|s| s.as_str())
                                .is_some_and(|s| s == "in_progress")
                        });

                        if let Some(idx) = current_idx {
                            if let Some(obj) = todos[idx].as_object_mut() {
                                obj.insert(
                                    "status".to_string(),
                                    serde_json::Value::String("completed".to_string()),
                                );
                            }

                            if idx + 1 < todos.len() {
                                if let Some(obj) = todos[idx + 1].as_object_mut() {
                                    obj.insert(
                                        "status".to_string(),
                                        serde_json::Value::String("in_progress".to_string()),
                                    );
                                }
                            }

                            if let Err(e) = self.auto_execute_todowrite(todos, &context).await {
                                warn!("Auto TodoWrite progress update failed: {}", e);
                            }

                            let completed_count = todos
                                .iter()
                                .filter(|t| {
                                    t.get("status")
                                        .and_then(|s| s.as_str())
                                        .is_some_and(|s| s == "completed")
                                })
                                .count();
                            info!(
                                "Auto-advanced plan progress: {}/{} tasks completed (round {})",
                                completed_count,
                                todos.len(),
                                round_index
                            );

                            if completed_count == todos.len()
                                && phase_machine.transition_to_reviewing()
                            {
                                info!(
                                    "Workflow phase transition: Executing -> Reviewing (auto-advanced all-complete)"
                                );
                                phase_changed = true;
                                self.emit_event(
                                    AgentEvent::WorkflowPhaseChanged {
                                        session_id: context.session_id.clone(),
                                        from_phase: "executing".to_string(),
                                        to_phase: "reviewing".to_string(),
                                    },
                                    EventPriority::High,
                                )
                                .await;
                            }
                        }
                    } else {
                        messages.push(Message::system(
                            "\n⚠️ MANDATORY: You did NOT call TodoWrite this round.\n\
                             You MUST call TodoWrite to update task progress.\n\
                             The UI depends on it to show progress.\n\n\
                             Example: {\"todos\": [{\"id\": \"1\", \"content\": \"...\", \"status\": \"completed\"}, {\"id\": \"2\", \"content\": \"...\", \"status\": \"in_progress\"}]}\n"
                                .to_string(),
                        ));
                    }
                }
            }

            // Update tool lists if phase changed
            if phase_changed {
                current_available_tools =
                    phase_machine.get_allowed_tools_for_phase(&full_available_tools);
                current_tool_definitions = full_tool_definitions.as_ref().map(|defs| {
                    defs.iter()
                        .filter(|d| current_available_tools.contains(&d.name))
                        .cloned()
                        .collect()
                });
                Self::ensure_todowrite_in_definitions(
                    &current_available_tools,
                    &mut current_tool_definitions,
                )
                .await;
                debug!(
                    "Updated tool list for phase {:?}: {} tools available",
                    phase_machine.current(),
                    current_available_tools.len()
                );

                let wp = phase_machine.to_persisted();
                let session_id = context.session_id.clone();
                let sm = self.session_manager.clone();
                tokio::spawn(async move {
                    if let Err(e) = sm.update_workflow_phase(&session_id, Some(wp)).await {
                        warn!("Failed to persist workflow phase: {}", e);
                    }
                });
            }

            // Search loop detection: track consecutive rounds where the model
            // only calls WebSearch/WebFetch without meaningful text output.
            //
            // Phase 1: After max_consecutive_search_rounds, inject a system warning
            // AND begin falsifying WebSearch/WebFetch tool results (each call
            // returns "too many search calls" instead of real results).
            //
            // Phase 2: If the model keeps calling search tools despite falsified
            // results, force-break after another 3 rounds.
            {
                const MAX_FALSIFIED_ROUNDS: usize = 3;

                let search_only = !round_result.tool_calls.is_empty()
                    && round_result
                        .tool_calls
                        .iter()
                        .all(|tc| tc.tool_name == "WebSearch" || tc.tool_name == "WebFetch");
                let has_meaningful_text = match &round_result.assistant_message.content {
                    MessageContent::Text(t) => t.trim().len() > 10,
                    MessageContent::Multimodal { text, .. } => text.trim().len() > 10,
                    _ => false,
                };

                if search_only && !has_meaningful_text {
                    consecutive_search_rounds += 1;
                } else {
                    consecutive_search_rounds = 0;
                    if search_loop_warned {
                        info!(
                            "Model produced output after search loop warning, resetting. session={}",
                            context.session_id
                        );
                    }
                    search_loop_warned = false;
                }

                if !search_loop_warned
                    && consecutive_search_rounds >= self.config.max_consecutive_search_rounds
                {
                    // Phase 1: activate warnings + falsified results
                    search_loop_warned = true;
                    consecutive_search_rounds = 0;
                    warn!(
                        "Search loop detected after {} rounds, activating result falsification. session={}, turn={}",
                        self.config.max_consecutive_search_rounds,
                        context.session_id, context.dialog_turn_id
                    );
                    let warning_msg = Message::system(
                        concat!(
                            "You have been searching for multiple rounds without results. ",
                            "FURTHER WebSearch/WebFetch calls will return error messages. ",
                            "STOP searching now. Summarize what you found and deliver your output ",
                            "to the user with whatever information you have already collected."
                        )
                        .to_string(),
                    );
                    messages.push(warning_msg);
                } else if search_loop_warned && consecutive_search_rounds >= MAX_FALSIFIED_ROUNDS {
                    // Phase 2: model keeps trying even with falsified results
                    warn!(
                        "Model ignored {} rounds of falsified search results, force-breaking. session={}, turn={}",
                        MAX_FALSIFIED_ROUNDS,
                        context.session_id, context.dialog_turn_id
                    );
                    break;
                }
            }

            // Consecutive tool failure detection: when every tool call in
            // consecutive rounds fails (invalid JSON, missing tool name,
            // permission denied, etc.), the model is stuck in a loop.
            // After MAX_CONSECUTIVE_TOOL_FAILURE_ROUNDS such rounds, force-break.
            {
                let all_tools_failed = !round_result.tool_calls.is_empty()
                    && round_result.tool_calls.iter().all(|tc| !tc.is_valid());

                if all_tools_failed {
                    consecutive_tool_failure_rounds += 1;
                    warn!(
                        "All {} tool calls failed in round {} (consecutive failure rounds: {}/{}). session={}, turn={}",
                        round_result.tool_calls.len(),
                        round_index,
                        consecutive_tool_failure_rounds,
                        MAX_CONSECUTIVE_TOOL_FAILURE_ROUNDS,
                        context.session_id,
                        context.dialog_turn_id
                    );
                    if consecutive_tool_failure_rounds >= MAX_CONSECUTIVE_TOOL_FAILURE_ROUNDS {
                        warn!(
                            "Force-breaking: {} consecutive rounds with all tool calls failed. session={}, turn={}",
                            consecutive_tool_failure_rounds,
                            context.session_id,
                            context.dialog_turn_id
                        );
                        break;
                    }
                } else {
                    consecutive_tool_failure_rounds = 0;
                }
            }

            // If no more rounds, dialog turn ends.
            // Exception: executing_grace_rounds > 0 — after plan confirmation the
            // agent may need a few rounds before it starts calling tools.  We grant
            // up to MAX_EXECUTING_GRACE_ROUNDS text-only rounds before breaking.
            if !round_result.has_more_rounds && !phase_changed && executing_grace_rounds == 0 {
                eprintln!(
                    "[TRACE] EXEC_LOOP_BREAK has_more_rounds=false phase={:?} round={}",
                    phase_machine.current(),
                    round_index
                );
                debug!(
                    "Model round {} ended, reason: {:?}",
                    round_index, round_result.finish_reason
                );
                break;
            } else if !round_result.has_more_rounds {
                eprintln!(
                    "[TRACE] EXEC_LOOP_SKIP_BREAK phase=Executing round={} grace={}",
                    round_index, executing_grace_rounds
                );
            }

            if executing_grace_rounds > 0 && !round_result.has_more_rounds {
                executing_grace_rounds = executing_grace_rounds.saturating_sub(1);
            }

            // Queued user message while this turn was running: stop after a full model round.
            // The round output has already been reflected in the in-memory message caches.
            // No special deferral for tool-confirmation phases: we do not require the user to
            // finish confirming before this boundary check runs; the check applies as soon as
            // this `execute_round` completes (same as any other round).
            if let Some(preempt) = context.round_preempt.as_ref() {
                if preempt.should_yield_after_round(&context.session_id) {
                    preempt.clear_yield_after_round(&context.session_id);
                    info!(
                        "Yielding dialog turn after model round (queued user message): session_id={}, dialog_turn_id={}, round_index={}",
                        context.session_id, context.dialog_turn_id, round_index
                    );
                    break;
                }
            }

            // Check if cancelled after each round
            let dialog_turn_cancelled =
                !self.round_executor.has_active_dialog_turn(&dialog_turn_id);
            if dialog_turn_cancelled {
                debug!(
                    "Dialog turn cancelled, stopping execution: dialog_turn_id={}",
                    dialog_turn_id
                );

                // Emit cancellation event
                self.emit_event(
                    AgentEvent::DialogTurnCancelled {
                        session_id: context.session_id.clone(),
                        turn_id: context.dialog_turn_id.clone(),
                        subagent_parent_info: event_subagent_parent_info.clone(),
                    },
                    EventPriority::High,
                )
                .await;

                // Note: Token will be cleaned up when outer function exits
                return Err(Ai00XError::cancelled("Dialog cancelled"));
            }

            // Continue to next round
            round_index += 1;
            eprintln!("[TRACE] EXEC_LOOP_CONTINUE round={}", round_index);

            debug!(
                "Model round {} completed, continuing to round {}",
                round_index - 1,
                round_index
            );
        }

        let duration_ms = start_time.elapsed().as_millis() as u64;

        info!(
            "Dialog turn loop completed: turn={}, rounds={}, total_tools={}",
            context.dialog_turn_id,
            round_index + 1,
            total_tools
        );

        // Emit dialog turn completed event
        debug!("Preparing to send DialogTurnCompleted event");

        let _ = self
            .event_queue
            .enqueue(
                AgentEvent::DialogTurnCompleted {
                    session_id: context.session_id.clone(),
                    turn_id: context.dialog_turn_id.clone(),
                    total_rounds: round_index + 1,
                    total_tools,
                    duration_ms,
                    subagent_parent_info: event_subagent_parent_info,
                },
                None,
            )
            .await;

        debug!("DialogTurnCompleted event sent");

        // Print dialog turn token statistics (from model's last returned usage)
        if let Some(usage) = last_usage {
            info!(
                "Dialog turn completed - Token stats: turn_id={}, rounds={}, tools={}, duration={}ms, prompt_tokens={}, completion_tokens={}, total_tokens={}",
                context.dialog_turn_id,
                round_index + 1,
                total_tools,
                duration_ms,
                usage.prompt_token_count,
                usage.candidates_token_count,
                usage.total_token_count
            );
        } else {
            warn!("Dialog turn completed but token stats not available");
        }

        // Calculate newly generated messages
        let safe_initial_count = initial_count.min(messages.len()); // Ensure no out-of-bounds
        let new_messages = messages[safe_initial_count..].to_vec();

        if safe_initial_count != initial_count {
            warn!(
                "initial_count ({}) exceeds messages length ({}), adjusted to {}",
                initial_count,
                messages.len(),
                safe_initial_count
            );
        }

        Ok(ExecutionResult {
            final_message: last_assistant_message,
            total_rounds: round_index + 1,
            success: true,
            new_messages,
        })
    }

    /// Cancel dialog turn execution
    pub async fn cancel_dialog_turn(&self, dialog_turn_id: &str) -> Ai00XResult<()> {
        debug!("Cancelling dialog turn: dialog_turn_id={}", dialog_turn_id);
        let result = self.round_executor.cancel_dialog_turn(dialog_turn_id).await;
        if result.is_ok() {
            debug!(
                "Dialog turn cancelled successfully: dialog_turn_id={}",
                dialog_turn_id
            );
        } else {
            error!(
                "Failed to cancel dialog turn: dialog_turn_id={}, error={:?}",
                dialog_turn_id, result
            );
        }
        result
    }

    /// Check if dialog turn is still active (used to detect cancellation)
    pub fn has_active_turn(&self, dialog_turn_id: &str) -> bool {
        self.round_executor.has_active_dialog_turn(dialog_turn_id)
    }

    /// Register cancellation token (for external control, e.g., execute_subagent)
    pub fn register_cancel_token(&self, dialog_turn_id: &str, token: CancellationToken) {
        self.round_executor
            .register_cancel_token(dialog_turn_id, token)
    }

    /// Cleanup cancellation token (for external calls)
    pub async fn cleanup_cancel_token(&self, dialog_turn_id: &str) {
        self.round_executor
            .cleanup_dialog_turn(dialog_turn_id)
            .await
    }

    /// Get available tool names and definitions: 1. Tool itself is enabled 2. Explicitly allowed in mode config
    async fn get_available_tools_and_definitions(
        &self,
        mode_allowed_tools: &[String],
        workspace: Option<&crate::agent::WorkspaceBinding>,
        agent_type: &str,
        primary_supports_image_understanding: bool,
    ) -> (Vec<String>, Option<Vec<ToolDefinition>>) {
        // Use get_all_registered_tools to get all tools including MCP tools
        let all_tools = get_all_registered_tools().await;

        // Filter tools: 1) Check if enabled 2) Check if mode allows
        let mut tool_definitions = Vec::new();
        let mut tool_opts_custom = HashMap::new();
        tool_opts_custom.insert(
            "primary_model_supports_image_understanding".to_string(),
            serde_json::Value::Bool(primary_supports_image_understanding),
        );
        let description_context = crate::agent::tools::framework::ToolUseContext {
            tool_call_id: None,
            agent_type: Some(agent_type.to_string()),
            session_id: None,
            dialog_turn_id: None,
            workspace: workspace.cloned(),
            custom_data: tool_opts_custom,
            computer_use_host: None,
            cancellation_token: None,
            workspace_services: None,
        };
        for tool in &all_tools {
            if !tool.is_enabled().await {
                continue;
            }

            let tool_name = tool.name().to_string();
            if mode_allowed_tools.contains(&tool_name) {
                let description = tool
                    .description_with_context(Some(&description_context))
                    .await
                    .unwrap_or_else(|_| format!("Tool: {}", tool.name()));

                let parameters = tool
                    .input_schema_for_model_with_context(Some(&description_context))
                    .await;

                tool_definitions.push(ToolDefinition {
                    name: tool.name().to_string(),
                    description,
                    parameters,
                });
            }
        }

        // Order tools for the model API: terminal → file-ish tools → **`ComputerUse`** (locate /
        // screenshot / keys) **before** split mouse tools so the list matches “sense then act”.
        let tool_ordering: HashMap<String, usize> = [
            ("Task", 1),
            ("Bash", 2),
            ("TerminalControl", 3),
            ("Glob", 4),
            ("Grep", 5),
            ("Read", 6),
            ("Edit", 7),
            ("Write", 8),
            ("Delete", 9),
            ("WebFetch", 10),
            ("WebSearch", 11),
            ("TodoWrite", 12),
            ("Skill", 13),
            ("Log", 14),
            ("MermaidInteractive", 15),
            ("ComputerUse", 16),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        tool_definitions.sort_by_key(|tool| tool_ordering.get(&tool.name).unwrap_or(&100));

        let enabled_tool_names: Vec<String> =
            tool_definitions.iter().map(|d| d.name.clone()).collect();

        (enabled_tool_names, Some(tool_definitions))
    }

    /// Emit event
    async fn emit_event(&self, event: AgentEvent, priority: EventPriority) {
        let _ = self.event_queue.enqueue(event, Some(priority)).await;
    }
}

/// Check if a tool result message is from WebSearch or WebFetch.
fn is_search_tool_result(msg: &Message) -> bool {
    match &msg.content {
        MessageContent::ToolResult { tool_name, .. } => {
            tool_name == "WebSearch" || tool_name == "WebFetch"
        }
        _ => false,
    }
}

/// Build a falsified ToolResult for WebSearch/WebFetch that warns the model
/// to stop searching. The model receives this as if the tool itself returned
/// an error, making it far more likely to comply.
fn build_search_loop_warning(original_msg: &Message) -> crate::agent::core::ToolResult {
    let (tool_id, tool_name) = match &original_msg.content {
        MessageContent::ToolResult {
            tool_id, tool_name, ..
        } => (tool_id.clone(), tool_name.clone()),
        _ => (String::new(), String::new()),
    };

    let warning = format!(
        "TOOL BLOCKED: You have exceeded the maximum number of {} calls.\n\
         The research phase is over. You MUST now:\n\
         1. Stop searching immediately\n\
         2. Summarize whatever information you have collected so far\n\
         3. Deliver your output to the user (write files, display results)\n\
         Do NOT attempt any more searches.",
        tool_name
    );

    crate::agent::core::ToolResult {
        tool_id,
        tool_name,
        result: serde_json::Value::String(warning.clone()),
        result_for_assistant: Some(warning),
        is_error: true,
        duration_ms: Some(0),
        image_attachments: None,
    }
}

impl ExecutionEngine {
    async fn ensure_todowrite_in_definitions(
        available_tools: &[String],
        tool_definitions: &mut Option<Vec<ToolDefinition>>,
    ) {
        let needs_todowrite = available_tools.iter().any(|t| t == "TodoWrite");
        if !needs_todowrite {
            return;
        }
        let has_todowrite_def = tool_definitions
            .as_ref()
            .is_some_and(|defs| defs.iter().any(|d| d.name == "TodoWrite"));
        if has_todowrite_def {
            return;
        }
        let all_tools = crate::agent::tools::registry::get_all_registered_tools().await;
        if let Some(todo_tool) = all_tools.iter().find(|t| t.name() == "TodoWrite") {
            let description = todo_tool
                .description_with_context(None)
                .await
                .unwrap_or_else(|_| "Tool: TodoWrite".to_string());
            let parameters = todo_tool.input_schema_for_model_with_context(None).await;
            let def = ToolDefinition {
                name: "TodoWrite".to_string(),
                description,
                parameters,
            };
            tool_definitions.get_or_insert_with(Vec::new).push(def);
            info!("Injected TodoWrite tool definition into current_tool_definitions (was missing from agent default_tools)");
        }
    }

    fn extract_yaml_frontmatter(content: &str) -> Option<serde_json::Value> {
        let stripped = content.strip_prefix("---\n")?;
        let frontmatter_str = stripped.split("\n---").next()?;
        let yaml_value: serde_yaml::Value = serde_yaml::from_str(frontmatter_str).ok()?;
        serde_json::to_value(yaml_value).ok()
    }

    async fn initialize_plan_progress(
        &self,
        phase_machine: &WorkflowPhaseMachine,
        context: &ExecutionContext,
    ) -> Option<Vec<serde_json::Value>> {
        let plan_path = phase_machine.plan_file_path()?;
        let workspace = context.workspace.as_ref()?;
        let full_path = workspace.root_path().join(plan_path);
        let plan_content = tokio::fs::read_to_string(&full_path).await.ok()?;
        let frontmatter = Self::extract_yaml_frontmatter(&plan_content)?;
        let todos = frontmatter.get("todos")?.as_array()?.clone();

        let mut todos_vec = todos;
        let has_in_progress = todos_vec.iter().any(|t| {
            t.get("status")
                .and_then(|s| s.as_str())
                .is_some_and(|s| s == "in_progress")
        });
        if !has_in_progress && !todos_vec.is_empty() {
            if let Some(obj) = todos_vec[0].as_object_mut() {
                obj.insert(
                    "status".to_string(),
                    serde_json::Value::String("in_progress".to_string()),
                );
            }
        }

        info!(
            "Initialized plan progress tracker with {} todos",
            todos_vec.len()
        );
        Some(todos_vec)
    }

    async fn auto_execute_todowrite(
        &self,
        todos: &[serde_json::Value],
        context: &ExecutionContext,
    ) -> Ai00XResult<()> {
        let tool_call = ToolCall {
            tool_id: format!("auto_todowrite_{}", uuid::Uuid::new_v4()),
            tool_name: "TodoWrite".to_string(),
            arguments: serde_json::json!({
                "todos": todos,
            }),
            is_error: false,
        };

        let tool_context = ToolExecutionContext {
            session_id: context.session_id.clone(),
            dialog_turn_id: context.dialog_turn_id.clone(),
            agent_type: context.agent_type.clone(),
            workspace: context.workspace.clone(),
            context_vars: context.context.clone(),
            subagent_parent_info: None,
            allowed_tools: vec!["TodoWrite".to_string()],
            workspace_services: context.workspace_services.clone(),
            permission_level: None,
            permission_policy: Some(PermissionPolicy::new(PermissionLevel::WorkspaceWrite)),
            workflow_phase: Some("executing".to_string()),
            plans_dir: None,
        };

        match self
            .round_executor
            .execute_single_tool(tool_call, tool_context)
            .await
        {
            Ok(Some(result)) => {
                info!(
                    "Auto TodoWrite executed successfully: {} todos, success={}",
                    todos.len(),
                    result
                        .result
                        .get("success")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                );
            }
            Ok(None) => {
                warn!("Auto TodoWrite: tool pipeline not available");
            }
            Err(e) => {
                warn!("Auto TodoWrite execution failed: {}", e);
            }
        }

        Ok(())
    }

    /// Check if the plan file's frontmatter todos are all completed.
    /// Returns Some(true) only when every todo has status "completed"
    /// AND the completed count from TodoWrite equals the plan file's todo count.
    async fn check_plan_all_completed(
        workspace: Option<&crate::agent::WorkspaceBinding>,
        plan_path: &str,
        completed_count_from_tool: usize,
    ) -> Option<bool> {
        let workspace = workspace?;
        let full_path = workspace.root_path().join(plan_path);
        let content = tokio::fs::read_to_string(&full_path).await.ok()?;

        let frontmatter = content.strip_prefix("---\n")?.split("\n---").next()?;

        let doc: serde_yaml::Value = serde_yaml::from_str(frontmatter).ok()?;
        let todos = doc.get("todos")?;
        let todos = match todos {
            serde_yaml::Value::Sequence(arr) => arr,
            _ => return Some(false),
        };

        if todos.is_empty() {
            return Some(false);
        }

        let all_completed = todos.iter().all(|todo| {
            todo.get("status")
                .and_then(|s| s.as_str())
                .is_some_and(|s| s == "completed")
        });

        if !all_completed || completed_count_from_tool != todos.len() {
            return Some(false);
        }

        Some(true)
    }
}

#[cfg(test)]
mod tests {
    use super::ExecutionEngine;
    use crate::service::config::types::AIConfig;
    use crate::service::config::types::AIModelConfig;
    use crate::service::config::types::DefaultModelsConfig;

    fn build_model(id: &str, name: &str, model_name: &str) -> AIModelConfig {
        AIModelConfig {
            id: id.to_string(),
            name: name.to_string(),
            model_name: model_name.to_string(),
            provider: "anthropic".to_string(),
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn resolve_configured_fast_model_falls_back_to_primary_when_fast_is_stale() {
        let ai_config = AIConfig {
            models: vec![build_model("model-primary", "Primary", "claude-sonnet-4.5")],
            default_models: DefaultModelsConfig {
                primary: Some("model-primary".to_string()),
                fast: Some("deleted-fast-model".to_string()),
                ..Default::default()
            },
            ..Default::default()
        };

        assert_eq!(
            ExecutionEngine::resolve_configured_model_id(&ai_config, "fast"),
            "model-primary"
        );
    }
}
