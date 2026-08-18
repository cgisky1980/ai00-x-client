use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

use crate::download_manager::DownloadManager;
use crate::model_checker::{CheckResult, ModelChecker, ModelUpdateInfo};
use crate::runtime;

use ai00_x_events::AudioGenEvent;

pub static ASR_ENGINE_INITIALIZED: AtomicBool = AtomicBool::new(false);
pub static TTS_ENGINE_INITIALIZED: AtomicBool = AtomicBool::new(false);
pub static LLM_ENGINE_INITIALIZED: AtomicBool = AtomicBool::new(false);
pub static EMBEDDING_ENGINE_INITIALIZED: AtomicBool = AtomicBool::new(false);
pub static AUDIO_GEN_ENGINE_INITIALIZED: AtomicBool = AtomicBool::new(false);

static ASR_REINITTING: AtomicBool = AtomicBool::new(false);

static ASR_MODEL_DIR: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

/// Shared across modules (model downloads + split-installer resource
/// downloads) so `get_download_progress` sees every task.
pub(crate) static DOWNLOAD_MANAGER: Lazy<DownloadManager> = Lazy::new(DownloadManager::new);

pub enum AsrTask {
    Pcm(Vec<f32>),
    File(String),
}

#[allow(clippy::type_complexity)]
pub static ASR_REQUEST_TX: Lazy<
    Mutex<Option<mpsc::Sender<(AsrTask, mpsc::Sender<Result<String, String>>)>>>,
> = Lazy::new(|| Mutex::new(None));

fn do_reinit_asr(model_dir: &str) -> Result<(), String> {
    log::info!(
        "[model_init] Auto reinit ASR engine: model_dir={}",
        model_dir
    );
    {
        let mut guard = ASR_MODEL_DIR
            .lock()
            .map_err(|_| "ASR model dir lock failed".to_string())?;
        *guard = Some(model_dir.to_string());
    }
    {
        let mut guard = ASR_REQUEST_TX
            .lock()
            .map_err(|_| "ASR channel lock failed".to_string())?;
        *guard = None;
    }
    ASR_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
    let model_path = std::path::PathBuf::from(model_dir);
    if !model_path.exists() {
        return Err(format!("ASR model directory does not exist: {}", model_dir));
    }
    let mut last_err = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            log::info!(
                "[model_init] Auto reinit ASR retry {}/2, waiting 3s...",
                attempt + 1
            );
            std::thread::sleep(std::time::Duration::from_secs(3));
        }
        match start_asr_worker(model_path.clone()) {
            Ok(()) => {
                log::info!("[model_init] ASR engine auto re-initialized successfully");
                return Ok(());
            }
            Err(e) => {
                last_err = e;
                log::warn!(
                    "[model_init] Auto reinit ASR attempt {}/2 failed: {}",
                    attempt + 1,
                    last_err
                );
            }
        }
    }
    Err(format!(
        "Auto reinit ASR failed after 2 attempts: {}",
        last_err
    ))
}

pub fn transcribe_pcm(samples: Vec<f32>) -> Result<String, String> {
    if !ASR_ENGINE_INITIALIZED.load(Ordering::SeqCst) {
        if ASR_REINITTING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let model_dir = ASR_MODEL_DIR
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .unwrap_or_else(|| {
                    runtime::get_models_dir()
                        .join("asr")
                        .to_string_lossy()
                        .to_string()
                });
            let reinit_result = do_reinit_asr(&model_dir);
            ASR_REINITTING.store(false, Ordering::SeqCst);
            reinit_result?;
        } else {
            // Wait for the other reinit to complete
            for _ in 0..50 {
                if ASR_ENGINE_INITIALIZED.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if !ASR_ENGINE_INITIALIZED.load(Ordering::SeqCst) {
                return Err("ASR engine not initialized, reinit in progress".to_string());
            }
        }
    }
    let (result_tx, result_rx) = mpsc::channel();
    {
        let guard = ASR_REQUEST_TX
            .lock()
            .map_err(|_| "ASR channel lock failed".to_string())?;
        let tx = guard.as_ref().ok_or("ASR worker not ready".to_string())?;
        tx.send((AsrTask::Pcm(samples), result_tx))
            .map_err(|_| "ASR worker send failed".to_string())?;
    }
    result_rx
        .recv()
        .map_err(|_| "ASR worker receive failed".to_string())?
}

static TTS_ENGINE: Lazy<Arc<Mutex<Option<crate::tts::TtsEngine>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

#[allow(dead_code)]
enum TtsRequest {
    Generate {
        text: String,
        speaker: String,
        instruct: Option<String>,
        temperature: f32,
        top_p: f32,
        top_k: i32,
        seed: Option<u64>,
        result_tx: mpsc::Sender<Result<Vec<u8>, String>>,
    },
}

static TTS_REQUEST_TX: Lazy<Mutex<Option<mpsc::Sender<TtsRequest>>>> =
    Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TtsChunkEvent {
    chunk: String,
    is_final: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub task_id: String,
    pub status: String,
    pub progress: u64,
    pub total: u64,
    pub error: Option<String>,
}

static DOWNLOAD_TASKS: Lazy<Mutex<std::collections::HashMap<String, DownloadProgress>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

pub fn get_models_dir_path() -> Result<std::path::PathBuf, String> {
    Ok(runtime::get_models_dir())
}

fn get_exe_dir() -> Result<String, String> {
    Ok(runtime::get_app_root_dir().to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_exe_dir_cmd() -> Result<String, String> {
    get_exe_dir()
}

/// Resolve the models directory. Respects `AI00X_MODELS_DIR` when set
/// (dev mode points it at `.ai00-x-dev/models`), otherwise falls back to
/// `<exe_dir>/models`.
#[tauri::command]
pub fn get_models_dir_cmd() -> Result<String, String> {
    Ok(get_models_dir_path()?.to_string_lossy().to_string())
}

/// Resolve the runtime directory. Respects `AI00X_RUNTIME_DIR` when set
/// (dev mode points it at `.ai00-x-dev/runtime`), otherwise falls back to
/// `<exe_dir>/runtime`.
#[tauri::command]
pub fn get_runtime_dir_cmd() -> Result<String, String> {
    Ok(runtime::get_runtime_dir().to_string_lossy().to_string())
}

#[tauri::command]
pub async fn check_model_updates() -> Result<CheckResult, String> {
    log::info!("[model_init] check_model_updates called");
    let models_dir = get_models_dir_path()?;
    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    }

    let checker = ModelChecker::new();
    checker.check_updates(None).await
}

#[tauri::command]
pub async fn download_model(model_info: ModelUpdateInfo) -> Result<String, String> {
    log::info!(
        "[model_init] download_model called: component={}, name={}",
        model_info.component,
        model_info.name
    );

    let save_dir = get_models_dir_path()?;
    std::fs::create_dir_all(&save_dir).map_err(|e| e.to_string())?;

    let save_path = save_dir.join(&model_info.url);
    log::info!(
        "[model_init] download_model: component={}, name={}, url={}, save_path={}",
        model_info.component,
        model_info.name,
        model_info.download_url,
        save_path.display()
    );
    if let Some(parent) = save_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let task_id = format!("{}_{}", model_info.component, model_info.name);

    {
        let mut tasks = DOWNLOAD_TASKS.lock().map_err(|e| e.to_string())?;
        tasks.insert(
            task_id.clone(),
            DownloadProgress {
                task_id: task_id.clone(),
                status: "Pending".to_string(),
                progress: 0,
                total: 0,
                error: None,
            },
        );
    }

    let mut urls = vec![model_info.download_url.clone()];
    for alt_url in model_info.available_hosts.values() {
        if !urls.contains(alt_url) {
            urls.push(alt_url.clone());
        }
    }

    DOWNLOAD_MANAGER
        .start_with_fallback(task_id.clone(), urls, save_path)
        .await
        .map_err(|e| e.to_string())?;

    Ok(task_id)
}

#[tauri::command]
pub async fn get_download_progress(task_id: String) -> Result<Option<DownloadProgress>, String> {
    let dm_task = DOWNLOAD_MANAGER.progress(&task_id).await;

    match dm_task {
        Some(task) => {
            let status_str = match task.status {
                crate::download_manager::DownloadStatus::Pending => "Pending",
                crate::download_manager::DownloadStatus::Downloading => "Downloading",
                crate::download_manager::DownloadStatus::Paused => "Paused",
                crate::download_manager::DownloadStatus::Completed => "Completed",
                crate::download_manager::DownloadStatus::Failed => "Failed",
            };

            let progress = DownloadProgress {
                task_id: task.id.clone(),
                status: status_str.to_string(),
                progress: task.progress,
                total: task.total.unwrap_or(0),
                error: task.error.clone(),
            };

            {
                let mut tasks = DOWNLOAD_TASKS.lock().map_err(|e| e.to_string())?;
                tasks.insert(task_id.clone(), progress.clone());
            }

            Ok(Some(progress))
        }
        None => {
            let tasks = DOWNLOAD_TASKS.lock().map_err(|e| e.to_string())?;
            Ok(tasks.get(&task_id).cloned())
        }
    }
}

#[tauri::command]
pub async fn init_all_runtimes_cmd() -> Result<(), String> {
    log::info!("[model_init] init_all_runtimes_cmd called");

    let runtime_dir = runtime::get_runtime_dir();
    if !runtime_dir.exists() {
        std::fs::create_dir_all(&runtime_dir).map_err(|e| e.to_string())?;
    }

    let backend = runtime::get_active_backend().to_string();
    log::info!("[model_init] Detected llama backend: {}", backend);
    runtime::set_active_backend(&backend);

    let downloader = runtime::RuntimeDownloader::new().await;
    if let Err(e) = downloader.download_all(&runtime_dir, &backend).await {
        log::warn!(
            "[model_init] Runtime download failed (DLLs may already exist locally): {}",
            e
        );
    }

    tokio::task::spawn_blocking(runtime::init_all_runtimes)
        .await
        .map_err(|e| format!("Runtime init task failed: {}", e))?
        .map_err(|e| format!("Runtime init failed: {}", e))?;

    log::info!(
        "[model_init] All runtimes initialized successfully (backend: {})",
        backend
    );
    Ok(())
}

/// Idle timeout in seconds before releasing ASR models to free GPU VRAM.
const ASR_IDLE_TIMEOUT_SECS: u64 = 180; // 3 minutes

fn start_asr_worker(model_path: std::path::PathBuf) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<(AsrTask, mpsc::Sender<Result<String, String>>)>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    {
        let mut guard = ASR_REQUEST_TX.lock().unwrap();
        *guard = Some(tx);
    }

    let model_path_clone = model_path.clone();
    std::thread::spawn(move || {
        let create_engine = |mp: &std::path::PathBuf| -> Result<crate::asr::AsrEngine, String> {
            crate::asr::AsrEngine::load(mp, true)
        };

        match create_engine(&model_path) {
            Ok(engine) => {
                ASR_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
                let _ = ready_tx.send(Ok(()));
                log::info!("[ASR Worker] Engine ready");

                let mut engine_opt = Some(engine);

                loop {
                    let timeout = if engine_opt.is_some() {
                        std::time::Duration::from_secs(ASR_IDLE_TIMEOUT_SECS)
                    } else {
                        std::time::Duration::from_secs(3600)
                    };

                    match rx.recv_timeout(timeout) {
                        Ok((task, result_tx)) => {
                            // Recreate engine if it was dropped due to idle timeout
                            if engine_opt.is_none() {
                                log::info!("[ASR Worker] Recreating engine after idle timeout");
                                match create_engine(&model_path_clone) {
                                    Ok(new_engine) => {
                                        ASR_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
                                        engine_opt = Some(new_engine);
                                        log::info!("[ASR Worker] Engine recreated");
                                    }
                                    Err(e) => {
                                        log::error!("[ASR Worker] Engine recreation failed: {}", e);
                                        let _ = result_tx.send(Err(e));
                                        continue;
                                    }
                                }
                            }

                            if let Some(ref mut eng) = engine_opt {
                                let result = match task {
                                    AsrTask::Pcm(samples) => eng.decode(samples.as_slice(), None),
                                    AsrTask::File(path) => {
                                        let p = std::path::Path::new(&path);
                                        let res = eng.transcribe(p, None);
                                        let _ = std::fs::remove_file(&path);
                                        res
                                    }
                                };
                                let _ = result_tx.send(result);
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            if engine_opt.is_some() {
                                log::info!(
                                    "[ASR Worker] Idle timeout ({}s), releasing GPU VRAM",
                                    ASR_IDLE_TIMEOUT_SECS
                                );
                                engine_opt = None;
                                ASR_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            break;
                        }
                    }
                }

                drop(engine_opt);
                ASR_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
                log::info!("[ASR Worker] Channel closed, worker exiting");
            }
            Err(e) => {
                ASR_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
                let _ = ready_tx.send(Err(format!("ASR engine init failed: {}", e)));
                log::error!("[ASR Worker] Init failed: {}", e);
            }
        }
    });

    ready_rx
        .recv()
        .map_err(|_| "ASR worker init channel closed".to_string())?
}

/// Idle timeout in seconds before releasing TTS models to free GPU VRAM.
const TTS_IDLE_TIMEOUT_SECS: u64 = 180; // 3 minutes

/// Stored init params for TTS re-initialization after idle timeout
static TTS_INIT_PARAMS: Lazy<Mutex<Option<(std::path::PathBuf, String)>>> =
    Lazy::new(|| Mutex::new(None));

fn start_tts_worker(
    app: tauri::AppHandle,
    model_dir: std::path::PathBuf,
    quant: String,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<TtsRequest>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    {
        let mut guard = TTS_REQUEST_TX.lock().unwrap();
        *guard = Some(tx);
    }

    // Store init params for re-initialization after idle timeout
    {
        let mut params = TTS_INIT_PARAMS.lock().unwrap();
        *params = Some((model_dir.clone(), quant.clone()));
    }

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            match crate::tts::TtsEngine::new(&model_dir, &quant, 4).await {
                Ok(engine) => {
                    let speakers_count = {
                        let mut guard = TTS_ENGINE.lock().unwrap();
                        *guard = Some(engine);
                        guard
                            .as_ref()
                            .map(|e| e.get_speakers_map().len())
                            .unwrap_or(0)
                    };
                    TTS_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
                    log::info!("[TTS Worker] Engine ready, speakers: {}", speakers_count);

                    {
                        let state = app.state::<crate::api::app_state::AppState>();
                        let speakers = {
                            let guard = TTS_ENGINE.lock().unwrap();
                            guard
                                .as_ref()
                                .map(|e| e.get_speakers_list())
                                .unwrap_or_default()
                        };
                        if let Ok(mut s) = state.speakers.write() {
                            *s = speakers;
                        };
                    }

                    let _ = ready_tx.send(Ok(()));

                    loop {
                        let timeout = if TTS_ENGINE.lock().map(|g| g.is_some()).unwrap_or(false) {
                            std::time::Duration::from_secs(TTS_IDLE_TIMEOUT_SECS)
                        } else {
                            std::time::Duration::from_secs(3600)
                        };

                        match rx.recv_timeout(timeout) {
                            Ok(TtsRequest::Generate {
                                text,
                                speaker,
                                instruct,
                                temperature,
                                top_p,
                                top_k,
                                seed,
                                result_tx,
                            }) => {
                                // Recreate engine if it was dropped due to idle timeout
                                let engine_empty =
                                    TTS_ENGINE.lock().map(|g| g.is_none()).unwrap_or(true);
                                if engine_empty {
                                    log::info!("[TTS Worker] Recreating engine after idle timeout");
                                    // P: 避免 await_holding_lock — clone 出参数后立即 drop guard，
                                    // 否则 std::sync::MutexGuard 会跨 await 点持有，可能死锁。
                                    let init_params: Option<(std::path::PathBuf, String)> =
                                        TTS_INIT_PARAMS.lock().unwrap().clone();
                                    if let Some((md, q)) = init_params.as_ref() {
                                        match crate::tts::TtsEngine::new(md, q, 4).await {
                                            Ok(new_engine) => {
                                                let speakers_count = {
                                                    let mut guard = TTS_ENGINE.lock().unwrap();
                                                    *guard = Some(new_engine);
                                                    guard
                                                        .as_ref()
                                                        .map(|e| e.get_speakers_map().len())
                                                        .unwrap_or(0)
                                                };
                                                TTS_ENGINE_INITIALIZED
                                                    .store(true, Ordering::SeqCst);
                                                log::info!(
                                                    "[TTS Worker] Engine recreated, speakers: {}",
                                                    speakers_count
                                                );

                                                // Update speakers list
                                                {
                                                    let state = app
                                                        .state::<crate::api::app_state::AppState>();
                                                    let speakers = {
                                                        let guard = TTS_ENGINE.lock().unwrap();
                                                        guard
                                                            .as_ref()
                                                            .map(|e| e.get_speakers_list())
                                                            .unwrap_or_default()
                                                    };
                                                    if let Ok(mut s) = state.speakers.write() {
                                                        *s = speakers;
                                                    };
                                                }
                                            }
                                            Err(e) => {
                                                log::error!(
                                                    "[TTS Worker] Engine recreation failed: {}",
                                                    e
                                                );
                                                let _ = result_tx.send(Err(e));
                                                continue;
                                            }
                                        }
                                    } else {
                                        let _ = result_tx
                                            .send(Err("TTS init params not available".to_string()));
                                        continue;
                                    }
                                }

                                let voice = {
                                    let guard = match TTS_ENGINE.try_lock() {
                                        Ok(g) => g,
                                        Err(_) => continue,
                                    };
                                    if guard.is_none() {
                                        continue;
                                    }
                                    guard
                                        .as_ref()
                                        .expect("TTS Engine should be Some")
                                        .get_speaker(&speaker)
                                        .clone()
                                };

                                let (stream_tx, stream_rx) = std::sync::mpsc::channel::<Vec<f32>>();
                                let app_handle = app.clone();
                                std::thread::spawn(move || {
                                    while let Ok(samples) = stream_rx.recv() {
                                        let bytes: Vec<u8> = samples
                                            .iter()
                                            .flat_map(|f: &f32| f.to_le_bytes())
                                            .collect();
                                        let chunk_b64 = base64::Engine::encode(
                                            &base64::engine::general_purpose::STANDARD,
                                            &bytes,
                                        );
                                        let _ = app_handle.emit(
                                            "tts_chunk",
                                            TtsChunkEvent {
                                                chunk: chunk_b64,
                                                is_final: false,
                                            },
                                        );
                                    }
                                });

                                let result = {
                                    let mut guard = match TTS_ENGINE.try_lock() {
                                        Ok(g) => g,
                                        Err(_) => continue,
                                    };
                                    if guard.is_none() {
                                        continue;
                                    }
                                    let engine = guard.as_mut().unwrap();
                                    let config = crate::tts::SamplerConfig::new(
                                        temperature,
                                        top_k,
                                        top_p,
                                        seed,
                                    );
                                    engine.set_sampler_config(config);
                                    engine.generate_with_voice_streaming(
                                        &text,
                                        &voice,
                                        instruct.as_deref(),
                                        Some(stream_tx),
                                    )
                                };

                                match result {
                                    Ok(audio) => {
                                        let samples = &audio.samples;
                                        let sample_rate = audio.sample_rate;
                                        let bytes = samples_to_wav(samples, sample_rate);
                                        let _ = result_tx.send(Ok(bytes));
                                        let _ = app.emit(
                                            "tts_chunk",
                                            TtsChunkEvent {
                                                chunk: "".to_string(),
                                                is_final: true,
                                            },
                                        );
                                    }
                                    Err(e) => {
                                        log::error!("[TTS] Generate failed: {}", e);
                                        let _ = result_tx.send(Err(format!("TTS failed: {}", e)));
                                    }
                                }
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                let engine_loaded =
                                    TTS_ENGINE.lock().map(|g| g.is_some()).unwrap_or(false);
                                if engine_loaded {
                                    log::info!(
                                        "[TTS Worker] Idle timeout ({}s), releasing GPU VRAM",
                                        TTS_IDLE_TIMEOUT_SECS
                                    );
                                    let mut guard = TTS_ENGINE.lock().unwrap();
                                    *guard = None;
                                    TTS_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
                                }
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                                break;
                            }
                        }
                    }
                }
                Err(e) => {
                    log::error!("[TTS Worker] Init failed: {}", e);
                    let _ = ready_tx.send(Err(format!("TTS engine init failed: {}", e)));
                }
            }
        });
    });

    ready_rx
        .recv()
        .map_err(|_| "TTS worker init channel closed".to_string())?
}

fn samples_to_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let num_channels = 1u16;
    let bits_per_sample = 16u16;
    let bytes_per_sample = (bits_per_sample / 8) as usize;
    let block_align = num_channels as usize * bytes_per_sample;
    let data_length = samples.len() * bytes_per_sample;

    let mut wav = Vec::with_capacity(44 + data_length);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_length as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&num_channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * block_align as u32).to_le_bytes());
    wav.extend_from_slice(&(block_align as u16).to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_length as u32).to_le_bytes());

    for &sample in samples {
        let amp = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
        wav.extend_from_slice(&amp.to_le_bytes());
    }
    wav
}

#[derive(Clone, Serialize)]
pub struct EngineInitStatus {
    pub asr_initialized: bool,
    pub tts_initialized: bool,
    pub llm_initialized: bool,
    pub embedding_initialized: bool,
    pub audio_gen_initialized: bool,
}

#[tauri::command]
pub fn get_engine_init_status() -> EngineInitStatus {
    EngineInitStatus {
        asr_initialized: ASR_ENGINE_INITIALIZED.load(Ordering::SeqCst),
        tts_initialized: TTS_ENGINE_INITIALIZED.load(Ordering::SeqCst),
        llm_initialized: LLM_ENGINE_INITIALIZED.load(Ordering::SeqCst),
        embedding_initialized: EMBEDDING_ENGINE_INITIALIZED.load(Ordering::SeqCst),
        audio_gen_initialized: AUDIO_GEN_ENGINE_INITIALIZED.load(Ordering::SeqCst),
    }
}

#[tauri::command]
pub async fn reinit_asr_engine(model_dir: String) -> Result<(), String> {
    log::info!(
        "[model_init] reinit_asr_engine called: model_dir={}",
        model_dir
    );
    {
        let mut guard = ASR_MODEL_DIR
            .lock()
            .map_err(|_| "ASR model dir lock failed".to_string())?;
        *guard = Some(model_dir.clone());
    }
    {
        let mut guard = ASR_REQUEST_TX
            .lock()
            .map_err(|_| "ASR channel lock failed".to_string())?;
        *guard = None;
    }
    ASR_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
    let model_path = std::path::PathBuf::from(&model_dir);
    if !model_path.exists() {
        return Err(format!("ASR model directory does not exist: {}", model_dir));
    }
    tokio::task::spawn_blocking(move || start_asr_worker(model_path))
        .await
        .map_err(|e| format!("ASR reinit task failed: {}", e))?
        .map_err(|e| format!("ASR reinit failed: {}", e))?;
    log::info!("[model_init] ASR engine re-initialized successfully");
    Ok(())
}

#[tauri::command]
pub async fn reinit_tts_engine(
    model_dir: String,
    quant: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    log::info!(
        "[model_init] reinit_tts_engine called: model_dir={}, quant={}",
        model_dir,
        quant
    );
    {
        let mut guard = TTS_REQUEST_TX.lock().unwrap();
        *guard = None;
    }
    {
        let mut guard = TTS_ENGINE.lock().unwrap();
        *guard = None;
    }
    TTS_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
    let model_path = std::path::PathBuf::from(&model_dir);
    if !model_path.exists() {
        return Err(format!("TTS model directory does not exist: {}", model_dir));
    }
    tokio::task::spawn_blocking(move || start_tts_worker(app, model_path, quant))
        .await
        .map_err(|e| format!("TTS reinit task failed: {}", e))?
        .map_err(|e| format!("TTS reinit failed: {}", e))?;
    log::info!("[model_init] TTS engine re-initialized successfully");
    Ok(())
}

#[tauri::command]
pub async fn init_asr_engine(model_dir: String) -> Result<(), String> {
    log::info!(
        "[model_init] init_asr_engine called: model_dir={}",
        model_dir
    );
    if ASR_ENGINE_INITIALIZED.load(Ordering::SeqCst) {
        log::info!("[model_init] ASR engine already initialized");
        return Ok(());
    }
    {
        let mut guard = ASR_MODEL_DIR
            .lock()
            .map_err(|_| "ASR model dir lock failed".to_string())?;
        *guard = Some(model_dir.clone());
    }
    let model_path = std::path::PathBuf::from(&model_dir);
    if !model_path.exists() {
        return Err(format!("ASR model directory does not exist: {}", model_dir));
    }
    let mut last_err = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            log::info!(
                "[model_init] ASR init retry {}/3, waiting 5s...",
                attempt + 1
            );
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        {
            let mut guard = ASR_REQUEST_TX
                .lock()
                .map_err(|_| "ASR channel lock failed".to_string())?;
            *guard = None;
        }
        ASR_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
        match tokio::task::spawn_blocking({
            let mp = model_path.clone();
            move || start_asr_worker(mp)
        })
        .await
        {
            Ok(Ok(())) => {
                log::info!("[model_init] ASR engine initialized successfully");
                return Ok(());
            }
            Ok(Err(e)) => {
                last_err = e;
                log::warn!(
                    "[model_init] ASR init attempt {}/3 failed: {}",
                    attempt + 1,
                    last_err
                );
            }
            Err(e) => {
                last_err = format!("ASR init task failed: {}", e);
                log::warn!(
                    "[model_init] ASR init attempt {}/3 task error: {}",
                    attempt + 1,
                    last_err
                );
            }
        }
    }
    Err(format!("ASR init failed after 3 attempts: {}", last_err))
}

#[tauri::command]
pub async fn init_tts_engine(
    model_dir: String,
    quant: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    log::info!(
        "[model_init] init_tts_engine called: model_dir={}, quant={}",
        model_dir,
        quant
    );
    if TTS_ENGINE_INITIALIZED.load(Ordering::SeqCst) {
        log::info!("[model_init] TTS engine already initialized");
        return Ok(());
    }
    let model_path = std::path::PathBuf::from(&model_dir);
    if !model_path.exists() {
        return Err(format!("TTS model directory does not exist: {}", model_dir));
    }
    log::info!("[model_init] Pre-initializing Llama FFI for TTS...");
    tokio::task::spawn_blocking(|| {
        crate::asr::llama::get_ffi()?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("FFI pre-init for TTS failed: {}", e))?
    .map_err(|e| format!("FFI pre-init for TTS failed: {}", e))?;
    let mut last_err = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            log::info!(
                "[model_init] TTS init retry {}/2, waiting 5s...",
                attempt + 1
            );
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        match tokio::task::spawn_blocking({
            let mp = model_path.clone();
            let q = quant.clone();
            let app_clone = app.clone();
            move || start_tts_worker(app_clone, mp, q)
        })
        .await
        {
            Ok(Ok(())) => {
                log::info!("[model_init] TTS engine initialized successfully");
                return Ok(());
            }
            Ok(Err(e)) => {
                last_err = e;
                log::warn!(
                    "[model_init] TTS init attempt {}/2 failed: {}",
                    attempt + 1,
                    last_err
                );
            }
            Err(e) => {
                last_err = format!("TTS init task failed: {}", e);
                log::warn!(
                    "[model_init] TTS init attempt {}/2 task error: {}",
                    attempt + 1,
                    last_err
                );
            }
        }
    }
    Err(format!("TTS init failed after 2 attempts: {}", last_err))
}

#[tauri::command]
pub async fn init_llm_engine(
    app: tauri::AppHandle,
    model_path: Option<String>,
    vocab_path: Option<String>,
) -> Result<bool, String> {
    log::info!(
        "[model_init] init_llm_engine called: model_path={:?}, vocab_path={:?}",
        model_path,
        vocab_path
    );
    if LLM_ENGINE_INITIALIZED.load(Ordering::SeqCst) {
        log::info!("[model_init] LLM engine already initialized");
        // Re-init sidecar in case it wasn't set (e.g., previous partial init)
        if !ai00_x_core::service::memory_graph::sidecar::is_sidecar_enabled() {
            crate::memory_sidecar::init_memory_sidecar();
        }
        return Ok(true);
    }
    let result = crate::rwkv_llm::rwkv_init_webrwkv(app, model_path, vocab_path, None).await?;
    // Init memory sidecar after LLM is ready
    crate::memory_sidecar::init_memory_sidecar();
    Ok(result)
}

#[tauri::command]
pub async fn init_embedding_engine() -> Result<(), String> {
    log::info!("[model_init] init_embedding_engine called");
    if EMBEDDING_ENGINE_INITIALIZED.load(Ordering::SeqCst) {
        log::info!("[model_init] Embedding engine already initialized");
        return Ok(());
    }

    tokio::task::spawn_blocking(|| {
        crate::embedding::init_embedding_service()
            .map_err(|e| format!("Embedding init failed: {}", e.0))
    })
    .await
    .map_err(|e| format!("Embedding init task failed: {}", e))??;

    crate::embedding::init_embedding_provider();

    // Try to init memory sidecar if LLM is already up
    if crate::rwkv_llm::is_llm_initialized() {
        crate::memory_sidecar::init_memory_sidecar();
    }

    EMBEDDING_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
    log::info!("[model_init] Embedding engine initialized successfully");
    Ok(())
}

#[tauri::command]
pub fn get_speakers(
    state: tauri::State<'_, crate::api::app_state::AppState>,
) -> Vec<crate::tts::SpeakerInfo> {
    state.speakers.read().unwrap().clone()
}

/// Ensure TTS engine is initialized. If it was dropped due to idle timeout,
/// re-initialize it using stored init params. Returns Ok(()) if engine is ready.
async fn ensure_tts_engine(app: &tauri::AppHandle) -> Result<(), String> {
    if TTS_ENGINE_INITIALIZED.load(Ordering::SeqCst) {
        return Ok(());
    }
    log::info!(
        "[model_init] TTS engine not initialized (idle timeout or first use), re-initializing"
    );
    let reinit_data = {
        let params = TTS_INIT_PARAMS.lock().unwrap();
        params.as_ref().map(|(md, q)| (md.clone(), q.clone()))
    };
    if let Some((model_dir, quant)) = reinit_data {
        init_tts_engine(model_dir.to_string_lossy().to_string(), quant, app.clone()).await
    } else {
        Err("TTS engine not initialized and no init params available".to_string())
    }
}

#[tauri::command]
pub async fn delete_speaker(
    speaker_id: String,
    state: tauri::State<'_, crate::api::app_state::AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_tts_engine(&app).await?;
    {
        let mut guard = TTS_ENGINE
            .lock()
            .map_err(|e| format!("TTS engine lock failed: {}", e))?;
        match guard.as_mut() {
            Some(engine) => engine.delete_speaker(&speaker_id)?,
            None => return Err("TTS engine not available".to_string()),
        }
    }
    let mut speakers = state.speakers.write().unwrap();
    speakers.retain(|s| s.id != speaker_id);
    Ok(())
}

#[tauri::command]
pub async fn update_speaker_meta(
    speaker_id: String,
    name: Option<String>,
    gender: Option<String>,
    age: Option<String>,
    state: tauri::State<'_, crate::api::app_state::AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    ensure_tts_engine(&app).await?;
    let new_id = {
        let mut guard = TTS_ENGINE
            .lock()
            .map_err(|e| format!("TTS engine lock failed: {}", e))?;
        match guard.as_mut() {
            Some(engine) => engine.update_speaker_meta(
                &speaker_id,
                name.clone(),
                gender.clone(),
                age.clone(),
            )?,
            None => return Err("TTS engine not available".to_string()),
        }
    };
    let mut speakers = state.speakers.write().unwrap();
    if let Some(s) = speakers.iter_mut().find(|s| s.id == speaker_id) {
        if let Some(n) = name {
            s.name = Some(n);
        }
        if let Some(g) = gender {
            s.gender = Some(g);
        }
        if let Some(a) = age {
            s.age = Some(a);
        }
        if new_id != speaker_id {
            s.id = new_id.clone();
        }
    }
    Ok(new_id)
}

#[tauri::command]
pub async fn tts_queue_start(app: tauri::AppHandle) -> Result<(), String> {
    ensure_tts_engine(&app).await?;

    let engine = Arc::clone(&TTS_ENGINE);

    let manager_ref = crate::tts::tts_queue::get_or_create_manager();
    let mut manager_guard = manager_ref.lock().unwrap();

    if manager_guard.is_none() {
        *manager_guard = Some(crate::tts::TtsPlaybackManager::new());
    }

    if let Some(manager) = manager_guard.as_mut() {
        manager.start(engine, app);
    }

    Ok(())
}

#[tauri::command]
pub async fn tts_queue_push(segment: crate::tts::TtsSegment) -> Result<(), String> {
    let manager_ref = crate::tts::tts_queue::get_or_create_manager();
    let manager_guard = manager_ref.lock().unwrap();

    match manager_guard.as_ref() {
        Some(manager) => {
            manager.push(segment);
            Ok(())
        }
        None => Err("TTS queue manager not initialized. Call tts_queue_start first.".to_string()),
    }
}

#[tauri::command]
pub async fn tts_queue_stop() -> Result<(), String> {
    let manager_ref = crate::tts::tts_queue::get_or_create_manager();
    let mut manager_guard = manager_ref.lock().unwrap();

    if let Some(manager) = manager_guard.as_mut() {
        manager.stop();
    }

    Ok(())
}

#[tauri::command]
pub async fn tts_preview(
    speaker_id: String,
    text: Option<String>,
    instruct: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_tts_engine(&app).await?;

    let preview_text = text.unwrap_or_else(|| "你好，我是你的助手".to_string());
    log::info!(
        "[TTS Preview] speaker_id={}, instruct={:?}, text={}",
        speaker_id,
        instruct,
        preview_text
    );

    let voice = {
        let guard = TTS_ENGINE
            .lock()
            .map_err(|e| format!("TTS engine lock failed: {}", e))?;
        match guard.as_ref() {
            Some(engine) => engine.get_speaker(&speaker_id).clone(),
            None => return Err("TTS engine not available".to_string()),
        }
    };

    let (stream_tx, stream_rx) = std::sync::mpsc::channel::<Vec<f32>>();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        while let Ok(samples) = stream_rx.recv() {
            let bytes: Vec<u8> = samples.iter().flat_map(|f: &f32| f.to_le_bytes()).collect();
            let chunk_b64 =
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
            let _ = app_handle.emit(
                "tts://preview_chunk",
                TtsChunkEvent {
                    chunk: chunk_b64,
                    is_final: false,
                },
            );
        }
    });

    let instruct_ref = instruct.as_deref();
    let result = {
        let mut guard = TTS_ENGINE
            .lock()
            .map_err(|e| format!("TTS engine lock failed: {}", e))?;
        match guard.as_mut() {
            Some(engine) => {
                let config = crate::tts::SamplerConfig::default();
                engine.set_sampler_config(config);
                engine.generate_with_voice_streaming(
                    &preview_text,
                    &voice,
                    instruct_ref,
                    Some(stream_tx),
                )
            }
            None => return Err("TTS engine not available".to_string()),
        }
    };

    match result {
        Ok(_) => {
            let _ = app.emit(
                "tts://preview_done",
                serde_json::json!({ "speaker_id": speaker_id }),
            );
            Ok(())
        }
        Err(e) => {
            log::error!("[TTS Preview] Generate failed: {}", e);
            Err(format!("TTS preview failed: {}", e))
        }
    }
}

// ==================== Audio Generation Engine ====================
// Uses a dedicated worker thread (same pattern as ASR) to ensure MNN models
// are always used on the same thread they were created on. MNN internally
// stores thread-local / GPU context state, so cross-thread usage causes segfaults.

enum AudioGenRequest {
    Generate {
        opts: crate::audio_gen::AudioGenOptions,
        output_dir: std::path::PathBuf,
        result_tx: mpsc::Sender<Result<crate::audio_gen::AudioGenResult, String>>,
    },
}

/// Idle timeout in seconds before releasing MNN models to free CPU.
/// After this period without generation requests, the engine is dropped
/// and MNN internal thread pools are released. The engine is recreated
/// on the next request (with model reload latency).
const AUDIO_GEN_IDLE_TIMEOUT_SECS: u64 = 180; // 3 minutes

static AUDIO_GEN_REQUEST_TX: Lazy<Mutex<Option<mpsc::Sender<AudioGenRequest>>>> =
    Lazy::new(|| Mutex::new(None));

/// Stored init params for re-initialization when switching GPU/CPU backend
struct AudioGenInitParams {
    model_dir: String,
    variant: String,
    mnn_gpu: i32, // User's preferred GPU setting
    mnn_int8: bool,
    default_duration: f32,
}

static AUDIO_GEN_INIT_PARAMS: Lazy<Mutex<Option<AudioGenInitParams>>> =
    Lazy::new(|| Mutex::new(None));

/// Current backend actually in use (0=CPU, 1=CUDA, 2=Vulkan)
static AUDIO_GEN_CURRENT_BACKEND: AtomicI32 = AtomicI32::new(-1); // -1 = not initialized

/// Init params stored inside the worker thread for engine recreation after idle timeout
struct AudioGenWorkerInitParams {
    model_path: std::path::PathBuf,
    variant: crate::audio_gen::AudioGenVariant,
    mnn_gpu: i32,
    mnn_int8: bool,
    default_duration: f32,
}

fn start_audio_gen_worker(
    model_path: std::path::PathBuf,
    variant: crate::audio_gen::AudioGenVariant,
    mnn_gpu: i32,
    mnn_int8: bool,
    default_duration: f32,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<AudioGenRequest>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    {
        let mut guard = AUDIO_GEN_REQUEST_TX
            .lock()
            .map_err(|e| format!("Audio gen channel lock failed: {}", e))?;
        *guard = Some(tx);
    }

    // Store init params for engine recreation after idle timeout
    let init_params = AudioGenWorkerInitParams {
        model_path,
        variant,
        mnn_gpu,
        mnn_int8,
        default_duration,
    };

    std::thread::spawn(move || {
        // Lower thread priority so SA3 inference does not starve the audio callback thread.
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::System::Threading::{
                GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
            };
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }

        log::info!(
            "[AudioGen Worker] Starting on thread {:?}",
            std::thread::current().id()
        );

        let create_engine = |params: &AudioGenWorkerInitParams| -> Result<crate::audio_gen::AudioGenEngine, String> {
            crate::audio_gen::AudioGenEngine::new(
                &params.model_path,
                &params.variant,
                params.mnn_gpu,
                params.mnn_int8,
                params.default_duration,
            ).map_err(|e| format!("Audio gen engine create failed: {}", e))
        };

        match create_engine(&init_params) {
            Ok(engine) => {
                AUDIO_GEN_ENGINE_INITIALIZED.store(true, Ordering::SeqCst);
                AUDIO_GEN_CURRENT_BACKEND.store(init_params.mnn_gpu, Ordering::SeqCst);
                let _ = ready_tx.send(Ok(()));
                log::info!(
                    "[AudioGen Worker] Engine ready on thread {:?}",
                    std::thread::current().id()
                );

                let mut engine_opt = Some(engine);

                loop {
                    // Use idle timeout when engine is loaded; wait indefinitely when unloaded
                    // (the thread will be killed by channel disconnect on reinit instead)
                    let timeout = if engine_opt.is_some() {
                        std::time::Duration::from_secs(AUDIO_GEN_IDLE_TIMEOUT_SECS)
                    } else {
                        std::time::Duration::from_secs(3600)
                    };

                    match rx.recv_timeout(timeout) {
                        Ok(req) => {
                            match req {
                                AudioGenRequest::Generate {
                                    mut opts,
                                    mut output_dir,
                                    mut result_tx,
                                } => {
                                    // Drain any newer requests that were queued after this one.
                                    // Only the latest request matters (e.g., when user rapidly
                                    // switches radio styles). Older ones get cancellation errors.
                                    let mut superseded = 0;
                                    while let Ok(newer) = rx.try_recv() {
                                        // Send error to the older request we're replacing
                                        let _ = result_tx
                                            .send(Err("Superseded by newer request".to_string()));
                                        superseded += 1;
                                        // Keep the newer request's data
                                        let AudioGenRequest::Generate {
                                            opts: new_opts,
                                            output_dir: new_dir,
                                            result_tx: new_tx,
                                        } = newer;
                                        opts = new_opts;
                                        output_dir = new_dir;
                                        result_tx = new_tx;
                                    }
                                    if superseded > 0 {
                                        log::info!(
                                            "[AudioGen Worker] Skipped {} superseded request(s), processing latest",
                                            superseded
                                        );
                                    }

                                    // Clear cancellation flag for this new request
                                    crate::audio_gen::engine::clear_cancel();

                                    // Recreate engine if it was dropped due to idle timeout
                                    if engine_opt.is_none() {
                                        log::info!("[AudioGen Worker] Recreating engine after idle timeout");
                                        match create_engine(&init_params) {
                                            Ok(new_engine) => {
                                                AUDIO_GEN_ENGINE_INITIALIZED
                                                    .store(true, Ordering::SeqCst);
                                                AUDIO_GEN_CURRENT_BACKEND
                                                    .store(init_params.mnn_gpu, Ordering::SeqCst);
                                                engine_opt = Some(new_engine);
                                                log::info!("[AudioGen Worker] Engine recreated on thread {:?}", std::thread::current().id());
                                            }
                                            Err(e) => {
                                                log::error!("[AudioGen Worker] Engine recreation failed: {}", e);
                                                let _ = result_tx.send(Err(e));
                                                continue;
                                            }
                                        }
                                    }

                                    if let Some(ref mut engine) = engine_opt {
                                        log::info!(
                                            "[AudioGen Worker] Generating on thread {:?}: prompt={:?}, duration={}",
                                            std::thread::current().id(),
                                            opts.prompt,
                                            opts.duration
                                        );
                                        let result = std::panic::catch_unwind(
                                            std::panic::AssertUnwindSafe(|| {
                                                engine
                                                    .generate(&opts, &output_dir)
                                                    .map_err(|e| e.to_string())
                                            }),
                                        )
                                        .unwrap_or_else(|_| {
                                            Err("Audio generation panicked (FFI crash)".to_string())
                                        });
                                        let _ = result_tx.send(result);
                                    }
                                }
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            if engine_opt.is_some() {
                                log::info!(
                                    "[AudioGen Worker] Idle timeout ({}s), releasing MNN resources to free CPU",
                                    AUDIO_GEN_IDLE_TIMEOUT_SECS
                                );
                                engine_opt = None;
                                AUDIO_GEN_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
                                AUDIO_GEN_CURRENT_BACKEND.store(-1, Ordering::SeqCst);
                            }
                            // If engine is already None, just continue waiting
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            break;
                        }
                    }
                }

                // Final cleanup
                drop(engine_opt);
                AUDIO_GEN_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
                log::info!("[AudioGen Worker] Channel closed, worker exiting");
            }
            Err(e) => {
                AUDIO_GEN_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
                let _ = ready_tx.send(Err(format!("Audio gen engine init failed: {}", e)));
                log::error!("[AudioGen Worker] Init failed: {}", e);
            }
        }
    });

    ready_rx
        .recv()
        .map_err(|_| "Audio gen worker init channel closed".to_string())?
}

#[tauri::command]
pub async fn init_audio_gen_engine(
    model_dir: String,
    variant: String,
    mnn_gpu: i32,
    mnn_int8: bool,
    default_duration: f32,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _ = &app; // Reserved for future use (e.g., download progress events)
    log::info!(
        "[model_init] init_audio_gen_engine called: model_dir={}, variant={}, mnn_gpu={}, mnn_int8={}",
        model_dir, variant, mnn_gpu, mnn_int8
    );

    // Store init params for potential re-init when switching GPU/CPU backend
    {
        let mut params = AUDIO_GEN_INIT_PARAMS
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *params = Some(AudioGenInitParams {
            model_dir: model_dir.clone(),
            variant: variant.clone(),
            mnn_gpu,
            mnn_int8,
            default_duration,
        });
    }

    // Always use user's preferred GPU setting for SA3 inference.
    let effective_mnn_gpu = mnn_gpu;
    if AUDIO_GEN_ENGINE_INITIALIZED.load(Ordering::SeqCst) {
        log::info!("[model_init] Audio gen engine already initialized");
        return Ok(());
    }

    // Resolve model directory: try user-provided path, then auto-resolve via runtime::get_models_dir()
    let model_path = if !model_dir.is_empty() {
        let p = std::path::PathBuf::from(&model_dir);
        if p.exists() {
            p
        } else {
            return Err(format!(
                "Audio gen model directory does not exist: {}",
                model_dir
            ));
        }
    } else {
        let models_dir = runtime::get_models_dir();
        let sa3_dir = models_dir.join("sa3");
        log::info!(
            "[model_init] Looking for SA3 models at: {:?} (exists={}, tokenizer={})",
            sa3_dir,
            sa3_dir.exists(),
            sa3_dir.join("tokenizer.json").exists()
        );
        if sa3_dir.exists() && sa3_dir.join("tokenizer.json").exists() {
            log::info!("[model_init] Using models/sa3: {:?}", sa3_dir);
            sa3_dir
        } else {
            return Err(format!(
                "models/sa3 directory not found at {:?}. Please place SA3 model files in the models/sa3 directory.",
                sa3_dir
            ));
        }
    };

    // Ensure MNN DLL search path is set
    if let Err(e) = runtime::set_library_search_path() {
        log::warn!("[model_init] Failed to set library search path: {}", e);
    }

    // Also ensure MNN DLL directory is in search path (runtime/mnn/{VERSION}/)
    let mnn_dir = runtime::get_mnn_dir();
    if mnn_dir.exists() {
        log::info!(
            "[model_init] Adding MNN DLL directory to search path: {:?}",
            mnn_dir
        );
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;
            let path_key = "PATH";
            let path_var = std::env::var_os(path_key).unwrap_or_default();
            let mut paths: Vec<_> = std::env::split_paths(&path_var).collect();
            if !paths.contains(&mnn_dir) {
                paths.insert(0, mnn_dir.clone());
            }
            if let Ok(new_path) = std::env::join_paths(paths) {
                std::env::set_var(path_key, new_path);
            }
            let path_wide: Vec<u16> = std::ffi::OsStr::new(&mnn_dir)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            unsafe {
                let _ = windows::Win32::System::LibraryLoader::SetDllDirectoryW(
                    windows::core::PCWSTR(path_wide.as_ptr()),
                );
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let ld_key = if cfg!(target_os = "macos") {
                "DYLD_LIBRARY_PATH"
            } else {
                "LD_LIBRARY_PATH"
            };
            let ld_path = std::env::var(ld_key).unwrap_or_default();
            let new_path = if ld_path.is_empty() {
                mnn_dir.to_string_lossy().to_string()
            } else {
                format!("{}:{}", mnn_dir.to_string_lossy(), ld_path)
            };
            std::env::set_var(ld_key, new_path);
        }
    }

    let audio_gen_variant = match variant.as_str() {
        "sm-music" => crate::audio_gen::AudioGenVariant::Music,
        "sm-sfx" => crate::audio_gen::AudioGenVariant::Sfx,
        _ => return Err(format!("Unknown audio gen variant: {}", variant)),
    };

    // Start dedicated worker thread - MNN model is created AND used on this same thread
    tokio::task::spawn_blocking(move || {
        start_audio_gen_worker(
            model_path,
            audio_gen_variant,
            effective_mnn_gpu,
            mnn_int8,
            default_duration,
        )
    })
    .await
    .map_err(|e| format!("Audio gen engine init task failed: {}", e))?
    .map_err(|e| format!("Audio gen engine init failed: {}", e))?;

    log::info!("[model_init] Audio gen engine initialized successfully");
    Ok(())
}

#[tauri::command]
pub async fn reinit_audio_gen_engine(
    model_dir: String,
    variant: String,
    mnn_gpu: i32,
    mnn_int8: bool,
    default_duration: f32,
    app: tauri::AppHandle,
) -> Result<(), String> {
    log::info!(
        "[model_init] reinit_audio_gen_engine called: model_dir={}, variant={}",
        model_dir,
        variant
    );
    AUDIO_GEN_ENGINE_INITIALIZED.store(false, Ordering::SeqCst);
    // Drop the old channel to stop the old worker thread
    {
        let mut guard = AUDIO_GEN_REQUEST_TX
            .lock()
            .map_err(|e| format!("Audio gen channel lock failed: {}", e))?;
        *guard = None;
    }
    init_audio_gen_engine(model_dir, variant, mnn_gpu, mnn_int8, default_duration, app).await
}

#[tauri::command]
pub async fn generate_audio(
    request: crate::audio_gen::AudioGenOptions,
    app: tauri::AppHandle,
) -> Result<crate::audio_gen::AudioGenResult, String> {
    // Auto-reinitialize if engine was dropped due to idle timeout.
    // The worker thread stays alive but releases MNN models after idle period,
    // so we need to re-init the engine (which recreates models on the worker).
    if !AUDIO_GEN_ENGINE_INITIALIZED.load(Ordering::SeqCst) {
        // Extract data before .await to avoid holding MutexGuard across await point
        let reinit_data = {
            let init_params = AUDIO_GEN_INIT_PARAMS
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            init_params.as_ref().map(|p| {
                let desired_backend = if request.force_cpu { 0 } else { p.mnn_gpu };
                (
                    p.model_dir.clone(),
                    p.variant.clone(),
                    desired_backend,
                    p.mnn_int8,
                    p.default_duration,
                )
            })
        }; // Lock released here before .await
        if let Some((model_dir, variant, backend, mnn_int8, default_duration)) = reinit_data {
            log::info!(
                "[model_init] Engine not initialized (idle timeout or first use), re-initializing"
            );
            init_audio_gen_engine(
                model_dir,
                variant,
                backend,
                mnn_int8,
                default_duration,
                app.clone(),
            )
            .await?;
        } else {
            return Err(
                "Audio gen engine not initialized and no init params available".to_string(),
            );
        }
    }

    // Always use user's preferred GPU setting — no dynamic switching.
    // Unless force_cpu is set (for background radio pre-generation).
    let current_backend = AUDIO_GEN_CURRENT_BACKEND.load(Ordering::SeqCst);

    // Extract preferred GPU and init params before any async operations
    let (preferred_gpu, init_params) = {
        let params = AUDIO_GEN_INIT_PARAMS
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match params.as_ref() {
            Some(p) => (
                p.mnn_gpu,
                Some((
                    p.model_dir.clone(),
                    p.variant.clone(),
                    p.mnn_int8,
                    p.default_duration,
                )),
            ),
            None => (0, None),
        }
    }; // Lock released here

    let desired_backend = if request.force_cpu { 0 } else { preferred_gpu };

    if current_backend != desired_backend {
        let backend_name = |b: i32| -> &'static str {
            match b {
                1 => "CUDA",
                2 => "Vulkan",
                _ => "CPU",
            }
        };
        log::info!(
            "[model_init] Switching SA3 backend: {} → {} (preferred_gpu={})",
            backend_name(current_backend),
            backend_name(desired_backend),
            preferred_gpu,
        );

        // Re-init with the desired backend
        if let Some((model_dir, variant, mnn_int8, default_duration)) = init_params {
            reinit_audio_gen_engine(
                model_dir,
                variant,
                desired_backend,
                mnn_int8,
                default_duration,
                app.clone(),
            )
            .await?;
        }
    }

    let output_dir = runtime::get_app_root_dir().join("audio_gen_output");

    // Send request to the dedicated worker thread via channel
    let (result_tx, result_rx) =
        mpsc::channel::<Result<crate::audio_gen::AudioGenResult, String>>();
    {
        let guard = AUDIO_GEN_REQUEST_TX
            .lock()
            .map_err(|e| format!("Audio gen channel lock failed: {}", e))?;
        let tx = guard
            .as_ref()
            .ok_or("Audio gen worker not ready".to_string())?;
        // Signal the in-flight generation to abort early.
        // The SA3 denoise loop checks this between steps and returns Err.
        // The worker also drains queued requests, keeping only the latest.
        crate::audio_gen::engine::signal_cancel();
        tx.send(AudioGenRequest::Generate {
            opts: request,
            output_dir,
            result_tx,
        })
        .map_err(|e| format!("Audio gen send failed: {}", e))?;
    }

    // Wait for result from the worker thread
    let result = result_rx
        .recv()
        .map_err(|e| format!("Audio gen receive failed: {}", e))?;

    match result {
        Ok(res) => {
            let _ = app.emit(
                "audio_gen-event",
                serde_json::to_value(AudioGenEvent::GenerateDone {
                    file_path: res.file_path.clone(),
                    duration_secs: res.duration_secs,
                    sample_rate: res.sample_rate,
                    channels: res.channels,
                })
                .unwrap_or_default(),
            );
            Ok(res)
        }
        Err(e) => {
            log::error!("[AudioGen] Generate failed: {}", e);
            let _ = app.emit(
                "audio_gen-event",
                serde_json::to_value(AudioGenEvent::GenerateError {
                    error: e.to_string(),
                })
                .unwrap_or_default(),
            );
            Err(format!("Audio generation failed: {}", e))
        }
    }
}

#[tauri::command]
pub fn get_audio_gen_status() -> Result<bool, String> {
    Ok(AUDIO_GEN_ENGINE_INITIALIZED.load(Ordering::SeqCst))
}

#[tauri::command]
pub fn check_audio_gen_models(
    model_dir: String,
    variant: String,
    mnn_int8: bool,
    mnn_t5_fp32: bool,
) -> Result<crate::audio_gen::AudioGenModelStatus, String> {
    let models_path = std::path::PathBuf::from(&model_dir);
    Ok(crate::audio_gen::check_audio_gen_models(
        &models_path,
        &variant,
        mnn_int8,
        mnn_t5_fp32,
    ))
}

#[derive(Clone, Serialize)]
pub struct MnnGpuInfo {
    pub cuda_available: bool,
    pub vulkan_available: bool,
    pub recommended_backend: i32, // 0=CPU, 1=CUDA, 2=Vulkan
}

#[tauri::command]
pub fn detect_mnn_gpu() -> MnnGpuInfo {
    let cuda_available = check_cuda_available();
    let vulkan_available = check_vulkan_available();
    let recommended_backend = if cuda_available {
        1 // CUDA first
    } else if vulkan_available {
        2 // Vulkan second
    } else {
        0 // CPU fallback
    };
    log::info!(
        "[model_init] MNN GPU detect: cuda={}, vulkan={}, recommended={}",
        cuda_available,
        vulkan_available,
        recommended_backend
    );
    MnnGpuInfo {
        cuda_available,
        vulkan_available,
        recommended_backend,
    }
}

fn check_cuda_available() -> bool {
    // Check if CUDA runtime DLL exists in PATH or common locations
    #[cfg(target_os = "windows")]
    {
        // Try loading cudart64 DLL
        for name in &["cudart64_12.dll", "cudart64_110.dll", "cudart64_10.dll"] {
            if let Ok(lib) = unsafe { libloading::Library::new(*name) } {
                std::mem::forget(lib);
                return true;
            }
        }
        // Also check if MNN was built with CUDA by checking if MNN_CUDA is available
        let mnn_dir = runtime::get_mnn_dir();
        if mnn_dir.exists() {
            // If MNN.dll exists and CUDA runtime is in PATH, MNN CUDA should work
            for entry in std::fs::read_dir(&mnn_dir)
                .unwrap_or_else(|_| {
                    std::fs::create_dir_all(&mnn_dir).ok();
                    std::fs::read_dir(&mnn_dir).unwrap_or_else(|_| panic!("Cannot read MNN dir"))
                })
                .flatten()
            {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with("cudart") || name_str.starts_with("cublas") {
                    return true;
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for name in &["libcudart.so", "libcudart.so.12", "libcudart.so.11"] {
            if let Ok(lib) = unsafe { libloading::Library::new(*name) } {
                std::mem::forget(lib);
                return true;
            }
        }
    }
    false
}

fn check_vulkan_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        if let Ok(lib) = unsafe { libloading::Library::new("vulkan-1.dll") } {
            std::mem::forget(lib);
            return true;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for name in &["libvulkan.so", "libvulkan.so.1", "libMoltenVK.dylib"] {
            if let Ok(lib) = unsafe { libloading::Library::new(*name) } {
                std::mem::forget(lib);
                return true;
            }
        }
    }
    false
}
