//! Wallpaper service — manages preview and project directories on disk.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::Utc;
use uuid::Uuid;

use super::types::{CreateProjectResult, WallpaperMeta, WallpaperProject};
use crate::service::config::server_endpoints::{LOCAL_EMBEDDED_SERVER_PORT, LOCAL_HOST};

/// Root directory for all wallpaper data.
fn wallpaper_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Ai00-X")
        .join("wallpapers")
}

/// Preview directory (temporary, reused across sessions).
pub fn preview_dir() -> PathBuf {
    wallpaper_root().join("preview")
}

/// Projects directory (persisted wallpaper projects).
pub fn projects_dir() -> PathBuf {
    wallpaper_root().join("projects")
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/// Ensure the preview directory and its `assets/` subdir exist.
pub fn ensure_preview_dir() -> io::Result<PathBuf> {
    let dir = preview_dir();
    fs::create_dir_all(dir.join("assets"))?;
    Ok(dir)
}

/// Write HTML content to `preview/index.html`. Creates the directory first.
pub fn write_preview_index(html: &str) -> io::Result<()> {
    ensure_preview_dir()?;
    fs::write(preview_dir().join("index.html"), html)?;
    Ok(())
}

/// Read the current `preview/index.html` content.
pub fn read_preview_index() -> io::Result<String> {
    fs::read_to_string(preview_dir().join("index.html"))
}

/// Create an asset file inside `preview/assets/`.
pub fn write_preview_asset(relative_path: &str, content: &[u8]) -> io::Result<()> {
    ensure_preview_dir()?;
    let path = preview_dir().join("assets").join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/// List all wallpaper projects.
pub fn list_projects() -> io::Result<Vec<WallpaperProject>> {
    let root = projects_dir();
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        if let Some(project) = read_project(&dir) {
            projects.push(project);
        }
    }
    projects.sort_by_key(|p| p.updated_at);
    projects.reverse(); // newest first
    Ok(projects)
}

/// Read a single project from its directory.
fn read_project(dir: &Path) -> Option<WallpaperProject> {
    let meta_path = dir.join("meta.json");
    let meta: WallpaperMeta = if meta_path.exists() {
        serde_json::from_str(&fs::read_to_string(&meta_path).ok()?).ok()?
    } else {
        WallpaperMeta::default()
    };

    let id = dir.file_name()?.to_string_lossy().to_string();
    let created = dir
        .metadata()
        .ok()
        .and_then(|m| m.created().ok())
        .map(chrono::DateTime::from)
        .unwrap_or_else(Utc::now);
    let updated = dir
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .map(chrono::DateTime::from)
        .unwrap_or_else(Utc::now);

    Some(WallpaperProject {
        id,
        name: if meta.name.is_empty() {
            "Unnamed".into()
        } else {
            meta.name
        },
        description: meta.description,
        tags: meta.tags,
        created_at: created,
        updated_at: updated,
        project_path: None,
    })
}

/// Read a workspace project with its full filesystem path.
fn read_workspace_project(dir: &Path) -> Option<WallpaperProject> {
    let mut project = read_project(dir)?;
    project.project_path = Some(dir.to_string_lossy().to_string());
    Some(project)
}

/// Create a new project by copying the current preview directory.
pub fn create_project(name: &str) -> io::Result<CreateProjectResult> {
    let id = slugify(name);
    let project_dir = projects_dir().join(&id);
    if project_dir.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("Project '{}' already exists", id),
        ));
    }
    fs::create_dir_all(&project_dir)?;

    // Copy preview contents to project dir
    let preview = preview_dir();
    if preview.exists() {
        copy_dir_contents(&preview, &project_dir)?;
    }

    // Write meta.json
    let meta = WallpaperMeta {
        name: name.to_string(),
        description: String::new(),
        tags: Vec::new(),
    };
    fs::write(
        project_dir.join("meta.json"),
        serde_json::to_string_pretty(&meta)?,
    )?;

    let project = read_project(&project_dir).unwrap_or_else(|| WallpaperProject {
        id: id.clone(),
        name: name.to_string(),
        description: String::new(),
        tags: Vec::new(),
        created_at: Utc::now(),
        updated_at: Utc::now(),
        project_path: None,
    });

    Ok(CreateProjectResult {
        project,
        serve_path: format!("/projects/{}", id),
        project_path: project_dir.to_string_lossy().to_string(),
    })
}

/// Delete a project directory and all its contents.
pub fn delete_project(id: &str) -> io::Result<()> {
    let dir = projects_dir().join(id);
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/// Get the project directory path.
pub fn project_dir(id: &str) -> PathBuf {
    projects_dir().join(id)
}

/// Update a project's meta.json and return the updated project.
pub fn update_project_meta(id: &str, meta: &WallpaperMeta) -> io::Result<WallpaperProject> {
    let dir = projects_dir().join(id);
    if !dir.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Project '{}' not found", id),
        ));
    }
    fs::write(dir.join("meta.json"), serde_json::to_string_pretty(meta)?)?;
    // Touch the directory to update modified time
    filetime::set_file_mtime(&dir, filetime::FileTime::now()).ok();
    read_project(&dir).ok_or_else(|| io::Error::other("Failed to read project after update"))
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Export a project as a zip file. Returns the path to the zip.
pub fn export_project_zip(id: &str, dest: &Path) -> io::Result<PathBuf> {
    let project_dir = projects_dir().join(id);
    if !project_dir.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Project '{}' not found", id),
        ));
    }

    let zip_path = dest.join(format!("{}.zip", id));
    let file = fs::File::create(&zip_path)?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    add_dir_to_zip(&mut writer, &project_dir, &project_dir, options)?;
    writer.finish()?;
    Ok(zip_path)
}

fn add_dir_to_zip<T: io::Write + io::Seek>(
    writer: &mut zip::ZipWriter<T>,
    root: &Path,
    dir: &Path,
    options: zip::write::SimpleFileOptions,
) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|e| io::Error::other(e.to_string()))?;

        if entry.file_type()?.is_dir() {
            writer.add_directory(relative.to_string_lossy().replace('\\', "/") + "/", options)?;
            add_dir_to_zip(writer, root, &path, options)?;
        } else {
            writer.start_file(relative.to_string_lossy().replace('\\', "/"), options)?;
            io::copy(&mut fs::File::open(&path)?, writer)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Copy all contents of `src` into `dest` recursively.
fn copy_dir_contents(src: &Path, dest: &Path) -> io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if entry.file_type()?.is_dir() {
            fs::create_dir_all(&dest_path)?;
            copy_dir_contents(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

/// Convert a human-readable name into a filesystem-safe slug.
pub fn slugify(name: &str) -> String {
    let slug = name
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    // Collapse consecutive dashes
    let slug = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        format!("wallpaper-{}", &Uuid::new_v4().to_string()[..8])
    } else {
        slug
    }
}

/// Generate a human-readable project name and directory slug from a description.
/// Uses a simple heuristic: extracts the first meaningful phrase and slugifies it.
pub fn generate_project_name(description: &str) -> (String, String) {
    // Extract first sentence or first 60 chars as the name
    let first_sentence = description
        .split(&['.', '!', '?', '。', '！', '？', '\n'][..])
        .next()
        .unwrap_or(description)
        .trim();
    let name = if first_sentence.len() > 60 {
        let end = first_sentence
            .char_indices()
            .take(60)
            .last()
            .map(|(i, _)| i)
            .unwrap_or(60);
        first_sentence[..end].trim().to_string()
    } else {
        first_sentence.to_string()
    };
    let dir_name = slugify(&name);
    (name, dir_name)
}

// ---------------------------------------------------------------------------
// Workspace-based project storage
// ---------------------------------------------------------------------------

/// Returns `<workspace>/wallpaper/` directory.
pub fn workspace_wallpaper_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join("wallpaper")
}

/// Returns `<workspace>/wallpaper/projects/` directory.
pub fn workspace_projects_dir(workspace_root: &Path) -> PathBuf {
    workspace_wallpaper_dir(workspace_root).join("projects")
}

/// Create a new wallpaper project under the workspace directory.
pub fn create_workspace_project(
    workspace_root: &Path,
    name: &str,
    dir_name: &str,
) -> io::Result<CreateProjectResult> {
    let project_dir = workspace_projects_dir(workspace_root).join(dir_name);
    if project_dir.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("Project '{}' already exists in workspace", dir_name),
        ));
    }
    fs::create_dir_all(&project_dir)?;

    // Copy template files into the new project
    copy_template_into(&project_dir, name)?;

    // Write meta.json
    let meta = WallpaperMeta {
        name: name.to_string(),
        description: String::new(),
        tags: Vec::new(),
    };
    fs::write(
        project_dir.join("meta.json"),
        serde_json::to_string_pretty(&meta)?,
    )?;

    let project = read_project(&project_dir).unwrap_or_else(|| WallpaperProject {
        id: dir_name.to_string(),
        name: name.to_string(),
        description: String::new(),
        tags: Vec::new(),
        created_at: Utc::now(),
        updated_at: Utc::now(),
        project_path: None,
    });

    Ok(CreateProjectResult {
        project,
        serve_path: format!("/wallpaper/projects/{}", dir_name),
        project_path: project_dir.to_string_lossy().to_string(),
    })
}

/// List all wallpaper projects under the workspace.
pub fn list_workspace_projects(workspace_root: &Path) -> io::Result<Vec<WallpaperProject>> {
    let root = workspace_projects_dir(workspace_root);
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        if let Some(project) = read_workspace_project(&dir) {
            projects.push(project);
        }
    }
    projects.sort_by_key(|p| p.updated_at);
    projects.reverse(); // newest first
    Ok(projects)
}

/// Publish a workspace wallpaper project: copy to serve directory + export zip.
/// Returns (zip_path, serve_url).
pub fn publish_workspace_project(
    workspace_root: &Path,
    dir_name: &str,
) -> io::Result<(String, String)> {
    let src_dir = workspace_projects_dir(workspace_root).join(dir_name);
    if !src_dir.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Project '{}' not found in workspace", dir_name),
        ));
    }

    // Copy project to the global wallpaper serve directory
    let serve_dir = projects_dir().join(dir_name);
    if serve_dir.exists() {
        fs::remove_dir_all(&serve_dir)?;
    }
    fs::create_dir_all(&serve_dir)?;
    copy_dir_contents(&src_dir, &serve_dir)?;

    // Export zip to the same global directory
    let zip_path = export_project_zip(dir_name, &projects_dir())?;

    let serve_url = format!(
        "http://{}:{}/wallpapers/projects/{}/index.html",
        LOCAL_HOST, LOCAL_EMBEDDED_SERVER_PORT, dir_name
    );
    Ok((zip_path.to_string_lossy().to_string(), serve_url))
}

/// Delete a workspace wallpaper project by directory name.
pub fn delete_workspace_project(workspace_root: &Path, dir_name: &str) -> io::Result<()> {
    let dir = workspace_projects_dir(workspace_root).join(dir_name);
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Template system — starter files copied into new projects
// ---------------------------------------------------------------------------

/// Returns the path to the wallpaper template directory.
fn template_dir() -> PathBuf {
    wallpaper_root().join("template")
}

/// Ensure the template directory exists and contains all template files.
/// Creates the template on first use so it lives alongside wallpaper data.
fn ensure_template_dir() -> io::Result<PathBuf> {
    let dir = template_dir();
    fs::create_dir_all(dir.join("assets"))?;

    let index_path = dir.join("index.html");
    if !index_path.exists() {
        fs::write(&index_path, TEMPLATE_INDEX_HTML)?;
    }

    let config_path = dir.join("wallpaper.config.json");
    if !config_path.exists() {
        fs::write(&config_path, TEMPLATE_CONFIG_JSON)?;
    }

    let readme_path = dir.join("README.md");
    if !readme_path.exists() {
        fs::write(&readme_path, TEMPLATE_README_MD)?;
    }

    Ok(dir)
}

/// Recursively copy the template directory into a new project directory,
/// replacing `{project_name}` placeholders in text files.
fn copy_template_into(project_dir: &Path, name: &str) -> io::Result<()> {
    let template = ensure_template_dir()?;
    copy_dir_recursive(&template, project_dir, name)?;
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path, name: &str) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dst_path = dst.join(&file_name);

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path, name)?;
        } else {
            let content = fs::read_to_string(&src_path).unwrap_or_default();
            let replaced = content.replace("{project_name}", name);
            fs::write(&dst_path, replaced)?;
        }
    }
    Ok(())
}

// ── Template file contents (embedded at compile time) ──────────────

const TEMPLATE_INDEX_HTML: &str = r##"<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{project_name}</title>
  <style>
    /*
     * Ai00-X 「灵」— 默认动态背景
     * 视觉：墨为骨（深墨底）、青为神（黛青墨雾/墨痕）、朱为印（灵印）、白为息（字与留白）。
     *
     * 开销纪律（改这个文件前必读）：
     *   1) 纯 CSS 动画，只动 transform / opacity —— 全程合成器处理，不触发布局与重绘；
     *   2) 禁止 canvas、requestAnimationFrame、逐帧 JS；本文只保留一个 20s 的时钟节拍；
     *   3) 动画元素 ≤ 6 个，无 filter / blur / 大阴影，避免 GPU 持续满载；
     *   4) 尊重 prefers-reduced-motion（只保留最慢档雾漂移）与 visibilitychange（不可见即暂停）。
     *
     * 版式纪律（underlay 有自己的动画层）：
     *   5) 桌面是「壁纸 + underlay 动画层」叠加显示的：底部（花圃/地面/工具栏）会盖住画面，
     *      所以壁纸的**文字与关键元素只放顶部**，底部 --safe-bottom 高度内一律不放内容；
     *   6) 所有尺寸用 clamp() + vmin/vh/vw，不写死 px；竖屏/超宽屏各有一档收敛规则。
     */
    :root {
      --ink-0: #06080a;
      --ink-1: #0c1116;
      --ink-2: #131b22;
      --daiqing: 92, 141, 162;   /* 黛青 rgb */
      --zhusha: 176, 66, 46;     /* 朱砂 rgb */
      --paper: 242, 239, 232;    /* 宣纸白 */
      /* 底部安全区：underlay 的动画层（花圃/地面/工具栏）会覆盖这一带 */
      --safe-bottom: 28vh;
      --edge-x: clamp(20px, 4vw, 72px);
      --edge-y: clamp(20px, 5vh, 64px);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    html, body {
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background-color: #06080a;
      color: rgb(var(--paper));
      font-family: "Ai00 X Serif", "Noto Serif SC", "Songti SC", serif;
      -webkit-font-smoothing: antialiased;
      cursor: default;
      user-select: none;
    }

    /* 墨底：静态径向渐变，不参与动画 */
    .stage {
      position: fixed;
      inset: 0;
      overflow: hidden;
      background:
        radial-gradient(120% 90% at 50% 12%, #16202a 0%, #0d1218 52%, #06080a 100%);
    }

    /* ── 墨雾：两团漂移 + 一团静态 ── */
    .mist {
      position: absolute;
      border-radius: 50%;
      pointer-events: none;
    }

    .mist--qing {
      width: 78vmax;
      height: 78vmax;
      left: -22vmax;
      top: -30vmax;
      background: radial-gradient(circle at 50% 50%,
        rgba(var(--daiqing), 0.38) 0%,
        rgba(var(--daiqing), 0.12) 46%,
        rgba(var(--daiqing), 0) 70%);
      animation: drift-qing 96s ease-in-out infinite alternate;
    }

    /* 右上角第三团雾：静态，只为增加纵深，零动画开销 */
    .mist--qing-2 {
      width: 46vmax;
      height: 46vmax;
      right: -14vmax;
      top: -16vmax;
      background: radial-gradient(circle at 50% 50%,
        rgba(var(--daiqing), 0.20) 0%,
        rgba(var(--daiqing), 0.06) 50%,
        rgba(var(--daiqing), 0) 72%);
    }

    /* 星尘：一次栅格化的静态点阵，不参与动画 */
    .dust {
      position: absolute;
      inset: 0 0 var(--safe-bottom) 0;
      pointer-events: none;
      background-repeat: no-repeat;
      background-image:
        radial-gradient(1px 1px at 11% 24%, rgba(var(--paper), 0.30) 50%, transparent 51%),
        radial-gradient(1px 1px at 23% 68%, rgba(var(--daiqing), 0.45) 50%, transparent 51%),
        radial-gradient(1px 1px at 34% 16%, rgba(var(--paper), 0.22) 50%, transparent 51%),
        radial-gradient(1px 1px at 47% 82%, rgba(var(--daiqing), 0.38) 50%, transparent 51%),
        radial-gradient(1px 1px at 58% 28%, rgba(var(--paper), 0.26) 50%, transparent 51%),
        radial-gradient(1px 1px at 66% 74%, rgba(var(--daiqing), 0.34) 50%, transparent 51%),
        radial-gradient(1px 1px at 74% 12%, rgba(var(--paper), 0.24) 50%, transparent 51%),
        radial-gradient(1px 1px at 83% 56%, rgba(var(--paper), 0.30) 50%, transparent 51%),
        radial-gradient(1px 1px at 91% 34%, rgba(var(--daiqing), 0.40) 50%, transparent 51%),
        radial-gradient(1px 1px at 17% 88%, rgba(var(--paper), 0.18) 50%, transparent 51%),
        radial-gradient(1px 1px at 52% 46%, rgba(var(--paper), 0.14) 50%, transparent 51%),
        radial-gradient(1px 1px at 38% 92%, rgba(var(--daiqing), 0.28) 50%, transparent 51%);
    }

    .mist--shu {
      width: 62vmax;
      height: 62vmax;
      right: -24vmax;
      bottom: -28vmax;
      background: radial-gradient(circle at 50% 50%,
        rgba(var(--zhusha), 0.16) 0%,
        rgba(var(--zhusha), 0.05) 44%,
        rgba(var(--zhusha), 0) 70%);
      animation: drift-shu 132s ease-in-out infinite alternate;
    }

    /* ── 墨痕：三道极细竖纹，只做透明度呼吸；底端停在安全区之上 ── */
    .stroke {
      position: absolute;
      top: 8vh;
      bottom: calc(var(--safe-bottom) + 2vh);
      width: 1px;
      background: linear-gradient(
        to bottom,
        rgba(var(--daiqing), 0) 0%,
        rgba(var(--daiqing), 0.34) 38%,
        rgba(var(--paper), 0.16) 62%,
        rgba(var(--daiqing), 0) 100%);
      opacity: 0;
      animation: breathe 24s ease-in-out infinite;
    }

    .stroke--1 { left: 22vw; animation-duration: 21s; animation-delay: -3s; }
    .stroke--2 { left: 50vw; animation-duration: 27s; animation-delay: -11s; }
    .stroke--3 { left: 78vw; animation-duration: 33s; animation-delay: -7s; }

    /* ── 顶部信息带：全部文字只出现在这里（底部会被 underlay 动画层盖住） ── */
    .topbar {
      position: absolute;
      top: var(--edge-y);
      left: var(--edge-x);
      right: var(--edge-x);
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: clamp(16px, 3vw, 48px);
      pointer-events: none;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: clamp(10px, 1.2vmin, 18px);
      min-width: 0;
    }

    /* 灵印：朱砂方印，全屏唯一的朱色 */
    .seal {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      width: clamp(44px, 6vmin, 84px);
      height: clamp(44px, 6vmin, 84px);
      border: 2px solid rgba(var(--zhusha), 0.72);
      border-radius: clamp(6px, 0.8vmin, 10px);
      background: rgba(var(--zhusha), 0.06);
      box-shadow: inset 0 0 0 5px rgba(var(--zhusha), 0.05);
      color: rgba(var(--zhusha), 0.92);
      font-size: clamp(24px, 3.2vmin, 46px);
      line-height: 1;
      animation: seal-breathe 12s ease-in-out infinite;
    }

    .brand__text { min-width: 0; }

    .brand__name {
      font-size: clamp(18px, 2.1vmin, 32px);
      letter-spacing: 0.16em;
      color: rgba(var(--paper), 0.84);
      white-space: nowrap;
    }

    .brand__tag {
      margin-top: clamp(4px, 0.6vmin, 10px);
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: clamp(9px, 0.95vmin, 12px);
      letter-spacing: 0.26em;
      text-transform: uppercase;
      color: rgba(var(--paper), 0.34);
      white-space: nowrap;
    }

    .clock {
      flex: 0 0 auto;
      text-align: right;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-variant-numeric: tabular-nums;
      color: rgba(var(--paper), 0.42);
    }

    .clock__time {
      font-size: clamp(16px, 2vmin, 30px);
      letter-spacing: 0.08em;
      color: rgba(var(--paper), 0.68);
    }

    .clock__date {
      margin-top: clamp(4px, 0.6vmin, 8px);
      font-size: clamp(9px, 0.95vmin, 12px);
      letter-spacing: 0.2em;
      white-space: nowrap;
    }

    /* ── 动画：全部 transform / opacity ── */
    @keyframes drift-qing {
      from { transform: translate3d(0, 0, 0) scale(1); }
      to   { transform: translate3d(6vmax, 4vmax, 0) scale(1.12); }
    }

    @keyframes drift-shu {
      from { transform: translate3d(0, 0, 0) scale(1.06); }
      to   { transform: translate3d(-5vmax, -3vmax, 0) scale(1); }
    }

    @keyframes breathe {
      0%, 100% { opacity: 0; }
      45%, 55% { opacity: 1; }
    }

    @keyframes seal-breathe {
      0%, 100% { transform: scale(1); opacity: 0.92; }
      50%      { transform: scale(1.04); opacity: 1; }
    }

    /* ── 分辨率适配 ── */
    /* 竖屏 / 方屏：顶部信息带改为纵向，避免左右两侧挤在一起 */
    @media (max-aspect-ratio: 1/1) {
      .topbar {
        flex-direction: column;
        align-items: flex-start;
      }
      .clock {
        text-align: left;
        margin-top: clamp(8px, 2vh, 20px);
      }
      /* 竖屏下雾的面积按 vmax 会过大，收敛一档 */
      .mist--qing { width: 110vmax; height: 110vmax; left: -40vmax; top: -50vmax; }
      .mist--shu { width: 90vmax; height: 90vmax; }
    }

    /* 超宽屏（21:9 及以上）：文字不跟着拉太散，保持靠边 */
    @media (min-aspect-ratio: 21/9) {
      .topbar { left: clamp(24px, 3vw, 96px); right: clamp(24px, 3vw, 96px); }
    }

    /* 矮屏（如 1366×768 / 1024×600）：压缩顶部留白与字号 */
    @media (max-height: 720px) {
      :root { --edge-y: 18px; --safe-bottom: 30vh; }
      .brand__tag { display: none; }
    }

    /* 减少动态效果：关掉呼吸类动画，墨雾降到最慢档（壁纸仍是「活的」，但不晃眼） */
    @media (prefers-reduced-motion: reduce) {
      .stroke, .seal { animation: none !important; }
      .stroke { opacity: 0.6; }
      .mist--qing { animation-duration: 240s; }
      .mist--shu { animation-duration: 330s; }
    }

    /* 不可见时暂停（壁纸被覆盖/最小化时零渲染开销） */
    body.is-idle .mist,
    body.is-idle .stroke,
    body.is-idle .seal {
      animation-play-state: paused;
    }
  </style>
</head>
<body>
  <div class="stage" aria-hidden="true">
    <div class="dust"></div>
    <div class="mist mist--qing-2"></div>
    <div class="mist mist--qing"></div>
    <div class="mist mist--shu"></div>
    <div class="stroke stroke--1"></div>
    <div class="stroke stroke--2"></div>
    <div class="stroke stroke--3"></div>
    <div class="topbar">
      <div class="brand">
        <div class="seal">灵</div>
        <div class="brand__text">
          <div class="brand__name">Ai00-X</div>
          <div class="brand__tag">Ink lives · 墨为骨 青为神</div>
        </div>
      </div>
      <div class="clock">
        <div class="clock__time" id="clock-time">--:--</div>
        <div class="clock__date" id="clock-date"></div>
      </div>
    </div>
  </div>
  <script>
    // 唯一的 JS：每 20s 对一次表（分钟级显示），可见性变化时暂停动画。
    (function () {
      var timeEl = document.getElementById('clock-time');
      var dateEl = document.getElementById('clock-date');
      var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

      function tick() {
        var now = new Date();
        var hh = String(now.getHours()).padStart(2, '0');
        var mm = String(now.getMinutes()).padStart(2, '0');
        timeEl.textContent = hh + ':' + mm;
        dateEl.textContent =
          now.getFullYear() + '.' +
          String(now.getMonth() + 1).padStart(2, '0') + '.' +
          String(now.getDate()).padStart(2, '0') + '  ' +
          WEEK[now.getDay()];
      }

      tick();
      setInterval(tick, 20000);

      function syncIdle() {
        document.body.classList.toggle('is-idle', document.hidden);
      }
      document.addEventListener('visibilitychange', syncIdle);
      syncIdle();
    })();
  </script>
</body>
</html>"##;

const TEMPLATE_CONFIG_JSON: &str = r##"{
  "version": "1.0",
  "type": "live-wallpaper",
  "name": "{project_name}",
  "description": "",
  "author": "",
  "preview": "index.html",
  "settings": {
    "fps": 30,
    "interactive": false,
    "audio": false,
    "mouseTracking": false
  },
  "theme": {
    "primaryColor": "#5c8da2",
    "backgroundColor": "#06080a"
  }
}"##;

const TEMPLATE_README_MD: &str = r##"# Wallpaper Project: {project_name}

## Description

Replace this section with your wallpaper description.

## Configuration

See `wallpaper.config.json` for project settings.

## Development

- Edit `index.html` to modify the wallpaper.
- All assets (images, audio, etc.) go into the `assets/` directory.
- Use `Shift+F5` in browser to hard-reload after changes.

## AI Agent Rules

- Keep HTML self-contained — no CDN or external resources.
- Use `body { margin: 0; overflow: hidden; width: 100vw; height: 100vh; }`.
- Cost discipline comes before "cool": a wallpaper runs for hours on the user's desktop.
  - Prefer pure CSS animation on `transform` / `opacity` only (compositor work, no layout/paint).
  - No large-area `filter: blur()` / `backdrop-filter` / big box shadows — use radial-gradient falloff instead.
  - Avoid canvas + rAF loops; if unavoidable: particles <= 120, <= 30fps, O(n) per frame, stop when `document.hidden`, throttle resize.
  - Keep animated elements <= 8 and cycles >= 20s; stagger starts with negative `animation-delay`.
  - Always honor `prefers-reduced-motion` and pause on `visibilitychange`.
  - Target: idle CPU < 1%, animated single-core < 5%, no dropped frames.
- Layout discipline (the desktop is wallpaper + underlay animation layers):
  - The bottom of the screen is covered by the underlay garden/ground/toolbar layers: put text and key elements in the TOP band only, keep the bottom 28vh (`--safe-bottom`) empty.
  - Never assume 16:9: size everything with `clamp()` + `vmin/vh/vw` (no hard-coded px); add branches for portrait (`max-aspect-ratio: 1/1`), ultra-wide (`min-aspect-ratio: 21/9`) and short screens (`max-height: 720px`).
  - Keep the middle band low-contrast (mists, dust) — desktop icons live there.
- Use `window.Ai00Wallpaper` API for audio, mouse tracking, and system focus detection.
"##;

/// Generate a fresh UUID string for use as a project directory name.
pub fn generate_dir_name() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("My Starry Sky"), "my-starry-sky");
        assert_eq!(slugify("Hello  World!"), "hello-world");
        assert!(!slugify("!!!").is_empty()); // becomes random UUID
    }

    #[test]
    fn test_generate_project_name() {
        let (name, dir) = generate_project_name(
            "A beautiful star field with twinkling stars and a subtle nebula background",
        );
        assert!(!name.is_empty());
        assert!(!dir.is_empty());
        assert!(dir.chars().all(|c| c.is_alphanumeric() || c == '-'));
    }
}
