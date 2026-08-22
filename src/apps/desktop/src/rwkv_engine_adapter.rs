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
            // top_k 必须 ≤50：CUDA 采样 kernel 快速路径上限（MAXK=50）。此前
            // 硬编码 128 会落入 512 轮全词表归约的兜底慢路径（token 级秒级），
            // smart-router 的摘要生成因此实际不可用。
            50,
            0.0,
            0.0,
            0.99654026_f32,
            Some(stop),
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

    async fn classify(
        &self,
        request: String,
        prev_tier: Option<u8>,
    ) -> Result<Vec<f32>, String> {
        rwkv_llm::rwkv_classify(request, prev_tier).await
    }

    fn is_initialized(&self) -> bool {
        rwkv_llm::is_llm_initialized()
    }
}
