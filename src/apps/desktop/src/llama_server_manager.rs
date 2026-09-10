//! llama-server 子进程管理器 + GGUF 模型目录扫描。
//!
//! 职责：
//! 1. **GGUF 模型枚举**（`list_gguf_models`）：只扫 models/llm/（自有下载）
//!    与用户手动注册目录。unsloth / HF 缓存遍历已移除（模型列表卡顿根源）；
//!    内置目录就绪判定为对 models/llm 指定文件直接 stat（`gguf_builtin_catalog`）。
//! 2. **llama-server 子进程**：懒启动（首次 GGUF 请求时 spawn），OpenAI 兼容
//!    HTTP 服务（/v1），ai-adapters 的 openai provider 直接对接。
//!
//! 进程纪律（对齐 MusicSourceManager 范式）：
//! - win32 Job kill-on-close：主进程被强杀时内核回收 llama-server
//! - 180s 空闲自动退出：缓解与 RWKV/ASR/TTS 的显存竞争
//! - 模型切换 = kill 旧进程 → 换 `-m` 重启

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::process::Child;

use ai00_x_core::util::process_manager;

/// GGUF 模型目录扫描最大深度。
const SCAN_MAX_DEPTH: usize = 6;
/// llama-server 就绪探测超时（27B 级模型冷加载 ~60s，留足余量）。
const READY_TIMEOUT_SECS: u64 = 180;
/// 默认上下文长度（27B UD-Q4_K_M 在 22GB 显存的舒适档）。
const DEFAULT_CTX: u32 = 16384;
/// ensure 调用后视为"可能活跃"的窗口（协调器 busy 近似，防止刚拉起即被驱逐）。
const BUSY_WINDOW_MS: u64 = 30_000;

// ---------------------------------------------------------------------------
// GGUF 模型扫描
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct GgufModelInfo {
    /// 展示 id（文件名去扩展名；HF 缓存为 `org/repo:量化名`）。
    pub id: String,
    pub gguf_path: String,
    /// 多分片模型的全部分片合计大小。
    pub size_bytes: u64,
    /// GGUF general.architecture（如 qwen3.8）。
    pub architecture: String,
    /// 模型声明上下文长度（metadata 为空时 0）。
    pub context_length: u64,
    /// 来源：bundled / unsloth / hf-cache / custom。
    pub source: String,
}

/// 用户手动注册的外部模型目录持久化文件。
fn custom_dirs_file() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Ai00-X")
        .join("gguf-model-dirs.json")
}

fn load_custom_dirs() -> Vec<PathBuf> {
    std::fs::read_to_string(custom_dirs_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .map(|v| v.into_iter().map(PathBuf::from).collect())
        .unwrap_or_default()
}

fn save_custom_dirs(dirs: &[PathBuf]) -> Result<(), String> {
    let texts: Vec<String> = dirs
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if let Some(parent) = custom_dirs_file().parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        custom_dirs_file(),
        serde_json::to_string_pretty(&texts).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())
}

/// 待扫描目录清单（dir, source 标签），按优先级排列。
///
/// 只扫自有模型目录 + 用户手动注册目录。unsloth / HF 缓存遍历已移除：
/// 那是模型列表打开卡顿的根源（大量目录 walk + 大文件头解析），
/// 内置目录的就绪判定改为对 models/llm 指定文件直接 stat。
fn scan_targets() -> Vec<(PathBuf, &'static str)> {
    let mut out = Vec::new();
    // 1. 自有下载目录
    out.push((crate::runtime::get_models_dir().join("llm"), "bundled"));
    // 2. 用户手动注册目录
    for d in load_custom_dirs() {
        out.push((d, "custom"));
    }
    out
}

/// 目录是否应跳过（工具链/二进制目录，非模型）。
fn skip_dir_name(name: &str) -> bool {
    matches!(
        name,
        "llama.cpp" | "bin" | "build" | "venv" | "share" | "include" | "lib" | "locks"
    )
}

/// 文件名是否为多分片首片：`*-00001-of-0000N.gguf`。返回 (前缀, 分片数)。
fn shard_first_of(file_stem: &str) -> Option<(String, u32)> {
    // 形如 "<prefix>-00001-of-00004"
    let dash = file_stem.rfind("-00001-of-")?;
    let prefix = &file_stem[..dash];
    let total = file_stem[dash + "-00001-of-".len()..].parse::<u32>().ok()?;
    Some((prefix.to_string(), total))
}

struct ScannedFile {
    path: PathBuf,
    size: u64,
    /// 多分片前缀（非分片为 None）。
    shard_prefix: Option<String>,
}

fn walk_gguf_files(dir: &Path, depth: usize, out: &mut Vec<ScannedFile>) {
    if depth > SCAN_MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir() {
            // HF 缓存目录内嵌 blobs/ 与快照的符号链接，直接扫快照层即可
            if skip_dir_name(name) || name == "blobs" {
                continue;
            }
            walk_gguf_files(&path, depth + 1, out);
        } else if name.to_lowercase().ends_with(".gguf") {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let stem = name.trim_end_matches(".gguf").trim_end_matches(".GGUF");
            let shard_prefix = shard_first_of(stem).map(|(p, _)| p);
            out.push(ScannedFile {
                path,
                size,
                shard_prefix,
            });
        }
    }
}

/// 从 HF 缓存目录名还原仓库 id：models--unsloth--Qwen3.8-27B-GGUF → unsloth/Qwen3.8-27B-GGUF。
fn hf_repo_id_from_dir(dir: &Path) -> Option<String> {
    dir.ancestors()
        .find(|a| {
            a.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("models--"))
                .unwrap_or(false)
        })
        .and_then(|a| a.file_name().and_then(|n| n.to_str()))
        .map(|n| n.trim_start_matches("models--").replace("--", "/"))
}

/// 读取 GGUF 元数据（只读文件头，不加载权重）。
fn read_gguf_meta(path: &Path) -> (String, u64) {
    match crate::asr::gguf::GgufReader::open(path) {
        Ok(r) => {
            let arch = r.architecture().unwrap_or("unknown").to_string();
            let ctx = r.meta_u32(&format!("{arch}.context_length")).unwrap_or(0) as u64;
            (arch, ctx)
        }
        Err(_) => ("unknown".to_string(), 0),
    }
}

/// GGUF 是否含 MTP（nextn）投机解码层。b10837 起 llama-server 带
/// `--spec-type draft-mtp` 加载非 MTP 模型会直接报错退出（b10665 及之前
/// 为静默忽略），spawn 前按元数据 `<arch>.nextn_predict_layers` 判定。
fn model_has_mtp_layers(path: &Path) -> bool {
    let Ok(r) = crate::asr::gguf::GgufReader::open(path) else {
        return false;
    };
    let arch = r.architecture().unwrap_or("unknown");
    r.meta_u32(&format!("{arch}.nextn_predict_layers"))
        .is_some_and(|n| n > 0)
}

fn build_gguf_model_info(
    first_shard: &ScannedFile,
    total_size: u64,
    source: &str,
) -> GgufModelInfo {
    let stem = first_shard
        .path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();
    let (arch, ctx) = read_gguf_meta(&first_shard.path);
    // HF 缓存：id 带仓库 id 便于辨认
    let id = if source == "hf-cache" {
        match hf_repo_id_from_dir(&first_shard.path) {
            Some(repo) => format!("{repo}:{stem}"),
            None => stem.clone(),
        }
    } else {
        stem.clone()
    };
    GgufModelInfo {
        id,
        gguf_path: first_shard.path.to_string_lossy().into_owned(),
        size_bytes: total_size,
        architecture: arch,
        context_length: ctx,
        source: source.to_string(),
    }
}

/// 枚举全部可用 GGUF 模型（去重：同一路径只出现一次，bundled 优先）。
#[tauri::command]
pub fn list_gguf_models() -> Vec<GgufModelInfo> {
    let mut out: Vec<GgufModelInfo> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for (dir, source) in scan_targets() {
        if !dir.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        walk_gguf_files(&dir, 0, &mut files);
        // 分片聚合：prefix → (首片, 合计大小)；非分片文件独立成项
        let mut shards: HashMap<String, (usize, u64)> = HashMap::new();
        for (idx, f) in files.iter().enumerate() {
            if let Some(prefix) = &f.shard_prefix {
                let e = shards.entry(prefix.clone()).or_insert((idx, 0));
                e.1 += f.size;
                // 首片 = 编号最小的文件（00001 命名保证首个遇到的即首片；保险起见按路径名排序取最小）
                if f.path < files[e.0].path {
                    e.0 = idx;
                }
            }
        }
        let mut consumed: Vec<usize> = Vec::new();
        for (prefix, (first_idx, total)) in &shards {
            consumed.push(*first_idx);
            // 同前缀全部分片路径标记已消费
            for (idx, f) in files.iter().enumerate() {
                if f.shard_prefix.as_deref() == Some(prefix.as_str()) {
                    consumed.push(idx);
                }
            }
            let info = build_gguf_model_info(&files[*first_idx], *total, source);
            if seen.insert(PathBuf::from(&info.gguf_path)) {
                out.push(info);
            }
        }
        for (idx, f) in files.iter().enumerate() {
            if consumed.contains(&idx) {
                continue;
            }
            let info = build_gguf_model_info(f, f.size, source);
            if seen.insert(PathBuf::from(&info.gguf_path)) {
                out.push(info);
            }
        }
    }
    out.sort_by_key(|m| m.size_bytes);
    out
}

#[tauri::command]
pub fn gguf_add_custom_dir(dir: String) -> Result<(), String> {
    let p = PathBuf::from(&dir);
    if !p.is_dir() {
        return Err(format!("directory not found: {dir}"));
    }
    let mut dirs = load_custom_dirs();
    if !dirs.contains(&p) {
        dirs.push(p);
        save_custom_dirs(&dirs)?;
    }
    Ok(())
}

#[tauri::command]
pub fn gguf_remove_custom_dir(dir: String) -> Result<(), String> {
    let p = PathBuf::from(&dir);
    let mut dirs = load_custom_dirs();
    dirs.retain(|d| d != &p);
    save_custom_dirs(&dirs)
}

#[tauri::command]
pub fn gguf_list_custom_dirs() -> Vec<String> {
    load_custom_dirs()
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

// ---------------------------------------------------------------------------
// llama-server 子进程
// ---------------------------------------------------------------------------

struct LlamaServerManager {
    child: tokio::sync::Mutex<Option<Child>>,
    /// 当前加载的 GGUF 路径（模型切换判定）。
    model_path: std::sync::Mutex<Option<String>>,
    port: AtomicU16,
    /// 最近一次使用时间（ms since epoch；空闲退出判定）。
    last_used_ms: AtomicU64,
    /// 并发启动互斥（ensure 只跑一份）。
    ensure_lock: tokio::sync::Mutex<()>,
    #[cfg(windows)]
    server_job: std::sync::Mutex<Option<win32job::Job>>,
}

static LLAMA_SERVER: std::sync::OnceLock<&'static LlamaServerManager> = std::sync::OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn manager() -> &'static LlamaServerManager {
    LLAMA_SERVER.get_or_init(|| {
        let m = Box::leak(Box::new(LlamaServerManager {
            child: tokio::sync::Mutex::new(None),
            model_path: std::sync::Mutex::new(None),
            port: AtomicU16::new(0),
            last_used_ms: AtomicU64::new(0),
            ensure_lock: tokio::sync::Mutex::new(()),
            #[cfg(windows)]
            server_job: std::sync::Mutex::new(None),
        }));
        spawn_idle_monitor();
        m
    })
}

/// 空闲监视 + MTP 接受率看门狗：每 30s 检查一次。
/// - 空闲超 keep_alive（`resolve_policy("llama-gguf")`，默认 300s；-1 常驻）→ kill 释放显存；
/// - 有推理进行中（/metrics requests_processing > 0）→ 跳过本次检查（防掐断长生成）；
/// - MTP draft 接受率崩塌（上游 llama.cpp #27151，偶发，重启恢复）→
///   增量接受率 < 5% 且 draft 增量 ≥ 200 时自动重启，下次请求懒启动恢复。
fn spawn_idle_monitor() {
    tokio::spawn(async move {
        let mut last_accepted: Option<u64> = None;
        let mut last_draft: Option<u64> = None;
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let m = manager();
            let running = m.child.lock().await.is_some();
            if !running {
                last_accepted = None;
                last_draft = None;
                continue;
            }
            let last = m.last_used_ms.load(Ordering::SeqCst);
            let idle_secs = now_ms().saturating_sub(last) / 1000;
            let keep_alive = crate::vram_manager::resolve_policy("llama-gguf", 0).keep_alive_secs;
            let expired = match keep_alive {
                -1 => false,                       // 常驻
                0 => last != 0 && idle_secs >= 30, // 用后尽快卸（下一轮询）
                ka => last != 0 && idle_secs >= ka as u64,
            };
            if expired {
                log::info!(
                    "[LlamaServer] idle {idle_secs}s (keep_alive {keep_alive}s), stopping to free VRAM"
                );
                stop_internal(m).await;
                last_accepted = None;
                last_draft = None;
                continue;
            }
            // MTP 接受率看门狗（仅 --metrics 开启时有效）
            let port = m.port.load(Ordering::SeqCst);
            if port == 0 {
                continue;
            }
            let metrics = match reqwest::Client::new()
                .get(format!("http://127.0.0.1:{port}/metrics"))
                .timeout(Duration::from_secs(5))
                .send()
                .await
            {
                Ok(r) => match r.text().await {
                    Ok(t) => t,
                    Err(_) => continue,
                },
                Err(_) => continue,
            };
            let parse_counter = |name: &str| -> Option<u64> {
                metrics.lines().find_map(|l| {
                    l.strip_prefix(name)
                        .and_then(|rest| rest.trim().parse::<u64>().ok())
                })
            };
            let accepted = parse_counter("llamacpp:spec_decode_num_accepted_tokens_total ");
            let draft = parse_counter("llamacpp:spec_decode_num_draft_tokens_total ");
            if let (Some(a), Some(d), Some(pa), Some(pd)) =
                (accepted, draft, last_accepted, last_draft)
            {
                let d_draft = d.saturating_sub(pd);
                let d_accepted = a.saturating_sub(pa);
                // 上游 #27151：崩塌时接受率跌至 ~0；正常 >0.3。
                // 消抖：draft 增量足够大才判定，避免短请求误报。
                if d_draft >= 200 && d_accepted * 20 < d_draft {
                    log::warn!(
                        "[LlamaServer] MTP acceptance collapsed (accepted +{d_accepted} / draft +{d_draft}), restarting server (upstream issue #27151)"
                    );
                    stop_internal(m).await;
                    last_accepted = None;
                    last_draft = None;
                    continue;
                }
            }
            last_accepted = accepted;
            last_draft = draft;
        }
    });
}

async fn stop_internal(m: &LlamaServerManager) {
    let was_running = m.child.lock().await.is_some();
    if let Some(mut child) = m.child.lock().await.take() {
        let _ = child.kill().await;
    }
    if let Ok(mut mp) = m.model_path.lock() {
        *mp = None;
    }
    m.port.store(0, Ordering::SeqCst);
    #[cfg(windows)]
    if let Ok(mut job) = m.server_job.lock() {
        *job = None; // drop Job 句柄触发 kill-on-close
    }
    if was_running {
        // 清空全局 base URL 槽，防止后续请求打到已死端口；
        // 下次 gguf-local 请求会重新 ensure 懒启动。
        ai00_x_core::infrastructure::ai::client_factory::set_gguf_local_base_url(None);
        crate::vram_manager::notify_state("llama-gguf", "GGUF 对话", false, "stopped");
    }
}

/// 定位 llama-server.exe：编译期构建目录优先，回退 runtime 下载目录。
fn find_server_exe() -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(lib_dir) = crate::runtime::find_llama_lib_dir() {
        candidates.push(lib_dir.join(exe_name));
    }
    candidates.push(crate::runtime::get_llama_dir().join(exe_name));
    candidates.into_iter().find(|p| p.is_file())
}

/// 探测空闲端口。
fn pick_free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .map(|l| l.local_addr().map(|a| a.port()).unwrap_or(0))
        .map_err(|e| format!("failed to pick free port: {e}"))
}

/// /health 就绪轮询。
async fn wait_ready(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(READY_TIMEOUT_SECS);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "llama-server not ready after {}s (model load may have failed)",
                READY_TIMEOUT_SECS
            ));
        }
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// 部分卸载固定开销：compute buffer + CUDA context + 碎片余量。
const PARTIAL_FIXED_OVERHEAD_BYTES: u64 = 1024 * 1024 * 1024;

/// 按当前可用显存计算可行的 GPU 卸载层数（-ngl）。
/// 每层显存 ≈ 权重均摊（文件字节/层数）+ KV cache（q8_0：K+V 每层每 token
/// 2×kv_heads×head_dim 字节 × DEFAULT_CTX）。返回错误 = 连一层都放不下。
fn compute_partial_ngl(gguf_path: &str, file_bytes: u64) -> Result<u32, String> {
    let meta = crate::gguf_meta::read_llm_meta(std::path::Path::new(gguf_path))?;
    if file_bytes == 0 {
        return Err("GGUF file size unknown".into());
    }
    let avail = crate::vram_manager::free_after_reserve(None)
        .ok_or_else(|| "VRAM monitor unavailable".to_string())?;
    let kv_per_layer = 2u64 * meta.n_kv_heads as u64 * meta.head_dim as u64 * DEFAULT_CTX as u64;
    let weights_per_layer = file_bytes / meta.n_layers as u64;
    let per_layer = weights_per_layer + kv_per_layer;
    let detail = format!(
        "avail-after-reserve {} MB, per-layer {} MB (weights {} + kv {}), {} layers",
        avail / 1048576,
        per_layer / 1048576,
        weights_per_layer / 1048576,
        kv_per_layer / 1048576,
        meta.n_layers
    );
    if per_layer == 0 || avail <= PARTIAL_FIXED_OVERHEAD_BYTES {
        return Err(format!(
            "insufficient VRAM even for partial offload: {detail}"
        ));
    }
    let ngl = ((avail - PARTIAL_FIXED_OVERHEAD_BYTES) / per_layer).min(meta.n_layers as u64) as u32;
    if ngl == 0 {
        return Err(format!(
            "insufficient VRAM even for partial offload: {detail}"
        ));
    }
    Ok(ngl)
}

/// 确保 llama-server 已加载指定 GGUF 并就绪，返回 base url（含 /v1）。
/// 先做 VRAM 预算检查（不足时协调器驱逐低优先级引擎腾空间）；
/// 加载失败（OOM / 就绪超时）且无其他活跃推理时，驱逐 LRU 引擎后重试一次。
pub async fn ensure_llama_server(gguf_path: &str) -> Result<String, String> {
    register_with_vram_manager();
    match ensure_once(gguf_path).await {
        Ok(url) => Ok(url),
        Err(first_err) => {
            // 加载失败驱逐重试（llama.cpp server PR #25326 模式）：至多重试一次。
            let cfg_enabled = crate::vram_manager::config_enabled();
            if cfg_enabled && crate::vram_manager::evict_lru(Some("llama-gguf")).is_some() {
                log::info!(
                    "[LlamaServer] load failed ({first_err}); evicted LRU engine, retrying once"
                );
                ensure_once(gguf_path).await.map_err(|second| {
                    format!("{first_err}; retry after eviction also failed: {second}")
                })
            } else {
                Err(first_err)
            }
        }
    }
}

async fn ensure_once(gguf_path: &str) -> Result<String, String> {
    let m = manager();
    let _guard = m.ensure_lock.lock().await;

    // 相同模型且在跑 → 刷新空闲计时，直接返回
    if let (Some(cur), Some(child)) = (
        m.model_path.lock().ok().and_then(|g| g.clone()),
        m.child.lock().await.as_ref(),
    ) {
        if cur == gguf_path && child.id().is_some() {
            m.last_used_ms.store(now_ms(), Ordering::SeqCst);
            let port = m.port.load(Ordering::SeqCst);
            return Ok(format!("http://127.0.0.1:{port}/v1"));
        }
    }

    // 模型不同或未运行 → （重）启动
    if !Path::new(gguf_path).exists() {
        return Err(format!("GGUF file not found: {gguf_path}"));
    }
    let exe = find_server_exe().ok_or_else(|| {
        "llama-server not found (runtime/llama incomplete; reinstall runtimes)".to_string()
    })?;
    stop_internal(m).await;

    // VRAM 预算检查：-ngl 99 全量 offload，文件大小 ≈ 显存占用；
    // ×1.15 余量 + KV cache 估 1GB。不足时协调器驱逐低优先级引擎腾空间
    // （驱逐候选逐个尝试，见 evict_lru）。驱逐后仍不足 → 不再直接报错，
    // 而是按当前可用显存计算可行的部分卸载层数（-ngl < n_layers）降级加载：
    // 有 GPU 加速但速度下降；连一层都放不下才向调用方报错。
    // ensure_capacity 可能阻塞（驱逐等待确认），放 blocking 线程。
    let file_bytes = std::fs::metadata(gguf_path).map(|md| md.len()).unwrap_or(0);
    let estimate = file_bytes + file_bytes / 7 + 1024 * 1024 * 1024;
    let budget =
        tokio::task::spawn_blocking(move || crate::vram_manager::ensure_capacity(estimate, None))
            .await
            .map_err(|e| format!("budget check task failed: {e}"))?;
    let ngl: u32 = match budget {
        Ok(()) => 99,
        Err(e) => match compute_partial_ngl(gguf_path, file_bytes) {
            Ok(ngl) => {
                log::info!(
                    "[LlamaServer] full offload infeasible ({e}); partial offload -ngl {ngl}"
                );
                ngl
            }
            Err(pe) => {
                return Err(format!(
                    "insufficient VRAM for GGUF ({gguf_path}): {e}; {pe}"
                ))
            }
        },
    };

    let port = pick_free_port()?;
    let mut cmd = process_manager::create_tokio_command(exe.to_string_lossy().as_ref());
    cmd.arg("-m")
        .arg(gguf_path)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        // GPU 卸载层数：全量 99；显存不足时为计算出的部分卸载层数，
        // 仍放不下时 llama-server 自行报错退出（错误透出）
        .arg("-ngl")
        .arg(ngl.to_string())
        .arg("-c")
        .arg(DEFAULT_CTX.to_string())
        .arg("-ctk")
        .arg("q8_0")
        .arg("-ctv")
        .arg("q8_0")
        // 看门狗需要 /metrics（MTP 接受率崩塌检测）
        .arg("--metrics")
        // 完整 Jinja chat template 渲染：MiniCPM5 等 Think 模型模板复杂，
        // legacy 简化转换会静默丢 reasoning 标签处理；简单模板无副作用。
        // think 内容由 llama-server 提取到 reasoning_content（stream_processor 已支持）
        .arg("--jinja");
    // MTP 投机解码：Qwen3.8 等 nextn 层模型内嵌 draft 权重。
    // n_max=8 + KV q8_0 为 2080 Ti 22GB 实测甜点（23.3 tok/s @ IQ4_XS）；
    // 默认 n_max=3 仅 8.4，n_max=12 接受率崩塌（2.3）。
    // 仅对含 nextn 层的模型启用：b10837 起非 MTP 模型带 draft-mtp
    // 会加载失败退出（Spark-X2.5 等）。
    if model_has_mtp_layers(Path::new(gguf_path)) {
        cmd.arg("--spec-type")
            .arg("draft-mtp")
            .arg("--spec-draft-n-max")
            .arg("8");
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn llama-server: {e}"))?;

    // stderr 日志泵（llama-server 日志走 stderr；加载失败原因在此）
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf[..]).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]);
                        for l in text.lines().filter(|l| !l.trim().is_empty()) {
                            log::info!("[llama-server] {l}");
                        }
                    }
                }
            }
        });
    }
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut reader = stdout;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf[..]).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }

    // 早期退出检测（端口冲突/参数错误等）：进程已死则立即报错
    if child.id().is_none() {
        return Err("llama-server exited immediately (see app log)".into());
    }

    // Job kill-on-close（防主进程强杀残留子进程）
    #[cfg(windows)]
    {
        use win32job::ExtendedLimitInfo;
        match win32job::Job::create() {
            Ok(job) => {
                let mut info = ExtendedLimitInfo::new();
                info.limit_kill_on_job_close();
                if let Err(e) = job.set_extended_limit_info(&info) {
                    log::warn!("[LlamaServer] job limit set failed: {e}");
                } else if let Some(handle) = child.raw_handle() {
                    match job.assign_process(handle as isize) {
                        Ok(()) => {
                            *m.server_job.lock().unwrap_or_else(|e| e.into_inner()) = Some(job);
                        }
                        Err(e) => log::warn!("[LlamaServer] job assign failed: {e}"),
                    }
                }
            }
            Err(e) => log::warn!("[LlamaServer] job create failed: {e}"),
        }
    }

    wait_ready(port).await?;

    *m.child.lock().await = Some(child);
    if let Ok(mut mp) = m.model_path.lock() {
        *mp = Some(gguf_path.to_string());
    }
    m.port.store(port, Ordering::SeqCst);
    m.last_used_ms.store(now_ms(), Ordering::SeqCst);
    crate::vram_manager::notify_state("llama-gguf", "GGUF 对话", true, "loaded");
    log::info!(
        "[LlamaServer] ready: model={} port={} ctx={}",
        gguf_path,
        port,
        DEFAULT_CTX
    );
    Ok(format!("http://127.0.0.1:{port}/v1"))
}

/// 请求前后调用：刷新空闲计时（由 openai provider 对接层调用）。
pub fn touch_llama_server() {
    manager().last_used_ms.store(now_ms(), Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// VRAM manager integration
// ---------------------------------------------------------------------------

/// GGUF llama-server governed-engine adapter (priority 0, default 300s).
struct LlamaGgufGoverned;

/// 只读访问已初始化的 manager（不触发初始化——那需要 tokio 上下文）。
fn try_manager() -> Option<&'static LlamaServerManager> {
    LLAMA_SERVER.get().copied()
}

impl crate::vram_manager::ManagedEngine for LlamaGgufGoverned {
    fn id(&self) -> &str {
        "llama-gguf"
    }
    fn display_name(&self) -> String {
        "GGUF 对话".to_string()
    }
    fn priority(&self) -> i32 {
        0
    }
    fn is_resident(&self) -> bool {
        try_manager().is_some_and(|m| m.port.load(Ordering::SeqCst) != 0)
    }
    fn is_busy(&self) -> bool {
        // 近似：最近一次 ensure/使用在 BUSY_WINDOW 内视为可能活跃，
        // 防止刚拉起/刚请求即被预算驱逐掐断流式输出。
        try_manager()
            .map(|m| {
                let last = m.last_used_ms.load(Ordering::SeqCst);
                last != 0 && now_ms().saturating_sub(last) < BUSY_WINDOW_MS
            })
            .unwrap_or(false)
    }
    fn estimate_vram_bytes(&self) -> Option<u64> {
        let m = try_manager()?;
        let path = m.model_path.lock().ok()?.clone()?;
        let bytes = std::fs::metadata(&path).ok()?.len();
        Some(bytes + bytes / 7 + 1024 * 1024 * 1024)
    }
    fn last_used_ms(&self) -> u64 {
        try_manager()
            .map(|m| m.last_used_ms.load(Ordering::SeqCst))
            .unwrap_or(0)
    }
    fn evict(&self) -> Result<(), String> {
        let m = try_manager().ok_or("llama-server never started")?;
        // 同步等待确认：临时 current_thread runtime 执行 stop_internal。
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("evict runtime: {e}"))?;
        rt.block_on(stop_internal(m));
        Ok(())
    }
}

/// Register the GGUF llama-server with the VRAM manager (idempotent).
pub fn register_with_vram_manager() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        crate::vram_manager::register_engine(std::sync::Arc::new(LlamaGgufGoverned));
    });
}

/// 手动停止（设置页用）。
#[tauri::command]
pub async fn gguf_local_stop() -> Result<(), String> {
    stop_internal(manager()).await;
    Ok(())
}

/// 当前状态（前端展示用）。
#[derive(Debug, Serialize)]
pub struct LlamaServerStatus {
    pub running: bool,
    pub model_path: Option<String>,
    pub port: u16,
    pub idle_secs: u64,
}

#[tauri::command]
pub async fn gguf_local_status() -> LlamaServerStatus {
    let m = manager();
    let running = m.child.lock().await.is_some();
    let model_path = m.model_path.lock().ok().and_then(|g| g.clone());
    let port = m.port.load(Ordering::SeqCst);
    let last = m.last_used_ms.load(Ordering::SeqCst);
    let idle_secs = if last == 0 {
        0
    } else {
        now_ms().saturating_sub(last) / 1000
    };
    LlamaServerStatus {
        running,
        model_path,
        port,
        idle_secs,
    }
}

// ---------------------------------------------------------------------------
// 内置 GGUF 下载目录（unsloth 官方 HF 直链）
// ---------------------------------------------------------------------------

/// 远端 UnifiedManifest 未收录 GGUF 组件前的内置下载目录。
/// unsloth 官方 HF 仓库直链 + hf-mirror 回退（国内优先）。
#[derive(Debug, Clone, Serialize)]
pub struct BuiltinGgufEntry {
    pub key: String,
    pub display: String,
    /// models/ 下相对保存路径（download_model 的 url 字段语义）。
    pub file_rel: String,
    /// 近似大小（精确 total 由下载响应 content-length 提供）。
    pub size_bytes: u64,
    pub downloaded: bool,
    /// 就绪时可直接使用的 GGUF 绝对路径（models/llm 落盘即就绪）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
}

#[derive(Debug, Clone)]
struct BuiltinCatalogModel {
    key: &'static str,
    display: &'static str,
    file_rel: &'static str,
    /// 近似字节数（精确 total 由下载响应 content-length 提供）。
    size_bytes: u64,
    gguf_file: &'static str,
    /// 下载源 HF 仓库 id 与仓库内子目录（空串 = 仓库根）。
    download_repo: &'static str,
    download_dir: &'static str,
}

const BUILTIN_GGUF: &[BuiltinCatalogModel] = &[
    BuiltinCatalogModel {
        key: "Qwen3.8-27B-UD-Q4_K_M",
        display: "Qwen3.8 27B",
        file_rel: "llm/Qwen3.8-27B-UD-Q4_K_M.gguf",
        size_bytes: 16_500_000_000,
        gguf_file: "Qwen3.8-27B-UD-Q4_K_M.gguf",
        download_repo: "cgisky/ai00-x",
        download_dir: "llm",
    },
    BuiltinCatalogModel {
        key: "Spark-X2.5-4B-Q8_0",
        display: "Spark-X2.5 4B",
        file_rel: "llm/Spark-X2.5-4B-Q8_0.gguf",
        size_bytes: 4_370_000_000,
        gguf_file: "Spark-X2.5-4B-Q8_0.gguf",
        // 本地 llama-quantize 产物（BF16 官方源量化），统一走自有模型仓
        download_repo: "cgisky/ai00-x",
        download_dir: "llm",
    },
    BuiltinCatalogModel {
        key: "MiniCPM5-2B-Q8_0",
        display: "MiniCPM5 2B",
        file_rel: "llm/MiniCPM5-2B-Q8_0.gguf",
        size_bytes: 2_679_710_688,
        gguf_file: "MiniCPM5-2B-Q8_0.gguf",
        // 源出 OpenBMB 官方 GGUF（标准 Llama 架构，vanilla llama.cpp 直接支持；Think 推理模型），
        // 统一走自有模型仓（下载源一致好管理）
        download_repo: "cgisky/ai00-x",
        download_dir: "llm",
    },
];

/// 仓库内相对路径（空 download_dir = 仓库根）。
fn builtin_repo_path(entry: &BuiltinCatalogModel) -> String {
    if entry.download_dir.is_empty() {
        entry.gguf_file.to_string()
    } else {
        format!("{}/{}", entry.download_dir, entry.gguf_file)
    }
}

/// 内置 GGUF 下载直链（primary = hf-mirror 国内优先，fallback = huggingface）。
fn builtin_urls(entry: &BuiltinCatalogModel) -> (String, String) {
    let path = builtin_repo_path(entry);
    (
        format!(
            "https://hf-mirror.com/{}/resolve/main/{path}",
            entry.download_repo
        ),
        format!(
            "https://huggingface.co/{}/resolve/main/{path}",
            entry.download_repo
        ),
    )
}

/// 内置 GGUF 下载目录（含本地就绪判定）。
///
/// 就绪判定：models/llm/<file_rel> 落盘即就绪——纯 stat，零扫描开销。
/// unsloth / HF 缓存目录遍历已移除（曾为模型列表打开卡顿的根源）。
#[tauri::command]
pub fn gguf_builtin_catalog() -> Vec<BuiltinGgufEntry> {
    let models_dir = crate::runtime::get_models_dir();
    BUILTIN_GGUF
        .iter()
        .map(|m| {
            let on_disk = models_dir.join(m.file_rel);
            let resolved_path = if on_disk.exists() {
                Some(on_disk.to_string_lossy().into_owned())
            } else {
                None
            };
            BuiltinGgufEntry {
                key: m.key.to_string(),
                display: m.display.to_string(),
                file_rel: m.file_rel.to_string(),
                size_bytes: m.size_bytes,
                downloaded: resolved_path.is_some(),
                resolved_path,
            }
        })
        .collect()
}

/// 触发内置 GGUF 模型下载（复用通用下载链路：进度/断点/多源回退）。
#[tauri::command]
pub async fn gguf_builtin_download(key: String) -> Result<String, String> {
    let entry = BUILTIN_GGUF
        .iter()
        .find(|m| m.key == key)
        .ok_or_else(|| format!("unknown builtin gguf model: {key}"))?;
    let (primary, fallback) = builtin_urls(entry);
    // ModelScope 与 HF 同仓镜像（sync-models.py 双推），国内直连最稳
    let ms_url = format!(
        "https://modelscope.cn/models/cgisky/Ai00-X/resolve/master/{}",
        builtin_repo_path(entry)
    );
    let info = super::model_checker::ModelUpdateInfo {
        component: "llm-gguf".to_string(),
        name: entry.key.to_string(),
        key: entry.key.to_string(),
        url: entry.file_rel.to_string(),
        download_url: primary,
        available_hosts: [("hf".to_string(), fallback), ("ms".to_string(), ms_url)]
            .into_iter()
            .collect(),
        local_hash: None,
        remote_hash: "builtin-catalog".to_string(),
        needs_update: true,
    };
    crate::model_init::download_model(info).await
}

/// 懒启动/复用 llama-server（base URL 写入 core 全局槽），
/// 使 agent 通道的 `gguf-local:<path>` 引用可直接解析（无需先经 plugin 通道）。
#[tauri::command]
pub async fn gguf_ensure_server(gguf_path: String) -> Result<String, String> {
    ensure_llama_server(&gguf_path).await
}

#[cfg(test)]
mod tests {
    use super::model_has_mtp_layers;

    /// 构造最小 GGUF 头（tensor_count=0）验证 MTP 判定，不依赖真实模型文件。
    fn write_minimal_gguf(path: &std::path::Path, arch: &str, nextn: Option<u32>) {
        use std::io::Write;
        let mut b = Vec::new();
        b.extend_from_slice(b"GGUF");
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(&0u64.to_le_bytes()); // tensor_count
        let kv_count = if nextn.is_some() { 2u64 } else { 1 };
        b.extend_from_slice(&kv_count.to_le_bytes());
        let put_str = |b: &mut Vec<u8>, s: &str| {
            b.extend_from_slice(&(s.len() as u64).to_le_bytes());
            b.extend_from_slice(s.as_bytes());
        };
        // general.architecture = <arch>（string）
        put_str(&mut b, "general.architecture");
        b.extend_from_slice(&8u32.to_le_bytes());
        put_str(&mut b, arch);
        if let Some(n) = nextn {
            put_str(&mut b, &format!("{arch}.nextn_predict_layers"));
            b.extend_from_slice(&4u32.to_le_bytes()); // UINT32
            b.extend_from_slice(&n.to_le_bytes());
        }
        std::fs::File::create(path).unwrap().write_all(&b).unwrap();
    }

    #[test]
    fn mtp_detection_by_nextn_metadata() {
        let dir = std::env::temp_dir();
        let with_mtp = dir.join("ai00x-test-mtp-qwen.gguf");
        write_minimal_gguf(&with_mtp, "qwen3", Some(1));
        assert!(model_has_mtp_layers(&with_mtp));

        let zero_mtp = dir.join("ai00x-test-mtp-spark.gguf");
        write_minimal_gguf(&zero_mtp, "spark2_5", Some(0));
        assert!(!model_has_mtp_layers(&zero_mtp));

        let no_key = dir.join("ai00x-test-mtp-nokey.gguf");
        write_minimal_gguf(&no_key, "spark2_5", None);
        assert!(!model_has_mtp_layers(&no_key));

        let _ = std::fs::remove_file(&with_mtp);
        let _ = std::fs::remove_file(&zero_mtp);
        let _ = std::fs::remove_file(&no_key);
    }
}
