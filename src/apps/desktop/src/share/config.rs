//! Ai00-Salvo 基地址配置
//!
//! 从 `ai00_x_core::service::config::get_global_config_service()` 读取
//! `global_config.app.ai00_s_base_url`（与 `auth.rs::refresh_auth_token_impl`
//! 保持一致），失败时回退到 `server_endpoints::ai00_s_base_url()`（远程正式服务器）。
//!
//! # CSRF 头
//!
//! 所有 Ai00-Salvo 请求需带 `X-Ai00-Internal-Token` 头（值 =
//! `ai00_x_core::infrastructure::ai00_s_internal_token()`，来自环境变量），使 CSRF 中间件
//! 豁免程序化客户端（reqwest 不发送 `Origin` 头，会被 CSRF 中间件拦截）。

use ai00_x_core::service::config::server_endpoints::ai00_s_base_url;
use ai00_x_core::service::config::GlobalConfig;

/// 读取 Ai00-Salvo 基地址。
///
/// 优先从全局配置服务读取 `app.ai00_s_base_url`；若为空或读取失败，
/// 回退到 [`DEFAULT_SALVO_BASE_URL`]。
pub async fn salvo_base_url() -> String {
    if let Ok(svc) = ai00_x_core::service::config::get_global_config_service() {
        if let Ok(cfg) = svc.get_config::<GlobalConfig>(None).await {
            if !cfg.app.ai00_s_base_url.is_empty() {
                return cfg.app.ai00_s_base_url;
            }
        }
    }
    ai00_s_base_url()
}

/// CSRF 豁免头值（运行时从环境变量读取）
pub fn internal_token() -> String {
    ai00_x_core::infrastructure::ai00_s_internal_token()
}
