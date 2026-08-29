//! ManagedEngine implementations for the ASR / TTS / AudioGen workers
//! (see `model_init.rs`). Each engine exposes an evict command channel that
//! its worker polls; `evict()` blocks until the engine confirmed unload.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::vram_manager::{notify_state, ManagedEngine};

/// Poll interval for worker loops: bounds eviction-command latency while
/// keeping CPU cost negligible.
pub const WORKER_POLL_MS: u64 = 500;

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

pub(crate) struct WorkerControl {
    pub evict_tx: Mutex<Option<mpsc::Sender<()>>>,
    pub initialized: &'static AtomicBool,
    pub last_used: AtomicU64,
    pub engine_id: &'static str,
    pub display_name: &'static str,
    /// Conservative VRAM footprint used for budget checks before first load.
    pub estimate_bytes: Option<u64>,
}

impl WorkerControl {
    pub fn touch(&self) {
        self.last_used
            .store(now_ms(), std::sync::atomic::Ordering::Relaxed);
    }

    /// Last-use timestamp in ms (delegating read for worker loops).
    pub fn last_used_ms(&self) -> u64 {
        self.last_used.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Estimated VRAM bytes (delegating read for budget checks).
    pub fn estimate_vram_bytes(&self) -> Option<u64> {
        self.estimate_bytes
    }

    fn send_evict(&self) -> Result<(), String> {
        let tx = self
            .evict_tx
            .lock()
            .map_err(|e| format!("evict channel poisoned: {e}"))?
            .clone();
        let Some(tx) = tx else {
            // Worker not started yet — nothing to evict.
            return Ok(());
        };
        tx.send(()).map_err(|_| "worker gone".to_string())?;
        // Wait until the worker confirmed unload (10s cap).
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if !self.initialized.load(Ordering::SeqCst) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(format!("{} evict timed out", self.engine_id))
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

macro_rules! worker_engine_impl {
    ($control:expr, $prio:expr) => {
        fn id(&self) -> &str {
            $control.engine_id
        }
        fn display_name(&self) -> String {
            $control.display_name.to_string()
        }
        fn priority(&self) -> i32 {
            $prio
        }
        fn is_resident(&self) -> bool {
            $control.initialized.load(Ordering::SeqCst)
        }
        fn estimate_vram_bytes(&self) -> Option<u64> {
            $control.estimate_bytes
        }
        fn last_used_ms(&self) -> u64 {
            $control.last_used_ms()
        }
        fn evict(&self) -> Result<(), String> {
            $control.send_evict()
        }
    };
}

// ---------------------------------------------------------------------------
// ASR
// ---------------------------------------------------------------------------

static ASR_CONTROL: WorkerControl = WorkerControl {
    evict_tx: Mutex::new(None),
    initialized: &crate::model_init::ASR_ENGINE_INITIALIZED,
    last_used: AtomicU64::new(0),
    engine_id: "asr",
    display_name: "语音识别",
    estimate_bytes: Some(1_500 * 1024 * 1024),
};

pub(crate) fn asr_control() -> &'static WorkerControl {
    &ASR_CONTROL
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

static TTS_CONTROL: WorkerControl = WorkerControl {
    evict_tx: Mutex::new(None),
    initialized: &crate::model_init::TTS_ENGINE_INITIALIZED,
    last_used: AtomicU64::new(0),
    engine_id: "tts",
    display_name: "语音合成",
    estimate_bytes: Some(3_000 * 1024 * 1024),
};

pub(crate) fn tts_control() -> &'static WorkerControl {
    &TTS_CONTROL
}

// ---------------------------------------------------------------------------
// AudioGen (MNN, CPU — governed for RAM release, not VRAM)
// ---------------------------------------------------------------------------

static AUDIO_GEN_CONTROL: WorkerControl = WorkerControl {
    evict_tx: Mutex::new(None),
    initialized: &crate::model_init::AUDIO_GEN_ENGINE_INITIALIZED,
    last_used: AtomicU64::new(0),
    engine_id: "audio-gen",
    display_name: "音频生成",
    estimate_bytes: None,
};

pub(crate) fn audio_gen_control() -> &'static WorkerControl {
    &AUDIO_GEN_CONTROL
}

// ---------------------------------------------------------------------------
// ManagedEngine wrappers
// ---------------------------------------------------------------------------

struct AsrEngine;
impl ManagedEngine for AsrEngine {
    worker_engine_impl!(ASR_CONTROL, 1);
}

struct TtsEngine;
impl ManagedEngine for TtsEngine {
    worker_engine_impl!(TTS_CONTROL, 1);
}

struct AudioGenEngine;
impl ManagedEngine for AudioGenEngine {
    worker_engine_impl!(AUDIO_GEN_CONTROL, 2);
}

// ---------------------------------------------------------------------------
// qwen3_fa (forced aligner — status reporting only, DLL is process-lifetime)
// ---------------------------------------------------------------------------

struct Qwen3FaEngine;
impl ManagedEngine for Qwen3FaEngine {
    fn id(&self) -> &str {
        "qwen3-fa"
    }
    fn display_name(&self) -> String {
        "语音对齐".to_string()
    }
    fn priority(&self) -> i32 {
        3
    }
    fn is_resident(&self) -> bool {
        // DLL 符号进程生命周期缓存，加载后常驻（显存占用小）。
        true
    }
    fn estimate_vram_bytes(&self) -> Option<u64> {
        Some(300 * 1024 * 1024)
    }
    fn last_used_ms(&self) -> u64 {
        0
    }
    fn evict(&self) -> Result<(), String> {
        Err("qwen3-fa does not support eviction".to_string())
    }
}

/// Register all governed engines with the VRAM manager (idempotent).
pub fn register_worker_engines() {
    static DONE: std::sync::Once = std::sync::Once::new();
    DONE.call_once(|| {
        crate::vram_manager::register_engine(Arc::new(AsrEngine));
        crate::vram_manager::register_engine(Arc::new(TtsEngine));
        crate::vram_manager::register_engine(Arc::new(AudioGenEngine));
        crate::vram_manager::register_engine(Arc::new(Qwen3FaEngine));
        crate::api::acestep_api::register_with_vram_manager();
    });
}

// ---------------------------------------------------------------------------
// Worker-loop helpers
// ---------------------------------------------------------------------------

/// Evict command channel: (shared tx stored in control, worker-side rx).
pub type EvictChannel = (Arc<Mutex<Option<mpsc::Sender<()>>>>, mpsc::Receiver<()>);

/// Create the evict channel for a worker.
pub fn evict_channel() -> EvictChannel {
    let (tx, rx) = mpsc::channel::<()>();
    (Arc::new(Mutex::new(Some(tx))), rx)
}

/// Whether the engine should be idle-unloaded now.
/// `keep_alive < 0` never times out; `0` unloads right after each use.
pub fn idle_expired(engine_id: &str, built_in_priority: i32, last_used_ms: u64) -> bool {
    let ka = crate::vram_manager::resolve_policy(engine_id, built_in_priority).keep_alive_secs;
    if ka < 0 {
        return false;
    }
    now_ms().saturating_sub(last_used_ms) >= (ka as u64) * 1000
}

/// Notify the manager that an engine was unloaded (idle timeout or eviction).
pub fn notify_unloaded(engine_id: &str, display: &str, reason: &str) {
    notify_state(engine_id, display, false, reason);
}
