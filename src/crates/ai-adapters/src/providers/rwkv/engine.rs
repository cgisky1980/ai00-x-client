use async_trait::async_trait;
use std::sync::Arc;
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct RwkvChoiceScore {
    /// 在入参 `choices` 里的下标（升序排列后仍可回溯）。
    pub index: usize,
    /// 升序名次（`0` = 最优）。
    pub rank: usize,
    /// 候选原文本。
    pub choice: String,
    /// 平均 NLL，**越小越优**（字段名沿用 `/v1/chooses` 的 `perplexity`）。
    pub perplexity: f32,
}

#[async_trait]
pub trait RwkvInferenceEngine: Send + Sync {
    #[allow(clippy::too_many_arguments)]
    async fn infer(
        &self,
        prompt: String,
        max_tokens: usize,
        temperature: f32,
        top_p: f32,
        stop: Vec<String>,
        presence_penalty: f32,
        frequency_penalty: f32,
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
    ///
    /// `capture`: true = 真实路由请求（进化数据回流采集 hidden 样本）；
    /// false = 无状态预览/测试（不采集）。
    async fn classify(
        &self,
        _request: String,
        _prev_tier: Option<u8>,
        _capture: bool,
    ) -> Result<Vec<f32>, String> {
        Err("classify not supported by this engine".to_string())
    }

    /// Candidate scoring (Jev-style: one forward pass, zero generated tokens):
    /// mean NLL per candidate, ascending (`rank = 0` is the best). `prompt` and
    /// every candidate are tokenized **verbatim** — no chat template — which is
    /// what makes the scores comparable across hosts (desktop engine, mytown's
    /// `model-server`, the reference `ai00-server`).
    ///
    /// Requires logits access, so only the local RWKV engine implements it;
    /// remote/other engines keep the default error and callers fall back to
    /// `infer`. Not wired into SmartRouter this round.
    async fn choose(
        &self,
        _prompt: String,
        _choices: Vec<String>,
        _calibrate: bool,
    ) -> Result<Vec<RwkvChoiceScore>, String> {
        Err("choose not supported by this engine".to_string())
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
