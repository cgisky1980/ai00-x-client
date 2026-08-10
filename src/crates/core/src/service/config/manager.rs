//! Configuration manager implementation
//!
//! A complete configuration management system based on the Provider mechanism.

use super::providers::ConfigProviderRegistry;
use super::types::*;
use crate::infrastructure::{try_get_path_manager_arc, PathManager};
use crate::util::errors::*;
use log::{debug, info, warn};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;

type ConfigMigrationFn = fn(Value) -> Ai00XResult<Value>;
type ConfigMigration = (&'static str, &'static str, ConfigMigrationFn);

/// Configuration manager.
pub struct ConfigManager {
    config_dir: PathBuf,
    config: GlobalConfig,
    providers: ConfigProviderRegistry,
    config_file: PathBuf,
    path_manager: Arc<PathManager>,
}

/// Configuration manager settings.
#[derive(Debug, Clone)]
pub struct ConfigManagerSettings {
    pub path_manager: Option<Arc<PathManager>>,
    pub auto_save: bool,
    pub backup_count: usize,
}

impl Default for ConfigManagerSettings {
    fn default() -> Self {
        Self {
            path_manager: None,
            auto_save: true,
            backup_count: 5,
        }
    }
}

impl ConfigManager {
    /// Creates a new unified configuration manager.
    pub async fn new(settings: ConfigManagerSettings) -> Ai00XResult<Self> {
        let path_manager = match settings.path_manager {
            Some(path_manager) => path_manager,
            None => try_get_path_manager_arc()?,
        };

        path_manager.initialize_user_directories().await?;

        let config_dir = path_manager.user_config_dir();
        let config_file = path_manager.app_config_file();

        let providers = ConfigProviderRegistry::new();

        let mut manager = Self {
            config_dir,
            config: GlobalConfig::default(),
            providers,
            config_file,
            path_manager,
        };

        manager.load_or_create_config().await?;

        debug!("ConfigManager initialized at {:?}", manager.config_file);
        Ok(manager)
    }

    /// Returns the path manager.
    pub fn path_manager(&self) -> &Arc<PathManager> {
        &self.path_manager
    }

    /// Loads or creates the configuration file.
    async fn load_or_create_config(&mut self) -> Ai00XResult<()> {
        if self.config_file.exists() {
            self.load_and_migrate_config().await?;
        } else {
            self.config = self.providers.get_default_config();
            Self::add_default_agent_models_config(&mut self.config.ai.agent_models);
            Self::add_default_func_agent_models_config(&mut self.config.ai.func_agent_models);
            self.config.version = env!("CARGO_PKG_VERSION").to_string();
            self.save_config().await?;
            debug!("Created default config file");
        }

        Ok(())
    }

    /// Loads and migrates configuration.
    async fn load_and_migrate_config(&mut self) -> Ai00XResult<()> {
        let content = fs::read_to_string(&self.config_file)
            .await
            .map_err(|e| Ai00XError::config(format!("Failed to read config file: {}", e)))?;

        let mut config_value: Value = serde_json::from_str(&content).map_err(|e| {
            Ai00XError::config(format!("Failed to parse config file as JSON: {}", e))
        })?;

        // Sanitize obsolete gesture action variants (VrmShow/VrmHide) before
        // deserialization, since they were removed from the GestureAction enum
        // when VRM features were stripped out.
        sanitize_legacy_gesture_actions(&mut config_value);

        let file_version = config_value
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0")
            .to_string();

        let current_version = env!("CARGO_PKG_VERSION").to_string();

        let mut needs_migration = !versions_match(&file_version, &current_version);
        if needs_migration {
            info!(
                "Config version change detected: {} -> {}",
                file_version, current_version
            );
            config_value = self
                .migrate_config_version(&file_version, config_value)
                .await?;

            if let Some(obj) = config_value.as_object_mut() {
                obj.insert(
                    "version".to_string(),
                    Value::String(current_version.clone()),
                );
            }
        }

        match serde_json::from_value::<GlobalConfig>(config_value.clone()) {
            Ok(mut config) => {
                Self::ensure_models_config(&mut config.ai.models);
                Self::add_default_agent_models_config(&mut config.ai.agent_models);
                Self::add_default_func_agent_models_config(&mut config.ai.func_agent_models);
                Self::enforce_fast_model_binding(&mut config.ai.default_models);
                Self::ensure_ai00s_models(&mut config.ai.models, &config.app.ai00_s_base_url);
                Self::migrate_ai00s_model_refs(&mut config.ai);

                if config.migrate_vrm_to_standalone() {
                    needs_migration = true;
                }

                self.config = config;

                if needs_migration {
                    self.config.version = current_version;
                    self.save_config().await?;
                    info!("Config migrated and saved");
                } else {
                    debug!("Loaded config from file");
                }

                Ok(())
            }
            Err(e) => {
                warn!(
                    "Config file deserialization failed, starting smart merge: {}",
                    e
                );

                self.smart_merge_config_from_value(config_value).await
            }
        }
    }

    /// Performs a smart merge from a JSON value.
    async fn smart_merge_config_from_value(&mut self, user_value: Value) -> Ai00XResult<()> {
        let base_config = self.providers.get_default_config();

        let base_value = serde_json::to_value(&base_config).map_err(|e| {
            Ai00XError::config(format!("Failed to serialize default config: {}", e))
        })?;
        let merged_value = deep_merge(base_value, user_value);

        let mut config: GlobalConfig = serde_json::from_value(merged_value).map_err(|e| {
            Ai00XError::config(format!("Failed to deserialize merged config: {}", e))
        })?;

        Self::ensure_models_config(&mut config.ai.models);
        Self::add_default_agent_models_config(&mut config.ai.agent_models);
        Self::add_default_func_agent_models_config(&mut config.ai.func_agent_models);
        Self::enforce_fast_model_binding(&mut config.ai.default_models);
        Self::ensure_ai00s_models(&mut config.ai.models, &config.app.ai00_s_base_url);
        Self::migrate_ai00s_model_refs(&mut config.ai);

        let _ = config.migrate_vrm_to_standalone();

        self.config = config;

        self.config.version = env!("CARGO_PKG_VERSION").to_string();
        self.save_config().await?;
        info!("Config automatically fixed and saved");

        Ok(())
    }

    /// Auto-completes missing fields in model configuration (backward compatible).
    /// Ensures older configurations won't panic.
    fn ensure_models_config(models: &mut [AIModelConfig]) {
        for model in models.iter_mut() {
            model.ensure_category_and_capabilities();
        }
        debug!(
            "Auto-completed category and capabilities for {} models",
            models.len()
        );
    }

    fn ensure_ai00s_models(models: &mut Vec<AIModelConfig>, base_url: &str) {
        models.retain(|m| m.id != "ai00s-free" && m.id != "ai00s-vip" && m.id != "ai00s-svip");

        if !models.iter().any(|m| m.id == "ai00s") {
            models.push(AIModelConfig {
                id: "ai00s".to_string(),
                name: "Ai00-S".to_string(),
                provider: "ai00s".to_string(),
                model_name: "ai00s".to_string(),
                base_url: base_url.to_string(),
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
        for model in models.iter_mut() {
            if model.provider == "ai00s" {
                model.base_url = base_url.to_string();
            }
        }
    }

    fn migrate_ai00s_model_refs(config: &mut AIConfig) {
        let migrate = |id: &mut String| {
            if id == "ai00s-free" || id == "ai00s-vip" || id == "ai00s-svip" {
                *id = "ai00s".to_string();
            }
        };
        if let Some(ref mut primary) = config.default_models.primary {
            migrate(primary);
        }
        if let Some(ref mut fast) = config.default_models.fast {
            migrate(fast);
        }
        for v in config.agent_models.values_mut() {
            migrate(v);
        }
        for v in config.func_agent_models.values_mut() {
            migrate(v);
        }
    }

    /// Adds default configuration for the primary agents (`agent_models`).
    fn add_default_agent_models_config(
        agent_models: &mut std::collections::HashMap<String, String>,
    ) {
        let agents_using_fast = vec![
            "Explore",
            "FileFinder",
            "GenerateDoc",
            "CodeReview",
            "Router",
            "Init",
        ];
        for key in agents_using_fast {
            if !agent_models.contains_key(key) {
                agent_models.insert(key.to_string(), "fast".to_string());
            }
        }
    }

    /// Adds default configuration for functional agents (`func_agent_models`).
    fn add_default_func_agent_models_config(
        func_agent_models: &mut std::collections::HashMap<String, String>,
    ) {
        let func_agents_using_fast = vec![
            "compression",
            "startchat-func-agent",
            "session-title-func-agent",
            "git-func-agent",
        ];
        for key in func_agents_using_fast {
            if !func_agent_models.contains_key(key) {
                func_agent_models.insert(key.to_string(), "fast".to_string());
            }
        }
    }

    fn enforce_fast_model_binding(default_models: &mut DefaultModelsConfig) {
        const RWKV_FAST_MODEL_ID: &str = "rwkv-local";
        if default_models.fast.as_deref() != Some(RWKV_FAST_MODEL_ID) {
            info!(
                "Enforcing fast model binding to '{}', was: {:?}",
                RWKV_FAST_MODEL_ID, default_models.fast
            );
            default_models.fast = Some(RWKV_FAST_MODEL_ID.to_string());
        }
    }

    /// Migrates configuration versions.
    async fn migrate_config_version(
        &self,
        from_version: &str,
        mut config: Value,
    ) -> Ai00XResult<Value> {
        let migrations: Vec<ConfigMigration> = vec![
            ("0.0.0", "1.0.0", migrate_0_0_0_to_1_0_0),
            ("1.0.0", "1.1.0", migrate_1_0_0_to_1_1_0),
        ];

        let mut current_version = from_version.to_string();

        for (from, to, migrate_fn) in migrations {
            if version_gte(&current_version, from) && version_lt(&current_version, to) {
                debug!("Executing migration: {} -> {}", from, to);
                config = migrate_fn(config)?;
                current_version = to.to_string();
            }
        }

        Ok(config)
    }

    /// Saves the configuration file.
    pub async fn save_config(&self) -> Ai00XResult<()> {
        let content = serde_json::to_string_pretty(&self.config)
            .map_err(|e| Ai00XError::config(format!("Config serialization failed: {}", e)))?;

        if let Some(parent) = self.config_file.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).await.map_err(|e| {
                    Ai00XError::config(format!(
                        "Failed to create config directory {:?}: {}",
                        parent, e
                    ))
                })?;
            }
        }

        fs::write(&self.config_file, content).await.map_err(|e| {
            Ai00XError::config(format!(
                "Failed to write config file {:?}: {}",
                self.config_file, e
            ))
        })?;
        Ok(())
    }

    /// Gets a configuration value (supports dot-paths).
    pub fn get<T>(&self, path: &str) -> Ai00XResult<T>
    where
        T: serde::de::DeserializeOwned,
    {
        let value = self.get_value_by_path(path)?;
        serde_json::from_value(value).map_err(|e| {
            Ai00XError::config(format!(
                "Failed to deserialize config value at '{}': {}",
                path, e
            ))
        })
    }

    /// Sets a configuration value (supports dot-paths).
    pub async fn set<T>(&mut self, path: &str, value: T) -> Ai00XResult<()>
    where
        T: serde::Serialize,
    {
        let old_config = self.config.clone();
        let json_value = serde_json::to_value(value)
            .map_err(|e| Ai00XError::config(format!("Failed to serialize config value: {}", e)))?;

        self.set_value_by_path(path, json_value)?;
        self.config.last_modified = chrono::Utc::now();

        if let Err(e) = self.validate_config().await {
            self.config = old_config;
            return Err(e);
        }

        self.notify_config_changed(path, &old_config).await?;

        Ok(())
    }

    /// Resets configuration (supports dot-paths).
    pub async fn reset(&mut self, path: Option<&str>) -> Ai00XResult<()> {
        let old_config = self.config.clone();

        if let Some(path) = path {
            let default_config = self.providers.get_default_config();
            let default_value = self.get_value_by_path_from_config(&default_config, path)?;
            self.set_value_by_path(path, default_value)?;
        } else {
            self.config = self.providers.get_default_config();
        }

        self.config.last_modified = chrono::Utc::now();

        if let Some(path) = path {
            self.notify_config_changed(path, &old_config).await?;
        } else {
            for provider_name in self.providers.get_provider_names() {
                self.notify_config_changed(&provider_name, &old_config)
                    .await?;
            }
        }

        Ok(())
    }

    /// Returns the full configuration.
    pub fn get_config(&self) -> &GlobalConfig {
        &self.config
    }

    /// Validates configuration.
    pub async fn validate_config(&self) -> Ai00XResult<ConfigValidationResult> {
        self.providers.validate_config(&self.config).await
    }

    /// Exports configuration.
    pub fn export_config(&self) -> Ai00XResult<serde_json::Value> {
        serde_json::to_value(&self.config)
            .map_err(|e| Ai00XError::config(format!("Failed to export config: {}", e)))
    }

    /// Imports configuration.
    pub async fn import_config(&mut self, config_data: serde_json::Value) -> Ai00XResult<()> {
        let old_config = self.config.clone();

        let imported_config: GlobalConfig = serde_json::from_value(config_data)
            .map_err(|e| Ai00XError::config(format!("Failed to parse imported config: {}", e)))?;

        let validation_result = self.providers.validate_config(&imported_config).await?;
        if !validation_result.valid {
            let error_messages: Vec<String> = validation_result
                .errors
                .iter()
                .map(|e| e.message.clone())
                .collect();
            return Err(Ai00XError::validation(format!(
                "Invalid imported config: {}",
                error_messages.join(", ")
            )));
        }

        self.config = imported_config;
        self.config.last_modified = chrono::Utc::now();

        for provider_name in self.providers.get_provider_names() {
            self.notify_config_changed(&provider_name, &old_config)
                .await?;
        }

        info!("Successfully imported configuration");
        Ok(())
    }

    /// Creates a configuration backup.
    pub async fn create_backup(&self) -> Ai00XResult<PathBuf> {
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_dir = self.config_dir.join("backups");

        if !backup_dir.exists() {
            fs::create_dir_all(&backup_dir).await.map_err(|e| {
                Ai00XError::config(format!("Failed to create backup directory: {}", e))
            })?;
        }

        let backup_file = backup_dir.join(format!("config_backup_{}.json", timestamp));

        let content = serde_json::to_string_pretty(&self.config)
            .map_err(|e| Ai00XError::config(format!("Failed to serialize backup: {}", e)))?;

        fs::write(&backup_file, content)
            .await
            .map_err(|e| Ai00XError::config(format!("Failed to write backup: {}", e)))?;

        info!("Created config backup: {:?}", backup_file);
        Ok(backup_file)
    }

    /// Registers a configuration provider.
    pub fn register_provider(&mut self, provider: Box<dyn ConfigProvider>) {
        self.providers.register(provider);
    }

    /// Returns configuration statistics.
    pub fn get_statistics(&self) -> ConfigStatistics {
        ConfigStatistics {
            total_ai_models: self.config.ai.models.len(),
            has_default_model: self.config.ai.default_models.primary.is_some(),
            config_directory: self.config_dir.clone(),
            providers_count: self.providers.get_provider_names().len(),
            last_modified: self.config.last_modified,
        }
    }

    /// Gets a configuration value by dot-path.
    fn get_value_by_path(&self, path: &str) -> Ai00XResult<serde_json::Value> {
        self.get_value_by_path_from_config(&self.config, path)
    }

    /// Gets a configuration value by dot-path from the given config.
    fn get_value_by_path_from_config(
        &self,
        config: &GlobalConfig,
        path: &str,
    ) -> Ai00XResult<serde_json::Value> {
        let config_value = serde_json::to_value(config)
            .map_err(|e| Ai00XError::config(format!("Failed to serialize config: {}", e)))?;

        let keys: Vec<&str> = path.split('.').collect();
        let mut current = &config_value;

        for key in keys {
            current = current
                .get(key)
                .ok_or_else(|| Ai00XError::config(format!("Config path '{}' not found", path)))?;
        }

        Ok(current.clone())
    }

    /// Sets a configuration value by dot-path.
    fn set_value_by_path(&mut self, path: &str, value: serde_json::Value) -> Ai00XResult<()> {
        if path.is_empty() {
            self.config = serde_json::from_value(value)
                .map_err(|e| Ai00XError::config(format!("Failed to deserialize config: {}", e)))?;
            return Ok(());
        }

        let mut config_value = serde_json::to_value(&self.config)
            .map_err(|e| Ai00XError::config(format!("Failed to serialize config: {}", e)))?;

        let keys: Vec<&str> = path.split('.').filter(|k| !k.is_empty()).collect();
        if keys.is_empty() {
            self.config = serde_json::from_value(value)
                .map_err(|e| Ai00XError::config(format!("Failed to deserialize config: {}", e)))?;
            return Ok(());
        }

        let last_key = keys.last().ok_or_else(|| {
            Ai00XError::config(format!("Config path '{}' does not contain any keys", path))
        })?;
        let parent_keys = &keys[..keys.len() - 1];

        let mut current = &mut config_value;
        for key in parent_keys {
            current = current
                .get_mut(key)
                .ok_or_else(|| Ai00XError::config(format!("Config path '{}' not found", path)))?;
        }

        if let Some(obj) = current.as_object_mut() {
            obj.insert(last_key.to_string(), value);
        } else {
            return Err(Ai00XError::config(format!(
                "Cannot set value at path '{}': parent is not an object",
                path
            )));
        }

        self.config = serde_json::from_value(config_value).map_err(|e| {
            Ai00XError::config(format!("Failed to deserialize updated config: {}", e))
        })?;

        Ok(())
    }

    /// Notifies about a configuration change.
    async fn notify_config_changed(
        &self,
        path: &str,
        old_config: &GlobalConfig,
    ) -> Ai00XResult<()> {
        self.check_and_broadcast_debug_mode_change(old_config).await;
        self.check_and_broadcast_log_level_change(old_config).await;

        self.providers
            .notify_config_changed(path, old_config, &self.config)
            .await
    }

    /// Detects and broadcasts debug-mode configuration changes.
    async fn check_and_broadcast_debug_mode_change(&self, old_config: &GlobalConfig) {
        let old_debug = &old_config.ai.debug_mode_config;
        let new_debug = &self.config.ai.debug_mode_config;

        if old_debug.ingest_port != new_debug.ingest_port
            || old_debug.log_path != new_debug.log_path
        {
            debug!(
                "Debug Mode config change detected: port {} -> {}, log_path {} -> {}",
                old_debug.ingest_port,
                new_debug.ingest_port,
                old_debug.log_path,
                new_debug.log_path
            );

            use super::global::{ConfigUpdateEvent, GlobalConfigManager};
            GlobalConfigManager::broadcast_update(ConfigUpdateEvent::DebugModeConfigUpdated {
                new_port: new_debug.ingest_port,
                new_log_path: new_debug.log_path.clone(),
            })
            .await;
        }
    }

    /// Detects and broadcasts runtime log-level changes.
    async fn check_and_broadcast_log_level_change(&self, old_config: &GlobalConfig) {
        let old_level = old_config.app.logging.level.trim().to_lowercase();
        let new_level = self.config.app.logging.level.trim().to_lowercase();

        if old_level != new_level {
            debug!(
                "App logging level change detected: {} -> {}",
                old_level, new_level
            );

            use super::global::{ConfigUpdateEvent, GlobalConfigManager};
            GlobalConfigManager::broadcast_update(ConfigUpdateEvent::LogLevelUpdated { new_level })
                .await;
        }
    }
}

/// Configuration statistics.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigStatistics {
    pub total_ai_models: usize,
    pub has_default_model: bool,
    pub config_directory: PathBuf,
    pub providers_count: usize,
    pub last_modified: chrono::DateTime<chrono::Utc>,
}

/// Deeply merges JSON values.
///
/// Merges values from `overlay` into `base`:
/// - For objects, recursively merges all key/value pairs
/// - For other types, `overlay` overwrites `base`
/// - Keeps fields that exist in `base` but not in `overlay`
pub(crate) fn deep_merge(base: Value, overlay: Value) -> Value {
    match (base, overlay) {
        (Value::Object(mut base_obj), Value::Object(overlay_obj)) => {
            for (key, overlay_value) in overlay_obj {
                if let Some(base_value) = base_obj.get(&key) {
                    base_obj.insert(key.clone(), deep_merge(base_value.clone(), overlay_value));
                } else {
                    base_obj.insert(key.clone(), overlay_value);
                }
            }
            Value::Object(base_obj)
        }
        (_, overlay) => overlay,
    }
}

/// Returns whether two versions match.
pub(crate) fn versions_match(v1: &str, v2: &str) -> bool {
    v1 == v2
}

/// Returns whether `v1 >= v2`.
pub(crate) fn version_gte(v1: &str, v2: &str) -> bool {
    parse_version(v1) >= parse_version(v2)
}

/// Returns whether `v1 < v2`.
pub(crate) fn version_lt(v1: &str, v2: &str) -> bool {
    parse_version(v1) < parse_version(v2)
}

/// Parses a version string into a tuple `(major, minor, patch)`.
pub(crate) fn parse_version(version: &str) -> (u32, u32, u32) {
    let parts: Vec<&str> = version.split('.').collect();
    let major = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let patch = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor, patch)
}

/// Sanitizes legacy gesture actions that are no longer valid.
///
/// Replaces obsolete `GestureAction` variants (`VrmShow`, `VrmHide`) with `None`
/// in the JSON config before deserialization. This is required because those
/// variants were removed from the `GestureAction` enum when VRM features were
/// stripped out, but existing config files may still contain them.
///
/// Handles both the top-level `gesture.bindings[]` path and the legacy
/// `vrm.gesture.bindings[]` path.
pub(crate) fn sanitize_legacy_gesture_actions(config: &mut Value) {
    let mut sanitized_count = 0usize;

    // Helper: walk a gesture config object and sanitize its bindings.
    let sanitize_bindings = |gesture: &mut Value, count: &mut usize| {
        if let Some(bindings) = gesture.get_mut("bindings").and_then(|v| v.as_array_mut()) {
            for binding in bindings.iter_mut() {
                if let Some(action) = binding.get_mut("action").and_then(|v| v.as_object_mut()) {
                    if let Some(t) = action.get("type").and_then(|v| v.as_str()) {
                        if t == "VrmShow" || t == "VrmHide" {
                            action.clear();
                            action.insert("type".to_string(), Value::String("None".to_string()));
                            *count += 1;
                        }
                    }
                }
            }
        }
    };

    // Top-level gesture path (current config layout).
    if let Some(gesture) = config.get_mut("gesture") {
        sanitize_bindings(gesture, &mut sanitized_count);
    }

    // Legacy vrm.gesture path (pre-migration config layout).
    if let Some(vrm) = config.get_mut("vrm") {
        if let Some(gesture) = vrm.get_mut("gesture") {
            sanitize_bindings(gesture, &mut sanitized_count);
        }
    }

    if sanitized_count > 0 {
        info!(
            "Sanitized {} legacy VrmShow/VrmHide gesture bindings to None",
            sanitized_count
        );
    }
}

/// Migration function: `0.0.0 -> 1.0.0`.
///
/// This migration is an example showing how to handle configuration upgrades.
pub(crate) fn migrate_0_0_0_to_1_0_0(mut config: Value) -> Ai00XResult<Value> {
    debug!("Executing config migration: 0.0.0 -> 1.0.0");

    if let Some(app) = config.get_mut("app").and_then(|v| v.as_object_mut()) {
        if !app.contains_key("ai_experience") {
            app.insert(
                "ai_experience".to_string(),
                serde_json::json!({
                    "enable_session_title_generation": true,
                    "enable_welcome_panel_ai_analysis": false
                }),
            );
        }
    }

    if let Some(ai) = config.get_mut("ai").and_then(|v| v.as_object_mut()) {
        if !ai.contains_key("super_agent_models") {
            ai.insert(
                "super_agent_models".to_string(),
                Value::Object(serde_json::Map::new()),
            );
        }
        if !ai.contains_key("sub_agent_models") {
            ai.insert("sub_agent_models".to_string(), serde_json::json!({}));
        }
        if !ai.contains_key("func_agent_models") {
            let func_keys = [
                "compression",
                "startchat-func-agent",
                "session-title-func-agent",
                "git-func-agent",
            ];
            let mut fa = serde_json::Map::new();
            if let Some(am) = ai.get("agent_models").and_then(|v| v.as_object()) {
                for k in func_keys {
                    if let Some(v) = am.get(k) {
                        fa.insert(k.to_string(), v.clone());
                    }
                }
            }
            ai.insert("func_agent_models".to_string(), Value::Object(fa));
        }
    }

    debug!("Migration 0.0.0 -> 1.0.0 completed");
    Ok(config)
}

/// Migration function: `1.0.0 -> 1.1.0`.
///
/// Migrates legacy agent type keys in `agent_models` to the top-level Agent architecture:
/// - "agentic" → "Code"
/// - "Cowork" → "Code"
/// - "Core" → "Code" (in agent_models)
/// - "code" → "Code" (in app.session.default_mode)
/// - "cowork" → "Code" (in app.session.default_mode)
pub(crate) fn migrate_1_0_0_to_1_1_0(mut config: Value) -> Ai00XResult<Value> {
    debug!("Executing config migration: 1.0.0 -> 1.1.0");

    if let Some(ai) = config.get_mut("ai").and_then(|v| v.as_object_mut()) {
        if let Some(agent_models) = ai.get_mut("agent_models").and_then(|v| v.as_object_mut()) {
            let legacy_keys = ["agentic", "Cowork", "Core"];
            let mut migrated_value: Option<Value> = None;

            for key in &legacy_keys {
                if let Some(value) = agent_models.remove(*key) {
                    if migrated_value.is_none() {
                        migrated_value = Some(value);
                    }
                }
            }

            if let Some(value) = migrated_value {
                if !agent_models.contains_key("Code") {
                    agent_models.insert("Code".to_string(), value);
                    debug!("Migrated agent_models: agentic/Cowork/Core -> Code");
                }
            }
        }
    }

    if let Some(app) = config.get_mut("app").and_then(|v| v.as_object_mut()) {
        if let Some(session) = app.get_mut("session").and_then(|v| v.as_object_mut()) {
            if let Some(
                _default_mode @ ("code" | "cowork" | "agentic" | "Agentic" | "Cowork" | "Core"),
            ) = session.get("default_mode").and_then(|v| v.as_str())
            {
                session.insert(
                    "default_mode".to_string(),
                    Value::String("Code".to_string()),
                );
                debug!("Migrated app.session.default_mode -> Code");
            }
        }
    }

    debug!("Migration 1.0.0 -> 1.1.0 completed");
    Ok(config)
}
