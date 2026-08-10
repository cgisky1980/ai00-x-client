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
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{project_name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100vw; height: 100vh; overflow: hidden; background: #0a0a1a; }
    canvas { display: block; }
  </style>
</head>
<body>
  <canvas id="bg"></canvas>
  <script>
    // Particle network background — responsive, mouse-interactive
    (function() {
      const canvas = document.getElementById('bg');
      const ctx = canvas.getContext('2d');
      let w, h, particles = [];
      const PARTICLE_COUNT = 80;
      const LINK_DISTANCE = 120;
      const PARTICLE_SPEED = 0.4;

      function resize() {
        w = canvas.width = window.innerWidth;
        h = canvas.height = window.innerHeight;
      }
      window.addEventListener('resize', resize);
      resize();

      class Particle {
        constructor() {
          this.x = Math.random() * w;
          this.y = Math.random() * h;
          this.vx = (Math.random() - 0.5) * PARTICLE_SPEED;
          this.vy = (Math.random() - 0.5) * PARTICLE_SPEED;
          this.r = Math.random() * 2 + 1;
        }
        update() {
          this.x += this.vx; this.y += this.vy;
          if (this.x < 0 || this.x > w) this.vx *= -1;
          if (this.y < 0 || this.y > h) this.vy *= -1;
        }
        draw() {
          ctx.beginPath();
          ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(102, 126, 234, 0.7)';
          ctx.fill();
        }
      }

      for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(new Particle());

      function animate() {
        ctx.clearRect(0, 0, w, h);
        particles.forEach(p => { p.update(); p.draw(); });
        for (let i = 0; i < particles.length; i++) {
          for (let j = i + 1; j < particles.length; j++) {
            const dx = particles[i].x - particles[j].x;
            const dy = particles[i].y - particles[j].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < LINK_DISTANCE) {
              const opacity = 1 - dist / LINK_DISTANCE;
              ctx.beginPath();
              ctx.moveTo(particles[i].x, particles[i].y);
              ctx.lineTo(particles[j].x, particles[j].y);
              ctx.strokeStyle = 'rgba(102, 126, 234, ' + (opacity * 0.4) + ')';
              ctx.stroke();
            }
          }
        }
        requestAnimationFrame(animate);
      }
      animate();
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
    "fps": 60,
    "interactive": true,
    "audio": false,
    "mouseTracking": false
  },
  "theme": {
    "primaryColor": "#667eea",
    "backgroundColor": "#0a0a1a"
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
- Avoid heavy continuous animations — limit particle counts and `requestAnimationFrame` usage.
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
