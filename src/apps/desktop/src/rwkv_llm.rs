use cbor4ii::{core::utils::SliceReader, serde::Deserializer};

const DEBUG_LOG_LLM: bool = false;
macro_rules! debug_print {
    ($($arg:tt)*) => {
        if DEBUG_LOG_LLM {
            println!($($arg)*);
        }
    };
}

use memmap2::Mmap;
use serde::de::DeserializeSeed;
use serde::{Deserialize, Serialize};
use serde_json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{Emitter, Manager};
use web_rwkv::{
    context::{Context, ContextBuilder, InstanceExt},
    runtime::{
        infer::{Rnn, RnnInput, RnnInputBatch, RnnOption},
        loader::{Loader, Reader},
        model::{Bundle, ContextAutoLimits, ModelBuilder, ModelInfo, ModelVersion, Quant, State},
        v7, Runtime, TokioRuntime,
    },
    tensor::{serialization::Seed, TensorCpu},
    tokenizer::Tokenizer,
    wgpu::{Instance, PowerPreference},
};

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, RwLock};

type SessionStateEntry = (Vec<u32>, TensorCpu<f32>);
type SessionStates = Arc<RwLock<HashMap<String, SessionStateEntry>>>;

const MAX_SLOTS: usize = 16;

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

#[allow(dead_code)]
struct InferenceTask {
    slot: usize,
    phase: TaskPhase,
    prompt_tokens: Vec<u32>,
    input_tokens: Vec<u32>,
    state_path: Option<String>,
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

enum PoolRequest {
    Submit(InferenceTaskParams),
    #[allow(dead_code)]
    Shutdown,
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
    state_path: Option<String>,
    session_id: Option<String>,
    is_streaming: bool,
    is_vrm: bool,
    /// Prior Assistant message contents (joined by \n\n) to initialize penalty state.
    /// Without this, presence_penalty and frequency_penalty have no memory and are ineffective.
    model_text: String,
    tx: mpsc::UnboundedSender<InferenceEvent>,
}

struct InferencePoolHandle {
    tx: mpsc::UnboundedSender<PoolRequest>,
}

static INFERENCE_POOL: OnceLock<InferencePoolHandle> = OnceLock::new();

fn get_inference_pool() -> Option<&'static InferencePoolHandle> {
    INFERENCE_POOL.get()
}

fn start_inference_pool() {
    let (pool_tx, pool_rx) = mpsc::unbounded_channel::<PoolRequest>();

    let g = LLM
        .get()
        .expect("LLM must be initialized before starting pool");
    let binding = g.lock().expect("LLM lock not poisoned");
    let s = binding.as_ref().expect("LlmState present");
    let runtime = s.runtime.clone();
    let state = s.state.clone();
    let tokenizer = s.tokenizer.clone();
    let states = s.states.clone();
    let session_states = s.session_states.clone();
    let context = s.context.clone();
    let info = s.info.clone();

    tokio::spawn(inference_pool_loop(
        pool_rx,
        runtime,
        state,
        tokenizer,
        states,
        session_states,
        context,
        info,
    ));

    let _ = INFERENCE_POOL.set(InferencePoolHandle { tx: pool_tx });
}

#[allow(clippy::too_many_arguments)]
async fn inference_pool_loop(
    mut pool_rx: mpsc::UnboundedReceiver<PoolRequest>,
    runtime: Arc<dyn Runtime<Rnn> + Send + Sync>,
    state: Arc<dyn State + Send + Sync>,
    tokenizer: Arc<Tokenizer>,
    states: Arc<RwLock<HashMap<String, TensorCpu<f32>>>>,
    session_states: SessionStates,
    context: Context,
    info: ModelInfo,
) {
    let mut slots: Vec<Option<InferenceTask>> = (0..MAX_SLOTS).map(|_| None).collect();
    let mut pending_queue: Vec<InferenceTaskParams> = Vec::new();

    loop {
        tokio::select! {
            req = pool_rx.recv() => {
                match req {
                    Some(PoolRequest::Submit(params)) => {
                        pending_queue.push(params);
                    }
                    Some(PoolRequest::Shutdown) | None => {
                        return;
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(20)), if !pending_queue.is_empty() || slots.iter().any(|s| s.is_some()) => {}
        }

        while !pending_queue.is_empty() {
            let free_slot = slots.iter().position(|s| s.is_none());
            if free_slot.is_none() {
                break;
            }
            let slot_idx = free_slot.unwrap();
            let params = pending_queue.remove(0);
            let tx = params.tx.clone();
            let task = prepare_task(
                params,
                slot_idx,
                &state,
                &tokenizer,
                &states,
                &session_states,
                &context,
                &info,
            )
            .await;
            match task {
                Ok(t) => {
                    slots[slot_idx] = Some(t);
                }
                Err(e) => {
                    let _ = tx.send(InferenceEvent::Error(e));
                }
            }
        }

        let active_count = slots.iter().filter(|s| s.is_some()).count();
        if active_count == 0 && pending_queue.is_empty() {
            continue;
        }

        let mut batches = vec![RnnInputBatch::default(); MAX_SLOTS];
        let mut has_active = false;

        for (i, slot) in slots.iter_mut().enumerate() {
            if let Some(task) = slot {
                let mut tokens = match task.phase {
                    TaskPhase::Prefill => task.input_tokens.clone(),
                    TaskPhase::Decode => {
                        if task.last_logits.is_empty() {
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
                        }
                    }
                };
                if tokens.is_empty() {
                    tokens = vec![0u32];
                }
                batches[i] = RnnInputBatch::new(tokens, RnnOption::Last);
                has_active = true;
            }
        }

        if !has_active {
            continue;
        }

        let mut input = RnnInput::new(batches, 128);

        loop {
            if input.num_token() == 0 {
                break;
            }

            let result = std::panic::AssertUnwindSafe(runtime.infer(input)).await;
            let (remaining, output) = match result {
                Ok(r) => r,
                Err(e) => {
                    log::error!("RWKV inference error: {:?}", e);
                    for slot in slots.iter_mut() {
                        if let Some(task) = slot.take() {
                            let _ = task.tx.send(InferenceEvent::Error(e.to_string()));
                        }
                    }
                    return;
                }
            };
            input = remaining;

            if input.num_token() > 0 {
                continue;
            }

            for (batch_idx, slot) in slots.iter_mut().enumerate() {
                if let Some(task) = slot {
                    if batch_idx < output.len() && output[batch_idx].0.size() > 0 {
                        let logits = output[batch_idx].0.clone().to_vec();
                        match task.phase {
                            TaskPhase::Prefill => {
                                task.phase = TaskPhase::Decode;
                                task.last_logits = logits;

                                if let Some(sid) = &task.session_id {
                                    if let Ok(current_state) = state.back(task.slot).await {
                                        let mut new_cached_tokens = task.prompt_tokens.clone();
                                        if task.loaded_from_cache {
                                            if let Some((old_tokens, _)) =
                                                session_states.read().await.get(sid)
                                            {
                                                let new_len = old_tokens
                                                    .len()
                                                    .saturating_sub(task.dedup_backtrack);
                                                let mut full = old_tokens[..new_len].to_vec();
                                                full.extend(task.input_tokens.clone());
                                                new_cached_tokens = full;
                                            }
                                        }
                                        session_states.write().await.insert(
                                            sid.clone(),
                                            (new_cached_tokens, current_state),
                                        );
                                    }
                                }
                            }
                            TaskPhase::Decode => {
                                task.last_logits = logits;

                                let last_id = task.acc_ids.last().copied().unwrap_or(0);
                                let decoded = tokenizer.decode(&[last_id]).unwrap_or_default();
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

                                let mut stopped = false;
                                let mut hit_stop_seq: Option<String> = None;
                                if let Some(ref ss) = task.stop {
                                    for stop_str in ss {
                                        if !stop_str.is_empty()
                                            && task.stop_buffer.ends_with(stop_str)
                                        {
                                            stopped = true;
                                            hit_stop_seq = Some(stop_str.clone());
                                            break;
                                        }
                                    }
                                }

                                if stopped {
                                    task.ended_by_stop = true;
                                }

                                task.steps_done += 1;

                                if task.is_streaming {
                                    if let Ok(decoded) = tokenizer.decode(&task.acc_ids) {
                                        let s = String::from_utf8_lossy(&decoded);
                                        let new = &s[task.last_decoded_len..];
                                        if !new.is_empty() {
                                            let _ = task
                                                .tx
                                                .send(InferenceEvent::Token(new.to_string()));
                                        }
                                        task.last_decoded_len = s.len();
                                    }
                                }

                                if task.ended_by_stop || task.steps_done >= task.max_tokens {
                                    let mut text =
                                        if let Ok(decoded) = tokenizer.decode(&task.acc_ids) {
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

                                    if let Some(sid) = &task.session_id {
                                        if let Ok(current_state) = state.back(task.slot).await {
                                            let mut base_tokens = task.prompt_tokens.clone();
                                            if task.loaded_from_cache {
                                                if let Some((prev_cached_tokens, _)) =
                                                    session_states.read().await.get(sid)
                                                {
                                                    let new_len = prev_cached_tokens
                                                        .len()
                                                        .saturating_sub(task.dedup_backtrack);
                                                    let mut full =
                                                        prev_cached_tokens[..new_len].to_vec();
                                                    full.extend_from_slice(&task.input_tokens);
                                                    base_tokens = full;
                                                }
                                            }
                                            let mut full_tokens = base_tokens;
                                            full_tokens.extend_from_slice(&task.acc_ids);
                                            session_states
                                                .write()
                                                .await
                                                .insert(sid.clone(), (full_tokens, current_state));
                                        }
                                    }

                                    *slot = None;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn prepare_task(
    params: InferenceTaskParams,
    slot: usize,
    state: &Arc<dyn State + Send + Sync>,
    tokenizer: &Arc<Tokenizer>,
    states: &Arc<RwLock<HashMap<String, TensorCpu<f32>>>>,
    session_states: &SessionStates,
    context: &Context,
    info: &ModelInfo,
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

    let prompt_tokens = tokenizer
        .encode(prompt.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut input_tokens = prompt_tokens.clone();
    let mut loaded_from_cache = false;
    let mut dedup_backtrack = 0usize;

    if let Some(sid) = &params.session_id {
        let read = session_states.read().await;
        if let Some((cached_tokens, cached_state)) = read.get(sid) {
            if state.load(cached_state.clone(), slot).is_ok() {
                let mut skip = 0;
                let boundary_texts = ["\n\n# User", "# User", "\n\n### Tool Risk", "### Tool Risk"];
                for text in boundary_texts {
                    if let Ok(boundary_ids) = tokenizer.encode(text.as_bytes()) {
                        if !boundary_ids.is_empty()
                            && prompt_tokens.starts_with(&boundary_ids)
                            && cached_tokens.ends_with(&boundary_ids)
                        {
                            skip = skip.max(boundary_ids.len());
                        }
                    }
                }

                if skip == 0 && !prompt_tokens.is_empty() && !cached_tokens.is_empty() {
                    let last_id = cached_tokens.last().unwrap();
                    let is_last_newline = tokenizer
                        .decode(&[*last_id])
                        .ok()
                        .map(|s| String::from_utf8_lossy(&s) == "\n")
                        .unwrap_or(false);

                    if is_last_newline {
                        if let Ok(double_newline_ids) = tokenizer.encode(b"\n\n") {
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
        if let Some(path) = &params.state_path {
            let resolved_path = if Path::new(path).exists() {
                path.clone()
            } else {
                let p = assets_models_dir().join(path);
                if p.exists() {
                    p.to_string_lossy().to_string()
                } else {
                    path.clone()
                }
            };
            log::info!(
                "[rwkv] state_path input={}, resolved={}, assets_dir={}",
                path,
                resolved_path,
                assets_models_dir().display()
            );

            let s = {
                let read = states.read().await;
                read.get(&resolved_path).cloned()
            };
            let s = match s {
                Some(s) => s,
                None => {
                    let file = std::fs::File::open(&resolved_path).map_err(|e| {
                        format!(
                            "failed to open state file '{}': {} (assets_dir={})",
                            resolved_path,
                            e,
                            assets_models_dir().display()
                        )
                    })?;
                    let data = unsafe {
                        Mmap::map(&file).map_err(|e| format!("failed to mmap state file: {}", e))?
                    };
                    let st = safetensors::tensor::SafeTensors::deserialize(&data)
                        .map_err(|e| format!("failed to deserialize state file: {}", e))?;
                    let s = load_model_state(context, info, st).await?;
                    states
                        .write()
                        .await
                        .insert(resolved_path.clone(), s.clone());
                    s
                }
            };
            state
                .load(s, slot)
                .map_err(|e| format!("failed to apply state: {}", e))?;
        } else {
            let s = {
                let read = states.read().await;
                read.get("__initial__").cloned()
            };
            if let Some(s) = s {
                state
                    .load(s, slot)
                    .map_err(|e| format!("failed to reset state: {}", e))?;
            }
        }
    }

    // Initialize penalty state from model_text (prior Assistant message contents).
    // This aligns with ai00-server's NucleusSampler which uses model_text to seed
    // presence_penalty and frequency_penalty memory. Without this, penalties are
    // completely ineffective on the first generated token.
    let token_counts = if !params.model_text.is_empty() {
        match tokenizer.encode(params.model_text.as_bytes()) {
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
        slot,
        phase: TaskPhase::Prefill,
        prompt_tokens,
        input_tokens,
        state_path: params.state_path,
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
    state_path: Option<String>,
    session_id: Option<String>,
    is_streaming: bool,
    is_vrm: bool,
    model_text: String,
) -> Result<mpsc::UnboundedReceiver<InferenceEvent>, String> {
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
        state_path,
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

struct LlmState {
    context: Context,
    info: ModelInfo,
    runtime: Arc<dyn Runtime<Rnn> + Send + Sync>,
    state: Arc<dyn State + Send + Sync>,
    states: Arc<RwLock<HashMap<String, TensorCpu<f32>>>>,
    session_states: SessionStates,
    tokenizer: Arc<Tokenizer>,
}

#[derive(Debug, Deserialize)]
struct Prefab {
    info: ModelInfo,
}

static LLM: OnceLock<Mutex<Option<LlmState>>> = OnceLock::new();
static CANCEL_EPOCH: OnceLock<AtomicU64> = OnceLock::new();
static LLM_INITING: OnceLock<Mutex<bool>> = OnceLock::new();

pub fn is_llm_initialized() -> bool {
    if let Some(lock) = LLM.get() {
        if let Ok(g) = lock.lock() {
            return g.is_some();
        }
    }
    false
}

/// Lightweight inference for sidecar tasks (relevance check, extraction).
/// Uses low temperature + top_k=10 for deterministic but slightly diverse output.
/// Shares the same state as VRM chat (single state, 8 batch slots).
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

fn load_tokenizer(path: &str) -> Result<Tokenizer, String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Tokenizer::new(&content).map_err(|e| e.to_string())
}

async fn load_model_state<R: Reader>(
    context: &Context,
    info: &ModelInfo,
    model: R,
) -> Result<TensorCpu<f32>, String> {
    match info.version {
        ModelVersion::V4 => Err("v4 does not support init state yet".to_string()),
        ModelVersion::V5 => web_rwkv::runtime::v5::read_state(context, info, model)
            .await
            .map_err(|e| format!("{:?}", e)),
        ModelVersion::V6 => web_rwkv::runtime::v6::read_state(context, info, model)
            .await
            .map_err(|e| format!("{:?}", e)),
        ModelVersion::V7 => web_rwkv::runtime::v7::read_state(context, info, model)
            .await
            .map_err(|e| format!("{:?}", e)),
    }
}

async fn load_model(
    context: &Context,
    bytes: &[u8],
    state_path: Option<String>,
    quant_choice: Option<String>,
) -> Result<
    (
        ModelInfo,
        TokioRuntime<Rnn>,
        Arc<dyn State + Send + Sync>,
        Arc<RwLock<HashMap<String, TensorCpu<f32>>>>,
        SessionStates,
    ),
    String,
> {
    if let Ok(st) = safetensors::tensor::SafeTensors::deserialize(bytes) {
        let info = Loader::info(&st).map_err(|e| e.to_string())?;
        match info.version {
            ModelVersion::V7 => {
                let mut builder = ModelBuilder::new(context, st);
                if let Some(qc) = quant_choice.clone() {
                    let t = qc.to_uppercase();
                    if t == "INT8" || t == "NF4" {
                        let mut map: HashMap<usize, Quant> = HashMap::new();
                        let q = if t == "INT8" { Quant::Int8 } else { Quant::NF4 };
                        let n = info.num_layer.saturating_sub(2);
                        for i in 0..n {
                            map.insert(i, q);
                        }
                        builder = builder.quant(map);
                    }
                }
                let model = builder.build_v7().await.map_err(|e| e.to_string())?;
                let bundle = v7::Bundle::<f32>::new(model, 16);
                let state = Arc::new(bundle.state());
                let rt = TokioRuntime::<Rnn>::new::<v7::Bundle<f32>, v7::RnnJob>(bundle).await;
                let states = Arc::new(RwLock::new(HashMap::new()));
                let session_states = Arc::new(RwLock::new(HashMap::new()));
                let initial_state = state.back(0).await.map_err(|e| e.to_string())?;
                states
                    .write()
                    .await
                    .insert("__initial__".to_string(), initial_state);

                if let Some(path) = state_path {
                    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
                    let data = unsafe { Mmap::map(&file).map_err(|e| e.to_string())? };
                    let st = safetensors::tensor::SafeTensors::deserialize(&data)
                        .map_err(|e| e.to_string())?;
                    let s = load_model_state(context, &info, st).await?;
                    states.write().await.insert(path, s);
                }
                Ok((info, rt, state, states, session_states))
            }
            _ => Err("unsupported version".to_string()),
        }
    } else {
        let mut de = Deserializer::new(SliceReader::new(bytes));
        let model = Seed::<_, v7::Model>::new(context)
            .deserialize(&mut de)
            .map_err(|e| e.to_string())?;
        let bundle = v7::Bundle::<f32>::new(model, 16);
        let info = bundle.info().clone();
        let state = Arc::new(bundle.state());
        let rt = TokioRuntime::<Rnn>::new::<v7::Bundle<f32>, v7::RnnJob>(bundle).await;
        let states = Arc::new(RwLock::new(HashMap::new()));
        let session_states = Arc::new(RwLock::new(HashMap::new()));
        let initial_state = state.back(0).await.map_err(|e| e.to_string())?;
        states
            .write()
            .await
            .insert("__initial__".to_string(), initial_state);

        if let Some(path) = state_path {
            let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let data = unsafe { Mmap::map(&file).map_err(|e| e.to_string())? };
            let st =
                safetensors::tensor::SafeTensors::deserialize(&data).map_err(|e| e.to_string())?;
            let s = load_model_state(context, &info, st).await?;
            states.write().await.insert(path, s);
        }
        Ok((info, rt, state, states, session_states))
    }
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

#[tauri::command]
pub async fn rwkv_init_webrwkv(
    app: tauri::AppHandle,
    model_path: Option<String>,
    vocab_path: Option<String>,
    state_path: Option<String>,
) -> Result<bool, String> {
    if let Some(lock) = LLM.get() {
        if let Ok(g) = lock.lock() {
            if g.is_some() {
                let _ = app.emit("rwkv://debug", "llm initialized".to_string());
                {
                    crate::model_init::LLM_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
                }
                return Ok(true);
            }
        }
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
            if LLM.get().is_some() {
                let _ = app.emit("rwkv://debug", "llm initialized".to_string());
                {
                    crate::model_init::LLM_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
                }
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
        None => {
            let models_dir = assets_models_dir();
            let mut found_model = None;
            if let Ok(entries) = std::fs::read_dir(&models_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(ext) = path.extension() {
                        // .st is RWKV safetensors with custom extension
                        if ext == "safetensors" || ext == "cbor" || ext == "prefab" || ext == "st" {
                            found_model = Some(path.to_string_lossy().into_owned());
                            break;
                        }
                    }
                }
            }
            match found_model {
                Some(p) => p,
                None => return Err("No model file found in models directory".to_string()),
            }
        }
    };
    let _ = app.emit("rwkv://debug", format!("init model={} vocab={}", mp, vp));
    debug_print!("rwkv_init_webrwkv: model_path={} vocab_path={}", mp, vp);
    if !Path::new(&mp).exists() {
        let _ = app.emit("rwkv://debug", "model missing, skip init".to_string());
        return Err("model file missing".to_string());
    }
    if !in_progress {
        let _ = app.emit("rwkv://debug", "llm initializing".to_string());
    }
    let file = std::fs::File::open(&mp).map_err(|e| e.to_string())?;
    let data = unsafe { Mmap::map(&file).map_err(|e| e.to_string())? };

    let info = if let Ok(st) = safetensors::tensor::SafeTensors::deserialize(&data) {
        Loader::info(&st).map_err(|e| e.to_string())?
    } else {
        let prefab: Prefab = cbor4ii::serde::from_slice(&data).map_err(|e| e.to_string())?;
        prefab.info
    };

    let instance = Instance::default();
    let adapter = instance
        .adapter(PowerPreference::HighPerformance)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("rwkv://debug", "llm building context".to_string());
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let context = ContextBuilder::new(adapter)
        .auto_limits(&info)
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("rwkv://debug", "llm loading model".to_string());
    // quant = None to align with ai00-server's quant=0 configuration.
    // NF4 causes precision domain mismatch with FP16/FP32 state files.
    let qtype: Option<String> = None;
    let (info, rt, state, states, session_states) =
        load_model(&context, &data[..], state_path, qtype).await?;
    let _ = app.emit("rwkv://debug", "llm loading tokenizer".to_string());
    let tokenizer = Arc::new(load_tokenizer(&vp)?);
    let runtime_arc: Arc<dyn Runtime<Rnn> + Send + Sync> = Arc::new(rt);
    LLM.set(Mutex::new(Some(LlmState {
        context,
        info,
        runtime: runtime_arc.clone(),
        state,
        states,
        session_states,
        tokenizer: tokenizer.clone(),
    })))
    .map_err(|_| "already initialized".to_string())?;
    let _ = app.emit("rwkv://debug", "llm initialized".to_string());
    {
        crate::model_init::LLM_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
    }
    start_inference_pool();
    Ok(true)
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
    state_path: Option<String>,
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
            state_path,
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
    state_path: Option<String>,
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
        state_path,
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
    // Clone the Arc out of the guard and drop the guard before awaiting
    // to avoid holding a non-Send MutexGuard across an await point.
    let session_states = LLM.get().and_then(|lock| {
        lock.lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|state| state.session_states.clone()))
    });
    if let Some(session_states) = session_states {
        let mut states = session_states.write().await;
        states.remove(&session_id);
        log::info!("[rwkv] Cleared session cache for session_id={}", session_id);
        Ok(true)
    } else {
        Ok(false)
    }
}
