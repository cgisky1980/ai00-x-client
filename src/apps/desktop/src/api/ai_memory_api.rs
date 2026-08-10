//! AI Memory Points API

use ai00_x_core::infrastructure::PathManager;
use ai00_x_core::service::ai_memory::{AIMemory, AIMemoryManager, MemoryType};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMemoryRequest {
    pub title: String,
    pub content: String,
    #[serde(rename = "type")]
    pub memory_type: MemoryType,
    pub importance: u8,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateMemoryRequest {
    pub id: String,
    pub title: String,
    pub content: String,
    #[serde(rename = "type")]
    pub memory_type: MemoryType,
    pub importance: u8,
    pub tags: Vec<String>,
    pub enabled: bool,
}

#[tauri::command]
pub async fn get_all_memories(
    path_manager: State<'_, Arc<PathManager>>,
) -> Result<Vec<AIMemory>, String> {
    let manager = AIMemoryManager::new(path_manager.inner().clone())
        .await
        .map_err(|e| e.to_string())?;

    manager.get_all_memories().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_memory(
    path_manager: State<'_, Arc<PathManager>>,
    request: CreateMemoryRequest,
) -> Result<AIMemory, String> {
    let manager = AIMemoryManager::new(path_manager.inner().clone())
        .await
        .map_err(|e| e.to_string())?;

    let mut memory = AIMemory::new(
        request.title,
        request.content,
        request.memory_type,
        request.importance,
    );

    if let Some(tags) = request.tags {
        memory.tags = tags;
    }

    manager.add_memory(memory).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_memory(
    path_manager: State<'_, Arc<PathManager>>,
    request: UpdateMemoryRequest,
) -> Result<bool, String> {
    let manager = AIMemoryManager::new(path_manager.inner().clone())
        .await
        .map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().to_rfc3339();
    let memory = AIMemory {
        id: request.id.clone(),
        title: request.title,
        content: request.content,
        memory_type: request.memory_type,
        tags: request.tags,
        source: "User manual edit".to_string(),
        created_at: now.clone(),
        updated_at: now,
        importance: request.importance.min(5),
        enabled: request.enabled,
    };

    manager
        .update_memory(memory)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_memory(
    path_manager: State<'_, Arc<PathManager>>,
    id: String,
) -> Result<bool, String> {
    let manager = AIMemoryManager::new(path_manager.inner().clone())
        .await
        .map_err(|e| e.to_string())?;

    manager.delete_memory(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_memory(
    path_manager: State<'_, Arc<PathManager>>,
    id: String,
) -> Result<bool, String> {
    let manager = AIMemoryManager::new(path_manager.inner().clone())
        .await
        .map_err(|e| e.to_string())?;

    manager.toggle_memory(&id).await.map_err(|e| e.to_string())
}
