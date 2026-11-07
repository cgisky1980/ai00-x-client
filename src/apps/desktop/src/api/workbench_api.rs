//! Workbench host-side API.
//!
//! Commands backing the host-side session integration declared in
//! `参考/2026-11-07-工作台插件规范.md` §6.2:
//! - `workbench_prepare_project` — 解析/创建工作台的**固定总工作目录**、
//!   确保工作台自己的 `AGENTS.md`、解析/创建项目子目录，并写入项目级
//!   `AGENTS.local.md`（宿主生成，供 dsh standard preset 注入 system 段）。
//!
//! 目录约定（每类工作台一个总目录，每个项目一个子目录）：
//! - `wallpaper`：总目录 `<exe_dir>/workspaces/wallpaper`，项目
//!   `<root>/projects/<projectId>`（目录由壁纸服务创建，宿主只解析）。
//! - 其他工作台：总目录 `{data_dir}/Ai00-X/workbenches/<dataDir>`，
//!   项目 `<root>/<projectId>`（宿主按需创建）。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::api::app_state::AppState;
use ai00_x_core::wallpaper::service as wallpaper_service;

/// Slug guard: project ids / dataDir names must stay path-safe.
fn is_safe_slug(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 工作台总目录 + 项目工作目录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchProjectContext {
    /// 工作台固定总工作目录（承载 `AGENTS.md`）。
    pub workbench_root: String,
    /// 本次会话的工作目录（项目子目录）。
    pub project_root: String,
}

/// 工作台没有声明 `workbench.agentInstructions` 时的兜底骨架。
fn default_workbench_agents(title: &str, workbench_id: &str) -> String {
    format!(
        "# {title} 工作台约定（{workbench_id}）\n\n\
本文件是「{title}」这一类工作台的固定 agent.md，由 Ai00-X 宿主在首次运行时生成；\n\
可以直接编辑，宿主只在文件缺失时重建，不会覆盖你的修改。\n\n\
## 目录约定\n\n\
- 工作台总目录：本文件所在目录。\n\
- 每个项目占一个子目录，AI 会话的工作目录是该子目录，而不是总目录。\n\n\
## 通用约定\n\n\
- 只在当前项目子目录内创建/修改文件；越界写入会被宿主直接拒绝。\n\
- 产物保持可独立打开：不依赖 CDN 或外部网络资源。\n\
- 完成改动后同步更新项目内的说明文件（README 等）。\n"
    )
}

/// 写入（或读取）工作台总目录的 `AGENTS.md`；已存在则原样返回，不覆盖。
fn ensure_workbench_agents(
    root: &Path,
    title: &str,
    workbench_id: &str,
    declared: Option<&str>,
) -> Result<String, String> {
    let file = root.join("AGENTS.md");
    if let Ok(existing) = std::fs::read_to_string(&file) {
        if !existing.trim().is_empty() {
            return Ok(existing);
        }
    }
    let content = match declared.map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => text.to_string(),
        None => default_workbench_agents(title, workbench_id),
    };
    std::fs::write(&file, &content)
        .map_err(|e| format!("Failed to write workbench AGENTS.md: {e}"))?;
    Ok(content)
}

/// 项目级 `AGENTS.local.md`：宿主生成块 + 工作台约定的内联副本。
///
/// 内联而非引用，是因为 workbench preset 把指令根发现止于工程子目录
/// （`projectRootMarkers = ['AGENTS.local.md']`），不会向上读取总目录的
/// `AGENTS.md`。
fn compose_project_agents(opts: &ComposeOptions<'_>) -> String {
    let project_label = match opts.project_title.filter(|t| !t.trim().is_empty()) {
        Some(title) => format!("{title}（id: {}）", opts.project_id),
        None => opts.project_id.to_string(),
    };
    format!(
        "# Ai00-X 工作台会话约定（宿主生成，请勿手改）\n\n\
本会话由 Ai00-X 工作台「{workbench_title}」（id: {workbench_id}）创建并绑定到工程 {project_label}。\n\n\
- 工作台总目录：`{workbench_root}`\n\
- 工程根路径（本会话工作目录）：`{project_root}`\n\
- 写入范围约定：只允许读取/创建/修改该工程根路径之内的文件；任何越界写入都会被宿主自动拒绝（path_out_of_scope）。\n\
- 需要工程之外的参考资料时请只读访问，并把产物写回工程根内。\n\n\
## 工作台约定\n\n\
{workbench_agents}\n",
        workbench_title = opts.workbench_title,
        workbench_id = opts.workbench_id,
        project_label = project_label,
        workbench_root = opts.workbench_root.display(),
        project_root = opts.project_root.display(),
        workbench_agents = opts.workbench_agents.trim(),
    )
}

struct ComposeOptions<'a> {
    workbench_id: &'a str,
    workbench_title: &'a str,
    workbench_root: &'a Path,
    project_id: &'a str,
    project_title: Option<&'a str>,
    project_root: &'a Path,
    workbench_agents: &'a str,
}

/// Resolve the workbench root and its project subdirectory, then make sure both
/// the workbench-level `AGENTS.md` and the project-level `AGENTS.local.md` exist.
#[tauri::command]
pub async fn workbench_prepare_project(
    _state: State<'_, AppState>,
    workbench_id: String,
    data_dir_name: Option<String>,
    workbench_title: Option<String>,
    agent_instructions: Option<String>,
    project_id: String,
    project_title: Option<String>,
) -> Result<WorkbenchProjectContext, String> {
    if !is_safe_slug(&project_id) {
        return Err(format!("Invalid project id '{project_id}'"));
    }
    let title = workbench_title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| workbench_id.clone());

    let (root, resolved_project) = if workbench_id == "wallpaper" {
        let workspaces_root = ai00_x_core::infrastructure::PathManager::exe_dir()
            .map_err(|e| e.to_string())?
            .join("workspaces");
        let root = wallpaper_service::workspace_wallpaper_dir(&workspaces_root);
        let projects = wallpaper_service::list_workspace_projects(&workspaces_root)
            .map_err(|e| e.to_string())?;
        let project = projects
            .into_iter()
            .find(|p| p.id == project_id)
            .and_then(|p| p.project_path)
            .ok_or_else(|| format!("project-root-not-found:{project_id}"))?;
        (root, Some(PathBuf::from(project)))
    } else {
        let data_dir_name = data_dir_name
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| workbench_id.clone());
        if !is_safe_slug(&data_dir_name) {
            return Err(format!("Invalid workbench dataDir '{data_dir_name}'"));
        }
        // plugins_dir() = {data_dir}/Ai00-X/plugins → parent = {data_dir}/Ai00-X.
        let root = crate::api::plugin_api::plugins_dir()
            .parent()
            .ok_or_else(|| "Failed to resolve Ai00-X data dir".to_string())?
            .join("workbenches")
            .join(&data_dir_name);
        (root, None)
    };

    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create workbench root {}: {e}", root.display()))?;
    let workbench_agents =
        ensure_workbench_agents(&root, &title, &workbench_id, agent_instructions.as_deref())?;

    let project_root = resolved_project.unwrap_or_else(|| root.join(&project_id));
    std::fs::create_dir_all(&project_root).map_err(|e| {
        format!(
            "Failed to create project root {}: {e}",
            project_root.display()
        )
    })?;

    let content = compose_project_agents(&ComposeOptions {
        workbench_id: &workbench_id,
        workbench_title: &title,
        workbench_root: &root,
        project_id: &project_id,
        project_title: project_title.as_deref(),
        project_root: &project_root,
        workbench_agents: &workbench_agents,
    });
    let local = project_root.join("AGENTS.local.md");
    let unchanged = std::fs::read_to_string(&local)
        .map(|existing| existing == content)
        .unwrap_or(false);
    if !unchanged {
        std::fs::write(&local, content)
            .map_err(|e| format!("Failed to write AGENTS.local.md: {e}"))?;
    }

    Ok(WorkbenchProjectContext {
        workbench_root: root.to_string_lossy().to_string(),
        project_root: project_root.to_string_lossy().to_string(),
    })
}
