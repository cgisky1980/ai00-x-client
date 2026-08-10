use crate::util::errors::{Ai00XError, Ai00XResult};
use log::warn;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use tokio::fs;
use tokio::sync::Mutex;

const ATOMIC_WRITE_MAX_RETRIES: usize = 3;
const ATOMIC_WRITE_BASE_DELAY_MS: u64 = 50;
const CHUNK_THRESHOLD: usize = 256 * 1024;
const WRITE_CHUNK_SIZE: usize = 64 * 1024;

static FILE_WRITE_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub async fn acquire_file_write_lock(path: &Path) -> Arc<Mutex<()>> {
    let mut locks = FILE_WRITE_LOCKS.lock().await;
    locks
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

pub async fn atomic_write(path: &Path, content: &[u8]) -> Ai00XResult<()> {
    let mut last_error: Option<std::io::Error> = None;

    for attempt in 0..=ATOMIC_WRITE_MAX_RETRIES {
        let temp_path = path.with_extension("tmp");

        let write_result = if content.len() > CHUNK_THRESHOLD {
            write_chunked(&temp_path, content).await
        } else {
            fs::write(&temp_path, content).await
        };

        if let Err(e) = write_result {
            let _ = fs::remove_file(&temp_path).await;
            last_error = Some(e);
            if attempt < ATOMIC_WRITE_MAX_RETRIES {
                tokio::time::sleep(std::time::Duration::from_millis(
                    ATOMIC_WRITE_BASE_DELAY_MS * (attempt as u64 + 1),
                ))
                .await;
                continue;
            }
            break;
        }

        match fs::rename(&temp_path, path).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                let _ = fs::remove_file(&temp_path).await;
                let should_retry =
                    is_retryable_write_error(&e) && attempt < ATOMIC_WRITE_MAX_RETRIES;
                last_error = Some(e);

                if should_retry {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        ATOMIC_WRITE_BASE_DELAY_MS * (attempt as u64 + 1),
                    ))
                    .await;
                    continue;
                }

                break;
            }
        }
    }

    if let Some(error) = last_error {
        if error.kind() == ErrorKind::PermissionDenied {
            warn!(
                "Atomic rename permission denied for {}, fallback to direct overwrite",
                path.display()
            );
            fs::write(path, content).await.map_err(|e| {
                Ai00XError::io(format!(
                    "Failed fallback overwrite {}: {}",
                    path.display(),
                    e
                ))
            })?;
            return Ok(());
        }

        return Err(Ai00XError::io(format!(
            "Failed to write file {}: {}",
            path.display(),
            error
        )));
    }

    Err(Ai00XError::io(format!(
        "Failed to write file {}: unknown error",
        path.display()
    )))
}

async fn write_chunked(path: &Path, content: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut file = fs::File::create(path).await?;
    for chunk in content.chunks(WRITE_CHUNK_SIZE) {
        file.write_all(chunk).await?;
    }
    file.flush().await?;
    Ok(())
}

fn is_retryable_write_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::PermissionDenied
            | ErrorKind::TimedOut
            | ErrorKind::ResourceBusy
            | ErrorKind::Interrupted
    )
}
