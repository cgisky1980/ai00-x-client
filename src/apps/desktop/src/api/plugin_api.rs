//! Desktop UI plugin system API (Hook-based).
//!
//! Plugin package: `.a00pkg` (zip) with root-level `manifest.json`
//! (GitHub archive zips with a single top-level dir are also accepted).
//! Install dir: `{data_dir}/Ai00-X/plugins/{id}/`.
//! Registry: `plugins/registry.json` stores disabled ids + install timestamps.
//!
//! Hook point registry is maintained in `参考/插件系统设计` docs; unknown hook
//! ids only produce a warning at install time (forward compatibility).

use anyhow::{anyhow, Context, Result};
use futures::StreamExt;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};
use tokio::fs;

use crate::api::app_state::AppState;
use ai00_x_core::infrastructure::ai::AIClient;
use ai00_x_core::util::types::Message;

/// Hook ids known to this client build (see docs for authoritative list).
const KNOWN_HOOKS: &[&str] = &[
    "app:startup",
    "app:shutdown",
    "overlay:mount",
    "overlay:island",
    "overlay:island-action",
    "overlay:panel",
    "overlay:menu",
    "media:lyrics",
    "media:visualizer",
    "media:now-playing",
    "media:controls",
    "underlay:widget",
    "underlay:mount",
    "underlay:shortcut",
    "sys:hotkey",
    "sys:click",
    "sys:scheduler",
    "sys:clipboard",
];

/// Hooks carried by a sandboxed iframe (all other known hooks use ESM modules).
const IFRAME_HOOKS: &[&str] = &["underlay:widget", "overlay:panel"];

/// Returns `Some(true)` when the hook is iframe-carried, `Some(false)` when
/// module-carried, `None` for unknown hooks.
fn hook_expects_iframe(hook_id: &str) -> Option<bool> {
    if !KNOWN_HOOKS.contains(&hook_id) {
        return None;
    }
    Some(IFRAME_HOOKS.contains(&hook_id))
}

/// Event emitted to all windows after install/uninstall/enable/disable.
pub const PLUGINS_CHANGED_EVENT: &str = "plugins-changed";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Hook entry configuration. The carrying form is decided by the hook id
/// (see `hook_expects_iframe`), NOT by the manifest — plugins only provide
/// the matching entry field:
/// - iframe-carried hooks: `path` (HTML entry, plus widget size fields)
/// - module-carried hooks: `module` (ESM entry)
///
/// `#[serde(untagged)]` discriminates by field and ignores unknown fields,
/// so legacy manifests with an explicit `"kind"` still parse.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HookConfig {
    /// Injected ESM module (path inside the package).
    Module {
        #[serde(rename = "module")]
        module: String,
    },
    /// Sandboxed iframe entry (HTML path inside the package).
    Iframe {
        #[serde(rename = "path")]
        path: String,
        #[serde(rename = "width", default = "default_widget_width")]
        width: u32,
        #[serde(rename = "height", default = "default_widget_height")]
        height: u32,
        #[serde(rename = "resizable", default = "default_true")]
        resizable: bool,
    },
}

fn default_widget_width() -> u32 {
    2
}

fn default_widget_height() -> u32 {
    2
}

fn default_true() -> bool {
    true
}

/// Plugin manifest (`manifest.json` at package root).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub min_ai00x_version: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub hooks: HashMap<String, HookConfig>,
}

/// Plugin info returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: PluginManifest,
    pub enabled: bool,
    pub installed_at: u64,
}

/// Persisted registry (`plugins/registry.json`).
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginRegistry {
    #[serde(default)]
    disabled: HashSet<String>,
    #[serde(default)]
    installed_at: HashMap<String, u64>,
    /// Whether one-time default-plugin seeding has already run.
    #[serde(default)]
    defaults_initialized: bool,
    /// Bundled default ids the user explicitly uninstalled — they must NOT
    /// come back on app upgrades. Distinguishes "user removed it" from
    /// "newly bundled plugin never seen before" (the latter installs even
    /// after first seeding).
    #[serde(default)]
    removed_defaults: HashSet<String>,
}

/// Payload for the `plugins-changed` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginsChangedPayload {
    action: String,
    plugin_id: String,
}

// ---------------------------------------------------------------------------
// Paths / registry helpers
// ---------------------------------------------------------------------------

/// Root plugins directory: `{data_dir}/Ai00-X/plugins`.
pub fn plugins_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Ai00-X")
        .join("plugins")
}

fn registry_path() -> PathBuf {
    plugins_dir().join("registry.json")
}

async fn read_registry() -> PluginRegistry {
    match fs::read_to_string(registry_path()).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            warn!("Failed to parse plugin registry, resetting: {}", e);
            PluginRegistry::default()
        }),
        Err(_) => PluginRegistry::default(),
    }
}

async fn write_registry(registry: &PluginRegistry) -> Result<()> {
    let dir = plugins_dir();
    fs::create_dir_all(&dir).await?;
    let content = serde_json::to_string_pretty(registry)?;
    fs::write(registry_path(), content).await?;
    Ok(())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Validate plugin id charset (also acts as path-traversal guard).
fn validate_plugin_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 {
        return Err(anyhow!("Plugin id must be 1-128 characters"));
    }
    if id.starts_with('.') {
        return Err(anyhow!("Plugin id must not start with '.'"));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(anyhow!("Plugin id may only contain [a-zA-Z0-9._-]: {}", id));
    }
    Ok(())
}

fn emit_plugins_changed(app: &AppHandle, action: &str, plugin_id: &str) {
    let payload = PluginsChangedPayload {
        action: action.to_string(),
        plugin_id: plugin_id.to_string(),
    };
    if let Err(e) = app.emit(PLUGINS_CHANGED_EVENT, payload) {
        warn!("Failed to emit {}: {}", PLUGINS_CHANGED_EVENT, e);
    }
}

// ---------------------------------------------------------------------------
// Zip handling
// ---------------------------------------------------------------------------

/// Read manifest.json from a zip archive.
///
/// Returns `(manifest_content, prefix)` where `prefix` is `Some("dir/")` for
/// GitHub archive zips that wrap everything in a single top-level directory.
fn read_manifest_from_zip(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Result<(String, Option<String>)> {
    // Root-level manifest first.
    if let Ok(mut entry) = archive.by_name("manifest.json") {
        let mut content = String::new();
        entry.read_to_string(&mut content)?;
        return Ok((content, None));
    }

    // GitHub archive layout: `{repo}-{ref}/manifest.json` (single top dir).
    let names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();
    let mut candidates: Vec<String> = names
        .into_iter()
        .filter(|n| n.ends_with("manifest.json") && n.matches('/').count() == 1)
        .collect();
    if candidates.len() == 1 {
        let name = candidates.remove(0);
        let prefix = name.trim_end_matches("manifest.json").to_string();
        let mut entry = archive.by_name(&name)?;
        let mut content = String::new();
        entry.read_to_string(&mut content)?;
        return Ok((content, Some(prefix)));
    }

    Err(anyhow!("manifest.json not found at package root"))
}

/// Extract zip entries into `dest`, optionally stripping `prefix`.
///
/// Includes a zip-slip guard: entries containing `..` components are skipped.
fn extract_zip_to(
    archive: &mut zip::ZipArchive<std::fs::File>,
    dest: &Path,
    prefix: Option<&str>,
) -> Result<()> {
    let names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();
    for name in names {
        let rel = match prefix {
            Some(p) => match name.strip_prefix(p) {
                Some(r) => r,
                None => continue,
            },
            None => name.as_str(),
        };
        if rel.is_empty() {
            continue;
        }
        let rel_path = Path::new(rel);
        if rel_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            warn!("Skipping suspicious zip entry: {}", name);
            continue;
        }
        let out_path = dest.join(rel_path);
        if out_path == dest {
            continue;
        }
        let mut entry = archive.by_name(&name)?;
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out = std::fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Core install/uninstall logic
// ---------------------------------------------------------------------------

async fn install_from_zip(app: &AppHandle, zip_path: &Path) -> Result<PluginInfo> {
    let file =
        std::fs::File::open(zip_path).with_context(|| format!("open {}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file).context("open zip archive")?;

    let (manifest_content, prefix) = read_manifest_from_zip(&mut archive)?;
    let manifest: PluginManifest =
        serde_json::from_str(&manifest_content).context("parse manifest.json")?;
    validate_plugin_id(&manifest.id)?;

    for (hook_id, hook_cfg) in &manifest.hooks {
        match hook_expects_iframe(hook_id) {
            None => {
                warn!(
                    "Plugin '{}' declares unknown hook '{}' (may need a newer client)",
                    manifest.id, hook_id
                );
            }
            Some(true) => {
                if !matches!(hook_cfg, HookConfig::Iframe { .. }) {
                    return Err(anyhow!(
                        "Hook '{}' expects an iframe entry (field 'path'), found a module entry",
                        hook_id
                    ));
                }
            }
            Some(false) => {
                if !matches!(hook_cfg, HookConfig::Module { .. }) {
                    return Err(anyhow!(
                        "Hook '{}' expects a module entry (field 'module'), found an iframe entry",
                        hook_id
                    ));
                }
            }
        }
    }

    let plugin_dir = plugins_dir().join(&manifest.id);
    if plugin_dir.exists() {
        return Err(anyhow!(
            "Plugin already installed: {} (uninstall it first)",
            manifest.id
        ));
    }
    fs::create_dir_all(&plugin_dir).await?;

    if let Err(e) = extract_zip_to(&mut archive, &plugin_dir, prefix.as_deref()) {
        let _ = fs::remove_dir_all(&plugin_dir).await;
        return Err(e.context("extract plugin package"));
    }

    let installed_at = now_millis();
    let mut registry = read_registry().await;
    registry.disabled.remove(&manifest.id);
    registry
        .installed_at
        .insert(manifest.id.clone(), installed_at);
    if let Err(e) = write_registry(&registry).await {
        let _ = fs::remove_dir_all(&plugin_dir).await;
        return Err(anyhow!("write plugin registry: {}", e));
    }

    let info = PluginInfo {
        manifest,
        enabled: true,
        installed_at,
    };
    info!(
        "Plugin installed: {} v{} ({})",
        info.manifest.name, info.manifest.version, info.manifest.id
    );
    emit_plugins_changed(app, "installed", &info.manifest.id);
    Ok(info)
}

// ---------------------------------------------------------------------------
// GitHub source resolution
// ---------------------------------------------------------------------------

/// Resolve a GitHub source (`owner/repo`, release asset URL, or repo archive
/// URL) into a direct download URL.
async fn resolve_github_url(source: &str) -> Result<String> {
    let s = source.trim().trim_end_matches('/');
    if s.starts_with("http://") || s.starts_with("https://") {
        if s.contains("github.com") {
            return Ok(s.to_string());
        }
        return Err(anyhow!("Only GitHub URLs are supported: {}", s));
    }

    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(anyhow!(
            "Invalid source: expected 'owner/repo' or a GitHub URL"
        ));
    }

    // owner/repo -> latest release -> first .a00pkg asset
    let api_url = format!("https://api.github.com/repos/{}/releases/latest", s);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let resp = client
        .get(&api_url)
        .header("User-Agent", "Ai00-X-Desktop")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .context("query GitHub releases API")?;
    match resp.status().as_u16() {
        404 => return Err(anyhow!("Repository or release not found: {}", s)),
        403 => {
            return Err(anyhow!(
                "GitHub API rate limit reached, try again later or use a direct URL"
            ))
        }
        code if !(200..300).contains(&code) => {
            return Err(anyhow!("GitHub API error: HTTP {}", code));
        }
        _ => {}
    }
    let json: serde_json::Value = resp.json().await.context("parse GitHub API response")?;
    let assets = json
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("Latest release has no assets: {}", s))?;
    for asset in assets {
        let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.ends_with(".a00pkg") {
            let url = asset
                .get("browser_download_url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("Asset missing download URL: {}", name))?;
            return Ok(url.to_string());
        }
    }
    Err(anyhow!("No .a00pkg asset found in latest release of {}", s))
}

// ---------------------------------------------------------------------------
// Bundled default plugins
//
// Official plugins embedded at compile time from the repo-root `plugins/`
// directory (single source of truth — `plugins/package.mjs` packages the
// same files). On startup each bundled plugin is:
//   - installed when missing (one-shot first-launch seeding via the
//     `defaultsInitialized` registry flag, so a later user uninstall is
//     respected and the plugin does not come back),
//   - refreshed in place when the bundled version is newer than the
//     installed one (app-managed upgrade: enabled/disabled state and
//     plugins-data are preserved).
// ---------------------------------------------------------------------------

/// One compile-time embedded plugin package.
struct BundledPlugin {
    /// `manifest.json` content (written verbatim; its `id` names the dir).
    manifest: &'static str,
    /// Remaining package files: (relative path, content).
    files: &'static [(&'static str, &'static str)],
}

/// Official default plugins shipped with the client.
/// (todo 已于 2026-08-25 从插件提升为 overlay 核心功能——React 重写于
/// web-ui `tools/todo/`，本地数据走 todo_api.rs，游戏化走服务器
/// member_xp_events。源码保留在 plugins/todo/ 供参考。)
const BUNDLED_PLUGINS: &[BundledPlugin] = &[BundledPlugin {
    manifest: include_str!("../../../../../../plugins/sticky-notes/manifest.json"),
    files: &[
        (
            "overlay.mjs",
            include_str!("../../../../../../plugins/sticky-notes/overlay.mjs"),
        ),
        (
            "island.mjs",
            include_str!("../../../../../../plugins/sticky-notes/island.mjs"),
        ),
    ],
}];

/// Default plugins retired from the bundle. Any installed copy is removed at
/// startup (files + registry entries) and recorded in `removed_defaults` so
/// the plugin is never resurrected. Uninstall does NOT touch plugins-data
/// (the one-time migration to core storage reads it afterwards).
const RETIRED_DEFAULT_PLUGINS: &[&str] = &["com.ai00x.todo"];

/// Core-feature ids exempt from the plugin gate (install/enabled checks) on
/// shared commands (`plugin_ai_complete` / `plugin_emit_event`). The todo
/// core is not a plugin anymore but still uses these channels for local
/// RWKV one-shots (问诊/拆解) and cross-layer garden milestones.
const CORE_FEATURE_IDS: &[&str] = &["com.ai00x.core.todo"];

/// Parse a dotted numeric version ("1.2.0"); `None` when any part is
/// non-numeric (e.g. pre-release suffixes).
fn parse_version(v: &str) -> Option<Vec<u64>> {
    v.split('.').map(|p| p.trim().parse::<u64>().ok()).collect()
}

/// Whether `new` is strictly newer than `old` (missing parts count as 0;
/// unparseable versions never compare as newer — conservative).
fn version_newer(new: &str, old: &str) -> bool {
    let (Some(a), Some(b)) = (parse_version(new), parse_version(old)) else {
        return false;
    };
    let len = a.len().max(b.len());
    for i in 0..len {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Write a bundled plugin's files into its install dir (the caller clears
/// any previous install first).
async fn write_bundled_plugin(bundled: &BundledPlugin, plugin_id: &str) -> Result<()> {
    let dir = plugins_dir().join(plugin_id);
    fs::create_dir_all(&dir).await?;
    fs::write(dir.join("manifest.json"), bundled.manifest).await?;
    for (name, content) in bundled.files {
        let rel = Path::new(name);
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(anyhow!("bundled plugin file escapes package dir: {}", name));
        }
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(&path, content).await?;
    }
    Ok(())
}

/// Seed/upgrade the bundled default plugins at startup (see section header
/// for the exact semantics). Never reinstalls a plugin the user uninstalled.
pub async fn ensure_default_plugins(app: &AppHandle) {
    let mut registry = read_registry().await;
    let mut changed: Vec<String> = Vec::new();
    let mut registry_dirty = false;

    // Retired defaults first: remove any installed copy so it disappears
    // even for users who never uninstalled it. plugins-data is NOT touched
    // (the todo-core one-time migration reads it afterwards).
    for id in RETIRED_DEFAULT_PLUGINS {
        let dir = plugins_dir().join(id);
        let mut touched = false;
        if dir.exists() {
            match fs::remove_dir_all(&dir).await {
                Ok(()) => touched = true,
                Err(e) => {
                    warn!("Failed to remove retired default plugin '{}': {}", id, e);
                    continue;
                }
            }
        }
        if !registry.removed_defaults.contains(*id) {
            registry.removed_defaults.insert((*id).to_string());
            touched = true;
        }
        if registry.installed_at.remove(*id).is_some() {
            touched = true;
        }
        registry.disabled.remove(*id);
        if touched {
            info!("Retired default plugin removed: {}", id);
            registry_dirty = true;
            emit_plugins_changed(app, "uninstalled", id);
        }
    }

    for bundled in BUNDLED_PLUGINS {
        let manifest = match serde_json::from_str::<PluginManifest>(bundled.manifest) {
            Ok(m) => m,
            Err(e) => {
                warn!("Skipping bundled plugin with invalid manifest: {}", e);
                continue;
            }
        };
        let dir = plugins_dir().join(&manifest.id);
        let fresh_install = if dir.exists() {
            // Installed: refresh only when the bundled version is newer (or
            // the installed manifest is unreadable/corrupt).
            let installed = fs::read_to_string(dir.join("manifest.json"))
                .await
                .ok()
                .and_then(|c| serde_json::from_str::<PluginManifest>(&c).ok());
            let needs_refresh = match &installed {
                Some(m) => version_newer(&manifest.version, &m.version),
                None => true,
            };
            if !needs_refresh {
                continue;
            }
            if let Err(e) = fs::remove_dir_all(&dir).await {
                warn!(
                    "Failed to clear '{}' for default-plugin upgrade: {}",
                    manifest.id, e
                );
                continue;
            }
            false
        } else if registry.removed_defaults.contains(&manifest.id) {
            // Explicitly uninstalled by the user — never resurrect.
            continue;
        } else {
            // Missing but never uninstalled: first seeding OR a newly
            // bundled plugin shipped in this app version.
            true
        };

        if let Err(e) = write_bundled_plugin(bundled, &manifest.id).await {
            warn!("Failed to install default plugin '{}': {}", manifest.id, e);
            continue;
        }
        registry.removed_defaults.remove(&manifest.id);
        registry
            .installed_at
            .insert(manifest.id.clone(), now_millis());
        if fresh_install {
            // Fresh installs start enabled; upgrades keep the user's choice.
            registry.disabled.remove(&manifest.id);
        }
        info!(
            "Default plugin ready: {} v{}",
            manifest.id, manifest.version
        );
        changed.push(manifest.id.clone());
    }

    if !changed.is_empty() || registry_dirty || !registry.defaults_initialized {
        registry.defaults_initialized = true;
        if let Err(e) = write_registry(&registry).await {
            warn!(
                "Failed to persist plugin registry after default seeding: {}",
                e
            );
        }
    }
    for id in &changed {
        emit_plugins_changed(app, "installed", id);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// List installed plugins (manifest + enabled + installedAt).
#[tauri::command]
pub async fn get_plugins() -> Result<Vec<PluginInfo>, String> {
    let dir = plugins_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let registry = read_registry().await;
    let mut entries = match fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(e) => return Err(format!("read plugins dir: {}", e)),
    };

    let mut result = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if id.starts_with('.') {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        let content = match fs::read_to_string(&manifest_path).await {
            Ok(c) => c,
            Err(e) => {
                warn!("Failed to read manifest for '{}': {}", id, e);
                continue;
            }
        };
        let manifest: PluginManifest = match serde_json::from_str(&content) {
            Ok(m) => m,
            Err(e) => {
                warn!("Failed to parse manifest for '{}': {}", id, e);
                continue;
            }
        };
        if manifest.id != id {
            warn!(
                "Plugin dir '{}' manifest id mismatch: {} (skipped)",
                id, manifest.id
            );
            continue;
        }
        result.push(PluginInfo {
            enabled: !registry.disabled.contains(id),
            installed_at: registry.installed_at.get(id).copied().unwrap_or(0),
            manifest,
        });
    }
    result.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    Ok(result)
}

/// Install a plugin from a local `.a00pkg` file.
#[tauri::command]
pub async fn install_plugin(app: AppHandle, package_path: String) -> Result<PluginInfo, String> {
    let path = PathBuf::from(&package_path);
    if path.extension().and_then(|e| e.to_str()) != Some("a00pkg") {
        return Err("Invalid plugin package (expected .a00pkg)".to_string());
    }
    install_from_zip(&app, &path)
        .await
        .map_err(|e| e.to_string())
}

/// Install a plugin from GitHub (`owner/repo`, release asset URL, or repo
/// archive URL).
#[tauri::command]
pub async fn install_plugin_from_github(
    app: AppHandle,
    source: String,
) -> Result<PluginInfo, String> {
    let url = resolve_github_url(&source)
        .await
        .map_err(|e| e.to_string())?;
    info!("Downloading plugin from GitHub: {}", url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("User-Agent", "Ai00-X-Desktop")
        .send()
        .await
        .map_err(|e| format!("download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    let tmp = std::env::temp_dir().join(format!("ai00x-plugin-{}.a00pkg", now_millis()));
    fs::write(&tmp, &bytes)
        .await
        .map_err(|e| format!("write temp package: {}", e))?;

    let result = install_from_zip(&app, &tmp).await;
    let _ = fs::remove_file(&tmp).await;
    result.map_err(|e| e.to_string())
}

/// Uninstall a plugin. The directory is renamed to `.trash-*` first (Windows
/// file-occupancy safety), then deleted in the background.
#[tauri::command]
pub async fn uninstall_plugin(app: AppHandle, plugin_id: String) -> Result<(), String> {
    let dir = plugins_dir().join(&plugin_id);
    if !dir.exists() {
        return Err(format!("Plugin not found: {}", plugin_id));
    }
    let trash = plugins_dir().join(format!(".trash-{}-{}", plugin_id, std::process::id()));
    fs::rename(&dir, &trash)
        .await
        .map_err(|e| format!("remove plugin dir: {}", e))?;
    tokio::spawn(async move {
        if let Err(e) = fs::remove_dir_all(&trash).await {
            warn!("Failed to delete trashed plugin dir: {}", e);
        }
    });

    let mut registry = read_registry().await;
    registry.disabled.remove(&plugin_id);
    registry.installed_at.remove(&plugin_id);
    // Uninstalling a bundled default opts out of future re-seeding (and of
    // bundled upgrades) — record it explicitly.
    if BUNDLED_PLUGINS.iter().any(|b| {
        serde_json::from_str::<PluginManifest>(b.manifest)
            .map(|m| m.id == plugin_id)
            .unwrap_or(false)
    }) {
        registry.removed_defaults.insert(plugin_id.clone());
    }
    write_registry(&registry)
        .await
        .map_err(|e| format!("write plugin registry: {}", e))?;

    info!("Plugin uninstalled: {}", plugin_id);
    emit_plugins_changed(&app, "uninstalled", &plugin_id);
    Ok(())
}

/// Enable or disable a plugin (hot-swap: frontend reacts to the event).
#[tauri::command]
pub async fn set_plugin_enabled(
    app: AppHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<(), String> {
    let dir = plugins_dir().join(&plugin_id);
    if !dir.exists() {
        return Err(format!("Plugin not found: {}", plugin_id));
    }
    let mut registry = read_registry().await;
    if enabled {
        registry.disabled.remove(&plugin_id);
    } else {
        registry.disabled.insert(plugin_id.clone());
    }
    write_registry(&registry)
        .await
        .map_err(|e| format!("write plugin registry: {}", e))?;

    let action = if enabled { "enabled" } else { "disabled" };
    info!("Plugin {}: {}", plugin_id, action);
    emit_plugins_changed(&app, action, &plugin_id);
    Ok(())
}

/// HTTP proxy for sandboxed iframe plugins (opaque origin cannot fetch
/// cross-origin directly).
#[tauri::command]
pub async fn proxy_http_request(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        other => return Err(format!("Unsupported method: {}", other)),
    };
    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            req = req.header(&k, &v);
        }
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let data = serde_json::from_str(&body).unwrap_or(serde_json::Value::String(body));
    Ok(serde_json::json!({ "status": status, "data": data }))
}

// ---------------------------------------------------------------------------
// Unified plugin data storage
//
// Per-plugin key-value persistence at
// `{data_dir}/Ai00-X/plugins-data/{plugin_id}/{key}.json`.
// Shared by both carrying forms: injected modules via `ctx.storage`, iframe
// plugins via the PluginWidget postMessage protocol. Uninstalling a plugin
// KEEPS its data (reinstall restores it).
// ---------------------------------------------------------------------------

/// Root plugin-data directory: `{data_dir}/Ai00-X/plugins-data`.
fn plugins_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Ai00-X")
        .join("plugins-data")
}

/// Validate a storage key: `[a-zA-Z0-9._-]{1,64}` (path-traversal guard).
fn validate_storage_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > 64 {
        return Err(anyhow!("Storage key must be 1-64 characters"));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(anyhow!(
            "Storage key may only contain [a-zA-Z0-9._-]: {}",
            key
        ));
    }
    Ok(())
}

fn plugin_data_path(plugin_id: &str, key: &str) -> Result<PathBuf> {
    validate_plugin_id(plugin_id)?;
    validate_storage_key(key)?;
    Ok(plugins_data_dir()
        .join(plugin_id)
        .join(format!("{}.json", key)))
}

/// Read a plugin data value; `None` when the key does not exist.
#[tauri::command]
pub async fn plugin_data_get(
    plugin_id: String,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    let path = plugin_data_path(&plugin_id, &key).map_err(|e| e.to_string())?;
    match fs::read_to_string(&path).await {
        Ok(content) => {
            let value: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("corrupt data file '{}': {}", key, e))?;
            Ok(Some(value))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read data '{}': {}", key, e)),
    }
}

/// Write a plugin data value (creates the plugin directory on demand).
#[tauri::command]
pub async fn plugin_data_set(
    plugin_id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let path = plugin_data_path(&plugin_id, &key).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create data dir: {}", e))?;
    }
    let content = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&path, content)
        .await
        .map_err(|e| format!("write data '{}': {}", key, e))?;
    Ok(())
}

/// Remove a plugin data value (missing key is a no-op).
#[tauri::command]
pub async fn plugin_data_remove(plugin_id: String, key: String) -> Result<(), String> {
    let path = plugin_data_path(&plugin_id, &key).map_err(|e| e.to_string())?;
    match fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove data '{}': {}", key, e)),
    }
}

/// List all storage keys of a plugin.
#[tauri::command]
pub async fn plugin_data_keys(plugin_id: String) -> Result<Vec<String>, String> {
    validate_plugin_id(&plugin_id).map_err(|e| e.to_string())?;
    let dir = plugins_data_dir().join(&plugin_id);
    let mut keys = Vec::new();
    let mut entries = match fs::read_dir(&dir).await {
        Ok(e) => e,
        // Missing dir = no data yet.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(keys),
        Err(e) => return Err(format!("read data dir: {}", e)),
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                keys.push(stem.to_string());
            }
        }
    }
    keys.sort();
    Ok(keys)
}

/// Clear all stored data of a plugin.
#[tauri::command]
pub async fn plugin_data_clear(plugin_id: String) -> Result<(), String> {
    validate_plugin_id(&plugin_id).map_err(|e| e.to_string())?;
    let dir = plugins_data_dir().join(&plugin_id);
    match fs::remove_dir_all(&dir).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("clear data dir: {}", e)),
    }
}

// ---------------------------------------------------------------------------
// Plugin AI channel
//
// Non-streaming AI completion for module plugins (module plugins are
// same-origin full-trust and could technically invoke any command; this
// dedicated command is the FIRST AI path for plugins and adds an explicit
// gate + per-plugin rate limit that raw passthrough would not have).
// Mirrors miniapp_api::miniapp_ai_complete (AIClientFactory, non-streaming
// aggregation) but is keyed by plugin id + enabled state instead of MiniApp
// permissions.
// ---------------------------------------------------------------------------

/// Default AI requests per minute per plugin (covers capture bursts).
const PLUGIN_AI_RATE_LIMIT_PER_MINUTE: u32 = 12;

/// Rate limiter state: plugin_id -> (count, window_start_ms).
static PLUGIN_AI_RATE_LIMITER: OnceLock<Mutex<HashMap<String, (u32, u64)>>> = OnceLock::new();

fn plugin_ai_rate_limiter() -> &'static Mutex<HashMap<String, (u32, u64)>> {
    PLUGIN_AI_RATE_LIMITER.get_or_init(|| Mutex::new(HashMap::new()))
}

fn plugin_ai_check_rate_limit(plugin_id: &str) -> Result<(), String> {
    let now = now_millis();
    let window_ms: u64 = 60_000;
    let mut map = plugin_ai_rate_limiter()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let entry = map.entry(plugin_id.to_string()).or_insert((0, now));
    if now - entry.1 >= window_ms {
        *entry = (1, now);
    } else {
        entry.0 += 1;
        if entry.0 > PLUGIN_AI_RATE_LIMIT_PER_MINUTE {
            return Err(format!(
                "Plugin AI rate limit exceeded: max {} requests/minute",
                PLUGIN_AI_RATE_LIMIT_PER_MINUTE
            ));
        }
    }
    Ok(())
}

/// Request DTO for `plugin_ai_complete`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAiCompleteRequest {
    pub plugin_id: String,
    pub prompt: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Model reference ("primary" / "fast" / specific id). Defaults to the
    /// plugin func-agent slot (`ai.func_agent_models.plugin`), which itself
    /// defaults to the local RWKV model (`rwkv-local`).
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub top_p: Option<f64>,
}

/// Response DTO for `plugin_ai_complete`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAiCompleteResponse {
    pub text: String,
    pub usage: Option<PluginAiUsage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAiUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// Verify the plugin is installed and enabled (disabled plugins lose AI
/// access along with everything else). Core-feature ids (CORE_FEATURE_IDS)
/// bypass the install/enabled gate — they are not plugins but reuse these
/// shared channels (local RWKV one-shots / cross-layer events).
async fn plugin_ai_gate(plugin_id: &str) -> Result<(), String> {
    validate_plugin_id(plugin_id).map_err(|e| e.to_string())?;
    if CORE_FEATURE_IDS.contains(&plugin_id) {
        return Ok(());
    }
    if !plugins_dir().join(plugin_id).exists() {
        return Err(format!("Plugin not found: {}", plugin_id));
    }
    let registry = read_registry().await;
    if registry.disabled.contains(plugin_id) {
        return Err(format!("Plugin is disabled: {}", plugin_id));
    }
    Ok(())
}

/// Consume an AI stream into (full_text, usage) for plugin completions.
async fn plugin_ai_run(
    ai_client: &Arc<AIClient>,
    messages: Vec<Message>,
) -> Result<(String, Option<PluginAiUsage>), String> {
    let stream_response = ai_client
        .send_message_stream(messages, None)
        .await
        .map_err(|e| format!("AI request failed: {}", e))?;

    let mut stream = stream_response.stream;
    let mut full_text = String::new();
    let mut usage: Option<PluginAiUsage> = None;
    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                if let Some(text) = chunk.text {
                    full_text.push_str(&text);
                }
                if let Some(u) = chunk.usage {
                    usage = Some(PluginAiUsage {
                        prompt_tokens: u.prompt_token_count,
                        completion_tokens: u.candidates_token_count,
                        total_tokens: u.total_token_count,
                    });
                }
            }
            Err(e) => return Err(format!("AI stream error: {}", e)),
        }
    }
    Ok((full_text, usage))
}

/// Apply per-request sampling overrides (plugin-provided temperature/topP/maxTokens).
fn plugin_ai_with_overrides(
    client: Arc<AIClient>,
    temperature: Option<f64>,
    top_p: Option<f64>,
    max_tokens: Option<u32>,
) -> Arc<AIClient> {
    let mut c = client;
    if let Some(t) = temperature {
        c = Arc::new(c.with_temperature(t));
    }
    if let Some(p) = top_p {
        c = Arc::new(c.with_top_p(p));
    }
    if let Some(m) = max_tokens {
        c = Arc::new(c.with_max_tokens(m));
    }
    c
}

/// Non-streaming AI completion for plugins (see section header).
///
/// Model priority: explicit `request.model` > user-configured plugin
/// func-agent slot (`ai.func_agent_models.plugin` / `ai.agent_models.plugin`)
/// > local RWKV (`rwkv-local`). When no explicit model was requested and the
/// default (local) path fails — e.g. the RWKV engine is not loaded — fall
/// back to the primary model so plugin AI keeps working (优先本地，本地不可
/// 用时回退主模型).
#[tauri::command]
pub async fn plugin_ai_complete(
    state: State<'_, AppState>,
    request: PluginAiCompleteRequest,
) -> Result<PluginAiCompleteResponse, String> {
    if request.prompt.trim().is_empty() {
        return Err("prompt must not be empty".to_string());
    }
    plugin_ai_gate(&request.plugin_id).await?;
    plugin_ai_check_rate_limit(&request.plugin_id)?;

    let has_explicit_model = request.model.is_some();
    let ai_client = if let Some(model_ref) = request.model.as_deref() {
        state.ai_client_factory.get_client_resolved(model_ref).await
    } else {
        state
            .ai_client_factory
            .get_client_by_func_agent("plugin")
            .await
    }
    .map_err(|e| format!("Failed to get AI client: {}", e))?;

    let ai_client = plugin_ai_with_overrides(
        ai_client,
        request.temperature,
        request.top_p,
        request.max_tokens,
    );

    let mut messages = Vec::new();
    if let Some(sp) = request.system_prompt.as_deref() {
        if !sp.is_empty() {
            messages.push(Message::system(sp.to_string()));
        }
    }
    messages.push(Message::user(request.prompt.clone()));

    let run = plugin_ai_run(&ai_client, messages.clone()).await;
    let (full_text, usage) = match run {
        Ok(r) => r,
        Err(e) => {
            if has_explicit_model {
                return Err(e);
            }
            warn!(
                "[plugin-ai] plugin model failed, falling back to primary: {}",
                e
            );
            let fallback = state
                .ai_client_factory
                .get_client_resolved("primary")
                .await
                .map_err(|e2| format!("{} (primary fallback: {})", e, e2))?;
            let fallback = plugin_ai_with_overrides(
                fallback,
                request.temperature,
                request.top_p,
                request.max_tokens,
            );
            plugin_ai_run(&fallback, messages).await?
        }
    };

    Ok(PluginAiCompleteResponse {
        text: full_text,
        usage,
    })
}

/// Emit a namespaced milestone event to ALL windows (cross-layer bridge —
/// e.g. the todo plugin broadcasts `plugin://com.ai00x.todo/badge-unlocked`
/// and the underlay garden layer listens for it).
///
/// Gate: the plugin must be installed + enabled (same as AI access). The
/// event name is restricted to `[a-zA-Z0-9_-]{1,64}` and always prefixed
/// with `plugin://{plugin_id}/` so plugins cannot spoof host event names.
#[tauri::command]
pub async fn plugin_emit_event(
    app: AppHandle,
    plugin_id: String,
    name: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    plugin_ai_gate(&plugin_id).await?;
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid event name (allowed: [a-zA-Z0-9_-], 1-64 chars)".to_string());
    }
    let event = format!("plugin://{}/{}", plugin_id, name);
    app.emit(&event, payload).map_err(|e| e.to_string())
}

/// Absolute path of a plugin's data directory
/// (`{data_dir}/Ai00-X/plugins-data/{plugin_id}`).
///
/// Used by plugins that own agent sessions (todo「待办助理」): the path is
/// passed as the session workspace so agent Read/Write tool access stays
/// scoped to the plugin's own data directory.
#[tauri::command]
pub async fn plugin_data_dir(plugin_id: String) -> Result<String, String> {
    validate_plugin_id(&plugin_id).map_err(|e| e.to_string())?;
    Ok(plugins_data_dir()
        .join(&plugin_id)
        .to_string_lossy()
        .into_owned())
}
