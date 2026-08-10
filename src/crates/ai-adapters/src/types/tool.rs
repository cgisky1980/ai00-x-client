use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallConfirmationDetails {
    pub request: ToolCallRequestInfo,
    #[serde(rename = "type")]
    pub confirmation_type: String, // 'edit' | 'execute' | 'confirm'
    pub message: Option<String>,
    pub file_diff: Option<String>,
    pub file_name: Option<String>,
    pub original_content: Option<String>,
    pub new_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRequestInfo {
    pub call_id: String,
    pub name: String,
    pub args: HashMap<String, serde_json::Value>,
    pub is_client_initiated: bool,
    pub prompt_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallResponseInfo {
    pub call_id: String,
    pub response_parts: serde_json::Value,
    pub result_display: Option<String>,
    pub error: Option<String>,
    pub error_type: Option<String>,
}
