//! Ai00-X AI 网关：dsh `@ai00-x/ai-bridge` 插件的统一 LLM 入口。
//!
//! 端点（挂本地内嵌 Salvo 2100，仅本机监听）：
//! - `POST /ai00-internal/llm/v1/chat/completions` — OpenAI 兼容（含 SSE 流式）
//! - `GET  /ai00-internal/llm/v1/models` — 逻辑模型列表
//!
//! 分流策略（按请求 `model` 字段）：
//! - `ai00-auto`（默认）→ SmartRouter（本地 RWKV classify R0-R3）：
//!   R0/R1 → 本地 RWKV；R2/R3 → ai00-salvo（primary 模型转发）
//! - 带 tools 且全部在本地白名单 → 混合工具循环（M1.3，默认开）：工具轮
//!   本地 RWKV 零状态临时会话，收敛后远端基于折叠历史合成终答
//! - `rwkv-local`  → 强制本地 RWKV
//! - `ai00-salvo`  → 强制远程转发（primary 模型）
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

use crate::rwkv_llm::{pool_infer, InferenceEvent};

/// 逻辑模型 id（对 dsh provider UI 暴露）。
pub const MODEL_AUTO: &str = "ai00-auto";
pub const MODEL_RWKV: &str = "rwkv-local";
pub const MODEL_REMOTE: &str = "ai00-salvo";

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
}

#[handler]
async fn list_models(res: &mut Response) {
    // 静态逻辑模型 + 用户已配置的具体模型引用（讨论通道同源，dsh 侧
    // 模型选择器可见可选；桥按 id 透传回网关按引用解析）。
    // ai00-auto 不再广告（弹层去 auto）：主会话钉远端、编排 worker 内部
    // 使用该 id 走 SmartRouter，分流语义保留（存量会话/aux 兼容）。
    let mut data = vec![
        json!({"id": MODEL_RWKV,   "object": "model", "name": "Ai00-X Local RWKV", "contextWindow": 16384, "owned_by": "ai00-x"}),
        json!({"id": MODEL_REMOTE, "object": "model", "name": "Ai00-X Salvo (ai00-x.com)", "contextWindow": 128000, "owned_by": "ai00-x"}),
    ];
    if let Ok(service) = get_global_config_service() {
        if let Ok(config) = service
            .get_config::<ai00_x_core::service::config::GlobalConfig>(None)
            .await
        {
            for m in &config.ai.models {
                // "ai00s" 裸别名条目与 ai00-salvo（primary 槽）语义重叠，不下发
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
        hybrid_tool_loop(body, &model, res).await;
        return;
    }
    // 具体模型引用（非三个保留逻辑 id）→ 按引用解析转发，不参与智能路由
    let is_specific_ref = !model.is_empty() && model != MODEL_AUTO;
    let use_local = match model.as_str() {
        MODEL_RWKV => true,
        MODEL_REMOTE => false,
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
        if local_rwkv_sse(body.clone(), res).await.is_err() {
            log::warn!("[ai-gateway] local branch failed -> fallback to remote");
            forward_to_ai00_salvo(body, res, &model).await;
        }
    } else {
        forward_to_ai00_salvo(body, res, &model).await;
    }
}

/// 本地工具白名单：只放行只读 + 通知类工具——本地分支即使工具调用解析失败
/// 也不会产生破坏性副作用（写知行/换壁纸/XP 全部排除）。
/// 两部分同源约定（改动须双向同步）：
/// - ai00_*：桌面业务只读工具（M1.2）
/// - dsh 只读六件套：与 dsh_manager.rs ORCHESTRATION_PATCH 的
///   research_worker toolFilter.allow 完全一致——编排架构里调研 worker
///   （model=ai00-auto）靠本白名单获得 hybrid_tool_loop 本地资格
const LOCAL_TOOL_WHITELIST: &[&str] = &[
    "ai00_notify",
    "ai00_todo_read",
    "ai00_plan_read",
    "ai00_focus_log",
    "ai00_wallpaper_projects",
    // dsh 只读六件套（research_worker 允许集）
    "read",
    "read_image",
    "glob",
    "grep",
    "web_fetch",
    "web_search",
];

/// 本地工具路径开关（env `AI00X_DSH_LOCAL_TOOLS=1`；默认关，M1.1 真机验证
/// 通过后再默认放开）。
fn local_tools_enabled() -> bool {
    std::env::var("AI00X_DSH_LOCAL_TOOLS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// 混合工具循环入口判定（纯函数，便于单测）：仅智能路由语义（空 / ai00-auto）
/// 才允许进入本地工具循环；显式选型（rwkv-local=强制本地 / ai00-salvo=强制远端 /
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
async fn local_rwkv_sse(body: Value, res: &mut Response) -> Result<(), String> {
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
    let top_p = body
        .get("top_p")
        .and_then(|v| v.as_f64())
        .map(|v| v as f32)
        .unwrap_or(if has_tools { 0.1 } else { 0.3 });
    let presence = if has_tools { 0.5 } else { 0.3 };
    let frequency = if has_tools { 0.5 } else { 0.3 };

    let prompt = openai_messages_to_rwkv_prompt(&messages, tools.as_deref());
    let is_instruction_format = prompt.starts_with("Instruction: ");

    // stop 序列：沿用 ai-adapters RWKV provider 验证过的组合
    let mut stop = vec![
        "\n\nUser:".to_string(),
        "\n\nSystem:".to_string(),
        "\n\nInstruction:".to_string(),
        "\n\nInput:".to_string(),
    ];
    if is_instruction_format {
        stop.push("\n\n".to_string());
    }

    let mut rx = match pool_infer(
        prompt.clone(),
        max_tokens,
        top_p,
        0,
        presence,
        frequency,
        0.996,
        Some(stop.clone()),
        None, // session_id：零状态全量 prefill，不写会话缓存——避免双重喂入
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

    // 流式桥接：InferenceEvent → OpenAI SSE chunks
    // 带工具时输出全缓冲（结束才判定 tool-call / 纯文本）：边流 text-delta 边
    // 补发 tool_call_delta 会让 text 块和 tool-call 块并存，污染 dsh 上下文。
    let (tx, rx_body) = tokio::sync::mpsc::unbounded_channel::<Result<Bytes, salvo::Error>>();
    let model_name = MODEL_RWKV.to_string();

    tokio::spawn(async move {
        let mut full_text = String::new();
        let mut input_tokens = 0usize;
        let mut output_tokens = 0usize;
        while let Some(event) = rx.recv().await {
            match event {
                InferenceEvent::Token(t) => {
                    full_text.push_str(&t);
                    if !has_tools {
                        let chunk = sse_text_delta(&model_name, &t);
                        if tx.send(Ok(Bytes::from(chunk))).is_err() {
                            break;
                        }
                    }
                }
                InferenceEvent::Done {
                    text,
                    input_tokens: it,
                    output_tokens: ot,
                    ..
                } => {
                    full_text = text;
                    input_tokens = it;
                    output_tokens = ot;
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

        // 尝试提取工具调用（```json {...} ``` 协议）
        if let Some((name, arguments)) = try_extract_tool_call(&text) {
            let chunk = sse_tool_call_delta(&model_name, &name, &arguments);
            let _ = tx.send(Ok(Bytes::from(chunk)));
            let chunk = sse_finish(&model_name, "tool_calls");
            let _ = tx.send(Ok(Bytes::from(chunk)));
        } else {
            // 带工具但没解析出调用：整段作为文本补发（缓冲模式下还没发过）
            if has_tools && !text.is_empty() {
                let chunk = sse_text_delta(&model_name, &text);
                let _ = tx.send(Ok(Bytes::from(chunk)));
            }
            let chunk = sse_usage(&model_name, input_tokens, output_tokens);
            let _ = tx.send(Ok(Bytes::from(chunk)));
            let chunk = sse_finish(&model_name, "stop");
            let _ = tx.send(Ok(Bytes::from(chunk)));
        }
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
    ToolCall { name: String, arguments: String },
    /// 模型产出纯文本——工具循环收敛信号，作为终答草稿。
    /// hit_len = 因 max_tokens 收尾（Done.stop_sequence 为 None），供质量门判定截断。
    Draft { text: String, hit_len: bool },
}

/// 混合工具循环编排：工具轮本地 RWKV（零状态临时会话），收敛后远端终答。
/// 本地失败整轮降级远端循环（旧路径），请求不失败。
async fn hybrid_tool_loop(body: Value, model: &str, res: &mut Response) {
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
        forward_to_ai00_salvo(body, res, model).await;
        return;
    }

    match local_tool_round(&body, None).await {
        Ok(ToolRoundOutcome::ToolCall { name, arguments }) => {
            log::info!("[ai-gateway] tool round {rounds}: local -> call {name}");
            let (tx, rx_body) =
                tokio::sync::mpsc::unbounded_channel::<Result<Bytes, salvo::Error>>();
            tokio::spawn(async move {
                let _ = tx.send(Ok(Bytes::from(sse_tool_call_delta(
                    MODEL_RWKV, &name, &arguments,
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
        Ok(ToolRoundOutcome::Draft { text, hit_len }) => {
            let is_local_final = crate::tool_session::tools_all_local_final(&body);
            match crate::tool_session::quality_gate(&text, hit_len) {
                Ok(()) if is_local_final => {
                    // 全本地闭环工具（web 提取/长文总结）：草稿即终答，直出不绕远端
                    log::info!(
                        "[ai-gateway] tool round {rounds}: local-final answer {} chars (no remote)",
                        text.chars().count()
                    );
                    stream_local_final(res, &text);
                }
                Ok(()) => {
                    log::info!(
                        "[ai-gateway] tool round {rounds}: local -> draft {} chars, composing remote final",
                        text.chars().count()
                    );
                    compose_final_remote(body, Some(&text), model, res).await;
                }
                Err(problems) => {
                    // 质量门拦截：换采样（top_p 0.5）本地重试一次，仍不合格升级远端（无草稿）
                    log::warn!(
                        "[ai-gateway] draft failed quality gate: {problems:?}, retrying top_p=0.5"
                    );
                    let retry = match local_tool_round(&body, Some(0.5)).await {
                        Ok(ToolRoundOutcome::Draft {
                            text: retry_text,
                            hit_len: retry_hit,
                        }) if crate::tool_session::quality_gate(&retry_text, retry_hit).is_ok() => {
                            Some(retry_text)
                        }
                        _ => None,
                    };
                    match retry {
                        Some(retry_text) if is_local_final => {
                            log::info!(
                                "[ai-gateway] retry passed gate: local-final answer {} chars",
                                retry_text.chars().count()
                            );
                            stream_local_final(res, &retry_text);
                        }
                        Some(retry_text) => {
                            compose_final_remote(body, Some(&retry_text), model, res).await;
                        }
                        None => {
                            log::warn!(
                                "[ai-gateway] retry failed gate, upgrading to remote (no draft)"
                            );
                            compose_final_remote(body, None, model, res).await;
                        }
                    }
                }
            }
        }
        Err(e) => {
            // 本地推理失败：整轮降级远端循环（forward 入口折叠闭合段，
            // 进行中段原样保留，远端续接工具循环），用户无感。
            log::warn!("[ai-gateway] local tool round failed ({e}), fallback to remote loop");
            forward_to_ai00_salvo(body, res, model).await;
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
) -> Result<ToolRoundOutcome, String> {
    let messages = body
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let tools = body.get("tools").and_then(|v| v.as_array()).cloned();
    let max_tokens = body
        .get("max_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(512) as usize;
    let top_p = top_p_override
        .or_else(|| body.get("top_p").and_then(|v| v.as_f64()).map(|v| v as f32))
        .unwrap_or(0.1);

    let folded = crate::tool_session::fold_tool_segments(&messages, false);
    let prompt = openai_messages_to_rwkv_prompt(&folded, tools.as_deref());

    // stop 序列与 local_rwkv_sse 对齐（带工具时恒为对话格式，无 Instruction 分支）
    let stop = vec![
        "\n\nUser:".to_string(),
        "\n\nSystem:".to_string(),
        "\n\nInstruction:".to_string(),
        "\n\nInput:".to_string(),
    ];
    let mut rx = pool_infer(
        prompt,
        max_tokens,
        top_p,
        0,
        0.5,
        0.5,
        0.996,
        Some(stop),
        None, // session_id：零状态临时会话，不写会话缓存
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
    while let Some(event) = rx.recv().await {
        match event {
            InferenceEvent::Token(t) => full_text.push_str(&t),
            InferenceEvent::Done {
                text,
                stop_sequence,
                ..
            } => {
                full_text = text;
                // stop_sequence 为 None = 因 max_tokens 收尾（截断），供质量门判定
                hit_len = stop_sequence.is_none();
                break;
            }
            InferenceEvent::Error(e) => return Err(e),
        }
    }

    if let Some((name, arguments)) = try_extract_tool_call(&full_text) {
        Ok(ToolRoundOutcome::ToolCall { name, arguments })
    } else {
        Ok(ToolRoundOutcome::Draft {
            text: full_text.trim().to_string(),
            hit_len,
        })
    }
}

/// 全本地闭环终答直出：草稿文本以 SSE 流式形状一次性下发（不绕远端）。
fn stream_local_final(res: &mut Response, text: &str) {
    let (tx, rx_body) = tokio::sync::mpsc::unbounded_channel::<Result<Bytes, salvo::Error>>();
    let text = text.to_string();
    tokio::spawn(async move {
        let _ = tx.send(Ok(Bytes::from(sse_text_delta(MODEL_RWKV, &text))));
        let _ = tx.send(Ok(Bytes::from(sse_usage(
            MODEL_RWKV,
            0,
            text.chars().count(),
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
async fn compose_final_remote(body: Value, draft: Option<&str>, model: &str, res: &mut Response) {
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
    forward_to_ai00_salvo(body, res, model).await;
}

// ---------------------------------------------------------------------------
// 远程转发分支（ai00-salvo primary / 具体模型引用解析转发）
// ---------------------------------------------------------------------------

/// 本地失败降级目标：不可解析为远端客户端的引用（本地/智能路由逻辑 id）
/// 统一落到 primary 槽；具体远端引用（ai00s:xxx / 自定义 id / ai00-salvo）原样保留。
fn remote_fallback_ref(model: &str) -> &str {
    match model {
        MODEL_RWKV | MODEL_AUTO => MODEL_REMOTE,
        _ => model,
    }
}

/// 转发到指定模型引用（OpenAI 兼容 SSE 透传）：`ai00-salvo` → primary 槽；
/// 其他引用（ai00s:/gguf-local:/自定义 id）按 client_factory 同一解析链直达。
/// 本地失败降级统一走此入口——逻辑 id（rwkv-local/ai00-auto）先经
/// [`remote_fallback_ref`] 映射，保证「本地失败自动降级远端」真实成立。
async fn forward_to_ai00_salvo(mut body: Value, res: &mut Response, model_ref: &str) {
    // 历史折叠（M1.3）：已闭合工具段 → 紧凑结论行（省 token、防长会话漂移）；
    // 进行中段原样保留——llama-server 需原始 tool 消息续接工具循环。幂等。
    if let Some(obj) = body.as_object_mut() {
        if let Some(messages) = obj.get("messages").and_then(|v| v.as_array()) {
            let folded = crate::tool_session::fold_tool_segments(messages, false);
            if folded.len() != messages.len() {
                log::info!(
                    "[ai-gateway] folded tool segments: {} -> {} messages",
                    messages.len(),
                    folded.len()
                );
            }
            obj.insert("messages".to_string(), json!(folded));
        }
    }
    let resolve_key = match remote_fallback_ref(model_ref) {
        MODEL_REMOTE => "primary",
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

    // 覆写 model 为 primary 配置的模型名，强制流式
    if let Some(obj) = body.as_object_mut() {
        obj.insert("model".to_string(), json!(client.config.model));
        obj.insert("stream".to_string(), json!(true));
    }

    // 发送（401 时刷新 member token 重试一次——dsh 会话是长驻的，
    // access token 过期后不刷新会让所有 agent 请求永久 502）
    let mut upstream = None;
    for attempt in 0..2 {
        let mut request = client
            .http_client()
            .post(&client.config.request_url)
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
                    // token 过期：刷新后重建 client 重试
                    if crate::auth::refresh_auth_token_impl().await.is_ok() {
                        if let Ok(f) = AIClientFactory::get_global() {
                            if let Ok(c) = f.get_client_resolved(resolve_key).await {
                                client = c;
                                continue;
                            }
                        }
                    }
                }
                upstream = Some(r);
                break;
            }
            Err(e) => {
                res.status_code(StatusCode::BAD_GATEWAY);
                res.body(
                    json!({"error": {"message": format!("upstream request failed: {e}")}})
                        .to_string(),
                );
                return;
            }
        }
    }
    let Some(upstream) = upstream else {
        return;
    };

    if !upstream.status().is_success() {
        let status = upstream.status();
        let text = upstream.text().await.unwrap_or_default();
        res.status_code(StatusCode::BAD_GATEWAY);
        res.body(json!({"error": {"message": text, "status": status.as_u16()}}).to_string());
        return;
    }

    // SSE 字节流透传
    let (tx, rx_body) = tokio::sync::mpsc::unbounded_channel::<Result<Bytes, salvo::Error>>();
    tokio::spawn(async move {
        let mut stream = upstream.bytes_stream();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    if tx.send(Ok(bytes)).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(salvo::Error::other(format!(
                        "upstream stream error: {e}"
                    ))));
                    break;
                }
            }
        }
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

// ---------------------------------------------------------------------------
// OpenAI messages → RWKV prompt（移植自 ai-adapters/providers/rwkv/request.rs）
// ---------------------------------------------------------------------------

/// OpenAI 格式消息（role/content/tool_calls/tool_call_id）→ RWKV World/Instruction 格式。
fn openai_messages_to_rwkv_prompt(messages: &[Value], tools: Option<&[Value]>) -> String {
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

    let mut prompt = String::new();
    let mut tools_injected = false;

    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        match role {
            "system" => {
                if let Some(content) = message_text(msg) {
                    prompt.push_str(&format!("System: {}\n\n", sanitize(&content)));
                }
            }
            "user" => {
                if !tools_injected {
                    if let Some(tool_defs) = tools {
                        inject_tools(&mut prompt, tool_defs);
                    }
                    tools_injected = true;
                }
                if let Some(content) = message_text(msg) {
                    prompt.push_str(&format!("User: {}\n\n", sanitize(&content)));
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
                        prompt.push_str(&format!("Assistant: ```json\n{}\n```\n\n", value));
                    }
                } else if let Some(content) = message_text(msg) {
                    prompt.push_str(&format!("Assistant: {}\n\n", sanitize(&content)));
                }
            }
            "tool" => {
                if let Some(content) = message_text(msg) {
                    prompt.push_str(&format!(
                        "User: Function output:\n{}\n\n",
                        sanitize(&content)
                    ));
                }
            }
            _ => {}
        }
    }

    if !tools_injected {
        if let Some(tool_defs) = tools {
            inject_tools(&mut prompt, tool_defs);
        }
    }

    if has_tools {
        // 官方 G1x 模板：续写起点给 ```json 围栏开头，模型输出 {"name":...} 后闭合
        prompt.push_str("Assistant: ```json\n");
    } else {
        prompt.push_str("Assistant: ");
    }
    prompt
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
/// <https://www.rwkv.cn/docs/RWKV-Prompts/Prompt-Format#function-call>：
/// JSON 数组格式，每项带 name / description / arguments（参数名 → schema），
/// 后跟 "Return only a JSON function call."。description 必须保留——
/// 模型靠它判断何时调用哪个工具（丢失会导致模型把调用当纯文本续写）。
fn inject_tools(prompt: &mut String, tools: &[Value]) {
    let defs: Vec<Value> = tools
        .iter()
        .filter_map(|tool| {
            let f = tool.get("function")?;
            let arguments = f
                .get("parameters")
                .and_then(|p| p.get("properties"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            Some(json!({
                "name": f.get("name").cloned().unwrap_or(Value::Null),
                "description": f.get("description").cloned().unwrap_or(json!("")),
                "arguments": arguments,
            }))
        })
        .collect();
    prompt.push_str("System: Tools:\n");
    prompt.push_str(&serde_json::to_string_pretty(&defs).unwrap_or_default());
    prompt.push_str("\nReturn only a JSON function call.\n\n");
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

/// 解析后的 JSON 值 → (name, arguments_json)。无 name 字段视为非工具调用。
fn parse_call_value(v: Value) -> Option<(String, String)> {
    let name = v.get("name")?.as_str()?.to_string();
    let arguments = v
        .get("arguments")
        .cloned()
        .map(|a| a.to_string())
        .unwrap_or_else(|| "{}".to_string());
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
        // 官方 G1x 模板：JSON 数组工具定义（含 description）+ ```json 续写起点
        assert!(prompt.contains("System: Tools:"));
        assert!(prompt.contains("\"name\": \"Read\""));
        assert!(prompt.contains("\"description\": \"Read a UTF-8 text file\""));
        assert!(prompt.contains("Return only a JSON function call."));
        assert!(prompt.ends_with("Assistant: ```json\n"));
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
    fn truncates_runaway_role_marker() {
        let text = "Paris。System: ### 新任务";
        assert_eq!(truncate_at_role_marker(text), "Paris。");
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
}
