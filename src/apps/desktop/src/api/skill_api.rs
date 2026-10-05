//! Skill 管理 API —— dsh 引擎技能目录的桌面侧管理面。
//!
//! 技能的发现与加载本体在 dsh 引擎（`dsh-skill`/`dsh-skill-filesystem`/`dsh-tool-skill`，
//! 目录热更新，无需刷新注册表）；本模块只做三件事：
//! 1. 按引擎相同的根约定扫描并列出技能（UI 目录）；
//! 2. 从本地路径安装 / 按 key 删除技能目录；
//! 3. skills.sh 市场检索与安装（`npx skills add -a universal` 装入
//!    `<ws>/.agents/skills` 或 `~/.agents/skills`，两处引擎均原生发现）。
//!
//! 引擎根约定（rank 小者优先，同名就近遮蔽）：
//!   - project: `<ws>/.dsh/skills`(100)、`<ws>/.agents/skills`(200)
//!   - user:    `<DSH_HOME>/skills`(400)
//!   - bundled: `<DSH_HOME>/bundled-skills`(600，经编排补丁 bundledSkillDir 注入，
//!     由 [`ensure_bundled_skills_installed`] 从内嵌资源同步，只读语义)

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

use ai00_x_core::service::remote_ssh::workspace_state::is_remote_path;
use ai00_x_core::service::runtime::RuntimeManager;
use ai00_x_core::util::process_manager::create_tokio_command;
use include_dir::{include_dir, Dir};
use log::{debug, info};
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio::task::JoinSet;
use tokio::time::{timeout, Duration};

use crate::dsh_manager::dsh_home;

/// 内嵌内置技能（core 源树随编译嵌入，dev / fast build / 安装包三态一致）。
pub static BUILTIN_SKILLS_DIR: Dir<'_> =
    include_dir!("$CARGO_MANIFEST_DIR/../../../src/crates/core/builtin_skills");

// ---------------------------------------------------------------------------
// 类型（与 web-ui infrastructure/config/types 的 SkillInfo 等保持 camelCase 对齐）
// ---------------------------------------------------------------------------

/// `key` = `{level}::{slot}::{dirName}`，删除时按 key 反查路径。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfoDto {
    pub key: String,
    pub name: String,
    pub description: String,
    pub path: String,
    /// "user" | "project"
    pub level: String,
    pub source_slot: String,
    pub dir_name: String,
    pub is_builtin: bool,
    pub group_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillValidationResult {
    pub valid: bool,
    pub name: Option<String>,
    pub description: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub installs: u64,
    pub url: String,
    pub install_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct SkillSearchApiResponse {
    #[serde(default)]
    skills: Vec<SkillSearchApiItem>,
}

#[derive(Debug, Clone, Deserialize)]
struct SkillSearchApiItem {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    installs: u64,
}

// ---------------------------------------------------------------------------
// 根约定与扫描
// ---------------------------------------------------------------------------

struct SkillRoot {
    path: PathBuf,
    level: &'static str,
    slot: &'static str,
    is_builtin: bool,
}

/// 与引擎 dsh-skill-filesystem 对齐的根清单（优先级降序）。
/// `workspace_path` 为远端路径时跳过 project 根（引擎侧远端工作区技能暂不接）。
async fn skill_roots(workspace_path: Option<&Path>) -> Vec<SkillRoot> {
    let mut roots = Vec::new();
    let ws = workspace_path
        .map(Path::to_string_lossy)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    if let Some(ws) = ws {
        if !is_remote_path(&ws.to_string_lossy()).await {
            roots.push(SkillRoot {
                path: ws.join(".dsh").join("skills"),
                level: "project",
                slot: "project-dsh",
                is_builtin: false,
            });
            roots.push(SkillRoot {
                path: ws.join(".agents").join("skills"),
                level: "project",
                slot: "project-agents",
                is_builtin: false,
            });
        }
    }
    roots.push(SkillRoot {
        path: dsh_home().join("skills"),
        level: "user",
        slot: "user-dsh",
        is_builtin: false,
    });
    roots.push(SkillRoot {
        path: dsh_home().join("bundled-skills"),
        level: "user",
        slot: "builtin",
        is_builtin: true,
    });
    roots
}

/// 旧内置分组（docx/pdf/pptx/xlsx → office 等），UI 分组展示用。
fn builtin_group_key(dir_name: &str) -> Option<&'static str> {
    match dir_name {
        "docx" | "pdf" | "pptx" | "xlsx" => Some("office"),
        "find-skills" | "writing-skills" => Some("meta"),
        "agent-browser" => Some("computer-use"),
        _ if dir_name.starts_with("gstack-") => Some("team"),
        _ => None,
    }
}

/// 解析 SKILL.md 的 YAML frontmatter（容忍引号/多余字段；解析失败视为无名技能跳过）。
fn parse_skill_frontmatter(content: &str) -> Option<(String, String)> {
    let trimmed = content.trim_start();
    let rest = trimmed.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let frontmatter = &rest[..end];

    let mut name = None;
    let mut description = None;
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let mut value = value.trim();
        // 去成对包裹引号（引擎侧 YAML 语义，这里只做展示级解析）
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = &value[1..value.len() - 1];
        }
        // Block scalar（description: |- 等）取不到单行值，跳过交给缺省
        if value == "|" || value == ">" || value == "|-" || value == ">-" {
            continue;
        }
        match key {
            "name" if name.is_none() && !value.is_empty() => name = Some(value.to_string()),
            "description" if description.is_none() && !value.is_empty() => {
                description = Some(value.to_string())
            }
            _ => {}
        }
    }
    Some((name?, description.unwrap_or_default()))
}

async fn scan_root(root: &SkillRoot) -> Vec<SkillInfoDto> {
    let mut out = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(&root.path).await else {
        return out;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if dir_name.starts_with('.') {
            continue;
        }
        // 目录束 <name>/SKILL.md
        let skill_md = entry.path().join("SKILL.md");
        let content = match tokio::fs::read_to_string(&skill_md).await {
            Ok(c) => c,
            Err(_) => continue,
        };
        let Some((name, description)) = parse_skill_frontmatter(&content) else {
            debug!(
                "[SkillApi] skip skill without usable frontmatter: {}",
                skill_md.display()
            );
            continue;
        };
        let group_key = if root.is_builtin {
            builtin_group_key(&dir_name).map(str::to_string)
        } else {
            None
        };
        out.push(SkillInfoDto {
            key: format!("{}::{}::{}", root.level, root.slot, dir_name),
            name,
            description,
            path: entry.path().to_string_lossy().to_string(),
            level: root.level.to_string(),
            source_slot: root.slot.to_string(),
            dir_name,
            is_builtin: root.is_builtin,
            group_key,
        });
    }
    out
}

/// 按引擎优先级扫描全部根，同名技能高优先级根遮蔽低优先级（与引擎 first-wins 对齐）。
async fn scan_all_skills(workspace_path: Option<&Path>) -> Vec<SkillInfoDto> {
    let roots = skill_roots(workspace_path).await;
    let mut merged: Vec<SkillInfoDto> = Vec::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    for root in &roots {
        for skill in scan_root(root).await {
            if seen_names.insert(skill.name.clone()) {
                merged.push(skill);
            }
        }
    }
    merged
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 列出技能（引擎会热加载目录，forceRefresh 仅为兼容前端的 no-op）。
#[tauri::command]
pub async fn get_skill_configs(
    _force_refresh: Option<bool>,
    workspace_path: Option<String>,
) -> Result<Vec<SkillInfoDto>, String> {
    Ok(scan_all_skills(workspace_path.as_deref().map(Path::new)).await)
}

/// 校验一个待安装的技能目录（存在 + 含可解析的 SKILL.md）。
#[tauri::command]
pub async fn validate_skill_path(path: String) -> Result<SkillValidationResult, String> {
    let skill_path = Path::new(&path);
    if !skill_path.exists() {
        return Ok(SkillValidationResult {
            valid: false,
            name: None,
            description: None,
            error: Some("Path does not exist".to_string()),
        });
    }
    if !skill_path.is_dir() {
        return Ok(SkillValidationResult {
            valid: false,
            name: None,
            description: None,
            error: Some("Path is not a directory".to_string()),
        });
    }
    let skill_md_path = skill_path.join("SKILL.md");
    if !skill_md_path.exists() {
        return Ok(SkillValidationResult {
            valid: false,
            name: None,
            description: None,
            error: Some("Directory is missing SKILL.md file".to_string()),
        });
    }
    match tokio::fs::read_to_string(&skill_md_path).await {
        Ok(content) => match parse_skill_frontmatter(&content) {
            Some((name, description)) => Ok(SkillValidationResult {
                valid: true,
                name: Some(name),
                description: Some(description),
                error: None,
            }),
            None => Ok(SkillValidationResult {
                valid: false,
                name: None,
                description: None,
                error: Some("SKILL.md frontmatter missing name".to_string()),
            }),
        },
        Err(e) => Ok(SkillValidationResult {
            valid: false,
            name: None,
            description: None,
            error: Some(format!("Failed to read SKILL.md: {}", e)),
        }),
    }
}

/// 安装技能：user → `<DSH_HOME>/skills`；project → `<ws>/.agents/skills`
/// （引擎 rank 200 原生发现，目录热更新，装完即生效）。
#[tauri::command]
pub async fn add_skill(
    source_path: String,
    level: String,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let validation = validate_skill_path(source_path.clone()).await?;
    if !validation.valid {
        return Err(validation
            .error
            .unwrap_or_else(|| "Invalid skill path".to_string()));
    }
    let skill_name = validation
        .name
        .as_ref()
        .ok_or_else(|| "Skill name missing after validation".to_string())?;
    let source = Path::new(&source_path);

    let target_dir = if level == "project" {
        let ws = workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "No workspace open, cannot add project-level Skill".to_string())?;
        if is_remote_path(ws).await {
            return Err(
                "Installing project skills into remote workspaces is not supported yet".to_string(),
            );
        }
        PathBuf::from(ws).join(".agents").join("skills")
    } else {
        dsh_home().join("skills")
    };

    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| format!("Failed to create skills directory: {}", e))?;

    let folder_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Unable to get folder name".to_string())?;
    let target_path = target_dir.join(folder_name);
    if target_path.exists() {
        return Err(format!(
            "Skill '{}' already exists in {} level directory",
            folder_name,
            if level == "project" {
                "project"
            } else {
                "user"
            }
        ));
    }

    copy_dir_all(source, &target_path)
        .await
        .map_err(|e| format!("Failed to copy skill folder: {}", e))?;

    info!(
        "[SkillApi] skill added: name={}, level={}, path={}",
        skill_name,
        level,
        target_path.display()
    );
    Ok(format!("Skill '{}' added successfully", skill_name))
}

/// 按 key 删除技能（builtin 根拒绝删除；目录删除后引擎热更新自动移出目录）。
#[tauri::command]
pub async fn delete_skill(
    skill_key: String,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let skills = scan_all_skills(workspace_path.as_deref().map(Path::new)).await;
    let skill = skills
        .iter()
        .find(|s| s.key == skill_key)
        .ok_or_else(|| format!("Skill '{}' not found", skill_key))?;
    if skill.is_builtin {
        return Err(format!(
            "Skill '{}' is built-in and cannot be deleted",
            skill.name
        ));
    }
    let path = PathBuf::from(&skill.path);
    if path.exists() {
        tokio::fs::remove_dir_all(&path)
            .await
            .map_err(|e| format!("Failed to delete skill folder: {}", e))?;
    }
    info!(
        "[SkillApi] skill deleted: key={}, path={}",
        skill_key,
        path.display()
    );
    Ok(format!("Skill '{}' deleted successfully", skill.name))
}

async fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dst).await?;
    let mut entries = tokio::fs::read_dir(src).await?;
    while let Some(entry) = entries.next_entry().await? {
        let ty = entry.file_type().await?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            Box::pin(copy_dir_all(&entry.path(), &dst_path)).await?;
        } else {
            tokio::fs::copy(entry.path(), &dst_path).await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 内置技能同步（内嵌资源 → <DSH_HOME>/bundled-skills，编排补丁 bundledSkillDir 指向）
// ---------------------------------------------------------------------------

/// 启动时同步内置技能到 bundled 根（幂等：内容一致跳过，内置更新可随版本传播）。
pub async fn ensure_bundled_skills_installed() -> Result<(), String> {
    let dest_root = dsh_home().join("bundled-skills");
    tokio::fs::create_dir_all(&dest_root)
        .await
        .map_err(|e| format!("create bundled skills root: {e}"))?;

    let mut installed = 0usize;
    let mut updated = 0usize;
    for dir in BUILTIN_SKILLS_DIR.dirs() {
        // 只同步单层技能目录（<name>/SKILL.md），根目录散文件（LICENSE 等）跳过
        if !dir_has_direct_file(dir, "SKILL.md") {
            continue;
        }
        let mut files = Vec::new();
        collect_files(dir, &mut files);
        for file in files {
            let dest_path = dest_root.join(file.path());
            let desired = file.contents();
            if let Ok(current) = tokio::fs::read(&dest_path).await {
                if current == desired {
                    continue;
                }
                updated += 1;
            } else {
                installed += 1;
            }
            if let Some(parent) = dest_path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| format!("mkdir bundled skill parent: {e}"))?;
            }
            tokio::fs::write(&dest_path, desired)
                .await
                .map_err(|e| format!("write bundled skill file: {e}"))?;
        }
    }
    if installed > 0 || updated > 0 {
        info!(
            "[SkillApi] bundled skills synced: installed={}, updated={}, root={}",
            installed,
            updated,
            dest_root.display()
        );
    }
    Ok(())
}

fn collect_files<'a>(dir: &'a Dir<'a>, out: &mut Vec<&'a include_dir::File<'a>>) {
    for file in dir.files() {
        out.push(file);
    }
    for sub in dir.dirs() {
        collect_files(sub, out);
    }
}

/// include_dir 无「直属于该目录」的查询 API——用路径父级判断。
fn dir_has_direct_file(dir: &Dir<'_>, file_name: &str) -> bool {
    dir.files().any(|f| {
        f.path()
            .file_name()
            .is_some_and(|n| n.to_string_lossy() == file_name)
            && f.path().parent() == Some(dir.path())
    })
}

// ---------------------------------------------------------------------------
// 技能市场（skills.sh 检索 + npx skills 安装；安装目标 .agents/skills 引擎原生发现）
// ---------------------------------------------------------------------------

const SKILLS_SEARCH_API_BASE: &str = "https://skills.sh";
const DEFAULT_MARKET_QUERY: &str = "skill";
const DEFAULT_MARKET_LIMIT: u32 = 12;
const MAX_MARKET_LIMIT: u32 = 500;
const MAX_OUTPUT_PREVIEW_CHARS: usize = 2000;
const MARKET_DESC_FETCH_TIMEOUT_SECS: u64 = 4;
const MARKET_DESC_FETCH_CONCURRENCY: usize = 6;
const MARKET_DESC_MAX_LEN: usize = 220;

static MARKET_DESCRIPTION_CACHE: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketListRequest {
    pub query: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketSearchRequest {
    pub query: String,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketDownloadRequest {
    pub package: String,
    /// "user" | "project"（缺省 project）
    pub level: Option<String>,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketDownloadResponse {
    pub package: String,
    pub level: String,
    pub installed_skills: Vec<String>,
    pub output: String,
}

#[tauri::command]
pub async fn list_skill_market(
    request: SkillMarketListRequest,
) -> Result<Vec<SkillMarketItem>, String> {
    let query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(DEFAULT_MARKET_QUERY);
    fetch_skill_market(query, normalize_market_limit(request.limit)).await
}

#[tauri::command]
pub async fn search_skill_market(
    request: SkillMarketSearchRequest,
) -> Result<Vec<SkillMarketItem>, String> {
    let query = request.query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    fetch_skill_market(query, normalize_market_limit(request.limit)).await
}

#[tauri::command]
pub async fn download_skill_market(
    request: SkillMarketDownloadRequest,
) -> Result<SkillMarketDownloadResponse, String> {
    let package = request.package.trim().to_string();
    if package.is_empty() {
        return Err("Skill package cannot be empty".to_string());
    }
    let level = match request.level.as_deref() {
        Some("user") => "user",
        _ => "project",
    };

    let workspace_path = if level == "project" {
        let path = request
            .workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "No workspace open, cannot add project-level Skill".to_string())?;
        if is_remote_path(path).await {
            return Err(
                "Downloading project skills into remote workspaces is not supported yet"
                    .to_string(),
            );
        }
        Some(PathBuf::from(path))
    } else {
        None
    };

    // 安装前后各扫一遍（只扫安装会落地的 user + project 根）做差集
    let before: HashSet<String> = scan_all_skills(workspace_path.as_deref().map(Path::new))
        .await
        .into_iter()
        .map(|s| s.name)
        .collect();

    let runtime_manager = RuntimeManager::new().map_err(|e| e.to_string())?;
    let resolved_npx = runtime_manager.resolve_command("npx").ok_or_else(|| {
        "Command 'npx' is not available. Install Node.js or configure Ai00-X runtimes.".to_string()
    })?;

    let mut command = create_tokio_command(&resolved_npx.command);
    command
        .arg("-y")
        .arg("skills")
        .arg("add")
        .arg(&package)
        .arg("-y")
        .arg("-a")
        .arg("universal");
    if level == "user" {
        command.arg("-g");
    }
    if let Some(path) = workspace_path.as_ref() {
        command.current_dir(path);
    }
    let current_path = std::env::var("PATH").ok();
    if let Some(merged_path) = runtime_manager.merged_path_env(current_path.as_deref()) {
        command.env("PATH", &merged_path);
        #[cfg(windows)]
        command.env("Path", &merged_path);
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let output = command
        .output()
        .await
        .map_err(|e| format!("Failed to execute skills installer: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        let exit_code = output.status.code().unwrap_or(-1);
        let detail = if !stderr.trim().is_empty() {
            truncate_preview(stderr.trim())
        } else if !stdout.trim().is_empty() {
            truncate_preview(stdout.trim())
        } else {
            "Unknown installer error".to_string()
        };
        return Err(format!(
            "Failed to download skill package '{}' (exit code {}): {}",
            package, exit_code, detail
        ));
    }

    let mut installed_skills: Vec<String> =
        scan_all_skills(workspace_path.as_deref().map(Path::new))
            .await
            .into_iter()
            .map(|s| s.name)
            .filter(|name| !before.contains(name))
            .collect();
    installed_skills.sort();
    installed_skills.dedup();

    info!(
        "[SkillApi] market download completed: package={}, level={}, installed_count={}",
        package,
        level,
        installed_skills.len()
    );

    Ok(SkillMarketDownloadResponse {
        package,
        level: level.to_string(),
        installed_skills,
        output: summarize_command_output(&stdout, &stderr),
    })
}

fn normalize_market_limit(value: Option<u32>) -> u32 {
    value
        .unwrap_or(DEFAULT_MARKET_LIMIT)
        .clamp(1, MAX_MARKET_LIMIT)
}

async fn fetch_skill_market(query: &str, limit: u32) -> Result<Vec<SkillMarketItem>, String> {
    let api_base =
        std::env::var("SKILLS_API_URL").unwrap_or_else(|_| SKILLS_SEARCH_API_BASE.into());
    let base_url = api_base.trim_end_matches('/');
    let endpoint = format!("{}/api/search", base_url);

    let client = Client::new();
    let limit_str = limit.to_string();
    let response = client
        .get(&endpoint)
        .query(&[("q", query), ("limit", limit_str.as_str())])
        .send()
        .await
        .map_err(|e| format!("Failed to query skill market: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Skill market request failed with status {}",
            response.status()
        ));
    }

    let payload: SkillSearchApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to decode skill market response: {}", e))?;

    let mut seen_install_ids: HashSet<String> = HashSet::new();
    let mut items = Vec::new();
    for raw in payload.skills {
        let source = raw.source.trim().to_string();
        let install_id = if source.is_empty() {
            if raw.id.contains('@') {
                raw.id.clone()
            } else {
                format!("{}@{}", raw.id, raw.name)
            }
        } else {
            format!("{}@{}", source, raw.name)
        };
        if !seen_install_ids.insert(install_id.clone()) {
            continue;
        }
        items.push(SkillMarketItem {
            id: raw.id.clone(),
            name: raw.name,
            description: raw.description,
            source,
            installs: raw.installs,
            url: format!("{}/{}", base_url, raw.id.trim_start_matches('/')),
            install_id,
        });
    }

    fill_market_descriptions(&client, base_url, &mut items).await;
    Ok(items)
}

fn summarize_command_output(stdout: &str, stderr: &str) -> String {
    let primary = if !stdout.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if primary.is_empty() {
        return "Skill downloaded successfully.".to_string();
    }
    truncate_preview(primary)
}

fn truncate_preview(text: &str) -> String {
    if text.chars().count() <= MAX_OUTPUT_PREVIEW_CHARS {
        return text.to_string();
    }
    let truncated: String = text.chars().take(MAX_OUTPUT_PREVIEW_CHARS).collect();
    format!("{}...", truncated)
}

fn market_description_cache() -> &'static RwLock<HashMap<String, String>> {
    MARKET_DESCRIPTION_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

async fn fill_market_descriptions(client: &Client, base_url: &str, items: &mut [SkillMarketItem]) {
    let cache = market_description_cache();
    {
        let reader = cache.read().await;
        for item in items.iter_mut() {
            if !item.description.trim().is_empty() {
                continue;
            }
            if let Some(cached) = reader.get(&item.id) {
                item.description = cached.clone();
            }
        }
    }

    let mut missing_ids = Vec::new();
    for item in items.iter() {
        if item.description.trim().is_empty() {
            missing_ids.push(item.id.clone());
        }
    }
    if missing_ids.is_empty() {
        return;
    }

    let mut join_set = JoinSet::new();
    let mut fetched = HashMap::new();
    for skill_id in missing_ids {
        let client_clone = client.clone();
        let page_url = format!("{}/{}", base_url, skill_id.trim_start_matches('/'));
        join_set.spawn(async move {
            let description = fetch_description_from_skill_page(&client_clone, &page_url).await;
            (skill_id, description)
        });
        if join_set.len() >= MARKET_DESC_FETCH_CONCURRENCY {
            if let Some(Ok((skill_id, Some(desc)))) = join_set.join_next().await {
                fetched.insert(skill_id, desc);
            }
        }
    }
    while let Some(result) = join_set.join_next().await {
        if let Ok((skill_id, Some(desc))) = result {
            fetched.insert(skill_id, desc);
        }
    }
    if fetched.is_empty() {
        return;
    }

    {
        let mut writer = cache.write().await;
        for (skill_id, desc) in &fetched {
            writer.insert(skill_id.clone(), desc.clone());
        }
    }
    for item in items.iter_mut() {
        if item.description.trim().is_empty() {
            if let Some(desc) = fetched.get(&item.id) {
                item.description = desc.clone();
            }
        }
    }
}

async fn fetch_description_from_skill_page(client: &Client, page_url: &str) -> Option<String> {
    // P1-A：市场 base_url 可配置，过 net_guard 防被指到内网
    if let Err(e) = ai00_x_core::util::net_guard::assert_url_allowed(page_url).await {
        log::warn!("[skill-api] blocked by net guard: {e}");
        return None;
    }
    let response = timeout(
        Duration::from_secs(MARKET_DESC_FETCH_TIMEOUT_SECS),
        client.get(page_url).send(),
    )
    .await
    .ok()?
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let html = timeout(
        Duration::from_secs(MARKET_DESC_FETCH_TIMEOUT_SECS),
        response.text(),
    )
    .await
    .ok()?
    .ok()?;
    extract_description_from_html(&html)
}

fn extract_description_from_html(html: &str) -> Option<String> {
    if let Some(prose_index) = html.find("class=\"prose") {
        let scope = &html[prose_index..];
        if let Some(p_start) = scope.find("<p>") {
            let content = &scope[p_start + 3..];
            if let Some(p_end) = content.find("</p>") {
                let raw = &content[..p_end];
                let normalized = normalize_html_text(raw);
                if !normalized.is_empty() {
                    return Some(limit_text_len(&normalized, MARKET_DESC_MAX_LEN));
                }
            }
        }
    }
    if let Some(twitter_desc) = extract_meta_content(html, "twitter:description") {
        let normalized = normalize_html_text(&twitter_desc);
        if is_meaningful_meta_description(&normalized) {
            return Some(limit_text_len(&normalized, MARKET_DESC_MAX_LEN));
        }
    }
    None
}

fn extract_meta_content(html: &str, key: &str) -> Option<String> {
    let pattern = format!(r#"<meta name="{}" content="([^"]+)""#, regex::escape(key));
    let re = Regex::new(&pattern).ok()?;
    let caps = re.captures(html)?;
    Some(caps.get(1)?.as_str().to_string())
}

fn normalize_html_text(raw: &str) -> String {
    let without_tags = if let Ok(re) = Regex::new(r"<[^>]+>") {
        re.replace_all(raw, " ").into_owned()
    } else {
        raw.to_string()
    };
    without_tags
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn is_meaningful_meta_description(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.is_empty() || lower == "discover and install skills for ai agents." {
        return false;
    }
    !lower.starts_with("install the ")
}

fn limit_text_len(text: &str, max_len: usize) -> String {
    if text.chars().count() <= max_len {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max_len).collect();
    truncated.push_str("...");
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_parses_name_and_description() {
        let md =
            "---\nname: docx\ndescription: \"Office docs skill\"\nlicense: MIT\n---\n\n# body\n";
        let (name, description) = parse_skill_frontmatter(md).unwrap();
        assert_eq!(name, "docx");
        assert_eq!(description, "Office docs skill");
    }

    #[test]
    fn frontmatter_without_name_is_rejected() {
        assert!(parse_skill_frontmatter("---\ndescription: only\n---\n").is_none());
    }

    #[test]
    fn builtin_grouping_matches_legacy() {
        assert_eq!(builtin_group_key("docx"), Some("office"));
        assert_eq!(builtin_group_key("gstack-qa"), Some("team"));
        assert_eq!(builtin_group_key("unknown"), None);
    }

    #[test]
    fn bundled_embed_contains_skills() {
        // 编译期内嵌完整性：至少含一个可安装技能目录
        assert!(BUILTIN_SKILLS_DIR.dirs().count() > 0);
    }
}
