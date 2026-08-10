//! AI Rules Management API

use crate::api::AppState;
use ai00_x_core::service::ai_rules::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiRuleLevel {
    User,
    Project,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRulesRequest {
    pub level: ApiRuleLevel,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRuleRequest {
    pub level: ApiRuleLevel,
    pub name: String,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRuleApiRequest {
    pub level: ApiRuleLevel,
    pub rule: CreateRuleRequest,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRuleApiRequest {
    pub level: ApiRuleLevel,
    pub name: String,
    pub rule: UpdateRuleRequest,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRuleApiRequest {
    pub level: ApiRuleLevel,
    pub name: String,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRulesStatsRequest {
    pub level: ApiRuleLevel,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReloadRulesRequest {
    pub level: ApiRuleLevel,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleRuleApiRequest {
    pub level: ApiRuleLevel,
    pub name: String,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSystemPromptRequest {
    pub workspace_path: String,
}

fn workspace_root_from_request(workspace_path: Option<&str>) -> Option<PathBuf> {
    workspace_path
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

fn require_workspace_root(
    level: ApiRuleLevel,
    workspace_root: Option<PathBuf>,
) -> Result<PathBuf, String> {
    match level {
        ApiRuleLevel::Project | ApiRuleLevel::All => workspace_root.ok_or_else(|| {
            "workspacePath is required when level includes project rules".to_string()
        }),
        ApiRuleLevel::User => Err("workspacePath is not used for user-only rules".to_string()),
    }
}

#[tauri::command]
pub async fn get_ai_rules(
    state: State<'_, AppState>,
    request: GetRulesRequest,
) -> Result<Vec<AIRule>, String> {
    let rules_service = &state.ai_rules_service;
    let workspace_root = workspace_root_from_request(request.workspace_path.as_deref());

    match request.level {
        ApiRuleLevel::User => rules_service
            .get_user_rules()
            .await
            .map_err(|e| format!("Failed to get user rules: {}", e)),
        ApiRuleLevel::Project => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            rules_service
                .get_project_rules_for_workspace(&workspace_root)
                .await
                .map_err(|e| format!("Failed to get project rules: {}", e))
        }
        ApiRuleLevel::All => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            let mut all_rules = Vec::new();

            let user_rules = rules_service
                .get_user_rules()
                .await
                .map_err(|e| format!("Failed to get user rules: {}", e))?;
            all_rules.extend(user_rules);

            let project_rules = rules_service
                .get_project_rules_for_workspace(&workspace_root)
                .await
                .map_err(|e| format!("Failed to get project rules: {}", e))?;
            all_rules.extend(project_rules);
            all_rules.sort_by(|a, b| a.name.cmp(&b.name));

            Ok(all_rules)
        }
    }
}

#[tauri::command]
pub async fn get_ai_rule(
    state: State<'_, AppState>,
    request: GetRuleRequest,
) -> Result<Option<AIRule>, String> {
    let rules_service = &state.ai_rules_service;
    let workspace_root = workspace_root_from_request(request.workspace_path.as_deref());

    match request.level {
        ApiRuleLevel::User => rules_service
            .get_user_rule(&request.name)
            .await
            .map_err(|e| format!("Failed to get user rule: {}", e)),
        ApiRuleLevel::Project => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            rules_service
                .get_project_rule_for_workspace(&workspace_root, &request.name)
                .await
                .map_err(|e| format!("Failed to get project rule: {}", e))
        }
        ApiRuleLevel::All => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            if let Some(rule) = rules_service
                .get_user_rule(&request.name)
                .await
                .map_err(|e| format!("Failed to get user rule: {}", e))?
            {
                Ok(Some(rule))
            } else {
                rules_service
                    .get_project_rule_for_workspace(&workspace_root, &request.name)
                    .await
                    .map_err(|e| format!("Failed to get project rule: {}", e))
            }
        }
    }
}

#[tauri::command]
pub async fn create_ai_rule(
    state: State<'_, AppState>,
    request: CreateRuleApiRequest,
) -> Result<AIRule, String> {
    let rules_service = &state.ai_rules_service;
    let workspace_root = workspace_root_from_request(request.workspace_path.as_deref());

    match request.level {
        ApiRuleLevel::User => rules_service
            .create_user_rule(request.rule)
            .await
            .map_err(|e| format!("Failed to create user rule: {}", e)),
        ApiRuleLevel::Project => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            rules_service
                .create_project_rule_for_workspace(&workspace_root, request.rule)
                .await
                .map_err(|e| format!("Failed to create project rule: {}", e))
        }
        ApiRuleLevel::All => Err(
            "Cannot create rule with 'all' level. Please specify 'user' or 'project'.".to_string(),
        ),
    }
}

#[tauri::command]
pub async fn update_ai_rule(
    state: State<'_, AppState>,
    request: UpdateRuleApiRequest,
) -> Result<AIRule, String> {
    let rules_service = &state.ai_rules_service;
    let workspace_root = workspace_root_from_request(request.workspace_path.as_deref());

    match request.level {
        ApiRuleLevel::User => rules_service
            .update_user_rule(&request.name, request.rule)
            .await
            .map_err(|e| format!("Failed to update user rule: {}", e)),
        ApiRuleLevel::Project => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            rules_service
                .update_project_rule_for_workspace(&workspace_root, &request.name, request.rule)
                .await
                .map_err(|e| format!("Failed to update project rule: {}", e))
        }
        ApiRuleLevel::All => Err(
            "Cannot update rule with 'all' level. Please specify 'user' or 'project'.".to_string(),
        ),
    }
}

#[tauri::command]
pub async fn delete_ai_rule(
    state: State<'_, AppState>,
    request: DeleteRuleApiRequest,
) -> Result<bool, String> {
    let rules_service = &state.ai_rules_service;
    let workspace_root = workspace_root_from_request(request.workspace_path.as_deref());

    match request.level {
        ApiRuleLevel::User => rules_service
            .delete_user_rule(&request.name)
            .await
            .map_err(|e| format!("Failed to delete user rule: {}", e)),
        ApiRuleLevel::Project => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            rules_service
                .delete_project_rule_for_workspace(&workspace_root, &request.name)
                .await
                .map_err(|e| format!("Failed to delete project rule: {}", e))
        }
        ApiRuleLevel::All => Err(
            "Cannot delete rule with 'all' level. Please specify 'user' or 'project'.".to_string(),
        ),
    }
}

#[tauri::command]
pub async fn get_ai_rules_stats(
    state: State<'_, AppState>,
    request: GetRulesStatsRequest,
) -> Result<RuleStats, String> {
    let rules_service = &state.ai_rules_service;
    let workspace_root = workspace_root_from_request(request.workspace_path.as_deref());

    match request.level {
        ApiRuleLevel::User => rules_service
            .get_user_rules_stats()
            .await
            .map_err(|e| format!("Failed to get user rules stats: {}", e)),
        ApiRuleLevel::Project => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            rules_service
                .get_project_rules_stats_for_workspace(&workspace_root)
                .await
                .map_err(|e| format!("Failed to get project rules stats: {}", e))
        }
        ApiRuleLevel::All => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            let user_stats = rules_service
                .get_user_rules_stats()
                .await
                .map_err(|e| format!("Failed to get user rules stats: {}", e))?;
            let project_stats = rules_service
                .get_project_rules_stats_for_workspace(&workspace_root)
                .await
                .map_err(|e| format!("Failed to get project rules stats: {}", e))?;

            let mut by_apply_type = user_stats.by_apply_type.clone();
            for (key, value) in project_stats.by_apply_type {
                *by_apply_type.entry(key).or_insert(0) += value;
            }

            Ok(RuleStats {
                total_rules: user_stats.total_rules + project_stats.total_rules,
                enabled_rules: user_stats.enabled_rules + project_stats.enabled_rules,
                disabled_rules: user_stats.disabled_rules + project_stats.disabled_rules,
                by_apply_type,
            })
        }
    }
}

#[tauri::command]
pub async fn build_ai_rules_system_prompt(
    state: State<'_, AppState>,
    request: BuildSystemPromptRequest,
) -> Result<String, String> {
    let rules_service = &state.ai_rules_service;
    let workspace_root = workspace_root_from_request(Some(request.workspace_path.as_str()))
        .ok_or_else(|| "workspacePath is required to build project AI rules prompt".to_string())?;

    rules_service
        .build_system_prompt_for(Some(&workspace_root))
        .await
        .map_err(|e| format!("Failed to build system prompt: {}", e))
}

#[tauri::command]
pub async fn reload_ai_rules(
    state: State<'_, AppState>,
    request: ReloadRulesRequest,
) -> Result<(), String> {
    let rules_service = &state.ai_rules_service;
    let workspace_root = workspace_root_from_request(request.workspace_path.as_deref());

    match request.level {
        ApiRuleLevel::User => rules_service
            .reload_user_rules()
            .await
            .map_err(|e| format!("Failed to reload user rules: {}", e)),
        ApiRuleLevel::Project => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            rules_service
                .reload_project_rules_for_workspace(&workspace_root)
                .await
                .map_err(|e| format!("Failed to reload project rules: {}", e))
        }
        ApiRuleLevel::All => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            rules_service
                .reload_user_rules()
                .await
                .map_err(|e| format!("Failed to reload user rules: {}", e))?;
            rules_service
                .reload_project_rules_for_workspace(&workspace_root)
                .await
                .map_err(|e| format!("Failed to reload project rules: {}", e))
        }
    }
}

#[tauri::command]
pub async fn toggle_ai_rule(
    state: State<'_, AppState>,
    request: ToggleRuleApiRequest,
) -> Result<AIRule, String> {
    let rules_service = &state.ai_rules_service;
    let workspace_root = workspace_root_from_request(request.workspace_path.as_deref());

    match request.level {
        ApiRuleLevel::User => rules_service
            .toggle_user_rule(&request.name)
            .await
            .map_err(|e| format!("Failed to toggle user rule: {}", e)),
        ApiRuleLevel::Project => {
            let workspace_root = require_workspace_root(request.level, workspace_root)?;
            rules_service
                .toggle_project_rule_for_workspace(&workspace_root, &request.name)
                .await
                .map_err(|e| format!("Failed to toggle project rule: {}", e))
        }
        ApiRuleLevel::All => Err(
            "Cannot toggle rule with 'all' level. Please specify 'user' or 'project'.".to_string(),
        ),
    }
}
