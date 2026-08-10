//! Configuration service implementation
//!
//! Provides comprehensive configuration management functionality.

use super::manager::{ConfigManager, ConfigManagerSettings, ConfigStatistics};
use super::types::*;
use crate::util::errors::*;
use log::{info, trace, warn};

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Configuration service.
pub struct ConfigService {
    manager: Arc<RwLock<ConfigManager>>,
}

/// Configuration import/export format.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigExport {
    pub config: GlobalConfig,
    pub export_timestamp: String,
    pub version: String,
}

/// Configuration import result.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigImportResult {
    pub success: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// Configuration health status.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigHealthStatus {
    pub healthy: bool,
    pub total_providers: usize,
    pub config_directory: std::path::PathBuf,
    pub warnings: Vec<String>,
    pub message: String,
    pub last_modified: chrono::DateTime<chrono::Utc>,
}

impl ConfigService {
    /// Creates a new configuration service.
    pub async fn new() -> Ai00XResult<Self> {
        let settings = ConfigManagerSettings::default();
        Self::with_settings(settings).await
    }

    /// Creates a configuration service with custom settings.
    pub async fn with_settings(settings: ConfigManagerSettings) -> Ai00XResult<Self> {
        let manager = ConfigManager::new(settings).await?;

        Ok(Self {
            manager: Arc::new(RwLock::new(manager)),
        })
    }

    /// Gets a configuration value (supports dot-paths).
    pub async fn get_config<T>(&self, path: Option<&str>) -> Ai00XResult<T>
    where
        T: serde::de::DeserializeOwned,
    {
        trace!("GET_CONFIG_READ_LOCK path={:?}", path);
        let manager = self.manager.read().await;
        trace!("GET_CONFIG_READ_LOCK_ACQUIRED path={:?}", path);

        if let Some(path) = path {
            manager.get(path)
        } else {
            let config = manager.get_config();
            serde_json::from_value(serde_json::to_value(config)?)
                .map_err(|e| Ai00XError::config(format!("Failed to serialize config: {}", e)))
        }
    }

    /// Sets a configuration value (supports dot-paths).
    pub async fn set_config<T>(&self, path: &str, value: T) -> Ai00XResult<()>
    where
        T: serde::Serialize,
    {
        trace!("SET_CONFIG_WRITE_LOCK path={}", path);
        let mut manager = self.manager.write().await;
        trace!("SET_CONFIG_WRITE_LOCK_ACQUIRED path={}", path);
        manager.set(path, value).await?;
        drop(manager);
        trace!("SET_CONFIG_WRITE_RELEASED path={}", path);
        let manager = self.manager.read().await;
        manager.save_config().await
    }

    /// Resets configuration.
    pub async fn reset_config(&self, path: Option<&str>) -> Ai00XResult<()> {
        trace!("RESET_CONFIG_WRITE_LOCK path={:?}", path);
        let mut manager = self.manager.write().await;
        trace!("RESET_CONFIG_WRITE_LOCK_ACQUIRED path={:?}", path);
        manager.reset(path).await?;
        drop(manager);
        let manager = self.manager.read().await;
        manager.save_config().await
    }

    /// Validates configuration.
    pub async fn validate_config(&self) -> Ai00XResult<ConfigValidationResult> {
        let manager = self.manager.read().await;
        manager.validate_config().await
    }

    /// Exports configuration.
    pub async fn export_config(&self) -> Ai00XResult<ConfigExport> {
        let manager = self.manager.read().await;
        let config_value = manager.export_config()?;
        let config: GlobalConfig = serde_json::from_value(config_value)?;

        Ok(ConfigExport {
            config,
            export_timestamp: chrono::Utc::now().to_rfc3339(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        })
    }

    /// Imports configuration.
    pub async fn import_config(&self, export: ConfigExport) -> Ai00XResult<ConfigImportResult> {
        trace!("IMPORT_CONFIG_WRITE_LOCK");
        let mut manager = self.manager.write().await;
        trace!("IMPORT_CONFIG_WRITE_LOCK_ACQUIRED");
        let result = manager
            .import_config(serde_json::to_value(export.config)?)
            .await;
        drop(manager);
        let manager = self.manager.read().await;
        manager.save_config().await?;

        match result {
            Ok(_) => Ok(ConfigImportResult {
                success: true,
                errors: Vec::new(),
                warnings: Vec::new(),
            }),
            Err(e) => Ok(ConfigImportResult {
                success: false,
                errors: vec![e.to_string()],
                warnings: Vec::new(),
            }),
        }
    }

    /// Returns configuration statistics.
    pub async fn get_statistics(&self) -> ConfigStatistics {
        let manager = self.manager.read().await;
        manager.get_statistics()
    }

    /// Runs a health check.
    pub async fn health_check(&self) -> Ai00XResult<ConfigHealthStatus> {
        let manager = self.manager.read().await;
        let stats = manager.get_statistics();
        let validation_result = manager.validate_config().await?;

        let mut warnings = Vec::new();

        for warning in &validation_result.warnings {
            warnings.push(format!("{}: {}", warning.path, warning.message));
        }

        if stats.total_ai_models == 0 {
            warnings.push("No AI models configured".to_string());
        }

        let config: GlobalConfig = self.get_config(None).await?;
        if config.ai.default_models.primary.is_none() {
            warnings.push("Primary model not configured".to_string());
        }

        if !stats.config_directory.exists() {
            return Ok(ConfigHealthStatus {
                healthy: false,
                total_providers: stats.providers_count,
                config_directory: stats.config_directory,
                warnings,
                message: "Configuration directory does not exist".to_string(),
                last_modified: stats.last_modified,
            });
        }

        let healthy = validation_result.valid && stats.total_ai_models > 0;

        Ok(ConfigHealthStatus {
            healthy,
            total_providers: stats.providers_count,
            config_directory: stats.config_directory,
            warnings,
            message: if healthy {
                "Configuration system is healthy".to_string()
            } else {
                "Configuration system has issues".to_string()
            },
            last_modified: stats.last_modified,
        })
    }

    /// Reloads configuration.
    pub async fn reload(&self) -> Ai00XResult<()> {
        let settings = ConfigManagerSettings::default();
        let new_manager = ConfigManager::new(settings).await?;

        trace!("RELOAD_WRITE_LOCK");
        let mut manager = self.manager.write().await;
        trace!("RELOAD_WRITE_LOCK_ACQUIRED");
        *manager = new_manager;

        info!("Configuration reloaded");
        Ok(())
    }

    /// Creates a configuration backup.
    pub async fn create_backup(&self) -> Ai00XResult<std::path::PathBuf> {
        let manager = self.manager.read().await;
        manager.create_backup().await
    }

    /// Registers a configuration provider.
    pub async fn register_provider(&self, provider: Box<dyn ConfigProvider>) {
        let mut manager = self.manager.write().await;
        manager.register_provider(provider);
    }

    /// Returns all AI model configurations.
    pub async fn get_ai_models(&self) -> Ai00XResult<Vec<AIModelConfig>> {
        let mut config: GlobalConfig = self.get_config(None).await?;
        let base_url = config.app.ai00_s_base_url.clone();
        config
            .ai
            .models
            .retain(|m| m.id != "ai00s-free" && m.id != "ai00s-vip" && m.id != "ai00s-svip");
        if !config.ai.models.iter().any(|m| m.id == "ai00s") {
            config.ai.models.push(AIModelConfig {
                id: "ai00s".to_string(),
                name: "Ai00-S".to_string(),
                provider: "ai00s".to_string(),
                model_name: "ai00s".to_string(),
                base_url: base_url.clone(),
                request_url: None,
                api_key: String::new(),
                context_window: Some(65536),
                max_tokens: Some(4096),
                temperature: Some(0.7),
                enabled: true,
                category: ModelCategory::GeneralChat,
                capabilities: vec![ModelCapability::TextChat],
                metadata: Some(serde_json::json!({"source": "ai00-s"})),
                ..Default::default()
            });
        }
        for model in config.ai.models.iter_mut() {
            if model.provider == "ai00s" {
                model.base_url = base_url.clone();
            }
        }
        Ok(config.ai.models)
    }

    /// Adds an AI model configuration.
    pub async fn add_ai_model(&self, model: AIModelConfig) -> Ai00XResult<()> {
        let mut config: GlobalConfig = self.get_config(None).await?;
        config.ai.models.push(model);
        self.set_config("ai.models", &config.ai.models).await
    }

    /// Updates an AI model configuration.
    pub async fn update_ai_model(&self, model_id: &str, model: AIModelConfig) -> Ai00XResult<()> {
        let mut config: GlobalConfig = self.get_config(None).await?;

        if let Some(existing_model) = config.ai.models.iter_mut().find(|m| m.id == model_id) {
            *existing_model = model;
            self.set_config("ai.models", &config.ai.models).await
        } else {
            Err(Ai00XError::config(format!(
                "AI model '{}' not found",
                model_id
            )))
        }
    }

    /// Deletes an AI model configuration.
    pub async fn delete_ai_model(&self, model_id: &str) -> Ai00XResult<()> {
        if model_id == "ai00s" {
            return Err(Ai00XError::config(format!(
                "AI model '{}' is built-in and cannot be deleted",
                model_id
            )));
        }
        let mut config: GlobalConfig = self.get_config(None).await?;

        let original_len = config.ai.models.len();
        config.ai.models.retain(|m| m.id != model_id);

        if config.ai.models.len() == original_len {
            return Err(Ai00XError::config(format!(
                "AI model '{}' not found",
                model_id
            )));
        }

        for (agent_name, configured_model_id) in config.ai.agent_models.clone().iter() {
            if configured_model_id == model_id {
                warn!(
                    "Deleted model {} is used by agent {}, clearing configuration",
                    model_id, agent_name
                );
                config.ai.agent_models.remove(agent_name);
            }
        }
        for (func_agent_name, configured_model_id) in config.ai.func_agent_models.clone().iter() {
            if configured_model_id == model_id {
                warn!(
                    "Deleted model {} is used by func agent {}, clearing configuration",
                    model_id, func_agent_name
                );
                config.ai.func_agent_models.remove(func_agent_name);
            }
        }

        self.set_config("ai.models", &config.ai.models).await?;
        self.set_config("ai.agent_models", &config.ai.agent_models)
            .await?;
        self.set_config("ai.func_agent_models", &config.ai.func_agent_models)
            .await?;
        Ok(())
    }
}
