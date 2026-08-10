//! BTW (side question) API
//!
//! Temporarily disabled — /btw feature is not active.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

use crate::api::app_state::AppState;

use ai00_x_core::agent::coordination::ConversationCoordinator;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwAskRequest {
    pub session_id: String,
    pub question: String,
    pub model_id: Option<String>,
    pub max_context_messages: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwAskResponse {
    pub answer: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwAskStreamRequest {
    pub request_id: String,
    pub session_id: String,
    pub question: String,
    pub model_id: Option<String>,
    pub max_context_messages: Option<usize>,
    pub child_session_id: Option<String>,
    pub workspace_path: Option<String>,
    pub parent_dialog_turn_id: Option<String>,
    pub parent_turn_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwAskStreamResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwCancelRequest {
    pub request_id: String,
}

#[tauri::command]
pub async fn btw_cancel(
    _state: State<'_, AppState>,
    _coordinator: State<'_, Arc<ConversationCoordinator>>,
    _request: BtwCancelRequest,
) -> Result<(), String> {
    Err("/btw feature is temporarily disabled".to_string())
}

#[tauri::command]
pub async fn btw_ask_stream(
    _state: State<'_, AppState>,
    _coordinator: State<'_, Arc<ConversationCoordinator>>,
    _request: BtwAskStreamRequest,
) -> Result<BtwAskStreamResponse, String> {
    Err("/btw feature is temporarily disabled".to_string())
}

#[tauri::command]
pub async fn btw_ask(
    _state: State<'_, AppState>,
    _coordinator: State<'_, Arc<ConversationCoordinator>>,
    _request: BtwAskRequest,
) -> Result<BtwAskResponse, String> {
    Err("/btw feature is temporarily disabled".to_string())
}
