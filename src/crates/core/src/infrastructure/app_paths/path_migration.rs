//! Path migration module — auto-migrate legacy data to unified install-dir layout.
//!
//! ## Migration strategy
//!
//! When the new unified layout (`<exe_dir>/data/`) is detected as empty but
//! legacy paths have data, the migration moves data from legacy paths to the
//! new layout. Migration is idempotent and safe to retry.
//!
//! ## Legacy paths (detected for migration)
//!
//! 1. `~/.config/ai00-x/` (or platform equivalent) — config, agents, data, cache,
//!    runtimes, logs, temp
//! 2. `~/.ai00-x/` — projects, remote_ssh
//! 3. `%LOCALAPPDATA%\Ai00-X\skills\` (Windows) — skills
//! 4. `%LOCALAPPDATA%\Ai00-X\ssh\` (Windows) — SSH data
//! 5. `<exe_dir>/workspaces/` — scratch/code/task
//!
//! ## Mark files
//!
//! After successful migration, a `MIGRATED_TO.json` mark file is written to
//! the legacy path. This file records the new path and migration timestamp,
//! allowing future runs to skip re-migration. The original data is NOT deleted;
//! users can manually clean up after confirming the migration succeeded.

use std::path::Path;

use crate::util::errors::{Ai00XError, Ai00XResult};

use super::path_manager::PathManager;

/// Name of the mark file written to legacy paths after successful migration.
const MIGRATED_MARK_FILENAME: &str = "MIGRATED_TO.json";

/// Type alias for migration functions.
type MigrationFn = fn(&PathManager) -> Ai00XResult<bool>;

/// Run all migrations (called once at startup).
///
/// Each migration is independent — failure of one does not block others.
/// All errors are logged and converted to warnings (non-fatal).
pub async fn run_all_migrations(pm: &PathManager) {
    log::info!("[path_migration] checking for legacy data to migrate...");

    let migrations: Vec<(&str, MigrationFn)> = vec![
        ("legacy_user_config", migrate_legacy_user_config),
        ("legacy_ai00x_home", migrate_legacy_ai00x_home),
        ("legacy_skills", migrate_legacy_skills),
        ("legacy_ssh", migrate_legacy_ssh),
        ("legacy_workspaces", migrate_legacy_workspaces),
        // Must run AFTER legacy_user_config — moves vault/ui_prefs files
        // from the migrated data/data/ location (or legacy data dir) into
        // the new profile/ layout used by auth_vault/kv_store/ui_prefs.
        ("vault_to_profile", migrate_vault_to_profile),
    ];

    for (name, migrator) in migrations {
        match migrator(pm) {
            Ok(migrated) => {
                if migrated {
                    log::info!("[path_migration] {} → migrated successfully", name);
                }
            }
            Err(e) => {
                log::warn!("[path_migration] {} → failed (non-fatal): {}", name, e);
            }
        }
    }
}

/// Migrate legacy user config root (`~/.config/ai00-x/`) → `<exe_dir>/data/`
///
/// Migrates: config/, agents/, cache/, logs/, temp/
/// Note: `data/` subdirectory (containing usage_stats, token_usage, etc.) is also migrated.
/// Note: `runtimes/` is renamed to `managed_runtimes/` during migration.
///
/// Returns `Ok(true)` if any data was migrated, `Ok(false)` if nothing to migrate.
fn migrate_legacy_user_config(pm: &PathManager) -> Ai00XResult<bool> {
    let legacy_root = pm.legacy_user_config_root();

    if !legacy_root.exists() {
        return Ok(false);
    }

    // Check if already migrated (mark file exists)
    let mark_file = legacy_root.join(MIGRATED_MARK_FILENAME);
    if mark_file.exists() {
        return Ok(false);
    }

    let new_root = pm.install_data_root();
    let mut migrated_any = false;

    // Subdirectory migration mapping: legacy_name → new_name
    // (legacy "data" → new "data" nested; legacy "runtimes" → "managed_runtimes")
    let subdir_mapping: Vec<(&str, &str)> = vec![
        ("config", "config"),
        ("agents", "agents"),
        ("data", "data"),
        ("cache", "cache"),
        ("logs", "logs"),
        ("temp", "temp"),
        ("runtimes", "managed_runtimes"), // renamed to avoid conflict
    ];

    for (legacy_sub, new_sub) in subdir_mapping {
        let legacy_path = legacy_root.join(legacy_sub);
        let new_path = new_root.join(new_sub);

        if !legacy_path.exists() {
            continue;
        }

        // Skip if new path already has data (avoid overwriting)
        if new_path.exists() && is_dir_non_empty(&new_path) {
            log::debug!(
                "[path_migration] skip {}: target already has data at {}",
                legacy_path.display(),
                new_path.display()
            );
            continue;
        }

        match migrate_dir_blocking(&legacy_path, &new_path) {
            Ok(_) => {
                log::info!(
                    "[path_migration] moved {} → {}",
                    legacy_path.display(),
                    new_path.display()
                );
                migrated_any = true;
            }
            Err(e) => {
                log::warn!(
                    "[path_migration] failed to move {} → {}: {}",
                    legacy_path.display(),
                    new_path.display(),
                    e
                );
            }
        }
    }

    // Write mark file
    if migrated_any {
        write_mark_file(&mark_file, &new_root)?;
    }

    Ok(migrated_any)
}

/// Migrate legacy Ai00-X home (`~/.ai00-x/`) → `<exe_dir>/data/`
///
/// Migrates: projects/, remote_ssh/
fn migrate_legacy_ai00x_home(pm: &PathManager) -> Ai00XResult<bool> {
    let legacy_home = pm.legacy_ai00x_home_dir();

    if !legacy_home.exists() {
        return Ok(false);
    }

    // Check if already migrated
    let mark_file = legacy_home.join(MIGRATED_MARK_FILENAME);
    if mark_file.exists() {
        return Ok(false);
    }

    let new_root = pm.install_data_root();
    let mut migrated_any = false;

    let subdirs = ["projects", "remote_ssh"];
    for sub in subdirs {
        let legacy_path = legacy_home.join(sub);
        let new_path = new_root.join(sub);

        if !legacy_path.exists() {
            continue;
        }

        if new_path.exists() && is_dir_non_empty(&new_path) {
            log::debug!(
                "[path_migration] skip {}: target already has data at {}",
                legacy_path.display(),
                new_path.display()
            );
            continue;
        }

        match migrate_dir_blocking(&legacy_path, &new_path) {
            Ok(_) => {
                log::info!(
                    "[path_migration] moved {} → {}",
                    legacy_path.display(),
                    new_path.display()
                );
                migrated_any = true;
            }
            Err(e) => {
                log::warn!(
                    "[path_migration] failed to move {} → {}: {}",
                    legacy_path.display(),
                    new_path.display(),
                    e
                );
            }
        }
    }

    if migrated_any {
        write_mark_file(&mark_file, &new_root)?;
    }

    Ok(migrated_any)
}

/// Migrate legacy skills directory (`%LOCALAPPDATA%\Ai00-X\skills\`) → `<exe_dir>/data/skills/`
fn migrate_legacy_skills(pm: &PathManager) -> Ai00XResult<bool> {
    let legacy_skills = pm.legacy_user_skills_dir();

    if !legacy_skills.exists() {
        return Ok(false);
    }

    // Mark file goes in parent (legacy Ai00-X data dir), not inside skills/
    let mark_file = legacy_skills
        .parent()
        .map(|p| p.join(MIGRATED_MARK_FILENAME))
        .unwrap_or_else(|| legacy_skills.join(MIGRATED_MARK_FILENAME));
    if mark_file.exists() {
        return Ok(false);
    }

    let new_skills = pm.user_skills_dir();

    if new_skills.exists() && is_dir_non_empty(&new_skills) {
        log::debug!(
            "[path_migration] skip skills: target already has data at {}",
            new_skills.display()
        );
        return Ok(false);
    }

    let mut migrated_any = false;
    match migrate_dir_blocking(&legacy_skills, &new_skills) {
        Ok(_) => {
            log::info!(
                "[path_migration] moved skills {} → {}",
                legacy_skills.display(),
                new_skills.display()
            );
            write_mark_file(&mark_file, &new_skills)?;
            migrated_any = true;
        }
        Err(e) => {
            log::warn!(
                "[path_migration] failed to move skills {} → {}: {}",
                legacy_skills.display(),
                new_skills.display(),
                e
            );
        }
    }

    Ok(migrated_any)
}

/// Migrate legacy SSH directory (`%LOCALAPPDATA%\Ai00-X\ssh\`) → split into:
/// - `<exe_dir>/data/profile/ssh/` (connections, known_hosts, remote_workspace — sync-able)
/// - `<exe_dir>/data/ssh_secrets/` (password vault — not migrated)
fn migrate_legacy_ssh(pm: &PathManager) -> Ai00XResult<bool> {
    let legacy_ssh = pm.legacy_ssh_dir();

    if !legacy_ssh.exists() {
        return Ok(false);
    }

    let mark_file = legacy_ssh.join(MIGRATED_MARK_FILENAME);
    if mark_file.exists() {
        return Ok(false);
    }

    let new_connections = pm.ssh_connections_dir();
    let new_secrets = pm.ssh_secrets_dir();

    // Files to migrate to profile/ssh/ (sync-able)
    let sync_files = [
        "ssh_connections.json",
        "known_hosts",
        "remote_workspace.json",
    ];
    // Files to migrate to ssh_secrets/ (sensitive, not synced)
    let secret_files = ["ssh_password_vault.json", ".ssh_password_vault.key"];

    let mut migrated_any = false;

    // Ensure target directories exist
    std::fs::create_dir_all(&new_connections).map_err(|e| {
        Ai00XError::service(format!(
            "Failed to create {}: {}",
            new_connections.display(),
            e
        ))
    })?;
    std::fs::create_dir_all(&new_secrets).map_err(|e| {
        Ai00XError::service(format!("Failed to create {}: {}", new_secrets.display(), e))
    })?;

    // Migrate sync-able files
    for filename in sync_files {
        let legacy_path = legacy_ssh.join(filename);
        let new_path = new_connections.join(filename);

        if !legacy_path.exists() {
            continue;
        }

        if new_path.exists() {
            log::debug!(
                "[path_migration] skip ssh file {}: target exists at {}",
                legacy_path.display(),
                new_path.display()
            );
            continue;
        }

        match migrate_file_blocking(&legacy_path, &new_path) {
            Ok(_) => {
                log::info!(
                    "[path_migration] moved ssh file {} → {}",
                    legacy_path.display(),
                    new_path.display()
                );
                migrated_any = true;
            }
            Err(e) => {
                log::warn!(
                    "[path_migration] failed to move ssh file {} → {}: {}",
                    legacy_path.display(),
                    new_path.display(),
                    e
                );
            }
        }
    }

    // Migrate secret files
    for filename in secret_files {
        let legacy_path = legacy_ssh.join(filename);
        let new_path = new_secrets.join(filename);

        if !legacy_path.exists() {
            continue;
        }

        if new_path.exists() {
            continue;
        }

        match migrate_file_blocking(&legacy_path, &new_path) {
            Ok(_) => {
                log::info!(
                    "[path_migration] moved ssh secret {} → {}",
                    legacy_path.display(),
                    new_path.display()
                );
                migrated_any = true;
            }
            Err(e) => {
                log::warn!(
                    "[path_migration] failed to move ssh secret {} → {}: {}",
                    legacy_path.display(),
                    new_path.display(),
                    e
                );
            }
        }
    }

    if migrated_any {
        write_mark_file(&mark_file, &new_connections)?;
    }

    Ok(migrated_any)
}

/// Migrate legacy workspaces (`<exe_dir>/workspaces/`) → `<exe_dir>/data/workspaces/`
fn migrate_legacy_workspaces(pm: &PathManager) -> Ai00XResult<bool> {
    let exe_dir = PathManager::exe_dir()?;
    let legacy_workspaces = exe_dir.join("workspaces");

    if !legacy_workspaces.exists() {
        return Ok(false);
    }

    let mark_file = legacy_workspaces.join(MIGRATED_MARK_FILENAME);
    if mark_file.exists() {
        return Ok(false);
    }

    // New workspace path is under install_data_root/workspaces/
    let new_workspaces = pm.install_data_root().join("workspaces");

    if new_workspaces.exists() && is_dir_non_empty(&new_workspaces) {
        log::debug!(
            "[path_migration] skip workspaces: target already has data at {}",
            new_workspaces.display()
        );
        return Ok(false);
    }

    let mut migrated_any = false;
    match migrate_dir_blocking(&legacy_workspaces, &new_workspaces) {
        Ok(_) => {
            log::info!(
                "[path_migration] moved workspaces {} → {}",
                legacy_workspaces.display(),
                new_workspaces.display()
            );
            write_mark_file(&mark_file, &new_workspaces)?;
            migrated_any = true;
        }
        Err(e) => {
            log::warn!(
                "[path_migration] failed to move workspaces {} → {}: {}",
                legacy_workspaces.display(),
                new_workspaces.display(),
                e
            );
        }
    }

    Ok(migrated_any)
}

/// Migrate vault/ui_prefs files from old `data/data/` location (or legacy
/// `~/.config/ai00-x/data/`) into the new `profile/` layout.
///
/// Old layout (pre-refactor):
/// - `<exe_dir>/data/data/.user_auth_vault.key`, `user_auth_vault.json`
/// - `<exe_dir>/data/data/.user_kv_vault.key`, `user_kv_vault.json`
/// - `<exe_dir>/data/data/ui_prefs.json`
///
/// New layout (post-refactor):
/// - `<exe_dir>/data/profile/auth_vault/.user_auth_vault.key`, `user_auth_vault.json`
/// - `<exe_dir>/data/profile/kv_vault/.user_kv_vault.key`, `user_kv_vault.json`
/// - `<exe_dir>/data/profile/ui_prefs.json`
///
/// Runs after `migrate_legacy_user_config`, so the source files may be either
/// at the legacy path (if that migration was skipped) or at the migrated
/// `<exe_dir>/data/data/` path. We check both.
fn migrate_vault_to_profile(pm: &PathManager) -> Ai00XResult<bool> {
    let mark_filename = "MIGRATED_VAULT_TO_PROFILE.json";

    // Skip if already migrated (mark file in install_data_root)
    let mark_file = pm.install_data_root().join(mark_filename);
    if mark_file.exists() {
        return Ok(false);
    }

    // Candidate source directories (in priority order):
    // 1. <exe_dir>/data/data/  (after migrate_legacy_user_config has run)
    // 2. ~/.config/ai00-x/data/ (legacy path, if migration was skipped)
    let new_data_dir = pm.user_data_dir();
    let legacy_data_dir = pm.legacy_user_config_root().join("data");

    let source_dir = if new_data_dir.exists() && has_vault_files(&new_data_dir) {
        new_data_dir
    } else if legacy_data_dir.exists() && has_vault_files(&legacy_data_dir) {
        legacy_data_dir
    } else {
        // Nothing to migrate — write mark file to skip future checks
        write_mark_file(&mark_file, &pm.profile_dir())?;
        return Ok(false);
    };

    // File mapping: (source filename, target subdir, target filename)
    // Empty target subdir means file goes directly to profile_dir/
    let file_mapping: &[(&str, &str, &str)] = &[
        // auth_vault
        (".user_auth_vault.key", "auth_vault", ".user_auth_vault.key"),
        ("user_auth_vault.json", "auth_vault", "user_auth_vault.json"),
        // kv_vault
        (".user_kv_vault.key", "kv_vault", ".user_kv_vault.key"),
        ("user_kv_vault.json", "kv_vault", "user_kv_vault.json"),
        // ui_prefs (goes directly to profile_dir, no subdir)
        ("ui_prefs.json", "", "ui_prefs.json"),
    ];

    let profile_dir = pm.profile_dir();
    let mut migrated_any = false;

    for (src_name, subdir, dst_name) in file_mapping {
        let src = source_dir.join(src_name);
        if !src.exists() {
            continue;
        }

        let dst = if subdir.is_empty() {
            profile_dir.join(dst_name)
        } else {
            profile_dir.join(subdir).join(dst_name)
        };

        // Skip if destination already exists (don't overwrite)
        if dst.exists() {
            log::debug!(
                "[path_migration] skip vault file {}: target exists at {}",
                src.display(),
                dst.display()
            );
            continue;
        }

        match migrate_file_blocking(&src, &dst) {
            Ok(_) => {
                log::info!(
                    "[path_migration] moved vault file {} → {}",
                    src.display(),
                    dst.display()
                );
                migrated_any = true;
            }
            Err(e) => {
                log::warn!(
                    "[path_migration] failed to move vault file {} → {}: {}",
                    src.display(),
                    dst.display(),
                    e
                );
            }
        }
    }

    // Always write mark file (even if nothing migrated) to avoid re-scanning
    write_mark_file(&mark_file, &profile_dir)?;

    Ok(migrated_any)
}

/// Check if a directory contains any vault/ui_prefs files.
fn has_vault_files(dir: &Path) -> bool {
    let targets = [
        ".user_auth_vault.key",
        "user_auth_vault.json",
        ".user_kv_vault.key",
        "user_kv_vault.json",
        "ui_prefs.json",
    ];
    targets.iter().any(|name| dir.join(name).exists())
}

// === Helper functions ===

/// Synchronous directory move (used during startup before async runtime is needed).
///
/// Tries `rename` first (fast, same-filesystem). Falls back to recursive copy + delete
/// on cross-filesystem moves.
fn migrate_dir_blocking(from: &Path, to: &Path) -> Ai00XResult<()> {
    // Ensure parent exists
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Ai00XError::service(format!(
                "Failed to create parent dir {}: {}",
                parent.display(),
                e
            ))
        })?;
    }

    // Try fast rename first
    match std::fs::rename(from, to) {
        Ok(_) => Ok(()),
        Err(_) => {
            // Fallback: recursive copy + delete (for cross-filesystem moves)
            copy_dir_recursive(from, to)?;
            std::fs::remove_dir_all(from).map_err(|e| {
                Ai00XError::service(format!(
                    "Failed to remove source dir {} after copy: {}",
                    from.display(),
                    e
                ))
            })?;
            Ok(())
        }
    }
}

/// Synchronous file move.
fn migrate_file_blocking(from: &Path, to: &Path) -> Ai00XResult<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Ai00XError::service(format!(
                "Failed to create parent dir {}: {}",
                parent.display(),
                e
            ))
        })?;
    }

    std::fs::rename(from, to).or_else(|_| {
        // Fallback: copy + delete
        std::fs::copy(from, to).map_err(|e| {
            Ai00XError::service(format!(
                "Failed to copy {} → {}: {}",
                from.display(),
                to.display(),
                e
            ))
        })?;
        std::fs::remove_file(from).map_err(|e| {
            Ai00XError::service(format!(
                "Failed to remove source file {} after copy: {}",
                from.display(),
                e
            ))
        })?;
        Ok(())
    })
}

/// Recursive directory copy (fallback when rename fails).
fn copy_dir_recursive(from: &Path, to: &Path) -> Ai00XResult<()> {
    std::fs::create_dir_all(to).map_err(|e| {
        Ai00XError::service(format!("Failed to create dir {}: {}", to.display(), e))
    })?;

    for entry in std::fs::read_dir(from)
        .map_err(|e| Ai00XError::service(format!("Failed to read dir {}: {}", from.display(), e)))?
    {
        let entry =
            entry.map_err(|e| Ai00XError::service(format!("Failed to read dir entry: {}", e)))?;
        let path = entry.path();
        let file_name = entry.file_name();
        let dest = to.join(&file_name);

        let metadata = entry
            .metadata()
            .map_err(|e| Ai00XError::service(format!("Failed to read metadata: {}", e)))?;

        if metadata.is_dir() {
            copy_dir_recursive(&path, &dest)?;
        } else {
            std::fs::copy(&path, &dest).map_err(|e| {
                Ai00XError::service(format!(
                    "Failed to copy {} → {}: {}",
                    path.display(),
                    dest.display(),
                    e
                ))
            })?;
        }
    }

    Ok(())
}

/// Check if a directory has any entries.
fn is_dir_non_empty(path: &Path) -> bool {
    std::fs::read_dir(path)
        .map(|mut iter| iter.next().is_some())
        .unwrap_or(false)
}

/// Write a mark file indicating migration target.
fn write_mark_file(mark_path: &Path, target: &Path) -> Ai00XResult<()> {
    let content = serde_json::json!({
        "migrated_to": target,
        "migrated_at": chrono::Utc::now().to_rfc3339(),
        "note": "Legacy data has been migrated. You can safely delete this legacy directory after confirming the migration succeeded."
    });

    if let Some(parent) = mark_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Ai00XError::service(format!("Failed to create mark file parent dir: {}", e))
        })?;
    }

    let json = serde_json::to_string_pretty(&content)
        .map_err(|e| Ai00XError::service(format!("Failed to serialize mark file: {}", e)))?;

    std::fs::write(mark_path, json).map_err(|e| {
        Ai00XError::service(format!(
            "Failed to write mark file {}: {}",
            mark_path.display(),
            e
        ))
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Helper: create a unique temp dir under std::env::temp_dir().
    fn make_temp_dir(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("ai00-x-test-{}-{}", name, std::process::id()));
        // Clean up if exists from previous run
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_migrate_dir_blocking_same_filesystem() {
        let tmp = make_temp_dir("migrate_dir");
        let from = tmp.join("from");
        let to = tmp.join("to");

        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("file.txt"), "hello").unwrap();

        migrate_dir_blocking(&from, &to).unwrap();

        assert!(to.exists());
        assert!(to.join("file.txt").exists());
        assert!(!from.exists()); // source removed

        // Cleanup
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_is_dir_non_empty() {
        let tmp = make_temp_dir("dir_non_empty");
        let empty = tmp.join("empty");
        let nonempty = tmp.join("nonempty");

        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&nonempty).unwrap();
        std::fs::write(nonempty.join("file.txt"), "x").unwrap();

        assert!(!is_dir_non_empty(&empty));
        assert!(is_dir_non_empty(&nonempty));

        // Cleanup
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_write_mark_file() {
        let tmp = make_temp_dir("mark_file");
        let mark = tmp.join("MIGRATED_TO.json");
        let target = tmp.join("new_location");

        write_mark_file(&mark, &target).unwrap();

        assert!(mark.exists());
        let content = std::fs::read_to_string(&mark).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(json["migrated_to"], target.to_string_lossy().to_string());

        // Cleanup
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
