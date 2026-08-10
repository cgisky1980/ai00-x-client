use ai00_x_ai_adapters::providers::rwkv::engine::RwkvInferenceEngine;
use async_trait::async_trait;

use crate::rwkv_llm;

fn bump_cancel_epoch() {
    let epoch = rwkv_llm::cancel_epoch();
    epoch.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

pub struct DesktopRwkvEngine;

#[async_trait]
impl RwkvInferenceEngine for DesktopRwkvEngine {
    async fn infer(
        &self,
        prompt: String,
        max_tokens: usize,
        _temperature: f32,
        top_p: f32,
        stop: Vec<String>,
    ) -> Result<String, String> {
        let mut rx = rwkv_llm::pool_infer(
            prompt,
            max_tokens,
            top_p,
            128,
            0.0,
            0.0,
            0.99654026_f32,
            Some(stop),
            None,
            None,
            false,
            false,
            String::new(),
        )
        .await?;

        let mut text = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                rwkv_llm::InferenceEvent::Token(t) => text.push_str(&t),
                rwkv_llm::InferenceEvent::Done { text: t, .. } => {
                    text = t;
                    break;
                }
                rwkv_llm::InferenceEvent::Error(e) => return Err(e),
            }
        }
        Ok(text)
    }

    fn cancel(&self) -> Result<(), String> {
        bump_cancel_epoch();
        Ok(())
    }

    fn is_initialized(&self) -> bool {
        rwkv_llm::is_llm_initialized()
    }
}
