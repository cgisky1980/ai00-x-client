use crate::api::app_state::AppState;
use crate::auth_vault::{get_user_auth_vault, StoredAuthInfo};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthInfo {
    pub username: String,
    pub token: String,
    pub logged_at: u64,
    #[serde(default)]
    pub plan_tier: Option<String>,
    /// P4-L2: 会员 ID（用于设备绑定/解绑等会员侧 API）
    #[serde(default)]
    pub member_id: Option<i64>,
    /// P4-L3: refresh token (用于 access token 过期后自动刷新)
    /// 旧 Vault 文件无此字段，`#[serde(default)]` 兜底为 None
    #[serde(default)]
    pub refresh_token: Option<String>,
}

static AUTH_STORE: Lazy<Mutex<Option<AuthInfo>>> = Lazy::new(|| Mutex::new(None));

#[tauri::command]
pub async fn set_auth_info(
    token: String,
    username: String,
    plan_tier: Option<String>,
    member_id: Option<i64>,
) -> Result<(), String> {
    let auth = AuthInfo {
        username: username.clone(),
        token: token.clone(),
        logged_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        plan_tier: plan_tier.clone(),
        member_id,
        refresh_token: None,
    };

    persist_auth(auth).await
}

/// P4-L3: 写入 access + refresh token 对（用于 Rust API /api/v1/auth/member/* 路径）
/// 与 `set_auth_info` 区别:同时持久化 refresh_token，启用自动刷新能力
#[tauri::command]
pub async fn set_auth_info_pair(
    token: String,
    refresh_token: String,
    username: String,
    plan_tier: Option<String>,
    member_id: Option<i64>,
) -> Result<(), String> {
    let auth = AuthInfo {
        username: username.clone(),
        token: token.clone(),
        logged_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        plan_tier: plan_tier.clone(),
        member_id,
        refresh_token: Some(refresh_token),
    };

    persist_auth(auth).await
}

/// 内部共享:写入内存 + Vault + core 层
async fn persist_auth(auth: AuthInfo) -> Result<(), String> {
    let stored = StoredAuthInfo {
        username: auth.username.clone(),
        token: auth.token.clone(),
        logged_at: auth.logged_at,
        plan_tier: auth.plan_tier.clone(),
        member_id: auth.member_id,
        refresh_token: auth.refresh_token.clone(),
    };

    {
        let mut store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
        *store = Some(auth.clone());
    }

    if let Some(vault) = get_user_auth_vault() {
        if let Err(e) = vault.store_auth(&stored).await {
            log::warn!("Failed to persist auth info to vault: {}", e);
        }
    }

    ai00_x_core::set_ai00s_auth_token(auth.token);

    Ok(())
}

#[tauri::command]
pub async fn get_auth_info() -> Result<Option<AuthInfo>, String> {
    ensure_auth_synced().await
}

/// Public non-Tauri entry point: ensures `AI00S_AUTH_TOKEN` is populated
/// from `AUTH_STORE` or vault before any AI request that needs it.
///
/// Called by `acestep_llm_chat_stream` and other non-main-window code paths
/// that create AI clients without first going through `get_auth_info`.
pub async fn ensure_auth_synced() -> Result<Option<AuthInfo>, String> {
    // 快速路径:内存中已有则直接返回
    {
        let store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
        if let Some(auth) = store.as_ref() {
            // Defensive: ensure AI00S_AUTH_TOKEN is in sync with AUTH_STORE.
            // persist_auth / restore_auth_from_vault_core already set it, but
            // this guards against any path that populates AUTH_STORE without
            // updating the static token (e.g. after ACE-Step window refresh,
            // the fast path previously skipped set_ai00s_auth_token entirely).
            ai00_x_core::set_ai00s_auth_token(auth.token.clone());
            return Ok(store.clone());
        }
    }
    // 懒加载:内存为空时尝试从 vault 恢复(不调用 fetch_tier_from_server,
    // 避免网络阻塞;tier 可后续 fetch_user_tier 命令补充)
    let _ = restore_auth_from_vault_core().await;
    let store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
    // Also ensure token is set after vault restore (defensive —
    // restore_auth_from_vault_core already does this, but keep the guarantee).
    if let Some(auth) = store.as_ref() {
        ai00_x_core::set_ai00s_auth_token(auth.token.clone());
    }
    Ok(store.clone())
}

/// Refresh the access token using the stored refresh token (core impl).
///
/// Uses the global config service to get the base URL — no Tauri State
/// dependency. Called by:
/// - `refresh_auth_token` Tauri command (frontend TokenManager)
/// - `acestep_llm_chat_stream` / `acestep_llm_complete` (on 401 retry)
pub async fn refresh_auth_token_impl() -> Result<String, String> {
    // 1. Get current auth info (with refresh_token)
    let auth_info = ensure_auth_synced().await?;
    let auth = auth_info.ok_or_else(|| "Not logged in".to_string())?;
    let refresh_token = auth
        .refresh_token
        .ok_or_else(|| "No refresh_token available".to_string())?;

    // 2. Get base URL from global config service
    let config_service = ai00_x_core::service::config::get_global_config_service()
        .map_err(|e| format!("Failed to get global config service: {}", e))?;
    let global_config: ai00_x_core::service::config::GlobalConfig = config_service
        .get_config(None)
        .await
        .map_err(|e| format!("Failed to get config: {}", e))?;
    let base_url = global_config.app.ai00_s_base_url.clone();
    let url = format!("{}/api/v1/auth/member/refresh", base_url);

    // 3. Call Ai00-Salvo refresh endpoint (server-side, no CORS).
    //    Inject X-Ai00-Internal-Token so the CSRF middleware exempt this
    //    programmatic client (same as the AI client factory does for chat
    //    requests). Without this header Ai00-Salvo returns 403 "missing Origin
    //    header" because reqwest does not send an Origin header like browsers do.
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header(
            "X-Ai00-Internal-Token",
            ai00_x_core::infrastructure::ai00_s_internal_token(),
        )
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|e| format!("Refresh request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("Refresh failed ({}): {}", status, text));
    }

    // 4. Parse response
    #[derive(Deserialize)]
    struct RefreshResponse {
        code: i32,
        data: Option<RefreshData>,
        message: Option<String>,
    }
    #[derive(Deserialize)]
    struct RefreshData {
        access_token: String,
        refresh_token: String,
    }

    let data: RefreshResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse refresh response: {} (body: {})", e, text))?;

    if data.code != 0 || data.data.is_none() {
        return Err(data.message.unwrap_or_else(|| "Refresh failed".to_string()));
    }

    let refresh_data = data.data.unwrap();

    // 5. Persist new tokens (updates AUTH_STORE + AI00S_AUTH_TOKEN)
    let new_auth = AuthInfo {
        username: auth.username.clone(),
        token: refresh_data.access_token.clone(),
        logged_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        plan_tier: auth.plan_tier.clone(),
        member_id: auth.member_id,
        refresh_token: Some(refresh_data.refresh_token),
    };
    persist_auth(new_auth).await?;

    log::info!("[Auth] Token refreshed successfully");
    Ok(refresh_data.access_token)
}

/// Tauri command wrapper for `refresh_auth_token_impl`.
/// Kept for frontend TokenManager compatibility (invoke('refresh_auth_token')).
#[tauri::command]
pub async fn refresh_auth_token(_state: State<'_, AppState>) -> Result<String, String> {
    refresh_auth_token_impl().await
}

/// Synchronous accessor for the current auth info (used by profile_sync module).
pub fn get_auth_info_sync() -> Option<AuthInfo> {
    AUTH_STORE.lock().ok().and_then(|s| s.clone())
}

#[tauri::command]
pub async fn clear_auth_info() -> Result<(), String> {
    {
        let mut store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
        *store = None;
    }

    if let Some(vault) = get_user_auth_vault() {
        if let Err(e) = vault.clear_auth().await {
            log::warn!("Failed to clear auth info from vault: {}", e);
        }
    }

    ai00_x_core::set_ai00s_auth_token(String::new());

    Ok(())
}

#[tauri::command]
pub async fn is_authenticated() -> Result<bool, String> {
    let store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
    Ok(store.is_some())
}

#[tauri::command]
pub async fn restore_auth_from_vault() -> Result<bool, String> {
    {
        let store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
        if store.is_some() {
            return Ok(true);
        }
    }

    let restored = restore_auth_from_vault_core().await?;
    if !restored {
        return Ok(false);
    }

    // 补充拉取 plan_tier(网络调用,可能阻塞;仅命令路径需要,懒加载路径跳过)
    let token = {
        let store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
        store.as_ref().map(|a| a.token.clone())
    };
    let tier_missing = {
        let store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
        store
            .as_ref()
            .map(|a| a.plan_tier.is_none())
            .unwrap_or(true)
    };
    if let Some(token) = token {
        if tier_missing {
            if let Ok(tier) = fetch_tier_from_server(&token).await {
                let mut store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
                if let Some(ref mut auth) = *store {
                    auth.plan_tier = Some(tier);
                }
            }
        }
    }

    Ok(true)
}

/// 内部:从 vault 加载 auth 到内存(不调 fetch_tier_from_server,避免网络阻塞)
/// 供 `get_auth_info` 懒加载和 `restore_auth_from_vault` 命令复用
async fn restore_auth_from_vault_core() -> Result<bool, String> {
    let Some(vault) = get_user_auth_vault() else {
        return Ok(false);
    };

    match vault.load_auth().await {
        Ok(Some(stored)) => {
            let token = stored.token.clone();
            let auth = AuthInfo {
                username: stored.username,
                token: stored.token,
                logged_at: stored.logged_at,
                plan_tier: stored.plan_tier.clone(),
                member_id: stored.member_id,
                refresh_token: stored.refresh_token.clone(),
            };
            {
                let mut store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
                *store = Some(auth);
            }
            ai00_x_core::set_ai00s_auth_token(token);
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(e) => {
            log::warn!("Failed to restore auth from vault: {}", e);
            Ok(false)
        }
    }
}

async fn fetch_tier_from_server(token: &str) -> Result<String, String> {
    use ai00_x_core::service::config::server_endpoints::ai00_s_base_url;
    let base_url = match ai00_x_core::service::config::global::get_global_config_service() {
        Ok(service) => service
            .get_config(None)
            .await
            .map(|c: ai00_x_core::service::config::types::GlobalConfig| {
                c.app.ai00_s_base_url.clone()
            })
            .unwrap_or_else(|_| ai00_s_base_url()),
        Err(_) => ai00_s_base_url(),
    };
    let url = format!("{}/ai00-s/api/ai/me", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("fetch tier failed: {}", e))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("parse tier response failed: {}", e))?;

    let tier = body
        .get("data")
        .and_then(|d| d.get("plan_tier"))
        .or_else(|| body.get("plan_tier"))
        .and_then(|t| t.as_str())
        .unwrap_or("free")
        .to_string();

    Ok(tier)
}

#[tauri::command]
pub async fn fetch_user_tier() -> Result<Option<String>, String> {
    let (token, current_tier) = {
        let store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
        match store.as_ref() {
            Some(auth) => (auth.token.clone(), auth.plan_tier.clone()),
            None => return Ok(None),
        }
    };

    if current_tier.is_some() {
        return Ok(current_tier);
    }

    match fetch_tier_from_server(&token).await {
        Ok(tier) => {
            let mut store = AUTH_STORE.lock().map_err(|e| e.to_string())?;
            if let Some(ref mut auth) = *store {
                auth.plan_tier = Some(tier.clone());
            }
            Ok(Some(tier))
        }
        Err(e) => {
            log::warn!("Failed to fetch user tier: {}", e);
            Ok(None)
        }
    }
}
