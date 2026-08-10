//! Global configuration service singleton
//!
//! Provides a global configuration service instance with dynamic updates and synchronization.

use super::service::ConfigService;
use crate::util::errors::*;
use log::{debug, info, warn};
use std::sync::Arc;
use std::sync::OnceLock;

/// Global configuration service singleton.
static GLOBAL_CONFIG_SERVICE: OnceLock<Arc<ConfigService>> = OnceLock::new();

/// Configuration update notification channel.
static CONFIG_UPDATE_SENDER: OnceLock<tokio::sync::broadcast::Sender<ConfigUpdateEvent>> =
    OnceLock::new();

/// Configuration update events.
#[derive(Debug, Clone)]
pub enum ConfigUpdateEvent {
    /// AI model configuration updated.
    AIModelUpdated {
        model_id: String,
        model_name: String,
    },
    /// Default AI model updated.
    DefaultAIModelUpdated {
        model_id: String,
        model_name: String,
    },
    /// Theme configuration updated.
    ThemeUpdated { theme_id: String },
    /// Editor configuration updated.
    EditorUpdated,
    /// Terminal configuration updated.
    TerminalUpdated,
    /// Workspace configuration updated.
    WorkspaceUpdated,
    /// App configuration updated.
    AppUpdated,
    /// Configuration fully reloaded.
    ConfigReloaded,
    /// Debug-mode configuration updated.
    DebugModeConfigUpdated {
        /// The new ingest port.
        new_port: u16,
        /// The new log path.
        new_log_path: String,
    },
    /// Runtime log level updated.
    LogLevelUpdated {
        /// New runtime log level.
        new_level: String,
    },
}

/// Global configuration service manager.
pub struct GlobalConfigManager;

impl GlobalConfigManager {
    /// Initializes the global configuration service.
    pub async fn initialize() -> Ai00XResult<()> {
        if Self::is_initialized() {
            debug!("Global config service already initialized, skipping");
            return Ok(());
        }

        let (sender, _) = tokio::sync::broadcast::channel(100);
        CONFIG_UPDATE_SENDER.set(sender).map_err(|_| {
            Ai00XError::config("Failed to initialize config update sender".to_string())
        })?;

        let config_service = Arc::new(ConfigService::new().await?);

        GLOBAL_CONFIG_SERVICE.set(config_service).map_err(|_| {
            Ai00XError::config("Failed to initialize global config service".to_string())
        })?;

        info!("Global config service initialized");

        match super::mode_config_canonicalizer::canonicalize_mode_configs().await {
            Ok(report) => {
                if !report.removed_mode_configs.is_empty() || !report.updated_modes.is_empty() {
                    info!(
                        "Mode config canonicalization completed: removed_modes={}, updated_modes={}",
                        report.removed_mode_configs.len(),
                        report.updated_modes.len()
                    );
                }
            }
            Err(e) => {
                warn!("Mode config canonicalization failed: {}", e);
            }
        }

        Ok(())
    }

    /// Returns the global configuration service instance.
    pub fn get_service() -> Ai00XResult<Arc<ConfigService>> {
        GLOBAL_CONFIG_SERVICE
            .get()
            .cloned()
            .ok_or_else(|| Ai00XError::config("Global config service not initialized".to_string()))
    }

    // Removed: update_service was dead code with no callers.

    /// Reloads configuration in-place.
    ///
    /// Re-reads the config from disk into the existing `ConfigService` instance,
    /// preserving the `Arc` pointer so that all holders (e.g. `AppState`) stay in sync.
    pub async fn reload() -> Ai00XResult<()> {
        let service = Self::get_service()?;
        service.reload().await?;
        if let Err(error) = super::mode_config_canonicalizer::canonicalize_mode_configs().await {
            warn!(
                "Mode config canonicalization failed after reload: {}",
                error
            );
        }
        Self::broadcast_update(ConfigUpdateEvent::ConfigReloaded).await;
        Ok(())
    }

    /// Subscribes to configuration update events.
    pub fn subscribe_updates() -> Option<tokio::sync::broadcast::Receiver<ConfigUpdateEvent>> {
        CONFIG_UPDATE_SENDER.get().map(|sender| sender.subscribe())
    }

    /// Broadcasts a configuration update event.
    pub async fn broadcast_update(event: ConfigUpdateEvent) {
        if let Some(sender) = CONFIG_UPDATE_SENDER.get() {
            let _ = sender.send(event);
        }
    }

    /// Updates an AI model configuration and broadcasts an event.
    pub async fn update_ai_model(
        &self,
        model_id: &str,
        model: crate::service::config::types::AIModelConfig,
    ) -> Ai00XResult<()> {
        let model_name = model.name.clone();
        let service = Self::get_service()?;
        service.update_ai_model(model_id, model).await?;

        Self::broadcast_update(ConfigUpdateEvent::AIModelUpdated {
            model_id: model_id.to_string(),
            model_name,
        })
        .await;

        Ok(())
    }

    /// Updates the theme configuration and broadcasts an event.
    pub async fn update_theme(&self, theme_id: &str) -> Ai00XResult<()> {
        let service = Self::get_service()?;
        service.set_config("theme.id", theme_id).await?;

        Self::broadcast_update(ConfigUpdateEvent::ThemeUpdated {
            theme_id: theme_id.to_string(),
        })
        .await;

        Ok(())
    }

    /// Returns whether the configuration service has been initialized.
    pub fn is_initialized() -> bool {
        GLOBAL_CONFIG_SERVICE.get().is_some()
    }
}

/// Convenience helper: get the global configuration service.
pub fn get_global_config_service() -> Ai00XResult<Arc<ConfigService>> {
    GlobalConfigManager::get_service()
}

/// Convenience helper: initialize the global configuration service.
pub async fn initialize_global_config() -> Ai00XResult<()> {
    GlobalConfigManager::initialize().await
}

/// Convenience helper: reload the global configuration.
pub async fn reload_global_config() -> Ai00XResult<()> {
    GlobalConfigManager::reload().await
}

/// Convenience helper: subscribe to configuration updates.
pub fn subscribe_config_updates() -> Option<tokio::sync::broadcast::Receiver<ConfigUpdateEvent>> {
    GlobalConfigManager::subscribe_updates()
}
