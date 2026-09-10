//! 智能路由「自我进化」数据与训练编排（投影器原位微调闭环）。
//!
//! 数据流：真实路由分类时（pool 线程）零成本捕获 `(文本, hidden, prev_tier,
//! probs)` → 用户在设置页标注正确层级 → `evolve_router_head` 在 Rust 端用
//! AdamW 微调当前头（`ai00_x_core::routing::training`）→ eval_pack 闸门
//! （新头准确率不回退才上线）→ 备份旧头 + 写入 + 复用热重载。
//!
//! 线程约束：pool 线程（std::thread）只做内存 push + 文件追加（µs 级），
//! 禁 tokio；训练/闸门跑在独立 std::thread，通过 AppHandle emit 进度事件。
//!
//! 防遗忘约束（与 training.rs 呼应）：mean/std 冻结、低学习率微调、
//! eval_pack 独立参照（不含捕获样本）。

use ai00_x_core::routing::training::{finetune_head, FinetuneOptions, TrainingSample};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use half::f16;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// 捕获样本上限（FIFO 淘汰）。f16+hex 存储 ≈ 3.1KB/条 → 满载 ~6MB。
const CAPTURE_LIMIT: usize = 2000;
/// 触发一次微调所需的最少已标注样本数。
const MIN_LABELED_FOR_EVOLVE: usize = 20;
/// 自动进化步长：每新增 200 条已标注样本自动触发一次微调。
const AUTO_EVOLVE_STEP: usize = 200;
/// 进化进行中的全局互斥（防止并发触发多个训练线程）。
static EVOLVE_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureRecord {
    /// Unix 毫秒时间戳。
    pub ts: u64,
    /// 分类输入原文（含 Summary 前缀，与 classify 输入一致）。
    pub text: String,
    /// mean-pooled hidden，f16 little-endian hex（768 维 ≈ 3KB）。
    pub hidden_hex: String,
    /// 上一轮 sticky 层级（0-3），None = 首轮/未知。
    pub prev_tier: Option<u8>,
    /// 分类头输出的 4 类概率（R0-R3，后处理前）。
    pub probs: [f32; 4],
    /// 采集时的骨干维度（换路由模型后旧样本自动失效过滤）。
    pub num_embd: usize,
    /// 正确层级标签（0-3）；None = 未标注。
    #[serde(default)]
    pub label: Option<u8>,
    /// 采集来源：route = 真实路由；preview = 设置页测试框（默认不采集）。
    #[serde(default)]
    pub source: String,
}

impl CaptureRecord {
    fn hidden_f32(&self) -> Vec<f32> {
        (0..self.hidden_hex.len() / 4)
            .map(|i| {
                let bytes = hex::decode(&self.hidden_hex[i * 4..i * 4 + 4]).unwrap_or_default();
                if bytes.len() == 2 {
                    f16::from_le_bytes([bytes[0], bytes[1]]).to_f32()
                } else {
                    0.0
                }
            })
            .collect()
    }
}

/// hex 编解码（无 hex crate 依赖时的本地实现）。
mod hex {
    pub fn decode(s: &str) -> Result<Vec<u8>, String> {
        if !s.len().is_multiple_of(2) {
            return Err("odd hex length".to_string());
        }
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string()))
            .collect()
    }

    pub fn encode(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}

pub fn hidden_to_hex(hidden: &[f32]) -> String {
    let mut buf = Vec::with_capacity(hidden.len() * 2);
    for &v in hidden {
        buf.extend_from_slice(&f16::from_f32(v).to_le_bytes()[..2]);
    }
    hex::encode(&buf)
}

struct Store {
    records: Vec<CaptureRecord>,
    path: PathBuf,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

fn store_path() -> PathBuf {
    crate::runtime::get_runtime_dir()
        .join("router_evolution")
        .join("samples.jsonl")
}

fn load_records(path: &PathBuf) -> Vec<CaptureRecord> {
    let mut records = Vec::new();
    if let Ok(f) = std::fs::File::open(path) {
        let reader = std::io::BufReader::new(f);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<CaptureRecord>(&line) {
                Ok(r) => records.push(r),
                Err(e) => log::warn!("[router-evolution] skip bad record: {e}"),
            }
        }
    }
    records
}

fn store() -> &'static Mutex<Store> {
    STORE.get_or_init(|| {
        let path = store_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let records = load_records(&path);
        log::info!(
            "[router-evolution] store loaded: {} records from {}",
            records.len(),
            path.display()
        );
        Mutex::new(Store { records, path })
    })
}

/// 全量重写存储文件（标注/删除/淘汰时）。
fn persist_all(store: &Store) -> Result<(), String> {
    let tmp = store.path.with_extension("jsonl.tmp");
    let content: String = store
        .records
        .iter()
        .filter_map(|r| serde_json::to_string(r).ok())
        .map(|mut s| {
            s.push('\n');
            s
        })
        .collect();
    std::fs::write(&tmp, content).map_err(|e| format!("persist failed: {e}"))?;
    std::fs::rename(&tmp, &store.path).map_err(|e| format!("persist rename failed: {e}"))?;
    Ok(())
}

/// 单条追加（pool 线程热路径：打开-append-关闭，µs~ms 级）。
fn append_record(store: &mut Store, rec: &CaptureRecord) -> Result<(), String> {
    let line = serde_json::to_string(rec).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&store.path)
        .map_err(|e| format!("append open failed: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("append write failed: {e}"))?;
    Ok(())
}

/// pool 线程调用：捕获一次真实路由分类。任何失败静默降级（不影响路由）。
pub fn capture_route_sample(
    text: &str,
    hidden: &[f32],
    prev_tier: Option<u8>,
    probs: &[f32],
    num_embd: usize,
) {
    if text.trim().is_empty() || hidden.is_empty() || probs.len() != 4 {
        return;
    }
    let rec = CaptureRecord {
        ts: now_ms(),
        text: text.chars().take(2000).collect(),
        hidden_hex: hidden_to_hex(hidden),
        prev_tier,
        probs: [probs[0], probs[1], probs[2], probs[3]],
        num_embd,
        label: None,
        source: "route".to_string(),
    };
    let mut need_rewrite = false;
    let result = store().lock().map(|mut s| {
        s.records.push(rec);
        if s.records.len() > CAPTURE_LIMIT {
            need_rewrite = true;
        } else if let Some(last) = s.records.last().cloned() {
            if let Err(e) = append_record(&mut s, &last) {
                log::warn!("[router-evolution] capture append failed: {e}");
            }
        }
    });
    if let Err(e) = result {
        log::warn!("[router-evolution] capture lock poisoned: {e}");
        return;
    }
    if need_rewrite {
        // FIFO 淘汰：超限一次性裁剪到上限的一半，避免频繁重写。
        let _ = store().lock().map(|mut s| {
            let drop_n = s.records.len() - CAPTURE_LIMIT / 2;
            s.records.drain(..drop_n);
            if let Err(e) = persist_all(&s) {
                log::warn!("[router-evolution] capture rewrite failed: {e}");
            }
        });
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tauri commands（设置页进化面板）
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct CaptureStats {
    pub total: usize,
    pub labeled: usize,
    pub unlabeled: usize,
    pub limit: usize,
    pub min_labeled_for_evolve: usize,
}

#[derive(Serialize, Clone)]
pub struct CaptureItem {
    pub idx: usize,
    pub ts: u64,
    pub text: String,
    pub probs: [f32; 4],
    pub prev_tier: Option<u8>,
    pub label: Option<u8>,
    pub source: String,
}

#[tauri::command]
pub fn router_capture_stats() -> CaptureStats {
    let s = store().lock().unwrap_or_else(|e| e.into_inner());
    let labeled = s.records.iter().filter(|r| r.label.is_some()).count();
    CaptureStats {
        total: s.records.len(),
        labeled,
        unlabeled: s.records.len() - labeled,
        limit: CAPTURE_LIMIT,
        min_labeled_for_evolve: MIN_LABELED_FOR_EVOLVE,
    }
}

#[tauri::command]
pub fn router_capture_list(offset: usize, limit: usize) -> Vec<CaptureItem> {
    let s = store().lock().unwrap_or_else(|e| e.into_inner());
    // 最新优先。
    s.records
        .iter()
        .rev()
        .skip(offset)
        .take(limit.clamp(1, 200))
        .enumerate()
        .map(|(i, r)| CaptureItem {
            idx: s.records.len() - 1 - offset - i,
            ts: r.ts,
            text: r.text.chars().take(300).collect(),
            probs: r.probs,
            prev_tier: r.prev_tier,
            label: r.label,
            source: r.source.clone(),
        })
        .collect()
}

/// 标注正确层级（0-3）；label=None 取消标注。idx 为当前存储数组下标。
#[tauri::command]
pub fn router_capture_label(
    app: tauri::AppHandle,
    idx: usize,
    label: Option<u8>,
) -> Result<(), String> {
    if let Some(l) = label {
        if l > 3 {
            return Err(format!("invalid tier label {l} (0-3)"));
        }
    }
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    let rec = s
        .records
        .get_mut(idx)
        .ok_or_else(|| format!("index {idx} out of range"))?;
    rec.label = label;
    let path_ok = persist_all(&s);
    drop(s);
    path_ok?;
    // 设值（非清除）后检查自动进化阈值。
    if label.is_some() {
        maybe_auto_evolve(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn router_capture_delete(idx: usize) -> Result<(), String> {
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    if idx >= s.records.len() {
        return Err(format!("index {idx} out of range"));
    }
    s.records.remove(idx);
    persist_all(&s)
}

#[tauri::command]
pub fn router_capture_clear() -> Result<(), String> {
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    s.records.clear();
    persist_all(&s)
}

// ---------------------------------------------------------------------------
// 进化（微调 + 闸门 + 热重载）
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct EvolveResult {
    pub status: String, // "ok" | "rejected" | "skipped"
    pub message: String,
    pub train_samples: usize,
    pub eval_samples: usize,
    pub epochs_run: usize,
    pub baseline_acc: f32,
    pub new_acc: f32,
}

#[derive(Serialize, Clone)]
pub struct EvolutionProgress {
    pub stage: String, // "loading" | "training" | "gating" | "done"
    pub detail: String,
}

fn load_pack_file(path: &Path) -> Result<(usize, Vec<TrainingSample>), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    #[derive(Deserialize)]
    struct Pack {
        version: u32,
        base_dim: usize,
        samples: Vec<PackSample>,
    }
    #[derive(Deserialize)]
    struct PackSample {
        h: String,
        t: u8,
        p: Option<u8>,
    }
    let pack: Pack = serde_json::from_str(&text).map_err(|e| format!("pack parse failed: {e}"))?;
    if pack.version != 1 {
        return Err(format!("unsupported pack version {}", pack.version));
    }
    let mut samples = Vec::with_capacity(pack.samples.len());
    for s in &pack.samples {
        let raw = B64
            .decode(&s.h)
            .map_err(|e| format!("pack hidden decode failed: {e}"))?;
        let hidden: Vec<f32> = raw
            .chunks_exact(2)
            .map(|c| f16::from_le_bytes([c[0], c[1]]).to_f32())
            .collect();
        samples.push(TrainingSample {
            hidden,
            prev_tier: s.p,
            label: s.t,
        });
    }
    Ok((pack.base_dim, samples))
}

fn load_eval_pack() -> Result<(usize, Vec<TrainingSample>), String> {
    let path = crate::runtime::get_models_dir()
        .join("rwkv")
        .join("eval_pack.json");
    let (dim, samples) = load_pack_file(&path).map_err(|_| {
        "eval_pack.json not found in models/rwkv (deploy it to enable evolution)".to_string()
    })?;
    Ok((dim, samples))
}

/// 回放池（与闸门集互斥切分，防灾难性遗忘）；未部署 = Ok(空)，退化为纯捕获微调。
fn load_replay_pool() -> Result<(usize, Vec<TrainingSample>), String> {
    let path = crate::runtime::get_models_dir()
        .join("rwkv")
        .join("replay_pool.json");
    if !path.exists() {
        return Ok((0, Vec::new()));
    }
    load_pack_file(&path)
}

/// 按类均衡取 target 条回放样本（round-robin 逐类轮取，池序固定 = 结果确定）。
fn replay_mix(pool: &[TrainingSample], target: usize) -> Vec<TrainingSample> {
    if pool.is_empty() || target == 0 {
        return Vec::new();
    }
    let mut by_class: [Vec<&TrainingSample>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    for s in pool {
        by_class[(s.label as usize).min(3)].push(s);
    }
    let mut out = Vec::with_capacity(target.min(pool.len()));
    let mut taken = [0usize; 4];
    while out.len() < target {
        let mut progressed = false;
        for (cls, rows) in by_class.iter().enumerate() {
            if out.len() >= target {
                break;
            }
            if taken[cls] < rows.len() {
                out.push(rows[taken[cls]].clone());
                taken[cls] += 1;
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }
    out
}

// ============================================================================
// 自动进化：每新增 AUTO_EVOLVE_STEP 条已标注样本自动触发一次微调
// ============================================================================

static LAST_AUTO_MARK: OnceLock<Mutex<usize>> = OnceLock::new();

fn auto_state_path() -> PathBuf {
    crate::runtime::get_runtime_dir()
        .join("router_evolution")
        .join("auto_state.json")
}

/// 上次自动进化触发时的已标注样本数（持久化，重启不重复触发）。
fn last_auto_mark() -> usize {
    *LAST_AUTO_MARK
        .get_or_init(|| {
            let n = std::fs::read_to_string(auto_state_path())
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("last_mark").and_then(|x| x.as_u64()))
                .unwrap_or(0) as usize;
            Mutex::new(n)
        })
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn save_auto_mark(n: usize) {
    *LAST_AUTO_MARK
        .get_or_init(|| Mutex::new(n))
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = n;
    let path = auto_state_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::json!({ "last_mark": n }).to_string();
    let _ = std::fs::write(&path, body);
}

/// 下一次自动进化阈值（stats 展示用）。
pub fn next_auto_evolve_at() -> usize {
    last_auto_mark() + AUTO_EVOLVE_STEP
}

/// 标注落库后调用：满足「新增标注 ≥ 200」且无进化进行中时，后台触发自动进化。
///
/// 触发即推进标记并持久化（无论 ok/rejected/skipped）——闸门拒绝说明这批数据
/// 无收益，凑满下一批再试；否则每次标注都会反复白跑训练。
pub fn maybe_auto_evolve(app: &tauri::AppHandle) {
    let labeled = {
        let s = store().lock().unwrap_or_else(|e| e.into_inner());
        s.records.iter().filter(|r| r.label.is_some()).count()
    };
    let mark = last_auto_mark();
    if labeled < mark.saturating_add(AUTO_EVOLVE_STEP) {
        return;
    }
    // 占坑失败 = 手动进化进行中：不推进标记，下次标注再查。
    if EVOLVE_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    save_auto_mark(labeled);
    let app = app.clone();
    std::thread::spawn(move || {
        log::info!("[router-evolution] auto-evolve triggered ({labeled} labeled)");
        let result = run_evolution_inner(Some(app));
        EVOLVE_RUNNING.store(false, Ordering::SeqCst);
        log::info!(
            "[router-evolution] auto-evolve finished: {} ({})",
            result.status,
            result.message
        );
    });
}

/// 进化主流程（独立线程执行；通过 app emit 进度）。
pub fn run_evolution(app: Option<tauri::AppHandle>) -> EvolveResult {
    if EVOLVE_RUNNING.swap(true, Ordering::SeqCst) {
        return EvolveResult {
            status: "skipped".to_string(),
            message: "evolution already running".to_string(),
            train_samples: 0,
            eval_samples: 0,
            epochs_run: 0,
            baseline_acc: 0.0,
            new_acc: 0.0,
        };
    }
    let result = run_evolution_inner(app);
    EVOLVE_RUNNING.store(false, Ordering::SeqCst);
    result
}

fn emit(app: &Option<tauri::AppHandle>, stage: &str, detail: &str) {
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit(
            "router://evolution",
            EvolutionProgress {
                stage: stage.to_string(),
                detail: detail.to_string(),
            },
        );
    }
}

fn run_evolution_inner(app: Option<tauri::AppHandle>) -> EvolveResult {
    let fail = |status: &str, message: String| EvolveResult {
        status: status.to_string(),
        message,
        train_samples: 0,
        eval_samples: 0,
        epochs_run: 0,
        baseline_acc: 0.0,
        new_acc: 0.0,
    };

    // 1. 收集已标注样本（按当前头期望维度过滤）。
    emit(&app, "loading", "collecting labeled samples");
    let (head_path, expected_dim) = match current_head_info() {
        Ok(v) => v,
        Err(e) => return fail("skipped", e),
    };
    let labeled: Vec<TrainingSample> = {
        let s = store().lock().unwrap_or_else(|e| e.into_inner());
        s.records
            .iter()
            .filter(|r| r.num_embd == expected_dim)
            .filter_map(|r| {
                r.label.map(|label| TrainingSample {
                    hidden: r.hidden_f32(),
                    prev_tier: r.prev_tier,
                    label,
                })
            })
            .collect()
    };
    if labeled.len() < MIN_LABELED_FOR_EVOLVE {
        return fail(
            "skipped",
            format!(
                "need >= {MIN_LABELED_FOR_EVOLVE} labeled samples, have {}",
                labeled.len()
            ),
        );
    }

    // 2. 加载闸门评估包。
    emit(&app, "loading", "loading eval pack");
    let (pack_dim, eval_samples) = match load_eval_pack() {
        Ok(v) => v,
        Err(e) => return fail("skipped", e),
    };
    if pack_dim != expected_dim {
        return fail(
            "skipped",
            format!("eval_pack base_dim {pack_dim} != head {expected_dim}"),
        );
    }

    // 2.5 加载回放池（与闸门集互斥；缺失则退化为纯捕获微调）。
    let replay = match load_replay_pool() {
        Ok((replay_dim, pool)) => {
            if replay_dim != 0 && replay_dim != expected_dim {
                log::warn!(
                    "[router_evolution] replay_pool base_dim {replay_dim} != head {expected_dim}, replay disabled"
                );
                Vec::new()
            } else {
                pool
            }
        }
        Err(e) => {
            log::warn!("[router_evolution] replay_pool load failed, replay disabled: {e}");
            Vec::new()
        }
    };
    let mut train_samples = labeled;
    if replay.is_empty() {
        log::info!(
            "[router_evolution] replay pool not deployed, training on captured samples only"
        );
    } else {
        // 1:1 回放（按类均衡），池子不足时全部混入。
        let mixed = replay_mix(&replay, train_samples.len());
        log::info!(
            "[router_evolution] replay mixing: {} replay + {} captured",
            mixed.len(),
            train_samples.len()
        );
        train_samples.extend(mixed);
    }

    // 3. 原位微调（冻结 mean/std，低学习率）。
    emit(
        &app,
        "training",
        &format!("{} train samples", train_samples.len()),
    );
    let base = match ai00_x_core::routing::head::RouterHead::from_json_file(&head_path) {
        Ok(h) => h,
        Err(e) => return fail("skipped", format!("load head failed: {e}")),
    };
    let opts = FinetuneOptions::default();
    // 早停集不传 eval_pack（避免 selection bias 虚高闸门），训练器内部自切。
    let (new_head, report) = match finetune_head(&base, &train_samples, None, &opts) {
        Ok(v) => v,
        Err(e) => return fail("skipped", format!("finetune failed: {e}")),
    };

    // 4. 闸门：新头在 eval_pack 上不回退（容差 0.5%）才上线。
    emit(&app, "gating", "comparing heads on eval pack");
    let old_head = &base;
    let new_acc = eval_head_acc(&new_head, &eval_samples);
    // baseline（report.baseline_eval_acc 是训练切分上的，闸门用全量 pack 重算）。
    let baseline_acc = eval_head_acc(old_head, &eval_samples);

    if new_acc < baseline_acc - 0.005 {
        let msg = format!(
            "gated: new head acc {new_acc:.4} < baseline {baseline_acc:.4} - 0.005; old head kept"
        );
        log::warn!("[router-evolution] {msg}");
        emit(&app, "done", &msg);
        return EvolveResult {
            status: "rejected".to_string(),
            message: msg,
            train_samples: report.train_samples,
            eval_samples: eval_samples.len(),
            epochs_run: report.epochs_run,
            baseline_acc,
            new_acc,
        };
    }

    // 5. 备份旧头 + 写入新头 + 热重载。
    let backup = head_path.with_extension("json.bak");
    if let Err(e) = std::fs::copy(&head_path, &backup) {
        log::warn!("[router-evolution] head backup failed: {e}");
    }
    let weights = new_head.trainable();
    let new_json = serde_json::json!({
        "version": 1,
        "input_dim": new_head.input_dim(),
        "hidden_dim": new_head.hidden_dim(),
        "base_dim": new_head.expected_hidden_dim(),
        "mean": new_head.mean_iter().collect::<Vec<f32>>(),
        "std": new_head.std_iter().collect::<Vec<f32>>(),
        "w1": weights.w1, "b1": weights.b1,
        "ln_g": weights.ln_g, "ln_b": weights.ln_b,
        "w2": weights.w2, "b2": weights.b2,
    });
    if let Err(e) = std::fs::write(&head_path, new_json.to_string()) {
        return fail("skipped", format!("write head failed: {e}"));
    }
    log::info!(
        "[router-evolution] evolved: acc {:.4} -> {:.4} ({} samples, {} epochs); reloading head",
        baseline_acc,
        new_acc,
        report.train_samples,
        report.epochs_run
    );
    emit(&app, "done", "head updated, reloading");
    // 热重载复用现有链路（spawn_blocking 上下文，tokio oneshot blocking_recv）。
    if let Err(e) = crate::rwkv_llm::reload_head_blocking() {
        log::warn!("[router-evolution] hot reload failed (restart or manual reload needed): {e}");
    }
    EvolveResult {
        status: "ok".to_string(),
        message: format!(
            "evolved: acc {:.4} -> {:.4} ({} labeled, {} epochs)",
            baseline_acc, new_acc, report.train_samples, report.epochs_run
        ),
        train_samples: report.train_samples,
        eval_samples: eval_samples.len(),
        epochs_run: report.epochs_run,
        baseline_acc,
        new_acc,
    }
}

/// 读取当前头文件路径与期望 hidden 维度（router_mini 优先，主模型回退）。
fn current_head_info() -> Result<(PathBuf, usize), String> {
    crate::rwkv_llm::router_head_target()
}

/// 头在样本集上的 top-1 准确率。
fn eval_head_acc(head: &ai00_x_core::routing::head::RouterHead, samples: &[TrainingSample]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut hit = 0usize;
    for s in samples {
        if let Ok(probs) = head.forward(&s.hidden, s.prev_tier) {
            let argmax = probs
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(i, _)| i)
                .unwrap_or(0);
            if argmax == s.label as usize {
                hit += 1;
            }
        }
    }
    hit as f32 / samples.len() as f32
}

#[tauri::command]
pub async fn evolve_router_head(app: tauri::AppHandle) -> Result<EvolveResult, String> {
    // 训练（66 万参数、秒级）放阻塞线程，避免卡 UI。
    let result = tokio::task::spawn_blocking(move || run_evolution(Some(app)))
        .await
        .map_err(|e| format!("evolution thread failed: {e}"))?;
    Ok(result)
}
