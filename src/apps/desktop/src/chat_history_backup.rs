//! Chat history backup module — encrypted export/import of all chat sessions.
//!
//! Backs up the entire `<exe_dir>/data/projects/` directory (which contains
//! all workspace sessions, snapshots, plans, memory) into an encrypted archive
//! the user can manually transfer (USB drive, cloud storage) between devices.
//!
//! ## Archive format
//!
//! ```text
//! [9 bytes:  magic "AI00XBAK1"]    ← magic + version
//! [16 bytes: salt]                  ← Argon2id password-derivation salt
//! [12 bytes: nonce]                 ← AES-GCM nonce
//! [rest:     ciphertext]            ← AES-GCM-encrypted tar.gz stream
//! ```
//!
//! ## Security notes
//!
//! - Password never leaves the user's brain (only Argon2-derived 32-byte key is used).
//! - Argon2id with default params (m=19456 KiB, t=2, p=1) — slow on purpose.
//! - AES-GCM provides authenticated encryption (tamper detection).
//! - On wrong password: AES-GCM tag verification fails → error returned.
//!
//! ## What is included
//!
//! All files under `projects_root()`:
//! - `projects/<workspace-slug>/sessions/<session_id>/{metadata,state,turns,snapshots}`
//! - `projects/<workspace-slug>/plans/`, `memory/`, `ai_memories.json`
//!
//! ## What is NOT included
//!
//! - `profile/` (synced separately via profile_sync)
//! - `auth_vault/`, `kv_vault/` (device-local keys)
//! - `ssh_secrets/` (sensitive SSH passwords)

use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use ai00_x_core::infrastructure::get_path_manager_arc;
use argon2::password_hash::SaltString;
use argon2::{Algorithm, Argon2, Params, Version};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Serialize;

/// Magic bytes prefixing every backup file ("AI00XBAK1").
const MAGIC: &[u8; 9] = b"AI00XBAK1";

/// Salt size in bytes (Argon2 SaltString uses 22-byte base64 of 16 raw bytes,
/// we store the 16 raw bytes for compactness and reproducibility).
const SALT_LEN: usize = 16;

/// AES-GCM nonce length (96-bit, standard for GCM).
const NONCE_LEN: usize = 12;

/// Backup operation summary returned to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct BackupResult {
    /// Number of files processed (added to archive on export, extracted on import).
    pub files: usize,
    /// Total bytes of the resulting plaintext archive (export) or extracted
    /// content (import). Useful for showing "backed up 12.4 MB".
    pub bytes: u64,
    /// Path to the resulting file (export) or restored root (import).
    pub path: String,
}

/// Derive a 32-byte AES-256 key from password + salt using Argon2id.
fn derive_key(password: &str, salt_bytes: &[u8]) -> Result<[u8; 32], String> {
    // Argon2id with default params (m=19456 KiB, t=2, p=1) — secure but slow.
    let params = Params::new(19_456, 2, 1, Some(32)).map_err(|e| format!("argon2 params: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    // SaltString::encode_b64 expects raw bytes and returns base64-encoded form.
    let salt = SaltString::encode_b64(salt_bytes).map_err(|e| format!("argon2 salt: {e}"))?;

    let mut key_out = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt.as_str().as_bytes(), &mut key_out)
        .map_err(|e| format!("argon2 hash: {e}"))?;
    Ok(key_out)
}

/// Walk a directory recursively and add all files to the tar builder.
///
/// `base` is the root directory; entries are stored with paths relative to `base`.
/// Returns `(file_count, total_bytes)`.
fn add_dir_to_tar<W: Write>(
    builder: &mut tar::Builder<W>,
    base: &Path,
    rel_prefix: &Path,
) -> Result<(usize, u64), String> {
    let mut files = 0usize;
    let mut bytes = 0u64;

    let entries = match fs::read_dir(base) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // Nothing to back up — not an error
            return Ok((0, 0));
        }
        Err(e) => return Err(format!("read_dir {}: {}", base.display(), e)),
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!(
                    "[chat_backup] skip unreadable entry in {}: {}",
                    base.display(),
                    e
                );
                continue;
            }
        };
        let path = entry.path();
        let file_name = entry.file_name();
        let rel_path = rel_prefix.join(&file_name);

        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(e) => {
                log::warn!(
                    "[chat_backup] skip {} (file_type error): {}",
                    path.display(),
                    e
                );
                continue;
            }
        };

        if file_type.is_dir() {
            let (f, b) = add_dir_to_tar(builder, &path, &rel_path)?;
            files += f;
            bytes += b;
        } else if file_type.is_file() {
            match fs::read(&path) {
                Ok(data) => {
                    let mut header = tar::Header::new_gnu();
                    header
                        .set_path(&rel_path)
                        .map_err(|e| format!("set_path {} failed: {}", rel_path.display(), e))?;
                    header.set_size(data.len() as u64);
                    header.set_mode(0o644);
                    header.set_cksum();
                    builder
                        .append(&header, Cursor::new(&data))
                        .map_err(|e| format!("append {}: {}", path.display(), e))?;
                    files += 1;
                    bytes += data.len() as u64;
                }
                Err(e) => {
                    log::warn!("[chat_backup] skip {} (read error): {}", path.display(), e);
                }
            }
        }
        // Skip symlinks / sockets / etc.
    }

    Ok((files, bytes))
}

/// Export all chat history (entire `projects/` directory) into an encrypted archive.
///
/// - `password`: user-provided passphrase (any length; Argon2 stretches it).
/// - `output_path`: destination `.ai00x-backup` file path.
///
/// If `projects/` does not exist or is empty, returns an error (nothing to back up).
pub fn export_chat_history(password: &str, output_path: &Path) -> Result<BackupResult, String> {
    let pm = get_path_manager_arc();
    let projects_root = pm.projects_root();

    if !projects_root.exists() {
        return Err(format!(
            "projects directory not found: {}",
            projects_root.display()
        ));
    }

    // 1. Build tar in memory
    let mut tar_buf: Vec<u8> = Vec::with_capacity(8 * 1024 * 1024);
    let (file_count, source_bytes) = {
        let mut builder = tar::Builder::new(&mut tar_buf);
        let (files, bytes) = add_dir_to_tar(&mut builder, &projects_root, Path::new(""))?;
        if files == 0 {
            return Err("no files found in projects directory (nothing to back up)".to_string());
        }
        builder
            .finish()
            .map_err(|e| format!("tar finish failed: {e}"))?;
        log::info!("[chat_backup] tar built: {} files, {} bytes", files, bytes);
        (files, bytes)
    };

    // 2. Gzip-compress the tar
    let gz_buf = {
        let mut encoder = flate2::write::GzEncoder::new(
            Vec::with_capacity(tar_buf.len() / 2),
            flate2::Compression::default(),
        );
        encoder
            .write_all(&tar_buf)
            .map_err(|e| format!("gzip write failed: {e}"))?;
        encoder
            .finish()
            .map_err(|e| format!("gzip finish failed: {e}"))?
    };

    // 3. Derive AES-256 key from password + random salt
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);

    let key = derive_key(password, &salt)?;

    // 4. Generate random AES-GCM nonce
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // 5. Encrypt the gzip stream
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("aes init: {e}"))?;
    let ciphertext = cipher
        .encrypt(nonce, gz_buf.as_ref())
        .map_err(|e| format!("aes encrypt failed: {e}"))?;

    // 6. Write magic + salt + nonce + ciphertext
    let total_size = MAGIC.len() + SALT_LEN + NONCE_LEN + ciphertext.len();
    let mut out = fs::File::create(output_path)
        .map_err(|e| format!("create output {}: {}", output_path.display(), e))?;
    out.write_all(MAGIC)
        .map_err(|e| format!("write magic: {e}"))?;
    out.write_all(&salt)
        .map_err(|e| format!("write salt: {e}"))?;
    out.write_all(&nonce_bytes)
        .map_err(|e| format!("write nonce: {e}"))?;
    out.write_all(&ciphertext)
        .map_err(|e| format!("write ciphertext: {e}"))?;
    out.flush().map_err(|e| format!("flush: {e}"))?;
    drop(out);

    log::info!(
        "[chat_backup] export complete: {} ({} files, {}B source, {}B encrypted)",
        output_path.display(),
        file_count,
        source_bytes,
        total_size
    );

    Ok(BackupResult {
        files: file_count,
        bytes: total_size as u64,
        path: output_path.to_string_lossy().to_string(),
    })
}

/// Import chat history from an encrypted archive into `projects/`.
///
/// - `password`: passphrase used at export time.
/// - `input_path`: source `.ai00x-backup` file path.
///
/// Behavior:
/// - Existing files in `projects/` with the same relative path are overwritten.
/// - Files in `projects/` not present in the archive are left untouched (merge, not replace).
/// - On wrong password: returns an error (AES-GCM tag verification fails).
pub fn import_chat_history(password: &str, input_path: &Path) -> Result<BackupResult, String> {
    // 1. Read entire backup file
    let mut file =
        fs::File::open(input_path).map_err(|e| format!("open {}: {}", input_path.display(), e))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("read {}: {}", input_path.display(), e))?;

    let header_len = MAGIC.len() + SALT_LEN + NONCE_LEN;
    if buf.len() < header_len {
        return Err(format!(
            "file too small ({}B < {}B header): corrupted or not a backup file",
            buf.len(),
            header_len
        ));
    }

    // 2. Verify magic
    let magic = &buf[..MAGIC.len()];
    if magic != MAGIC {
        return Err(format!(
            "bad magic header: not an Ai00-X backup file (got {:?})",
            String::from_utf8_lossy(magic)
        ));
    }

    // 3. Extract salt + nonce + ciphertext
    let salt = &buf[MAGIC.len()..MAGIC.len() + SALT_LEN];
    let nonce_bytes = &buf[MAGIC.len() + SALT_LEN..MAGIC.len() + SALT_LEN + NONCE_LEN];
    let ciphertext = &buf[MAGIC.len() + SALT_LEN + NONCE_LEN..];

    // 4. Derive key and decrypt
    let key = derive_key(password, salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("aes init: {e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    let plain_gz = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decrypt failed (wrong password or corrupted file): {e}"))?;

    // 5. Gzip-decompress
    let mut decoder = flate2::read::GzDecoder::new(Cursor::new(plain_gz));
    let mut tar_buf = Vec::new();
    decoder
        .read_to_end(&mut tar_buf)
        .map_err(|e| format!("gzip decompress failed: {e}"))?;

    // 6. Extract tar to projects_root
    let pm = get_path_manager_arc();
    let projects_root = pm.projects_root();
    fs::create_dir_all(&projects_root)
        .map_err(|e| format!("create projects dir {}: {}", projects_root.display(), e))?;

    let mut archive = tar::Archive::new(Cursor::new(tar_buf));
    let mut files = 0usize;
    let mut bytes = 0u64;

    for entry in archive.entries().map_err(|e| format!("tar entries: {e}"))? {
        let mut entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("[chat_backup] skip bad tar entry: {}", e);
                continue;
            }
        };

        // Only extract regular files (skip directories / symlinks for safety).
        // Directory entries are skipped — parent dirs are created per-file below.
        if entry.header().entry_type() != tar::EntryType::Regular {
            continue;
        }

        // Sanitize path: reject absolute paths and parent traversal for safety.
        let rel_path = match entry.path() {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[chat_backup] skip entry with bad path: {}", e);
                continue;
            }
        };
        let rel_path = rel_path.into_owned();

        // Reject any path component of ".." or absolute paths.
        let is_unsafe = rel_path.is_absolute()
            || rel_path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir));
        if is_unsafe {
            log::warn!(
                "[chat_backup] skip entry with unsafe path: {}",
                rel_path.display()
            );
            continue;
        }

        let dest = projects_root.join(&rel_path);
        if let Some(parent) = dest.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                log::warn!(
                    "[chat_backup] create parent {} failed: {}",
                    parent.display(),
                    e
                );
                continue;
            }
        }

        let mut data = Vec::new();
        if let Err(e) = entry.read_to_end(&mut data) {
            log::warn!(
                "[chat_backup] read tar entry {} failed: {}",
                rel_path.display(),
                e
            );
            continue;
        }

        if let Err(e) = fs::write(&dest, &data) {
            log::warn!("[chat_backup] write {} failed: {}", dest.display(), e);
            continue;
        }

        files += 1;
        bytes += data.len() as u64;
    }

    log::info!(
        "[chat_backup] import complete: {} files, {} bytes restored to {}",
        files,
        bytes,
        projects_root.display()
    );

    Ok(BackupResult {
        files,
        bytes,
        path: projects_root.to_string_lossy().to_string(),
    })
}

// === Tauri commands ===

/// Export all chat history to an encrypted `.ai00x-backup` file.
///
/// `password` must be provided by the user; `output_path` is chosen via
/// the file-save dialog in the frontend (tauri-plugin-dialog).
#[tauri::command]
pub async fn chat_history_export(
    password: String,
    output_path: String,
) -> Result<BackupResult, String> {
    let output_path = PathBuf::from(output_path);
    // Run on blocking thread — tar/gzip/argon2 are CPU-heavy.
    tokio::task::spawn_blocking(move || export_chat_history(&password, &output_path))
        .await
        .map_err(|e| format!("join task: {e}"))?
}

/// Import chat history from an encrypted `.ai00x-backup` file.
///
/// `password` must match the one used at export time.
#[tauri::command]
pub async fn chat_history_import(
    password: String,
    input_path: String,
) -> Result<BackupResult, String> {
    let input_path = PathBuf::from(input_path);
    tokio::task::spawn_blocking(move || import_chat_history(&password, &input_path))
        .await
        .map_err(|e| format!("join task: {e}"))?
}
