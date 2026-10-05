//! RWKV 推理核心（rwkv-rsv 引擎：Vulkan/CUDA 后端）。
//!
//! 架构：模型与全部推理状态由专用 OS 线程持有（rwkv-rsv 为同步 API 且
//! `GpuModel` 非 Send），上层（Tauri 命令 / ai-adapters）通过 channel 提交
//! 任务，事件经 `InferenceEvent` 回流，接口与旧 web-rwkv 实现完全兼容。

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

/// Current time in ms since epoch (keep_alive accounting).
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

use rwkv_rsv::gpu_model::{Bundle, GpuModel, ModelBuilder, SamplerParams, State};
use rwkv_rsv::tokenizer::Tokenizer;

const DEBUG_LOG_LLM: bool = false;
macro_rules! debug_print {
    ($($arg:tt)*) => {
        if DEBUG_LOG_LLM {
            println!($($arg)*);
        }
    };
}

const MAX_SLOTS: usize = 16;
/// prefill 分块长度：限制单次 seq 缓冲大小（块大小固定避免重建）。
const PREFILL_CHUNK: usize = 128;
/// 惩罚历史每槽容量（token 数）。超出后丢弃最旧 1/4（惩罚窗口滑动，语义与
/// 客户端原 `token_counts` 的"全历史计数"在窗口内等价）。
const HIST_STRIDE: usize = 8192;

pub enum InferenceEvent {
    Token(String),
    Done {
        text: String,
        input_tokens: usize,
        output_tokens: usize,
        stop_sequence: Option<String>,
    },
    Error(String),
}

/// 单个生成任务。生命周期：`pending` → `prefill_queue`（串行分块 prefill）
/// → 解码组（密集占 batch 行）→ `finish_pending` 补喂末 token → 回收。
///
/// 解码组内**本步喂入的 token 即上一步采样的结果**（`feed_token` 与 `acc_ids`
/// 错开一格）。判定结束时先补喂最后一个 token（丢弃其采样结果）再回写缓存，
/// 使「状态已消费的 token」与「会话缓存 token 列表」严格一致——对齐旧实现
/// 「先 forward 后判停」的语义，续聊前缀匹配才不会错位。
struct InferenceTask {
    prompt_tokens: Vec<u32>,
    input_tokens: Vec<u32>,
    /// 会话缓存继承的 token 前缀（状态起点对应；空 = 零态起步）。
    base_tokens: Vec<u32>,
    /// prefill 已喂入的 input_tokens 数量（分块推进游标）。
    prefill_cursor: usize,
    /// prefill 末块产出的 logits（首 token 主机采样用；采样后取走）。
    prefill_logits: Option<Vec<f32>>,
    /// 会话缓存命中的起步状态（prefill 起点；None = 零初始状态）。
    resume_state: Option<Vec<f32>>,
    session_id: Option<String>,
    max_tokens: usize,
    top_p: f32,
    top_k: usize,
    presence_penalty: f32,
    frequency_penalty: f32,
    penalty_decay: f32,
    stop: Option<Vec<String>>,
    is_streaming: bool,
    tx: mpsc::UnboundedSender<InferenceEvent>,
    /// 已发射的 token（顺序）——用于流式增量解码与最终文本。
    acc_ids: Vec<u32>,
    /// 惩罚历史（model_text 编码 + 已生成 token），GPU 采样器按此计数。
    hist: Vec<u32>,
    /// 本步要喂入解码组的 token（= 上一步采样的结果）。
    feed_token: u32,
    /// 采样种子，每步递增。
    seed: u32,
    stop_buffer: String,
    last_decoded_len: usize,
    steps_done: usize,
    ended_by_stop: bool,
    /// 命中的 stop 串（Done 时从文本尾部截断用）。
    hit_stop: Option<String>,
    /// 已判定结束、等待最后一次补喂（下一轮喂完即回写缓存并发 Done）。
    finish_pending: bool,
}

struct InferenceTaskParams {
    prompt: String,
    max_tokens: usize,
    top_p: f32,
    top_k: usize,
    presence_penalty: f32,
    frequency_penalty: f32,
    penalty_decay: f32,
    stop: Option<Vec<String>>,
    session_id: Option<String>,
    is_streaming: bool,
    is_vrm: bool,
    /// Prior Assistant message contents (joined by \n\n) to initialize penalty state.
    /// Without this, presence_penalty and frequency_penalty have no memory and are ineffective.
    model_text: String,
    tx: mpsc::UnboundedSender<InferenceEvent>,
}

enum PoolRequest {
    Init {
        model_path: String,
        vocab_path: String,
        /// 路径不同时热切换（卸载旧模型重建）；推理中返回忙错误。
        force: bool,
        app: Option<tauri::AppHandle>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Submit(InferenceTaskParams),
    ClearSession(String),
    /// Single-shot classification (smart router): mean-hidden extraction from
    /// a zero state + trained MLP head -> four tier probabilities (R0-R3).
    /// `prev_tier`: sticky-tier value of the previous turn (v4 head one-hot;
    /// v1 head ignores). `capture`: true = 真实路由（进化数据回流捕获样本）；
    /// false = 设置页预览（不采集）。
    Classify {
        request: String,
        prev_tier: Option<u8>,
        capture: bool,
        reply: oneshot::Sender<Result<Vec<f32>, String>>,
    },
    /// 查询当前可用分类骨干的 hidden 维度（router_mini 优先，主模型回退）；
    /// 两者皆未加载时 None。进化流程用于样本维度过滤。
    RouterDim {
        reply: oneshot::Sender<Option<usize>>,
    },
    /// Hot-reload the router classification head (router_head.json) into the
    /// running engine without an app restart.
    ReloadRouterHead {
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Load/replace the resident router mini model (0.1B, classify-only).
    /// Independent of the main engine: does not touch slots/Init/Evict.
    InitRouter {
        model_path: String,
        vocab_path: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// VRAM manager eviction: unload the engine if idle (busy -> ignored).
    Evict,
}

struct InferencePoolHandle {
    tx: mpsc::UnboundedSender<PoolRequest>,
}

/// Conservative VRAM estimate for a RWKV model: total on-disk weight bytes
/// (file or directory) x 1.2 (weights + runtime states + buffers).
fn estimate_rwkv_vram_bytes(model_path: &str) -> Option<u64> {
    let path = Path::new(model_path);
    let total = if path.is_file() {
        std::fs::metadata(path).ok()?.len()
    } else if path.is_dir() {
        let mut sum = 0u64;
        for entry in std::fs::read_dir(path).ok()? {
            let Ok(entry) = entry else { continue };
            if entry.file_type().ok()?.is_file() {
                sum += entry.metadata().ok()?.len();
            }
        }
        sum
    } else {
        return None;
    };
    if total == 0 {
        return None;
    }
    Some(total + total / 5)
}

static INFERENCE_POOL: OnceLock<InferencePoolHandle> = OnceLock::new();
static LLM_READY: AtomicBool = AtomicBool::new(false);
/// Inference in progress (any active slot or pending task). Governed engines
/// with busy=true are never evicted.
static LLM_BUSY: AtomicBool = AtomicBool::new(false);
/// Last submit/classify timestamp (ms since epoch) for keep_alive accounting.
static LLM_LAST_USED_MS: AtomicU64 = AtomicU64::new(0);
static CANCEL_EPOCH: OnceLock<AtomicU64> = OnceLock::new();
static LLM_INITING: OnceLock<Mutex<bool>> = OnceLock::new();
/// 当前已加载模型路径（路径感知切换 gate：相同路径直接返回，不同路径触发热切换）。
static LLM_CURRENT_MODEL: RwLock<Option<String>> = RwLock::new(None);
/// 路由小模型（0.1B）常驻槽就绪标志：与主模型 LLM_READY 相互独立。
static ROUTER_MINI_READY: AtomicBool = AtomicBool::new(false);
/// 路由小模型固定文件名（models/rwkv/ 下；`router-` 前缀用于主模型扫描过滤）。
const ROUTER_MODEL_FILE: &str = "router-0.1B-int8.st";

fn router_model_path() -> PathBuf {
    assets_models_dir().join(ROUTER_MODEL_FILE)
}

fn get_inference_pool() -> Option<&'static InferencePoolHandle> {
    INFERENCE_POOL.get()
}

/// 确保 pool 线程已启动（Init / InitRouter 共用入口）。
fn ensure_inference_pool() -> &'static InferencePoolHandle {
    INFERENCE_POOL.get_or_init(|| {
        let (pool_tx, pool_rx) = mpsc::unbounded_channel::<PoolRequest>();
        std::thread::Builder::new()
            .name("rwkv-inference-pool".to_string())
            .spawn(move || inference_pool_main(pool_rx))
            .expect("failed to spawn rwkv inference pool thread");
        InferencePoolHandle { tx: pool_tx }
    })
}

// ---------------------------------------------------------------------------
// VRAM manager integration
// ---------------------------------------------------------------------------

/// RWKV LLM governed-engine adapter (priority 0, default keep forever).
struct RwkvLlmGoverned;

impl crate::vram_manager::ManagedEngine for RwkvLlmGoverned {
    fn id(&self) -> &str {
        "rwkv-llm"
    }
    fn display_name(&self) -> String {
        "RWKV 对话".to_string()
    }
    fn priority(&self) -> i32 {
        0
    }
    fn is_resident(&self) -> bool {
        LLM_READY.load(Ordering::SeqCst)
    }
    fn is_busy(&self) -> bool {
        LLM_BUSY.load(Ordering::SeqCst)
    }
    fn estimate_vram_bytes(&self) -> Option<u64> {
        let cur = LLM_CURRENT_MODEL.read().ok()?.clone()?;
        estimate_rwkv_vram_bytes(&cur)
    }
    fn last_used_ms(&self) -> u64 {
        LLM_LAST_USED_MS.load(Ordering::Relaxed)
    }
    fn evict(&self) -> Result<(), String> {
        let pool = get_inference_pool().ok_or("pool not started")?;
        pool.tx
            .send(PoolRequest::Evict)
            .map_err(|_| "pool gone".to_string())?;
        // Block until confirmed unloaded (10s cap).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if !LLM_READY.load(Ordering::SeqCst) {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Err("rwkv-llm evict timed out".to_string())
    }
}

/// Register the RWKV engine with the VRAM manager (once).
fn register_with_vram_manager() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        crate::vram_manager::register_engine(std::sync::Arc::new(RwkvLlmGoverned));
    });
}

pub fn is_llm_initialized() -> bool {
    LLM_READY.load(Ordering::SeqCst)
}

/// 智能路由分类头的全局可查询加载状态（引擎 Init 时写入，UI 读取展示）。
#[derive(Debug, Clone, Serialize)]
pub struct RouterHeadStatus {
    pub loaded: bool,
    pub input_dim: Option<usize>,
    /// 未加载原因（文件缺失 / 解析失败 / 维度不匹配 / 引擎未初始化）。
    pub detail: Option<String>,
}

impl RouterHeadStatus {
    fn engine_not_ready() -> Self {
        Self {
            loaded: false,
            input_dim: None,
            detail: Some("engine not initialized".to_string()),
        }
    }
}

static ROUTER_HEAD_STATUS: OnceLock<RwLock<RouterHeadStatus>> = OnceLock::new();

fn set_router_head_status(status: RouterHeadStatus) {
    let lock = ROUTER_HEAD_STATUS.get_or_init(|| RwLock::new(RouterHeadStatus::engine_not_ready()));
    if let Ok(mut guard) = lock.write() {
        *guard = status;
    }
}

/// 读取分类头当前加载状态；引擎从未初始化过时返回"未初始化"。
pub fn get_router_head_status() -> RouterHeadStatus {
    match ROUTER_HEAD_STATUS.get() {
        Some(lock) => lock
            .read()
            .map(|g| g.clone())
            .unwrap_or_else(|_| RouterHeadStatus::engine_not_ready()),
        None => RouterHeadStatus::engine_not_ready(),
    }
}

/// 加载智能路由分类头（models 目录 router_head.json），并写入全局状态。
/// 缺失/损坏/维度不匹配时返回 None（分类降级回落），状态记录原因。
fn load_router_head(model_num_emb: usize) -> Option<ai00_x_core::routing::head::RouterHead> {
    let head_path = assets_models_dir().join("router_head.json");
    if !head_path.exists() {
        log::info!(
            "[rwkv] router head not found at {}, smart-router classify disabled",
            head_path.display()
        );
        set_router_head_status(RouterHeadStatus {
            loaded: false,
            input_dim: None,
            detail: Some("router_head.json not found in models/rwkv".to_string()),
        });
        return None;
    }
    match ai00_x_core::routing::head::RouterHead::from_json_file(&head_path) {
        Ok(head) => {
            // v4 头 input_dim = base_dim + 5（prev_tier one-hot），须按
            // expected_hidden_dim（= base_dim）与模型 n_embd 校验。
            if head.expected_hidden_dim() != model_num_emb {
                log::warn!(
                    "[rwkv] router head hidden dim {} != model n_embd {}, classify disabled",
                    head.expected_hidden_dim(),
                    model_num_emb
                );
                set_router_head_status(RouterHeadStatus {
                    loaded: false,
                    input_dim: Some(head.input_dim()),
                    detail: Some(format!(
                        "dimension mismatch: head hidden {} vs model {}",
                        head.expected_hidden_dim(),
                        model_num_emb
                    )),
                });
                return None;
            }
            log::info!(
                "[rwkv] router head loaded: input_dim={} hidden_dim={}",
                head.input_dim(),
                head.hidden_dim()
            );
            set_router_head_status(RouterHeadStatus {
                loaded: true,
                input_dim: Some(head.input_dim()),
                detail: None,
            });
            Some(head)
        }
        Err(e) => {
            log::warn!(
                "[rwkv] router head load failed ({}), classify disabled: {}",
                head_path.display(),
                e
            );
            set_router_head_status(RouterHeadStatus {
                loaded: false,
                input_dim: None,
                detail: Some(format!("parse failed: {e}")),
            });
            None
        }
    }
}

/// 推理引擎全部状态（仅 pool 线程访问，无锁）。
struct PoolEngine {
    model: GpuModel,
    /// 批量解码组状态：batch = slot_count；活跃任务密集占行 [0, n_active)。
    decode_state: State,
    /// 解码组各行的惩罚历史设备缓冲 [slot_count, HIST_STRIDE]（前 hist_len 个有效）。
    hist_buf: rwkv_rsv::backend::TensorId,
    /// 单序列状态：串行 prefill 专用（与解码组隔离，避免 seq 缓冲互相抖动）。
    prefill_state: State,
    /// 是否走批量解码路径（fp16 模型缺 batch 层 kernel → 逐槽单序列兜底）。
    use_batch_decode: bool,
    /// 兜底路径的每槽单序列状态（仅 `!use_batch_decode` 时非空；批量路径不用）。
    slot_states: Vec<State>,
    /// 本模型实际启用的生成槽位数（按模型规模动态核减，≤ MAX_SLOTS）。
    slot_count: usize,
    tokenizer: Tokenizer,
    /// 零初始状态缓存（新任务/无缓存任务重置 slot 用）。
    initial_state: Vec<f32>,
    /// session_id → (已缓存 token 序列, RNN 状态)
    session_states: HashMap<String, (Vec<u32>, Vec<f32>)>,
    /// 专用分类状态（智能路由 prefill 用，与生成槽位隔离；仅主模型兼容回退时使用）。
    classify_state: State,
}

/// 常驻路由小模型（0.1B，仅做 R0-R3 分类）。生命周期与主引擎完全独立：
/// 主模型 Init/热切换/Evict 均不触碰本槽，路由可用性不受主模型影响。
struct RouterMini {
    model: GpuModel,
    /// 零初始状态快照（每次分类前重置）。
    initial_state: Vec<f32>,
    classify_state: State,
    tokenizer: Tokenizer,
    num_embd: usize,
    model_path: String,
}

/// pool 线程主循环：常驻，Init 消息触发（重）加载，Submit/ClearSession 业务消息。
fn inference_pool_main(pool_rx: mpsc::UnboundedReceiver<PoolRequest>) {
    let mut pool_rx = pool_rx;
    let mut engine: Option<PoolEngine> = None;
    // 常驻路由小模型与分类头（与主引擎生命周期解耦；分类头全局唯一，
    // 按所选分类模型的 n_embd 校验匹配）。
    let mut router_mini: Option<RouterMini> = None;
    let mut router_head: Option<ai00_x_core::routing::head::RouterHead> = None;
    // 解码组：活跃任务密集占前缀 [0, n_active)，索引即 batch 行。
    let mut tasks: Vec<Option<InferenceTask>> = (0..MAX_SLOTS).map(|_| None).collect();
    // prefill 队列：串行推进（prefill_state 独占），每轮喂一块。
    let mut prefill_queue: VecDeque<InferenceTask> = VecDeque::new();
    let mut pending: Vec<InferenceTaskParams> = Vec::new();
    // 采样种子基数：每任务递增（GPU 采样器以 seed 哈希随机数）。
    let mut seed_counter: u32 = 1;

    loop {
        // 引擎或路由小模型存在且完全空闲 → 可进入等待；否则非阻塞抽干消息。
        // 注意 router_mini 计入空闲判定：主模型未加载时不能陷入忙等空转。
        let idle = (engine.is_some() || router_mini.is_some())
            && tasks.iter().all(|s| s.is_none())
            && prefill_queue.is_empty()
            && pending.is_empty();
        LLM_BUSY.store(!idle, Ordering::SeqCst);
        if idle {
            if engine.is_some() {
                // keep_alive 等待：到期空闲卸载（-1 常驻 → 短轮询仅响应 Evict）。
                // 注意：池线程是普通 OS 线程（std::thread::spawn，无 tokio 上下文），
                // 不能用 timer runtime block_on（release 下触发 "no reactor" panic），
                // 这里用 std 轮询等待，语义等价：到点即查卸载，消息随到随处理。
                let keep_alive = crate::vram_manager::resolve_policy("rwkv-llm", 0).keep_alive_secs;
                let elapsed = now_ms().saturating_sub(LLM_LAST_USED_MS.load(Ordering::Relaxed));
                let wait = if keep_alive < 0 {
                    std::time::Duration::from_millis(500)
                } else {
                    let remaining_ms = (keep_alive as u64)
                        .saturating_mul(1000)
                        .saturating_sub(elapsed)
                        .max(1);
                    std::time::Duration::from_millis(remaining_ms.min(500))
                };
                let deadline = std::time::Instant::now() + wait;
                let mut exit_pool = false;
                'keep_alive_wait: loop {
                    // 抽干已到达的消息
                    while let Ok(req) = pool_rx.try_recv() {
                        if !handle_request(
                            req,
                            &mut engine,
                            &mut router_mini,
                            &mut router_head,
                            &mut pending,
                            false,
                        ) {
                            exit_pool = true;
                            break 'keep_alive_wait;
                        }
                    }
                    if pool_rx.is_closed() {
                        exit_pool = true;
                        break 'keep_alive_wait;
                    }
                    if std::time::Instant::now() >= deadline {
                        break 'keep_alive_wait;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                // 等待结束：检查 keep_alive 是否到期（到期则卸载释放 VRAM）
                let last_used = LLM_LAST_USED_MS.load(Ordering::Relaxed);
                let keep_alive = crate::vram_manager::resolve_policy("rwkv-llm", 0).keep_alive_secs;
                if keep_alive >= 0
                    && now_ms().saturating_sub(last_used)
                        >= (keep_alive as u64).saturating_mul(1000)
                {
                    log::info!(
                        "[rwkv] idle {}s (keep_alive {}s), releasing VRAM",
                        keep_alive,
                        keep_alive
                    );
                    engine = None;
                    LLM_READY.store(false, Ordering::SeqCst);
                    crate::vram_manager::notify_state(
                        "rwkv-llm",
                        "RWKV 对话",
                        false,
                        "idle-timeout",
                    );
                }
                if exit_pool {
                    break;
                }
            } else {
                match pool_rx.blocking_recv() {
                    Some(req) => {
                        if !handle_request(
                            req,
                            &mut engine,
                            &mut router_mini,
                            &mut router_head,
                            &mut pending,
                            false,
                        ) {
                            break;
                        }
                    }
                    None => break,
                }
            }
        } else {
            while let Ok(req) = pool_rx.try_recv() {
                let busy = !pending.is_empty()
                    || !prefill_queue.is_empty()
                    || tasks.iter().any(|s| s.is_some());
                if !handle_request(
                    req,
                    &mut engine,
                    &mut router_mini,
                    &mut router_head,
                    &mut pending,
                    busy,
                ) {
                    return;
                }
            }
        }

        // 引擎未就绪时（Init 失败/尚未 Init），无任务可推进
        let Some(engine) = engine.as_mut() else {
            continue;
        };

        // 调度 pending → prefill 队列（活跃任务总数 ≤ slot_count）
        while !pending.is_empty() {
            let active = tasks.iter().filter(|s| s.is_some()).count() + prefill_queue.len();
            if active >= engine.slot_count {
                break;
            }
            let params = pending.remove(0);
            let tx = params.tx.clone();
            let seed = seed_counter;
            seed_counter = seed_counter.wrapping_add(1);
            match prepare_task(params, engine, seed) {
                Ok(task) => prefill_queue.push_back(task),
                Err(e) => {
                    let _ = tx.send(InferenceEvent::Error(e));
                }
            }
        }

        // prefill 一步：串行推进队首任务一块（其余任务的解码不受阻塞）。
        if let Some(task) = prefill_queue.front_mut() {
            match prefill_step(task, engine) {
                Ok(true) => {
                    // 队首 prefill 完成 → 转入解码组（活跃数 ≤ slot_count 保证有空行）
                    let mut task = prefill_queue.pop_front().expect("队首存在");
                    let row = tasks
                        .iter()
                        .position(|s| s.is_none())
                        .expect("活跃数 ≤ slot_count 保证有空行");
                    match join_decode_group(&mut task, engine, row) {
                        Ok(true) => tasks[row] = Some(task),
                        // 首 token 即结束（stop / max_tokens=1）：已在 join 内收尾
                        Ok(false) => {}
                        Err(e) => {
                            log::error!("[rwkv] join decode group failed: {}", e);
                            let _ = task.tx.send(InferenceEvent::Error(e));
                        }
                    }
                }
                Ok(false) => {}
                Err(e) => {
                    let task = prefill_queue.pop_front().expect("队首存在");
                    log::error!("[rwkv] prefill error: {}", e);
                    let _ = task.tx.send(InferenceEvent::Error(e));
                }
            }
        }

        // 解码组推进一步（批量前向 + GPU 采样），并回收已补喂完成的任务。
        if tasks[0].is_some() {
            let n_active = tasks.iter().take_while(|s| s.is_some()).count();
            // 本轮开始时已处于「待补喂」状态的行：喂完即回写缓存 + 发 Done。
            let finalize_rows: Vec<usize> = (0..n_active)
                .filter(|&i| tasks[i].as_ref().is_some_and(|t| t.finish_pending))
                .collect();
            if let Err(e) = decode_step(&mut tasks[..n_active], engine) {
                log::error!("[rwkv] decode step failed: {}", e);
                for slot in tasks[..n_active].iter_mut() {
                    if let Some(t) = slot.take() {
                        let _ = t.tx.send(InferenceEvent::Error(e.clone()));
                    }
                }
            } else {
                for row in finalize_rows {
                    if let Some(mut t) = tasks[row].take() {
                        finalize_task(&mut t, engine, Some(row));
                    }
                }
                compact_tasks(&mut tasks[..n_active], engine);
            }
        }
    }

    LLM_READY.store(false, Ordering::SeqCst);
    log::info!("[rwkv] inference pool thread exited");
}

/// 处理一条请求。返回 false 表示线程应退出（channel 关闭或 Shutdown）。
/// `busy`：调用时是否有活跃/待处理任务（热切换忙检查用；阻塞等待路径恒为 false）。
#[allow(clippy::too_many_arguments)]
fn handle_request(
    req: PoolRequest,
    engine: &mut Option<PoolEngine>,
    router_mini: &mut Option<RouterMini>,
    router_head: &mut Option<ai00_x_core::routing::head::RouterHead>,
    pending: &mut Vec<InferenceTaskParams>,
    busy: bool,
) -> bool {
    match req {
        PoolRequest::Init {
            model_path,
            vocab_path,
            force,
            app,
            reply,
        } => {
            if engine.is_some() && !force {
                LLM_READY.store(true, Ordering::SeqCst);
                let _ = reply.send(Ok(()));
                return true;
            }
            if engine.is_some() && force {
                if busy {
                    let _ = reply.send(Err(
                        "engine busy: inference in progress, switch later".to_string()
                    ));
                    return true;
                }
                // 热切换：卸载旧模型（drop 释放 GPU 资源）后重建
                log::info!(
                    "[rwkv] switching model: unloading previous engine ({} slots freed)",
                    engine.as_ref().map(|e| e.slot_count).unwrap_or(0)
                );
                *engine = None;
                LLM_READY.store(false, Ordering::SeqCst);
            }
            if let Some(app) = &app {
                let _ = app.emit("rwkv://debug", "llm loading model".to_string());
            }
            // VRAM budget check before (re)loading — may evict other engines.
            let estimate = estimate_rwkv_vram_bytes(&model_path).unwrap_or(0);
            if let Err(e) = crate::vram_manager::ensure_capacity(estimate, None) {
                log::warn!("[rwkv] budget check failed, loading anyway: {e}");
            }
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                load_engine(&model_path, &vocab_path)
            }));
            match result {
                Ok(Ok(e)) => {
                    *engine = Some(e);
                    if let Ok(mut cur) = LLM_CURRENT_MODEL.write() {
                        *cur = Some(model_path.clone());
                    }
                    LLM_READY.store(true, Ordering::SeqCst);
                    if let Some(app) = &app {
                        let _ = app.emit("rwkv://debug", "llm initialized".to_string());
                    }
                    let _ = reply.send(Ok(()));
                }
                Ok(Err(e)) => {
                    if let Some(app) = &app {
                        let _ = app.emit("rwkv://debug", format!("llm init failed: {}", e));
                    }
                    let _ = reply.send(Err(e));
                }
                Err(panic) => {
                    let msg = format!("llm init panicked: {:?}", panic);
                    log::error!("[rwkv] {}", msg);
                    if let Some(app) = &app {
                        let _ = app.emit("rwkv://debug", msg.clone());
                    }
                    let _ = reply.send(Err(msg));
                }
            }
            true
        }
        PoolRequest::Evict => {
            if engine.is_some() && !busy {
                log::info!("[rwkv] evicted by VRAM manager, releasing VRAM");
                *engine = None;
                LLM_READY.store(false, Ordering::SeqCst);
                crate::vram_manager::notify_state("rwkv-llm", "RWKV 对话", false, "evicted");
            }
            // busy: ignore — the manager never evicts busy engines.
            // 注意：router_mini 常驻槽不随 Evict 卸载（路由可用性独立于主模型）。
            true
        }
        PoolRequest::Submit(params) => {
            LLM_LAST_USED_MS.store(now_ms(), Ordering::Relaxed);
            if engine.is_none() {
                let _ = params.tx.send(InferenceEvent::Error(
                    "LLM engine not initialized".to_string(),
                ));
            } else {
                pending.push(params);
            }
            true
        }
        PoolRequest::ClearSession(session_id) => {
            if let Some(engine) = engine.as_mut() {
                engine.session_states.remove(&session_id);
                log::info!("[rwkv] Cleared session cache for session_id={}", session_id);
            }
            true
        }
        PoolRequest::Classify {
            request,
            prev_tier,
            capture,
            reply,
        } => {
            // 分类优先级链：常驻 router_mini → 主模型兼容回退（头与主模型
            // 维度匹配时）→ Err（上游降级回落远程）。
            if let Some(mini) = router_mini.as_mut() {
                let result = classify_with_mini(mini, router_head.as_ref(), &request, prev_tier);
                if capture {
                    if let Ok((ref probs, ref hidden)) = result {
                        crate::router_evolution::capture_route_sample(
                            &request,
                            hidden,
                            prev_tier,
                            probs,
                            mini.num_embd,
                        );
                    }
                }
                let _ = reply.send(result.map(|(probs, _)| probs));
                return true;
            }
            if let Some(engine) = engine.as_mut() {
                // 仅主模型回退路径计入主模型 keep_alive（router_mini 分类不续命大模型）。
                LLM_LAST_USED_MS.store(now_ms(), Ordering::Relaxed);
                let result =
                    classify_with_engine(engine, router_head.as_ref(), &request, prev_tier);
                if capture {
                    if let Ok((ref probs, ref hidden)) = result {
                        crate::router_evolution::capture_route_sample(
                            &request,
                            hidden,
                            prev_tier,
                            probs,
                            engine.model.info().num_emb,
                        );
                    }
                }
                let _ = reply.send(result.map(|(probs, _)| probs));
                return true;
            }
            let _ = reply.send(Err(
                "router mini model not loaded and LLM engine not initialized".to_string(),
            ));
            true
        }
        PoolRequest::RouterDim { reply } => {
            let dim = router_mini
                .as_ref()
                .map(|m| m.num_embd)
                .or_else(|| engine.as_ref().map(|e| e.model.info().num_emb));
            let _ = reply.send(dim);
            true
        }
        PoolRequest::ReloadRouterHead { reply } => {
            // 校验对象随可用分类模型走：优先 router_mini，其次主模型。
            let target_emb = router_mini
                .as_ref()
                .map(|m| m.num_embd)
                .or_else(|| engine.as_ref().map(|e| e.model.info().num_emb));
            let result = match target_emb {
                Some(num_emb) => {
                    *router_head = load_router_head(num_emb);
                    if router_head.is_some() {
                        Ok(())
                    } else {
                        Err(get_router_head_status()
                            .detail
                            .unwrap_or_else(|| "router head reload failed".to_string()))
                    }
                }
                None => {
                    Err("router mini model not loaded and LLM engine not initialized".to_string())
                }
            };
            let _ = reply.send(result);
            true
        }
        PoolRequest::InitRouter {
            model_path,
            vocab_path,
            reply,
        } => {
            // 路径感知 gate：同路径已加载直接成功（幂等，懒加载防重复）。
            if let Some(mini) = router_mini.as_ref() {
                if mini.model_path == model_path {
                    let _ = reply.send(Ok(()));
                    return true;
                }
            }
            // VRAM 预算检查（0.1B int8 ~0.2GB，预算不足时仅告警照常加载）。
            let estimate = estimate_rwkv_vram_bytes(&model_path).unwrap_or(0);
            if let Err(e) = crate::vram_manager::ensure_capacity(estimate, None) {
                log::warn!("[rwkv] router mini budget check failed, loading anyway: {e}");
            }
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                load_router_mini(&model_path, &vocab_path)
            }));
            match result {
                Ok(Ok(mini)) => {
                    // 分类头与路由小模型绑定加载（校验对象 = mini n_embd）。
                    *router_head = load_router_head(mini.num_embd);
                    let head_ok = router_head.is_some();
                    log::info!(
                        "[rwkv] router mini loaded: n_embd={} (head {})",
                        mini.num_embd,
                        if head_ok {
                            "loaded"
                        } else {
                            "missing/mismatch"
                        }
                    );
                    *router_mini = Some(mini);
                    ROUTER_MINI_READY.store(true, Ordering::SeqCst);
                    if !head_ok {
                        // 模型已就绪但头缺失：分类头状态已由 load_router_head 记录，
                        // 这里补写 detail 说明分类仍不可用。
                        set_router_head_status(RouterHeadStatus {
                            loaded: false,
                            input_dim: None,
                            detail: Some(
                                "router model loaded but router_head.json missing/mismatch"
                                    .to_string(),
                            ),
                        });
                    }
                    let _ = reply.send(Ok(()));
                }
                Ok(Err(e)) => {
                    log::warn!("[rwkv] router mini load failed: {e}");
                    set_router_head_status(RouterHeadStatus {
                        loaded: false,
                        input_dim: None,
                        detail: Some(format!("router model load failed: {e}")),
                    });
                    let _ = reply.send(Err(e));
                }
                Err(panic) => {
                    let msg = format!("router mini init panicked: {panic:?}");
                    log::error!("[rwkv] {}", msg);
                    set_router_head_status(RouterHeadStatus {
                        loaded: false,
                        input_dim: None,
                        detail: Some(msg.clone()),
                    });
                    let _ = reply.send(Err(msg));
                }
            }
            true
        }
    }
}

/// 分类请求截断上限（token）：双段预算 = 会话摘要（~128）+ 当前请求（~128）。
/// 256 与 seq 路径 GEMM 的 m_pad 对齐档一致，延迟与旧 128 档基本持平。
const CLASSIFY_MAX_TOKENS: usize = 256;

/// 分类特征提取（共享）：tokenize 输入（摘要+请求，截断 256）→ 零状态恢复 →
/// mean-hidden（state embedding）。在 pool 线程内同步执行（prefill 短）。
fn classify_extract_hidden(
    model: &mut GpuModel,
    tokenizer: &Tokenizer,
    classify_state: &mut State,
    initial_state: &[f32],
    request: &str,
) -> Result<Vec<f32>, String> {
    let mut tokens = tokenizer
        .encode(request.as_bytes())
        .map_err(|e| format!("failed to encode classify request: {}", e))?;
    if tokens.is_empty() {
        // 空文本无法 prefill（闲聊类应由 core 的 trivial-ack 规则先行拦截）。
        return Err("classify request encoded to zero tokens".to_string());
    }
    tokens.truncate(CLASSIFY_MAX_TOKENS);

    model
        .state_load(classify_state, initial_state)
        .map_err(|e| format!("failed to reset classify state: {}", e))?;
    model
        .forward_seq_mean_hidden(classify_state, &tokens)
        .map_err(|e| format!("classify prefill failed: {}", e))
}

/// 分类头可用性校验：头已加载且 expected_hidden_dim 与所选模型 n_embd 匹配。
/// v4 head 的 expected_hidden_dim = base_dim（input_dim 含 5 维 one-hot）。
fn check_router_head(
    head: Option<&ai00_x_core::routing::head::RouterHead>,
    num_embd: usize,
) -> Result<&ai00_x_core::routing::head::RouterHead, String> {
    let head =
        head.ok_or_else(|| "router head not loaded (router_head.json missing)".to_string())?;
    if head.expected_hidden_dim() != num_embd {
        return Err(format!(
            "router head expects hidden {} != model n_embd {} (head/model mismatch)",
            head.expected_hidden_dim(),
            num_embd
        ));
    }
    Ok(head)
}

/// 常驻路由小模型分类路径（主模型无关）。返回 `(probs, hidden)`，
/// hidden 供进化数据回流捕获。
fn classify_with_mini(
    mini: &mut RouterMini,
    head: Option<&ai00_x_core::routing::head::RouterHead>,
    request: &str,
    prev_tier: Option<u8>,
) -> Result<(Vec<f32>, Vec<f32>), String> {
    let head = check_router_head(head, mini.num_embd)?;
    let hidden = classify_extract_hidden(
        &mut mini.model,
        &mini.tokenizer,
        &mut mini.classify_state,
        &mini.initial_state,
        request,
    )?;
    let probs = head.forward(&hidden, prev_tier)?;
    Ok((probs.to_vec(), hidden))
}

/// 主模型兼容回退分类路径（router_mini 未加载且主模型头维度匹配时）。
fn classify_with_engine(
    engine: &mut PoolEngine,
    head: Option<&ai00_x_core::routing::head::RouterHead>,
    request: &str,
    prev_tier: Option<u8>,
) -> Result<(Vec<f32>, Vec<f32>), String> {
    let head = check_router_head(head, engine.model.info().num_emb)?;
    let hidden = classify_extract_hidden(
        &mut engine.model,
        &engine.tokenizer,
        &mut engine.classify_state,
        &engine.initial_state,
        request,
    )?;
    let probs = head.forward(&hidden, prev_tier)?;
    Ok((probs.to_vec(), hidden))
}

/// 按模型规模动态核减生成槽位数：RWKV state 显存随模型规模线性放大，
/// 大模型少开槽位避免 OOM。int8 下参数量≈文件字节数：
/// ≤6GB（3B 级）→ 16 槽；≤11GB（7B 级）→ 8 槽；更大（13B 级）→ 4 槽。
fn slot_count_for_model(model_path: &Path) -> usize {
    let size_gb = std::fs::metadata(model_path).map(|m| m.len()).unwrap_or(0) as f64
        / (1024.0 * 1024.0 * 1024.0);
    if size_gb <= 0.0 || size_gb < 6.0 {
        MAX_SLOTS
    } else if size_gb < 11.0 {
        8
    } else {
        4
    }
}

/// 加载模型并创建批量解码状态 + 单序列 prefill 状态。
fn load_engine(model_path: &str, vocab_path: &str) -> Result<PoolEngine, String> {
    log::info!("[rwkv] loading model: {}", model_path);
    let bundle: Bundle = ModelBuilder::new(model_path)
        .build()
        .map_err(|e| format!("failed to load model '{}': {}", model_path, e))?;
    let Bundle { mut model, state } = bundle;

    let slot_count = slot_count_for_model(Path::new(model_path));
    let decode_state = model
        .create_batch_state(slot_count)
        .map_err(|e| format!("failed to create batch decode state: {}", e))?;
    let prefill_state = model
        .create_state()
        .map_err(|e| format!("failed to create prefill state: {}", e))?;
    let hist_buf = model
        .alloc_u32(HIST_STRIDE * slot_count)
        .map_err(|e| format!("failed to alloc hist buf: {}", e))?;
    model
        .write_u32(hist_buf, &vec![0u32; HIST_STRIDE * slot_count])
        .map_err(|e| format!("failed to zero hist buf: {}", e))?;
    let use_batch_decode = model.supports_batch_decode();
    // 兜底路径（fp16 模型无 batch 层 kernel）才需要每槽单序列状态。
    let mut slot_states = Vec::new();
    if !use_batch_decode {
        for i in 0..slot_count {
            slot_states.push(
                model
                    .create_state()
                    .map_err(|e| format!("failed to create slot state {i}: {}", e))?,
            );
        }
    }

    let vocab = std::fs::read_to_string(vocab_path)
        .map_err(|e| format!("failed to read vocab '{}': {}", vocab_path, e))?;
    let tokenizer = Tokenizer::new(&vocab).map_err(|e| format!("failed to parse vocab: {}", e))?;

    let initial_state = model
        .state_back(&state)
        .map_err(|e| format!("failed to snapshot initial state: {}", e))?;
    // 将单序列零态灌入 batch 状态作起点（解码组每行起步状态）。
    model
        .reset_state_of(&decode_state)
        .map_err(|e| format!("failed to reset batch state: {}", e))?;

    let classify_state = model
        .create_state()
        .map_err(|e| format!("failed to create classify state: {}", e))?;

    let info = model.info();
    log::info!(
        "[rwkv] model loaded: layers={} emb={} vocab={} slots={} batch_decode={}",
        info.num_layer,
        info.num_emb,
        info.num_vocab,
        slot_count,
        use_batch_decode
    );

    Ok(PoolEngine {
        model,
        decode_state,
        hist_buf,
        prefill_state,
        use_batch_decode,
        slot_states,
        slot_count,
        tokenizer,
        initial_state,
        session_states: HashMap::new(),
        classify_state,
    })
}

/// 加载常驻路由小模型（0.1B int8）：仅创建分类状态，无生成槽位。
fn load_router_mini(model_path: &str, vocab_path: &str) -> Result<RouterMini, String> {
    log::info!("[rwkv] loading router mini model: {}", model_path);
    let bundle: Bundle = ModelBuilder::new(model_path)
        .build()
        .map_err(|e| format!("failed to load router mini '{}': {}", model_path, e))?;
    let Bundle { mut model, state } = bundle;

    let initial_state = model
        .state_back(&state)
        .map_err(|e| format!("failed to snapshot router mini initial state: {}", e))?;
    let classify_state = model
        .create_state()
        .map_err(|e| format!("failed to create router mini classify state: {}", e))?;

    let vocab = std::fs::read_to_string(vocab_path)
        .map_err(|e| format!("failed to read vocab '{}': {}", vocab_path, e))?;
    let tokenizer = Tokenizer::new(&vocab).map_err(|e| format!("failed to parse vocab: {}", e))?;

    let num_embd = model.info().num_emb;
    Ok(RouterMini {
        model,
        initial_state,
        classify_state,
        tokenizer,
        num_embd,
        model_path: model_path.to_string(),
    })
}

/// 组装任务：prompt 清洗/编码、会话状态恢复（含前缀去重）、惩罚历史初始化。
/// 状态本身不在此灌入（prefill 串行，起步态在 `prefill_step` 首块时装入）。
fn prepare_task(
    params: InferenceTaskParams,
    engine: &mut PoolEngine,
    seed: u32,
) -> Result<InferenceTask, String> {
    let prompt = if params.is_vrm {
        // VRM mode: only standardize line breaks, do NOT trim trailing newlines.
        // Trimming breaks prompt format alignment with training data.
        params.prompt.replace("\r\n", "\n").replace('\r', "\n")
    } else if params.prompt.contains("User:")
        || params.prompt.contains("Assistant:")
        || params.prompt.contains("System:")
        || params.prompt.contains("# User")
        || params.prompt.contains("# Assistant")
        || params.prompt.contains("# System")
    {
        sanitize_rwkv_prompt_preserve_roles(&params.prompt)
    } else {
        let content = sanitize_rwkv_content(&params.prompt);
        format!("User: {}\n\nAssistant: ", content)
    };

    let prompt_tokens = engine
        .tokenizer
        .encode(prompt.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut input_tokens = prompt_tokens.clone();
    let mut base_tokens: Vec<u32> = Vec::new();
    let mut resume_state: Option<Vec<f32>> = None;

    if let Some(sid) = &params.session_id {
        let cached = engine.session_states.get(sid).cloned();
        if let Some((cached_tokens, cached_state)) = cached {
            let mut skip = 0;
            let boundary_texts = ["\n\n# User", "# User", "\n\n### Tool Risk", "### Tool Risk"];
            for text in boundary_texts {
                if let Ok(boundary_ids) = engine.tokenizer.encode(text.as_bytes()) {
                    if !boundary_ids.is_empty()
                        && prompt_tokens.starts_with(&boundary_ids)
                        && cached_tokens.ends_with(&boundary_ids)
                    {
                        skip = skip.max(boundary_ids.len());
                    }
                }
            }

            let mut dedup_backtrack = 0usize;
            if skip == 0 && !prompt_tokens.is_empty() && !cached_tokens.is_empty() {
                let last_id = cached_tokens.last().unwrap_or(&0);
                let is_last_newline = engine
                    .tokenizer
                    .decode(&[*last_id])
                    .ok()
                    .map(|s| String::from_utf8_lossy(&s) == "\n")
                    .unwrap_or(false);

                if is_last_newline {
                    if let Ok(double_newline_ids) = engine.tokenizer.encode(b"\n\n") {
                        if prompt_tokens.starts_with(&double_newline_ids) {
                            dedup_backtrack = 1;
                        }
                    }
                }
            }

            if skip > 0 {
                input_tokens = prompt_tokens[skip..].to_vec();
            }

            // 缓存命中的前缀（去掉回溯位）= 状态已消费的 token 前缀。
            let keep = cached_tokens.len().saturating_sub(dedup_backtrack);
            base_tokens = cached_tokens[..keep].to_vec();
            resume_state = Some(cached_state);
        }
    }

    if input_tokens.is_empty() {
        input_tokens = vec![0u32];
    }

    // 惩罚历史：model_text 编码（对齐 ai00-server NucleusSampler 的预热语义；
    // 不含 prompt 本身），生成 token 随后逐个追加。
    let mut hist: Vec<u32> = if params.model_text.is_empty() {
        Vec::new()
    } else {
        engine
            .tokenizer
            .encode(params.model_text.as_bytes())
            .unwrap_or_default()
    };
    if hist.len() > HIST_STRIDE {
        let drop = hist.len() - HIST_STRIDE;
        hist.drain(..drop);
    }

    Ok(InferenceTask {
        prompt_tokens,
        input_tokens,
        base_tokens,
        prefill_cursor: 0,
        prefill_logits: None,
        resume_state,
        session_id: params.session_id,
        max_tokens: if params.max_tokens == 0 {
            1
        } else {
            params.max_tokens
        },
        top_p: params.top_p.clamp(0.0, 1.0),
        top_k: if params.top_k == 0 { 128 } else { params.top_k },
        presence_penalty: params.presence_penalty,
        frequency_penalty: params.frequency_penalty,
        penalty_decay: if params.penalty_decay == 0.0 {
            0.99654026
        } else {
            params.penalty_decay
        },
        stop: params.stop,
        is_streaming: params.is_streaming,
        tx: params.tx,
        acc_ids: Vec::new(),
        hist,
        feed_token: 0,
        seed,
        stop_buffer: String::new(),
        last_decoded_len: 0,
        steps_done: 0,
        ended_by_stop: false,
        hit_stop: None,
        finish_pending: false,
    })
}

/// prefill 推进一步（一块）。返回 true 表示 prefill 已完成（末块 logits 存入任务）。
/// 首块前把起步状态（会话缓存态 / 零初始态）装入 `prefill_state`。
fn prefill_step(task: &mut InferenceTask, engine: &mut PoolEngine) -> Result<bool, String> {
    if task.prefill_cursor == 0 {
        let start = task
            .resume_state
            .take()
            .unwrap_or_else(|| engine.initial_state.clone());
        engine
            .model
            .state_load(&engine.prefill_state, &start)
            .map_err(|e| format!("failed to load prefill state: {}", e))?;
    }
    let end = (task.prefill_cursor + PREFILL_CHUNK).min(task.input_tokens.len());
    let chunk = task.input_tokens[task.prefill_cursor..end].to_vec();
    let logits = engine
        .model
        .forward_seq_with_state(&mut engine.prefill_state, &chunk)
        .map_err(|e| format!("prefill failed: {}", e))?;
    task.prefill_cursor = end;
    if end < task.input_tokens.len() {
        return Ok(false);
    }
    task.prefill_logits = Some(logits);
    // prefill 完成即缓存会话状态（任务中途异常也能保留已 prefill 的前缀）。
    if let Some(sid) = task.session_id.clone() {
        if let Ok(st) = engine.model.state_back(&engine.prefill_state) {
            let mut tokens = task.base_tokens.clone();
            tokens.extend_from_slice(&task.input_tokens);
            engine.session_states.insert(sid, (tokens, st));
        }
    }
    Ok(true)
}

/// prefill 完成 → 主机采样首 token 并转入解码组（状态从 `prefill_state` 迁到
/// `row` 行）。返回 false 表示首 token 即命中结束条件（任务已收尾，不再入组）。
fn join_decode_group(
    task: &mut InferenceTask,
    engine: &mut PoolEngine,
    row: usize,
) -> Result<bool, String> {
    let logits = task
        .prefill_logits
        .take()
        .ok_or_else(|| "prefill 未产出 logits".to_string())?;
    let id = sample_token(
        &logits,
        task.top_p,
        task.top_k,
        &task.hist,
        task.presence_penalty,
        task.frequency_penalty,
        task.penalty_decay,
        task.seed,
    );
    task.acc_ids.push(id);
    task.steps_done = 1;
    task.feed_token = id;
    task.seed = task.seed.wrapping_add(1);
    task.hist.push(id);
    post_sample(engine, task);

    if task.finish_pending {
        // 首 token 即结束：状态尚在 prefill_state，补喂末 token 后直接收尾
        engine
            .model
            .forward_with_state(&mut engine.prefill_state, &[id])
            .map_err(|e| format!("final sync forward failed: {}", e))?;
        finalize_task(task, engine, None);
        return Ok(false);
    }

    // 转入解码组：状态迁入 row 行（兜底路径直接换 State，批量路径走行灌入）
    if engine.use_batch_decode {
        let st = engine
            .model
            .state_back(&engine.prefill_state)
            .map_err(|e| format!("state_back failed: {}", e))?;
        engine
            .model
            .state_slot_load(&engine.decode_state, row, &st)
            .map_err(|e| format!("state_slot_load failed: {}", e))?;
    } else {
        std::mem::swap(&mut engine.prefill_state, &mut engine.slot_states[row]);
    }
    upload_hist_row(engine, row, task)?;
    Ok(true)
}

/// 解码组推进一步：一次批量前向 + GPU 采样（权重读一份算 n_active 份），
/// 然后逐任务后处理。`tasks` 为活跃任务的密集前缀（索引 = batch 行）。
fn decode_step(tasks: &mut [Option<InferenceTask>], engine: &mut PoolEngine) -> Result<(), String> {
    let n = tasks.len();
    if n == 0 {
        return Ok(());
    }
    let sampled: Vec<u32> = if engine.use_batch_decode {
        let mut toks: Vec<Vec<u32>> = Vec::with_capacity(n);
        let mut hist_len: Vec<u32> = Vec::with_capacity(n);
        let mut sp: Vec<SamplerParams> = Vec::with_capacity(n);
        for slot in tasks.iter() {
            let t = slot.as_ref().ok_or("decode_step: 活跃前缀存在空洞")?;
            toks.push(vec![t.feed_token]);
            hist_len.push(t.hist.len() as u32);
            sp.push(SamplerParams {
                temperature: 1.0,
                top_k: t.top_k as u32,
                top_p: t.top_p,
                seed: t.seed,
                repetition_penalty: 1.0,
                frequency_penalty: t.frequency_penalty,
                presence_penalty: t.presence_penalty,
                penalty_decay: t.penalty_decay,
            });
        }
        engine
            .model
            .batch_step_sample(
                &mut engine.decode_state,
                &toks,
                engine.hist_buf,
                HIST_STRIDE,
                &hist_len,
                &sp,
            )
            .map_err(|e| format!("batch decode failed: {}", e))?
    } else {
        let mut out = Vec::with_capacity(n);
        for (row, slot) in tasks.iter_mut().enumerate() {
            let t = slot.as_mut().ok_or("decode_step: 活跃前缀存在空洞")?;
            let logits = engine
                .model
                .forward_with_state(&mut engine.slot_states[row], &[t.feed_token])
                .map_err(|e| format!("decode failed: {}", e))?;
            out.push(sample_token(
                &logits,
                t.top_p,
                t.top_k,
                &t.hist,
                t.presence_penalty,
                t.frequency_penalty,
                t.penalty_decay,
                t.seed,
            ));
        }
        out
    };

    for (row, id) in sampled.into_iter().enumerate() {
        let Some(t) = tasks[row].as_mut() else {
            continue;
        };
        if t.finish_pending {
            // 补喂末 token（本轮只推进状态，采样结果丢弃）——下一轮回写缓存 + Done
            continue;
        }
        t.acc_ids.push(id);
        t.steps_done += 1;
        t.feed_token = id;
        t.seed = t.seed.wrapping_add(1);
        append_hist(engine, row, t, id)?;
        post_sample(engine, t);
    }
    Ok(())
}

/// 采样后处理：stop 串判定 + 流式增量发射 + 结束判定。
fn post_sample(engine: &PoolEngine, task: &mut InferenceTask) {
    let last_id = task.acc_ids.last().copied().unwrap_or(0);
    let decoded = engine.tokenizer.decode(&[last_id]).unwrap_or_default();
    let token_str = String::from_utf8_lossy(&decoded).to_string();

    task.stop_buffer.push_str(&token_str);
    if task.stop_buffer.len() > 200 {
        let split_idx = task.stop_buffer.len() - 100;
        if let Some((idx, _)) = task
            .stop_buffer
            .char_indices()
            .find(|(i, _)| *i >= split_idx)
        {
            task.stop_buffer = task.stop_buffer[idx..].to_string();
        }
    }

    if let Some(ref ss) = task.stop {
        for stop_str in ss {
            if !stop_str.is_empty() && task.stop_buffer.ends_with(stop_str) {
                task.ended_by_stop = true;
                task.hit_stop = Some(stop_str.clone());
                break;
            }
        }
    }

    if task.is_streaming {
        if let Ok(decoded) = engine.tokenizer.decode(&task.acc_ids) {
            // 增量发射：以原始字节为基准切新增段；末尾不完整的 UTF-8 序列
            // 留到下轮补全。不能对 lossy 串按字节切片——增量解码在多字节
            // 字符（如 📋）中途时替换符会使索引漂移，直接切会 panic
            //（真实案例：990 行 start byte index not a char boundary 杀进程）。
            if decoded.len() >= task.last_decoded_len {
                let fresh = &decoded[task.last_decoded_len..];
                // 末尾可能是被截断的多字节序列：trim 到 UTF-8 安全边界
                let valid = match std::str::from_utf8(fresh) {
                    Ok(_) => fresh.len(),
                    Err(e) => e.valid_up_to(),
                };
                if valid > 0 {
                    let chunk = String::from_utf8_lossy(&fresh[..valid]);
                    if !chunk.is_empty() {
                        let _ = task.tx.send(InferenceEvent::Token(chunk.to_string()));
                    }
                }
                task.last_decoded_len += valid;
            } else {
                // 解码字节数回退（异常情形）：重置基线防 panic，宁丢增量
                task.last_decoded_len = decoded.len();
            }
        }
    }

    if task.ended_by_stop || task.steps_done >= task.max_tokens {
        task.finish_pending = true;
    }
}

/// 任务收尾：回写会话缓存（状态已含全部已发射 token）+ 发送 Done。
/// `row` = 解码组行号；None 表示任务尚未入组（状态仍在 `prefill_state`）。
fn finalize_task(task: &mut InferenceTask, engine: &mut PoolEngine, row: Option<usize>) {
    if let Some(sid) = task.session_id.clone() {
        let st = match row {
            Some(row) if engine.use_batch_decode => {
                engine.model.state_slot_back(&engine.decode_state, row)
            }
            Some(row) => engine.model.state_back(&engine.slot_states[row]),
            None => engine.model.state_back(&engine.prefill_state),
        };
        if let Ok(st) = st {
            // 状态已消费 base ++ input_tokens ++ acc_ids（末 token 已补喂）。
            let mut tokens = task.base_tokens.clone();
            tokens.extend_from_slice(&task.input_tokens);
            tokens.extend_from_slice(&task.acc_ids);
            engine.session_states.insert(sid, (tokens, st));
        }
    }

    let mut text = engine
        .tokenizer
        .decode(&task.acc_ids)
        .map(|d| String::from_utf8_lossy(&d).to_string())
        .unwrap_or_default();
    if let Some(ref seq) = task.hit_stop {
        if let Some(pos) = text.rfind(seq.as_str()) {
            text.truncate(pos);
        }
    }
    let _ = task.tx.send(InferenceEvent::Done {
        text,
        input_tokens: task.prompt_tokens.len(),
        output_tokens: task.acc_ids.len(),
        stop_sequence: task.hit_stop.clone(),
    });
}

/// 把任务的惩罚历史整行同步到设备 `row` 行（入组 / 槽位迁移时用）。
fn upload_hist_row(engine: &PoolEngine, row: usize, task: &InferenceTask) -> Result<(), String> {
    if task.hist.is_empty() {
        return Ok(());
    }
    engine
        .model
        .write_u32_part(engine.hist_buf, row * HIST_STRIDE, &task.hist)
        .map_err(|e| format!("hist row upload failed: {}", e))
}

/// 追加一个 token 到惩罚历史并同步到设备（O(1) 增量；满则滑窗重传整行）。
fn append_hist(
    engine: &PoolEngine,
    row: usize,
    task: &mut InferenceTask,
    tok: u32,
) -> Result<(), String> {
    if task.hist.len() >= HIST_STRIDE {
        // 滑动窗口：丢弃最旧 1/4（每 HIST_STRIDE/4 个 token 才发生一次）
        let drop = HIST_STRIDE / 4;
        task.hist.drain(..drop);
        task.hist.push(tok);
        return upload_hist_row(engine, row, task);
    }
    task.hist.push(tok);
    engine
        .model
        .write_u32_part(
            engine.hist_buf,
            row * HIST_STRIDE + task.hist.len() - 1,
            &[tok],
        )
        .map_err(|e| format!("hist append failed: {}", e))
}

/// 紧凑化解码组前缀：回收空洞后的任务前移，并迁移其状态行与惩罚历史行。
fn compact_tasks(tasks: &mut [Option<InferenceTask>], engine: &mut PoolEngine) {
    let mut to = 0usize;
    for from in 0..tasks.len() {
        if tasks[from].is_none() {
            continue;
        }
        if to != from {
            let t = tasks[from].take().expect("checked some");
            migrate_slot(engine, from, to);
            if let Err(e) = upload_hist_row(engine, to, &t) {
                log::error!("[rwkv] hist migrate {from}->{to} failed: {e}");
            }
            tasks[to] = Some(t);
        }
        to += 1;
    }
}

/// 迁移 batch 状态行 from → to（仅任务结束回收时发生，非每步开销）。
/// 走设备内单行拷贝：主机中转版在 batch=16 时每次要传 ~260MB（实测 ~80ms/次）。
fn migrate_slot(engine: &mut PoolEngine, from: usize, to: usize) {
    if from == to {
        return;
    }
    if !engine.use_batch_decode {
        // 兜底路径的 State 由 Vec 直接持有，交换即完成迁移
        engine.slot_states.swap(from, to);
        return;
    }
    if let Err(e) = engine.model.state_slot_move(&engine.decode_state, from, to) {
        log::error!("[rwkv] slot state migrate {from}->{to} failed: {e}");
    }
}

fn sample_token(
    logits: &[f32],
    top_p: f32,
    top_k: usize,
    hist: &[u32],
    presence_penalty: f32,
    frequency_penalty: f32,
    penalty_decay: f32,
    seed: u32,
) -> u32 {
    let mut logits = logits.to_vec();
    if !hist.is_empty() && (presence_penalty != 0.0 || frequency_penalty != 0.0) {
        let mut counts: HashMap<u32, u32> = HashMap::new();
        for &id in hist {
            if (id as usize) < logits.len() {
                *counts.entry(id).or_insert(0) += 1;
            }
        }
        for (id, count) in counts {
            let penalty = presence_penalty + frequency_penalty * (count as f32).powf(penalty_decay);
            logits[id as usize] -= penalty;
        }
    }
    let probs = softmax(&logits);
    let mut cumsum = 0.0;
    let mut candidates: Vec<(usize, f32)> =
        probs.iter().enumerate().map(|(i, &p)| (i, p)).collect();
    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut top_k_candidates: Vec<(usize, f32)> = Vec::new();
    for (i, p) in candidates.into_iter().take(top_k) {
        cumsum += p;
        top_k_candidates.push((i, p));
        if cumsum >= top_p {
            break;
        }
    }
    let r = u01(seed) * cumsum.min(1.0);
    let mut cumsum = 0.0;
    let mut selected_id = top_k_candidates[0].0 as u32;
    for (i, p) in top_k_candidates {
        cumsum += p;
        if cumsum >= r {
            selected_id = i as u32;
            break;
        }
    }
    selected_id
}

/// 与 CUDA 采样器 `u01_batch` 同构的确定性随机数（主机侧首 token 采样用）。
fn u01(seed: u32) -> f32 {
    let mut z = seed.wrapping_add(0x9E37_79B9);
    z = (z ^ (z >> 16)).wrapping_mul(0x85EB_CA6B);
    z = (z ^ (z >> 13)).wrapping_mul(0xC2B2_AE35);
    z ^= z >> 16;
    z as f32 / 4294967296.0
}

#[allow(clippy::too_many_arguments)]
pub async fn pool_infer(
    prompt: String,
    max_tokens: usize,
    top_p: f32,
    top_k: usize,
    presence_penalty: f32,
    frequency_penalty: f32,
    penalty_decay: f32,
    stop: Option<Vec<String>>,
    session_id: Option<String>,
    is_streaming: bool,
    is_vrm: bool,
    model_text: String,
) -> Result<mpsc::UnboundedReceiver<InferenceEvent>, String> {
    // Lazy-init：启动不再预加载主 LLM，首个使用方（网关 / 对话 / 划词翻译 /
    // 网页摘要）在此触发加载。app 传 None：池内加载完成即置 LLM_READY，无需事件。
    if !LLM_READY.load(Ordering::SeqCst) {
        if let Err(e) = init_engine_internal(None, None, None).await {
            // 并发首用时另一调用方已在初始化：等待其完成（与 init 超时同上限 300s）。
            if !e.contains("initialization in progress") {
                return Err(format!("LLM auto-init failed: {}", e));
            }
            let mut ready = false;
            for _ in 0..600 {
                if LLM_READY.load(Ordering::SeqCst) {
                    ready = true;
                    break;
                }
                // 对方的初始化已结束（标志复位）且仍未就绪 = 加载失败，
                // 立即报错而非傻等满 300s。成功路径 LLM_READY 先于标志复位置位。
                let still_initing = LLM_INITING
                    .get()
                    .and_then(|f| f.lock().ok())
                    .map(|f| *f)
                    .unwrap_or(false);
                if !still_initing {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            if !ready {
                return Err(format!("LLM auto-init failed: {}", e));
            }
        }
    }
    let pool = get_inference_pool().ok_or("inference pool not started")?;
    let (tx, rx) = mpsc::unbounded_channel::<InferenceEvent>();
    let params = InferenceTaskParams {
        prompt,
        max_tokens,
        top_p,
        top_k,
        presence_penalty,
        frequency_penalty,
        penalty_decay,
        stop,
        session_id,
        is_streaming,
        is_vrm,
        model_text,
        tx,
    };
    pool.tx
        .send(PoolRequest::Submit(params))
        .map_err(|e| e.to_string())?;
    Ok(rx)
}

/// 单次分类请求（智能路由用）：mean-hidden 提取 + MLP 头 → 4 类概率（R0-R3）。
/// `capture`：true = 真实路由（进化数据回流）；false = 设置页预览（不采集）。
pub async fn rwkv_classify(
    request: String,
    prev_tier: Option<u8>,
    capture: bool,
) -> Result<Vec<f32>, String> {
    // 路由分类与主模型解耦：router_mini 未就绪但模型文件已下载时先懒加载
    // （幂等；下载完成后的首次分类自动恢复，无需重启）。文件缺失时直接
    // 走 pool 内兼容回退链（主模型匹配头 / Err 降级回落远程）。
    if !ROUTER_MINI_READY.load(Ordering::SeqCst) && router_model_path().exists() {
        if let Err(e) = init_router_internal().await {
            log::warn!("[rwkv] router mini lazy-init failed, classify falls back: {e}");
        }
    }
    let pool = get_inference_pool().ok_or("inference pool not started")?;
    let (reply_tx, reply_rx) = oneshot::channel::<Result<Vec<f32>, String>>();
    pool.tx
        .send(PoolRequest::Classify {
            request,
            prev_tier,
            capture,
            reply: reply_tx,
        })
        .map_err(|e| format!("failed to send classify request: {}", e))?;
    match tokio::time::timeout(Duration::from_secs(30), reply_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("classify reply channel closed".to_string()),
        Err(_) => Err("classify request timed out after 30s".to_string()),
    }
}

/// 查询当前分类骨干 hidden 维度（router_mini 优先，主模型回退；未就绪 = None）。
/// 仅在阻塞线程上下文调用（blocking_recv）。
pub fn router_head_target() -> Result<(std::path::PathBuf, usize), String> {
    let pool = get_inference_pool().ok_or("inference pool not started")?;
    let (reply_tx, reply_rx) = oneshot::channel::<Option<usize>>();
    pool.tx
        .send(PoolRequest::RouterDim { reply: reply_tx })
        .map_err(|e| format!("failed to send router-dim request: {e}"))?;
    let dim = reply_rx
        .blocking_recv()
        .ok()
        .flatten()
        .ok_or("no classification backbone loaded (router mini / LLM engine)")?;
    Ok((assets_models_dir().join("router_head.json"), dim))
}

/// 同步热重载路由头（进化流程写入新 router_head.json 后复用）。
/// 仅在阻塞线程上下文调用（blocking_recv）。
pub fn reload_head_blocking() -> Result<(), String> {
    let pool = get_inference_pool().ok_or("inference pool not started")?;
    let (reply_tx, reply_rx) = oneshot::channel::<Result<(), String>>();
    pool.tx
        .send(PoolRequest::ReloadRouterHead { reply: reply_tx })
        .map_err(|e| format!("failed to send reload request: {e}"))?;
    reply_rx
        .blocking_recv()
        .unwrap_or_else(|_| Err("reload reply channel closed".to_string()))
}

/// 加载/替换常驻路由小模型（0.1B）。幂等：同路径已加载直接成功。
async fn init_router_internal() -> Result<(), String> {
    let mp = router_model_path();
    if !mp.exists() {
        return Err("router model not downloaded (router-0.1B-int8.st missing)".to_string());
    }
    let (default_vocab, _) = resolve_default_paths();
    let pool = ensure_inference_pool();
    register_with_vram_manager();
    let (reply_tx, reply_rx) = oneshot::channel::<Result<(), String>>();
    pool.tx
        .send(PoolRequest::InitRouter {
            model_path: mp.to_string_lossy().into_owned(),
            vocab_path: default_vocab,
            reply: reply_tx,
        })
        .map_err(|e| format!("failed to send init-router request: {}", e))?;
    // 0.1B 加载很快（秒级），超时放宽到 60s 覆盖首载 GPU 初始化。
    match tokio::time::timeout(Duration::from_secs(60), reply_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("init-router reply channel closed".to_string()),
        Err(_) => Err("router mini load timed out after 60s".to_string()),
    }
}

/// 热重载智能路由分类头（router_head.json）：无需重启应用/引擎。
pub async fn rwkv_reload_router_head() -> Result<(), String> {
    // 路由头校验对象优先 router_mini，主模型仅兼容回退——两者皆未加载才拒绝。
    if !ROUTER_MINI_READY.load(Ordering::SeqCst) && !LLM_READY.load(Ordering::SeqCst) {
        return Err("no engine available (router mini and LLM engine not initialized)".to_string());
    }
    let pool = get_inference_pool().ok_or("inference pool not started")?;
    let (reply_tx, reply_rx) = oneshot::channel::<Result<(), String>>();
    pool.tx
        .send(PoolRequest::ReloadRouterHead { reply: reply_tx })
        .map_err(|e| format!("failed to send reload request: {}", e))?;
    match tokio::time::timeout(Duration::from_secs(10), reply_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("reload reply channel closed".to_string()),
        Err(_) => Err("reload request timed out after 10s".to_string()),
    }
}

pub(crate) fn cancel_epoch() -> &'static AtomicU64 {
    CANCEL_EPOCH.get_or_init(|| AtomicU64::new(0))
}

fn sanitize_rwkv_content(content: &str) -> String {
    let s = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut result = String::with_capacity(s.len());
    let mut prev_was_newline = false;
    for ch in s.chars() {
        if ch == '\n' {
            if !prev_was_newline {
                result.push('\n');
            }
            prev_was_newline = true;
        } else {
            result.push(ch);
            prev_was_newline = false;
        }
    }
    result.trim_end_matches('\n').to_string()
}

fn sanitize_rwkv_prompt_preserve_roles(content: &str) -> String {
    let s = content.replace("\r\n", "\n").replace('\r', "\n");
    let role_markers = [
        "\n\n# System",
        "\n\n# User",
        "\n\n# Assistant",
        "\n\nUser:",
        "\n\nAssistant:",
        "\n\nSystem:",
    ];
    let mut result = String::with_capacity(s.len());
    let mut i = 0;
    let chars: Vec<char> = s.chars().collect();
    while i < chars.len() {
        let remaining: String = chars[i..].iter().collect();
        let mut found_role = false;
        for marker in &role_markers {
            if remaining.starts_with(marker) {
                result.push_str(marker);
                i += marker.len();
                found_role = true;
                break;
            }
        }
        if !found_role {
            let ch = chars[i];
            if ch == '\n' {
                if !result.ends_with('\n') {
                    result.push('\n');
                }
            } else {
                result.push(ch);
            }
            i += 1;
        }
    }
    result.trim_end_matches('\n').to_string()
}

fn rwkv_debug_log_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("rwkv_chat_debug.log")
}

fn rwkv_debug_ts_ms() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn emit_to_overlay<T: Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: T) {
    debug_print!("[EMIT] Sending {} to all windows", event);
    let _ = app.emit(event, payload);
}

fn rwkv_debug_append(app: &tauri::AppHandle, session_id: Option<&str>, tag: &str, msg: &str) {
    use std::fs::OpenOptions;
    use std::io::Write;
    let path = rwkv_debug_log_path(app);
    let sid = session_id.unwrap_or("-");
    let line = format!("{}\t{}\t{}\t{}", rwkv_debug_ts_ms(), sid, tag, msg);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

fn softmax(xs: &[f32]) -> Vec<f32> {
    let mut m = f32::NEG_INFINITY;
    for &x in xs {
        if x > m {
            m = x;
        }
    }
    let mut s = 0.0;
    let mut out = Vec::with_capacity(xs.len());
    for &x in xs {
        let e = (x - m).exp();
        out.push(e);
        s += e;
    }
    if s > 0.0 {
        for v in out.iter_mut() {
            *v /= s;
        }
    }
    out
}

#[derive(Serialize)]
pub struct ChatResult {
    pub text: String,
    pub input_token_count: usize,
    pub output_token_count: usize,
}

#[derive(Debug, Serialize)]
pub struct RwkvPaths {
    pub llm_vocab_path: String,
}

fn assets_models_dir() -> PathBuf {
    crate::runtime::get_models_dir().join("rwkv")
}

fn resolve_default_paths() -> (String, String) {
    let llm_vocab_path = assets_models_dir().join("vocab.json");
    (llm_vocab_path.to_string_lossy().into_owned(), String::new())
}

#[tauri::command]
pub fn rwkv_get_default_paths() -> RwkvPaths {
    let (llm_vocab_path, _) = resolve_default_paths();
    RwkvPaths { llm_vocab_path }
}

/// 判断是否为 RWKV 模型文件（rwkv-rsv 仅支持 safetensors，.st 为惯用扩展名）。
fn is_rwkv_model_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("st") || e.eq_ignore_ascii_case("safetensors"))
        .unwrap_or(false)
}

/// 路由小模型固定名（router- 前缀）：主模型扫描/自动选择必须跳过，
/// 防止 0.1B 路由模型被误当主模型加载。
fn is_router_model_file(path: &Path) -> bool {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase().starts_with("router-"))
        .unwrap_or(false)
}

/// 解析 safetensors 文件头（前 8 字节 u64 长度 + JSON），判断是否为 int8 量化
/// （量化张量键含 ".int8_idx" 后缀，存储在 .st 文件内部）。
fn is_int8_model(model_path: &Path) -> bool {
    let Ok(mut f) = std::fs::File::open(model_path) else {
        return false;
    };
    use std::io::Read;
    let mut len_buf = [0u8; 8];
    let Ok(()) = f.read_exact(&mut len_buf) else {
        return false;
    };
    let header_len = u64::from_le_bytes(len_buf).min(1 << 20) as usize; // 头异常大则截断
    let mut header = vec![0u8; header_len];
    if f.read_exact(&mut header).is_err() {
        return false;
    }
    // 免 serde：直接在头 JSON 文本中找键后缀（键名只会出现在此处）
    let text = String::from_utf8_lossy(&header);
    text.contains(".int8_idx\"")
}

#[derive(Debug, Serialize)]
pub struct RwkvModelInfo {
    /// 模型 id：子目录名或文件名（去扩展名）。
    pub id: String,
    pub model_path: String,
    pub vocab_path: String,
    pub size_bytes: u64,
    pub int8: bool,
    /// 来源：bundled=models/rwkv 内置目录。
    pub source: String,
}

/// 枚举 models/rwkv/ 下全部可用模型：
/// - 新子目录布局：models/rwkv/{id}/ 内的 .st（vocab 优先子目录内 vocab.json）
/// - 旧平铺布局：目录内 .st/.safetensors 文件（vocab 用根目录 vocab.json）
#[tauri::command]
pub fn list_rwkv_models() -> Vec<RwkvModelInfo> {
    let mut out: Vec<RwkvModelInfo> = Vec::new();
    let models_dir = assets_models_dir();
    let root_vocab = models_dir.join("vocab.json");
    let Ok(entries) = std::fs::read_dir(&models_dir) else {
        return out;
    };
    let mut flat_files: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let dir_vocab = path.join("vocab.json");
            let vocab = if dir_vocab.exists() {
                dir_vocab
            } else {
                root_vocab.clone()
            };
            if let Ok(sub) = std::fs::read_dir(&path) {
                for e in sub.flatten() {
                    let p = e.path();
                    if p.is_file() && is_rwkv_model_file(&p) && !is_router_model_file(&p) {
                        if let Some(info) = build_model_info(&p, &vocab) {
                            out.push(info);
                        }
                    }
                }
            }
        } else if is_rwkv_model_file(&path) && !is_router_model_file(&path) {
            flat_files.push(path);
        }
    }
    for p in flat_files {
        if let Some(info) = build_model_info(&p, &root_vocab) {
            out.push(info);
        }
    }
    out.sort_by_key(|m| m.size_bytes);
    out
}

fn build_model_info(model_path: &Path, vocab_path: &Path) -> Option<RwkvModelInfo> {
    let size = std::fs::metadata(model_path).ok()?.len();
    let id = model_path.file_stem()?.to_str()?.to_string();
    Some(RwkvModelInfo {
        model_path: model_path.to_string_lossy().into_owned(),
        vocab_path: vocab_path.to_string_lossy().into_owned(),
        size_bytes: size,
        int8: is_int8_model(model_path),
        id,
        source: "bundled".to_string(),
    })
}

// ---------------------------------------------------------------------------
// 本地 RWKV 模型下载目录（统一仓库 cgisky/ai00-x：hf-mirror 优先 + HF 回退）
// ---------------------------------------------------------------------------

/// 远端 UnifiedManifest 未收录 RWKV 档位前的内置下载目录。
///
/// 就绪判定基于实际扫描（list_rwkv_models）：本地模型统一使用 int8，
/// 按文件大小区间匹配档位（int8 ≈ 每参数 1 字节；兼容 bundled bf16 大文件）。
#[derive(Debug, Clone, Serialize)]
pub struct BuiltinRwkvEntry {
    pub key: String,
    pub display: String,
    /// models/ 下相对保存路径（download_model 的 url 字段语义）。
    pub file_rel: String,
    /// 近似大小（int8 量化体积）。
    pub size_bytes: u64,
    /// 就绪 = 扫描到匹配档位的本地模型（返回可用路径）。
    pub downloaded: bool,
    /// 就绪时可直接使用的模型路径（激活时传给 init_llm_engine 热切换）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_model_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_vocab_path: Option<String>,
}

#[derive(Debug, Clone)]
struct BuiltinRwkvModel {
    key: &'static str,
    display: &'static str,
    /// models/ 下 .st 相对保存路径（与统一仓库布局一致，落盘即被 list_rwkv_models 扫描到）。
    st_rel: &'static str,
    /// models/ 下 vocab 相对保存路径（7.2B 有独立 vocab 子目录，其余共用顶层 vocab.json）。
    vocab_rel: &'static str,
    /// int8 量化近似字节数。
    size_bytes: u64,
    /// 就绪匹配区间（字节）：按 int8 实际体积紧凑匹配。
    min_bytes: u64,
    max_bytes: u64,
}

const BUILTIN_RWKV: &[BuiltinRwkvModel] = &[
    BuiltinRwkvModel {
        key: "rwkv-3b",
        display: "RWKV 3B",
        // g1j 2.9b（20260831，ctx16384）int8；档位统一命名 rwkv7-(3/7/13)B-int8.st
        //（7B/13B 待 g1j 权重就绪后跟进统一；13B 文件尚未上传仓库）
        st_rel: "rwkv/rwkv7-3B-int8.st",
        vocab_rel: "rwkv/vocab.json",
        size_bytes: 3_295_783_296,
        min_bytes: 2_500_000_000,
        max_bytes: 4_500_000_000,
    },
    // 7B/13B 内置支持已收窄移除（2026-09-10）：本地对话模型仅保留 RWKV 3B，
    // 已下载文件保留但不再出现在目录/下载列表。
];

const RWKV_UNIFIED_REPO: &str = "cgisky/ai00-x";
/// ModelScope 镜像仓库（同步脚本 sync-models.py 的 MS_REPO）。
const RWKV_MS_REPO: &str = "cgisky/Ai00-X";

/// 下载 URL：主源 hf-mirror + 回退 [(ModelScope, HuggingFace)]（国内直连最稳优先）。
fn rwkv_builtin_urls(rel_path: &str) -> (String, Vec<(&'static str, String)>) {
    (
        format!("https://hf-mirror.com/{RWKV_UNIFIED_REPO}/resolve/main/{rel_path}"),
        vec![
            (
                "ms",
                format!("https://modelscope.cn/models/{RWKV_MS_REPO}/resolve/master/{rel_path}"),
            ),
            (
                "hf",
                format!("https://huggingface.co/{RWKV_UNIFIED_REPO}/resolve/main/{rel_path}"),
            ),
        ],
    )
}

/// 内置 RWKV 下载目录（就绪判定 = 扫描到匹配档位大小的本地模型，返回可用路径）。
#[tauri::command]
pub fn rwkv_builtin_catalog() -> Vec<BuiltinRwkvEntry> {
    let scanned = list_rwkv_models();
    BUILTIN_RWKV
        .iter()
        .map(|m| {
            let hit = scanned
                .iter()
                .find(|info| info.size_bytes >= m.min_bytes && info.size_bytes < m.max_bytes);
            BuiltinRwkvEntry {
                key: m.key.to_string(),
                display: m.display.to_string(),
                file_rel: m.st_rel.to_string(),
                size_bytes: m.size_bytes,
                downloaded: hit.is_some(),
                resolved_model_path: hit.map(|h| h.model_path.clone()),
                resolved_vocab_path: hit.map(|h| h.vocab_path.clone()),
            }
        })
        .collect()
}

/// 触发 RWKV 模型下载（int8 .st + vocab 两个任务，vocab 已存在则跳过）。
/// 复用通用下载链路（进度/断点/多源回退），返回任务 id 列表。
#[tauri::command]
pub async fn rwkv_builtin_download(key: String) -> Result<Vec<String>, String> {
    let entry = BUILTIN_RWKV
        .iter()
        .find(|m| m.key == key)
        .ok_or_else(|| format!("unknown builtin rwkv model: {key}"))?;
    let models_dir = crate::runtime::get_models_dir();
    let mut task_ids = Vec::new();

    let (st_primary, st_hosts) = rwkv_builtin_urls(entry.st_rel);
    let st_info = crate::model_checker::ModelUpdateInfo {
        component: "llm-rwkv".to_string(),
        name: entry.key.to_string(),
        key: entry.key.to_string(),
        url: entry.st_rel.to_string(),
        download_url: st_primary,
        available_hosts: st_hosts
            .into_iter()
            .map(|(k, u)| (k.to_string(), u))
            .collect(),
        local_hash: None,
        remote_hash: "builtin-catalog".to_string(),
        needs_update: true,
    };
    task_ids.push(crate::model_init::download_model(st_info).await?);

    if !models_dir.join(entry.vocab_rel).exists() {
        let (v_primary, v_hosts) = rwkv_builtin_urls(entry.vocab_rel);
        let vocab_info = crate::model_checker::ModelUpdateInfo {
            component: "llm-rwkv-vocab".to_string(),
            name: format!("{key}-vocab"),
            key: format!("{key}-vocab"),
            url: entry.vocab_rel.to_string(),
            download_url: v_primary,
            available_hosts: v_hosts
                .into_iter()
                .map(|(k, u)| (k.to_string(), u))
                .collect(),
            local_hash: None,
            remote_hash: "builtin-catalog".to_string(),
            needs_update: true,
        };
        task_ids.push(crate::model_init::download_model(vocab_info).await?);
    }
    Ok(task_ids)
}

/// 扫描模型目录，返回第一个 .st / .safetensors 模型文件（跳过路由小模型）。
fn scan_model_file() -> Option<String> {
    let models_dir = assets_models_dir();
    let entries = std::fs::read_dir(&models_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && is_rwkv_model_file(&path) && !is_router_model_file(&path) {
            return Some(path.to_string_lossy().into_owned());
        }
    }
    None
}

#[tauri::command]
pub async fn rwkv_init_webrwkv(
    app: tauri::AppHandle,
    model_path: Option<String>,
    vocab_path: Option<String>,
    _state_path: Option<String>,
) -> Result<bool, String> {
    init_engine_internal(Some(app), model_path, vocab_path).await
}

/// 引擎初始化核心逻辑（tauri command 与启动序列共用）。
/// `app` 为 None 时不 emit 调试事件（供启动预加载路径使用）。
pub async fn init_engine_internal(
    app: Option<tauri::AppHandle>,
    model_path: Option<String>,
    vocab_path: Option<String>,
) -> Result<bool, String> {
    // 先解析目标模型路径（供路径感知 gate 比对）
    let (default_vocab, _) = resolve_default_paths();
    let vp = vocab_path.unwrap_or(default_vocab);
    let mp = match model_path {
        Some(p) => {
            if !Path::new(&p).exists() {
                return Err(format!("Model file not found: {}", p));
            }
            p
        }
        None => match scan_model_file() {
            Some(p) => p,
            None => return Err("No model file found in models directory".to_string()),
        },
    };
    debug_print!("rwkv_init: model_path={} vocab_path={}", mp, vp);

    // 路径感知 gate：已就绪且目标模型相同 → 直接返回；不同 → 触发热切换
    let force = if LLM_READY.load(Ordering::SeqCst) {
        let same = LLM_CURRENT_MODEL
            .read()
            .map(|c| c.as_deref() == Some(mp.as_str()))
            .unwrap_or(false);
        if same {
            if let Some(app) = &app {
                let _ = app.emit("rwkv://debug", "llm initialized".to_string());
            }
            crate::model_init::LLM_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
            return Ok(true);
        }
        true
    } else {
        false
    };

    if LLM_INITING.get().is_none() {
        let _ = LLM_INITING.set(Mutex::new(false));
    }
    let in_progress = {
        let flag = LLM_INITING.get().ok_or("init flag missing")?;
        let mut f = flag.lock().map_err(|_| "lock poisoned".to_string())?;
        let ip = *f;
        if !ip {
            *f = true;
        }
        ip
    };
    if in_progress {
        for _ in 0..50 {
            if LLM_READY.load(Ordering::SeqCst) {
                if let Some(app) = &app {
                    let _ = app.emit("rwkv://debug", "llm initialized".to_string());
                }
                crate::model_init::LLM_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
                return Ok(true);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        return Err("initialization in progress".to_string());
    }
    struct ResetFlagOnDrop(Option<tauri::AppHandle>);
    impl Drop for ResetFlagOnDrop {
        fn drop(&mut self) {
            if let Some(flag) = LLM_INITING.get() {
                if let Ok(mut f) = flag.lock() {
                    *f = false;
                }
            }
            if let Some(app) = &self.0 {
                let _ = app.emit("rwkv://debug", "llm init flag reset".to_string());
            }
        }
    }
    let _reset = ResetFlagOnDrop(app.clone());

    if let Some(app) = &app {
        let _ = app.emit("rwkv://debug", format!("init model={} vocab={}", mp, vp));
    }
    if let Some(app) = &app {
        let _ = app.emit("rwkv://debug", "llm initializing".to_string());
    }

    // 确保 pool 线程已启动（常驻，加载由 Init 消息触发）
    let pool = ensure_inference_pool();
    register_with_vram_manager();

    let (reply_tx, reply_rx) = oneshot::channel::<Result<(), String>>();
    pool.tx
        .send(PoolRequest::Init {
            model_path: mp,
            vocab_path: vp,
            force,
            app,
            reply: reply_tx,
        })
        .map_err(|e| format!("failed to send init request: {}", e))?;

    // 大模型加载（mmap + GPU 上传）可能耗时较长
    let result = tokio::time::timeout(Duration::from_secs(300), reply_rx).await;
    match result {
        Ok(Ok(Ok(()))) => {
            crate::model_init::LLM_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
            Ok(true)
        }
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(_closed)) => Err("init channel closed unexpectedly".to_string()),
        Err(_elapsed) => Err("model load timed out after 300s".to_string()),
    }
}

/// 启动序列智能路由预加载：router.enabled 时仅加载常驻路由小模型（0.1B，
/// ~0.2GB 显存），使首个 auto 模式请求即可完成本地分类——不再为路由加载
/// 整个主本地模型。路由模型未下载（manifest 首启拉取）时跳过，首次分类
/// 请求会懒加载兜底。
pub async fn preload_engine_for_router() {
    // 等待配置服务就绪（启动初期可能尚未初始化，最多等 30s）。
    for _ in 0..300 {
        if ai00_x_core::service::config::get_global_config_service().is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let Ok(config_service) = ai00_x_core::service::config::get_global_config_service() else {
        log::warn!("[rwkv] config service unavailable, skip router preload");
        return;
    };
    let ai_config: ai00_x_core::service::config::types::AIConfig = config_service
        .get_config(Some("ai"))
        .await
        .unwrap_or_default();
    if !ai_config.router.enabled {
        return;
    }
    // 显存预算保护：路由小模型常驻预算 ~0.5GB（0.1B int8 ~0.2GB + 状态/缓冲）。
    // 预算不足时跳过（预加载不驱逐其它引擎；首次分类请求会懒加载兜底）。
    if let Some(mem) = crate::vram_monitor::query_vram(None) {
        let reserve = 1024u64 * 1024 * 1024;
        let min_need = 512u64 * 1024 * 1024;
        if mem.free_bytes.saturating_sub(reserve) < min_need {
            log::info!(
                "[rwkv] insufficient VRAM headroom (free {} MB), skip router preload",
                mem.free_bytes / (1024 * 1024)
            );
            return;
        }
    }
    if !router_model_path().exists() {
        log::info!(
            "[rwkv] router mini model not downloaded yet ({}), classify lazy-inits after download",
            router_model_path().display()
        );
        return;
    }
    log::info!("[rwkv] smart router enabled, preloading router mini model");
    match init_router_internal().await {
        Ok(_) => log::info!("[rwkv] router preload complete"),
        Err(e) => log::warn!("[rwkv] router preload failed: {}", e),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rwkv_chat(
    prompt: String,
    max_tokens: usize,
    _temperature: f32,
    top_p: f32,
    top_k: usize,
    presence_penalty: f32,
    frequency_penalty: f32,
    penalty_decay: f32,
    _state_path: Option<String>,
) -> Result<ChatResult, String> {
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let mut rx = pool_infer(
            prompt,
            max_tokens,
            top_p,
            top_k,
            presence_penalty,
            frequency_penalty,
            penalty_decay,
            None,
            None,
            false,
            false,
            String::new(),
        )
        .await?;

        let mut text = String::new();
        let mut input_tokens = 0usize;
        let mut output_tokens = 0usize;
        while let Some(event) = rx.recv().await {
            match event {
                InferenceEvent::Token(t) => text.push_str(&t),
                InferenceEvent::Done {
                    text: t,
                    input_tokens: it,
                    output_tokens: ot,
                    ..
                } => {
                    text = t;
                    input_tokens = it;
                    output_tokens = ot;
                    break;
                }
                InferenceEvent::Error(e) => return Err(e),
            }
        }
        Ok(ChatResult {
            text,
            input_token_count: input_tokens,
            output_token_count: output_tokens,
        })
    })
    .await;
    match result {
        Ok(inner) => inner,
        Err(_elapsed) => Err("RWKV inference timed out after 30s".to_string()),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rwkv_chat_stream(
    app: tauri::AppHandle,
    prompt: String,
    max_tokens: usize,
    stop: Option<Vec<String>>,
    _kbnf: Option<String>,
    _temperature: f32,
    top_p: f32,
    top_k: usize,
    presence_penalty: f32,
    frequency_penalty: f32,
    penalty_decay: f32,
    _state_path: Option<String>,
    session_id: Option<String>,
    model_text: Option<String>,
) -> Result<String, String> {
    // Lazy-init: ensure LLM engine is started before inference.
    // Frontend may not call init_llm_engine explicitly, so we auto-start here.
    if !is_llm_initialized() {
        let _ = app.emit(
            "rwkv://debug",
            "llm not ready, auto-initializing".to_string(),
        );
        let app_clone = app.clone();
        if let Err(e) = rwkv_init_webrwkv(app_clone, None, None, None).await {
            let _ = app.emit("rwkv://debug", format!("auto-init failed: {}", e));
            return Err(format!("LLM auto-init failed: {}", e));
        }
    }

    {
        let _ = app.emit("rwkv://start", prompt.clone());
        let _ = app.emit("rwkv://debug", format!("start prompt_len={}", prompt.len()));
    }
    rwkv_debug_append(
        &app,
        session_id.as_deref(),
        "start",
        &format!("prompt_len={} max_tokens={}", prompt.len(), max_tokens),
    );

    let mut rx = pool_infer(
        prompt,
        max_tokens,
        top_p,
        top_k,
        presence_penalty,
        frequency_penalty,
        penalty_decay,
        stop,
        session_id.clone(),
        true,
        true,
        model_text.unwrap_or_default(),
    )
    .await?;

    let mut text = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            InferenceEvent::Token(t) => {
                emit_to_overlay(&app, "rwkv://token", t.clone());
                text.push_str(&t);
            }
            InferenceEvent::Done {
                text: t,
                stop_sequence,
                ..
            } => {
                text = t;
                if let Some(seq) = stop_sequence {
                    let _ = app.emit(
                        "rwkv://stop_hit",
                        serde_json::json!({"sequence": seq, "kind": "stop"}),
                    );
                }
                break;
            }
            InferenceEvent::Error(e) => return Err(e),
        }
    }

    emit_to_overlay(&app, "rwkv://done", &text);
    rwkv_debug_append(
        &app,
        session_id.as_deref(),
        "end",
        &format!("text_len={}", text.len()),
    );
    Ok(text)
}

#[tauri::command]
pub fn rwkv_chat_stream_cancel() -> Result<bool, String> {
    cancel_epoch().fetch_add(1, Ordering::SeqCst);
    Ok(true)
}

/// Clear the cached state for a given session_id.
/// Called by the frontend when resetting a chat to ensure the next request
/// starts from a fresh state instead of resuming from the cached one.
#[tauri::command]
pub async fn rwkv_clear_session_cache(session_id: String) -> Result<bool, String> {
    match get_inference_pool() {
        Some(pool) => {
            let _ = pool.tx.send(PoolRequest::ClearSession(session_id));
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod router_mini_tests {
    use super::*;

    /// router- 前缀过滤：固定名命中（大小写不敏感），普通模型名不命中。
    #[test]
    fn router_prefix_filter() {
        let yes = |name: &str| is_router_model_file(Path::new(name));
        assert!(yes("router-0.1B-int8.st"));
        assert!(yes("ROUTER-test.safetensors"));
        assert!(!yes("rwkv7-3B-int8.st"));
        assert!(!yes("rwkv7-7B-int8.st"));
        // 无连缀前缀（routerX）不是路由模型。
        assert!(!yes("routerx.st"));
    }

    fn toy_v4_head(base_dim: usize) -> ai00_x_core::routing::head::RouterHead {
        let n = base_dim + 5;
        let mean = vec![0.0_f32; n];
        let std = vec![1.0_f32; n];
        let mut w1 = vec![0.0_f32; n];
        w1[0] = 1.0;
        let json = format!(
            r#"{{"version":1,"input_dim":{n},"hidden_dim":1,"base_dim":{base_dim},
                "mean":{mean:?},"std":{std:?},
                "w1":{w1:?},"b1":[0.0],"ln_g":[1.0],"ln_b":[0.0],
                "w2":[1.0,0.0,0.0,0.0],"b2":[0.0,0.0,0.0,0.0]}}"#
        );
        ai00_x_core::routing::head::RouterHead::from_json_str(&json).unwrap()
    }

    /// 分类头校验：缺失拒绝；维度不匹配拒绝；匹配通过（回退链判定核心）。
    #[test]
    fn check_router_head_dims() {
        let head = toy_v4_head(2);
        assert!(check_router_head(None, 2).is_err());
        assert!(check_router_head(Some(&head), 3).is_err());
        assert!(check_router_head(Some(&head), 2).is_ok());
        // 错误信息可定位（缺失 vs 不匹配）。
        assert!(check_router_head(None, 2)
            .unwrap_err()
            .contains("not loaded"));
        assert!(check_router_head(Some(&head), 3)
            .unwrap_err()
            .contains("mismatch"));
    }
}
