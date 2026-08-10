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
