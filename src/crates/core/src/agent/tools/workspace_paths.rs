//! Workspace path resolution for agent tools.
//!
//! When Ai00-X runs on Windows but the open workspace is a **remote SSH** (POSIX) tree,
//! `std::path::Path` treats paths like `/home/user/proj` as non-absolute and joins them
//! incorrectly. Remote sessions must use POSIX path semantics for tool arguments.

use crate::util::errors::{Ai00XError, Ai00XResult};
use std::path::{Component, Path, PathBuf};

pub const AI00X_RUNTIME_URI_PREFIX: &str = "ai00-x://runtime/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAi00XRuntimeUri {
    pub workspace_scope: String,
    pub relative_path: String,
}

pub fn normalize_path(path: &str) -> String {
    let path = Path::new(path);
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !components.is_empty() {
                    components.pop();
                }
            }
            c => components.push(c),
        }
    }
    components
        .iter()
        .collect::<PathBuf>()
        .to_string_lossy()
        .to_string()
}

pub fn resolve_path_with_workspace(
    path: &str,
    workspace_root: Option<&Path>,
) -> Ai00XResult<String> {
    let resolved = if Path::new(path).is_absolute() {
        normalize_path(path)
    } else {
        let base_path = workspace_root.ok_or_else(|| {
            Ai00XError::tool(format!(
                "A workspace path is required to resolve relative path: {}",
                path
            ))
        })?;

        normalize_path(base_path.join(path).to_string_lossy().as_ref())
    };

    if let Some(root) = workspace_root {
        ensure_within_workspace_local(&resolved, root)?;
    }

    Ok(resolved)
}

pub fn resolve_path(path: &str) -> Ai00XResult<String> {
    resolve_path_with_workspace(path, None)
}

pub fn is_ai00x_runtime_uri(path: &str) -> bool {
    path.trim().starts_with(AI00X_RUNTIME_URI_PREFIX)
}

pub fn normalize_runtime_relative_path(path: &str) -> Ai00XResult<String> {
    let normalized = path.trim().replace('\\', "/");
    let trimmed = normalized.trim_matches('/');
    if trimmed.is_empty() {
        return Err(Ai00XError::tool(
            "Runtime artifact path cannot be empty".to_string(),
        ));
    }

    let mut segments = Vec::new();
    for part in trimmed.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                return Err(Ai00XError::tool(
                    "Runtime artifact path cannot escape its root".to_string(),
                ))
            }
            value => segments.push(value.to_string()),
        }
    }

    if segments.is_empty() {
        return Err(Ai00XError::tool(
            "Runtime artifact path cannot be empty".to_string(),
        ));
    }

    Ok(segments.join("/"))
}

pub fn parse_ai00x_runtime_uri(path: &str) -> Ai00XResult<ParsedAi00XRuntimeUri> {
    let trimmed = path.trim();
    let suffix = trimmed
        .strip_prefix(AI00X_RUNTIME_URI_PREFIX)
        .ok_or_else(|| Ai00XError::tool(format!("Unsupported runtime URI: {}", path)))?;

    let mut parts = suffix.splitn(2, '/');
    let workspace_scope = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Ai00XError::tool("Runtime URI is missing workspace scope".to_string()))?
        .to_string();
    let relative_path = parts
        .next()
        .ok_or_else(|| Ai00XError::tool("Runtime URI is missing artifact path".to_string()))?;

    Ok(ParsedAi00XRuntimeUri {
        workspace_scope,
        relative_path: normalize_runtime_relative_path(relative_path)?,
    })
}

pub fn build_ai00x_runtime_uri(workspace_scope: &str, relative_path: &str) -> Ai00XResult<String> {
    let scope = workspace_scope.trim();
    if scope.is_empty() {
        return Err(Ai00XError::tool(
            "Runtime URI workspace scope cannot be empty".to_string(),
        ));
    }

    Ok(format!(
        "{}{}/{}",
        AI00X_RUNTIME_URI_PREFIX,
        scope,
        normalize_runtime_relative_path(relative_path)?
    ))
}

/// POSIX absolute: after normalizing backslashes, path starts with `/`.
pub fn posix_style_path_is_absolute(path: &str) -> bool {
    let p = path.trim().replace('\\', "/");
    p.starts_with('/')
}

fn posix_normalize_components(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    let is_abs = path.starts_with('/');
    let mut stack: Vec<String> = Vec::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            stack.pop();
        } else {
            stack.push(part.to_string());
        }
    }
    let body = stack.join("/");
    if is_abs {
        format!("/{}", body)
    } else {
        body
    }
}

/// Resolve a path using POSIX rules (for remote SSH workspaces).
pub fn posix_resolve_path_with_workspace(
    path: &str,
    workspace_root: Option<&str>,
) -> Ai00XResult<String> {
    let path = path.trim();
    if path.is_empty() {
        return Err(Ai00XError::tool("path cannot be empty".to_string()));
    }

    let normalized_input = path.replace('\\', "/");

    let combined = if posix_style_path_is_absolute(&normalized_input) {
        normalized_input
    } else {
        let base = workspace_root
            .ok_or_else(|| {
                Ai00XError::tool(format!(
                    "A workspace path is required to resolve relative path: {}",
                    path
                ))
            })?
            .trim()
            .replace('\\', "/");
        let base = base.trim_end_matches('/');
        format!("{}/{}", base, normalized_input)
    };

    let resolved = posix_normalize_components(&combined);

    if let Some(root) = workspace_root {
        let root_normalized = posix_normalize_components(&root.trim().replace('\\', "/"));
        ensure_within_workspace_posix(&resolved, &root_normalized)?;
    }

    Ok(resolved)
}

/// Unified resolver: POSIX semantics when the workspace is remote SSH; otherwise host `Path`.
pub fn resolve_workspace_tool_path(
    path: &str,
    workspace_root: Option<&str>,
    workspace_is_remote: bool,
) -> Ai00XResult<String> {
    if workspace_is_remote {
        posix_resolve_path_with_workspace(path, workspace_root)
    } else {
        resolve_path_with_workspace(path, workspace_root.map(Path::new))
    }
}

/// Check that `resolved_path` is within the workspace sandbox (local filesystem).
///
/// Uses `dunce::canonicalize` to resolve symlinks and normalize paths before
/// comparing. For paths that do not exist yet (e.g. write operations), walks
/// up to the nearest existing ancestor for canonicalization.
///
/// Also allows paths within the Ai00-X runtime storage directory (`.ai00-x/projects/`)
/// so that session-scoped files like PLAN.md can be edited by the agent.
fn ensure_within_workspace_local(resolved_path: &str, workspace_root: &Path) -> Ai00XResult<()> {
    let resolved_canonical = canonicalize_best_effort(Path::new(resolved_path));

    let root_canonical = dunce::canonicalize(workspace_root)
        .unwrap_or_else(|_| normalize_path(&workspace_root.to_string_lossy()).into());

    if resolved_canonical.starts_with(&root_canonical) {
        return Ok(());
    }

    let runtime_root = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ai00-x")
        .join("projects");
    let runtime_canonical = canonicalize_best_effort(&runtime_root);

    if resolved_canonical.starts_with(&runtime_canonical) {
        return Ok(());
    }

    Err(Ai00XError::tool(format!(
        "Sandbox violation: path \"{}\" is outside the workspace \"{}\"",
        resolved_path,
        workspace_root.display()
    )))
}

/// Canonicalize a path, falling back to normalized string if the path does not exist.
fn canonicalize_best_effort(path: &Path) -> PathBuf {
    match dunce::canonicalize(path) {
        Ok(canonical) => canonical,
        Err(_) => {
            if let Some(parent) = path.parent() {
                if parent.as_os_str().is_empty() {
                    normalize_path(&path.to_string_lossy()).into()
                } else {
                    let parent_canonical = canonicalize_best_effort(parent);
                    if let Some(filename) = path.file_name() {
                        parent_canonical.join(filename)
                    } else {
                        parent_canonical
                    }
                }
            } else {
                normalize_path(&path.to_string_lossy()).into()
            }
        }
    }
}

/// Check that `resolved` is within `root` using POSIX normalized path prefix comparison.
fn ensure_within_workspace_posix(resolved: &str, root: &str) -> Ai00XResult<()> {
    if resolved == root {
        return Ok(());
    }

    let root_with_sep = format!("{}/", root.trim_end_matches('/'));

    if !resolved.starts_with(&root_with_sep) {
        return Err(Ai00XError::tool(format!(
            "Sandbox violation: path \"{}\" is outside the workspace \"{}\"",
            resolved, root
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_paths_from_workspace_root() {
        let tmp = std::env::temp_dir().join("ai00-x-test-workspace");
        let _ = std::fs::create_dir_all(tmp.join("src"));
        let src_main = tmp.join("src").join("main.rs");
        std::fs::write(&src_main, b"").unwrap();

        let resolved =
            resolve_path_with_workspace("src/main.rs", Some(&tmp)).expect("path should resolve");

        let expected = dunce::canonicalize(&src_main).unwrap();
        assert_eq!(dunce::canonicalize(Path::new(&resolved)).unwrap(), expected);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn rejects_absolute_path_outside_workspace() {
        let tmp = std::env::temp_dir().join("ai00-x-test-ws-sandbox");
        let _ = std::fs::create_dir_all(&tmp);

        let outside = std::env::temp_dir().join("ai00-x-test-outside");
        let _ = std::fs::create_dir_all(&outside);

        let err = resolve_path_with_workspace(&outside.to_string_lossy(), Some(&tmp))
            .expect_err("should reject path outside workspace");

        assert!(err.to_string().contains("Sandbox violation"));

        std::fs::remove_dir_all(&tmp).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn rejects_path_traversal_outside_workspace() {
        let tmp = std::env::temp_dir().join("ai00-x-test-ws-traversal");
        let _ = std::fs::create_dir_all(&tmp);

        let err = resolve_path_with_workspace("../../outside", Some(&tmp))
            .expect_err("should reject .. traversal outside workspace");

        assert!(err.to_string().contains("Sandbox violation"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn allows_path_within_workspace() {
        let tmp = std::env::temp_dir().join("ai00-x-test-ws-valid");
        let _ = std::fs::create_dir_all(tmp.join("sub").join("deep"));
        std::fs::write(tmp.join("sub").join("deep").join("file.txt"), b"hello").unwrap();

        let resolved = resolve_path_with_workspace("sub/deep/file.txt", Some(&tmp))
            .expect("should allow path within workspace");

        let expected = dunce::canonicalize(tmp.join("sub").join("deep").join("file.txt")).unwrap();
        assert_eq!(dunce::canonicalize(Path::new(&resolved)).unwrap(), expected);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn posix_absolute_starts_with_slash() {
        let r =
            posix_resolve_path_with_workspace("/home/user/file.txt", Some("/should/not/matter"))
                .unwrap_err();
        assert!(r.to_string().contains("Sandbox violation"));
    }

    #[test]
    fn posix_relative_joins_workspace() {
        let r = posix_resolve_path_with_workspace("src/main.rs", Some("/home/proj")).unwrap();
        assert_eq!(r, "/home/proj/src/main.rs");
    }

    #[test]
    fn posix_rejects_absolute_outside_workspace() {
        let err = posix_resolve_path_with_workspace("/etc/passwd", Some("/home/proj"))
            .expect_err("should reject path outside workspace");
        assert!(err.to_string().contains("Sandbox violation"));
    }

    #[test]
    fn posix_allows_path_within_workspace() {
        let r = posix_resolve_path_with_workspace("/home/proj/src/main.rs", Some("/home/proj"))
            .unwrap();
        assert_eq!(r, "/home/proj/src/main.rs");
    }

    #[test]
    fn runtime_uri_round_trips_and_normalizes_separators() {
        let uri = build_ai00x_runtime_uri("workspace-123", r"plans\demo.plan.md").unwrap();
        assert_eq!(uri, "ai00-x://runtime/workspace-123/plans/demo.plan.md");

        let parsed = parse_ai00x_runtime_uri(&uri).unwrap();
        assert_eq!(parsed.workspace_scope, "workspace-123");
        assert_eq!(parsed.relative_path, "plans/demo.plan.md");
    }

    #[test]
    fn runtime_uri_rejects_parent_directory_escape() {
        let err = build_ai00x_runtime_uri("workspace-123", "../secret.txt")
            .expect_err("runtime URI should reject parent directory escape");

        assert!(err.to_string().contains("cannot escape"));
    }
}
