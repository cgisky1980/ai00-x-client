//! One-shot AI completion API
//!
//! Single request/response AI call for lightweight inline features (e.g.
//! community post title generation). Unlike `editor_ai_api` this command
//! awaits and returns the text directly — no event stream, no session, no
//! persistence. This matters for windows outside the event capability list
//! (e.g. the member-chat window serves from a local HTTP origin and is not
//! granted `core:event:allow-listen`), where event subscription is denied.

use crate::api::app_state::AppState;
use ai00_x_core::util::types::message::Message as AIMessage;
use serde::{Deserialize, Serialize};
use tauri::State;

fn default_model_id() -> String {
    "fast".to_string()
}

fn default_timeout_secs() -> u64 {
    15
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCompleteOnceRequest {
    pub user_prompt: String,
    pub system_prompt: Option<String>,
    /// Model alias or explicit model id, resolved per-call from the user's
    /// current config (rwkv-local / gguf-local / remote APIs all supported).
    /// Defaults to "fast" (mid-tier); falls back to primary when unset.
    #[serde(default = "default_model_id")]
    pub model_id: String,
    /// Whole-call timeout in seconds so callers never hang.
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCompleteOnceResponse {
    pub text: String,
}

#[tauri::command]
pub async fn ai_complete_once(
    state: State<'_, AppState>,
    request: AiCompleteOnceRequest,
) -> Result<AiCompleteOnceResponse, String> {
    if request.user_prompt.trim().is_empty() {
        return Err("userPrompt is required".to_string());
    }

    let client = state
        .ai_client_factory
        .get_client_resolved(&request.model_id)
        .await
        .map_err(|error| format!("Failed to create AI client: {}", error))?;

    let mut messages: Vec<AIMessage> = Vec::new();
    let system_prompt = request
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(system_prompt) = system_prompt {
        messages.push(AIMessage::system(system_prompt.to_string()));
    }
    messages.push(AIMessage::user(request.user_prompt));

    let call = client.send_message(messages, None);
    let response = tokio::time::timeout(std::time::Duration::from_secs(request.timeout_secs), call)
        .await
        .map_err(|_| format!("AI call timed out after {}s", request.timeout_secs))?
        .map_err(|error| format!("AI call failed: {}", error))?;

    Ok(AiCompleteOnceResponse {
        text: response.text.trim().to_string(),
    })
}
