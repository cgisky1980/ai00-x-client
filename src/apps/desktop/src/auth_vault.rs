use ai00_x_core::infrastructure::storage::EncryptedVault;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const AUTH_ENTRY_KEY: &str = "user_auth";
const KEY_FILENAME: &str = ".user_auth_vault.key";
const VAULT_FILENAME: &str = "user_auth_vault.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAuthInfo {
    pub username: String,
    pub token: String,
    pub logged_at: u64,
    #[serde(default)]
    pub plan_tier: Option<String>,
    /// P4-L2: 会员 ID（用于设备绑定/解绑等会员侧 API）
    #[serde(default)]
    pub member_id: Option<i64>,
    /// P4-L3: refresh token（用于 access token 过期后自动刷新）
    /// 旧 Vault 文件无此字段，`#[serde(default)]` 兜底为 None
    #[serde(default)]
    pub refresh_token: Option<String>,
}

pub struct UserAuthVault {
    vault: EncryptedVault,
}

impl UserAuthVault {
    pub fn new(data_dir: std::path::PathBuf) -> Self {
        Self {
            vault: EncryptedVault::new(data_dir, KEY_FILENAME, VAULT_FILENAME),
        }
    }

    pub async fn store_auth(&self, info: &StoredAuthInfo) -> Result<()> {
        let json = serde_json::to_string(info)?;
        self.vault.store(AUTH_ENTRY_KEY, &json).await
    }

    pub async fn load_auth(&self) -> Result<Option<StoredAuthInfo>> {
        let Some(json) = self.vault.load(AUTH_ENTRY_KEY).await? else {
            return Ok(None);
        };
        match serde_json::from_str::<StoredAuthInfo>(&json) {
            Ok(info) => Ok(Some(info)),
            Err(e) => {
                log::warn!("Failed to parse stored auth info: {}", e);
                Ok(None)
            }
        }
    }

    pub async fn clear_auth(&self) -> Result<()> {
        self.vault.clear().await
    }
}

use once_cell::sync::Lazy;
use std::sync::Mutex as StdMutex;

static USER_AUTH_VAULT: Lazy<StdMutex<Option<Arc<UserAuthVault>>>> =
    Lazy::new(|| StdMutex::new(None));

pub fn init_user_auth_vault(data_dir: std::path::PathBuf) {
    let vault = UserAuthVault::new(data_dir);
    match USER_AUTH_VAULT.lock() {
        Ok(mut store) => *store = Some(Arc::new(vault)),
        Err(e) => log::error!("USER_AUTH_VAULT lock poisoned, cannot init vault: {}", e),
    }
}

pub fn get_user_auth_vault() -> Option<Arc<UserAuthVault>> {
    USER_AUTH_VAULT.lock().ok().and_then(|s| s.clone())
}
