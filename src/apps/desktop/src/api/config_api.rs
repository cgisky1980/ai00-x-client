//! Configuration API

use crate::api::app_state::AppState;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct GetConfigRequest {
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetConfigRequest {
    pub path: String,
    pub value: Value,
}

#[derive(Debug, Deserialize)]
pub struct ResetConfigRequest {
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct GetRuntimeLoggingInfoRequest {}

fn to_json_value<T: Serialize>(value: T, context: &str) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("Failed to serialize {}: {}", context, e))
}

#[tauri::command]
pub async fn get_config(
    state: State<'_, AppState>,
    request: GetConfigRequest,
) -> Result<Value, String> {
    let config_service = &state.config_service;

    match config_service
        .get_config::<Value>(request.path.as_deref())
        .await
    {
        Ok(mut config) => {
            if request.path.as_deref() == Some("ai.models") {
                use ai00_x_core::service::config::server_endpoints::ai00_s_base_url;
                let base_url: String = config_service
                    .get_config::<Value>(Some("app.ai00_s_base_url"))
                    .await
                    .ok()
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .unwrap_or_else(ai00_s_base_url);
                if let Some(models) = config.as_array_mut() {
                    for model in models.iter_mut() {
                        if model.get("provider").and_then(|v| v.as_str()) == Some("ai00s") {
                            model["base_url"] = serde_json::json!(base_url);
                        }
                    }
                }
            }
            Ok(config)
        }
        Err(e) => {
            error!("Failed to get config: path={:?}, error={}", request.path, e);
            Err(format!("Failed to get config: {}", e))
        }
    }
}

/// 获取 Ai00-S 服务器地址（统一配置入口）。
///
/// 所有 UI 层（web-ui / loader-ui / underlay-ui）都应通过此命令获取服务器地址，
/// 而不是各自硬编码。配置存储在 app.json 的 app.ai00_s_base_url 字段中。
#[tauri::command]
pub async fn get_ai00_s_base_url(state: State<'_, AppState>) -> Result<String, String> {
    use ai00_x_core::service::config::server_endpoints::ai00_s_base_url;
    let config_service = &state.config_service;
    match config_service
        .get_config::<Value>(Some("app.ai00_s_base_url"))
        .await
    {
        Ok(v) => Ok(v
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(ai00_s_base_url)),
        Err(_) => Ok(ai00_s_base_url()),
    }
}

/// 获取头像/宠物资源服务地址（独立于 ai00_s_base_url）。
///
/// 返回 `app.assets_base_url` 的配置值；空字符串表示未配置，前端应回退到
/// `ai00_s_base_url` 的资源（沿用服务器地址）。用于本地开发指向嵌入服务器
/// `/pet`（如 http://127.0.0.1:2100），后续可配置 CDN/网络同步地址，
/// 不影响 AI00-S API 服务器地址。
#[tauri::command]
pub async fn get_assets_base_url(state: State<'_, AppState>) -> Result<String, String> {
    let config_service = &state.config_service;
    match config_service
        .get_config::<Value>(Some("app.assets_base_url"))
        .await
    {
        Ok(v) => Ok(v.as_str().map(|s| s.to_string()).unwrap_or_default()),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
pub async fn set_config(
    state: State<'_, AppState>,
    request: SetConfigRequest,
) -> Result<String, String> {
    let config_service = &state.config_service;

    match config_service
        .set_config(&request.path, request.value)
        .await
    {
        Ok(_) => {
            if let Err(e) = ai00_x_core::service::config::reload_global_config().await {
                warn!(
                    "Failed to sync global config after set_config: path={}, error={}",
                    request.path, e
                );
            } else {
                info!(
                    "Global config synced after set_config: path={}",
                    request.path
                );
            }

            if request.path.starts_with("ai.models")
                || request.path.starts_with("ai.default_models")
                || request.path.starts_with("ai.agent_models")
                || request.path.starts_with("ai.proxy")
                || request.path == "app.ai00_s_base_url"
            {
                state.ai_client_factory.invalidate_cache();
                info!(
                    "AI config changed, cache invalidated: path={}",
                    request.path
                );
            }

            Ok("Configuration set successfully".to_string())
        }
        Err(e) => {
            error!("Failed to set config: path={}, error={}", request.path, e);
            Err(format!("Failed to set config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn reset_config(
    state: State<'_, AppState>,
    request: ResetConfigRequest,
) -> Result<String, String> {
    let config_service = &state.config_service;

    match config_service.reset_config(request.path.as_deref()).await {
        Ok(_) => {
            if let Err(e) = ai00_x_core::service::config::reload_global_config().await {
                warn!(
                    "Failed to sync global config after reset_config: path={:?}, error={}",
                    request.path, e
                );
            } else {
                info!(
                    "Global config synced after reset_config: path={:?}",
                    request.path
                );
            }

            let message = if let Some(path) = &request.path {
                format!("Configuration '{}' reset successfully", path)
            } else {
                "All configurations reset successfully".to_string()
            };

            let should_invalidate = match &request.path {
                Some(path) => path.starts_with("ai"),
                None => true,
            };
            if should_invalidate {
                state.ai_client_factory.invalidate_cache();
                info!(
                    "AI config reset, cache invalidated: path={:?}",
                    request.path
                );
            }

            Ok(message)
        }
        Err(e) => {
            error!(
                "Failed to reset config: path={:?}, error={}",
                request.path, e
            );
            Err(format!("Failed to reset config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn export_config(state: State<'_, AppState>) -> Result<Value, String> {
    let config_service = &state.config_service;

    match config_service.export_config().await {
        Ok(export_data) => Ok(to_json_value(export_data, "export config data")?),
        Err(e) => {
            error!("Failed to export config: {}", e);
            Err(format!("Failed to export config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn import_config(state: State<'_, AppState>, config: Value) -> Result<Value, String> {
    let config_service = &state.config_service;

    let export_data: ai00_x_core::service::config::ConfigExport =
        serde_json::from_value(config).map_err(|e| format!("Invalid config format: {}", e))?;

    match config_service.import_config(export_data).await {
        Ok(result) => {
            if let Err(e) = ai00_x_core::service::config::reload_global_config().await {
                warn!("Failed to sync global config after import_config: {}", e);
            } else {
                info!("Global config synced after import_config");
            }
            state.ai_client_factory.invalidate_cache();
            info!("Config imported, AI client cache invalidated");
            Ok(to_json_value(result, "import config result")?)
        }
        Err(e) => {
            error!("Failed to import config: {}", e);
            Err(format!("Failed to import config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn validate_config(state: State<'_, AppState>) -> Result<Value, String> {
    let config_service = &state.config_service;

    match config_service.validate_config().await {
        Ok(validation_result) => Ok(to_json_value(
            validation_result,
            "config validation result",
        )?),
        Err(e) => {
            error!("Failed to validate config: {}", e);
            Err(format!("Failed to validate config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn reload_config(state: State<'_, AppState>) -> Result<String, String> {
    let config_service = &state.config_service;

    match config_service.reload().await {
        Ok(_) => {
            info!("Config reloaded");
            Ok("Configuration reloaded successfully".to_string())
        }
        Err(e) => {
            error!("Failed to reload config: {}", e);
            Err(format!("Failed to reload config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn sync_config_to_global(_state: State<'_, AppState>) -> Result<String, String> {
    match ai00_x_core::service::config::reload_global_config().await {
        Ok(_) => {
            info!("Config synced to global service");
            Ok("Configuration synced to global service".to_string())
        }
        Err(e) => {
            error!("Failed to sync config to global service: {}", e);
            Err(format!("Failed to sync config to global service: {}", e))
        }
    }
}

#[tauri::command]
pub async fn get_global_config_health() -> Result<bool, String> {
    Ok(ai00_x_core::service::config::GlobalConfigManager::is_initialized())
}

#[tauri::command]
pub async fn get_runtime_logging_info(
    _state: State<'_, AppState>,
    _request: GetRuntimeLoggingInfoRequest,
) -> Result<Value, String> {
    let logging_info = crate::logging::get_runtime_logging_info();
    to_json_value(logging_info, "runtime logging info")
}

#[tauri::command]
pub async fn get_mode_configs(_state: State<'_, AppState>) -> Result<Value, String> {
    let mode_configs =
        ai00_x_core::service::config::mode_config_canonicalizer::get_mode_config_views()
            .await
            .map_err(|e| format!("Failed to get mode configs: {}", e))?;

    to_json_value(mode_configs, "mode configs")
}

#[tauri::command]
pub async fn get_mode_config(
    _state: State<'_, AppState>,
    mode_id: String,
) -> Result<Value, String> {
    let config =
        ai00_x_core::service::config::mode_config_canonicalizer::get_mode_config_view(&mode_id)
            .await
            .map_err(|e| format!("Failed to get mode config: {}", e))?;

    to_json_value(config, "mode config")
}

#[tauri::command]
pub async fn set_mode_config(
    state: State<'_, AppState>,
    mode_id: String,
    config: Value,
) -> Result<String, String> {
    let _ = state;

    match ai00_x_core::service::config::mode_config_canonicalizer::persist_mode_config_from_value(
        &mode_id, config,
    )
    .await
    {
        Ok(_) => {
            if let Err(e) = ai00_x_core::service::config::reload_global_config().await {
                warn!(
                    "Failed to reload global config after mode config change: mode_id={}, error={}",
                    mode_id, e
                );
            } else {
                info!(
                    "Global config reloaded after mode config change: mode_id={}",
                    mode_id
                );
            }

            Ok(format!("Mode '{}' configuration set successfully", mode_id))
        }
        Err(e) => {
            error!(
                "Failed to set mode config: mode_id={}, error={}",
                mode_id, e
            );
            Err(format!("Failed to set mode config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn reset_mode_config(
    _state: State<'_, AppState>,
    mode_id: String,
) -> Result<String, String> {
    match ai00_x_core::service::config::mode_config_canonicalizer::reset_mode_config_to_default(
        &mode_id,
    )
    .await
    {
        Ok(_) => {
            if let Err(e) = ai00_x_core::service::config::reload_global_config().await {
                warn!(
                    "Failed to reload global config after mode config reset: mode_id={}, error={}",
                    mode_id, e
                );
            } else {
                info!(
                    "Global config reloaded after mode config reset: mode_id={}",
                    mode_id
                );
            }

            Ok(format!(
                "Mode '{}' configuration reset successfully",
                mode_id
            ))
        }
        Err(e) => {
            error!(
                "Failed to reset mode config: mode_id={}, error={}",
                mode_id, e
            );
            Err(format!("Failed to reset mode config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn get_subagent_configs(state: State<'_, AppState>) -> Result<Value, String> {
    use ai00_x_core::service::config::types::SubAgentConfig;
    use std::collections::HashMap;

    let config_service = &state.config_service;
    let mut subagent_configs: HashMap<String, SubAgentConfig> = config_service
        .get_config(Some("ai.subagent_configs"))
        .await
        .unwrap_or_default();

    let workspace = state.workspace_path.read().await.clone();
    let all_subagents = state
        .agent_registry
        .get_subagents_info(workspace.as_deref())
        .await;
    let mut needs_save = false;

    for subagent in all_subagents {
        let subagent_id = subagent.id;
        if let std::collections::hash_map::Entry::Vacant(e) = subagent_configs.entry(subagent_id) {
            e.insert(SubAgentConfig { enabled: true });
            needs_save = true;
        }
    }

    if needs_save {
        match to_json_value(&subagent_configs, "subagent configs") {
            Ok(subagent_configs_value) => {
                if let Err(e) = config_service
                    .set_config("ai.subagent_configs", subagent_configs_value)
                    .await
                {
                    warn!("Failed to save initialized subagent configs: {}", e);
                }
            }
            Err(e) => {
                warn!("Failed to serialize initialized subagent configs: {}", e);
            }
        }
    }

    to_json_value(subagent_configs, "subagent configs")
}

#[tauri::command]
pub async fn set_subagent_config(
    state: State<'_, AppState>,
    subagent_id: String,
    enabled: bool,
) -> Result<String, String> {
    use ai00_x_core::service::config::types::SubAgentConfig;

    let config_service = &state.config_service;
    let config = SubAgentConfig { enabled };
    let path = format!("ai.subagent_configs.{}", subagent_id);
    let config_value = to_json_value(&config, "subagent config")?;

    match config_service.set_config(&path, config_value).await {
        Ok(_) => {
            if let Err(e) = ai00_x_core::service::config::reload_global_config().await {
                warn!("Failed to reload global config after subagent config change: subagent_id={}, error={}", subagent_id, e);
            } else {
                info!("Global config reloaded after subagent config change: subagent_id={}, enabled={}", subagent_id, enabled);
            }

            Ok(format!(
                "SubAgent '{}' configuration set successfully",
                subagent_id
            ))
        }
        Err(e) => {
            error!(
                "Failed to set subagent config: subagent_id={}, enabled={}, error={}",
                subagent_id, enabled, e
            );
            Err(format!("Failed to set SubAgent config: {}", e))
        }
    }
}

#[tauri::command]
pub async fn canonicalize_mode_configs(_state: State<'_, AppState>) -> Result<Value, String> {
    match ai00_x_core::service::config::mode_config_canonicalizer::canonicalize_mode_configs().await
    {
        Ok(report) => {
            info!(
                "Mode configs canonicalized: removed_modes={}, updated_modes={}",
                report.removed_mode_configs.len(),
                report.updated_modes.len()
            );
            Ok(to_json_value(
                report,
                "mode config canonicalization report",
            )?)
        }
        Err(e) => {
            error!("Failed to canonicalize mode configs: {}", e);
            Err(format!("Failed to canonicalize mode configs: {}", e))
        }
    }
}
