//! 三槽位 checkpoint（P1-B）：引擎关键小文件的轮转健康快照 + 恢复。
//!
//! 对标 dsh-desktop profile-checkpoint 的极简恢复模型：不做 receipt/回滚乘法，
//! 槽里只留健康态——只在「健康启动后且内容有变化」时轮转写入（启动失败绝不写槽）；
//! 恢复必须用户选槽，不自动回滚。凭据/会话/缓存/storages 永不进快照。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::dsh_manager::{dsh_home, dsh_version, profile_dir};

const SLOT_COUNT: u32 = 3;
const CURRENT_FILE: &str = "CURRENT";
const META_FILE: &str = "checkpoint.json";

/// 设置页「引擎健康」分区的槽位卡片数据。
#[derive(Debug, Clone, Serialize)]
pub struct CheckpointInfo {
    pub slot: u32,
    /// Unix 秒（前端格式化）
    pub timestamp_unix_secs: u64,
    pub engine_version: String,
    pub file_count: usize,
}

fn checkpoints_dir() -> PathBuf {
    dsh_home().join("checkpoints")
}

/// 快照覆盖的文件（相对 DSH_HOME 的路径）。缺失的文件按 MISSING 计入 hash，
/// 恢复时跳过——即「曾经存在后来没了」的变化也能被下一次快照捕捉。
/// 快照条目：(相对路径, 内容字节)；None = 快照时不存在（MISSING 记入 hash）。
type SnapshotEntries = Vec<(String, Option<Vec<u8>>)>;

fn collect_entries() -> Result<SnapshotEntries, String> {
    let home = dsh_home();
    let profile_rel = profile_dir()
        .strip_prefix(&home)
        .map_err(|e| format!("profile dir not under dsh home: {e}"))?
        .to_string_lossy()
        .replace('\\', "/");

    let mut rels: Vec<String> = vec![
        format!("{profile_rel}/package.json"),
        format!("{profile_rel}/cordis.yml"),
        format!("{profile_rel}/cordis.patch.yml"),
        format!("{profile_rel}/pnpm-lock.yaml"),
        "settings.yaml".into(),
        "install-marker.json".into(),
        "hooks.json".into(),
    ];
    // agent-workers/*.md（数据驱动编排的帮手定义）
    let workers = home.join("agent-workers");
    if let Ok(entries) = fs::read_dir(&workers) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".md") {
                rels.push(format!("agent-workers/{name}"));
            }
        }
    }
    rels.sort();
    rels.dedup();

    let mut out = Vec::with_capacity(rels.len());
    for rel in rels {
        let bytes = fs::read(home.join(&rel)).ok();
        out.push((rel, bytes));
    }
    Ok(out)
}

fn hash_entries(entries: &SnapshotEntries) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for (rel, bytes) in entries {
        rel.hash(&mut hasher);
        match bytes {
            Some(b) => hasher.write(b),
            None => "MISSING".hash(&mut hasher),
        };
    }
    hasher.finish()
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_current() -> Option<(u32, u64)> {
    let raw = fs::read_to_string(checkpoints_dir().join(CURRENT_FILE)).ok()?;
    let mut parts = raw.trim().split(':');
    let slot = parts.next()?.parse::<u32>().ok()?;
    let hash = parts.next()?.parse::<u64>().ok()?;
    Some((slot, hash))
}

fn write_current(slot: u32, hash: u64) -> Result<(), String> {
    fs::create_dir_all(checkpoints_dir()).map_err(|e| format!("mkdir checkpoints: {e}"))?;
    fs::write(
        checkpoints_dir().join(CURRENT_FILE),
        format!("{slot}:{hash:x}"),
    )
    .map_err(|e| format!("write {CURRENT_FILE}: {e}"))
}

/// 健康启动后调用：内容有变化才轮转写下一个槽；无变化幂等跳过。
/// 只写日志不向上抛错——快照失败绝不影响启动结果。
pub async fn snapshot_if_changed() -> Result<(), String> {
    let entries = collect_entries()?;
    let hash = hash_entries(&entries);
    if let Some((_, last_hash)) = read_current() {
        if last_hash == hash {
            return Ok(());
        }
    }
    let last_slot = read_current().map(|(s, _)| s).unwrap_or(SLOT_COUNT - 1);
    let slot = (last_slot + 1) % SLOT_COUNT;
    let slot_dir = checkpoints_dir().join(format!("slot-{slot}"));

    if slot_dir.exists() {
        fs::remove_dir_all(&slot_dir).map_err(|e| format!("clear slot-{slot}: {e}"))?;
    }
    let mut saved = 0usize;
    for (rel, bytes) in &entries {
        let Some(bytes) = bytes else { continue };
        let target = slot_dir.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        fs::write(&target, bytes).map_err(|e| format!("write {}: {e}", target.display()))?;
        saved += 1;
    }
    let meta = serde_json::json!({
        "timestamp_unix_secs": now_unix_secs(),
        "engine_version": dsh_version().unwrap_or("unknown"),
        "file_count": saved,
    });
    fs::write(
        slot_dir.join(META_FILE),
        serde_json::to_string_pretty(&meta).unwrap_or_default(),
    )
    .map_err(|e| format!("write meta: {e}"))?;
    write_current(slot, hash)?;
    log::info!(
        "[checkpoint] snapshot written to slot-{slot} ({saved} files, hash {:x})",
        hash
    );
    Ok(())
}

/// 列出全部槽位（设置页「引擎健康」分区用）。空槽不返回。
pub fn list() -> Vec<CheckpointInfo> {
    let mut out = Vec::new();
    for slot in 0..SLOT_COUNT {
        let meta_path = checkpoints_dir()
            .join(format!("slot-{slot}"))
            .join(META_FILE);
        let Ok(raw) = fs::read_to_string(&meta_path) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        out.push(CheckpointInfo {
            slot,
            timestamp_unix_secs: meta["timestamp_unix_secs"].as_u64().unwrap_or(0),
            engine_version: meta["engine_version"]
                .as_str()
                .unwrap_or("unknown")
                .to_string(),
            file_count: meta["file_count"].as_u64().unwrap_or(0) as usize,
        });
    }
    out
}

/// 恢复指定槽：把槽内文件覆盖回 DSH_HOME 对应路径（跳过缺失标记）。
/// 只动文件不碰引擎进程——调用方负责随后的 stop/start（见 dsh_checkpoint_restore）。
pub fn restore(slot: u32) -> Result<usize, String> {
    if slot >= SLOT_COUNT {
        return Err(format!("invalid slot {slot}"));
    }
    let slot_dir = checkpoints_dir().join(format!("slot-{slot}"));
    if !slot_dir.join(META_FILE).exists() {
        return Err(format!("slot-{slot} has no checkpoint"));
    }
    let home = dsh_home();
    let mut restored = 0usize;
    let mut stack = vec![slot_dir.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.file_name().is_some_and(|n| n == META_FILE) {
                continue;
            }
            let rel = path
                .strip_prefix(&slot_dir)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            let target = home.join(&rel);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            }
            fs::copy(&path, &target).map_err(|e| format!("copy {}: {e}", target.display()))?;
            restored += 1;
        }
    }
    log::info!("[checkpoint] restored slot-{slot}: {restored} files");
    Ok(restored)
}

#[tauri::command]
pub async fn dsh_checkpoints_list() -> Result<Vec<CheckpointInfo>, String> {
    Ok(list())
}

/// 恢复槽位并重启引擎（stop → start；幂等，restart_lock 串行化）。
#[tauri::command]
pub async fn dsh_checkpoint_restore(slot: u32) -> Result<super::dsh_manager::DshStatus, String> {
    let _guard = super::dsh_manager::restart_lock_guard().await;
    // 先停引擎再覆盖文件：Windows 下运行中的引擎可能持有文件句柄，先停避免
    // 「文件被占用」导致恢复半途而废。
    super::dsh_manager::stop().await?;
    let restored = restore(slot)?;
    log::info!("[checkpoint] restored slot-{slot} ({restored} files), restarting engine");
    super::dsh_manager::start().await?;
    super::dsh_manager::dsh_status().await
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn hash_changes_with_content() {
        let a = vec![("a.txt".to_string(), Some(b"hello".to_vec()))];
        let b = vec![("a.txt".to_string(), Some(b"world".to_vec()))];
        let missing = vec![("a.txt".to_string(), None)];
        assert_ne!(hash_entries(&a), hash_entries(&b));
        assert_ne!(hash_entries(&a), hash_entries(&missing));
        let a2 = a.clone();
        assert_eq!(hash_entries(&a), hash_entries(&a2));
    }

    #[test]
    fn slot_rotation_math() {
        let last = SLOT_COUNT - 1;
        assert_eq!((last + 1) % SLOT_COUNT, 0);
        assert_eq!((0 + 1) % SLOT_COUNT, 1);
    }
}
