//! Ai00-X AI 网关：dsh `@ai00-x/ai-bridge` 插件的统一 LLM 入口。
//!
//! 端点（挂本地内嵌 Salvo 2100，仅本机监听）：
//! - `POST /ai00-internal/llm/v1/chat/completions` — OpenAI 兼容（含 SSE 流式）
//! - `GET  /ai00-internal/llm/v1/models` — 逻辑模型列表
//!
//! 分流策略（按请求 `model` 字段）：
//! - `ai00-auto`（默认）→ SmartRouter（本地 RWKV classify R0-R3）：
//!   R0/R1 → 本地 RWKV；R2/R3 → ai00-salvo（primary 模型转发）
//! - `rwkv-local`  → 强制本地 RWKV
//! - `ai00-salvo`  → 强制远程转发
//!
//! 鉴权：`X-Ai00-Internal-Token` 头匹配 `AI00_S_INTERNAL_TOKEN`（回退默认值）。

use bytes::Bytes;
use futures::StreamExt;
use salvo::http::StatusCode;
use salvo::prelude::*;
use serde_json::{json, Value};

use ai00_x_core::agent::routing::get_smart_router;
use ai00_x_core::agent::routing::RouteClass;
use ai00_x_core::infrastructure::ai::client_factory::{ai00_s_internal_token, AIClientFactory};
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
    res.body(
        json!({
            "object": "list",
            "data": [
                { "id": MODEL_AUTO,   "object": "model", "owned_by": "ai00-x" },
                { "id": MODEL_RWKV,   "object": "model", "owned_by": "ai00-x" },
                { "id": MODEL_REMOTE, "object": "model", "owned_by": "ai00-x" },
            ],
        })
        .to_string(),
    );
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
        Ok(v) => v,
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
    let use_local = match model.as_str() {
        MODEL_RWKV => true,
        MODEL_REMOTE => false,
        _ => {
            // ai00-auto：SmartRouter 分类
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
        local_rwkv_sse(body, session_id, res).await;
    } else {
        forward_to_ai00_salvo(body, res).await;
    }
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
async fn local_rwkv_sse(body: Value, session_id: Option<String>, res: &mut Response) {
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
    let top_p = body.get("top_p").and_then(|v| v.as_f64()).unwrap_or(0.3) as f32;

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
        0.3,
        0.3,
        0.996,
        Some(stop.clone()),
        session_id,
        stream,
        false,
        String::new(),
    )
    .await
    {
        Ok(rx) => rx,
        Err(e) if e.contains("not initialized") => {
            // RWKV 引擎未初始化：后台触发 lazy-init（加载耗时且推理池串行，
            // 阻塞等待会让并发请求全部积压挂死）。本请求立即 503，
            // 由 dsh llm-retry 层重试直到引擎就绪。
            tokio::spawn(async move {
                if let Err(e) = crate::rwkv_llm::init_engine_internal(None, None, None).await {
                    log::warn!("[ai-gateway] RWKV lazy-init failed: {e}");
                }
            });
            res.status_code(StatusCode::SERVICE_UNAVAILABLE);
            res.body(
                json!({"error": {"message": "RWKV engine not initialized; loading in background, retry shortly"}})
                    .to_string(),
            );
            return;
        }
        Err(e) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.body(json!({"error": {"message": format!("RWKV engine error: {e}")}}).to_string());
            return;
        }
    };

    // 流式桥接：InferenceEvent → OpenAI SSE chunks
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
                    let chunk = sse_text_delta(&model_name, &t);
                    if tx.send(Ok(Bytes::from(chunk))).is_err() {
                        break;
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
}

// ---------------------------------------------------------------------------
// 远程转发分支（ai00-salvo primary 模型）
// ---------------------------------------------------------------------------

/// 转发到 primary 模型（OpenAI 兼容 SSE 透传）。
async fn forward_to_ai00_salvo(mut body: Value, res: &mut Response) {
    // 恢复登录态：dsh 侧请求可能先于任何前端登录流程到达，
    // AI00S_AUTH_TOKEN 是内存态——从 vault 兜底恢复（幂等，已有则秒回）。
    let _ = crate::auth::ensure_auth_synced().await;
    let client = match AIClientFactory::get_global() {
        Ok(f) => match f.get_client_resolved("primary").await {
            Ok(c) => c,
            Err(e) => {
                res.status_code(StatusCode::BAD_GATEWAY);
                res.body(
                    json!({"error": {"message": format!("primary model unavailable: {e}")}})
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

    let upstream = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            res.status_code(StatusCode::BAD_GATEWAY);
            res.body(
                json!({"error": {"message": format!("upstream request failed: {e}")}}).to_string(),
            );
            return;
        }
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
        prompt.push_str("Assistant: {\"name\":\"");
    } else {
        prompt.push_str("Assistant: ");
    }
    prompt
}

/// 取消息文本（兼容 string content 与数组 content 的 text 部分）。
fn message_text(msg: &Value) -> Option<String> {
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

fn inject_tools(prompt: &mut String, tools: &[Value]) {
    prompt.push_str("System: Tools:\n");
    for tool in tools {
        let name = tool
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("unknown");
        let params = tool
            .get("function")
            .and_then(|f| f.get("parameters"))
            .and_then(|p| p.get("properties"))
            .and_then(|p| p.as_object())
            .map(|props| {
                props
                    .iter()
                    .map(|(k, v)| {
                        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("any");
                        format!("{k}: {ty}")
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        prompt.push_str(&format!("- {name}({params})\n"));
    }
    prompt.push_str("Return only a JSON function call.\n\n");
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
fn try_extract_tool_call(text: &str) -> Option<(String, String)> {
    let text = text.trim();
    let json_str = if let Some(rest) = text.strip_prefix("```json") {
        rest.strip_suffix("```")?.trim()
    } else if let Some(start) = text.find("```json") {
        let rest = &text[start + 7..];
        let end = rest.find("```")?;
        rest[..end].trim()
    } else if text.starts_with('{') {
        text
    } else {
        return None;
    };

    let parsed: Value = serde_json::from_str(json_str).ok()?;
    let name = parsed.get("name")?.as_str()?.to_string();
    let arguments = parsed
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
    fn world_format_for_multi_turn_with_tools() {
        let messages = vec![
            json!({"role": "system", "content": "You are helpful"}),
            json!({"role": "user", "content": "Read the file"}),
        ];
        let tools = vec![json!({
            "type": "function",
            "function": {"name": "Read", "parameters": {"properties": {"file_path": {"type": "string"}}}}
        })];
        let prompt = openai_messages_to_rwkv_prompt(&messages, Some(&tools));
        assert!(prompt.contains("System: Tools:"));
        assert!(prompt.contains("- Read(file_path: string)"));
        assert!(prompt.ends_with("Assistant: {\"name\":\""));
    }

    #[test]
    fn extracts_tool_call_from_json_block() {
        let text = "让我先读文件。\n```json\n{\"name\":\"Read\",\"arguments\":{\"file_path\":\"src/main.rs\"}}\n```";
        let (name, args) = try_extract_tool_call(text).unwrap();
        assert_eq!(name, "Read");
        assert!(args.contains("src/main.rs"));
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
}
