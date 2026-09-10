//! Editor AI API
//!
//! Ephemeral streaming AI calls for in-editor experiences such as Markdown continuation:
//! - No session or dialog turn is created
//! - No persistence writes
//! - Supports streaming output and cancellation by request id

use crate::api::app_state::AppState;
use ai00_x_core::util::types::message::Message as AIMessage;
use futures::StreamExt;
use log::warn;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorAiStreamRequest {
    pub request_id: String,
    pub prompt: String,
    /// Optional model id override. Supports "fast"/"primary" aliases.
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorAiStreamResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorAiCancelRequest {
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorAiTextChunkEvent {
    pub request_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorAiCompletedEvent {
    pub request_id: String,
    pub full_text: String,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorAiErrorEvent {
    pub request_id: String,
    pub error: String,
}

/// Cancellation token for one in-flight editor AI stream.
#[derive(Clone)]
struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Registry of in-flight editor AI streams, keyed by request id.
#[derive(Default)]
struct CancelRegistry {
    tokens: Mutex<HashMap<String, CancelToken>>,
}

impl CancelRegistry {
    fn register(&self, request_id: &str) -> CancelToken {
        let token = CancelToken(Arc::new(AtomicBool::new(false)));
        if let Ok(mut guard) = self.tokens.lock() {
            guard.insert(request_id.to_string(), token.clone());
        }
        token
    }

    fn cancel(&self, request_id: &str) {
        if let Ok(guard) = self.tokens.lock() {
            if let Some(token) = guard.get(request_id) {
                token.0.store(true, Ordering::Relaxed);
            }
        }
    }

    fn remove(&self, request_id: &str) {
        if let Ok(mut guard) = self.tokens.lock() {
            guard.remove(request_id);
        }
    }
}

static CANCEL_REGISTRY: Lazy<CancelRegistry> = Lazy::new(CancelRegistry::default);

fn system_prompt() -> &'static str {
    "You are an in-editor AI writing assistant.\n\
Follow the user's prompt exactly.\n\
- Return only the requested document content.\n\
- Do not add wrapper text or explanations unless the prompt explicitly asks for them.\n\
- Do not call tools.\n"
}

#[tauri::command]
pub async fn editor_ai_cancel(
    _state: State<'_, AppState>,
    request: EditorAiCancelRequest,
) -> Result<(), String> {
    if request.request_id.trim().is_empty() {
        return Err("requestId is required".to_string());
    }

    CANCEL_REGISTRY.cancel(&request.request_id);
    Ok(())
}

#[tauri::command]
pub async fn editor_ai_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    request: EditorAiStreamRequest,
) -> Result<EditorAiStreamResponse, String> {
    if request.request_id.trim().is_empty() {
        return Err("requestId is required".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("prompt is required".to_string());
    }

    let model_id = request
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("primary")
        .to_string();

    let client = state
        .ai_client_factory
        .get_client_resolved(&model_id)
        .await
        .map_err(|error| format!("Failed to create AI client: {}", error))?;

    let cancel_token = CANCEL_REGISTRY.register(&request.request_id);

    let request_id = request.request_id.clone();
    let prompt = request.prompt.clone();
    let app_handle = app.clone();

    tokio::spawn(async move {
        let messages = vec![
            AIMessage::system(system_prompt().to_string()),
            AIMessage::user(prompt),
        ];

        let mut full_text = String::new();
        let mut last_finish_reason: Option<String> = None;

        let mut stream = match client.send_message_stream(messages, None).await {
            Ok(response) => response.stream,
            Err(error) => {
                CANCEL_REGISTRY.remove(&request_id);
                let payload = EditorAiErrorEvent {
                    request_id,
                    error: format!("AI call failed: {}", error),
                };
                if let Err(emit_error) = app_handle.emit("editor-ai://error", payload) {
                    warn!("Failed to emit editor AI error: {}", emit_error);
                }
                return;
            }
        };

        while let Some(chunk_result) = stream.next().await {
            if cancel_token.is_cancelled() {
                CANCEL_REGISTRY.remove(&request_id);
                return;
            }

            match chunk_result {
                Ok(chunk) => {
                    if let Some(reason) = chunk.finish_reason.clone() {
                        last_finish_reason = Some(reason);
                    }

                    if let Some(text) = chunk.text {
                        if text.is_empty() {
                            continue;
                        }

                        full_text.push_str(&text);
                        let payload = EditorAiTextChunkEvent {
                            request_id: request_id.clone(),
                            text,
                        };
                        if let Err(error) = app_handle.emit("editor-ai://text-chunk", payload) {
                            warn!("Failed to emit editor AI text chunk: {}", error);
                        }
                    }
                }
                Err(error) => {
                    CANCEL_REGISTRY.remove(&request_id);
                    let payload = EditorAiErrorEvent {
                        request_id,
                        error: format!("Stream error: {}", error),
                    };
                    if let Err(emit_error) = app_handle.emit("editor-ai://error", payload) {
                        warn!("Failed to emit editor AI error: {}", emit_error);
                    }
                    return;
                }
            }
        }

        CANCEL_REGISTRY.remove(&request_id);

        if cancel_token.is_cancelled() {
            return;
        }

        let payload = EditorAiCompletedEvent {
            request_id,
            full_text: full_text.trim().to_string(),
            finish_reason: last_finish_reason,
        };
        if let Err(error) = app_handle.emit("editor-ai://completed", payload) {
            warn!("Failed to emit editor AI completion: {}", error);
        }
    });

    Ok(EditorAiStreamResponse { ok: true })
}
