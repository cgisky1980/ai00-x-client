//! AI client factory - centrally manages client instances for all models

use crate::infrastructure::ai::AIClient;
use crate::service::config::providers::get_default_rwkv_model_config;
use crate::service::config::{get_global_config_service, ConfigService};
use crate::util::errors::{Ai00XError, Ai00XResult};
use crate::util::types::AIConfig;
use anyhow::{anyhow, Result};
use log::{debug, info};
use std::sync::{Arc, OnceLock};

static AI00S_AUTH_TOKEN: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// Ai00-Salvo 内部客户端共享密钥。
///
/// 用于 CSRF 豁免 + 强制头校验。值从环境变量 `AI00_S_INTERNAL_TOKEN` 读取，
/// 未设置时返回空字符串（不注入该头）。此密钥为客户端与服务端之间的共享凭证，
/// 不硬编码进公开源码，由部署方通过环境变量注入。
/// 公开以便其他模块（如 `auth::refresh_auth_token_impl`）复用，确保所有 Ai00-X →
/// Ai00-Salvo 的程序化请求都能通过 CSRF 中间件。
pub fn ai00_s_internal_token() -> String {
    std::env::var("AI00_S_INTERNAL_TOKEN").unwrap_or_default()
}

pub fn set_ai00s_auth_token(token: String) {
    let mut guard = AI00S_AUTH_TOKEN.lock().unwrap_or_else(|e| e.into_inner());
    *guard = token;
}

pub struct AIClientFactory {
    config_service: Arc<ConfigService>,
}

impl AIClientFactory {
    fn resolve_model_reference_in_config(
        global_config: &crate::service::config::GlobalConfig,
        model_ref: &str,
    ) -> Option<String> {
        global_config.ai.resolve_model_reference(model_ref)
    }

    fn resolve_model_selection_in_config(
        global_config: &crate::service::config::GlobalConfig,
        model_ref: &str,
    ) -> Option<String> {
        global_config.ai.resolve_model_selection(model_ref)
    }

    fn new(config_service: Arc<ConfigService>) -> Self {
        Self { config_service }
    }

    pub async fn get_client_by_agent(&self, agent_name: &str) -> Result<Arc<AIClient>> {
        let global_config: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;
        match global_config.ai.agent_models.get(agent_name) {
            Some(model_id) => self.get_client_resolved(model_id).await,
            None => self.get_client_resolved("primary").await,
        }
    }

    pub async fn get_client_by_func_agent(&self, func_agent_name: &str) -> Result<Arc<AIClient>> {
        let global_config: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;
        let model_id = global_config
            .ai
            .func_agent_models
            .get(func_agent_name)
            .or_else(|| global_config.ai.agent_models.get(func_agent_name))
            .map(String::as_str)
            .unwrap_or("fast");
        self.get_client_resolved(model_id).await
    }

    pub async fn get_client_by_id(&self, model_id: &str) -> Result<Arc<AIClient>> {
        self.create_client(model_id).await
    }

    pub async fn get_client_resolved(&self, model_id: &str) -> Result<Arc<AIClient>> {
        eprintln!("[TRACE] GET_CLIENT_RESOLVED model={}", model_id);
        let global_config: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;
        let resolved_model_id = match model_id {
            "primary" => Self::resolve_model_selection_in_config(&global_config, "primary")
                .ok_or_else(|| anyhow!("Primary model not configured or invalid"))?,
            "fast" => Self::resolve_model_selection_in_config(&global_config, "fast").ok_or_else(
                || anyhow!("Fast model not configured or invalid, and primary model not configured or invalid"),
            )?,
            _ => Self::resolve_model_reference_in_config(&global_config, model_id)
                .unwrap_or_else(|| model_id.to_string()),
        };
        self.create_client(&resolved_model_id).await
    }

    async fn create_client(&self, model_id: &str) -> Result<Arc<AIClient>> {
        let global_config: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;
        let normalized_model_id = match model_id {
            "primary" | "fast" => Self::resolve_model_selection_in_config(&global_config, model_id)
                .unwrap_or_else(|| model_id.to_string()),
            _ => Self::resolve_model_reference_in_config(&global_config, model_id)
                .unwrap_or_else(|| model_id.to_string()),
        };

        let model_config = if normalized_model_id == "rwkv-local" {
            global_config
                .ai
                .models
                .iter()
                .find(|m| {
                    m.id == "rwkv-local" || m.name == "rwkv-local" || m.model_name == "rwkv-local"
                })
                .cloned()
                .unwrap_or_else(|| {
                    info!("rwkv-local not in user models list, using built-in default config");
                    get_default_rwkv_model_config()
                })
        } else {
            global_config
                .ai
                .models
                .iter()
                .find(|m| {
                    m.id == normalized_model_id
                        || m.name == normalized_model_id
                        || m.model_name == normalized_model_id
                })
                .cloned()
                .ok_or_else(|| anyhow!("Model configuration not found: {}", normalized_model_id))?
        };

        let mut model_config = model_config;
        if model_config.provider == "ai00s" {
            model_config.base_url = global_config.app.ai00_s_base_url.clone();
            let token = AI00S_AUTH_TOKEN
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if !token.is_empty() {
                model_config.api_key = token;
            }
            // 注入 X-Ai00-Internal-Token 头（CSRF 豁免 + 强制头校验）
            // 值来自环境变量 AI00_S_INTERNAL_TOKEN，为空则不注入
            let internal_token = ai00_s_internal_token();
            if !internal_token.is_empty() {
                let headers = model_config
                    .custom_headers
                    .get_or_insert_with(std::collections::HashMap::new);
                headers.insert("X-Ai00-Internal-Token".to_string(), internal_token);
            }
        }

        let ai_config = AIConfig::try_from(model_config)
            .map_err(|e| anyhow!("AI configuration conversion failed: {}", e))?;

        let proxy_config = if global_config.ai.proxy.enabled {
            Some(global_config.ai.proxy.clone())
        } else {
            None
        };

        Ok(Arc::new(AIClient::new_with_proxy(ai_config, proxy_config)))
    }

    pub fn invalidate_cache(&self) {
        info!("AI client cache invalidation requested (cache disabled)");
    }

    pub fn get_cache_size(&self) -> usize {
        0
    }

    pub fn invalidate_model(&self, _model_id: &str) {
        debug!("Model invalidation requested (cache disabled)");
    }
}

static GLOBAL_AI_CLIENT_FACTORY: OnceLock<Arc<AIClientFactory>> = OnceLock::new();

impl AIClientFactory {
    pub async fn initialize_global() -> Ai00XResult<()> {
        if Self::is_global_initialized() {
            return Ok(());
        }
        info!("Initializing global AIClientFactory...");
        let config_service = get_global_config_service().map_err(|e| {
            Ai00XError::service(format!("Failed to get global config service: {}", e))
        })?;
        let factory = Arc::new(AIClientFactory::new(config_service));
        GLOBAL_AI_CLIENT_FACTORY.set(factory).map_err(|_| {
            Ai00XError::service("Failed to initialize global AIClientFactory".to_string())
        })?;
        info!("Global AIClientFactory initialized");
        Ok(())
    }

    pub fn is_global_initialized() -> bool {
        GLOBAL_AI_CLIENT_FACTORY.get().is_some()
    }

    pub fn get_global() -> Ai00XResult<Arc<AIClientFactory>> {
        GLOBAL_AI_CLIENT_FACTORY.get().cloned().ok_or_else(|| {
            Ai00XError::service(
                "Global AIClientFactory not initialized. Call initialize_global() first."
                    .to_string(),
            )
        })
    }

    pub fn try_get_global() -> Option<Arc<AIClientFactory>> {
        GLOBAL_AI_CLIENT_FACTORY.get().cloned()
    }
}

pub async fn get_global_ai_client_factory() -> Ai00XResult<Arc<AIClientFactory>> {
    AIClientFactory::get_global()
}

pub async fn initialize_global_ai_client_factory() -> Ai00XResult<()> {
    AIClientFactory::initialize_global().await
}
