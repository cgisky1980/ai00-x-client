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

use crate::rwkv_choose::{Candidate, ChoiceScore};
use ai00_x_ai_adapters::providers::rwkv::request::estimate_prompt_tokens;

const DEBUG_LOG_LLM: bool = false;
macro_rules! debug_print {
    ($($arg:tt)*) => {
        if DEBUG_LOG_LLM {
            println!($($arg)*);
        }
    };
}

const MAX_SLOTS: usize = 16;
/// 批量 prefill 的最大批宽：队列里凑够 ≥2 个「无缓存命中」任务即按行并批。
///
/// 并发墙钟：串行 prefill 的 4 路 ~5k token 请求是 4×1.8s ≈ 7.5s，并批后 ≈5.3s
/// （rwkv-rsv `batch_prefill_probe`，3B int8/CUDA，含完成行暂存开销）。批宽
/// 2/4/8 的加速比都在 1.4× 附近，取 4 覆盖工作台 4 路 compose，也不至于让
/// `SeqBuffers`（bt = 批宽 × 768）挤占解码显存。
const BATCH_PREFILL_WIDTH: usize = 4;

/// 批量 prefill 批宽（`AI00X_BATCH_PREFILL=0` 关闭并批，走原串行路径；默认 4）。
/// 读一次即缓存：同一进程内两臂语义不同，A/B 须重启进程换档。
fn batch_prefill_width() -> usize {
    static N: OnceLock<usize> = OnceLock::new();
    *N.get_or_init(|| {
        std::env::var("AI00X_BATCH_PREFILL")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(BATCH_PREFILL_WIDTH)
            .min(MAX_SLOTS)
    })
}

/// 组批的最短 prompt（token）：批内每行都按 `PREFILL_CHUNK` 补齐，短 prompt
/// 并批是拿 15× 的补齐算力换一次 launch（实测 4×51 token：并批 1.14s vs 串行
/// ~0.2s/条）。工具轮这类短请求保持串行；长 prompt 才值得并批。
const BATCH_PREFILL_MIN_TOKENS: usize = 512;

/// prefill 分块长度：限制单次 seq 缓冲大小（块大小固定避免重建）。
///
/// 分块是串行推进的，每块一次 `forward_seq_with_state`；块越小调用开销占比越高，
/// 但块越大末块（prompt 长度取模）与会话回退拆分块的重建代价也越大。引擎层 A/B
/// （3B int8，同机，含会话回退 head/tail 路径，5056 token）：
/// 128 ≈ 4.5s → 512 ≈ 2.6-2.9s → **768 ≈ 2.40s** → 1024 ≈ 2.6s → 1536 不稳。
/// 2048 token 时 512/768 持平；8192 token 时 768 仍快约 7%。768 是 256 对齐
/// （`m_pad` 按 256 补齐）下的甜点，故取 768。E2E（rwkv_chat，4984 token，
/// max_tokens=16）：512 中位 2.92s → 768 中位 2.64s（-10%）。
const PREFILL_CHUNK: usize = 768;
/// 惩罚历史每槽容量（token 数）。超出后丢弃最旧 1/4（惩罚窗口滑动，语义与
/// 客户端原 `token_counts` 的"全历史计数"在窗口内等价）。
const HIST_STRIDE: usize = 8192;

pub enum InferenceEvent {
    Token(String),
    Done {
        text: String,
        input_tokens: usize,
        output_tokens: usize,
        /// 会话前缀缓存复用的 token 数（0 = 零状态全量 prefill）。
        /// 记进 ai_usage 的 cachedPromptTokens，用于验证缓存命中率。
        cached_tokens: usize,
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
    /// 命中前缀缓存复用的 token 数（0 = 全量 prefill），回传 usage 用。
    cached_tokens: usize,
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
    /// 进入 prefill 队列的时刻（用于观测 prefill 耗时，含排队等待）。
    queued_at: std::time::Instant,
    /// 提交时的取消代次（`rwkv_chat_stream_cancel` 递增）；落后即取消。
    cancel_epoch: u64,
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
    /// 提交时的取消代次（空闲卸载/取消按键会让旧任务退出，不再白跑 GPU）。
    cancel_epoch: u64,
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
    /// 候选打分（Jev 式：单次前向、零生成 token）：逐候选算平均 NLL，升序回表。
    /// 口径与三处 quirk 见 [`crate::rwkv_choose`]。只走主引擎——router_mini 是
    /// 分类专用小模型，能分类不代表会打分。
    Choose {
        prompt: String,
        choices: Vec<String>,
        calibrate: bool,
        reply: oneshot::Sender<Result<Vec<ChoiceScore>, String>>,
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
    fn contexts(&self) -> &[&str] {
        // 工作台委派 agent 时前端会 `vram_set_active_context("agent")`
        //（useAgentDelegate / useDshChat），以此作为本地模型的预测加载信号。
        &["agent"]
    }
    /// 预测预热：agent 上下文激活时提前加载主本地模型，把首个工具轮的
    /// 10s+ 冷加载从关键路径上拿掉（原先只有首个请求触发的 lazy-init）。
    /// 显存不够（或模型未下载）时直接跳过，失败不影响懒加载兜底。
    fn warmup(&self) -> Result<(), String> {
        if LLM_READY.load(Ordering::SeqCst) {
            return Ok(());
        }
        let Some(model_path) = scan_model_file() else {
            return Err("no model file found in models directory".to_string());
        };
        if let Some(mem) = crate::vram_monitor::query_vram(None) {
            let reserve = 1024u64 * 1024 * 1024;
            let need = estimate_rwkv_vram_bytes(&model_path).unwrap_or(0);
            let free = mem.free_bytes.saturating_sub(reserve);
            if free < need {
                return Err(format!(
                    "insufficient VRAM headroom (free {} MB, need {} MB)",
                    free / (1024 * 1024),
                    need / (1024 * 1024)
                ));
            }
        }
        log::info!("[rwkv] agent context active, preloading local model {model_path}");
        // warmup 跑在 vram_manager 的专用线程上：用一个临时 current-thread
        // runtime 驱动异步 init（本文件的推理池线程禁止 block_on，这里不是池线程）。
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("warmup runtime: {e}"))?;
        rt.block_on(init_engine_internal(None, None, None))?;
        log::info!("[rwkv] local model preload complete");
        Ok(())
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
    /// 会话缓存的插入顺序（LRU 淘汰用；同一 key 更新时移到队尾）。
    session_order: VecDeque<String>,
    /// 专用分类状态（智能路由 prefill 用，与生成槽位隔离；仅主模型兼容回退时使用）。
    classify_state: State,
    /// 批量 prefill 状态池：`(宽度, 活动态, 暂存态)`，宽度变化时重建（懒创建）。
    /// 暂存态接「先喂完的行」的终态：拷过去后该行继续喂占位 token 不污染真状态。
    batch_prefill_states: Option<(usize, State, State)>,
}

/// 批量 prefill 组内的单行任务（行号 = 在 `BatchPrefillGroup::tasks` 里的下标）。
struct BatchPrefillTask {
    task: InferenceTask,
    /// `input_tokens` 已喂游标（恒 ≤ len-1：末 token 留给解码组首步采样）。
    cursor: usize,
    /// 会话缓存的快照点（= len-1-back，与串行路径 `prefill_step` 的 head/tail
    /// 拆分同口径）；None = 不写缓存（短 prompt / 无 session_id）。
    cache_point: Option<usize>,
}

/// 进行中的批量 prefill 组：cache-miss 任务按行并行推进，每轮每行喂 ≤ `PREFILL_CHUNK`。
struct BatchPrefillGroup {
    tasks: Vec<BatchPrefillTask>,
    /// 终态已拷到暂存态的行（之后只喂占位，不再读其结果）。
    parked: Vec<bool>,
    started_at: std::time::Instant,
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
    // 批量 prefill 组：队列里 cache-miss 任务凑够 ≥2 时并批（与串行路径二选一）。
    let mut batch_prefill: Option<BatchPrefillGroup> = None;
    let mut pending: Vec<InferenceTaskParams> = Vec::new();
    // 采样种子基数：每任务递增（GPU 采样器以 seed 哈希随机数）。
    let mut seed_counter: u32 = 1;

    loop {
        // 引擎或路由小模型存在且完全空闲 → 可进入等待；否则非阻塞抽干消息。
        // 注意 router_mini 计入空闲判定：主模型未加载时不能陷入忙等空转。
        let idle = (engine.is_some() || router_mini.is_some())
            && tasks.iter().all(|s| s.is_none())
            && prefill_queue.is_empty()
            && batch_prefill.is_none()
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
                    || batch_prefill.is_some()
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

        // 取消扫描：epoch 落后（用户点停止 / 上层 cancel）或事件通道已关闭
        // （HTTP 客户端断开）的任务立即退出——否则它们会继续占着槽位把
        // max_tokens 跑完，白白拖慢其它请求。
        let epoch_now = cancel_epoch().load(Ordering::Relaxed);
        let is_cancelled = |epoch: u64, tx: &mpsc::UnboundedSender<InferenceEvent>| {
            epoch < epoch_now || tx.is_closed()
        };
        let mut kept_pending = Vec::with_capacity(pending.len());
        for p in pending.drain(..) {
            if is_cancelled(p.cancel_epoch, &p.tx) {
                let _ = p.tx.send(InferenceEvent::Error("cancelled".to_string()));
            } else {
                kept_pending.push(p);
            }
        }
        pending = kept_pending;
        {
            let mut kept: VecDeque<InferenceTask> = VecDeque::with_capacity(prefill_queue.len());
            while let Some(t) = prefill_queue.pop_front() {
                if is_cancelled(t.cancel_epoch, &t.tx) {
                    log::debug!(
                        "[rwkv] cancel prefill task ({}; epoch {} vs {})",
                        if t.tx.is_closed() {
                            "通道已关闭"
                        } else {
                            "epoch 落后"
                        },
                        t.cancel_epoch,
                        epoch_now
                    );
                    let _ = t.tx.send(InferenceEvent::Error("cancelled".to_string()));
                } else {
                    kept.push_back(t);
                }
            }
            prefill_queue = kept;
        }
        // 批量组整体取消：组内都是同一代任务，摘行会破坏行↔任务映射，直接整组退出。
        if batch_prefill.as_ref().is_some_and(|g| {
            g.tasks
                .iter()
                .any(|bt| is_cancelled(bt.task.cancel_epoch, &bt.task.tx))
        }) {
            let group = batch_prefill.take().expect("组存在");
            for bt in group.tasks {
                let _ = bt
                    .task
                    .tx
                    .send(InferenceEvent::Error("cancelled".to_string()));
            }
        }
        // 解码组：摘掉取消行后紧凑前缀（后续 decode_step 仍要求无空洞）。
        let mut cancelled_rows = false;
        for (i, slot) in tasks.iter_mut().enumerate() {
            if let Some(t) = slot.as_ref() {
                if is_cancelled(t.cancel_epoch, &t.tx) {
                    log::debug!(
                        "[rwkv] cancel decode row {i} ({}; epoch {} vs {})",
                        if t.tx.is_closed() {
                            "通道已关闭"
                        } else {
                            "epoch 落后"
                        },
                        t.cancel_epoch,
                        epoch_now
                    );
                    let t = slot.take().expect("checked some");
                    let _ = t.tx.send(InferenceEvent::Error("cancelled".to_string()));
                    cancelled_rows = true;
                }
            }
        }
        if cancelled_rows {
            compact_tasks(&mut tasks, engine);
        }

        // 调度 pending → prefill 队列（活跃任务总数 ≤ slot_count；批量组里的行
        // 虽然不在队列里，但同样占着活跃额度，必须计入）
        while !pending.is_empty() {
            let active = tasks.iter().filter(|s| s.is_some()).count()
                + prefill_queue.len()
                + batch_prefill.as_ref().map(|g| g.tasks.len()).unwrap_or(0);
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

        // prefill 一步：缓存命中任务先走串行（后缀短，别让它等整轮组批）；
        // 否则有批量组就推进一轮；再否则凑批；最后退回串行。
        if prefill_queue
            .front()
            .is_some_and(|t| t.resume_state.is_some())
        {
            serial_prefill_step(&mut prefill_queue, engine, &mut tasks);
        } else if let Some(group) = batch_prefill.as_mut() {
            match batch_prefill_step(group, engine) {
                Ok(true) => {
                    let group = batch_prefill.take().expect("组存在");
                    log::debug!(
                        "[rwkv] batch prefill done: {} rows in {:.2}s",
                        group.tasks.len(),
                        group.started_at.elapsed().as_secs_f64()
                    );
                    join_batch_prefill(group, engine, &mut tasks);
                }
                Ok(false) => {}
                Err(e) => {
                    let group = batch_prefill.take().expect("组存在");
                    log::error!("[rwkv] batch prefill error: {}", e);
                    for bt in group.tasks {
                        let _ = bt.task.tx.send(InferenceEvent::Error(e.clone()));
                    }
                }
            }
        } else if let Some(mut group) = form_batch_prefill(&mut prefill_queue, engine) {
            log::debug!(
                "[rwkv] batch prefill start: {} rows, tokens {:?}",
                group.tasks.len(),
                group
                    .tasks
                    .iter()
                    .map(|t| t.task.input_tokens.len())
                    .collect::<Vec<_>>()
            );
            group.started_at = std::time::Instant::now();
            batch_prefill = Some(group);
        } else {
            serial_prefill_step(&mut prefill_queue, engine, &mut tasks);
        }

        // 解码组推进一步（批量前向 + GPU 采样），并回收已补喂完成的任务。
        // 批量 prefill 组进行中时，**流式**任务每轮多推几步：否则「一轮 prefill
        // 才一步 decode」会把 token 间隔拉到 ~0.7s（8 路两波实测：第一波 8 token
        // 用了 5.5s）。非流式任务整段缓冲，多推只会拖慢下一波，保持单步。
        let streaming_active = tasks
            .iter()
            .take_while(|s| s.is_some())
            .flatten()
            .any(|t| t.is_streaming);
        let decode_steps = if batch_prefill.is_some() && streaming_active {
            3
        } else {
            1
        };
        for _ in 0..decode_steps {
            if tasks[0].is_none() {
                break;
            }
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
                break;
            }
            for row in finalize_rows {
                if let Some(mut t) = tasks[row].take() {
                    finalize_task(&mut t, engine, Some(row));
                }
            }
            compact_tasks(&mut tasks[..n_active], engine);
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
        PoolRequest::Choose {
            prompt,
            choices,
            calibrate,
            reply,
        } => {
            // 打分与分类同律：pool 线程内同步跑完再回通道（几十次单 token 前向，
            // 短于一次生成）。router_mini 不参与——只有主模型会打分。
            let Some(engine) = engine.as_mut() else {
                let _ = reply.send(Err("LLM engine not initialized".to_string()));
                return true;
            };
            // 打分计入主模型 keep_alive（与主模型回退分类同一条）。
            LLM_LAST_USED_MS.store(now_ms(), Ordering::Relaxed);
            let result = choose_with_engine(engine, &prompt, &choices, calibrate);
            match &result {
                Ok(rows) => log::debug!(
                    "[rwkv] choose: {} choices, best={:?} ppl={:.4}",
                    rows.len(),
                    rows.first().map(|r| r.choice.as_str()),
                    rows.first().map(|r| r.perplexity).unwrap_or(f32::NAN)
                ),
                Err(e) => log::warn!("[rwkv] choose failed: {e}"),
            }
            let _ = reply.send(result);
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

/// 候选打分（Jev 式：单次前向、零生成 token）。口径与三处 quirk 见
/// [`crate::rwkv_choose`]，语义与 mytown `model-server` 的 `/v1/chooses` 逐位对齐
/// （那份是同一套打分数学的拷贝）。
///
/// prompt 与每个候选都**原样分词**：不套聊天模板、不注入前导空格——参照实现
/// （`ai00-core/src/run.rs`）就是直接 `encode(prompt)`，套了模板分数会整体漂移，
/// 两侧对拍也就失去可比性。
///
/// 复用 `classify_state`（单序列状态，与生成槽位/prefill 状态隔离）；打分入口会
/// 先把该状态清零，因此既不继承上一次打分、也不影响在飞的生成。
fn choose_with_engine(
    engine: &mut PoolEngine,
    prompt: &str,
    choices: &[String],
    calibrate: bool,
) -> Result<Vec<ChoiceScore>, String> {
    let prompt_tokens = engine
        .tokenizer
        .encode(prompt.as_bytes())
        .map_err(|e| format!("failed to encode choose prompt: {}", e))?;
    if prompt_tokens.is_empty() {
        return Err("choose prompt encoded to zero tokens".to_string());
    }
    // 先全部编码再拼引用：Candidate 借的是这里的 token 缓冲，两者都活到打分结束。
    let mut toks: Vec<Vec<u32>> = Vec::with_capacity(choices.len());
    for t in choices {
        toks.push(
            engine
                .tokenizer
                .encode(t.as_bytes())
                .map_err(|e| format!("failed to encode choice: {}", e))?,
        );
    }
    let cands: Vec<Candidate> = choices
        .iter()
        .zip(&toks)
        .map(|(text, tokens)| Candidate {
            text: text.as_str(),
            tokens,
        })
        .collect();
    crate::rwkv_choose::score_candidates_on_model(
        &mut engine.model,
        &mut engine.classify_state,
        &prompt_tokens,
        &cands,
        calibrate,
    )
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
    let mut prefill_state = model
        .create_state()
        .map_err(|e| format!("failed to create prefill state: {}", e))?;
    let hist_buf = model
        .alloc_u32(HIST_STRIDE * slot_count)
        .map_err(|e| format!("failed to alloc hist buf: {}", e))?;
    model
        .write_u32(hist_buf, &vec![0u32; HIST_STRIDE * slot_count])
        .map_err(|e| format!("failed to zero hist buf: {}", e))?;
    let use_batch_decode = model.supports_batch_decode();
    // 回落串行时把**原因**记一行：裸 bool 让事后无从判断是「模型是 fp16」还是「后端缺算子」。
    if let Some(reason) = model.batch_decode_blocker() {
        log::info!(
            "[rwkv] batch decode unavailable, falling back to per-slot serial: {}",
            reason
        );
    }
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

    // 预热 seq/prefill 的 int8 张量核：首个真实请求若是并发突发，NVRTC 首次编译
    // 会直接砸在关键路径上（实测首组 +0.5~1s）。用 64 token 哑前向把 r/k/v、
    // ffn key/value 的 IMMA 变体编好——显存只占 T=64 的 seq 缓冲（~30MB），
    // 不碰批量缓冲（那是 1.8GB 级，留给真实首组按需分配）。
    match model
        .forward_seq_with_state(&mut prefill_state, &vec![0u32; 64])
        .map(|_| ())
        .map_err(|e| e.to_string())
    {
        Ok(()) => {
            if let Err(e) = model.reset_state_of(&prefill_state) {
                log::warn!("[rwkv] prefill warmup reset failed: {e}");
            }
            log::info!("[rwkv] seq/prefill int8 内核预热完成（T=64）");
        }
        Err(e) => log::warn!("[rwkv] prefill warmup skipped: {e}"),
    }

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
        session_order: VecDeque::new(),
        classify_state,
        batch_prefill_states: None,
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
    let mut cached_tokens = 0usize;

    // 会话缓存只做**前缀延长**复用：RWKV 的 RNN 状态不可回退，prompt 一旦与
    // 缓存分叉就只能整段重算（拿旧状态喂分叉后的后缀会输出错乱，2026-11 的
    // "双重喂入"事故即此）。旧实现按 `# User` 边界猜跳过位，风险高；这里改为
    // 严格前缀判定（cache_extension）。
    //
    // 查找**不按 key 过滤**：缓存是内容寻址的——任何一条缓存只要 token 前缀
    // 匹配就能用，取匹配最长者。真实工人每轮的 system 快照带时间戳，按
    // system 哈希出的 key 每轮都不同（实测 2026-11-23 整个任务零命中），
    // 内容寻址彻底绕开 key 稳定性问题。
    if params.session_id.is_some() {
        log::debug!(
            "[rwkv] session cache lookup: {} entries, prompt {} tokens",
            engine.session_states.len(),
            prompt_tokens.len()
        );
        let mut best: Option<(usize, Vec<u32>, Vec<f32>)> = None;
        for (_key, (cached_toks, cached_state)) in engine.session_states.iter() {
            let Some(skip) =
                ai00_x_core::util::prompt_cache::cache_extension(&prompt_tokens, cached_toks)
            else {
                continue;
            };
            if best.as_ref().map(|(b, _, _)| skip > *b).unwrap_or(true) {
                best = Some((skip, cached_toks.clone(), cached_state.clone()));
            }
        }
        if let Some((skip, cached_prefix, cached_state)) = best {
            log::info!(
                "[rwkv] session cache hit: reuse {skip} of {} tokens, prefill {}",
                prompt_tokens.len(),
                prompt_tokens.len() - skip
            );
            base_tokens = cached_prefix;
            input_tokens = prompt_tokens[skip..].to_vec();
            resume_state = Some(cached_state);
            cached_tokens = skip;
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
        cached_tokens,
        session_id: params.session_id,
        max_tokens: if params.max_tokens == 0 {
            1
        } else {
            params.max_tokens
        },
        top_p: params.top_p.clamp(0.0, 1.0),
        // top_k=0（调用方未指定）→ 50：CUDA 采样 kernel 快速路径上限 MAXK=50，
        // >50 会落入「逐候选全词表归约」的兜底慢路径。实测（64 token，同机）：
        // top_k 1/8/32/50 均约 29-31ms/token，top_k=128 涨到 ~70ms/token——
        // 本地工具轮此前按 128 走，每轮白付 2-4s。与 rwkv_engine_adapter 口径一致。
        // （top_p<1 时改走 top_k=0 的 top-p 候选路径实测同样 ~30ms/token，无额外收益，故不特判。）
        top_k: if params.top_k == 0 { 50 } else { params.top_k },
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
        queued_at: std::time::Instant::now(),
        cancel_epoch: params.cancel_epoch,
    })
}

/// 会话状态缓存上限：每个条目是一份完整 RNN 状态（3B 实测 ~12MB/行，
/// host 内存副本；7B 约翻倍）。网关按「回合指纹」使用缓存，key 数量会比聊天
/// 场景多，必须限量但不必抠太小——agent 工作流里 4 路 compose 并行 + 工具轮
/// 会同时需要多个前缀，4 条容易互相淘汰。8 条在 3B 上只多占 ~50MB host 内存。
/// 超额按插入顺序淘汰（近似 LRU；命中不重排，够用且实现简单）。
const SESSION_STATE_CAP: usize = 8;

/// 缓存前缀相对 prompt 末尾的回退 token 数（BPE 边界失配防护，见 prefill_step）。
/// 8 足以覆盖 `{"name": "` 与回放渲染 `{"name":"` 的 token 化差异。
const SESSION_CACHE_BACKTRACK: usize = 8;

/// 写入会话缓存并做容量淘汰。
///
/// 每条缓存用「来源 key + 自增序号」作 HashMap 键：查找是内容寻址的（遍历
/// 所有条目按前缀匹配），键只用于淘汰顺序，不参与命中判断；这样多个工人/
/// 连续回合的缓存互不覆盖。
fn cache_session_state(engine: &mut PoolEngine, sid: String, tokens: Vec<u32>, state: Vec<f32>) {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let key = format!("{sid}#{}", SEQ.fetch_add(1, Ordering::Relaxed));
    engine.session_states.insert(key.clone(), (tokens, state));
    engine.session_order.retain(|k| k != &key);
    engine.session_order.push_back(key);
    while engine.session_order.len() > SESSION_STATE_CAP {
        if let Some(old) = engine.session_order.pop_front() {
            engine.session_states.remove(&old);
        }
    }
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

    // 末块 + 有会话：缓存前缀要**回退几个 token**。
    //
    // prompt 的末尾与"下一轮 prompt"的分叉点就在这里：BPE 在文本末尾的
    // 编码与"后面还有字"时可能不同（实测 `Assistant: ` 末尾空格单独编码 vs
    // 与首个生成字符合并），缓存整段 prompt 会让下一轮恰好在最后 1–2 个
    // token 失配。因此末块先喂 head 并快照（tokens = prompt 去掉末尾 K 个），
    // 再喂 tail 拿 logits——下一轮只 prefill K + 增量，稳定命中。
    if end == task.input_tokens.len() {
        if let Some(sid) = task.session_id.clone() {
            let back = SESSION_CACHE_BACKTRACK.min(chunk.len().saturating_sub(1));
            if back > 0 {
                let (head, tail) = chunk.split_at(chunk.len() - back);
                if !head.is_empty() {
                    engine
                        .model
                        .forward_seq_with_state(&mut engine.prefill_state, head)
                        .map_err(|e| format!("prefill failed: {}", e))?;
                }
                if let Ok(st) = engine.model.state_back(&engine.prefill_state) {
                    let keep = task.input_tokens.len() - back;
                    let mut tokens = task.base_tokens.clone();
                    tokens.extend_from_slice(&task.input_tokens[..keep]);
                    cache_session_state(engine, sid, tokens, st);
                }
                let logits = engine
                    .model
                    .forward_seq_with_state(&mut engine.prefill_state, tail)
                    .map_err(|e| format!("prefill failed: {}", e))?;
                task.prefill_cursor = end;
                task.prefill_logits = Some(logits);
                return Ok(true);
            }
        }
    }

    let logits = engine
        .model
        .forward_seq_with_state(&mut engine.prefill_state, &chunk)
        .map_err(|e| format!("prefill failed: {}", e))?;
    task.prefill_cursor = end;
    if end < task.input_tokens.len() {
        return Ok(false);
    }
    task.prefill_logits = Some(logits);
    Ok(true)
}

/// 串行 prefill 一步（队首任务一块，其余任务的解码不受阻塞）；完成即转入解码组。
fn serial_prefill_step(
    queue: &mut VecDeque<InferenceTask>,
    engine: &mut PoolEngine,
    tasks: &mut [Option<InferenceTask>],
) {
    let Some(task) = queue.front_mut() else {
        return;
    };
    match prefill_step(task, engine) {
        Ok(true) => {
            // 观测：prefill 完成（含排队等待）——本地工具轮的主要延迟来源
            log::debug!(
                "[rwkv] prefill done: prompt={} tok input={} tok in {:.2}s",
                task.prompt_tokens.len(),
                task.input_tokens.len(),
                task.queued_at.elapsed().as_secs_f64()
            );
            // 队首 prefill 完成 → 转入解码组（活跃数 ≤ slot_count 保证有空行）
            let mut task = queue.pop_front().expect("队首存在");
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
            let task = queue.pop_front().expect("队首存在");
            log::error!("[rwkv] prefill error: {}", e);
            let _ = task.tx.send(InferenceEvent::Error(e));
        }
    }
}

/// 从队列挑 cache-miss 任务组批（≥2 行才值得，且批宽 ≤ slot_count）。
///
/// 只收「零起点、至少 2 个 token、无缓存命中」的任务：
/// · 缓存命中任务的后缀通常很短，走串行 `prefill_step`（且其起步态是恢复态，
///   批量路径没有对应入口）；
/// · 1-token 的任务没有可喂块（末 token 要留给解码组首步）；
/// · 已串行推进过的任务（`prefill_cursor > 0`）状态在 `prefill_state` 里，不并批。
fn form_batch_prefill(
    queue: &mut VecDeque<InferenceTask>,
    engine: &mut PoolEngine,
) -> Option<BatchPrefillGroup> {
    if !engine.use_batch_decode {
        return None;
    }
    let width = batch_prefill_width().min(engine.slot_count);
    if width < 2 {
        return None;
    }
    let candidates = queue
        .iter()
        .filter(|t| t.resume_state.is_none() && t.prefill_cursor == 0 && t.input_tokens.len() > 1)
        .count();
    if candidates < 2 {
        return None;
    }
    // 全是短 prompt 时并批不划算（见 `BATCH_PREFILL_MIN_TOKENS`）；长短混合时
    // 长 prompt 撑起整轮，短行按同一 pad_to 补齐的开销可以忽略。
    let max_len = queue
        .iter()
        .filter(|t| t.resume_state.is_none() && t.prefill_cursor == 0)
        .map(|t| t.input_tokens.len())
        .max()
        .unwrap_or(0);
    if max_len < BATCH_PREFILL_MIN_TOKENS {
        return None;
    }
    let mut chosen: Vec<InferenceTask> = Vec::with_capacity(width.min(candidates));
    let mut rest: VecDeque<InferenceTask> = VecDeque::with_capacity(queue.len());
    for t in queue.drain(..) {
        if chosen.len() < width
            && t.resume_state.is_none()
            && t.prefill_cursor == 0
            && t.input_tokens.len() > 1
        {
            chosen.push(t);
        } else {
            rest.push_back(t);
        }
    }
    *queue = rest;
    let n = chosen.len();
    let tasks: Vec<BatchPrefillTask> = chosen
        .into_iter()
        .map(|task| {
            // 会话缓存快照点：与串行路径同口径「prompt 末尾回退 K 个 token」。
            // 批量路径从整个输入的尾部回退（串行只从末块回退），最多早缓存几个
            // token——仍然是下一轮 prompt 的严格前缀，不影响命中。
            let to_feed = task.input_tokens.len() - 1;
            let back = SESSION_CACHE_BACKTRACK.min(to_feed);
            let cache_point = if task.session_id.is_some() && to_feed > back {
                Some(to_feed - back)
            } else {
                None
            };
            BatchPrefillTask {
                task,
                cursor: 0,
                cache_point,
            }
        })
        .collect();

    // 宽度变化时重建状态池；每次组批前清零（行 = 零态起步）。
    // 失败时把任务原样放回队首（FIFO 近似：它们是最早的 cache-miss 任务），
    // 绝不能吞掉任务——那会让调用方永远等不到 Done/Error。
    let restore = |queue: &mut VecDeque<InferenceTask>, tasks: Vec<BatchPrefillTask>| {
        for bt in tasks.into_iter().rev() {
            queue.push_front(bt.task);
        }
    };
    let need_new = engine
        .batch_prefill_states
        .as_ref()
        .is_none_or(|(w, _, _)| *w != n);
    if need_new {
        engine.batch_prefill_states = None;
        match (
            engine.model.create_batch_state(n),
            engine.model.create_batch_state(n),
        ) {
            (Ok(s), Ok(p)) => engine.batch_prefill_states = Some((n, s, p)),
            (r, _) => {
                if let Err(e) = r {
                    log::warn!("[rwkv] batch prefill state alloc failed: {e}");
                }
                restore(queue, tasks);
                return None;
            }
        }
    }
    let Some((_, state, _)) = engine.batch_prefill_states.as_ref() else {
        restore(queue, tasks);
        return None;
    };
    if let Err(e) = engine.model.reset_state_of(state) {
        log::warn!("[rwkv] batch prefill state reset failed: {e}");
        restore(queue, tasks);
        return None;
    }
    Some(BatchPrefillGroup {
        tasks,
        parked: vec![false; n],
        started_at: std::time::Instant::now(),
    })
}

/// 批量 prefill 推进一步（一轮）。返回 true = 所有行都已喂完（等待入组）。
///
/// 每轮对每行喂 ≤ `PREFILL_CHUNK` 个 token；喂到缓存快照点的行先把状态下载
/// 进会话缓存，喂完（`cursor == len-1`）的行把终态设备内拷到暂存态后停喂——
/// 之后该行只喂占位 token，不会污染真状态。
fn batch_prefill_step(
    group: &mut BatchPrefillGroup,
    engine: &mut PoolEngine,
) -> Result<bool, String> {
    let width = group.tasks.len();
    // ① 缓存快照 + 终态暂存（状态与游标一致：都在上一轮 forward 之后）
    let mut snapshots: Vec<(usize, usize, Vec<f32>)> = Vec::new();
    {
        let PoolEngine {
            model,
            batch_prefill_states,
            ..
        } = engine;
        let (w, state, parked_state) = batch_prefill_states
            .as_mut()
            .ok_or_else(|| "batch prefill: 状态池缺失".to_string())?;
        if *w != width {
            return Err(format!("batch prefill: 状态宽度 {w} != 任务数 {width}"));
        }
        for i in 0..width {
            let bt = &mut group.tasks[i];
            let to_feed = bt.task.input_tokens.len() - 1;
            if let Some(point) = bt.cache_point {
                if bt.cursor == point {
                    let row = model
                        .state_slot_back(state, i)
                        .map_err(|e| format!("batch prefill snapshot: {e}"))?;
                    snapshots.push((i, point, row));
                    bt.cache_point = None;
                }
            }
            if !group.parked[i] && bt.cursor >= to_feed {
                model
                    .state_rows_copy(parked_state, state, i, i, 1)
                    .map_err(|e| format!("batch prefill park row {i}: {e}"))?;
                group.parked[i] = true;
            }
        }
    }
    // ② 快照入会话缓存（借用块之外，避免与状态池借用冲突）
    for (i, point, st) in snapshots {
        let bt = &mut group.tasks[i];
        if let Some(sid) = bt.task.session_id.clone() {
            let mut tokens = bt.task.base_tokens.clone();
            tokens.extend_from_slice(&bt.task.input_tokens[..point]);
            cache_session_state(engine, sid, tokens, st);
        }
    }
    // ③ 组本轮块（停喂行给 1 个占位 token——`forward_seq_batch_chunk` 要求非空）
    let mut batch: Vec<Vec<u32>> = Vec::with_capacity(width);
    let mut any = false;
    for i in 0..width {
        let bt = &mut group.tasks[i];
        if group.parked[i] {
            batch.push(vec![0]);
            continue;
        }
        let to_feed = bt.task.input_tokens.len() - 1;
        let mut take = PREFILL_CHUNK.min(to_feed - bt.cursor);
        if let Some(point) = bt.cache_point {
            if bt.cursor < point {
                take = take.min(point - bt.cursor);
            }
        }
        if take == 0 {
            return Err(format!(
                "batch prefill: 行 {i} 无块可喂（游标 {}）",
                bt.cursor
            ));
        }
        batch.push(bt.task.input_tokens[bt.cursor..bt.cursor + take].to_vec());
        bt.cursor += take;
        any = true;
    }
    if !any {
        return Ok(true);
    }
    {
        let PoolEngine {
            model,
            batch_prefill_states,
            ..
        } = engine;
        let (_, state, _) = batch_prefill_states
            .as_mut()
            .ok_or_else(|| "batch prefill: 状态池缺失".to_string())?;
        model
            .forward_seq_batch_chunk(state, &batch, PREFILL_CHUNK)
            .map_err(|e| format!("batch prefill forward: {e}"))?;
    }
    Ok(false)
}

/// 批量 prefill 完成 → 行状态灌入解码组 dense 前缀的尾部。
///
/// 与串行 `join_decode_group` 的差异：首 token 不在主机采样，而是把**最后一个
/// prompt token** 留给解码组首步（`decode_step` 的批量采样核），状态消费序列
/// 与串行完全一致（prompt 全喂完，再逐个生成 token），只差一次批量采样的延迟。
fn join_batch_prefill(
    group: BatchPrefillGroup,
    engine: &mut PoolEngine,
    tasks: &mut [Option<InferenceTask>],
) {
    let width = group.tasks.len();
    let base = tasks.iter().take_while(|s| s.is_some()).count();
    if base + width > tasks.len() {
        let e = format!(
            "batch prefill join: 空闲行不足 {base}+{width} > {}",
            tasks.len()
        );
        for bt in group.tasks {
            let _ = bt.task.tx.send(InferenceEvent::Error(e.clone()));
        }
        return;
    }
    let mut next_row = base;
    for (k, bt) in group.tasks.into_iter().enumerate() {
        let copy: Result<(), String> = {
            let PoolEngine {
                model,
                decode_state,
                batch_prefill_states,
                ..
            } = engine;
            match batch_prefill_states.as_ref() {
                Some((_, state, parked_state)) => {
                    let src = if group.parked[k] { parked_state } else { state };
                    model
                        .state_rows_copy(decode_state, src, k, next_row, 1)
                        .map_err(|e| e.to_string())
                }
                None => Err("batch prefill join: 状态池缺失".to_string()),
            }
        };
        if let Err(e) = copy {
            log::error!("[rwkv] batch prefill join row {k}: {e}");
            let _ = bt.task.tx.send(InferenceEvent::Error(e));
            continue;
        }
        let mut task = bt.task;
        // 末 token 留给解码组首步：采样首 token 的同时推进状态。
        task.feed_token = *task.input_tokens.last().expect("组批保证非空");
        task.steps_done = 0;
        task.prefill_cursor = task.input_tokens.len();
        if let Err(e) = upload_hist_row(engine, next_row, &task) {
            let _ = task.tx.send(InferenceEvent::Error(e));
            continue;
        }
        tasks[next_row] = Some(task);
        next_row += 1;
    }
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

    // 转入解码组：状态迁入 row 行（兜底路径直接换 State，批量路径设备内拷贝）
    if engine.use_batch_decode {
        // 全程设备内拷贝（替代 state_back + state_slot_load 的 2×21.6MB PCIe 往返，
        // rwkv-rsv `examples/app_path_probe` 实测 35ms → ~1ms/请求）。
        engine
            .model
            .state_slot_from_state(&engine.decode_state, row, &engine.prefill_state)
            .map_err(|e| format!("state_slot_from_state failed: {}", e))?;
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

/// 任务收尾：发送 Done。
///
/// **不回写会话缓存**：缓存只保存「prefill 完成时的 prompt 前缀 + 状态」
/// （见 `prefill_step`），因为模型生成的 token 序列与「把生成文本重新编码」
/// 的结果在边界处不一定一致（实测同一文本命中不了），回写带生成 token 的
/// 前缀会让下一轮恰好在这里失配。只留 prompt 前缀则下一轮必然是它的超集，
/// 稳定命中。
/// `row` 仅用于保持签名兼容（当前不再读取状态）。
fn finalize_task(task: &mut InferenceTask, engine: &mut PoolEngine, _row: Option<usize>) {
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
        cached_tokens: task.cached_tokens,
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

#[allow(clippy::too_many_arguments)]
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

/// 本地直连推理记账（不经网关的 Tauri 命令 / 内部闭环路径）。
///
/// 网关与插件 AI 路径已经在各自出口记账，这里只覆盖直连 `pool_infer` 的调用，
/// 避免同一批 token 被计两次。生成类调用用引擎 `Done` 事件的真实计数；
/// 打分/分类等零生成调用用 [`estimate_prompt_tokens`] 仅计输入侧。
pub(crate) async fn record_local_usage(
    route: &str,
    model: &str,
    prompt_tokens: usize,
    completion_tokens: usize,
    latency_ms: u64,
) {
    if prompt_tokens == 0 && completion_tokens == 0 {
        return;
    }
    crate::api::ai_usage_api::record_usage(crate::api::ai_usage_api::AiUsageRecord {
        at: now_ms(),
        plugin_id: "rwkv-direct".to_string(),
        tag: None,
        model: model.to_string(),
        local: true,
        prompt_tokens: u32::try_from(prompt_tokens).unwrap_or(u32::MAX),
        completion_tokens: u32::try_from(completion_tokens).unwrap_or(u32::MAX),
        latency_ms,
        ttft_ms: None,
        tool_rounds: None,
        session_id: None,
        requested_model: None,
        route: Some(route.to_string()),
        fallback_reason: None,
        cached_prompt_tokens: None,
        usage_known: Some(true),
        request_id: None,
    })
    .await;
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
        cancel_epoch: cancel_epoch().load(Ordering::Relaxed),
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
    let started = std::time::Instant::now();
    let prompt_tokens = estimate_prompt_tokens(&request);
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
        Ok(Ok(Ok(result))) => {
            record_local_usage(
                "local-router-classify",
                "rwkv-router-mini",
                prompt_tokens,
                0,
                started.elapsed().as_millis() as u64,
            )
            .await;
            Ok(result)
        }
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(_)) => Err("classify reply channel closed".to_string()),
        Err(_) => Err("classify request timed out after 30s".to_string()),
    }
}

/// 候选打分（Jev 式：单次前向、零生成 token）：对 `choices` 逐个算平均 NLL，
/// 返回**升序**表（`rank=0` 最优）。与 `/v1/chat/completions` 不同，`prompt` 原样
/// 分词、不经模板渲染（口径见 [`crate::rwkv_choose`]）。
///
/// 走主引擎：未加载即 Err（上游自行回落生成）。30s 超时与 [`rwkv_classify`] 同一条。
pub async fn rwkv_choose(
    prompt: String,
    choices: Vec<String>,
    calibrate: bool,
) -> Result<Vec<ChoiceScore>, String> {
    let started = std::time::Instant::now();
    // 零生成打分：token 用量 = prompt 原样分词 + 每个候选的 NLL 打分文本
    let prompt_tokens = estimate_prompt_tokens(&prompt)
        + choices
            .iter()
            .map(|c| estimate_prompt_tokens(c))
            .sum::<usize>();
    let pool = get_inference_pool().ok_or("inference pool not started")?;
    let (reply_tx, reply_rx) = oneshot::channel::<Result<Vec<ChoiceScore>, String>>();
    pool.tx
        .send(PoolRequest::Choose {
            prompt,
            choices,
            calibrate,
            reply: reply_tx,
        })
        .map_err(|e| format!("failed to send choose request: {}", e))?;
    match tokio::time::timeout(Duration::from_secs(30), reply_rx).await {
        Ok(Ok(Ok(result))) => {
            record_local_usage(
                "local-router-choose",
                "rwkv-local",
                prompt_tokens,
                0,
                started.elapsed().as_millis() as u64,
            )
            .await;
            Ok(result)
        }
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(_)) => Err("choose reply channel closed".to_string()),
        Err(_) => Err("choose request timed out after 30s".to_string()),
    }
}

/// Tauri 侧的响应包装：`ChoiceScore` 是打分内核的中性类型，前端/HTTP 只需要这四个字段
/// （与 mytown `/v1/chooses` 的 `data` 行同形）。
#[derive(Debug, Clone, Serialize)]
pub struct RwkvChoice {
    pub index: usize,
    pub rank: usize,
    pub choice: String,
    pub perplexity: f32,
}

impl From<&ChoiceScore> for RwkvChoice {
    fn from(r: &ChoiceScore) -> Self {
        Self {
            index: r.index,
            rank: r.rank,
            choice: r.choice.clone(),
            perplexity: r.perplexity,
        }
    }
}

/// 候选打分的前端入口（打分是本地能力，远端 provider 不参与）。
#[tauri::command]
pub async fn rwkv_choose_cmd(
    prompt: String,
    choices: Vec<String>,
    calibrate: Option<bool>,
) -> Result<Vec<RwkvChoice>, String> {
    let rows = rwkv_choose(prompt, choices, calibrate.unwrap_or(false)).await?;
    Ok(rows.iter().map(RwkvChoice::from).collect())
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

/// 解析 safetensors 文件头（前 8 字节 u64 长度 + JSON），判断是否为量化权重
/// （量化张量键含 ".int8_idx" 后缀，存储在 .st 文件内部）。
///
/// 注：int6 文件的 head 恒为 int8，因此也会命中；该字段只表示“已量化”，
/// 不区分位宽（加载端按文件内键自动分派）。
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
/// 就绪判定基于实际扫描（list_rwkv_models）：3B 默认 int6，其余档位 int8，
/// 按文件大小区间匹配档位（int6 ≈ 0.78–0.81 字节/参数，int8 ≈ 1 字节/参数；
/// 兼容 bundled bf16 大文件）。
#[derive(Debug, Clone, Serialize)]
pub struct BuiltinRwkvEntry {
    pub key: String,
    pub display: String,
    /// models/ 下相对保存路径（download_model 的 url 字段语义）。
    pub file_rel: String,
    /// 近似大小（当前部署量化体积，3B=int6、其余=int8）。
    pub size_bytes: u64,
    /// 就绪 = 扫描到匹配档位的本地模型（返回可用路径）。
    pub downloaded: bool,
    /// 就绪时可直接使用的模型路径（激活时传给 init_llm_engine 热切换）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_model_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_vocab_path: Option<String>,
    /// 必需档位：启动期自动下载，作为本地协同（智能路由/工具轮）的默认模型。
    pub required: bool,
    /// 仓库是否已上架权重（false = 仅占位展示，不能下载）。
    pub available: bool,
}

/// 3B 档位当前权重文件名（换版本或换量化位宽只改这一行；目录固定为 models/rwkv/）。
///
/// 命名约定：`rwkv-3B-<generation>-<tag>-int<bits>.st`
/// （当前默认 g1m 预览版 int8 = `rwkv-3B-g1m-pre-int8.st`；int6 小体积件 = `...-int6.st`，不默认）。
/// 档位 key（`rwkv-3b`）保持不变，前端/路由/网关无需随版本或位宽改动。
pub const RWKV_3B_MODEL_FILE: &str = "rwkv-3B-g1m-pre-int8.st";

#[derive(Debug, Clone)]
struct BuiltinRwkvModel {
    key: &'static str,
    display: &'static str,
    /// models/rwkv/ 下 .st 文件名（与统一仓库布局一致，落盘即被 list_rwkv_models 扫描到）。
    file: &'static str,
    /// models/ 下 vocab 相对保存路径（7.2B 有独立 vocab 子目录，其余共用顶层 vocab.json）。
    vocab_rel: &'static str,
    /// 部署量化近似字节数（3B 当前为 int8，其余档位 int8）。
    size_bytes: u64,
    /// 就绪匹配区间（字节）：按当前部署量化体积紧凑匹配。
    min_bytes: u64,
    max_bytes: u64,
    /// 必需档位（启动期自动下载）；其余为可选档位，只在模型选择器里按需下载。
    required: bool,
    /// 权重是否已上架仓库（13B 尚未上传，仅占位）。
    available: bool,
}

impl BuiltinRwkvModel {
    /// models/ 下相对保存路径（下载 url 字段与 UI `file_rel` 的语义）。
    fn st_rel(&self) -> String {
        format!("rwkv/{}", self.file)
    }
}

const BUILTIN_RWKV: &[BuiltinRwkvModel] = &[
    BuiltinRwkvModel {
        key: "rwkv-3b",
        display: "RWKV 3B",
        // g1m 3b（temp-6056，ctx65536）int8；版本名只由 RWKV_3B_MODEL_FILE 决定。
        file: RWKV_3B_MODEL_FILE,
        vocab_rel: "rwkv/vocab.json",
        size_bytes: 3_295_783_296,
        // 区间只覆盖 int8 体积：同目录的 int6 小体积件（2,666,658,289 B）不会被判成就绪。
        min_bytes: 3_000_000_000,
        max_bytes: 3_500_000_000,
        required: true,
        available: true,
    },
    // 可选档位：不在启动期自动下载，用户可在模型选择器「本地模型」里按需下载。
    // 下载后不会自动改变引擎默认模型（scan_model_file 恒优先必需档位）。
    BuiltinRwkvModel {
        key: "rwkv-7b",
        display: "RWKV 7B",
        file: "rwkv7-7B-int8.st",
        vocab_rel: "rwkv/vocab.json",
        size_bytes: 7_898_815_456,
        min_bytes: 7_000_000_000,
        max_bytes: 9_000_000_000,
        required: false,
        available: true,
    },
    // 13B 权重尚未上传统一仓库：保留目录占位，UI 显示「暂未提供」，不提供下载。
    BuiltinRwkvModel {
        key: "rwkv-13b",
        display: "RWKV 13B",
        file: "rwkv7-13B-int8.st",
        vocab_rel: "rwkv/vocab.json",
        size_bytes: 0,
        min_bytes: 12_000_000_000,
        max_bytes: 16_000_000_000,
        required: false,
        available: false,
    },
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

/// 内置 RWKV 下载目录（就绪判定：先按精确文件名命中，未命中再回退体积区间）。
#[tauri::command]
pub fn rwkv_builtin_catalog() -> Vec<BuiltinRwkvEntry> {
    let scanned = list_rwkv_models();
    BUILTIN_RWKV
        .iter()
        .map(|m| {
            // 精确文件名优先：目录里可能保留旧版 3B，仅按体积会把旧文件误判为当前档位。
            let hit = scanned
                .iter()
                .find(|info| {
                    Path::new(&info.model_path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|name| name.eq_ignore_ascii_case(m.file))
                })
                .or_else(|| {
                    scanned.iter().find(|info| {
                        info.size_bytes >= m.min_bytes && info.size_bytes < m.max_bytes
                    })
                });
            BuiltinRwkvEntry {
                key: m.key.to_string(),
                display: m.display.to_string(),
                file_rel: m.st_rel(),
                size_bytes: m.size_bytes,
                downloaded: hit.is_some(),
                resolved_model_path: hit.map(|h| h.model_path.clone()),
                resolved_vocab_path: hit.map(|h| h.vocab_path.clone()),
                required: m.required,
                available: m.available,
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
    if !entry.available {
        return Err(format!(
            "{} is not available for download yet",
            entry.display
        ));
    }
    let models_dir = crate::runtime::get_models_dir();
    let mut task_ids = Vec::new();

    let st_rel = entry.st_rel();
    let (st_primary, st_hosts) = rwkv_builtin_urls(&st_rel);
    let st_info = crate::model_checker::ModelUpdateInfo {
        component: "llm-rwkv".to_string(),
        name: entry.key.to_string(),
        key: entry.key.to_string(),
        url: st_rel,
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

/// 扫描模型目录，返回默认 RWKV 模型文件（跳过路由小模型）。
///
/// 优先必需档位（3B）：可选档位（7B/13B）下载后不得悄悄改变本地协同模型的
/// 实际加载文件（否则同一台机器行为随下载历史漂移）。
fn scan_model_file() -> Option<String> {
    let models_dir = assets_models_dir();
    for builtin in BUILTIN_RWKV.iter().filter(|m| m.required) {
        let path = models_dir.join(builtin.file);
        if path.is_file() {
            return Some(path.to_string_lossy().into_owned());
        }
    }
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
    let started = std::time::Instant::now();
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
        Ok(Ok(result)) => {
            record_local_usage(
                "local-direct-chat",
                "rwkv-local",
                result.input_token_count,
                result.output_token_count,
                started.elapsed().as_millis() as u64,
            )
            .await;
            Ok(result)
        }
        Ok(Err(e)) => Err(e),
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

    let model_name = model_text
        .clone()
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "rwkv-local".to_string());
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
    let mut input_tokens = 0usize;
    let mut output_tokens = 0usize;
    let started = std::time::Instant::now();
    while let Some(event) = rx.recv().await {
        match event {
            InferenceEvent::Token(t) => {
                emit_to_overlay(&app, "rwkv://token", t.clone());
                text.push_str(&t);
            }
            InferenceEvent::Done {
                text: t,
                input_tokens: it,
                output_tokens: ot,
                stop_sequence,
                ..
            } => {
                text = t;
                input_tokens = it;
                output_tokens = ot;
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
    record_local_usage(
        "local-direct-stream",
        &model_name,
        input_tokens,
        output_tokens,
        started.elapsed().as_millis() as u64,
    )
    .await;
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
