//! 统一 KV 存储层（替代浏览器 localStorage/sessionStorage）。
//!
//! 两层存储：
//! - **敏感数据**（token、avatar selection）：`UserKvVault`，基于 `EncryptedVault`（AES-256-GCM）。
//! - **非敏感数据**（UI 偏好、桌面布局）：`UiPrefsStore`，明文 JSON KV（无 AES 开销）。
//!
//! 所有写入/删除操作会 emit `kv_changed` Tauri 事件，前端 `listen` 替代
//! `window.addEventListener('storage')`，实现跨 webview 同步。
//!
//! 设计参考 `auth_vault.rs` 的全局 Lazy + Arc 单例模式。

use ai00_x_core::infrastructure::storage::EncryptedVault;
use anyhow::Result;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

// ============================================================================
// 敏感数据存储（EncryptedVault）
// ============================================================================

const KV_VAULT_KEY_FILENAME: &str = ".user_kv_vault.key";
const KV_VAULT_FILENAME: &str = "user_kv_vault.json";

/// 敏感数据加密 KV（复用 EncryptedVault，独立文件，与 auth_vault 分离）。
pub struct UserKvVault {
    vault: EncryptedVault,
}

impl UserKvVault {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            vault: EncryptedVault::new(data_dir, KV_VAULT_KEY_FILENAME, KV_VAULT_FILENAME),
        }
    }

    pub async fn get(&self, key: &str) -> Result<Option<String>> {
        self.vault.load(key).await
    }

    pub async fn set(&self, key: &str, value: &str) -> Result<()> {
        self.vault.store(key, value).await
    }

    pub async fn remove(&self, key: &str) -> Result<()> {
        self.vault.remove(key).await
    }
}

static USER_KV_VAULT: Lazy<StdMutex<Option<Arc<UserKvVault>>>> = Lazy::new(|| StdMutex::new(None));

pub fn init_user_kv_vault(data_dir: PathBuf) {
    let vault = UserKvVault::new(data_dir);
    let mut store = USER_KV_VAULT.lock().expect("USER_KV_VAULT mutex poisoned");
    *store = Some(Arc::new(vault));
}

fn get_user_kv_vault() -> Option<Arc<UserKvVault>> {
    USER_KV_VAULT
        .lock()
        .expect("USER_KV_VAULT mutex poisoned")
        .clone()
}

// ============================================================================
// 非敏感数据存储（明文 JSON KV）
// ============================================================================

const UI_PREFS_FILENAME: &str = "ui_prefs.json";

/// 非敏感 UI 偏好明文 KV。每次读写无 AES 开销，适合频繁读写的 UI 状态。
pub struct UiPrefsStore {
    path: PathBuf,
    lock: Mutex<()>,
}

#[derive(Serialize, Deserialize, Default)]
struct PrefsFile {
    entries: HashMap<String, String>,
}

impl UiPrefsStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            path: data_dir.join(UI_PREFS_FILENAME),
            lock: Mutex::new(()),
        }
    }

    pub async fn get(&self, key: &str) -> Result<Option<String>> {
        let _g = self.lock.lock().await;
        if !self.path.exists() {
            return Ok(None);
        }
        let s = tokio::fs::read_to_string(&self.path)
            .await
            .unwrap_or_default();
        let file: PrefsFile = serde_json::from_str(&s).unwrap_or_default();
        Ok(file.entries.get(key).cloned())
    }

    pub async fn set(&self, key: &str, value: &str) -> Result<()> {
        let _g = self.lock.lock().await;
        let mut file: PrefsFile = if self.path.exists() {
            let s = tokio::fs::read_to_string(&self.path)
                .await
                .unwrap_or_default();
            serde_json::from_str(&s).unwrap_or_default()
        } else {
            PrefsFile::default()
        };
        file.entries.insert(key.to_string(), value.to_string());
        if let Some(p) = self.path.parent() {
            tokio::fs::create_dir_all(p).await?;
        }
        tokio::fs::write(&self.path, serde_json::to_string_pretty(&file)?).await?;
        Ok(())
    }

    pub async fn remove(&self, key: &str) -> Result<()> {
        let _g = self.lock.lock().await;
        if !self.path.exists() {
            return Ok(());
        }
        let s = tokio::fs::read_to_string(&self.path)
            .await
            .unwrap_or_default();
        let mut file: PrefsFile = serde_json::from_str(&s).unwrap_or_default();
        file.entries.remove(key);
        if file.entries.is_empty() {
            let _ = tokio::fs::remove_file(&self.path).await;
        } else {
            tokio::fs::write(&self.path, serde_json::to_string_pretty(&file)?).await?;
        }
        Ok(())
    }
}

static UI_PREFS: Lazy<StdMutex<Option<Arc<UiPrefsStore>>>> = Lazy::new(|| StdMutex::new(None));

pub fn init_ui_prefs(data_dir: PathBuf) {
    let store = UiPrefsStore::new(data_dir);
    let mut s = UI_PREFS.lock().expect("UI_PREFS mutex poisoned");
    *s = Some(Arc::new(store));
}

fn get_ui_prefs() -> Option<Arc<UiPrefsStore>> {
    UI_PREFS.lock().expect("UI_PREFS mutex poisoned").clone()
}

// ============================================================================
// kv_changed 事件（跨 webview 同步）
// ============================================================================

#[derive(Serialize, Clone)]
struct KvChangedPayload {
    /// "vault" 或 "pref"
    store: &'static str,
    key: String,
    /// None 表示已删除
    value: Option<String>,
}

fn emit_kv_changed(app: &AppHandle, store: &'static str, key: &str, value: Option<&str>) {
    let payload = KvChangedPayload {
        store,
        key: key.to_string(),
        value: value.map(|s| s.to_string()),
    };
    if let Err(e) = app.emit("kv_changed", payload) {
        log::warn!("Failed to emit kv_changed event: {}", e);
    }
}

// ============================================================================
// Tauri commands
// ============================================================================

/// 从敏感数据 vault 读取值。
#[tauri::command]
pub async fn vault_get(key: String) -> Result<Option<String>, String> {
    let Some(vault) = get_user_kv_vault() else {
        return Ok(None);
    };
    vault.get(&key).await.map_err(|e| e.to_string())
}

/// 向敏感数据 vault 写入值，并 emit kv_changed 事件。
#[tauri::command]
pub async fn vault_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let Some(vault) = get_user_kv_vault() else {
        return Err("user kv vault not initialized".into());
    };
    vault.set(&key, &value).await.map_err(|e| e.to_string())?;
    emit_kv_changed(&app, "vault", &key, Some(&value));
    Ok(())
}

/// 从敏感数据 vault 删除值，并 emit kv_changed 事件。
#[tauri::command]
pub async fn vault_remove(app: AppHandle, key: String) -> Result<(), String> {
    let Some(vault) = get_user_kv_vault() else {
        return Ok(());
    };
    vault.remove(&key).await.map_err(|e| e.to_string())?;
    emit_kv_changed(&app, "vault", &key, None);
    Ok(())
}

/// 从非敏感 UI 偏好读取值。
#[tauri::command]
pub async fn pref_get(key: String) -> Result<Option<String>, String> {
    let Some(prefs) = get_ui_prefs() else {
        return Ok(None);
    };
    prefs.get(&key).await.map_err(|e| e.to_string())
}

/// 向非敏感 UI 偏好写入值，并 emit kv_changed 事件。
#[tauri::command]
pub async fn pref_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let Some(prefs) = get_ui_prefs() else {
        return Err("ui prefs store not initialized".into());
    };
    prefs.set(&key, &value).await.map_err(|e| e.to_string())?;
    emit_kv_changed(&app, "pref", &key, Some(&value));
    Ok(())
}

/// 从非敏感 UI 偏好删除值，并 emit kv_changed 事件。
#[tauri::command]
pub async fn pref_remove(app: AppHandle, key: String) -> Result<(), String> {
    let Some(prefs) = get_ui_prefs() else {
        return Ok(());
    };
    prefs.remove(&key).await.map_err(|e| e.to_string())?;
    emit_kv_changed(&app, "pref", &key, None);
    Ok(())
}
