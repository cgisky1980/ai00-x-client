use async_trait::async_trait;
use std::sync::Arc;
use std::sync::OnceLock;

#[async_trait]
pub trait RwkvInferenceEngine: Send + Sync {
    async fn infer(
        &self,
        prompt: String,
        max_tokens: usize,
        temperature: f32,
        top_p: f32,
        stop: Vec<String>,
    ) -> Result<String, String>;

    /// Single-shot classification: classifies a raw user request into four
    /// tier probabilities (R0-R3, order preserved).
    ///
    /// Implemented on desktop as mean-hidden extraction (state embedding) +
    /// trained MLP head. Returns an error when unsupported, the head is
    /// missing, or the engine is unavailable.
    ///
    /// `prev_tier`: tier routed for the previous turn of the same session
    /// (sticky-tier value; 0-3), `None` on the first turn/unknown. v4 heads
    /// feed it as a one-hot feature; v1 heads ignore it.
    async fn classify(
        &self,
        _request: String,
        _prev_tier: Option<u8>,
    ) -> Result<Vec<f32>, String> {
        Err("classify not supported by this engine".to_string())
    }

    fn cancel(&self) -> Result<(), String>;

    fn is_initialized(&self) -> bool;
}

static GLOBAL_RWKV_ENGINE: OnceLock<Arc<dyn RwkvInferenceEngine>> = OnceLock::new();

pub fn register_rwkv_engine(engine: Arc<dyn RwkvInferenceEngine>) {
    let _ = GLOBAL_RWKV_ENGINE.set(engine);
}

pub fn get_rwkv_engine() -> Option<Arc<dyn RwkvInferenceEngine>> {
    GLOBAL_RWKV_ENGINE.get().cloned()
}
