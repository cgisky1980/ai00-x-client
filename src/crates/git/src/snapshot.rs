//! 志·工作区 git 快照服务：委托前基线 + 任务完成时快照。
//!
//! **全链路 libgit2 纯库（git2 crate vendored 编译进二进制）——不依赖系统
//! 安装 git**（Windows 无 git 环境照常工作），也不依赖用户 git 身份配置
//!（签名固定 Ai00-X Agent）。
//! auto-init 静默（非 repo 自动 init + Initial commit；已是 repo 不动）；
//! 快照 = add_all + commit（按任务完成粒度——一次委托一 commit，历史干净）。
//! 失败不阻塞业务路径（调用方静默）。

use std::path::Path;

use git2::{IndexAddOption, Repository, Signature, StatusOptions};
use serde::{Deserialize, Serialize};

/// 快照结果（给调用方判断是否真生成了 commit——非 repo 初始 commit 算一次）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotResult {
    /// repo 是否本次新建的（false = 既有 repo）
    pub initialized: bool,
    /// commit 哈希（失败/无变更时为 null）
    pub commit: Option<String>,
    /// 提交信息
    pub message: String,
}

const AGENT_NAME: &str = "Ai00-X Agent";
const AGENT_EMAIL: &str = "agent@ai00-x.local";

fn agent_signature() -> Result<Signature<'static>, String> {
    Signature::now(AGENT_NAME, AGENT_EMAIL).map_err(|e| e.to_string())
}

/// 确保工作区是 repo（非 repo 自动 init；纯 libgit2）。
/// 空目录 init 不做 Initial commit（无 tree 可提交）——首次快照自然成为首个 commit。
pub fn ensure_repo(path: &Path) -> Result<bool, String> {
    let is_new = Repository::open(path).is_err();
    if !is_new {
        return Ok(false);
    }
    Repository::init(path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// 是否存在变更（工作区/暂存区，相对 HEAD；纯 libgit2 status）。
fn has_changes(repo: &Repository) -> Result<bool, String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    Ok(!statuses.is_empty())
}

/// 快照：add_all + commit（纯 libgit2，无系统 git / 无用户 git 配置依赖）。
///
/// - 未 init 的目录会先 `ensure_repo`
/// - 无变更时跳过 commit（返回当前 HEAD）
/// - commit message 由调用方给（如 `task: 卡片标题 · agent 执行`）
pub fn snapshot(path: &Path, message: &str) -> Result<SnapshotResult, String> {
    let initialized = ensure_repo(path)?;
    let repo = Repository::open(path).map_err(|e| e.to_string())?;
    let sig = agent_signature()?;

    // 无变更：返回当前 HEAD（首次快照空目录时 commit 为 None）
    if !has_changes(&repo)? {
        let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        return Ok(SnapshotResult {
            initialized,
            commit: head.map(|c| c.id().to_string()),
            message: message.to_string(),
        });
    }

    // add -A（含未跟踪；尊重 .gitignore）
    {
        let mut index = repo.index().map_err(|e| e.to_string())?;
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .map_err(|e| e.to_string())?;
        index.write().map_err(|e| e.to_string())?;
    }

    // commit（parent = 当前 HEAD，无 HEAD = 首个 commit）
    let tree_id = {
        let mut index = repo.index().map_err(|e| e.to_string())?;
        index.write_tree().map_err(|e| e.to_string())?
    };
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let parents: Vec<git2::Commit> = match repo.head() {
        Ok(h) => vec![h.peel_to_commit().map_err(|e| e.to_string())?],
        Err(_) => vec![],
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let commit_id = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)
        .map_err(|e| e.to_string())?;

    Ok(SnapshotResult {
        initialized,
        commit: Some(commit_id.to_string()),
        message: message.to_string(),
    })
}

/// 单条快照时间线记录（仅 agent 签名的快照 commit）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotEntry {
    /// commit 哈希（完整）
    pub commit: String,
    /// 提交信息
    pub message: String,
    /// 提交时间（Unix 秒）
    pub time: i64,
}

/// 列出快照时间线：从 HEAD 反向遍历，仅保留 agent 签名
/// （Ai00-X Agent <agent@ai00-x.local>）的 commit——用户的真实提交不进时间线、
/// 也不受回滚之外的操作影响。`limit` 上限防止超长历史（默认 100）。
pub fn list_agent_snapshots(path: &Path, limit: usize) -> Result<Vec<SnapshotEntry>, String> {
    let repo = Repository::open(path).map_err(|e| e.to_string())?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let head_commit = head.peel_to_commit().map_err(|e| e.to_string())?;

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push(head_commit.id()).map_err(|e| e.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for oid in revwalk.flatten() {
        if entries.len() >= limit {
            break;
        }
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let committer = commit.committer();
        if committer.email() != Some(AGENT_EMAIL) {
            continue;
        }
        entries.push(SnapshotEntry {
            commit: commit.id().to_string(),
            message: commit.message().unwrap_or("").trim().to_string(),
            time: committer.when().seconds(),
        });
    }
    Ok(entries)
}

/// 回滚到某条快照：`reset --hard <commit>`（分支指针随动，目标之后的
/// agent 快照被丢弃）。UI 侧须二次确认——目标之后的所有变更不可恢复。
/// 只应回滚到 [`list_agent_snapshots`] 返回的条目。
pub fn rollback_to_snapshot(path: &Path, commit: &str) -> Result<SnapshotResult, String> {
    let repo = Repository::open(path).map_err(|e| e.to_string())?;
    let oid = git2::Oid::from_str(commit).map_err(|e| e.to_string())?;
    let obj = repo
        .find_object(oid, Some(git2::ObjectType::Commit))
        .map_err(|_| format!("snapshot not found: {commit}"))?;
    // reset 前先记下目标信息，成功后返回给调用方展示
    let target_commit = obj
        .as_commit()
        .ok_or_else(|| format!("not a commit: {commit}"))?;
    let message = target_commit.message().unwrap_or("").trim().to_string();
    repo.reset(&obj, git2::ResetType::Hard, None)
        .map_err(|e| e.to_string())?;
    Ok(SnapshotResult {
        initialized: false,
        commit: Some(target_commit.id().to_string()),
        message,
    })
}
