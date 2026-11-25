//! Ai00-X AI 网关：dsh `@ai00-x/ai-bridge` 插件的统一 LLM 入口。
//!
//! 端点（挂本地内嵌 Salvo 2100，仅本机监听）：
//! - `POST /ai00-internal/llm/v1/chat/completions` — OpenAI 兼容（含 SSE 流式）
//! - `POST /ai00-internal/llm/v1/chooses` — 候选 NLL 打分（仅本地 RWKV，零生成 token）
//! - `GET  /ai00-internal/llm/v1/models` — 逻辑模型列表
//!
//! 分流策略（按请求 `model` 字段）：
//! - `ai00-auto`（默认）→ SmartRouter（本地 RWKV classify R0-R3）：
//!   R0/R1 → 本地 RWKV；R2/R3 → AI00-API（primary 模型转发）
//! - 带 tools 且全部在本地白名单 → 混合工具循环（M1.3，默认开）：工具轮
//!   本地 RWKV 零状态临时会话，收敛后远端基于折叠历史合成终答
//! - `rwkv-local`  → 强制本地 RWKV
//! - `ai00-api`    → 强制远程转发（AI00-API primary 模型；旧 id 仅作兼容别名）
//! - 其他引用（`ai00s:<子模型>` / `gguf-local:<路径>` / 自定义 id）→ 按引用
//!   经 client_factory 解析转发——与讨论通道（plugin_ai_complete）同一解析链，
//!   dsh 执行会话可以和策讨论选到完全相同的模型，不再静默并入智能路由。
//!
//! 所有远程转发在 `forward_to_ai00_salvo` 入口做工具段历史折叠（M1.3）。
//!
//! 鉴权：`X-Ai00-Internal-Token` 头匹配 `AI00_S_INTERNAL_TOKEN`（回退默认值）。

use bytes::Bytes;
use futures::StreamExt;
use salvo::http::StatusCode;
use salvo::prelude::*;
use serde_json::{json, Value};

use ai00_x_core::infrastructure::ai::client_factory::{ai00_s_internal_token, AIClientFactory};
use ai00_x_core::routing::get_smart_router;
use ai00_x_core::routing::RouteClass;
use ai00_x_core::service::config::get_global_config_service;
/// 工具名归一（本地小模型写坏工具名时按编辑距离映射回真实名；
/// 实现在 core，纯函数可在 core 侧单测）。
use ai00_x_core::util::tool_name::normalize_tool_name;

use crate::rwkv_llm::{pool_infer, InferenceEvent};

/// 逻辑模型 id（对 dsh provider UI 暴露）。
pub const MODEL_AUTO: &str = "ai00-auto";
pub const MODEL_RWKV: &str = "rwkv-local";
/// 远端网关（AI00-API）入口：按配置的 primary 槽转发。
pub const MODEL_REMOTE: &str = "ai00-api";
/// 旧入口 id 的兼容别名：仅接受，不再对外通告（存量会话/配置迁移用）。
pub const MODEL_REMOTE_LEGACY: &str = "ai00-salvo";

#[derive(Debug, Clone, Copy, Default)]
struct GatewayTokenUsage {
    prompt: u32,
    completion: u32,
    cached_prompt: Option<u32>,
}

impl GatewayTokenUsage {
    fn from_openai(value: &Value) -> Option<Self> {
        let usage = value.get("usage")?;
        let prompt = usage.get("prompt_tokens")?.as_u64()?;
        let completion = usage.get("completion_tokens")?.as_u64()?;
        // 缓存命中字段各家不一：OpenAI 走 prompt_tokens_details.cached_tokens，
        // DeepSeek 走 prompt_cache_hit_tokens，Anthropic 走 cache_read_input_tokens，
        // 部分网关用 input_tokens_details。逐一兜底，命中任一即可。
        let cached = usage
            .get("prompt_tokens_details")
            .and_then(|v| v.get("cached_tokens"))
            .and_then(Value::as_u64)
            .or_else(|| usage.get("prompt_cache_hit_tokens").and_then(Value::as_u64))
            .or_else(|| usage.get("cache_read_input_tokens").and_then(Value::as_u64))
            .or_else(|| {
                usage
                    .get("input_tokens_details")
                    .and_then(|v| v.get("cached_tokens"))
                    .and_then(Value::as_u64)
            });
        Some(Self {
            prompt: u32::try_from(prompt).unwrap_or(u32::MAX),
            completion: u32::try_from(completion).unwrap_or(u32::MAX),
            cached_prompt: cached.map(|v| u32::try_from(v).unwrap_or(u32::MAX)),
        })
    }
}

fn gateway_usage_from_sse_line(line: &str) -> Option<GatewayTokenUsage> {
    let data = line.trim().strip_prefix("data:")?.trim();
    if data == "[DONE]" {
        return None;
    }
    let value = serde_json::from_str::<Value>(data).ok()?;
    GatewayTokenUsage::from_openai(&value)
}

/// dsh 网关调用的计量上下文。只负责观测，不改变模型路由决策。
#[derive(Clone)]
struct GatewayUsage {
    session_id: Option<String>,
    requested_model: String,
    route: String,
    fallback_reason: Option<String>,
    /// 本次请求发往服务端的 `X-Request-Id`（服务端计费账本同值，用于对账积分）。
    request_id: Option<String>,
    /// 本回合已完成的工具轮数（观测值，用于验证熔断是否按预期生效）。
    tool_rounds: Option<usize>,
    started: std::time::Instant,
}

impl GatewayUsage {
    fn new(session_id: Option<String>, requested_model: String, route: &str) -> Self {
        Self {
            session_id,
            requested_model,
            route: route.to_string(),
            fallback_reason: None,
            request_id: None,
            tool_rounds: None,
            started: std::time::Instant::now(),
        }
    }

    fn with_tool_rounds(&self, rounds: usize) -> Self {
        let mut next = self.clone();
        next.tool_rounds = Some(rounds);
        next
    }

    fn with_request_id(&self, request_id: String) -> Self {
        let mut next = self.clone();
        next.request_id = Some(request_id);
        next
    }

    fn with_route(&self, route: &str) -> Self {
        let mut next = self.clone();
        next.route = route.to_string();
        next
    }

    fn with_fallback(&self, reason: String) -> Self {
        let mut next = self.clone();
        next.fallback_reason = Some(reason);
        next
    }

    async fn record(
        &self,
        actual_model: &str,
        local: bool,
        usage: Option<GatewayTokenUsage>,
        ttft_ms: Option<u64>,
    ) {
        let usage_known = usage.is_some();
        let usage = usage.unwrap_or_default();
        crate::api::ai_usage_api::record_usage(crate::api::ai_usage_api::AiUsageRecord {
            at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            plugin_id: "dsh-agent".to_string(),
            tag: None,
            model: actual_model.to_string(),
            local,
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            latency_ms: self.started.elapsed().as_millis() as u64,
            ttft_ms,
            tool_rounds: self.tool_rounds,
            session_id: self.session_id.clone(),
            requested_model: Some(self.requested_model.clone()),
            route: Some(self.route.clone()),
            fallback_reason: self.fallback_reason.clone(),
            cached_prompt_tokens: usage.cached_prompt,
            usage_known: Some(usage_known),
            request_id: self.request_id.clone(),
        })
        .await;
    }
}

const INTERNAL_TOKEN_HEADER: &str = "x-ai00-internal-token";

/// 网关响应禁止缓存。
#[handler]
async fn no_cache(res: &mut Response) {
    res.headers_mut().insert(
        salvo::http::header::CACHE_CONTROL,
        salvo::http::HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
}

/// 挂到主 router 的网关子路由（外层 server.rs 已挂 "ai00-internal" 前缀）。
pub fn router() -> Router {
    Router::with_path("llm")
        .push(
            Router::with_path("v1/models")
                .hoop(no_cache)
                .get(list_models),
        )
        .push(
            Router::with_path("v1/chat/completions")
                .hoop(no_cache)
                .post(chat_completions),
        )
        .push(Router::with_path("v1/chooses").hoop(no_cache).post(chooses))
}

/// 收集配置里出现的 `ai00s:<子模型>` 引用（去重、保序）。
///
/// 这些是 AI00-API 的真实模型（默认主模型 / 快速模型 / 各 agent 绑定），
/// 通告给 dsh 后弹层显示具体模型名，而不是网关入口本身。
fn configured_ai00s_refs(ai: &ai00_x_core::service::config::AIConfig) -> Vec<String> {
    let mut refs: Vec<String> = Vec::new();
    let mut push = |value: Option<&String>| {
        if let Some(v) = value {
            let v = v.trim();
            if v.starts_with("ai00s:") && !refs.iter().any(|r| r == v) {
                refs.push(v.to_string());
            }
        }
    };
    push(ai.default_models.primary.as_ref());
    push(ai.default_models.fast.as_ref());
    for v in ai.agent_models.values() {
        push(Some(v));
    }
    for v in ai.func_agent_models.values() {
        push(Some(v));
    }
    refs
}

/// 拉取服务端模型目录（公开端点 `/ai00-s/api/ai/models`），返回全部子模型。
///
/// 网关只做「补通告」：服务端有、本机配置里没绑定的子模型也要让引擎能选，
/// 否则模型选择器可见但 `session/model-unavailable`。失败返回空，不影响列表。
///
/// 注意：**不再按 `locked` 过滤**（2026-11-08 用户要求「模型先都别上锁」）。
/// 是否可用交由服务端在真正调用时判定（未授权会返回 401/额度错误，UI 有人话提示）；
/// 过滤掉则引擎目录里根本没有该模型，选择器直接少项、用户误以为服务器没有。
async fn fetch_remote_ai00s_models(base_url: &str) -> Vec<(String, String)> {
    let url = format!("{}/ai00-s/api/ai/models", base_url.trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    body.get("data")
        .and_then(|d| d.get("data"))
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id")?.as_str()?.trim().to_string();
                    if id.is_empty() {
                        return None;
                    }
                    let name = m
                        .get("display_name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or(&id)
                        .to_string();
                    Some((id, name))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[handler]
async fn list_models(res: &mut Response) {
    // 静态逻辑模型 + 用户已配置的具体模型引用（讨论通道同源，dsh 侧
    // 模型选择器可见可选；桥按 id 透传回网关按引用解析）。
    // ai00-auto 不再广告（弹层去 auto）：主会话钉远端、编排 worker 内部
    // 使用该 id 走 SmartRouter，分流语义保留（存量会话/aux 兼容）。
    let mut data = vec![
        json!({"id": MODEL_RWKV,   "object": "model", "name": "Ai00-X Local RWKV", "contextWindow": 16384, "owned_by": "ai00-x"}),
        json!({"id": MODEL_REMOTE, "object": "model", "name": "AI00-API", "contextWindow": 128000, "owned_by": "ai00-x"}),
    ];
    if let Ok(service) = get_global_config_service() {
        if let Ok(config) = service
            .get_config::<ai00_x_core::service::config::GlobalConfig>(None)
            .await
        {
            // AI00-API 的具体子模型（default_models / agent_models 里配置的
            // `ai00s:<子模型>`）逐个通告——dsh 弹层里看到的是真实模型名，
            // 而不是网关入口本身。contextWindow 不低于 AI00-API 入口的 128k：
            // 引擎在「窗口变小」时会拒绝切换并保留原模型，本地 RWKV→远端
            // 这类放大切换才不会卡住。
            let ai00s_cw = config
                .ai
                .models
                .iter()
                .find(|m| m.id == "ai00s")
                .and_then(|m| m.context_window)
                .filter(|v| *v > 0)
                .unwrap_or(128_000)
                .max(128_000);
            // 服务端目录先拉：既用于补通告，也用于裁剪已下架的存量引用。
            // 失败静默沿用配置项（离线时不能把可用模型也裁掉）。
            let server_models = fetch_remote_ai00s_models(&config.app.ai00_s_base_url).await;
            let known_subs: Option<std::collections::HashSet<String>> = if server_models.is_empty()
            {
                None
            } else {
                Some(server_models.iter().map(|(id, _)| id.clone()).collect())
            };
            for sub in configured_ai00s_refs(&config.ai) {
                let name = sub.strip_prefix("ai00s:").unwrap_or(&sub).to_string();
                // 下架/改名后的存量引用（如 GLM-4.7-Flash）不再通告：否则引擎会把
                // 会话切到必然 404 的模型，用户看到的就是 upstream model_not_found。
                if let Some(known) = &known_subs {
                    if !known.contains(&name) {
                        log::warn!("[Gateway] drop stale ai00s ref from model list: {name}");
                        continue;
                    }
                }
                data.push(json!({
                    "id": sub,
                    "object": "model",
                    "name": name,
                    "contextWindow": ai00s_cw,
                    "owned_by": "ai00-x",
                }));
            }
            // 服务端目录补通告：本机配置没绑定的子模型（未锁定）也要可选，
            // 否则选择器里看不到 / 引擎拒绝会话模型。
            for (sub_id, display) in &server_models {
                let ref_id = format!("ai00s:{sub_id}");
                if data.iter().any(|v| v["id"] == ref_id) {
                    continue;
                }
                data.push(json!({
                    "id": ref_id,
                    "object": "model",
                    "name": display,
                    "contextWindow": ai00s_cw,
                    "owned_by": "ai00-x",
                }));
            }
            for m in &config.ai.models {
                // "ai00s" 裸别名条目与 AI00-API 入口语义重叠，不下发
                if m.id.is_empty() || m.id == MODEL_RWKV || m.id == MODEL_AUTO || m.id == "ai00s" {
                    continue;
                }
                // contextWindow 随目录下发——dsh 桥透传给引擎，压缩预算据此计算
                let cw = m.context_window.filter(|v| *v > 0).unwrap_or(32768);
                data.push(json!({
                    "id": m.id,
                    "object": "model",
                    "name": if m.name.is_empty() { m.id.clone() } else { m.name.clone() },
                    "contextWindow": cw,
                    "owned_by": "ai00-x",
                }));
            }
        }
    }
    res.body(json!({"object": "list", "data": data}).to_string());
}

/// 候选打分（Jev 式：单次前向、零生成 token）。请求体与 mytown `model-server` 的
/// `/v1/chooses` 同形（照参照 `ai00-server/src/api/oai/choose.rs`）：
/// `{"input":["prompt 分段…"] | "prompt":"…", "choices":[…], "calibrate":false}`，
/// 响应 `{"object":"list","model":…,"data":[{"object":"choice","index","rank",
/// "choice","perplexity"}]}`，`data` 按分数**升序**（`rank=0` 最优；`perplexity`
/// 其实是平均 NLL，越小越优）。
///
/// ⚠ 只走本地 RWKV：打分要读 logits，远端 provider 无此能力；引擎未加载即 502，
/// 上游自行决定回落（SmartRouter 本轮不接这条路）。
#[handler]
async fn chooses(req: &mut Request, res: &mut Response) {
    let expected = ai00_s_internal_token();
    let provided = req
        .headers()
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if provided != expected {
        res.status_code(StatusCode::UNAUTHORIZED);
        res.body(json!({"error": {"message": "invalid internal token"}}).to_string());
        return;
    }

    let body: Value = match req.parse_json().await {
        Ok(v) => v,
        Err(e) => {
            res.status_code(StatusCode::BAD_REQUEST);
            res.body(json!({"error": {"message": format!("invalid json: {e}")}}).to_string());
            return;
        }
    };
    // `input` 是分段数组（参照口径，拼接即 prompt）；也接受 `prompt` 单串方便 curl。
    let prompt = match body.get("input") {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => body
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    };
    let choices: Vec<String> = body
        .get("choices")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let calibrate = body
        .get("calibrate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if prompt.is_empty() || choices.is_empty() {
        res.status_code(StatusCode::BAD_REQUEST);
        res.body(json!({"error": {"message": "input/prompt 与 choices 均不能为空"}}).to_string());
        return;
    }

    match crate::rwkv_llm::rwkv_choose(prompt, choices, calibrate).await {
        Ok(rows) => {
            let data: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "object": "choice",
                        "index": r.index,
                        "rank": r.rank,
                        "choice": r.choice,
                        "perplexity": r.perplexity,
                    })
                })
                .collect();
            res.body(json!({"object": "list", "model": MODEL_RWKV, "data": data}).to_string());
        }
        Err(e) => {
            log::warn!("[ai-gateway] choose failed: {e}");
            res.status_code(StatusCode::BAD_GATEWAY);
            res.body(json!({"error": {"message": e}}).to_string());
        }
    }
}

/// 从破损 JSON 字符串里抢救第一个平衡的对象/数组（处理 `{...}{...}` 拼接、
/// 前导垃圾；不平衡输入放弃）。web_extract 本地筛选 JSON 解析复用。
/// 首个候选 parse 失败时继续尝试后续候选（模型可能先复述模板再输出真 JSON）。
pub(crate) fn salvage_balanced_json(s: &str) -> Option<Value> {
    let bytes = s.as_bytes();
    let mut start = 0;
    while start < bytes.len() {
        // 找下一个 '{' / '[' 候选起点
        let i = bytes[start..]
            .iter()
            .position(|&b| b == b'{' || b == b'[')
            .map(|p| start + p)?;
        let mut depth = 0i32;
        let mut in_str = false;
        let mut esc = false;
        let mut balanced_end = None;
        for (j, &b) in bytes[i..].iter().enumerate() {
            if in_str {
                if esc {
                    esc = false;
                } else if b == b'\\' {
                    esc = true;
                } else if b == b'"' {
                    in_str = false;
                }
                continue;
            }
            match b {
                b'"' => in_str = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        balanced_end = Some(i + j);
                        break;
                    }
                }
                _ => {}
            }
        }
        match balanced_end {
            Some(end) => {
                if let Ok(v) = serde_json::from_str(&s[i..=end]) {
                    return Some(v);
                }
                // 该候选不是合法 JSON（如模板复述）：从下一字节继续找候选
                start = i + 1;
            }
            None => return None, // 不平衡：没有更多候选
        }
    }
    None
}

/// 入站清洗历史消息里的 `tool_calls[].function.arguments`：llama-server 渲染
/// 模板前会把 string arguments 严格 parse 成 JSON，小模型偶发拼接/截断输出
/// 会 500 毒死整个会话（2026-09-10 实录）。合法 string 原样保留（OpenAI 规范
/// arguments 为 string，远程端点要求）；仅修复非法值——抢救失败则替换 "{}"。
/// 返回修复条数。
fn sanitize_tool_call_args(body: &mut Value) -> usize {
    let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return 0;
    };
    let mut fixed = 0;
    for message in messages.iter_mut() {
        let Some(calls) = message.get_mut("tool_calls").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        for call in calls.iter_mut() {
            let Some(func) = call.get_mut("function") else {
                continue;
            };
            let Some(raw) = func.get("arguments").and_then(|v| v.as_str()) else {
                continue; // 已是 object 或缺失——不动
            };
            if serde_json::from_str::<Value>(raw).is_ok() {
                continue; // 合法 string：保持类型不变
            }
            let repaired = salvage_balanced_json(raw)
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string());
            func["arguments"] = json!(repaired);
            fixed += 1;
        }
    }
    fixed
}

#[handler]
async fn chat_completions(req: &mut Request, res: &mut Response) {
    // 鉴权
    let expected = ai00_s_internal_token();
    let provided = req
        .headers()
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if provided != expected {
        res.status_code(StatusCode::UNAUTHORIZED);
        res.body(json!({"error": {"message": "invalid internal token"}}).to_string());
        return;
    }

    let body: Value = match req.parse_json().await {
        Ok(mut v) => {
            // 历史里小模型吐出的坏 tool-call 参数会毒死 llama-server 模板
            // 渲染（严格 parse 500，一条脏数据败掉整个会话）——入站统一修复
            let fixed = sanitize_tool_call_args(&mut v);
            if fixed > 0 {
                log::warn!("[ai-gateway] sanitized {fixed} malformed tool_call argument(s)");
            }
            v
        }
        Err(e) => {
            res.status_code(StatusCode::BAD_REQUEST);
            res.body(json!({"error": {"message": format!("invalid json: {e}")}}).to_string());
            return;
        }
    };

    let model = body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(MODEL_AUTO)
        .to_string();
    let session_id = req
        .headers()
        .get("x-ai00-session-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let tool_rounds = body
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|messages| crate::tool_session::count_turn_rounds(messages))
        .unwrap_or(0);
    let usage = GatewayUsage::new(session_id.clone(), model.clone(), "remote")
        .with_tool_rounds(tool_rounds);

    // 分流决策
    let has_tools = body
        .get("tools")
        .and_then(|v| v.as_array())
        .is_some_and(|t| !t.is_empty());

    // 混合工具循环（M1.3）：工具轮走本地 RWKV 零状态临时会话（不传
    // session_id，引擎不写会话缓存——主会话状态零污染零残留，隔离由构造
    // 保证）；本地收敛出结论草稿 → 远端基于折叠历史合成终答。
    // 全本地闭环工具（web 提取/长文总结）终答也本地直出（质量门把关）。
    // `AI00X_TOOL_LOOP_LOCAL=0` 回退旧路径（白名单 + SmartRouter / 强制远端）。
    if hybrid_eligible(&model, &body, has_tools) {
        hybrid_tool_loop(body, &model, res, usage).await;
        return;
    }
    // 具体模型引用（非三个保留逻辑 id）→ 按引用解析转发，不参与智能路由
    let is_specific_ref = !model.is_empty() && model != MODEL_AUTO;
    let use_local = match model.as_str() {
        MODEL_RWKV => true,
        MODEL_REMOTE | MODEL_REMOTE_LEGACY => false,
        _ if is_specific_ref => false,
        _ if has_tools => {
            // M1.2 分层路由 v2：默认远程（本地 RWKV 结构化 tool-call 可靠性
            // 待真机 G1x 验证）。AI00X_DSH_LOCAL_TOOLS=1 且工具全在本地白名单
            // 且 SmartRouter 判 R0/R1 时尝试本地；本地分支失败自动降级远程。
            if local_tools_enabled() && tools_all_local(&body) {
                let decision = smart_route(&session_id, &last_user_text(&body)).await;
                log::info!(
                    "[ai-gateway] local-tools path: session={:?}, tier={}, whitelist tools={}",
                    session_id,
                    decision,
                    body.get("tools")
                        .and_then(|v| v.as_array())
                        .map(|t| t.len())
                        .unwrap_or(0)
                );
                matches!(decision, RouteClass::R0 | RouteClass::R1)
            } else {
                log::info!(
                    "[ai-gateway] tools present ({} tools) -> forced remote",
                    body.get("tools")
                        .and_then(|v| v.as_array())
                        .map(|t| t.len())
                        .unwrap_or(0)
                );
                false
            }
        }
        _ => {
            // ai00-auto 无工具（含 dsh 标题/摘要类 aux 请求）：SmartRouter 分类，
            // R0/R1 → 本地 RWKV（省远端 token 的主通路）
            let user_input = last_user_text(&body);
            let decision = smart_route(&session_id, &user_input).await;
            log::info!(
                "[ai-gateway] smart route: session={:?}, tier={}, -> {}",
                session_id,
                decision,
                matches!(decision, RouteClass::R0 | RouteClass::R1)
            );
            matches!(decision, RouteClass::R0 | RouteClass::R1)
        }
    };

    if use_local {
        // 本地失败（引擎未就绪/推理错误，且发生在任何 SSE 字节写出之前）→
        // 自动降级远程，请求不失败——aux 误路由无感
        if let Err(error) = local_rwkv_sse(body.clone(), res, usage.with_route("local")).await {
            log::warn!("[ai-gateway] local branch failed -> fallback to remote: {error}");
            forward_to_ai00_salvo(
                body,
                res,
                &model,
                usage.with_route("local-fallback").with_fallback(error),
            )
            .await;
        }
    } else {
        forward_to_ai00_salvo(body, res, &model, usage).await;
    }
}

/// 本地工具白名单：只放行只读 + 通知类工具——本地分支即使工具调用解析失败
/// 也不会产生破坏性副作用（写知行/换壁纸/XP 全部排除）。
/// 两部分同源约定（改动须双向同步）：
/// - ai00_*：桌面业务只读工具（M1.2）
/// - dsh 只读套件：与 dsh_manager.rs research_worker 工具集完全一致——
///   编排架构里调研 worker（model=ai00-auto）靠本白名单获得
///   hybrid_tool_loop 本地资格。web 检索为全局插件 @ai00-x/dsh-tools 的
///   ai00_web_extract（自托管免 key，2026-11-11 起替代引擎 web_fetch/web_search；
///   2026-11-21 起合并原 ai00_search——query 模式本身即搜索+取正文）
const LOCAL_TOOL_WHITELIST: &[&str] = &[
    "ai00_notify",
    "ai00_todo_read",
    "ai00_plan_read",
    "ai00_focus_log",
    "ai00_wallpaper_projects",
    // dsh 只读套件（research_worker 允许集）
    "read",
    "read_image",
    "glob",
    "grep",
    "ai00_web_extract",
];

/// 本地工具路径开关（env `AI00X_DSH_LOCAL_TOOLS=1`；默认关，M1.1 真机验证
/// 通过后再默认放开）。
fn local_tools_enabled() -> bool {
    std::env::var("AI00X_DSH_LOCAL_TOOLS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// 混合工具循环入口判定（纯函数，便于单测）：仅智能路由语义（空 / ai00-auto）
/// 才允许进入本地工具循环；显式选型（rwkv-local=强制本地 / ai00-api=强制远端 /
/// 具体模型引用）一律尊重，不被本地循环劫持（2026-09-11 审查 P0：原入口不查
/// model，显式远端 + 全白名单工具会被本地接管终答，rwkv-local 会被远端接管）。
fn hybrid_eligible(model: &str, body: &Value, has_tools: bool) -> bool {
    let auto_route = model.is_empty() || model == MODEL_AUTO;
    has_tools
        && auto_route
        && crate::tool_session::tool_loop_local_enabled()
        && (tools_all_local(body) || crate::tool_session::tools_all_local_final(body))
}

/// 请求的 tools 是否全部在本地白名单内（含全本地闭环工具——工具轮同样本地）。
fn tools_all_local(body: &Value) -> bool {
    body.get("tools")
        .and_then(|v| v.as_array())
        .map(|t| {
            !t.is_empty()
                && t.iter().all(|tool| {
                    tool.get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|n| n.as_str())
                        .map(|n| {
                            LOCAL_TOOL_WHITELIST.contains(&n)
                                || crate::tool_session::LOCAL_FINAL_TOOLS.contains(&n)
                        })
                        .unwrap_or(false)
                })
        })
        .unwrap_or(false)
}

/// 本地推理的会话缓存键：同一回合（system + 首条 user 相同）内的多轮工具调用
/// 共享同一份前缀状态，引擎只 prefill 增量（本地 prefill 是逐 token 线性开销）。
/// 跨回合/并行工人天然得到不同 key；引擎侧仅在「新 prompt 严格以缓存为前缀」
/// 时复用，分叉就整段重算——不会出现状态错配。
fn local_session_key(messages: &[Value]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for msg in messages {
        match msg.get("role").and_then(|r| r.as_str()) {
            Some("system") => {
                if let Some(text) = message_text(msg) {
                    text.hash(&mut hasher);
                }
            }
            Some("user") => {
                if let Some(text) = message_text(msg) {
                    "first-user".hash(&mut hasher);
                    text.hash(&mut hasher);
                }
                break;
            }
            _ => {}
        }
    }
    format!("gw-{:016x}", hasher.finish())
}

/// SmartRouter 分类（失败时降级 R2 → 远程，保守）。
async fn smart_route(session_id: &Option<String>, user_input: &str) -> RouteClass {
    let config_service = match get_global_config_service() {
        Ok(s) => s,
        Err(_) => return RouteClass::R2,
    };
    let config: ai00_x_core::service::config::GlobalConfig =
        match config_service.get_config(None).await {
            Ok(c) => c,
            Err(_) => return RouteClass::R2,
        };
    let router_config = config.ai.router.clone();
    let sid = session_id.clone().unwrap_or_else(|| "dsh-anon".to_string());
    get_smart_router()
        .route(&sid, user_input, None, 0, &router_config)
        .await
        .route
}

/// 取最后一条 user 消息文本（SmartRouter 分类输入）。
fn last_user_text(body: &Value) -> String {
    body.get("messages")
        .and_then(|m| m.as_array())
        .and_then(|msgs| {
            msgs.iter()
                .rev()
                .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        })
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string()
}

// ---------------------------------------------------------------------------
// 本地 RWKV 分支
// ---------------------------------------------------------------------------

/// 本地 RWKV：OpenAI 请求 → RWKV prompt → pool_infer 流 → OpenAI SSE chunks。
/// 零状态推理（session_id=None 全量 prefill，不写会话缓存）——带会话 id + 全量
/// prompt 会命中引擎缓存按增量续写，历史被双重喂入已演化 State → 输出错乱
/// （M1.3 §2.4 留观项转正修复）。恢复点语义 = 折叠转录，RWKV 分块 prefill
/// 开销可忽略。
///
/// 返回 `Err` = 尚未写出任何 SSE 字节的失败（引擎未就绪/推理错误）——
/// 调用方据此降级远程；一旦开始流式输出则只能走流内错误事件，返回 `Ok`。
async fn local_rwkv_sse(
    body: Value,
    res: &mut Response,
    usage: GatewayUsage,
) -> Result<(), String> {
    let messages = body
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let tools = body.get("tools").and_then(|v| v.as_array()).cloned();
    let stream = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(true);
    let max_tokens = body
        .get("max_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(512) as usize;
    let _temperature = body
        .get("temperature")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0) as f32;
    // 无工具对话保持请求原值；带工具时套用验证配方（top_p≈0.1 近贪心，
    // presence=frequency=0.5 → JSON 骨架遵循 6/6，参考 2026-08-27 实验）
    let has_tools = body
        .get("tools")
        .and_then(|v| v.as_array())
        .is_some_and(|t| !t.is_empty());
    // 回合熔断：本轮工具轮数达到上限后**不再下发 tools**，模型只能给终答。
    // 3B 本地模型一旦选错工具会无限换词重试（实测同一会话连调检索工具十次），
    // 引擎侧没有轮数上限，这里按 `AI00X_TOOL_LOOP_MAX_ROUNDS`（默认 6）硬截断。
    let rounds = crate::tool_session::count_turn_rounds(&messages);
    let rounds_exhausted = has_tools && rounds >= crate::tool_session::tool_loop_max_rounds();
    let tools = if rounds_exhausted {
        log::warn!(
            "[ai-gateway] local tool rounds exhausted ({rounds}); forcing final answer without tools"
        );
        None
    } else {
        tools
    };
    let has_tools = has_tools && !rounds_exhausted;
    // 本轮可用的工具名（工具名归一用；熔断后为空，归一自然跳过）
    let tool_names: Vec<String> = tools
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter_map(|tool| {
            tool.get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .map(str::to_string)
        })
        .collect();
    // 熔断后必须让失败**显式**：不给工具还不够，3B 模型会继续胡写。
    // 追加一条收尾指令，要求它输出一行 `BLOCKED: 原因`——编排者据此判定失败、
    // 按预算升级云端工人，而不是把这坨文本当交付物。
    let messages = if rounds_exhausted {
        let mut messages = messages;
        messages.push(json!({
            "role": "user",
            "content": "Reply with exactly one line: BLOCKED: <reason>",
        }));
        messages
    } else {
        messages
    };
    // 终结型工具已成功的下一轮：不再推理，直接以证据收尾。
    // 3B 在拿到 write / ai00_research_collect 的结果后无法自行停止（工具轮预填
    // 使模型只能继续产出工具调用，见 openai_messages_to_rwkv_prompt 末尾），
    // 这里确定性短路：省一轮全量 prefill，同时杜绝"任务已完成却复读调用"。
    if !rounds_exhausted {
        if let Some(evidence) = terminal_tool_completion(&messages) {
            log::info!("[ai-gateway] terminal tool succeeded, closing turn with evidence");
            stream_local_final(res, &format!("DONE: {evidence}"), 0, 0);
            return Ok(());
        }
    }
    // 熔断轮只允许一句话：3B 模型在"没工具"时会整段复读指令甚至 system prompt，
    // 实测量出 20s / 数百 token 的垃圾正文。这里硬压到 256 token。
    let max_tokens = if rounds_exhausted {
        max_tokens.min(256)
    } else {
        max_tokens
    };
    let top_p = body
        .get("top_p")
        .and_then(|v| v.as_f64())
        .map(|v| v as f32)
        .unwrap_or(if has_tools { 0.1 } else { 0.3 });
    let presence = if has_tools { 0.5 } else { 0.3 };
    let frequency = if has_tools { 0.5 } else { 0.3 };

    let prompt = openai_messages_to_rwkv_prompt(&messages, tools.as_deref());
    let is_instruction_format = prompt.starts_with("Instruction: ");

    let mut stop = rwkv_stop_sequences(is_instruction_format, has_tools);
    for s in client_stop_sequences(&body) {
        if !stop.contains(&s) {
            stop.push(s);
        }
    }
    let local_session = local_session_key(&messages);
    // 自愈重试复用同一会话键（重试提示是首轮提示的严格前缀延长 → 缓存命中，
    // 重试只多付几十 token 的 prefill）。
    let retry_session = local_session.clone();
    log::debug!(
        "[ai-gateway] local prompt ({} chars) head: {:?}",
        prompt.chars().count(),
        prompt.chars().take(120).collect::<String>()
    );
    log::debug!(
        "[ai-gateway] local t={:.0}ms pre-pool",
        usage.started.elapsed().as_secs_f64() * 1e3
    );

    let mut rx = match pool_infer(
        prompt.clone(),
        max_tokens,
        top_p,
        0,
        presence,
        frequency,
        0.996,
        Some(stop.clone()),
        Some(local_session),
        stream,
        false,
        String::new(),
    )
    .await
    {
        Ok(rx) => rx,
        Err(e) if e.contains("not initialized") => {
            // RWKV 引擎未初始化：后台触发 lazy-init（加载耗时且推理池串行，
            // 阻塞等待会让并发请求全部积压挂死）。本请求降级远程，
            // 引擎就绪后的后续请求自然回到本地。
            tokio::spawn(async move {
                if let Err(e) = crate::rwkv_llm::init_engine_internal(None, None, None).await {
                    log::warn!("[ai-gateway] RWKV lazy-init failed: {e}");
                }
            });
            return Err(format!("RWKV engine not initialized: {e}"));
        }
        Err(e) => {
            return Err(format!("RWKV engine error: {e}"));
        }
    };

    log::debug!(
        "[ai-gateway] local t={:.0}ms pool-ready",
        usage.started.elapsed().as_secs_f64() * 1e3
    );

    // 流式桥接：InferenceEvent → OpenAI SSE chunks
    // 带工具时输出全缓冲（结束才判定 tool-call / 纯文本）：边流 text-delta 边
    // 补发 tool_call_delta 会让 text 块和 tool-call 块并存，污染 dsh 上下文。
    // 熔断轮同样全缓冲：终答要先收敛成一行 DONE:/BLOCKED:（见 finalize_exhausted_text）。
    let (tx, rx_body) = tokio::sync::mpsc::unbounded_channel::<Result<Bytes, salvo::Error>>();
    let model_name = MODEL_RWKV.to_string();
    let stream_inline_text = !has_tools && !rounds_exhausted;
    // 熔断轮判定"证据 vs 失败"用的历史（含本回合所有工具结果）
    let task_path_hint = hinted_path(&messages);
    let messages_for_evidence = messages;

    tokio::spawn(async move {
        let mut full_text = String::new();
        let mut input_tokens = 0usize;
        let mut output_tokens = 0usize;
        let mut cached_tokens = 0usize;
        // 流式正文已发出的字符数（stop 安全回看：见 `safe_emit_len`）
        let mut emitted_chars = 0usize;
        // 首 token 到达即记 TTFT（本地路径的一次性观测指标）
        let mut ttft_ms: Option<u64> = None;
        while let Some(event) = rx.recv().await {
            match event {
                InferenceEvent::Token(t) => {
                    if ttft_ms.is_none() {
                        ttft_ms = Some(usage.started.elapsed().as_millis() as u64);
                        log::debug!(
                            "[ai-gateway] local first-token t={}ms",
                            ttft_ms.unwrap_or(0)
                        );
                    }
                    full_text.push_str(&t);
                    if stream_inline_text {
                        // 引擎在 stop 命中时才截断 Done.text，但组成 stop 序列的
                        // 那几个 token 已经作为 Token 事件发出去了（实测尾巴漏出
                        // `User:`）。这里按「可能是 stop 前缀」的最长尾部扣留不发，
                        // 后续 token 证明它不是 stop 再补发。
                        let ready = safe_emit_len(&full_text, &stop);
                        if ready > emitted_chars {
                            let chunk: String = full_text
                                .chars()
                                .skip(emitted_chars)
                                .take(ready - emitted_chars)
                                .collect();
                            emitted_chars = ready;
                            let chunk = sse_text_delta(&model_name, &chunk);
                            if tx.send(Ok(Bytes::from(chunk))).is_err() {
                                break;
                            }
                        }
                    }
                }
                InferenceEvent::Done {
                    text,
                    input_tokens: it,
                    output_tokens: ot,
                    cached_tokens: ct,
                    ..
                } => {
                    full_text = text;
                    input_tokens = it;
                    output_tokens = ot;
                    cached_tokens = ct;
                    break;
                }
                InferenceEvent::Error(e) => {
                    let chunk = format!("data: {}\n\n", json!({"error": {"message": e}}));
                    let _ = tx.send(Ok(Bytes::from(chunk)));
                    let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n")));
                    return;
                }
            }
        }

        // Instruction 格式：截断模型幻觉出的新角色块
        let mut text = full_text;
        if is_instruction_format {
            text = truncate_at_role_marker(&text);
        }
        if rounds_exhausted {
            text = finalize_exhausted_text(&text, &messages_for_evidence);
        }

        // 尝试提取工具调用（```json {...} ``` 协议）
        // usage 分片放在 finish 之前、两条分支都发：工具轮以前完全没有 usage，
        // 引擎侧 deriveTurnTokenUsage 拿不到数字 → 本地模型的对话回合用量条全空。
        let mut call = extract_repaired_call(
            &text,
            has_tools,
            &tool_names,
            tools.as_deref(),
            task_path_hint.as_deref(),
        );
        // 一次性自愈：想调工具但调用不可用（参数解析不了 / 包络残缺）时，
        // 用「单工具 + 明确示例」的严格提示重问一次（实测失败救回 36%）。
        let invalid_args = |c: &Option<(String, String)>| {
            c.as_ref()
                .is_some_and(|(_, a)| serde_json::from_str::<Value>(a).is_err())
        };
        if has_tools
            && !rounds_exhausted
            && tool_retry_enabled()
            && !tx.is_closed()
            && (invalid_args(&call) || (call.is_none() && looks_like_tool_call_text(&text)))
        {
            if let Some(tool_defs) = tools.as_deref() {
                let (messages_retry, narrowed) =
                    tool_retry_plan(&messages_for_evidence, tool_defs, task_path_hint.as_deref());
                let retry_prompt = openai_messages_to_rwkv_prompt(&messages_retry, Some(&narrowed));
                log::info!("[ai-gateway] tool-call retry (first attempt unusable)");
                if let Ok(mut rx_retry) = pool_infer(
                    retry_prompt,
                    max_tokens.min(192),
                    top_p,
                    0,
                    presence,
                    frequency,
                    0.996,
                    Some(stop.clone()),
                    Some(retry_session.clone()),
                    false,
                    false,
                    String::new(),
                )
                .await
                {
                    let mut retry_text = String::new();
                    while let Some(event) = rx_retry.recv().await {
                        match event {
                            InferenceEvent::Token(t) => retry_text.push_str(&t),
                            InferenceEvent::Done {
                                text: t,
                                input_tokens: it,
                                output_tokens: ot,
                                cached_tokens: ct,
                                ..
                            } => {
                                retry_text = t;
                                input_tokens = input_tokens.saturating_add(it);
                                output_tokens = output_tokens.saturating_add(ot);
                                cached_tokens = cached_tokens.saturating_add(ct);
                                break;
                            }
                            InferenceEvent::Error(e) => {
                                log::warn!("[ai-gateway] tool-call retry failed: {e}");
                                break;
                            }
                        }
                    }
                    if let Some(recovered) = extract_repaired_call(
                        &retry_text,
                        true,
                        &tool_names,
                        tools.as_deref(),
                        task_path_hint.as_deref(),
                    ) {
                        if serde_json::from_str::<Value>(&recovered.1).is_ok() {
                            log::info!("[ai-gateway] tool-call retry recovered: {}", recovered.0);
                            call = Some(recovered);
                        }
                    }
                }
            }
        }
        if let Some((name, arguments)) = call {
            if let Some(reason) = write_rejection(&name, &arguments) {
                // 空写会整文件覆盖 → 清空既有交付物；超长写会让 3B 退化。
                // 强制本地路径（rwkv-local）也必须拦，工人正是走这条路。
                log::warn!("[ai-gateway] rejected {name} call: {reason}");
                let blocked = format!("BLOCKED: {reason}");
                let chunk = sse_text_delta(&model_name, &blocked);
                let _ = tx.send(Ok(Bytes::from(chunk)));
                let chunk = sse_usage(&model_name, input_tokens, output_tokens);
                let _ = tx.send(Ok(Bytes::from(chunk)));
                let chunk = sse_finish(&model_name, "stop");
                let _ = tx.send(Ok(Bytes::from(chunk)));
            } else if repeated_tool_call(&messages_for_evidence, &name, &arguments) {
                // 重复调用：直接以证据收尾，不再白烧工具轮（见 repeated_tool_call）
                log::info!("[ai-gateway] duplicate {name} call, closing turn with evidence");
                text = finalize_exhausted_text("", &messages_for_evidence);
                let chunk = sse_text_delta(&model_name, &text);
                let _ = tx.send(Ok(Bytes::from(chunk)));
                let chunk = sse_usage(&model_name, input_tokens, output_tokens);
                let _ = tx.send(Ok(Bytes::from(chunk)));
                let chunk = sse_finish(&model_name, "stop");
                let _ = tx.send(Ok(Bytes::from(chunk)));
            } else {
                let chunk = sse_tool_call_delta(&model_name, &name, &arguments);
                let _ = tx.send(Ok(Bytes::from(chunk)));
                let chunk = sse_usage(&model_name, input_tokens, output_tokens);
                let _ = tx.send(Ok(Bytes::from(chunk)));
                let chunk = sse_finish(&model_name, "tool_calls");
                let _ = tx.send(Ok(Bytes::from(chunk)));
            }
        } else if has_tools && looks_like_tool_call_text(&text) {
            // 模型确实想调工具，但 JSON 残缺到认不出工具名。绝不能把它当最终
            // 回答交给引擎——编排者会把一串 JSON 残片当成工人交付（实测的
            // "工人返回空壳"就是这么来的）。按传输错误收尾，交给引擎重试/降级。
            let snippet: String = text.chars().take(160).collect();
            log::warn!("[ai-gateway] unparsable local tool call: {snippet}");
            // 把模型自己产出的片段回灌进错误正文：本地模型看到原文才可能自纠。
            let chunk = format!(
                "data: {}\n\n",
                json!({"error": {
                    "message": format!("local model emitted an unparsable tool call: {snippet}"),
                    "code": "AI00X_TOOL_PARSE",
                }})
            );
            let _ = tx.send(Ok(Bytes::from(chunk)));
            let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n")));
            return;
        } else {
            // 流式正文：把回看窗口里还没发的尾巴补上（Done.text 已按 stop 截断）
            if stream_inline_text {
                let total = text.chars().count();
                if total > emitted_chars {
                    let chunk: String = text.chars().skip(emitted_chars).collect();
                    let chunk = sse_text_delta(&model_name, &chunk);
                    let _ = tx.send(Ok(Bytes::from(chunk)));
                }
            }
            // 缓冲模式（带工具 / 熔断轮）还没发过正文，这里整段补发
            if !stream_inline_text && !text.is_empty() {
                let chunk = sse_text_delta(&model_name, &text);
                let _ = tx.send(Ok(Bytes::from(chunk)));
            }
            let chunk = sse_usage(&model_name, input_tokens, output_tokens);
            let _ = tx.send(Ok(Bytes::from(chunk)));
            let chunk = sse_finish(&model_name, "stop");
            let _ = tx.send(Ok(Bytes::from(chunk)));
        }
        usage
            .record(
                MODEL_RWKV,
                true,
                Some(GatewayTokenUsage {
                    prompt: u32::try_from(input_tokens).unwrap_or(u32::MAX),
                    completion: u32::try_from(output_tokens).unwrap_or(u32::MAX),
                    // 本地前缀缓存复用的 token 数（0 = 全量 prefill），
                    // 供 usage 分析缓存命中率；远端路径由 SSE 响应自带。
                    cached_prompt: Some(u32::try_from(cached_tokens).unwrap_or(u32::MAX)),
                }),
                ttft_ms,
            )
            .await;
        let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n")));
    });

    res.headers_mut().insert(
        salvo::http::header::CONTENT_TYPE,
        salvo::http::HeaderValue::from_static("text/event-stream"),
    );
    res.headers_mut().insert(
        salvo::http::header::CACHE_CONTROL,
        salvo::http::HeaderValue::from_static("no-cache"),
    );
    res.stream(tokio_stream::wrappers::UnboundedReceiverStream::new(
        rx_body,
    ));
    Ok(())
}

// ---------------------------------------------------------------------------
// 混合工具循环（M1.3）：本地工具轮 + 远端终答合成
// ---------------------------------------------------------------------------

/// 单轮本地工具推理结果。
enum ToolRoundOutcome {
    /// 模型产出工具调用（```json 协议解析成功）。
    /// 带上本轮的 token 数：工具轮的 usage 分片要靠它，否则引擎侧拿不到数字。
    ToolCall {
        name: String,
        arguments: String,
        input_tokens: usize,
        output_tokens: usize,
    },
    /// 模型产出纯文本——工具循环收敛信号，作为终答草稿。
    /// hit_len = 因 max_tokens 收尾（Done.stop_sequence 为 None），供质量门判定截断。
    Draft {
        text: String,
        hit_len: bool,
        input_tokens: usize,
        output_tokens: usize,
    },
}

/// 混合工具循环编排：工具轮本地 RWKV（零状态临时会话），收敛后远端终答。
/// 本地失败整轮降级远端循环（旧路径），请求不失败。
async fn hybrid_tool_loop(body: Value, model: &str, res: &mut Response, usage: GatewayUsage) {
    let rounds = crate::tool_session::count_turn_rounds(
        body.get("messages")
            .and_then(|v| v.as_array())
            .map(|m| m.as_slice())
            .unwrap_or(&[]),
    );
    let max_rounds = crate::tool_session::tool_loop_max_rounds();
    if rounds > max_rounds {
        // 熔断防工具死循环：交接远端续接工具循环（保留 tools，与本地失败
        // 降级路径行为对齐——远端基于进行中工具段自然续跑直到收敛）。
        // 防死循环职责移交远端模型，与纯远端路径一致，风险不增。
        log::warn!(
            "[ai-gateway] tool loop exceeded {max_rounds} rounds, handing off to remote loop"
        );
        forward_to_ai00_salvo(
            body,
            res,
            model,
            usage
                .with_route("hybrid-max-rounds")
                .with_fallback(format!("tool loop exceeded {max_rounds} rounds")),
        )
        .await;
        return;
    }

    match local_tool_round(&body, None, usage.with_route("hybrid-local")).await {
        Ok(ToolRoundOutcome::ToolCall {
            name,
            arguments,
            input_tokens,
            output_tokens,
        }) => {
            log::info!("[ai-gateway] tool round {rounds}: local -> call {name}");
            let (tx, rx_body) =
                tokio::sync::mpsc::unbounded_channel::<Result<Bytes, salvo::Error>>();
            tokio::spawn(async move {
                let _ = tx.send(Ok(Bytes::from(sse_tool_call_delta(
                    MODEL_RWKV, &name, &arguments,
                ))));
                // 工具轮也要带 usage，否则本地工具轮在回合用量条上是空的
                let _ = tx.send(Ok(Bytes::from(sse_usage(
                    MODEL_RWKV,
                    input_tokens,
                    output_tokens,
                ))));
                let _ = tx.send(Ok(Bytes::from(sse_finish(MODEL_RWKV, "tool_calls"))));
                let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n")));
            });
            res.headers_mut().insert(
                salvo::http::header::CONTENT_TYPE,
                salvo::http::HeaderValue::from_static("text/event-stream"),
            );
            res.headers_mut().insert(
                salvo::http::header::CACHE_CONTROL,
                salvo::http::HeaderValue::from_static("no-cache"),
            );
            res.stream(tokio_stream::wrappers::UnboundedReceiverStream::new(
                rx_body,
            ));
        }
        Ok(ToolRoundOutcome::Draft {
            text,
            hit_len,
            input_tokens: draft_in,
            output_tokens: draft_out,
        }) => {
            let is_local_final = crate::tool_session::tools_all_local_final(&body);
            match crate::tool_session::quality_gate(&text, hit_len) {
                Ok(()) if is_local_final => {
                    // 全本地闭环工具（web 提取/长文总结）：草稿即终答，直出不绕远端
                    log::info!(
                        "[ai-gateway] tool round {rounds}: local-final answer {} chars (no remote)",
                        text.chars().count()
                    );
                    stream_local_final(res, &text, draft_in, draft_out);
                }
                Ok(()) => {
                    log::info!(
                        "[ai-gateway] tool round {rounds}: local -> draft {} chars, composing remote final",
                        text.chars().count()
                    );
                    compose_final_remote(
                        body,
                        Some(&text),
                        model,
                        res,
                        usage.with_route("hybrid-final"),
                    )
                    .await;
                }
                Err(problems) => {
                    // 质量门拦截：换采样（top_p 0.5）本地重试一次，仍不合格升级远端（无草稿）
                    log::warn!(
                        "[ai-gateway] draft failed quality gate: {problems:?}, retrying top_p=0.5"
                    );
                    let retry = match local_tool_round(
                        &body,
                        Some(0.5),
                        usage.with_route("hybrid-local-retry"),
                    )
                    .await
                    {
                        Ok(ToolRoundOutcome::Draft {
                            text: retry_text,
                            hit_len: retry_hit,
                            input_tokens: retry_in,
                            output_tokens: retry_out,
                        }) if crate::tool_session::quality_gate(&retry_text, retry_hit).is_ok() => {
                            Some((retry_text, retry_in, retry_out))
                        }
                        _ => None,
                    };
                    match retry {
                        Some((retry_text, retry_in, retry_out)) if is_local_final => {
                            log::info!(
                                "[ai-gateway] retry passed gate: local-final answer {} chars",
                                retry_text.chars().count()
                            );
                            stream_local_final(res, &retry_text, retry_in, retry_out);
                        }
                        Some((retry_text, _, _)) => {
                            compose_final_remote(
                                body,
                                Some(&retry_text),
                                model,
                                res,
                                usage.with_route("hybrid-final-retry"),
                            )
                            .await;
                        }
                        None => {
                            log::warn!(
                                "[ai-gateway] retry failed gate, upgrading to remote (no draft)"
                            );
                            compose_final_remote(
                                body,
                                None,
                                model,
                                res,
                                usage
                                    .with_route("hybrid-quality-fallback")
                                    .with_fallback("local draft failed quality gate".to_string()),
                            )
                            .await;
                        }
                    }
                }
            }
        }
        Err(e) => {
            // 本地推理失败：整轮降级远端循环（forward 入口折叠闭合段，
            // 进行中段原样保留，远端续接工具循环），用户无感。
            log::warn!("[ai-gateway] local tool round failed ({e}), fallback to remote loop");
            forward_to_ai00_salvo(
                body,
                res,
                model,
                usage.with_route("hybrid-error-fallback").with_fallback(e),
            )
            .await;
        }
    }
}

/// 单轮本地工具推理：折叠闭合历史段后零状态全量 prefill（不传 session_id，
/// 不写会话缓存），非流式全缓冲——工具轮输出必须先判定类型再决定走向。
/// 采样 = 验证配方（2026-08-27 JSON 遵循度实验 6/6）：top_p 默认 0.1 近贪心
/// + presence/frequency 0.5；`top_p_override` 供质量门重试换采样探索（0.5）。
async fn local_tool_round(
    body: &Value,
    top_p_override: Option<f32>,
    usage: GatewayUsage,
) -> Result<ToolRoundOutcome, String> {
    let messages = body
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let tools = body.get("tools").and_then(|v| v.as_array()).cloned();
    let task_path_hint = hinted_path(&messages);
    let tool_names: Vec<String> = tools
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter_map(|tool| {
            tool.get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .map(str::to_string)
        })
        .collect();
    let max_tokens = body
        .get("max_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(512) as usize;
    let top_p = top_p_override
        .or_else(|| body.get("top_p").and_then(|v| v.as_f64()).map(|v| v as f32))
        .unwrap_or(0.1);

    let folded = crate::tool_session::fold_tool_segments(&messages, false);
    let prompt = openai_messages_to_rwkv_prompt(&folded, tools.as_deref());
    let local_session = local_session_key(&messages);

    // stop 序列与 local_rwkv_sse 对齐（带工具时恒为对话格式，无 Instruction 分支）
    let stop = rwkv_stop_sequences(false, true);
    let started = std::time::Instant::now();
    let prompt_chars = prompt.chars().count();
    let mut rx = pool_infer(
        prompt,
        max_tokens,
        top_p,
        0,
        0.5,
        0.5,
        0.996,
        Some(stop),
        Some(local_session),
        false,
        false,
        String::new(),
    )
    .await
    .map_err(|e| {
        if e.contains("not initialized") {
            // 与 local_rwkv_sse 一致：后台触发 lazy-init，本请求降级
            tokio::spawn(async move {
                if let Err(e) = crate::rwkv_llm::init_engine_internal(None, None, None).await {
                    log::warn!("[ai-gateway] RWKV lazy-init failed: {e}");
                }
            });
        }
        format!("local tool round: {e}")
    })?;

    let mut full_text = String::new();
    let mut hit_len = false;
    let mut input_tokens = 0usize;
    let mut output_tokens = 0usize;
    let mut cached_tokens = 0usize;
    while let Some(event) = rx.recv().await {
        match event {
            InferenceEvent::Token(t) => full_text.push_str(&t),
            InferenceEvent::Done {
                text,
                stop_sequence,
                input_tokens: it,
                output_tokens: ot,
                cached_tokens: ct,
                ..
            } => {
                full_text = text;
                input_tokens = it;
                output_tokens = ot;
                cached_tokens = ct;
                // stop_sequence 为 None = 因 max_tokens 收尾（截断），供质量门判定
                hit_len = stop_sequence.is_none();
                break;
            }
            InferenceEvent::Error(e) => return Err(e),
        }
    }
    // 观测：本地工具轮端到端（prompt 构建 → 首 token → 收尾），含 prefill + 解码
    log::info!(
        "[ai-gateway] local tool round: prompt={prompt_chars} chars in={input_tokens} tok (cached {cached_tokens}) out={output_tokens} tok total={:.2}s",
        started.elapsed().as_secs_f64()
    );
    usage
        .record(
            MODEL_RWKV,
            true,
            Some(GatewayTokenUsage {
                prompt: u32::try_from(input_tokens).unwrap_or(u32::MAX),
                completion: u32::try_from(output_tokens).unwrap_or(u32::MAX),
                cached_prompt: Some(u32::try_from(cached_tokens).unwrap_or(u32::MAX)),
            }),
            None,
        )
        .await;

    if let Some((name, arguments)) = tool_call_from_text(&full_text, true) {
        let name = normalize_tool_name(&name, &tool_names);
        let arguments = normalize_tool_arguments(&name, &arguments);
        // 破损 JSON 按必填键抢救（见 salvage_if_invalid）
        let arguments = salvage_if_invalid(
            &name,
            arguments,
            tools.as_deref(),
            task_path_hint.as_deref(),
        );
        // 路径写坏（Users / section?2.md）时按 brief 点名文件覆盖
        let arguments = apply_path_hint(&name, arguments, task_path_hint.as_deref());
        // 空内容 write 会把已有文件截成 0 字节：实测 T2/T3 的本地工人在"追加"
        // 失败后都发出了 {"content":"","file_path":"report.md"}，直接把刚写好的
        // 报告清空（2026-11-21 会话 87c876ca / caeffa9d）。拒绝执行，按 BLOCKED 收尾。
        if let Some(reason) = write_rejection(&name, &arguments) {
            log::warn!("[ai-gateway] rejected {name} call: {reason}");
            return Ok(ToolRoundOutcome::Draft {
                text: format!("BLOCKED: {reason}"),
                hit_len: false,
                input_tokens,
                output_tokens,
            });
        }
        Ok(ToolRoundOutcome::ToolCall {
            name,
            arguments,
            input_tokens,
            output_tokens,
        })
    } else {
        Ok(ToolRoundOutcome::Draft {
            text: full_text.trim().to_string(),
            hit_len,
            input_tokens,
            output_tokens,
        })
    }
}

/// 全本地闭环终答直出：草稿文本以 SSE 流式形状一次性下发（不绕远端）。
fn stream_local_final(res: &mut Response, text: &str, input_tokens: usize, output_tokens: usize) {
    let (tx, rx_body) = tokio::sync::mpsc::unbounded_channel::<Result<Bytes, salvo::Error>>();
    let text = text.to_string();
    tokio::spawn(async move {
        let _ = tx.send(Ok(Bytes::from(sse_text_delta(MODEL_RWKV, &text))));
        let _ = tx.send(Ok(Bytes::from(sse_usage(
            MODEL_RWKV,
            input_tokens,
            output_tokens,
        ))));
        let _ = tx.send(Ok(Bytes::from(sse_finish(MODEL_RWKV, "stop"))));
        let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n")));
    });
    res.headers_mut().insert(
        salvo::http::header::CONTENT_TYPE,
        salvo::http::HeaderValue::from_static("text/event-stream"),
    );
    res.headers_mut().insert(
        salvo::http::header::CACHE_CONTROL,
        salvo::http::HeaderValue::from_static("no-cache"),
    );
    res.stream(tokio_stream::wrappers::UnboundedReceiverStream::new(
        rx_body,
    ));
}

/// 远端终答合成：全部工具段折叠（tools 摘除，循环终止），本地草稿作为
/// 组织语言的参考注入末位 user 消息。
async fn compose_final_remote(
    body: Value,
    draft: Option<&str>,
    model: &str,
    res: &mut Response,
    usage: GatewayUsage,
) {
    let mut body = body;
    if let Some(obj) = body.as_object_mut() {
        let messages = obj
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut folded = crate::tool_session::fold_tool_segments(&messages, true);
        if let Some(draft) = draft.map(str::trim).filter(|d| !d.is_empty()) {
            folded.push(json!({
                "role": "user",
                "content": format!(
                    "（工具已执行完毕。请基于以上工具结果直接给出最终答复，不要再调用任何工具。以下为本地草稿，仅供组织语言参考：）\n{draft}"
                ),
            }));
        }
        obj.insert("messages".to_string(), json!(folded));
        obj.remove("tools");
        obj.remove("tool_choice");
    }
    forward_to_ai00_salvo(body, res, model, usage).await;
}

// ---------------------------------------------------------------------------
// 远程转发分支（AI00-API primary / 具体模型引用解析转发）
// ---------------------------------------------------------------------------

/// 本地失败降级目标：不可解析为远端客户端的引用（本地/智能路由逻辑 id）
/// 统一落到 primary 槽；具体远端引用（ai00s:xxx / 自定义 id / `ai00-api`）原样保留。
fn remote_fallback_ref(model: &str) -> &str {
    match model {
        MODEL_RWKV | MODEL_AUTO => MODEL_REMOTE,
        _ => model,
    }
}

/// 远端折叠触发阈值（字符）：≈128k 窗口的 80%（128k token × ~3.5 字符 ≈ 448k，
/// 取 80% 后再留余量）。低于此值保留完整工具历史，避免把文件内容压成 300 字符。
const REMOTE_FOLD_TRIGGER_CHARS: usize = 320_000;

/// 远端历史是否需要兜底折叠：默认否（准确性优先），仅压力超阈值或
/// `AI00X_REMOTE_FOLD=1` 强制时折叠。
fn remote_fold_needed(messages: &[Value]) -> bool {
    if std::env::var("AI00X_REMOTE_FOLD").is_ok_and(|v| v == "1") {
        return true;
    }
    let total: usize = messages.iter().map(|m| m.to_string().chars().count()).sum();
    total > REMOTE_FOLD_TRIGGER_CHARS
}

/// 转发到指定模型引用（OpenAI 兼容 SSE 透传）：`ai00-api` → primary 槽；
/// 其他引用（ai00s:/gguf-local:/自定义 id）按 client_factory 同一解析链直达。
/// 本地失败降级统一走此入口——逻辑 id（rwkv-local/ai00-auto）先经
/// [`remote_fallback_ref`] 映射，保证「本地失败自动降级远端」真实成立。
///
/// 远端首字节超时秒数（默认 60；`AI00X_REMOTE_FIRST_BYTE_SECS` 可覆盖，测试用）。
fn remote_first_byte_timeout_secs() -> u64 {
    std::env::var("AI00X_REMOTE_FIRST_BYTE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v: &u64| *v > 0)
        .unwrap_or(60)
}

/// 远端流空闲超时秒数（默认 90；`AI00X_REMOTE_IDLE_SECS` 可覆盖，测试用）。
///
/// 上游挂起时（实测自建 RWKV 通道「建预扣后不 settle」）不会主动断开；
/// 没有这个超时，引擎回合会静默结束、计划卡停住且无错误可重试。
fn remote_idle_timeout_secs() -> u64 {
    std::env::var("AI00X_REMOTE_IDLE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v: &u64| *v > 0)
        .unwrap_or(90)
}

/// 转发到指定模型引用（OpenAI 兼容 SSE 透传）：`ai00-api` → primary 槽；
/// 其他引用（ai00s:/gguf-local:/自定义 id）按 client_factory 同一解析链直达。
async fn forward_to_ai00_salvo(
    mut body: Value,
    res: &mut Response,
    model_ref: &str,
    usage: GatewayUsage,
) {
    // 历史折叠（按需）：**默认不再折叠**。折叠把已闭合工具段的参数压到 80 字符、
    // 结果压到 300 字符，远端模型（128k 窗口）读完一个文件再调一次工具，文件内容
    // 就没了——准确性优先，历史预算交给引擎压缩（它按完整历史算）。
    // 只在估算体量超过远端窗口 80% 时兜底折叠（防爆），
    // `AI00X_REMOTE_FOLD=1` 可强制恢复旧行为（A/B 与回退用）。
    if let Some(obj) = body.as_object_mut() {
        if let Some(messages) = obj.get("messages").and_then(|v| v.as_array()) {
            if remote_fold_needed(messages) {
                let folded = crate::tool_session::fold_tool_segments(messages, false);
                log::info!(
                    "[ai-gateway] folded tool segments (pressure): {} -> {} messages",
                    messages.len(),
                    folded.len()
                );
                obj.insert("messages".to_string(), json!(folded));
            }
        }
    }
    let resolve_key = match remote_fallback_ref(model_ref) {
        MODEL_REMOTE | MODEL_REMOTE_LEGACY => "primary",
        other => other,
    };
    // 恢复登录态：dsh 侧请求可能先于任何前端登录流程到达，
    // AI00S_AUTH_TOKEN 是内存态——从 vault 兜底恢复（幂等，已有则秒回）。
    let _ = crate::auth::ensure_auth_synced().await;
    let mut client = match AIClientFactory::get_global() {
        Ok(f) => match f.get_client_resolved(resolve_key).await {
            Ok(c) => c,
            Err(e) => {
                res.status_code(StatusCode::BAD_GATEWAY);
                res.body(
                    json!({"error": {"message": format!("model `{resolve_key}` unavailable: {e}")}})
                        .to_string(),
                );
                return;
            }
        },
        Err(e) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.body(
                json!({"error": {"message": format!("config service unavailable: {e}")}})
                    .to_string(),
            );
            return;
        }
    };

    let actual_model = client.config.model.clone();
    let actual_local =
        resolve_key.starts_with("gguf-local") || client.config.name.starts_with("gguf-local");

    // 覆写 model 为 primary 配置的模型名，强制流式并请求真实 usage。
    if let Some(obj) = body.as_object_mut() {
        obj.insert("model".to_string(), json!(actual_model.clone()));
        obj.insert("stream".to_string(), json!(true));
        let options = obj.entry("stream_options").or_insert_with(|| json!({}));
        if let Some(options) = options.as_object_mut() {
            options.insert("include_usage".to_string(), json!(true));
        }
        // 会话标识透传：服务端按 session_id 聚合积分账单，供客户端展示「本回合消耗 / 会话累计」
        if let Some(sid) = usage.session_id.as_deref().filter(|s| !s.is_empty()) {
            obj.insert("session_id".to_string(), json!(sid));
        }
    }

    // 请求标识：一次逻辑请求生成一次，401 刷新重试复用同一 id（服务端据此关联请求日志与账单）
    let request_id = format!("cli_{}", uuid::Uuid::new_v4().simple());
    log::info!("[ai-gateway] request_id={request_id}");

    // 发送（最多两次机会）：
    // - 401：刷新 member token 后重建 client 重试（dsh 会话长驻，access token
    //   过期不刷新会让所有 agent 请求永久 502）
    // - 网络错误 / 5xx / 429 / 空响应体 / 首块即断流：长 SSE 请求在跨境链路上
    //   偶发中断，直接 502 会让整轮 agent 回合作废。**响应头提交前**是唯一干净
    //   的自愈点，所以首块先读出来再决定，绝不把半截坏流投给引擎。
    let mut upstream_stream = None;
    let mut first_chunk: Option<Bytes> = None;
    // 首块到达即记 TTFT（含上游排队与首 token 时间）
    let mut ttft_ms: Option<u64> = None;
    let mut last_error = String::from("upstream request failed");
    for attempt in 0..2u32 {
        let mut request = client
            .http_client()
            .post(&client.config.request_url)
            .header("X-Request-Id", &request_id)
            .json(&body);
        if !client.config.api_key.is_empty() {
            request = request.bearer_auth(&client.config.api_key);
        }
        if let Some(headers) = &client.config.custom_headers {
            for (k, v) in headers {
                if let (Ok(name), Ok(value)) = (
                    salvo::http::header::HeaderName::from_bytes(k.as_bytes()),
                    salvo::http::header::HeaderValue::from_str(v),
                ) {
                    request = request.header(name, value);
                }
            }
        }
        match request.send().await {
            Ok(r) => {
                if r.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                    // token 过期：先刷新，再重建 client 重试。
                    // 刷新失败也要重试一次——vault 里可能已有别的会话刚写入的
                    // 新 token（ensure_auth_synced 会把它同步进内存）。实测
                    // 2026-11-20：并发会话下刷新偶发失败，整轮直接 502
                    // `member authentication required`，而下一秒的直接请求正常。
                    let refreshed = crate::auth::refresh_auth_token_impl().await;
                    if refreshed.is_err() {
                        let _ = crate::auth::ensure_auth_synced().await;
                    }
                    if let Ok(f) = AIClientFactory::get_global() {
                        if let Ok(c) = f.get_client_resolved(resolve_key).await {
                            client = c;
                            log::info!(
                                "[ai-gateway] 401 recovered (refresh={:?}), retrying once",
                                refreshed.is_ok()
                            );
                            continue;
                        }
                    }
                    log::warn!("[ai-gateway] 401 but client rebuild failed, giving up");
                }
                if !r.status().is_success() {
                    let status = r.status();
                    let text = r.text().await.unwrap_or_default();
                    last_error = format!(
                        "upstream {status}: {}",
                        text.chars().take(400).collect::<String>()
                    );
                    if attempt == 0
                        && (status.is_server_error()
                            || status == reqwest::StatusCode::TOO_MANY_REQUESTS)
                    {
                        log::warn!("[ai-gateway] {last_error}, retrying once");
                        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                        continue;
                    }
                    res.status_code(StatusCode::BAD_GATEWAY);
                    res.body(
                        json!({"error": {"message": text, "status": status.as_u16()}}).to_string(),
                    );
                    return;
                }
                let mut stream = r.bytes_stream();
                // 首块读取加超时：上游长时间不吐首字节（排队/挂起）时按失败处理并重试，
                // 避免请求永远挂着、引擎回合静默结束。默认 60s，环境变量可覆盖（测试用）。
                let first_byte_secs = remote_first_byte_timeout_secs();
                match tokio::time::timeout(
                    std::time::Duration::from_secs(first_byte_secs),
                    stream.next(),
                )
                .await
                {
                    Ok(Some(Ok(bytes))) => {
                        first_chunk = Some(bytes);
                        upstream_stream = Some(stream);
                        ttft_ms = Some(usage.started.elapsed().as_millis() as u64);
                        break;
                    }
                    Ok(Some(Err(e))) => {
                        last_error = format!("upstream stream error before first byte: {e}");
                    }
                    Ok(None) => last_error = "upstream returned empty body".to_string(),
                    Err(_) => {
                        last_error = format!("upstream no first byte within {first_byte_secs}s");
                        log::warn!("[ai-gateway] {last_error}");
                    }
                }
                if attempt == 0 {
                    log::warn!("[ai-gateway] {last_error}, retrying once");
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                }
            }
            Err(e) => {
                last_error = format!("upstream request failed: {e}");
                if attempt == 0 {
                    log::warn!("[ai-gateway] {last_error}, retrying once");
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                }
            }
        }
    }
    let (Some(mut stream), Some(first)) = (upstream_stream, first_chunk) else {
        log::warn!("[ai-gateway] giving up: {last_error}");
        res.status_code(StatusCode::BAD_GATEWAY);
        res.body(json!({"error": {"message": last_error}}).to_string());
        return;
    };

    // SSE 字节流透传；旁路解析 usage，不改写下游内容。
    let usage = usage.with_request_id(request_id.clone());
    let (tx, rx_body) = tokio::sync::mpsc::unbounded_channel::<Result<Bytes, salvo::Error>>();
    tokio::spawn(async move {
        // 行缓冲扫描：usage 旁路 + 是否已见 `[DONE]` 终结符。
        fn scan(
            pending: &mut String,
            text: &str,
            seen_usage: &mut Option<GatewayTokenUsage>,
            saw_done: &mut bool,
        ) {
            pending.push_str(text);
            while let Some(end) = pending.find('\n') {
                let line = pending[..=end].to_string();
                pending.drain(..=end);
                // 终结符写法不统一：上游实测发 `data:[DONE]`（无空格），
                // 早期判定用 `ends_with("data: [DONE]")` 会漏判、导致重复补发。
                if line
                    .trim()
                    .strip_prefix("data:")
                    .is_some_and(|rest| rest.trim() == "[DONE]")
                {
                    *saw_done = true;
                }
                if let Some(u) = gateway_usage_from_sse_line(&line) {
                    *seen_usage = Some(u);
                }
            }
        }

        let mut pending = String::new();
        let mut seen_usage = None;
        let mut saw_done = false;
        let mut interrupted = None;
        scan(
            &mut pending,
            &String::from_utf8_lossy(&first),
            &mut seen_usage,
            &mut saw_done,
        );
        // 下游已断开时 send 失败，直接落到记账收尾。
        // 空闲超时：上游超过 N 秒没有新字节即视为挂起（实测自建通道会「建预扣
        // 后不 settle」），主动以 SSE error 终结，让引擎/UI 看到失败可重试。
        let idle_secs = remote_idle_timeout_secs();
        if tx.send(Ok(first)).is_ok() {
            loop {
                let chunk = match tokio::time::timeout(
                    std::time::Duration::from_secs(idle_secs),
                    stream.next(),
                )
                .await
                {
                    Ok(Some(chunk)) => chunk,
                    Ok(None) => break,
                    Err(_) => {
                        interrupted =
                            Some(format!("upstream idle timeout: no data for {idle_secs}s"));
                        log::warn!(
                            "[ai-gateway] upstream idle for {idle_secs}s, closing stream with error"
                        );
                        break;
                    }
                };
                match chunk {
                    Ok(bytes) => {
                        scan(
                            &mut pending,
                            &String::from_utf8_lossy(&bytes),
                            &mut seen_usage,
                            &mut saw_done,
                        );
                        if tx.send(Ok(bytes)).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        interrupted = Some(e.to_string());
                        break;
                    }
                }
            }
        }
        // 断流收尾：用 SSE error 事件 + `[DONE]` 干净关闭，而不是把原始错误
        // 塞进响应体流——后者会让下游 reqwest 报 `error decoding response body`，
        // 引擎整轮直接判死、用户只看到一句无上下文的解码失败。
        match interrupted {
            Some(e) => {
                log::warn!("[ai-gateway] upstream stream interrupted: {e}");
                let payload = format!(
                    "data: {}\n\ndata: [DONE]\n\n",
                    json!({
                        "error": {
                            "message": format!("upstream stream interrupted: {e}"),
                            "code": "upstream_stream_interrupted",
                        }
                    })
                );
                let _ = tx.send(Ok(Bytes::from(payload)));
            }
            None if !saw_done => {
                let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n")));
            }
            None => {}
        }
        if let Some(usage) = gateway_usage_from_sse_line(&pending) {
            seen_usage = Some(usage);
        }
        usage
            .record(&actual_model, actual_local, seen_usage, ttft_ms)
            .await;
    });

    res.headers_mut().insert(
        salvo::http::header::CONTENT_TYPE,
        salvo::http::HeaderValue::from_static("text/event-stream"),
    );
    res.headers_mut().insert(
        salvo::http::header::CACHE_CONTROL,
        salvo::http::HeaderValue::from_static("no-cache"),
    );
    // 回写请求标识，便于前端/日志按 id 追同一次逻辑请求
    if let Ok(val) = salvo::http::HeaderValue::from_str(&request_id) {
        res.headers_mut().insert("x-request-id", val);
    }
    res.stream(tokio_stream::wrappers::UnboundedReceiverStream::new(
        rx_body,
    ));
}

// ---------------------------------------------------------------------------
// OpenAI messages → RWKV prompt（移植自 ai-adapters/providers/rwkv/request.rs）
// ---------------------------------------------------------------------------

/// 本地 prompt 单条工具输出的字符上限。
///
/// 本地 3B 的 prefill 是逐 token 线性开销：实测 5 万字符工具输出 → 4 万
/// prompt token → 26.5s 才出 16 个 token；截断到 4 千字符后同等请求降到
/// 秒级。3B 也无法从超长输出里"记住"更多内容，截断只丢噪音不丢任务。
const LOCAL_PROMPT_BODY_MAX_CHARS: usize = 4000;

/// 截断单条工具输出（保留开头，附加显式截断标记）。
fn clamp_prompt_body(body: &str) -> String {
    let mut chars = body.chars();
    let head: String = chars.by_ref().take(LOCAL_PROMPT_BODY_MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{head}\n…(truncated)")
    } else {
        head
    }
}

/// OpenAI 格式消息（role/content/tool_calls/tool_call_id）→ RWKV World/Instruction 格式。
fn openai_messages_to_rwkv_prompt(messages: &[Value], tools: Option<&[Value]>) -> String {
    // 本地工人不需要引擎注入的 `working_directory`（人设已要求相对路径）。
    // 它的 schema 每轮都进 prefill，还会挤进 few-shot 示例；实测合成探针
    // （2 工具 read/write）4/4 成功，而真实工人（多出 working_directory）
    // 写出空内容——先摘掉这件噪声工具，让真实工人与探针同面。
    let filtered_tools: Option<Vec<Value>> = tools.map(|defs| {
        defs.iter()
            .filter(|tool| {
                tool.get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
                    != Some("working_directory")
            })
            .cloned()
            .collect()
    });
    let tools = filtered_tools.as_deref();
    let has_tools = tools.is_some_and(|t| !t.is_empty());

    // 单轮抽取任务（恰好 system+user，无工具）→ 官方 Instruction 格式
    if !has_tools && messages.len() == 2 {
        let roles: Vec<&str> = messages
            .iter()
            .map(|m| m.get("role").and_then(|r| r.as_str()).unwrap_or(""))
            .collect();
        if roles == ["system", "user"] {
            let mut prompt = String::new();
            if let Some(instruction) = message_text(&messages[0]) {
                prompt.push_str(&format!("Instruction: {}\n\n", sanitize(&instruction)));
            }
            if let Some(input) = message_text(&messages[1]) {
                prompt.push_str(&format!("Input: {}\n\n", sanitize(&input)));
            }
            prompt.push_str("Response: ");
            return prompt;
        }
    }

    // 官方 G1 只允许一个 System 块：先把所有 system 消息与工具清单合并成一个块，
    // 再按顺序写 user / assistant / tool。多写一个 `System:` 会被 rwkv-pf 判
    // MULTIPLE_SYSTEM / SYSTEM_THEN_ROLE（实测 RWKV 随后把工具调用当纯文本续写）。
    let mut system_text = String::new();
    for msg in messages {
        if msg.get("role").and_then(|r| r.as_str()) != Some("system") {
            continue;
        }
        if let Some(content) = message_text(msg) {
            let text = sanitize(&content);
            if text.is_empty() {
                continue;
            }
            if !system_text.is_empty() {
                system_text.push('\n');
            }
            system_text.push_str(&text);
        }
    }
    if let Some(tool_defs) = tools.filter(|defs| !defs.is_empty()) {
        if !system_text.is_empty() {
            system_text.push('\n');
        }
        system_text.push_str(&tools_block(tool_defs));
    }

    let mut prompt = String::new();
    if !system_text.is_empty() {
        prompt.push_str(&format!("System: {system_text}\n\n"));
    }
    if has_tools {
        if let Some(tool_defs) = tools.filter(|defs| !defs.is_empty()) {
            let hint = hinted_tool(tool_defs, messages);
            let path_hint = hinted_path(messages);
            let content_hint = hinted_content(messages);
            let focus = focus_tool(tool_defs, messages);
            // 观测：few-shot 的路径/正文回声是否命中（3B 会逐字照抄示例值）。
            log::debug!(
                "[ai-gateway] fewshot hints: path={:?} content={:?} focus={:?}",
                path_hint,
                content_hint,
                focus
            );
            if let Some(fewshot) = tool_fewshot_block(
                tool_defs,
                hint,
                path_hint.as_deref(),
                content_hint.as_deref(),
                focus,
            ) {
                prompt.push_str(&fewshot);
            }
        }
    }

    // 收集块：相邻同角色块合并（rwkv-pf 规则 TWO_USER_TURNS / TWO_ASSISTANT_TURNS）。
    //
    // dsh 在一个 turn 开头会连发多条 user 消息（工作目录变更 / 工作目录 /
    // runtime context 快照），各写一个 `User:` 块会让 3B 把"目录"和"上下文
    // 快照"当成任务本身：2026-11-21 用 rwkv-pf 校验真实工人提示词，判定 2 处
    // TWO_USER_TURNS（3 个连续 User 块）。
    //
    // Assistant 侧同理：并行工具调用是同一 assistant 消息里的多个围栏块，
    // 分开写会被判 TWO_ASSISTANT_TURNS；合并成同一个 Assistant 块后，生成点
    // 解析仍只取第一段围栏（与合并前一致）。
    let mut blocks: Vec<(bool, String)> = Vec::new();
    let mut previous_had_tool_calls = false;
    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        match role {
            "system" => {} // 已在上面合并进唯一的 System 块
            "user" => {
                if let Some(content) = message_text(msg) {
                    // 引擎有时把工具结果并回历史成普通 user 正文（无
                    // `Function output:` 前缀），紧随「带 tool_calls 的 assistant」。
                    // 不补前缀的话 3B 会把结果当用户指令——实测随后去调不存在的
                    // `read_file` 想读回 sources.md，白烧工具轮直到熔断。
                    let body = sanitize(&content);
                    // 引擎注入的运行时上下文 / 工作目录变更 / 给父代理的收尾说明：
                    // 对本地 3B 全是噪声（实测真实工人 4.2k 字符提示上自由写作退化，
                    // 只留任务 brief 的合成探针 4/4 成功）。本地路径直接剔除。
                    let trimmed = body.trim_start();
                    if trimmed.starts_with("<system-reminder>")
                        || trimmed.starts_with("The working directory changed")
                    {
                        continue;
                    }
                    let body = match body.find("Your final answer is delivered automatically") {
                        Some(i) => body[..i].trim_end().to_string(),
                        None => body,
                    };
                    if body.trim().is_empty() {
                        continue;
                    }
                    let body = if previous_had_tool_calls {
                        // 紧随工具调用的 user 正文 = 引擎并回的工具结果 → 同样截断
                        let body = clamp_prompt_body(&body);
                        if body.starts_with("Function output:") {
                            body
                        } else {
                            format!("Function output:\n{body}")
                        }
                    } else {
                        body
                    };
                    push_prompt_block(&mut blocks, true, body);
                }
            }
            "assistant" => {
                if let Some(tool_calls) = msg.get("tool_calls").and_then(|t| t.as_array()) {
                    for tc in tool_calls {
                        let function = tc.get("function").cloned().unwrap_or(Value::Null);
                        let value = json!({
                            "name": function.get("name").cloned().unwrap_or(Value::Null),
                            "arguments": function.get("arguments").cloned().unwrap_or(Value::Null),
                        });
                        push_prompt_block(&mut blocks, false, format!("```json\n{value}\n```"));
                    }
                } else if let Some(content) = message_text(msg) {
                    push_prompt_block(&mut blocks, false, sanitize(&content));
                }
            }
            "tool" => {
                if let Some(content) = message_text(msg) {
                    push_prompt_block(
                        &mut blocks,
                        true,
                        format!(
                            "Function output:\n{}",
                            clamp_prompt_body(&sanitize(&content))
                        ),
                    );
                }
            }
            _ => {}
        }
        previous_had_tool_calls = msg
            .get("tool_calls")
            .and_then(|t| t.as_array())
            .is_some_and(|calls| !calls.is_empty());
    }

    for (is_user, body) in blocks {
        let label = if is_user { "User" } else { "Assistant" };
        prompt.push_str(&format!("{label}: {body}\n\n"));
    }

    if has_tools {
        // 官方 G1x 模板的续写起点直接给到 name 键：3B 模型自由续写时经常漏掉
        // `{"name":` 直接从 `{"arguments":` 开始（2026-11-20 实测多轮），
        // 预填前缀后它只需要续写工具名；解析时由 TOOL_CALL_PREFILL 补回。
        prompt.push_str("Assistant: ```json\n");
        prompt.push_str(TOOL_CALL_PREFILL);
    } else {
        prompt.push_str("Assistant: ");
    }
    audit_prompt_format(&prompt);
    prompt
}

/// 追加一个提示词块；相邻的同角色块合并（见调用处说明）。
fn push_prompt_block(blocks: &mut Vec<(bool, String)>, is_user: bool, text: String) {
    let text = text.trim().to_string();
    if text.is_empty() {
        return;
    }
    if let Some((last_is_user, last)) = blocks.last_mut() {
        if *last_is_user == is_user {
            last.push('\n');
            last.push_str(&text);
            return;
        }
    }
    blocks.push((is_user, text));
}

/// 提示词格式自检（对齐 rwkv-pf 的关键规则，常开、零依赖）。
///
/// 为什么要有：`rwkv-prompt-format` 仓库里已有完整检查器，但推理链路此前
/// **一次都没调用**——格式问题只能靠模型表现反推。这里把最致命且可判定的几条
/// 内建到构造出口：连续 User / 连续 Assistant / 多 System / 生成点位置 / CRLF /
/// 块内空行。违规只记 warn（不阻断推理），并支持 `AI00X_RWKV_PROMPT_DEBUG`
/// 把真实提示词落盘，便于直接用 rwkv-pf 复查。
fn audit_prompt_format(prompt: &str) {
    let violations = scan_prompt_violations(prompt);
    if !violations.is_empty() {
        log::warn!("[ai-gateway] RWKV prompt format violations: {violations:?}");
    }
    if let Ok(path) = std::env::var("AI00X_RWKV_PROMPT_DEBUG") {
        if !path.trim().is_empty() {
            if let Err(e) = std::fs::write(&path, prompt) {
                log::warn!("[ai-gateway] dump RWKV prompt to {path} failed: {e}");
            }
        }
    }
}

/// 扫描提示词里的格式违规（返回 rwkv-pf 风格的规则名）。
fn scan_prompt_violations(prompt: &str) -> Vec<String> {
    const LABELS: [&str; 6] = [
        "System:",
        "Instruction:",
        "User:",
        "Assistant:",
        "Input:",
        "Response:",
    ];
    let mut violations: Vec<String> = Vec::new();
    if prompt.contains("\r\n") {
        violations.push("CRLF".to_string());
    }
    if prompt.contains("\n\n\n") {
        violations.push("EXTRA_BLANK_SEPARATOR".to_string());
    }
    // 块边界恒为单个空行（sanitize 已折叠块内空行），按 "\n\n" 切分即等于块
    let chunks: Vec<&str> = prompt
        .split("\n\n")
        .filter(|c| !c.trim().is_empty())
        .collect();
    let label_of = |chunk: &str| -> Option<&'static str> {
        LABELS
            .iter()
            .copied()
            .find(|label| chunk.starts_with(label))
    };
    let mut system_blocks = 0usize;
    let mut previous: Option<&'static str> = None;
    for chunk in &chunks {
        let Some(label) = label_of(chunk) else {
            violations.push("NO_ROLE_LABEL".to_string());
            continue;
        };
        if label == "System:" {
            system_blocks += 1;
        }
        if matches!(label, "User:" | "Assistant:") && previous == Some(label) {
            violations.push(
                if label == "User:" {
                    "TWO_USER_TURNS"
                } else {
                    "TWO_ASSISTANT_TURNS"
                }
                .to_string(),
            );
        }
        previous = Some(label);
    }
    if system_blocks > 1 {
        violations.push("MULTIPLE_SYSTEM".to_string());
    }
    if !chunks
        .last()
        .is_some_and(|chunk| chunk.starts_with("Assistant:") || chunk.starts_with("Response:"))
    {
        violations.push("ENDS_ON_NON_ASSISTANT".to_string());
    }
    violations
}

/// 取消息文本（兼容 string content 与数组 content 的 text 部分）。
pub(crate) fn message_text(msg: &Value) -> Option<String> {
    match msg.get("content")? {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => {
            let texts: Vec<String> = parts
                .iter()
                .filter_map(|p| {
                    if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                        p.get("text")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join(""))
            }
        }
        _ => None,
    }
}

/// 工具定义注入（官方 RWKV-7 G1x function call 模板）。
///
/// 工具说明文本（**不含** `System:` 前缀）。
///
/// 格式见 <https://www.rwkv.cn/docs/RWKV-Prompts/Prompt-Format#function-call>：
/// 官方示例是紧凑签名行（`- get_weather(location: string, unit?: ...)`），
/// 但 3B 实测（2026-11-23，16 例 ×3）签名行 **21/48**，而 JSON Schema 清单
/// **30/48**：模型会把签名行里的参数名续写成 `patternir`/`pattern.glob` 这类
/// 变体、丢掉必填键；带 `required` 的 JSON 清单反而让参数键逐字对齐。
/// 因此维持 JSON 数组格式（name / description / required / arguments）。
/// description 必须保留——模型靠它判断何时调用哪个工具（丢失会导致模型把
/// 调用当纯文本续写）。
///
/// 官方 G1 模板只允许一个 `System:` 块（`rwkv-pf` 规则 `MULTIPLE_SYSTEM` /
/// `SYSTEM_THEN_ROLE`），所以工具清单必须拼进同一个 System 块内，不能另起块。
fn tools_block(tools: &[Value]) -> String {
    let defs: Vec<Value> = tools
        .iter()
        .filter_map(|tool| {
            let f = tool.get("function")?;
            // 属性 schema 压缩：属性级 description 对 3B 的工具选择没有增量
            // 信息，却把真实工人 prompt 撑到 15k+ 字符（2026-11-24 实测：本地
            // 工人在 4.2k token 提示上输出退化）。只保留类型/枚举/数组元素。
            let arguments = f
                .get("parameters")
                .and_then(|p| p.get("properties"))
                .map(compact_properties)
                .unwrap_or_else(|| json!({}));
            // required 必须进清单：3B 只看 properties 时会输出 {} 或漏掉必填键
            //（2026-11-23 能力测试：glob/read 多例空参数）。
            let required = f
                .get("parameters")
                .and_then(|p| p.get("required"))
                .cloned()
                .unwrap_or_else(|| json!([]));
            Some(json!({
                "name": f.get("name").cloned().unwrap_or(Value::Null),
                "description": compact_description(
                    f.get("description").and_then(|d| d.as_str()).unwrap_or("")
                ),
                "required": required,
                "arguments": arguments,
            }))
        })
        .collect();
    // 紧凑 JSON（不缩进）：工具清单每轮都要进 prefill，pretty 的换行/缩进
    // 纯属浪费（本地 3B 也不靠缩进理解结构）；语义完全相同。
    //
    // NOTE(2026-11-23)：曾在这里补一句「read 只读文本、read_image 只读图片」
    // 的自然语言分界，实测反而让 3B 拼出 `greplines`/`globAll`/`readcode`
    // 这类粘连工具名（工具清单块只该是 JSON + 固定指令），已回退。
    // 观测：本地请求的工具面（档位拆分后应显著缩小；排查 3B 退化时先看这里）。
    log::debug!(
        "[ai-gateway] tools block: {} tool(s) [{}]",
        tools.len(),
        tools
            .iter()
            .filter_map(|tool| tool
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str()))
            .collect::<Vec<_>>()
            .join(",")
    );
    format!(
        "Tools:\n{}\nReturn only a JSON function call.",
        serde_json::to_string(&defs).unwrap_or_default()
    )
}

/// 工具描述限长：只留首句（≤120 字符）。工具选择靠名字 + 首句语义；保留
/// 整段说明在真实工人 prompt 里是纯负担（dsh-tool-fs 的 read 描述带整段
/// 编辑规范）。
fn compact_description(text: &str) -> String {
    const MAX: usize = 120;
    let first = text.split(['.', '。', '\n']).next().unwrap_or("").trim();
    let first = if first.is_empty() { text.trim() } else { first };
    if first.chars().count() <= MAX {
        first.to_string()
    } else {
        let mut out: String = first.chars().take(MAX).collect();
        out.push('…');
        out
    }
}

/// 属性 schema 压缩（递归）：只保留 type / enum / items，丢掉 description。
fn compact_properties(props: &Value) -> Value {
    let Some(map) = props.as_object() else {
        return props.clone();
    };
    let mut out = serde_json::Map::new();
    for (key, schema) in map {
        out.insert(key.clone(), compact_schema(schema));
    }
    Value::Object(out)
}

fn compact_schema(schema: &Value) -> Value {
    let Some(obj) = schema.as_object() else {
        return schema.clone();
    };
    let mut out = serde_json::Map::new();
    for key in ["type", "enum", "items"] {
        if let Some(value) = obj.get(key) {
            out.insert(
                key.to_string(),
                if key == "items" {
                    compact_schema(value)
                } else {
                    value.clone()
                },
            );
        }
    }
    Value::Object(out)
}

/// 所有 user 消息文本。引擎会把运行时上下文（`<system-reminder>`）与任务
/// brief 放进同一个 user 消息的不同文本块，也可能把 reminder 作为单独一条
/// user 消息排在 brief 之后——按「最后一条 user」取会拿到 reminder，导致
/// few-shot 的路径/工具提示全部失效（实测 path=None）。
fn user_texts(messages: &[Value]) -> Vec<String> {
    messages
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .filter_map(message_text)
        .collect()
}

/// 最后一条 user brief 里点名的工具名——few-shot 选例的第一优先级。
///
/// 编排者的 brief 会明确写「用 `ai00_research_collect` 一次完成」，被点名的
/// 那件才是本轮真正要调的工具；不点名时返回 None，退回到默认优先级。
fn hinted_tool<'a>(tools: &'a [Value], messages: &[Value]) -> Option<&'a str> {
    let texts = user_texts(messages);
    tools.iter().find_map(|tool| {
        let name = tool
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())?;
        (name.starts_with("ai00_") && texts.iter().any(|t| t.contains(name))).then_some(name)
    })
}

/// 最后一条 user brief 里点名的文件名（few-shot 的路径示例用真实目标名）。
///
/// 血案（2026-11-23）：brief 要写 `hello-cache.txt`，few-shot 的路径示例恒为
/// `note.txt`，本地 3B 直接照抄示例值——工人把内容写进 `note.txt`，验收读
/// `hello-cache.txt` 失败、白返工一轮。示例值改成 brief 里出现的文件名后，
/// 模型照抄的也是正确目标。
fn hinted_path(messages: &[Value]) -> Option<String> {
    const EXTS: [&str; 8] = [".txt", ".md", ".json", ".csv", ".py", ".js", ".ts", ".html"];
    // 取「出现次数最多」的文件名，平票取最后一次出现：分节 brief 里骨架名
    // 只出现一次（`guide.skeleton.md`），真正的输出文件在任务句 + 示例里
    // 至少出现两次；只看第一个会把 write 目标误判成骨架。
    let mut counts: Vec<(String, usize, usize)> = Vec::new();
    let mut index = 0usize;
    for text in user_texts(messages) {
        for token in text
            .split(|c: char| c.is_whitespace() || "，。；：“”‘’（）()[]{}<>\"'`、,;:".contains(c))
        {
            index += 1;
            let token = token.trim_matches(|c: char| {
                !(c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
            });
            let lower = token.to_ascii_lowercase();
            let looks_like_file = token.len() >= 5
                && token.len() <= 64
                && !token.contains('/')
                && !token.contains('\\')
                && !matches!(token, "AGENTS.local.md" | "CLAUDE.local.md")
                && EXTS.iter().any(|ext| lower.ends_with(ext));
            if !looks_like_file {
                continue;
            }
            match counts.iter_mut().find(|(name, _, _)| name == token) {
                Some((_, count, last)) => {
                    *count += 1;
                    *last = index;
                }
                None => counts.push((token.to_string(), 1, index)),
            }
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, count, last)| (*count, *last))
        .map(|(name, _, _)| name)
}

/// 最后一条 brief 的任务意图 → 最可能被调用的工具名（须在 tools 表内）。
///
/// few-shot 末位示例几乎决定 3B 的工具选择（见 `tool_fewshot_block`），示例
/// 顺序不能只按工具表顺序。关键词优先级从具体到宽泛：图片 → 写入 → 检索 →
/// 找文件 → 读文本；都不命中返回 None（保持原顺序）。
fn focus_tool<'a>(tools: &'a [Value], messages: &[Value]) -> Option<&'a str> {
    let text = user_texts(messages).join("\n").to_ascii_lowercase();
    let available = |name: &str| {
        tools.iter().any(|tool| {
            tool.get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                == Some(name)
        })
    };
    let pick = |name: &'static str| -> Option<&'a str> { available(name).then_some(name) };
    let any = |keywords: &[&str]| keywords.iter().any(|k| text.contains(k));

    if any(&[
        ".png", ".jpg", ".jpeg", ".webp", ".gif", "图片", "图像", "截图",
    ]) {
        return pick("read_image");
    }
    // 写入意图写在「读」之前：brief 常说「创建 a.md 并读回确认」，首个工具是
    // write；若按 .md 判成 read，末位示例会把模型带向读而不是写。
    if any(&[
        "创建",
        "新建",
        "写入",
        "编写",
        "写一个",
        "写一份",
        "保存",
        "生成",
        "create",
        "write",
        "save",
    ]) {
        return pick("write");
    }
    if any(&["grep", "搜索", "查找内容", "匹配", "todo"]) {
        return pick("grep");
    }
    if any(&[
        "glob",
        "找文件",
        "查找文件",
        "列出",
        "有哪些",
        "文件列表",
        "目录结构",
        "项目结构",
        "文件结构",
    ]) {
        return pick("glob");
    }
    if any(&[
        ".md", ".txt", ".json", ".rs", ".js", ".ts", ".toml", ".yaml", ".yml", "readme", "读",
        "查看", "打开",
    ]) {
        return pick("read");
    }
    None
}

/// 最后一条 brief 里「要写入的正文」——few-shot 的 write 示例正文回声。
///
/// 血案（2026-11-24）：brief 要求正文恰好一行 `console.log('local ok')`，
/// 但 few-shot 的 write 示例 content 恒为 "hello"，3B 逐字模仿成
/// `console.log('local ok', 'hello')`——示例里的 hello 直接污染了真实内容。
/// 把 brief 中反引号/双引号包起来的**正文片段**（非文件名、含空格或标点、
/// ≤120 字符）作为示例正文，模型照抄的就是目标内容。
fn hinted_content(messages: &[Value]) -> Option<String> {
    let texts = user_texts(messages);
    let mut best: Option<String> = None;
    for text in texts.iter().rev() {
        for quote in ['`', '"'] {
            let mut rest = text.as_str();
            while let Some(start) = rest.find(quote) {
                let after = &rest[start + quote.len_utf8()..];
                let Some(end) = after.find(quote) else {
                    break;
                };
                let span = after[..end].trim();
                if looks_like_content(span) && best.as_ref().is_none_or(|b| span.len() > b.len()) {
                    best = Some(span.to_string());
                }
                rest = &after[end + quote.len_utf8()..];
            }
        }
        if best.is_some() {
            return best;
        }
    }
    None
}

/// 片段是否像「文件正文」而不是文件名/路径：1..=120 字符，且含空白或标点
/// （`console.log('local ok')`、`local capability ok`），排除 `probe.js`、
/// `src/main.rs` 这类裸路径。
fn looks_like_content(span: &str) -> bool {
    let trimmed = span.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 120 || trimmed.contains('\n') {
        return false;
    }
    // 验收命令常以引号/反引号出现（`node -e "…process.exit(1)"`），不是正文。
    let lower = trimmed.to_ascii_lowercase();
    let command_like = [
        "node ",
        "pwsh ",
        "powershell",
        "cargo ",
        "pnpm ",
        "npm ",
        "npx ",
        "git ",
        "python ",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
        || trimmed.contains("process.exit(");
    if command_like {
        return false;
    }
    let has_shape = trimmed
        .chars()
        .any(|c| c.is_whitespace() || "(){}[]:=;<>'\"".contains(c));
    // 含路径分隔符的裸串一律按路径处理（Windows 盘符路径含冒号，旧判定会把它
    // 当成「正文」——实测 2026-11-24 fewshot content 回显了任务目录绝对路径）。
    let has_path_sep = trimmed.contains('\\') || trimmed.contains('/');
    let looks_like_path = has_path_sep
        || (!trimmed.contains(char::is_whitespace)
            && trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "./\\_-".contains(c)));
    has_shape && !looks_like_path
}

/// 一轮对话式 few-shot（2026-11-11 prompt_lab 实验：对话轮示例是 3B 工具
/// 调用 JSON 合法性的决定性变量——零样本会多闭合括号，而把示例写进
/// System 文本完全无效）。示例从当次工具表合成（优先首个能合成出非空
/// 参数的工具），保证示例工具恒在表内；格式模仿可泛化到表内其他工具
/// （三选一实测 3/3）。
fn tool_fewshot_block(
    tools: &[Value],
    hint: Option<&str>,
    path_hint: Option<&str>,
    content_hint: Option<&str>,
    focus: Option<&str>,
) -> Option<String> {
    // 优先选能合成出非空参数的工具做示例：空参数（{}）示例会让模型在需要
    // 填参数时把 JSON schema 结构当参数值复读（2026-11-11 实测 3/3 复现）。
    //
    // 示例取两个：3B 逐字模仿示例的参数键名，只给一个示例时没覆盖到的工具
    // 会去抄训练数据里的别的 schema（实测 write 没示例 → 输出 Claude Write 的
    // description/justification，漏掉 file_path，白烧 6 轮）。
    //
    // 选例顺序（2026-11-21）：brief 里点名的工具 → ai00_research_collect →
    // write → 其余。brief 点名的那件才是本轮真正要调的工具；不点名时
    // research 工人以前只会看到 read/read_image 的示例，从不示范检索工具。
    //
    // 2026-11-23 补 focus：3B 逐字模仿「最靠近真实任务」的示例，末位示例几乎
    // 决定工具选择——README 任务 2/2 选了 read_image，只因示例末位恰好是
    // read_image。focus = brief 意图推断出的工具，其示例排进前四并挪到**末位**。
    let priority = |index: usize| -> u8 {
        let name = tools[index]
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("");
        if hint == Some(name) {
            0
        } else if focus == Some(name) {
            1
        } else if name == "ai00_research_collect" {
            2
        } else if name == "write" {
            3
        } else {
            4
        }
    };
    let mut order: Vec<usize> = (0..tools.len()).collect();
    order.sort_by_key(|&index| (priority(index), index));

    let mut examples: Vec<(String, String)> = Vec::new();
    let mut empty_candidate: Option<String> = None;
    for index in order {
        let tool = &tools[index];
        let Some(function) = tool.get("function") else {
            continue;
        };
        let Some(name) = function.get("name").and_then(|n| n.as_str()) else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let mut args = serde_json::Map::new();
        let params = function.get("parameters");
        let required: Vec<String> = params
            .and_then(|p| p.get("required"))
            .and_then(|r| r.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(props) = params
            .and_then(|p| p.get("properties"))
            .and_then(|p| p.as_object())
        {
            // 必填参数优先；不足两个再用字符串类可选参数补（数字/布尔可选键
            // 会引出 offset/limit 之类的噪音示例，3B 会照抄）。
            for (key, schema) in props.iter() {
                if args.len() >= 2 {
                    break;
                }
                let ty = schema.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let is_required = required.iter().any(|r| r == key);
                if !is_required && ty != "string" && ty != "array" {
                    continue;
                }
                // 示例值必须真实感且互异：占位符（"example"）会让模型丢失
                // 参数绑定能力——复读 schema 结构或塌陷重复（p2/p4/p6 实测），
                // 真实值则连工具选择都纠正（p5 错选 vs p7 全对）。
                let value = match ty {
                    "string" => json!(sample_string_arg(name, key, path_hint, content_hint)),
                    "number" | "integer" => json!(1),
                    "boolean" => json!(true),
                    // 数组参数（queries / urls）：给一个元素的真实示例，
                    // 否则模型会把 schema 结构塞进数组或干脆漏掉该键。
                    "array" => json!([sample_string_arg(name, key, path_hint, content_hint)]),
                    _ => continue,
                };
                args.insert(key.clone(), value);
            }
        }
        if args.is_empty() {
            if empty_candidate.is_none() {
                empty_candidate = Some(build_fewshot(name, args));
            }
            continue;
        }
        examples.push((name.to_string(), build_fewshot(name, args)));
        // 每个工具都给示例：只给前两个时，其余工具会去抄训练数据里的别的
        // schema（实测 read_image 抄 read 的 file_path、grep 抄出破损 JSON）。
        if examples.len() >= 4 {
            break;
        }
    }
    if examples.is_empty() {
        return empty_candidate;
    }
    // 意图工具（focus）的示例挪到末位：最靠近真实任务的示例对 3B 的工具选择
    // 影响最大；brief 点名了工具（hint）时不重排——点名工具的示例已在首位，
    // 且它的名字会被直接照抄。
    if hint.is_none() {
        if let Some(name) = focus {
            if let Some(pos) = examples.iter().position(|(n, _)| n == name) {
                let item = examples.remove(pos);
                examples.push(item);
            }
        }
    }
    Some(examples.into_iter().map(|(_, ex)| ex).collect())
}

/// few-shot 字符串参数示例值（按工具+参数名挑最贴近真实用法的样例）。
/// `path_hint` = brief 里点名的文件名：路径类参数优先用它，避免模型照抄
/// 示例里的固定文件名。
/// `content_hint` = brief 里引号包起来的正文：write 的 content 优先用它
/// （3B 会把示例正文逐字抄进真实写入内容）。
fn sample_string_arg(
    tool: &str,
    key: &str,
    path_hint: Option<&str>,
    content_hint: Option<&str>,
) -> String {
    // 检索类：pattern 的示例必须是能直接用的真实表达式（旧值恒为 "hello"，
    // 3B 会把 "hello" 当 glob 模式照抄，搜不到目标文件）。
    match (tool, key) {
        ("glob", "pattern") => return "**/*.md".to_string(),
        ("grep", "pattern") => return "TODO".to_string(),
        ("grep", "include") | ("grep", "glob") => return "*.rs".to_string(),
        ("write", "content") => {
            return content_hint
                .map(str::to_string)
                .unwrap_or_else(|| "Hello from the local worker.".to_string());
        }
        _ => {}
    }
    if key.contains("path") {
        if let Some(hint) = path_hint {
            return hint.to_string();
        }
        return match tool {
            "read" => "README.md".to_string(),
            "read_image" => "assets/logo.png".to_string(),
            "glob" | "grep" => "src".to_string(),
            _ => "note.txt".to_string(),
        };
    }
    if key.contains("query") || key.contains("queries") {
        "agent memory architecture".to_string()
    } else if key.contains("url") {
        "https://www.rwkv.cn".to_string()
    } else if key.contains("title") {
        "Reminder".to_string()
    } else if key.contains("message") || key.contains("msg") {
        "Don't forget your meeting at 3 PM.".to_string()
    } else if key.contains("cwd") || key.contains("dir") {
        "C:/work/demo".to_string()
    } else if key.contains("topic") {
        "agent memory architecture".to_string()
    } else {
        "hello".to_string()
    }
}

fn build_fewshot(name: &str, args: serde_json::Map<String, Value>) -> String {
    // 手工拼串保证 name 在 arguments 前，且冒号后带空格——3B 逐字模仿示例
    // 风格：无空格紧凑风格会让输出丢 arguments 包装（2026-11-11 实测 3/3
    // 扁平化；带空格风格 3/3 正确），也不受 preserve_order feature 影响。
    let call = format!(
        "{{\"name\": {}, \"arguments\": {}}}",
        serde_json::to_string(name).unwrap_or_default(),
        spaced_json(&Value::Object(args))
    );
    format!("User: Use the {name} tool.\n\nAssistant: ```json\n{call}\n```\n\n")
}

/// 冒号后带空格的紧凑 JSON（`{"a": 1, "b": "x"}`）——few-shot 示例的
/// 固定排版，模型精确模仿该风格输出。
fn spaced_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let entries: Vec<String> = map
                .iter()
                .map(|(k, v)| {
                    format!(
                        "{}: {}",
                        serde_json::to_string(k).unwrap_or_default(),
                        spaced_json(v)
                    )
                })
                .collect();
            format!("{{{}}}", entries.join(", "))
        }
        Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(spaced_json).collect();
            format!("[{}]", items.join(", "))
        }
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

/// 流式正文当前可安全发出的字符数（stop 安全回看）。
///
/// 只扣住「可能正在拼成某个 stop 序列的尾部」：取所有 stop 里最长的、等于
/// `text` 末尾的前缀长度。旧实现固定扣 16 个字符（最长 stop 长度 + 1）——中文
/// 约 1 token/字，首屏要等 16 个 token 才发出第一段；与长 prefill 交错时
/// （3 步解码/块）实测首字节被拖到 1.25s。改成前缀感知后，普通正文每 token
/// 即可发出，只有真的出现 `User` / `\n\nInstruction` 这类前缀时才短暂扣留。
fn safe_emit_len(text: &str, stops: &[String]) -> usize {
    let tail: Vec<char> = text.chars().collect();
    let mut hold = 0usize;
    for stop in stops {
        let max = stop.chars().count().min(tail.len());
        for k in (1..=max).rev() {
            if tail[tail.len() - k..]
                .iter()
                .copied()
                .eq(stop.chars().take(k))
            {
                hold = hold.max(k);
                break;
            }
        }
    }
    tail.len() - hold
}

/// 本地 RWKV 停止序列（local_rwkv_sse / hybrid 工具轮共用）：角色标记组，
/// Instruction 格式加空行停，工具轮加围栏收尾（与 consult.ts FENCE_STOPS
/// 对齐：遇闭合 ``` 即停，省 token 并减少 bleed 对提取的干扰）。
///
/// 另加**不带换行**的 `User:` / `Assistant:`：3B 在对话格式下会把答案接到
/// 句末后直接自续下一轮（实测 `…回答问题。User: 请给我写一篇…`），只靠
/// `\n\nUser:` 拦不住（没有换行）。
fn rwkv_stop_sequences(is_instruction_format: bool, has_tools: bool) -> Vec<String> {
    let mut stop = vec![
        "\n\nUser:".to_string(),
        "\n\nSystem:".to_string(),
        "\n\nInstruction:".to_string(),
        "\n\nInput:".to_string(),
        "\nUser:".to_string(),
        "\nAssistant:".to_string(),
        "User:".to_string(),
        "Assistant:".to_string(),
    ];
    if is_instruction_format {
        stop.push("\n\n".to_string());
    }
    if has_tools {
        stop.push("\n```".to_string());
    }
    stop
}

/// 客户端 `stop`（OpenAI 兼容：string 或 string[]）→ 追加到内置停止串。
/// 约束：跳过空串、单条 ≤64 字符、最多 8 条（去重）。此前本地分支完全忽略
/// 客户端 stop，agent 传 `\nUser:` 之类的停止串也不生效，会白生成一段。
fn client_stop_sequences(body: &Value) -> Vec<String> {
    let candidates: Vec<&str> = match body.get("stop") {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str()).collect(),
        _ => Vec::new(),
    };
    let mut out: Vec<String> = Vec::new();
    for s in candidates {
        let s = s.trim();
        if s.is_empty() || s.chars().count() > 64 || out.len() >= 8 {
            continue;
        }
        if !out.iter().any(|x| x == s) {
            out.push(s.to_string());
        }
    }
    out
}

fn sanitize(content: &str) -> String {
    let s = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut result = String::with_capacity(s.len());
    let mut prev_newline = false;
    for ch in s.chars() {
        if ch == '\n' {
            if !prev_newline {
                result.push('\n');
            }
            prev_newline = true;
        } else {
            result.push(ch);
            prev_newline = false;
        }
    }
    result.trim_end_matches('\n').to_string()
}

/// 熔断轮终答：**证据优先于模型自述**。
///
/// 熔断只说明"工具预算用尽"，不等于任务失败：实测本地工人 6 轮里前两轮就已
/// 成功 `write` + `read`，后面四轮只是同一个写调用的复读，最后模型喊 BLOCKED——
/// 编排者据此升级云端，等于为一份已经落盘的文件再付一次远端费用。
/// 所以本回合只要存在**成功工具结果**，就以该结果作为交付证据输出 `DONE:`；
/// 一次成功都没有才输出 `BLOCKED:`。
fn finalize_exhausted_text(model_text: &str, messages: &[Value]) -> String {
    match last_successful_tool_result(messages) {
        Some(evidence) => format!("DONE: {evidence}"),
        None => sanitize_blocked_text(model_text),
    }
}

/// 最后一条**成功**工具结果的摘要。
///
/// 不能只看 `role == "tool"`：引擎把工具结果并回历史时可能渲染成 user 正文
/// （`Function output: …`），见 `tool_result_text`。`no results` / `Error`
/// 这类空结果与失败结果不算证据——否则熔断轮会把"什么都没搜到"收尾成 DONE。
fn last_successful_tool_result(messages: &[Value]) -> Option<String> {
    const MAX_CHARS: usize = 160;
    let mut fallback: Option<String> = None;
    for index in (0..messages.len()).rev() {
        let Some(text) = tool_result_text_at(messages, index) else {
            continue;
        };
        if is_failed_tool_text(&text) {
            continue;
        }
        // 空写入不是证据（0 字节文件曾被当作交付物，见 write_call_is_empty）
        let call_id = messages
            .get(index)
            .and_then(|m| m.get("tool_call_id"))
            .and_then(|v| v.as_str());
        let is_empty_write = find_tool_call_name(messages, call_id).as_deref() == Some("write")
            && write_call_is_empty(messages, call_id);
        if is_empty_write {
            continue;
        }
        if text.contains("<path>") {
            return Some(summarize_tool_text(&text, MAX_CHARS));
        }
        if fallback.is_none() {
            fallback = Some(summarize_tool_text(&text, MAX_CHARS));
        }
    }
    fallback
}

fn summarize_tool_text(text: &str, max_chars: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(max_chars).collect()
}

/// 工具结果正文（兼容 `role=tool` 与引擎把结果并回历史后渲染成的 user 正文
/// `Function output: …` 形态）。
///
/// 只认 role=tool 会漏掉后者：research 工人的检索结果就是这样进历史的，
/// 熔断轮因此把"已经搜到了内容"判成"什么都没做"，输出 BLOCKED 触发无谓的
/// 云端升级（2026-11-21 会话 session-369d2a7d 实测）。
fn tool_result_text(msg: &Value) -> Option<String> {
    let text = message_text(msg)?.trim().to_string();
    if text.is_empty() {
        return None;
    }
    let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
    if role == "tool" {
        return Some(text);
    }
    let stripped = text.strip_prefix("Function output:")?.trim();
    (!stripped.is_empty()).then(|| stripped.to_string())
}

/// 工具结果是否为**失败/空**（不能当交付证据）。
///
/// `ai00_search: no results` / `ai00_research_collect: no results` 这类文本
/// 曾被算作成功工具结果，导致"什么都没搜到"被收尾成 `DONE:`；这里显式排除。
fn is_failed_tool_text(text: &str) -> bool {
    let text = text.trim();
    text.starts_with("Error")
        || text.starts_with("ERR ")
        || text.contains("ai00_search: no results")
        || text.contains("ai00_research_collect: no results")
        || text.contains("web extract: no results")
}

/// 某条消息是否承载工具结果（`role=tool`，或紧随工具调用的 user 正文）。
fn tool_result_text_at(messages: &[Value], index: usize) -> Option<String> {
    let msg = messages.get(index)?;
    if let Some(text) = tool_result_text(msg) {
        return Some(text);
    }
    let previous = messages.get(index.checked_sub(1)?)?;
    let previous_had_calls = previous
        .get("tool_calls")
        .and_then(|t| t.as_array())
        .is_some_and(|calls| !calls.is_empty());
    if !previous_had_calls {
        return None;
    }
    let text = message_text(msg)?.trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// 终结型工具：它们的成功结果本身就代表任务达成，下一轮无需再推理。
const TERMINAL_TOOLS: [&str; 2] = ["write", "ai00_research_collect"];

/// 本回合最后一次成功工具结果若来自终结型工具，返回其摘要（供 `DONE:` 收尾）。
fn terminal_tool_completion(messages: &[Value]) -> Option<String> {
    let index = messages.len().checked_sub(1)?;
    let text = tool_result_text_at(messages, index)?;
    if is_failed_tool_text(&text) {
        return None;
    }
    let call_id = messages[index].get("tool_call_id").and_then(|v| v.as_str());
    let name = find_tool_call_name(messages, call_id)?;
    if !TERMINAL_TOOLS.contains(&name.as_str()) {
        return None;
    }
    if name == "write" && write_call_is_empty(messages, call_id) {
        return None;
    }
    Some(summarize_tool_text(&text, 160))
}

/// `write` 调用是否写了空内容。
///
/// 实测（2026-11-21 会话 511e40de）：本地 3B 在长文退化后发出
/// `{"content":"","file_path":"report.md"}`，`write` **成功**返回 `<path>…</path>`，
/// 终结短路据此判定「任务达成」并以 `DONE:` 收尾——留下一个 0 字节交付物，
/// 直到验收才发现。空写入不算交付证据。
fn write_call_is_empty(messages: &[Value], call_id: Option<&str>) -> bool {
    let Some(args) = find_tool_call_arguments(messages, call_id) else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&args) else {
        return false;
    };
    parsed
        .get("content")
        .and_then(Value::as_str)
        .map(|content| content.trim().is_empty())
        .unwrap_or(true)
}

/// 反查某个 tool_call id 对应的调用参数（与 `find_tool_call_name` 同源遍历）。
fn find_tool_call_arguments(messages: &[Value], call_id: Option<&str>) -> Option<String> {
    for msg in messages.iter().rev() {
        let Some(calls) = msg.get("tool_calls").and_then(|c| c.as_array()) else {
            continue;
        };
        for call in calls.iter().rev() {
            let Some(function) = call.get("function") else {
                continue;
            };
            let id = call.get("id").and_then(|v| v.as_str());
            if let (Some(want), Some(have)) = (call_id, id) {
                if want != have {
                    continue;
                }
            }
            let arguments = function.get("arguments")?;
            return Some(match arguments {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            });
        }
    }
    None
}

/// 反查某个 tool_call id 对应的工具名（无 id 时取最近一次 assistant 的最后一个调用）。
fn find_tool_call_name(messages: &[Value], call_id: Option<&str>) -> Option<String> {
    for msg in messages.iter().rev() {
        let Some(calls) = msg.get("tool_calls").and_then(|c| c.as_array()) else {
            continue;
        };
        for call in calls.iter().rev() {
            let Some(function) = call.get("function") else {
                continue;
            };
            let Some(name) = function.get("name").and_then(|n| n.as_str()) else {
                continue;
            };
            let id = call.get("id").and_then(|v| v.as_str());
            match (call_id, id) {
                (Some(want), Some(have)) if want != have => continue,
                _ => return Some(name.to_string()),
            }
        }
    }
    None
}

/// 同一回合里再次提交**同一调用**（同工具 + 规范化参数）→ 立即收尾。
///
/// 3B 在任务达成后会复读调用（实测同一检索查询连发 4 次，每轮全量 prefill +
/// 一次工具往返）。`write` 保留按写入内容判定的旧逻辑（复读时 3B 会把参数写坏，
/// 逐字段比对抓不住）；其余工具按规范化 JSON 比对。
fn repeated_tool_call(messages: &[Value], name: &str, arguments: &str) -> bool {
    if name == "write" {
        return repeated_write_call(messages, name, arguments);
    }
    let Some(current) = canonical_args(arguments) else {
        return false;
    };
    let Some(previous_calls) = messages
        .iter()
        .rev()
        .find_map(|msg| msg.get("tool_calls").and_then(|c| c.as_array()))
    else {
        return false;
    };
    previous_calls.iter().any(|call| {
        let Some(function) = call.get("function") else {
            return false;
        };
        if function.get("name").and_then(|n| n.as_str()) != Some(name) {
            return false;
        }
        let raw = match function.get("arguments") {
            Some(Value::String(text)) => text.clone(),
            Some(value) => value.to_string(),
            None => return false,
        };
        canonical_args(&raw).as_deref() == Some(current.as_str())
    })
}

/// 参数规范化：解析成 JSON 后重排序列化（serde_json 的 Map 默认有序），
/// 解析失败返回 None（调用方按"不重复"处理，宁可多跑一轮也不误收尾）。
fn canonical_args(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    Some(value.to_string())
}

/// 同一回合里再次提交**同内容**的 write（幂等写复读）。
///
/// 3B 在任务已达成后仍会复读同一个写调用（实测 4 轮，每轮全量 prefill + 一次
/// 工具往返），而且复读时参数会被它自己写坏（补上 `description`/`justification`、
/// 丢掉 `file_path`）——逐字段比对抓不住，所以按**写入内容**判定：
/// 本回合已经写过这段内容，再写一次只会得到同样的结果。检测到就立即以既有
/// 证据收尾，省 3–4 轮延迟与工具预算。
fn repeated_write_call(messages: &[Value], name: &str, arguments: &str) -> bool {
    if name != "write" {
        return false;
    }
    let Ok(current) = serde_json::from_str::<Value>(arguments) else {
        return false;
    };
    let Some(Value::String(content)) = current.get("content") else {
        return false;
    };
    if content.trim().is_empty() {
        return false;
    }
    let current_path = current.get("file_path").and_then(|v| v.as_str());
    messages.iter().any(|msg| {
        if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            return false;
        }
        msg.get("tool_calls")
            .and_then(|c| c.as_array())
            .is_some_and(|calls| {
                calls.iter().any(|call| {
                    let function = call.get("function").unwrap_or(&Value::Null);
                    if function.get("name").and_then(|n| n.as_str()) != Some("write") {
                        return false;
                    }
                    let previous = match function.get("arguments") {
                        Some(Value::String(raw)) => serde_json::from_str::<Value>(raw).ok(),
                        Some(value) => Some(value.clone()),
                        None => None,
                    };
                    let Some(previous) = previous else {
                        return false;
                    };
                    if previous.get("content") != Some(&Value::String(content.clone())) {
                        return false;
                    }
                    match (
                        current_path,
                        previous.get("file_path").and_then(|v| v.as_str()),
                    ) {
                        (Some(a), Some(b)) => a == b,
                        // 任一侧路径缺失（复读时常见）→ 视为同一目标
                        _ => true,
                    }
                })
            })
    })
}

/// 熔断轮终答清洗：收敛成**一行** `BLOCKED: <原因>`。
///
/// 3B 本地模型在"不给工具"时会把注入的指令、甚至 system prompt 原样复读进正文
/// （实测以「工具轮数已用尽…」开头、尾部还挂着 `System: You are a …`）。编排者
/// 既读不出失败信号，又会把这坨文本当交付物。这里确定性收敛：命中 `BLOCKED:`
/// 就从那里截到行尾；完全没命中就补前缀（熔断本身就意味着未完成，必须显式失败）。
fn sanitize_blocked_text(text: &str) -> String {
    const MARKER: &str = "BLOCKED:";
    const MAX_CHARS: usize = 200;
    // 先按角色标记截断：3B 会在正文尾部续写 `System: You are …`（实测泄漏
    // 整段系统提示词），这段既污染证据也会误导编排者。
    let text = truncate_at_role_marker(text);
    let marker_at = text.char_indices().find_map(|(i, _)| {
        text[i..]
            .get(..MARKER.len())
            .filter(|s| s.eq_ignore_ascii_case(MARKER))
            .map(|_| i)
    });
    let body = match marker_at {
        Some(start) => text[start + MARKER.len()..]
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string(),
        None => text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("")
            .to_string(),
    };
    let body: String = body.chars().take(MAX_CHARS).collect();
    if body.is_empty() {
        "BLOCKED: tool rounds exhausted".to_string()
    } else {
        format!("BLOCKED: {body}")
    }
}

/// 截断 Instruction 格式响应中模型幻觉出的新角色块。
fn truncate_at_role_marker(text: &str) -> String {
    const MARKERS: [&str; 5] = ["System:", "User:", "Assistant:", "Instruction:", "Input:"];
    let mut cut = text.len();
    for marker in MARKERS {
        if let Some(idx) = text.find(marker) {
            cut = cut.min(idx);
        }
    }
    text[..cut].trim_end().to_string()
}

/// 从 RWKV 输出中提取 ```json 工具调用（返回 (name, arguments_json)）。
///
/// 三种形态（按优先级）：
/// 1. `​```json {...} ``` ` 完整围栏（历史回放格式）
/// 2. 裸 `{"name":...}` 前缀 + 尾部围栏/续写残余（续写起点给 ```json 时
///    模型输出 {"name":...} 后闭合围栏，stop 截断后尾部可能残留 ` 痕迹）
/// 3. 裸 JSON 前缀流式解析：serde 流式反序列化取第一个完整值，容忍尾部垃圾
fn try_extract_tool_call(text: &str) -> Option<(String, String)> {
    let text = text.trim();

    // 1) ```json 围栏（strip_prefix / 中部出现两种位置）
    if let Some(rest) = text.strip_prefix("```json") {
        let inner = rest.trim_end_matches('`').trim();
        if let Some(call) = parse_call_value(serde_json::from_str(inner).ok()?) {
            return Some(call);
        }
    }
    if let Some(start) = text.find("```json") {
        let rest = &text[start + 7..];
        let inner = rest.split("```").next().unwrap_or("").trim();
        if let Ok(v) = serde_json::from_str::<Value>(inner) {
            if let Some(call) = parse_call_value(v) {
                return Some(call);
            }
        }
    }

    // 2/3) 裸 JSON：剥围栏残余后整体解析；失败则流式取第一个完整值
    if text.starts_with('{') {
        let stripped = text.trim_end_matches('`').trim();
        if let Ok(v) = serde_json::from_str::<Value>(stripped) {
            if let Some(call) = parse_call_value(v) {
                return Some(call);
            }
        }
        let mut stream = serde_json::Deserializer::from_str(text).into_iter::<Value>();
        if let Some(Ok(v)) = stream.next() {
            return parse_call_value(v);
        }
    }
    None
}

/// 工具调用续写起点：prompt 末尾预填该前缀，模型只需续写工具名与参数。
/// 解析时把前缀补回生成文本（`tool_call_from_text`）。
///
/// 保持与 few-shot 示例一致**带空格**的形式（改成紧凑形式曾观察到参数嵌套，
/// 复测证明是长提示下的模型抖动、与格式无关，但格式统一没有坏处）。
/// 会话缓存的前缀对齐靠引擎在缓存末尾回退 8 个 token
/// （`SESSION_CACHE_BACKTRACK`），能吸收 `{"name": "` 与回放渲染
/// `{"name":"` 的 token 化差异，仍能命中。
const TOOL_CALL_PREFILL: &str = "{\"name\": \"";

/// 工具调用提取总入口：先严格解析生成文本，再尝试补回预填前缀，
/// 最后走带工具时的宽容修复（多行美化 / 截断的 JSON）。
fn tool_call_from_text(text: &str, has_tools: bool) -> Option<(String, String)> {
    if let Some(call) = try_extract_tool_call(text) {
        return Some(call);
    }
    if has_tools {
        let restored = format!("{TOOL_CALL_PREFILL}{text}");
        if let Some(call) = try_extract_tool_call(&restored) {
            return Some(call);
        }
        if looks_like_tool_call_text(text) {
            // 残缺形状（截断/多行/参数嵌套错位）在补回前缀后的文本上再修一次
            return repair_tool_call_text(&restored);
        }
    }
    None
}

/// 宽容修复：模型把调用写成**多行美化 JSON 或被 max_tokens 截断**时，
/// `serde` 解析必然失败（实测 2026-11-20：`{\n  "name": "ai00_todo_read",\n …`），
/// 但工具名和参数起手式都在。这里按文本定位 name / arguments，把残缺参数原样
/// 交给引擎——引擎校验参数会回一条普通工具错误，模型能据此改，比整轮判死好。
fn repair_tool_call_text(text: &str) -> Option<(String, String)> {
    let mut name = None;
    for (idx, _) in text.match_indices("\"name\"") {
        let rest = text[idx + 6..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('"') else {
            continue;
        };
        let candidate: String = rest
            .chars()
            .take_while(|c| {
                c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.' || *c == ':'
            })
            .collect();
        if !candidate.is_empty() && candidate.len() <= 96 {
            name = Some(candidate);
            break;
        }
    }
    let name = name?;

    let arguments = text
        .find("\"arguments\"")
        .map(|idx| {
            let rest = &text[idx + 11..];
            rest.trim_start()
                .strip_prefix(':')
                .map(|r| {
                    r.trim_start()
                        .trim_end_matches(['`', '\\', ' ', '\n', '\r', '\t'])
                        .to_string()
                })
                .unwrap_or_default()
        })
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| "{}".to_string());
    Some((name, arguments))
}

/// 本地模型单次 `write` 的字符上限（≈120 行中文）。超过这个量，3B 会先在正文里
/// 退化（`应应应应` 级复读），再交出畸形参数——不如直接让它分节写或升级云端。
const LOCAL_WRITE_MAX_CHARS: usize = 6000;

/// 拒绝本地 `write` 调用的原因（None = 允许执行）。
///
/// 两类都是**确定性破坏**，不是"写得不好"：
/// - 空内容：`write` 是整文件覆盖，空内容等于清空目标文件。实测 2026-11-21
///   两次（87c876ca / caeffa9d）把已完成的第 1–3 章清零。
/// - 超长内容：本地 3B 在长文上退化并交出畸形 tool_call（同一轮 4 次
///   malformed arguments），最终产出仍是垃圾文件。
///
/// `edit` 不在此列（`new_string` 为空 = 删除段落，是合法操作）。
fn write_rejection(name: &str, arguments: &str) -> Option<String> {
    if name != "write" {
        return None;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(arguments) else {
        return None; // 参数坏到解析不了时交给下游报错，别在这里静默吞掉
    };
    let content =
        match parsed.get("content") {
            Some(Value::String(content)) => content,
            _ => return Some(
                "write content is empty and would truncate the target file. Never send an empty \
                 write — read the target file and write real content (or use edit to append)."
                    .to_string(),
            ),
        };
    if content.trim().is_empty() {
        return Some(
            "write content is empty and would truncate the target file. Never send an empty write \
             — read the target file and write real content (or use edit to append)."
                .to_string(),
        );
    }
    let chars = content.chars().count();
    if chars > LOCAL_WRITE_MAX_CHARS {
        return Some(format!(
            "local write of {chars} chars exceeds the local-model budget ({LOCAL_WRITE_MAX_CHARS}). \
             Write a skeleton with write, then append section by section with edit — long documents \
             belong to the cloud code_worker."
        ));
    }
    None
}

/// 本地写手一步只写一个文件：模型把路径写坏时（`Users` / `section?2.md` /
/// 绝对路径被重排）用 brief 里点名的文件名确定性覆盖。只在 basename 不匹配
/// 时动手，避免误改模型给出的合法同名路径。
fn apply_path_hint(name: &str, arguments: String, hint: Option<&str>) -> String {
    if !matches!(name, "write" | "read" | "edit" | "read_image") {
        return arguments;
    }
    let Some(hint) = hint else {
        return arguments;
    };
    let Ok(mut value) = serde_json::from_str::<Value>(&arguments) else {
        return arguments;
    };
    let Some(obj) = value.as_object_mut() else {
        return arguments;
    };
    let current = obj
        .get("file_path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cur_base = std::path::Path::new(&current)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let same = cur_base == hint;
    // write 的输出文件就是 hint（权威值）；read/edit/read_image 只在模型把
    // hint 写**截断**（`section-2-` 之于 `section-2.md`）时补全，不覆盖
    // 模型明确写出的别的文件（可能是有意读源文件）。
    let truncated = !cur_base.is_empty() && cur_base.len() >= 3 && hint.starts_with(cur_base);
    let replace = if name == "write" { !same } else { truncated };
    if !replace {
        return arguments;
    }
    obj.insert("file_path".to_string(), Value::String(hint.to_string()));
    serde_json::to_string(&value).unwrap_or(arguments)
}

/// 工具轮失败一次的透明自愈重试（`AI00X_TOOL_RETRY=0` 关闭，供 A/B 与排障；
/// 读一次即缓存，换档须重启进程）。
fn tool_retry_enabled() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        std::env::var("AI00X_TOOL_RETRY")
            .map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
            .unwrap_or(true)
    })
}

/// 从模型文本提取并修复工具调用（名称归一 → 参数归一 → 破损抢救 → 路径纠偏）。
///
/// 首轮与自愈重试共用同一套修复，避免两条路径口径漂移。
fn extract_repaired_call(
    text: &str,
    has_tools: bool,
    tool_names: &[String],
    tools: Option<&[Value]>,
    path_hint: Option<&str>,
) -> Option<(String, String)> {
    let (name, arguments) = tool_call_from_text(text, has_tools)?;
    let name = normalize_tool_name(&name, tool_names);
    let arguments = normalize_tool_arguments(&name, &arguments);
    let arguments = salvage_if_invalid(&name, arguments, tools, path_hint);
    let arguments = apply_path_hint(&name, arguments, path_hint);
    Some((name, arguments))
}

/// 工具轮失败后的「一次性自愈」计划：严格系统指令 + 收窄到意图工具。
///
/// 实测（2026-11-25，24 次 / read·glob·grep 三案）：常规提示首轮 10/24 合法，
/// 失败后用「单工具 + 明确示例」重问，14 次失败救回 5 次（36%）——放在网关内
/// 透明重试，省掉编排层一整轮工具往返（~1-2s/次）。
fn tool_retry_plan(
    messages: &[Value],
    tools: &[Value],
    path_hint: Option<&str>,
) -> (Vec<Value>, Vec<Value>) {
    let focus = hinted_tool(tools, messages).or_else(|| focus_tool(tools, messages));
    let narrowed: Vec<Value> = match focus {
        Some(name) => tools
            .iter()
            .filter(|t| {
                t.get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
                    == Some(name)
            })
            .cloned()
            .collect(),
        None => Vec::new(),
    };
    let narrowed = if narrowed.is_empty() {
        tools.to_vec()
    } else {
        narrowed
    };
    let example = focus.and_then(|name| {
        let required = required_params(Some(&narrowed), name);
        if required.is_empty() {
            return None;
        }
        let args = required
            .iter()
            .map(|(key, is_array)| {
                let value = sample_string_arg(name, key, path_hint, None);
                if *is_array {
                    format!("\"{key}\": [\"{value}\"]")
                } else {
                    format!("\"{key}\": \"{value}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        Some(format!(
            "{{\"name\": \"{name}\", \"arguments\": {{{args}}}}}"
        ))
    });
    let strict = match example {
        Some(ex) => format!(
            "上一次工具调用格式无效。本次只输出一行 JSON 工具调用，形如 {ex} 。\
             不要解释、不要代码围栏、不要多余字段。"
        ),
        None => "上一次工具调用格式无效。本次只输出一行 JSON 工具调用 \
                 {\"name\": …, \"arguments\": {…}}，不要解释。"
            .to_string(),
    };
    let mut messages_retry = messages.to_vec();
    messages_retry.push(json!({"role": "system", "content": strict}));
    (messages_retry, narrowed)
}

/// 工具参数归一：3B 本地模型常见两类"参数漂移"，这里确定性修掉，
/// 免得每一轮都因参数名不对被判失败（实测：`path`/`file_path` 混用、
/// `content` 里又嵌了一层 `{"content":…,"file_path":…}`）。
fn normalize_tool_arguments(name: &str, arguments: &str) -> String {
    // 0) 双编码参数：3B 偶发把 arguments 再序列化一层
    //    （`"{\"file_path\":\"a.md\"}"`，实测 2026-11-25 工具轮 1/8）→ 解开。
    let mut owned = arguments.to_string();
    for _ in 0..2 {
        let Ok(Value::String(inner)) = serde_json::from_str::<Value>(&owned) else {
            break;
        };
        if !inner.trim_start().starts_with('{') {
            break;
        }
        owned = inner;
    }
    let Ok(mut value) = serde_json::from_str::<Value>(&owned) else {
        return owned;
    };
    let Some(obj) = value.as_object_mut() else {
        return owned;
    };
    // 1) 文件类工具：`path` → `file_path`（dsh-tool-fs 的正式参数名）
    if matches!(name, "read" | "write" | "edit" | "read_image") && !obj.contains_key("file_path") {
        if let Some(path) = obj.remove("path") {
            obj.insert("file_path".to_string(), path);
        }
    }
    // 1a) glob：引擎参数是 `pattern`，模型常写 `path`/`query`
    if name == "glob" && !obj.contains_key("pattern") {
        if let Some(pattern) = obj.remove("path").or_else(|| obj.remove("query")) {
            obj.insert("pattern".to_string(), pattern);
        }
    }
    // 1b) file_path 去噪：3B 会把提示前缀/引号一起写进值里（实测
    // `": \"C:\\…\\hello.txt"`），直接落盘会失败，剥掉再交给引擎。
    if matches!(name, "read" | "write" | "edit" | "read_image") {
        if let Some(Value::String(path)) = obj.get("file_path").cloned() {
            let cleaned = clean_path_value(&path);
            let cleaned = rebase_absolute_path(&cleaned);
            let cleaned = collapse_doubled_extension(&cleaned);
            if cleaned != path {
                obj.insert("file_path".to_string(), Value::String(cleaned));
            }
        }
    }
    // 2) 命令类工具：引擎要求 `description` 必填（仅元信息），模型经常漏给
    if matches!(name, "pwsh" | "bash") && !obj.contains_key("description") {
        obj.insert(
            "description".to_string(),
            Value::String("run shell command".to_string()),
        );
    }
    // 3) 嵌套参数：content 的值是对象且自带 content/file_path → 上提
    for _ in 0..3 {
        let Some(Value::Object(inner)) = obj.get("content").cloned() else {
            break;
        };
        let nested_content = inner.get("content").cloned();
        let nested_path = inner.get("file_path").cloned();
        if nested_content.is_none() && nested_path.is_none() {
            break;
        }
        if let Some(content) = nested_content {
            obj.insert("content".to_string(), content);
        }
        if !obj.contains_key("file_path") {
            if let Some(path) = nested_path {
                obj.insert("file_path".to_string(), path);
            }
        }
    }
    // 4) 单参数自嵌套：3B 偶发写成 `{"query":{"query":"x"}}`（长提示/填充文本下
    //    更常见，实测 2026-11-23）→ 解开一层。只在「对象恰好一个键、且内层同名」
    //    时动手，避免误伤合法的嵌套参数。
    let keys: Vec<String> = obj.keys().cloned().collect();
    for key in keys {
        let inner_value = match obj.get(&key) {
            Some(Value::Object(inner)) if inner.len() == 1 => inner.get(&key).cloned(),
            _ => None,
        };
        if let Some(value) = inner_value {
            obj.insert(key, value);
        }
    }
    value.to_string()
}

/// 参数 JSON 破损时按必填键抢救（3B 常见：必填值写对，但多塞编造键、引号
/// 错位——实测 `{"file_path": "README.md", "limit": 1, "offset""":0"""}}`）。
/// 严格解析通过 / 工具无必填参数 / 任一必填键缺失 → 原样返回（不猜）。
fn salvage_if_invalid(
    name: &str,
    arguments: String,
    tools: Option<&[Value]>,
    path_hint: Option<&str>,
) -> String {
    if serde_json::from_str::<Value>(&arguments).is_ok() {
        return arguments;
    }
    let required = required_params(tools, name);
    match salvage_tool_arguments(&arguments, name, &required, path_hint) {
        Some(fixed) => {
            log::warn!(
                "[ai-gateway] salvaged broken arguments for {name}: {}",
                fixed.chars().take(120).collect::<String>()
            );
            fixed
        }
        None => arguments,
    }
}

/// 工具 schema 的必填参数（key, 是否数组）。
fn required_params(tools: Option<&[Value]>, name: &str) -> Vec<(String, bool)> {
    let Some(function) = tools.and_then(|tools| {
        tools.iter().find_map(|tool| {
            let f = tool.get("function")?;
            (f.get("name").and_then(|n| n.as_str()) == Some(name)).then_some(f)
        })
    }) else {
        return Vec::new();
    };
    let params = function.get("parameters");
    let Some(required) = params
        .and_then(|p| p.get("required"))
        .and_then(|r| r.as_array())
    else {
        return Vec::new();
    };
    let props = params.and_then(|p| p.get("properties"));
    required
        .iter()
        .filter_map(|key| {
            let key = key.as_str()?;
            let ty = props
                .and_then(|p| p.get(key))
                .and_then(|s| s.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("string");
            Some((key.to_string(), ty == "array"))
        })
        .collect()
}

/// 从破损参数文本里逐个提取必填键的值，重建最小合法对象。
///
/// 注意：`content` 等正文字段必须保留精确字节。真实事故（2026-11-24 实机）：
/// 抢救时对值做了 trim，`write` 的 content 丢了尾随换行 → 计划要求以 LF 结尾
/// 的验收命令失败 → 按「本地一次不过即升级云端」返工，白烧一轮远端。
fn salvage_tool_arguments(
    raw: &str,
    name: &str,
    required: &[(String, bool)],
    path_hint: Option<&str>,
) -> Option<String> {
    if required.is_empty() {
        return None;
    }
    let mut out = serde_json::Map::new();
    for (key, is_array) in required {
        let value = if *is_array {
            extract_json_array(raw, key)?
        } else {
            // write 的 file_path 有 brief 点名的权威值（`apply_path_hint`
            // 在合法 JSON 上也会覆盖），提取失败时直接用它，别让整轮报废。
            let text = match extract_json_string(raw, key) {
                Some(t) => t,
                None if key == "file_path" && name == "write" => path_hint?.to_string(),
                None => return None,
            };
            // 只有路径/模式类键去首尾空白；content 等正文保持原样。
            let text = if key.contains("path") || key == "pattern" || key == "include" {
                text.trim().to_string()
            } else {
                text
            };
            Value::String(text)
        };
        out.insert(key.clone(), value);
    }
    Some(Value::Object(out).to_string())
}

/// 在破损文本里找 `"key": "…"` 并还原 JSON 字符串转义。
fn extract_json_string(raw: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    for (idx, _) in raw.match_indices(&needle) {
        let rest = &raw[idx + needle.len()..];
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        // 3B 偶发用全角引号包值（`"file_path": “section-2.md”`，2026-11-25
        // 工具轮实测）：接受全角开引号，闭合按对应引号判定。
        let (rest, closer) = if let Some(r) = rest.strip_prefix('"') {
            (r, '"')
        } else if let Some(r) = rest.strip_prefix('“') {
            (r, '”')
        } else {
            continue;
        };
        let mut out = String::new();
        let mut chars = rest.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => {
                    // 只保留合法 JSON 转义；3B 会把 glob 写成 `**/\*.md` 这类
                    // 正则式转义（`\*` 非法），原样包回 `"…"` 会解析失败。
                    if let Some(next) = chars.next() {
                        if matches!(next, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u') {
                            out.push('\\');
                        }
                        out.push(next);
                    }
                }
                c if c == closer => break,
                _ => out.push(c),
            }
        }
        if let Ok(Value::String(s)) = serde_json::from_str::<Value>(&format!("\"{out}\"")) {
            // 不在这里 trim：正文（write content）依赖精确字节；路径类键的
            // 去空白由 salvage_tool_arguments 按 key 处理。
            if !s.trim().is_empty() {
                return Some(s);
            }
        }
    }
    None
}

/// 在破损文本里找 `"key": [ … ]`（括号配平、跳过字符串内的括号）。
fn extract_json_array(raw: &str, key: &str) -> Option<Value> {
    let needle = format!("\"{key}\"");
    for (idx, _) in raw.match_indices(&needle) {
        let rest = &raw[idx + needle.len()..];
        let Some(rest) = rest.trim_start().strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(start) = rest.find('[') else {
            continue;
        };
        let mut depth = 0usize;
        let mut in_str = false;
        let mut esc = false;
        for (i, c) in rest[start..].char_indices() {
            match c {
                '"' if !esc => in_str = !in_str,
                '[' if !in_str => depth += 1,
                ']' if !in_str => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        if let Ok(v) = serde_json::from_str::<Value>(&rest[start..start + i + 1]) {
                            if v.is_array() {
                                return Some(v);
                            }
                        }
                        break;
                    }
                }
                _ => {}
            }
            esc = c == '\\' && !esc;
        }
    }
    None
}

/// 绝对路径降级：3B 会把 system prompt 里的包路径拼进工作路径，产出一个
/// 工作目录之外的绝对路径（实测 `…\node_modules\@deepseek-ai\dsh\ws\hello.txt`）。
/// 引擎已把工具 cwd 钉成工作目录、规则也要求相对路径，所以本地模型给出的绝对
/// 路径只会是这种污染——**无条件**只留文件名（曾经只处理"不存在的绝对路径"，
/// 结果写进 node_modules 里"成功"了，工作目录里什么都没有，白烧 6 轮）。
fn rebase_absolute_path(path: &str) -> String {
    let candidate = std::path::Path::new(path);
    if !candidate.is_absolute() {
        return path.to_string();
    }
    match candidate.file_name().and_then(|n| n.to_str()) {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => path.to_string(),
    }
}

/// 重复扩展名折叠：3B 会把 brief 里的 `probe.js` 再补一个 `.js` 写成
/// `probe.js.js`（实测 2026-11-24，档位拆分后第一个真实写步骤）。验收按
/// brief 的路径找文件 → ENOENT → 白升级云端；这里确定性折掉重复的那一段。
fn collapse_doubled_extension(path: &str) -> String {
    const EXTS: [&str; 10] = [
        ".js", ".ts", ".md", ".txt", ".json", ".py", ".html", ".css", ".yaml", ".yml",
    ];
    let lower = path.to_ascii_lowercase();
    for ext in EXTS {
        if lower.ends_with(&format!("{ext}{ext}")) {
            return path[..path.len() - ext.len()].to_string();
        }
    }
    path.to_string()
}

/// 路径值去噪：取最后一个引号片段（模型常把提示前缀 `": "` 或多余引号抄进值里），
/// 再剥掉包裹的引号/冒号/等号/空白。干净的路径原样返回。
fn clean_path_value(raw: &str) -> String {
    let trimmed = raw.trim();
    let candidate = if trimmed.contains('"') {
        trimmed
            .split('"')
            .rfind(|part| !part.trim().is_empty())
            .map_or(trimmed, str::trim)
    } else {
        trimmed
    };
    candidate
        .trim_matches(|c: char| c == ':' || c == '=' || c == '\'' || c == '"' || c.is_whitespace())
        .to_string()
}

/// 文本是否"看起来像在调工具"：用于把**残缺到认不出工具名**的 JSON 判成
/// 失败，而不是当成最终回答。只在带 tools 的请求里使用，避免误伤普通 JSON 作答。
fn looks_like_tool_call_text(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    // 预填续写的残片形如 `pwsh", "arguments": {...`——不以 `{` 开头但明显是工具调用
    if t.contains("\"arguments\"") {
        return true;
    }
    if t.contains("```json") {
        return true;
    }
    if !t.starts_with('{') {
        return false;
    }
    [
        "\"arguments\"",
        "\"args\"",
        "\"name\"",
        "\"tool\"",
        "\"tool_name\"",
    ]
    .iter()
    .any(|key| t.contains(key))
}

/// 解析后的 JSON 值 → (name, arguments_json)。
///
/// RWKV 的"工具调用"是普通文本里的 JSON，形状并不统一（实测 2026-11-20）：
/// 标准形状 `{"name":"x","arguments":{...}}`；省略包装
/// `{"arguments":{"name":"x","query":"…"}}`（名字埋在参数里）；以及别名
/// `tool` / `tool_name` / `function.name`。
/// 只要能从任意位置认出名字就还原成工具调用——否则这段 JSON 会被当成
/// 最终回答交给引擎，编排者看到的就是"工人返回空壳"。
fn parse_call_value(v: Value) -> Option<(String, String)> {
    let mut arguments = v
        .get("arguments")
        .or_else(|| v.get("args"))
        .or_else(|| v.get("parameters"))
        .cloned();

    // 名字优先取顶层；缺失时从 arguments 内部取（并把该键从参数里摘掉）。
    let mut name = ["name", "tool", "tool_name"]
        .iter()
        .find_map(|key| v.get(*key).and_then(|n| n.as_str()).map(str::to_string))
        .or_else(|| {
            v.get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .map(str::to_string)
        });

    if name.is_none() {
        if let Some(Value::Object(map)) = arguments.as_mut() {
            let inner = ["name", "tool", "tool_name"]
                .iter()
                .find_map(|key| map.get(*key).and_then(|n| n.as_str()).map(str::to_string));
            if let Some(inner_name) = inner {
                for key in ["name", "tool", "tool_name"] {
                    map.remove(key);
                }
                name = Some(inner_name);
            }
        }
    }

    let name = name?;
    // arguments 是字符串时原样透传（模型已自行序列化），对象则序列化。
    let arguments = match arguments {
        Some(Value::String(raw)) => raw,
        Some(other) => other.to_string(),
        None => "{}".to_string(),
    };
    Some((name, arguments))
}

// ---------------------------------------------------------------------------
// OpenAI SSE chunk 构造
// ---------------------------------------------------------------------------

fn sse_text_delta(model: &str, text: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl-ai00x",
            "object": "chat.completion.chunk",
            "model": model,
            "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": null}],
        })
    )
}

fn sse_tool_call_delta(model: &str, name: &str, arguments: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl-ai00x",
            "object": "chat.completion.chunk",
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": format!("call_{name}"),
                        "type": "function",
                        "function": {"name": name, "arguments": arguments},
                    }]
                },
                "finish_reason": null,
            }],
        })
    )
}

fn sse_finish(model: &str, reason: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl-ai00x",
            "object": "chat.completion.chunk",
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": reason}],
        })
    )
}

fn sse_usage(model: &str, input_tokens: usize, output_tokens: usize) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl-ai00x",
            "object": "chat.completion.chunk",
            "model": model,
            "usage": {
                "prompt_tokens": input_tokens,
                "completion_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens,
            },
        })
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 工具参数两类确定性修复：arguments 被再序列化一层、值用全角引号。
    #[test]
    fn tool_arguments_repairs_double_encoding_and_fullwidth_quotes() {
        let raw = "\"{\\\"file_path\\\": \\\"a.md\\\"}\"";
        assert_eq!(
            normalize_tool_arguments("read", raw),
            "{\"file_path\":\"a.md\"}"
        );
        let tools = vec![json!({
            "type": "function",
            "function": {
                "name": "read",
                "parameters": {
                    "type": "object",
                    "properties": {"file_path": {"type": "string"}},
                    "required": ["file_path"]
                }
            }
        })];
        let broken = "{\"file_path\": “section-2.md”}";
        assert_eq!(
            salvage_if_invalid("read", broken.to_string(), Some(&tools), None),
            "{\"file_path\":\"section-2.md\"}"
        );
    }

    /// stop 安全回看：只扣「可能正在拼成 stop 的尾部」，普通正文立即发出。
    #[test]
    fn safe_emit_len_holds_only_stop_prefix_tail() {
        let stops = vec![
            "\n\nInstruction:".to_string(),
            "User:".to_string(),
            "Assistant:".to_string(),
            "```".to_string(),
        ];
        // 普通正文：全部可发
        assert_eq!(safe_emit_len("你好，世界", &stops), 5);
        // 结尾正好是 stop 前缀 → 扣住该前缀（7 字符里扣 4）
        assert_eq!(safe_emit_len("你好 User", &stops), 3);
        // 前缀被下一个字符打断，但顺带命中了 ``` 的前缀（8 字符里扣 3）
        assert_eq!(safe_emit_len("Users```", &stops), 5);
        // 多行前缀（最长匹配优先，9 字符里扣 7）
        assert_eq!(safe_emit_len("正文\n\nInstr", &stops), 2);
        assert_eq!(safe_emit_len("", &stops), 0);
    }

    /// 引擎的 system-reminder / 目录变更也是 user 角色，排在 brief 之后；
    /// 取最后一个文件名时必须跳过它们，并在骨架名与输出名之间选输出名。
    #[test]
    fn hinted_path_ignores_engine_noise_and_prefers_output_file() {
        let brief = "The skeleton file `guide.skeleton.md` holds the outline. \
                     请用 write 创建文件 section-2.md。示例：\
                     write({\"file_path\":\"section-2.md\",\"content\":\"## 骨架……\"})";
        let messages = vec![
            json!({"role": "user", "content": brief}),
            json!({"role": "user", "content": "<system-reminder>cwd</system-reminder>"}),
        ];
        assert_eq!(hinted_path(&messages).as_deref(), Some("section-2.md"));
    }

    /// 3B 把路径写成 `Users` / `section?2.md` 时，按 brief 点名文件覆盖；
    /// 已正确或非 write 的调用不动。
    #[test]
    fn write_path_hint_overrides_mangled_paths() {
        let mangled = r#"{"file_path":"Users","content":"body"}"#;
        let fixed = apply_path_hint("write", mangled.to_string(), Some("section-2.md"));
        assert!(fixed.contains("\"file_path\":\"section-2.md\""), "{fixed}");

        let good = r#"{"file_path":"section-2.md","content":"body"}"#;
        assert_eq!(
            apply_path_hint("write", good.to_string(), Some("section-2.md")),
            good
        );

        let read = r#"{"file_path":"Users"}"#;
        assert_eq!(
            apply_path_hint("read", read.to_string(), Some("section-2.md")),
            read
        );
        // read 只补全截断的 hint，不改写模型明确写出的别的文件
        let truncated = r#"{"file_path":"section-2-"}"#;
        assert_eq!(
            apply_path_hint("read", truncated.to_string(), Some("section-2.md")),
            r#"{"file_path":"section-2.md"}"#
        );
    }

    #[test]
    fn parses_real_usage_from_sse() {
        let line = format!(
            "data: {}",
            json!({
                "usage": {
                    "prompt_tokens": 123,
                    "completion_tokens": 45,
                    "prompt_tokens_details": {"cached_tokens": 100}
                }
            })
        );
        let usage = gateway_usage_from_sse_line(&line);
        assert!(usage.is_some());
        let usage = usage.unwrap_or_default();
        assert_eq!(usage.prompt, 123);
        assert_eq!(usage.completion, 45);
        assert_eq!(usage.cached_prompt, Some(100));
        assert!(gateway_usage_from_sse_line("data: [DONE]").is_none());
    }

    /// 官方 G1 模板只允许一个 System 块（rwkv-pf: MULTIPLE_SYSTEM / SYSTEM_THEN_ROLE）。
    /// 工具清单必须并进同一个 System 块，否则 RWKV 会把工具调用当纯文本续写。
    #[test]
    fn single_system_block_with_tools() {
        let messages = vec![
            json!({"role": "system", "content": "You are a local code worker.\n\nBe brief."}),
            json!({"role": "system", "content": "Workspace: C:/tmp/task"}),
            json!({"role": "user", "content": "Create notes.md"}),
        ];
        let tools = vec![json!({
            "type": "function",
            "function": {"name": "write", "description": "Write a file", "parameters": {"properties": {"path": {"type": "string"}}}}
        })];
        let prompt = openai_messages_to_rwkv_prompt(&messages, Some(&tools));

        assert_eq!(
            prompt.matches("System:").count(),
            1,
            "must have exactly one System block: {prompt}"
        );
        // System 之后必须直接是 User
        let after_system = prompt.split("System: ").nth(1).unwrap_or_default();
        assert!(
            after_system.contains("\n\nUser: Create notes.md"),
            "System block must be followed by User: {prompt}"
        );
        // 工具说明合并在同一个块内，且 System 块内没有空行
        let system_block = after_system.split("\n\nUser: ").next().unwrap_or_default();
        assert!(system_block.contains("Tools:"));
        assert!(system_block.contains("Return only a JSON function call."));
        assert!(
            !system_block.contains("\n\n"),
            "System block must not contain blank lines"
        );
        assert!(prompt.ends_with("Assistant: ```json\n{\"name\": \""));
    }

    #[test]
    fn instruction_format_for_single_turn() {
        let messages = vec![
            json!({"role": "system", "content": "Extract the name"}),
            json!({"role": "user", "content": "My name is Alice"}),
        ];
        let prompt = openai_messages_to_rwkv_prompt(&messages, None);
        assert!(prompt
            .starts_with("Instruction: Extract the name\n\nInput: My name is Alice\n\nResponse: "));
    }

    #[test]
    fn hybrid_gate_respects_explicit_model() {
        let body = json!({
            "tools": [{"type":"function","function":{"name":"ai00_todo_read","parameters":{}}}]
        });
        // 智能路由语义（空 / ai00-auto）+ 全白名单工具 → 进混合循环
        assert!(hybrid_eligible("", &body, true));
        assert!(hybrid_eligible(MODEL_AUTO, &body, true));
        // 显式选型一律不进：rwkv-local 保持纯本地，ai00-salvo/具体引用纯远端
        assert!(!hybrid_eligible(MODEL_RWKV, &body, true));
        assert!(!hybrid_eligible(MODEL_REMOTE, &body, true));
        assert!(!hybrid_eligible("ai00s:GLM-4.7-Flash", &body, true));
        // 无工具不进
        assert!(!hybrid_eligible(MODEL_AUTO, &body, false));
    }

    #[test]
    fn salvage_skips_invalid_template_echo() {
        // 模型先复述非法模板（"true或false" 不是合法 JSON），随后输出真 JSON：
        // 旧实现首候选 parse 失败即放弃，新实现须跳到后续候选。
        let raw = r#"{"relevant":true或false,"summary":"要点"} 然后是 {"relevant":true,"summary":"RWKV7 是新一代 RNN 架构"}"#;
        let v = salvage_balanced_json(raw).expect("should salvage second candidate");
        assert_eq!(v.get("relevant").and_then(|b| b.as_bool()), Some(true));
        // 全无可抢救候选 → None
        assert!(salvage_balanced_json("没有任何 JSON").is_none());
        // 首候选即合法 → 直接命中
        let v = salvage_balanced_json(r#"前缀 {"a":1}"#).expect("first candidate");
        assert_eq!(v.get("a").and_then(|n| n.as_i64()), Some(1));
    }

    #[test]
    fn world_format_for_multi_turn_with_tools() {
        let messages = vec![
            json!({"role": "system", "content": "You are helpful"}),
            json!({"role": "user", "content": "Read the file"}),
        ];
        let tools = vec![json!({
            "type": "function",
            "function": {
                "name": "Read",
                "description": "Read a UTF-8 text file",
                "parameters": {"properties": {"file_path": {"type": "string"}}}
            }
        })];
        let prompt = openai_messages_to_rwkv_prompt(&messages, Some(&tools));
        // 官方 G1x 模板：JSON 数组工具定义（含 description）+ ```json 续写起点。
        // 工具清单拼在同一个 System 块内（G1 只允许一个 System 块），
        // 因此是 `System: <persona>\nTools:`，不是独立的 `System: Tools:`。
        assert!(prompt.contains("System: You are helpful\nTools:"));
        assert!(prompt.contains("\"name\": \"Read\""));
        assert!(prompt.contains("\"description\": \"Read a UTF-8 text file\""));
        assert!(prompt.contains("Return only a JSON function call."));
        assert!(prompt.ends_with("Assistant: ```json\n{\"name\": \""));
        // 对话式 few-shot：System 之后、真实 User 之前，示例工具来自工具表
        assert!(prompt.contains(
            "User: Use the Read tool.\n\nAssistant: ```json\n{\"name\": \"Read\", \"arguments\": {\"file_path\": \"note.txt\"}}\n```\n\n"
        ));
        // few-shot 必须先于真实用户轮出现
        let fs = prompt.find("Use the Read tool.").unwrap();
        let real = prompt.find("User: Read the file").unwrap();
        assert!(fs < real);
        // 无工具不注入
        let plain = openai_messages_to_rwkv_prompt(&messages, None);
        assert!(!plain.contains("Use the Read tool."));
        // 工具轮停止序列带围栏收尾；纯文本不带
        assert!(rwkv_stop_sequences(false, true)
            .iter()
            .any(|s| s == "\n```"));
        assert!(!rwkv_stop_sequences(false, false)
            .iter()
            .any(|s| s == "\n```"));
        assert!(rwkv_stop_sequences(true, false).iter().any(|s| s == "\n\n"));
    }

    #[test]
    fn fewshot_prefers_tool_with_args() {
        // 空参数工具排前时，示例必须跳过它选首个能合成出参数的工具——
        // 空 {} 示例会教模型把 schema 当参数值复读（p2 实测）。
        let messages = vec![json!({"role": "user", "content": "hi"})];
        let tools = vec![
            json!({"type":"function","function":{"name":"ai00_todo_read","parameters":{}}}),
            json!({"type":"function","function":{"name":"ai00_notify","parameters":{"properties":{"title":{"type":"string"}}}}}),
        ];
        let prompt = openai_messages_to_rwkv_prompt(&messages, Some(&tools));
        assert!(prompt.contains("User: Use the ai00_notify tool."));
        assert!(prompt
            .contains("{\"name\": \"ai00_notify\", \"arguments\": {\"title\": \"Reminder\"}}"));
    }

    #[test]
    fn fewshot_covers_write_even_when_not_first() {
        // write 排在后面时也必须出示例：3B 缺 write 示例会抄 Claude Write 的
        // description/justification、漏掉 file_path（实测白烧 6 轮）。
        let messages = vec![json!({"role": "user", "content": "hi"})];
        let tools = vec![
            json!({"type":"function","function":{"name":"pwsh","parameters":{"properties":{
                "description":{"type":"string"},"command":{"type":"string"}}}}}),
            json!({"type":"function","function":{"name":"write","parameters":{"properties":{
                "file_path":{"type":"string"},"content":{"type":"string"}}}}}),
        ];
        let prompt = openai_messages_to_rwkv_prompt(&messages, Some(&tools));
        assert!(prompt.contains("User: Use the write tool."), "{prompt}");
        // 参数键必须与引擎 schema 同名（排序由 serde_json map 决定，不约束顺序）
        assert!(prompt.contains("\"name\": \"write\""), "{prompt}");
        assert!(prompt.contains("\"file_path\": \"note.txt\""), "{prompt}");
        assert!(prompt.contains("\"content\": \"hello\""), "{prompt}");
        assert!(!prompt.contains("justification"), "{prompt}");
        // 第二个示例仍要有（覆盖两个工具）
        assert!(prompt.contains("User: Use the pwsh tool."), "{prompt}");
    }

    #[test]
    fn cleans_garbled_path_values() {
        assert_eq!(clean_path_value("hello.txt"), "hello.txt");
        assert_eq!(clean_path_value(" \"C:\\a\\b.txt\" "), "C:\\a\\b.txt");
        // 实测形态：`: "C:\…\hello.txt`
        assert_eq!(
            clean_path_value(": \"C:\\Users\\x\\hello.txt"),
            "C:\\Users\\x\\hello.txt"
        );
        assert_eq!(
            clean_path_value("file_path: hello.txt"),
            "file_path: hello.txt"
        );
    }

    #[test]
    fn normalizes_garbled_file_path_argument() {
        let args = normalize_tool_arguments(
            "write",
            r#"{"content":"hello","file_path":": \"C:\\Users\\x\\hello.txt"}"#,
        );
        let parsed: Value = serde_json::from_str(&args).unwrap();
        // 去噪去掉 `": "` 前缀；该绝对路径不存在 → 降级为文件名
        assert_eq!(parsed["file_path"], json!("hello.txt"));
        assert_eq!(parsed["content"], json!("hello"));
    }

    #[test]
    fn normalizes_glob_path_to_pattern() {
        let args = normalize_tool_arguments("glob", r#"{"path":"**/*.txt"}"#);
        let parsed: Value = serde_json::from_str(&args).unwrap();
        assert_eq!(parsed["pattern"], json!("**/*.txt"));
        assert!(parsed.get("path").is_none());
    }

    #[test]
    fn rebases_absolute_path_to_basename() {
        // 绝对路径（含 system prompt 污染的包路径）→ 只留文件名
        let polluted = if cfg!(windows) {
            r"C:\nope\ai00x\node_modules\@deepseek-ai\dsh\ws\hello.txt"
        } else {
            "/nope/ai00x/node_modules/@deepseek-ai/dsh/ws/hello.txt"
        };
        assert_eq!(rebase_absolute_path(polluted), "hello.txt");
        // 相对路径原样保留
        assert_eq!(rebase_absolute_path("hello.txt"), "hello.txt");
        assert_eq!(rebase_absolute_path("src/main.rs"), "src/main.rs");
    }

    #[test]
    fn extracts_tool_call_from_json_block() {
        let text = "让我先读文件。\n```json\n{\"name\":\"Read\",\"arguments\":{\"file_path\":\"src/main.rs\"}}\n```";
        let (name, args) = try_extract_tool_call(text).unwrap();
        assert_eq!(name, "Read");
        assert!(args.contains("src/main.rs"));
    }

    #[test]
    fn extracts_bare_json_with_fence_remnant() {
        // 续写起点 ```json 模式：模型输出 {"name":...} + 闭合围栏残余
        let text = "{\"name\":\"ai00_notify\",\"arguments\":{\"title\":\"hi\"}}\n```";
        let (name, args) = try_extract_tool_call(text).unwrap();
        assert_eq!(name, "ai00_notify");
        assert!(args.contains("hi"));
    }

    #[test]
    fn extracts_bare_json_with_trailing_garbage() {
        // 模型闭合围栏后继续续写：流式解析取第一个完整 JSON 值
        let text = "{\"name\":\"Read\",\"arguments\":{}}\n```\n\nUser: 下一轮";
        let (name, _) = try_extract_tool_call(text).unwrap();
        assert_eq!(name, "Read");
    }

    #[test]
    fn extracts_tool_call_with_nested_name() {
        // 实测形状（2026-11-20）：名字埋在 arguments 里，没有顶层 name。
        // 以前整段被当成最终回答 → 编排者看到"工人返回空壳"。
        let text = r#"{"arguments":{"name":"web_search","query":"agent memory"}}"#;
        let (name, args) = try_extract_tool_call(text).unwrap();
        assert_eq!(name, "web_search");
        assert!(args.contains("agent memory"));
        assert!(!args.contains("\"name\""), "name must be stripped: {args}");
    }

    #[test]
    fn extracts_tool_call_alias_keys() {
        let text = r#"{"tool":"ai00_web_extract","args":{"query":"x"}}"#;
        let (name, args) = try_extract_tool_call(text).unwrap();
        assert_eq!(name, "ai00_web_extract");
        assert!(args.contains("\"x\""));
    }

    #[test]
    fn repairs_pretty_printed_truncated_call() {
        // 实测形状：多行美化 + 被 max_tokens 截断，serde 无法解析
        let text = "{\n  \"name\": \"ai00_todo_read\",\n  \"arguments\": {\n    \"taskId\": \"t-1\",\n    \"goal";
        assert!(try_extract_tool_call(text).is_none());
        let (name, args) = tool_call_from_text(text, true).expect("must repair");
        assert_eq!(name, "ai00_todo_read");
        assert!(args.starts_with('{'));
        // 不带 tools 的请求不做修复（避免把普通 JSON 作答当工具调用）
        assert!(tool_call_from_text(text, false).is_none());
    }

    #[test]
    fn restores_prefilled_tool_call() {
        // prompt 已预填 `{"name": "`，模型只续写 name 与 arguments
        let fragment = "write\", \"arguments\": {\"path\": \"hi.txt\", \"content\": \"hi\"}}\n```";
        let (name, args) = tool_call_from_text(fragment, true).expect("must restore");
        assert_eq!(name, "write");
        assert!(args.contains("hi.txt"));
        // 不带 tools 的请求不做前缀补回
        assert!(tool_call_from_text(fragment, false).is_none());
    }

    #[test]
    fn repairs_prefilled_fragment_text() {
        // 预填续写的残片：不含开头 `{"name": "`，直接是 `pwsh", "arguments": …`
        let fragment =
            "pwsh\", \"arguments\": {\"command\": {\"description\": \"x\", \"command\": \"Get-Content notes.txt\"}}";
        let (name, _args) = tool_call_from_text(fragment, true).expect("must repair");
        assert_eq!(name, "pwsh");
    }

    #[test]
    fn normalizes_local_tool_argument_drift() {
        // path → file_path
        let out = normalize_tool_arguments("write", r#"{"content":"hi","path":"hello.txt"}"#);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["file_path"], json!("hello.txt"));
        assert!(v.get("path").is_none());
        // content 里嵌套一层参数表 → 上提
        let out = normalize_tool_arguments(
            "write",
            r#"{"content":{"content":{"content":"hi","file_path":"hello.txt"}}}"#,
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["content"], json!("hi"));
        assert_eq!(v["file_path"], json!("hello.txt"));
        // 非文件工具不动参数
        let raw = r#"{"query":"x"}"#;
        assert_eq!(normalize_tool_arguments("ai00_web_extract", raw), raw);
        // 命令类工具补 description（引擎必填）
        let out = normalize_tool_arguments("pwsh", r#"{"command":"Get-Content notes.txt"}"#);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["command"], json!("Get-Content notes.txt"));
        assert!(v["description"].is_string(), "{out}");
    }

    #[test]
    fn parses_anthropic_cache_usage() {
        // Anthropic 风格字段：cache_read_input_tokens
        let v = json!({"usage": {
            "prompt_tokens": 100,
            "completion_tokens": 10,
            "cache_read_input_tokens": 64,
        }});
        let usage = GatewayTokenUsage::from_openai(&v).expect("must parse");
        assert_eq!(usage.prompt, 100);
        assert_eq!(usage.cached_prompt, Some(64));
        // 无缓存字段时不报错、cached 为空
        let plain = json!({"usage": {"prompt_tokens": 5, "completion_tokens": 1}});
        assert_eq!(
            GatewayTokenUsage::from_openai(&plain)
                .unwrap()
                .cached_prompt,
            None
        );
    }

    #[test]
    fn remote_fold_only_under_pressure() {
        let small = vec![
            json!({"role": "user", "content": "hi"}),
            json!({"role": "assistant", "tool_calls": [{"id": "c1", "function": {"name": "read", "arguments": "{}"}}]}),
            json!({"role": "tool", "tool_call_id": "c1", "content": "file body"}),
        ];
        assert!(
            !remote_fold_needed(&small),
            "small history must stay intact"
        );
        let big =
            vec![json!({"role": "tool", "content": "x".repeat(REMOTE_FOLD_TRIGGER_CHARS + 1)})];
        assert!(remote_fold_needed(&big), "oversized history must fold");
    }

    #[test]
    fn detects_unparsable_tool_call_text() {
        // 想调工具（有 arguments/name 键）但认不出工具名 → 判失败而非交付
        assert!(looks_like_tool_call_text(
            r#"{"arguments":{"query":"test"},"name":}"#
        ));
        assert!(looks_like_tool_call_text("```json\n{\"arguments\":"));
        // 普通文本 / 普通 JSON 作答不误伤
        assert!(!looks_like_tool_call_text("好的，已完成。"));
        assert!(!looks_like_tool_call_text(r#"{"answer":42}"#));
    }

    #[test]
    fn truncates_runaway_role_marker() {
        let text = "Paris。System: ### 新任务";
        assert_eq!(truncate_at_role_marker(text), "Paris。");
    }

    #[test]
    fn sanitizes_blocked_round_output() {
        // 实测形态：先复读注入指令，再给 BLOCKED 行，末尾挂着泄漏的 system prompt
        let text = "工具轮数已用尽，不再调用任何工具，只输出一行：BLOCKED: 无法继续执行，因为已没有可用工具。\nSystem: You are a DeepSeek Research Agent.\nThe user will provide…";
        assert_eq!(
            sanitize_blocked_text(text),
            "BLOCKED: 无法继续执行，因为已没有可用工具。"
        );
        // 完全没命中标记：补前缀，保证编排者能识别失败
        assert_eq!(
            sanitize_blocked_text("\n\nI could not finish the task"),
            "BLOCKED: I could not finish the task"
        );
        // 空正文也要有可解析的一行
        assert_eq!(
            sanitize_blocked_text("   \n "),
            "BLOCKED: tool rounds exhausted"
        );
    }

    #[test]
    fn exhausted_round_prefers_evidence_over_model_self_report() {
        let model_text = "BLOCKED: write 参数一直错";
        // 有成功工具结果 → 交付证据优先，输出 DONE（避免编排者白付一次远端升级）
        let with_evidence = vec![
            json!({"role":"user","content":"写 hello.txt"}),
            json!({"role":"tool","tool_call_id":"c1","content":"Error: missing file_path"}),
            json!({"role":"tool","tool_call_id":"c2","content":"<path>hello.txt</path>\n<content>\nhello\n</content>"}),
        ];
        let done = finalize_exhausted_text(model_text, &with_evidence);
        assert!(done.starts_with("DONE: "), "{done}");
        assert!(done.contains("hello.txt"), "{done}");
        // 只有失败结果 → 保持显式失败
        let only_errors = vec![
            json!({"role":"user","content":"写 hello.txt"}),
            json!({"role":"tool","tool_call_id":"c1","content":"Error: missing file_path"}),
        ];
        assert!(finalize_exhausted_text(model_text, &only_errors).starts_with("BLOCKED: "));
        // 引擎把工具结果渲染进 user 正文时同样算证据（不依赖 role=tool）
        let folded = vec![json!({
            "role":"user",
            "content":"[工具] read({\"file_path\":\"hello.txt\"}) → <path>hello.txt</path> <content>hello</content>"
        })];
        assert!(finalize_exhausted_text(model_text, &folded).starts_with("DONE: "));
    }

    #[test]
    fn detects_repeated_write_call() {
        let msgs = vec![
            json!({"role":"user","content":"写 hello.txt"}),
            json!({"role":"assistant","tool_calls":[{"id":"c1","function":{
                "name":"write","arguments":"{\"content\":\"hello\",\"file_path\":\"hello.txt\"}"}}]}),
            json!({"role":"tool","tool_call_id":"c1","content":"<path>hello.txt</path>"}),
        ];
        // 同内容同路径（键序无关）→ 重复
        assert!(repeated_write_call(
            &msgs,
            "write",
            r#"{"file_path":"hello.txt","content":"hello"}"#
        ));
        // 复读时把 file_path 弄丢、只带 content → 仍判为重复（实测形态）
        assert!(repeated_write_call(
            &msgs,
            "write",
            r#"{"content":"hello"}"#
        ));
        // 同内容但写的是另一个文件 → 不是重复
        assert!(!repeated_write_call(
            &msgs,
            "write",
            r#"{"content":"hello","file_path":"other.txt"}"#
        ));
        // 内容不同 → 不是重复
        assert!(!repeated_write_call(
            &msgs,
            "write",
            r#"{"content":"bye","file_path":"hello.txt"}"#
        ));
        // read 可重复（幂等判断只针对写）
        assert!(!repeated_write_call(
            &msgs,
            "read",
            r#"{"file_path":"hello.txt"}"#
        ));
    }

    #[test]
    fn sse_chunks_format() {
        let chunk = sse_text_delta("rwkv-local", "hello");
        assert!(chunk.starts_with("data: {"));
        assert!(chunk.ends_with("\n\n"));
        let parsed: Value =
            serde_json::from_str(chunk.trim_start_matches("data: ").trim()).unwrap();
        assert_eq!(parsed["choices"][0]["delta"]["content"], json!("hello"));
    }

    #[test]
    fn local_tools_whitelist_accepts_only_whitelisted() {
        let ok = json!({"tools": [
            {"type": "function", "function": {"name": "ai00_notify", "parameters": {}}},
            {"type": "function", "function": {"name": "ai00_todo_read", "parameters": {}}},
        ]});
        assert!(tools_all_local(&ok));

        // 混入一个非白名单工具（ai00_todo_write 有破坏性）→ 整体拒绝
        let mixed = json!({"tools": [
            {"type": "function", "function": {"name": "ai00_notify", "parameters": {}}},
            {"type": "function", "function": {"name": "ai00_todo_write", "parameters": {}}},
        ]});
        assert!(!tools_all_local(&mixed));

        // 空数组与缺失 tools → false
        assert!(!tools_all_local(&json!({"tools": []})));
        assert!(!tools_all_local(&json!({})));
    }

    #[test]
    fn local_tools_switch_defaults_off() {
        // 未设 env 时默认关（M1.1 真机验证前的保守默认）
        // 注：CI 环境不设 AI00X_DSH_LOCAL_TOOLS；若显式设为 0/false 也应关
        std::env::remove_var("AI00X_DSH_LOCAL_TOOLS");
        assert!(!local_tools_enabled());
    }

    #[test]
    fn remote_fallback_maps_logic_ids_to_primary() {
        // 本地/智能路由逻辑 id 不可被远端解析 → 统一落 primary 槽
        assert_eq!(remote_fallback_ref(MODEL_RWKV), MODEL_REMOTE);
        assert_eq!(remote_fallback_ref(MODEL_AUTO), MODEL_REMOTE);
        // ai00-salvo 自身与具体远端引用原样保留
        assert_eq!(remote_fallback_ref(MODEL_REMOTE), MODEL_REMOTE);
        assert_eq!(
            remote_fallback_ref("ai00s:deepseek-v3"),
            "ai00s:deepseek-v3"
        );
        assert_eq!(remote_fallback_ref("my-custom-model"), "my-custom-model");
    }

    // ---- 2026-11-21：工具轮收尾与证据判定 ----

    #[test]
    fn tool_result_text_accepts_rendered_user_output() {
        let tool_msg = json!({"role": "tool", "content": "1. Mem0 paper\n   https://arxiv.org/abs/2504.19413"});
        assert!(tool_result_text(&tool_msg).is_some_and(|t| t.contains("Mem0")));
        // 引擎把结果并回历史时渲染成 user 正文
        let rendered =
            json!({"role": "user", "content": "Function output:\n1. Mem0 paper\ntitle/url"});
        assert!(tool_result_text(&rendered).is_some_and(|t| t.starts_with("1. Mem0")));
        // 普通用户消息不是工具结果
        assert!(tool_result_text(&json!({"role": "user", "content": "plan ok"})).is_none());
    }

    #[test]
    fn failed_tool_text_is_not_evidence() {
        let messages = vec![
            json!({"role": "assistant", "tool_calls": [{"id": "c1", "function": {"name": "ai00_web_extract", "arguments": "{}"}}]}),
            json!({"role": "tool", "tool_call_id": "c1", "content": "web extract: no results"}),
        ];
        assert_eq!(last_successful_tool_result(&messages), None);
        assert_eq!(terminal_tool_completion(&messages), None);
    }

    #[test]
    fn runtime_evidence_detected_after_search_results() {
        let messages = vec![
            json!({"role": "assistant", "tool_calls": [{"id": "c1", "function": {"name": "ai00_search", "arguments": "{}"}}]}),
            json!({"role": "tool", "tool_call_id": "c1", "content": "1. Mem0\n   https://mem0.ai"}),
        ];
        assert!(last_successful_tool_result(&messages).is_some());
        // 检索不是终结型工具：不短路，让模型继续走
        assert_eq!(terminal_tool_completion(&messages), None);
    }

    #[test]
    fn terminal_tool_closes_turn_with_evidence() {
        let messages = vec![
            json!({"role": "assistant", "tool_calls": [{"id": "c1", "function": {"name": "ai00_research_collect", "arguments": "{}"}}]}),
            json!({"role": "tool", "tool_call_id": "c1", "content": "wrote sources.md: 12 sources from 4 queries, 0 failed"}),
        ];
        let done = terminal_tool_completion(&messages);
        assert!(done.is_some_and(|text| text.contains("12 sources")));
    }

    #[test]
    fn repeated_tool_call_detects_same_arguments() {
        let messages = vec![json!({
            "role": "assistant",
            "tool_calls": [{"id": "c1", "function": {
                "name": "ai00_search",
                "arguments": "{\"query\":\"agent memory\",\"max_results\":8}"
            }}]
        })];
        // 字段顺序不同但语义相同 → 视为重复
        assert!(repeated_tool_call(
            &messages,
            "ai00_search",
            "{\"max_results\":8,\"query\":\"agent memory\"}"
        ));
        assert!(!repeated_tool_call(
            &messages,
            "ai00_search",
            "{\"query\":\"graphiti temporal graph\",\"max_results\":8}"
        ));
    }

    #[test]
    fn terminal_tool_detects_result_injected_as_user_text() {
        // 引擎把工具结果并回历史成普通 user 正文 → 仍须判定为终结型工具成功
        let messages = vec![
            json!({"role": "assistant", "tool_calls": [{"id": "c1", "function": {"name": "ai00_research_collect", "arguments": "{}"}}]}),
            json!({"role": "user", "content": "wrote sources.md: 31 sources from 7 queries, 0 failed"}),
        ];
        let done = terminal_tool_completion(&messages);
        assert!(
            done.as_deref()
                .is_some_and(|text| text.contains("31 sources")),
            "{done:?}"
        );
        assert!(last_successful_tool_result(&messages).is_some());
    }

    #[test]
    fn empty_write_is_rejected_before_touching_the_file() {
        assert!(write_rejection("write", r#"{"file_path":"report.md","content":""}"#).is_some());
        assert!(
            write_rejection("write", r#"{"file_path":"report.md","content":"  \n "}"#).is_some()
        );
        // 缺 content 字段同样会清空文件
        assert!(write_rejection("write", r#"{"file_path":"report.md"}"#).is_some());
        // 正常写入放行
        assert!(
            write_rejection("write", r##"{"file_path":"report.md","content":"# hi"}"##).is_none()
        );
        // edit 删空一段内容（new_string 为空）是合法操作，不拦
        assert!(write_rejection(
            "edit",
            r#"{"file_path":"x.md","old_string":"a","new_string":""}"#
        )
        .is_none());
    }

    #[test]
    fn oversized_local_write_is_rejected() {
        // 本地 3B 写长文会退化：超过预算的单次 write 直接拒绝，让它分节写或升级云端
        let big = "字".repeat(LOCAL_WRITE_MAX_CHARS + 1);
        let args = json!({ "file_path": "report.md", "content": big }).to_string();
        let reason = write_rejection("write", &args).expect("must reject");
        assert!(
            reason.contains("exceeds the local-model budget"),
            "{reason}"
        );
        // 刚好到上限放行
        let ok = "字".repeat(LOCAL_WRITE_MAX_CHARS);
        let args = json!({ "file_path": "report.md", "content": ok }).to_string();
        assert!(write_rejection("write", &args).is_none());
    }

    #[test]
    fn empty_write_is_not_delivery_evidence() {
        // 实测：3B 退化后发出 content 为空的 write，write 成功 → 终结短路把 0 字节文件当 DONE
        let messages = vec![
            json!({"role": "assistant", "tool_calls": [{"id": "c1", "function": {"name": "write", "arguments": "{\"file_path\":\"report.md\",\"content\":\"\"}"}}]}),
            json!({"role": "tool", "tool_call_id": "c1", "content": "<path>C:/ws/report.md</path>"}),
        ];
        assert_eq!(terminal_tool_completion(&messages), None);
        assert_eq!(last_successful_tool_result(&messages), None);
        // 非空写入仍然算交付证据
        let ok = vec![
            json!({"role": "assistant", "tool_calls": [{"id": "c2", "function": {"name": "write", "arguments": "{\"file_path\":\"report.md\",\"content\":\"# hi\"}"}}]}),
            json!({"role": "tool", "tool_call_id": "c2", "content": "<path>C:/ws/report.md</path>"}),
        ];
        assert!(terminal_tool_completion(&ok).is_some());
        assert!(last_successful_tool_result(&ok).is_some());
    }

    #[test]
    fn blocked_text_truncates_leaked_system_prompt() {
        let text = "BLOCKED: 未找到相关结果。System: You are a helpful AI agent for research task execution.";
        let cleaned = sanitize_blocked_text(text);
        assert_eq!(cleaned, "BLOCKED: 未找到相关结果。");
    }

    #[test]
    fn merges_consecutive_user_blocks() {
        // dsh 在 turn 开头连发多条 user 消息 → 必须并成一个 User 块
        let messages = vec![
            json!({"role": "system", "content": "You are a worker."}),
            json!({"role": "user", "content": "The working directory changed to C:/ws"}),
            json!({"role": "user", "content": "Working directory: C:/ws"}),
            json!({"role": "user", "content": "Current runtime context snapshot."}),
        ];
        let prompt = openai_messages_to_rwkv_prompt(&messages, None);
        assert_eq!(
            prompt.matches("User:").count(),
            1,
            "consecutive user turns must merge: {prompt}"
        );
        assert!(prompt.contains("The working directory changed to C:/ws"));
        assert!(prompt.contains("Current runtime context snapshot."));
        assert!(scan_prompt_violations(&prompt).is_empty(), "{prompt}");
    }

    #[test]
    fn merges_parallel_tool_call_blocks() {
        let messages = vec![
            json!({"role": "system", "content": "You are a worker."}),
            json!({"role": "user", "content": "research memory"}),
            json!({"role": "assistant", "tool_calls": [
                {"id": "c1", "function": {"name": "ai00_search", "arguments": "{\"query\":\"a\"}"}},
                {"id": "c2", "function": {"name": "ai00_search", "arguments": "{\"query\":\"b\"}"}}
            ]}),
            json!({"role": "tool", "tool_call_id": "c1", "content": "1. result a"}),
            json!({"role": "tool", "tool_call_id": "c2", "content": "1. result b"}),
        ];
        let prompt = openai_messages_to_rwkv_prompt(&messages, None);
        assert_eq!(
            prompt.matches("Assistant: ```json").count(),
            1,
            "parallel calls must live in one assistant block: {prompt}"
        );
        assert_eq!(prompt.matches("User: Function output:").count(), 1);
        assert!(scan_prompt_violations(&prompt).is_empty(), "{prompt}");
    }

    #[test]
    fn scan_flags_two_user_turns_and_multiple_system() {
        let bad = "System: a\n\nSystem: b\n\nUser: x\n\nUser: y\n\nAssistant: ";
        let violations = scan_prompt_violations(bad);
        assert!(
            violations.contains(&"MULTIPLE_SYSTEM".to_string()),
            "{violations:?}"
        );
        assert!(
            violations.contains(&"TWO_USER_TURNS".to_string()),
            "{violations:?}"
        );
    }

    #[test]
    fn scan_accepts_wellformed_prompt() {
        let good = "System: a\n\nUser: x\n\nAssistant: ```json\n{\"name\": \"";
        assert!(scan_prompt_violations(good).is_empty());
        // 不以 Assistant 结尾 → 报错
        let truncated = "System: a\n\nUser: x\n\n";
        assert!(scan_prompt_violations(truncated).contains(&"ENDS_ON_NON_ASSISTANT".to_string()));
    }

    #[test]
    fn fewshot_prefers_tool_named_in_brief() {
        let tools = vec![
            json!({"type": "function", "function": {
                "name": "read",
                "description": "Read a file",
                "parameters": {"properties": {"path": {"type": "string"}}}
            }}),
            json!({"type": "function", "function": {
                "name": "ai00_research_collect",
                "description": "Collect sources",
                "parameters": {"properties": {
                    "topic": {"type": "string"},
                    "queries": {"type": "array", "items": {"type": "string"}}
                }}
            }}),
        ];
        let block = tool_fewshot_block(&tools, Some("ai00_research_collect"), None, None, None)
            .unwrap_or_default();
        assert!(
            block.contains("\"name\": \"ai00_research_collect\""),
            "expected the hinted tool first: {block}"
        );
        // 数组参数也要有真实示例
        assert!(block.contains("\"queries\": ["));
    }
}
