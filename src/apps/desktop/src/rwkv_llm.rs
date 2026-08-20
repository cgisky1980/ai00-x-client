//! RWKV 推理核心（rwkv-rsv 引擎：Vulkan/CUDA 后端）。
//!
//! 架构：模型与全部推理状态由专用 OS 线程持有（rwkv-rsv 为同步 API 且
//! `GpuModel` 非 Send），上层（Tauri 命令 / ai-adapters / memory sidecar）
//! 通过 channel 提交任务，事件经 `InferenceEvent` 回流，接口与旧 web-rwkv
//! 实现完全兼容。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

use rwkv_rsv::gpu_model::{Bundle, GpuModel, ModelBuilder, State};
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

enum TaskPhase {
    Prefill,
    Decode,
}

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

struct InferenceTask {
    phase: TaskPhase,
    prompt_tokens: Vec<u32>,
    input_tokens: Vec<u32>,
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
    last_logits: Vec<f32>,
    acc_ids: Vec<u32>,
    token_counts: HashMap<u32, i32>,
    loaded_from_cache: bool,
    dedup_backtrack: usize,
    stop_buffer: String,
    last_decoded_len: usize,
    steps_done: usize,
    ended_by_stop: bool,
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
        app: tauri::AppHandle,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Submit(InferenceTaskParams),
    ClearSession(String),
}

struct InferencePoolHandle {
    tx: mpsc::UnboundedSender<PoolRequest>,
}

static INFERENCE_POOL: OnceLock<InferencePoolHandle> = OnceLock::new();
static LLM_READY: AtomicBool = AtomicBool::new(false);
static CANCEL_EPOCH: OnceLock<AtomicU64> = OnceLock::new();
static LLM_INITING: OnceLock<Mutex<bool>> = OnceLock::new();

fn get_inference_pool() -> Option<&'static InferencePoolHandle> {
    INFERENCE_POOL.get()
}

pub fn is_llm_initialized() -> bool {
    LLM_READY.load(Ordering::SeqCst)
}

/// 推理引擎全部状态（仅 pool 线程访问，无锁）。
struct PoolEngine {
    model: GpuModel,
    /// 每槽一个独立 RNN 状态，支持多任务并发交错推进。
    slot_states: Vec<State>,
    tokenizer: Tokenizer,
    /// 零初始状态缓存（新任务/无缓存任务重置槽位用）。
    initial_state: Vec<f32>,
    /// session_id → (已缓存 token 序列, RNN 状态)
    session_states: HashMap<String, (Vec<u32>, Vec<f32>)>,
}

/// pool 线程主循环：常驻，Init 消息触发（重）加载，Submit/ClearSession 业务消息。
fn inference_pool_main(pool_rx: mpsc::UnboundedReceiver<PoolRequest>) {
    let mut pool_rx = pool_rx;
    let mut engine: Option<PoolEngine> = None;
    let mut slots: Vec<Option<InferenceTask>> = (0..MAX_SLOTS).map(|_| None).collect();
    let mut pending: Vec<InferenceTaskParams> = Vec::new();

    loop {
        // 引擎未加载或完全空闲 → 阻塞等待消息；否则非阻塞抽干消息
        let idle = engine.is_some() && slots.iter().all(|s| s.is_none()) && pending.is_empty();
        if idle {
            match pool_rx.blocking_recv() {
                Some(req) => {
                    if !handle_request(req, &mut engine, &mut pending) {
                        break;
                    }
                }
                None => break,
            }
        } else {
            while let Ok(req) = pool_rx.try_recv() {
                if !handle_request(req, &mut engine, &mut pending) {
                    return;
                }
            }
        }

        // 引擎未就绪时（Init 失败/尚未 Init），无任务可推进
        let Some(engine) = engine.as_mut() else {
            continue;
        };

        // 调度 pending → 空闲槽位
        while !pending.is_empty() {
            let Some(slot_idx) = slots.iter().position(|s| s.is_none()) else {
                break;
            };
            let params = pending.remove(0);
            let tx = params.tx.clone();
            match prepare_task(params, slot_idx, engine) {
                Ok(task) => slots[slot_idx] = Some(task),
                Err(e) => {
                    let _ = tx.send(InferenceEvent::Error(e));
                }
            }
        }

        // 每个活跃任务推进一步（prefill 一块 / decode 一个 token）
        for (slot_idx, slot) in slots.iter_mut().enumerate() {
            if slot.is_none() {
                continue;
            }
            let task = slot.as_mut().expect("checked non-empty");
            match advance_task(task, engine, slot_idx) {
                Ok(true) => {}
                Ok(false) => *slot = None,
                Err(e) => {
                    log::error!("[rwkv] task error: {}", e);
                    let _ = task.tx.send(InferenceEvent::Error(e));
                    *slot = None;
                }
            }
        }
    }

    LLM_READY.store(false, Ordering::SeqCst);
    log::info!("[rwkv] inference pool thread exited");
}

/// 处理一条请求。返回 false 表示线程应退出（channel 关闭或 Shutdown）。
fn handle_request(
    req: PoolRequest,
    engine: &mut Option<PoolEngine>,
    pending: &mut Vec<InferenceTaskParams>,
) -> bool {
    match req {
        PoolRequest::Init {
            model_path,
            vocab_path,
            app,
            reply,
        } => {
            if engine.is_some() {
                LLM_READY.store(true, Ordering::SeqCst);
                let _ = reply.send(Ok(()));
                return true;
            }
            let _ = app.emit("rwkv://debug", "llm loading model".to_string());
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                load_engine(&model_path, &vocab_path)
            }));
            match result {
                Ok(Ok(e)) => {
                    *engine = Some(e);
                    LLM_READY.store(true, Ordering::SeqCst);
                    let _ = app.emit("rwkv://debug", "llm initialized".to_string());
                    let _ = reply.send(Ok(()));
                }
                Ok(Err(e)) => {
                    let _ = app.emit("rwkv://debug", format!("llm init failed: {}", e));
                    let _ = reply.send(Err(e));
                }
                Err(panic) => {
                    let msg = format!("llm init panicked: {:?}", panic);
                    log::error!("[rwkv] {}", msg);
                    let _ = app.emit("rwkv://debug", msg.clone());
                    let _ = reply.send(Err(msg));
                }
            }
            true
        }
        PoolRequest::Submit(params) => {
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
    }
}

/// 加载模型并创建 16 槽推理状态。
fn load_engine(model_path: &str, vocab_path: &str) -> Result<PoolEngine, String> {
    log::info!("[rwkv] loading model: {}", model_path);
    let bundle: Bundle = ModelBuilder::new(model_path)
        .build()
        .map_err(|e| format!("failed to load model '{}': {}", model_path, e))?;
    let Bundle { mut model, state } = bundle;

    let mut slot_states = Vec::with_capacity(MAX_SLOTS);
    slot_states.push(state);
    for _ in 1..MAX_SLOTS {
        slot_states.push(
            model
                .create_state()
                .map_err(|e| format!("failed to create slot state: {}", e))?,
        );
    }

    let vocab = std::fs::read_to_string(vocab_path)
        .map_err(|e| format!("failed to read vocab '{}': {}", vocab_path, e))?;
    let tokenizer = Tokenizer::new(&vocab).map_err(|e| format!("failed to parse vocab: {}", e))?;

    let initial_state = model
        .state_back(&slot_states[0])
        .map_err(|e| format!("failed to snapshot initial state: {}", e))?;

    let info = model.info();
    log::info!(
        "[rwkv] model loaded: layers={} emb={} vocab={} ({} slots)",
        info.num_layer,
        info.num_emb,
        info.num_vocab,
        MAX_SLOTS
    );

    Ok(PoolEngine {
        model,
        slot_states,
        tokenizer,
        initial_state,
        session_states: HashMap::new(),
    })
}

/// 组装任务：prompt 清洗/编码、会话状态恢复（含前缀去重）、惩罚状态初始化。
fn prepare_task(
    params: InferenceTaskParams,
    slot: usize,
    engine: &mut PoolEngine,
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
    let mut loaded_from_cache = false;
    let mut dedup_backtrack = 0usize;

    if let Some(sid) = &params.session_id {
        let cached = engine.session_states.get(sid).cloned();
        if let Some((cached_tokens, cached_state)) = cached {
            if engine
                .model
                .state_load(&engine.slot_states[slot], &cached_state)
                .is_ok()
            {
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

                loaded_from_cache = true;
            }
        }
    }

    if !loaded_from_cache {
        // 重置槽位为零初始状态
        engine
            .model
            .state_load(&engine.slot_states[slot], &engine.initial_state)
            .map_err(|e| format!("failed to reset state: {}", e))?;
    }

    if input_tokens.is_empty() {
        input_tokens = vec![0u32];
    }

    // Initialize penalty state from model_text (prior Assistant message contents).
    // This aligns with ai00-server's NucleusSampler which uses model_text to seed
    // presence_penalty and frequency_penalty memory. Without this, penalties are
    // completely ineffective on the first generated token.
    let token_counts = if !params.model_text.is_empty() {
        match engine.tokenizer.encode(params.model_text.as_bytes()) {
            Ok(tokens) => {
                let mut counts: HashMap<u32, i32> = HashMap::new();
                for &id in &tokens {
                    *counts.entry(id).or_insert(0) += 1;
                }
                counts
            }
            Err(_) => HashMap::new(),
        }
    } else {
        HashMap::new()
    };

    Ok(InferenceTask {
        phase: TaskPhase::Prefill,
        prompt_tokens,
        input_tokens,
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
        last_logits: Vec::new(),
        acc_ids: Vec::new(),
        token_counts,
        loaded_from_cache,
        dedup_backtrack,
        stop_buffer: String::new(),
        last_decoded_len: 0,
        steps_done: 0,
        ended_by_stop: false,
    })
}

/// 推进一个任务一步。返回 Ok(false) 表示任务完成（槽位释放）。
fn advance_task(
    task: &mut InferenceTask,
    engine: &mut PoolEngine,
    slot: usize,
) -> Result<bool, String> {
    match task.phase {
        TaskPhase::Prefill => {
            // 分块 sequence-parallel prefill
            let mut logits = Vec::new();
            for chunk in task.input_tokens.chunks(PREFILL_CHUNK) {
                logits = engine
                    .model
                    .forward_seq_with_state(&mut engine.slot_states[slot], chunk)
                    .map_err(|e| format!("prefill failed: {}", e))?;
            }
            task.phase = TaskPhase::Decode;
            task.last_logits = logits;

            // prefill 完成后缓存会话状态（下次续聊免全量 prefill）
            if let Some(sid) = &task.session_id {
                let current_state = engine
                    .model
                    .state_back(&engine.slot_states[slot])
                    .map_err(|e| format!("state_back failed: {}", e))?;
                let mut new_cached_tokens = task.prompt_tokens.clone();
                if task.loaded_from_cache {
                    if let Some((old_tokens, _)) = engine.session_states.get(sid) {
                        let new_len = old_tokens.len().saturating_sub(task.dedup_backtrack);
                        let mut full = old_tokens[..new_len].to_vec();
                        full.extend(task.input_tokens.clone());
                        new_cached_tokens = full;
                    }
                }
                engine
                    .session_states
                    .insert(sid.clone(), (new_cached_tokens, current_state));
            }
            Ok(true)
        }
        TaskPhase::Decode => {
            let tokens = if task.last_logits.is_empty() {
                // 边缘回退：prefill 未产出 logits 时重推输入（保持旧实现行为）
                task.input_tokens.clone()
            } else {
                let id = sample_token(
                    &task.last_logits,
                    task.top_p,
                    task.top_k,
                    &task.token_counts,
                    task.presence_penalty,
                    task.frequency_penalty,
                    task.penalty_decay,
                );
                task.acc_ids.push(id);
                *task.token_counts.entry(id).or_insert(0) += 1;
                vec![id]
            };

            let logits = engine
                .model
                .forward_with_state(&mut engine.slot_states[slot], &tokens)
                .map_err(|e| format!("decode failed: {}", e))?;
            task.last_logits = logits;

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

            let mut hit_stop_seq: Option<String> = None;
            if let Some(ref ss) = task.stop {
                for stop_str in ss {
                    if !stop_str.is_empty() && task.stop_buffer.ends_with(stop_str) {
                        task.ended_by_stop = true;
                        hit_stop_seq = Some(stop_str.clone());
                        break;
                    }
                }
            }

            task.steps_done += 1;

            if task.is_streaming {
                if let Ok(decoded) = engine.tokenizer.decode(&task.acc_ids) {
                    let s = String::from_utf8_lossy(&decoded);
                    let new = &s[task.last_decoded_len..];
                    if !new.is_empty() {
                        let _ = task.tx.send(InferenceEvent::Token(new.to_string()));
                    }
                    task.last_decoded_len = s.len();
                }
            }

            if task.ended_by_stop || task.steps_done >= task.max_tokens {
                let mut text = if let Ok(decoded) = engine.tokenizer.decode(&task.acc_ids) {
                    String::from_utf8_lossy(&decoded).to_string()
                } else {
                    String::new()
                };

                if let Some(ref seq) = hit_stop_seq {
                    if let Some(pos) = text.rfind(seq) {
                        text.truncate(pos);
                    }
                }

                let _ = task.tx.send(InferenceEvent::Done {
                    text,
                    input_tokens: task.prompt_tokens.len(),
                    output_tokens: task.acc_ids.len(),
                    stop_sequence: hit_stop_seq,
                });

                // 任务完成时把最终状态写回会话缓存
                if let Some(sid) = &task.session_id {
                    let current_state = engine
                        .model
                        .state_back(&engine.slot_states[slot])
                        .map_err(|e| format!("state_back failed: {}", e))?;
                    let mut base_tokens = task.prompt_tokens.clone();
                    if task.loaded_from_cache {
                        if let Some((prev_cached_tokens, _)) = engine.session_states.get(sid) {
                            let new_len = prev_cached_tokens
                                .len()
                                .saturating_sub(task.dedup_backtrack);
                            let mut full = prev_cached_tokens[..new_len].to_vec();
                            full.extend_from_slice(&task.input_tokens);
                            base_tokens = full;
                        }
                    }
                    let mut full_tokens = base_tokens;
                    full_tokens.extend_from_slice(&task.acc_ids);
                    engine
                        .session_states
                        .insert(sid.clone(), (full_tokens, current_state));
                }

                return Ok(false);
            }
            Ok(true)
        }
    }
}

fn sample_token(
    logits: &[f32],
    top_p: f32,
    top_k: usize,
    token_counts: &HashMap<u32, i32>,
    presence_penalty: f32,
    frequency_penalty: f32,
    penalty_decay: f32,
) -> u32 {
    let mut logits = logits.to_vec();
    for (&id, &count) in token_counts {
        if (id as usize) < logits.len() {
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
    let r = fastrand::f64() as f32 * cumsum.min(1.0);
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
    if !LLM_READY.load(Ordering::SeqCst) {
        return Err("LLM engine not initialized".to_string());
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

/// Lightweight inference for sidecar tasks (relevance check, extraction).
/// Uses low temperature + top_k=10 for deterministic but slightly diverse output.
/// Shares the same engine with VRM chat (16 interleaved slots).
pub async fn rwkv_infer_sync(
    prompt: &str,
    max_tokens: usize,
) -> Result<(String, usize, usize), String> {
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let mut rx = pool_infer(
            prompt.to_string(),
            max_tokens,
            0.95,
            10,
            0.0,
            0.0,
            0.99654026,
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
        Ok((text, input_tokens, output_tokens))
    })
    .await;
    match result {
        Ok(inner) => inner,
        Err(_elapsed) => Err("RWKV inference timed out after 30s".to_string()),
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

/// 扫描模型目录，返回第一个 .st / .safetensors 模型文件。
fn scan_model_file() -> Option<String> {
    let models_dir = assets_models_dir();
    let entries = std::fs::read_dir(&models_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            // rwkv-rsv 仅支持 safetensors 格式（.st 为 RWKV 惯用扩展名）
            if ext.eq_ignore_ascii_case("st") || ext.eq_ignore_ascii_case("safetensors") {
                return Some(path.to_string_lossy().into_owned());
            }
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
    if LLM_READY.load(Ordering::SeqCst) {
        let _ = app.emit("rwkv://debug", "llm initialized".to_string());
        crate::model_init::LLM_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
        return Ok(true);
    }
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
                let _ = app.emit("rwkv://debug", "llm initialized".to_string());
                crate::model_init::LLM_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
                return Ok(true);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        return Err("initialization in progress".to_string());
    }
    struct ResetFlagOnDrop(tauri::AppHandle);
    impl Drop for ResetFlagOnDrop {
        fn drop(&mut self) {
            if let Some(flag) = LLM_INITING.get() {
                if let Ok(mut f) = flag.lock() {
                    *f = false;
                }
            }
            let _ = self
                .0
                .emit("rwkv://debug", "llm init flag reset".to_string());
        }
    }
    let _reset = ResetFlagOnDrop(app.clone());

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
    let _ = app.emit("rwkv://debug", format!("init model={} vocab={}", mp, vp));
    debug_print!("rwkv_init: model_path={} vocab_path={}", mp, vp);
    if !Path::new(&mp).exists() {
        let _ = app.emit("rwkv://debug", "model missing, skip init".to_string());
        return Err("model file missing".to_string());
    }
    let _ = app.emit("rwkv://debug", "llm initializing".to_string());

    // 确保 pool 线程已启动（常驻，加载由 Init 消息触发）
    let pool = INFERENCE_POOL.get_or_init(|| {
        let (pool_tx, pool_rx) = mpsc::unbounded_channel::<PoolRequest>();
        std::thread::Builder::new()
            .name("rwkv-inference-pool".to_string())
            .spawn(move || inference_pool_main(pool_rx))
            .expect("failed to spawn rwkv inference pool thread");
        InferencePoolHandle { tx: pool_tx }
    });

    let (reply_tx, reply_rx) = oneshot::channel::<Result<(), String>>();
    pool.tx
        .send(PoolRequest::Init {
            model_path: mp,
            vocab_path: vp,
            app: app.clone(),
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
