use crate::client::AIClient;
use crate::client::StreamResponse;
use crate::stream::{UnifiedResponse, UnifiedTokenUsage, UnifiedToolCall};
use crate::types::{Message, ToolDefinition};
use anyhow::{anyhow, Result};
use log::debug;
use log::info;
use tokio::sync::mpsc;

use super::engine::get_rwkv_engine;

fn few_shot_for_tool(tool_name: &str) -> Option<&'static str> {
    match tool_name {
        "Read" => Some("User: Read the file src/main.rs\n\nAssistant: ```json\n{\"name\":\"Read\",\"arguments\":{\"file_path\":\"src/main.rs\"}}\n```"),
        "Write" => Some("User: Create a new file hello.py with print('hello')\n\nAssistant: ```json\n{\"name\":\"Write\",\"arguments\":{\"file_path\":\"hello.py\",\"content\":\"print('hello')\"}}\n```"),
        "Edit" => Some("User: Replace 'foo' with 'bar' in config.rs\n\nAssistant: ```json\n{\"name\":\"Edit\",\"arguments\":{\"file_path\":\"config.rs\",\"old_str\":\"foo\",\"new_str\":\"bar\"}}\n```"),
        "Bash" => Some("User: Run cargo build\n\nAssistant: ```json\n{\"name\":\"Bash\",\"arguments\":{\"command\":\"cargo build\"}}\n```"),
        "Grep" => Some("User: Find all Rust files containing \"UserService\"\n\nAssistant: ```json\n{\"name\":\"Grep\",\"arguments\":{\"pattern\":\"UserService\",\"path\":\"src/\"}}\n```"),
        "Glob" => Some("User: Find all TypeScript files in src/\n\nAssistant: ```json\n{\"name\":\"Glob\",\"arguments\":{\"pattern\":\"**/*.ts\",\"path\":\"src/\"}}\n```"),
        "LS" => Some("User: List files in the project root\n\nAssistant: ```json\n{\"name\":\"LS\",\"arguments\":{\"path\":\".\"}}\n```"),
        "WebSearch" => Some("User: Search for Rust async best practices\n\nAssistant: ```json\n{\"name\":\"WebSearch\",\"arguments\":{\"query\":\"Rust async best practices\"}}\n```"),
        "WebFetch" => Some("User: Fetch the content of https://example.com\n\nAssistant: ```json\n{\"name\":\"WebFetch\",\"arguments\":{\"url\":\"https://example.com\"}}\n```"),
        "Delete" => Some("User: Delete the file temp.log\n\nAssistant: ```json\n{\"name\":\"Delete\",\"arguments\":{\"file_paths\":[\"temp.log\"]}}\n```"),
        "Git" => Some("User: Show the git diff\n\nAssistant: ```json\n{\"name\":\"Git\",\"arguments\":{\"operation\":\"diff\"}}\n```"),
        _ => None,
    }
}

pub async fn send_stream(
    client: &AIClient,
    messages: Vec<Message>,
    tools: Option<Vec<ToolDefinition>>,
    _extra_body: Option<serde_json::Value>,
    _max_tries: usize,
) -> Result<StreamResponse> {
    let engine = get_rwkv_engine().ok_or_else(|| anyhow!("RWKV engine not registered"))?;

    if !engine.is_initialized() {
        return Err(anyhow!("RWKV engine not initialized"));
    }

    let prompt = messages_to_prompt(&messages, tools.as_deref());

    eprintln!("[TRACE] RWKV_SEND_STREAM prompt_len={}", prompt.len());
    info!("[RWKV] Prompt ({} chars):\n{}", prompt.len(), prompt);

    let input_tokens = estimate_prompt_tokens(&prompt);

    let temperature = client.config.temperature.unwrap_or(0.3) as f32;
    let top_p = client.config.top_p.unwrap_or(0.95) as f32;
    let max_tokens = client.config.max_tokens.unwrap_or(512) as usize;
    let stop = client
        .config
        .stop
        .clone()
        .unwrap_or_else(|| vec!["\n\nUser:".to_string(), "\n\nSystem:".to_string()]);

    let full_text = engine
        .infer(prompt, max_tokens, temperature, top_p, stop)
        .await
        .map_err(|e| anyhow!("RWKV engine error: {}", e))?;

    eprintln!("[TRACE] RWKV_INFER_COMPLETED text_len={}", full_text.len());

    info!(
        "[RWKV] Full output ({} chars):\n{}",
        full_text.len(),
        full_text
    );

    let output_tokens = estimate_prompt_tokens(&full_text);

    let (tx, rx) = mpsc::unbounded_channel();

    if let Some(tool_call) = try_extract_tool_call(&full_text) {
        debug!(
            "RWKV tool call extracted: name={:?}, id={:?}",
            tool_call.name, tool_call.id
        );
        let _ = tx.send(Ok(UnifiedResponse {
            tool_call: Some(tool_call),
            finish_reason: Some("tool_calls".to_string()),
            usage: Some(UnifiedTokenUsage {
                prompt_token_count: input_tokens as u32,
                candidates_token_count: output_tokens as u32,
                total_token_count: (input_tokens + output_tokens) as u32,
                reasoning_token_count: None,
                cached_content_token_count: None,
            }),
            ..Default::default()
        }));
    } else if !full_text.is_empty() {
        let _ = tx.send(Ok(UnifiedResponse {
            text: Some(full_text),
            ..Default::default()
        }));
    }

    let _ = tx.send(Ok(UnifiedResponse {
        finish_reason: Some("stop".to_string()),
        usage: Some(UnifiedTokenUsage {
            prompt_token_count: input_tokens as u32,
            candidates_token_count: output_tokens as u32,
            total_token_count: (input_tokens + output_tokens) as u32,
            reasoning_token_count: None,
            cached_content_token_count: None,
        }),
        ..Default::default()
    }));

    Ok(StreamResponse {
        stream: Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(rx)),
        raw_sse_rx: None,
    })
}

fn try_extract_tool_call(text: &str) -> Option<UnifiedToolCall> {
    let text = text.trim();

    let json_str = if let Some(rest) = text.strip_prefix("```json") {
        let inner = rest.trim_start().split("```").next()?.trim();
        inner
    } else if text.starts_with('{') {
        let end = text.rfind('}').map(|i| i + 1)?;
        &text[..end]
    } else if let Some(pos) = text.find("{\"name\"") {
        let slice = &text[pos..];
        let json_end = find_matching_json_end(slice)?;
        &text[pos..pos + json_end]
    } else if let Some(pos) = text.find("```json") {
        let after = &text[pos + "```json".len()..].trim_start();
        after.split("```").next()?.trim()
    } else {
        return None;
    };

    let value: serde_json::Value = serde_json::from_str(json_str).ok()?;
    if !value.is_object() {
        return None;
    }

    let name = value.get("name")?.as_str()?.to_string();
    let arguments_value = value.get("arguments")?;
    if !arguments_value.is_object() {
        return None;
    }
    let arguments = arguments_value.to_string();

    Some(UnifiedToolCall {
        id: Some(uuid::Uuid::new_v4().to_string()),
        name: Some(name),
        arguments: Some(arguments),
        arguments_is_snapshot: true,
    })
}

fn find_matching_json_end(json_start: &str) -> Option<usize> {
    let mut depth = 0;
    for (i, ch) in json_start.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

fn messages_to_prompt(messages: &[Message], tools: Option<&[ToolDefinition]>) -> String {
    let mut prompt = String::new();
    let mut tools_injected = false;

    for msg in messages {
        match msg.role.as_str() {
            "system" => {
                if let Some(content) = &msg.content {
                    prompt.push_str(&format!("System: {}\n\n", sanitize_rwkv_content(content)));
                }
            }
            "user" => {
                if !tools_injected {
                    if let Some(tool_defs) = tools {
                        inject_tools(&mut prompt, tool_defs);
                    }
                    tools_injected = true;
                }
                if let Some(content) = &msg.content {
                    prompt.push_str(&format!("User: {}\n\n", sanitize_rwkv_content(content)));
                }
            }
            "assistant" => {
                if let Some(tool_calls) = &msg.tool_calls {
                    for tc in tool_calls {
                        let value = serde_json::json!({
                            "name": tc.name,
                            "arguments": tc.arguments,
                        });
                        prompt.push_str(&format!("Assistant: ```json\n{}\n```\n\n", value));
                    }
                } else if let Some(content) = &msg.content {
                    prompt.push_str(&format!(
                        "Assistant: {}\n\n",
                        sanitize_rwkv_content(content)
                    ));
                }
            }
            "tool" => {
                if let Some(content) = &msg.content {
                    prompt.push_str(&format!(
                        "User: Function output:\n{}\n\n",
                        sanitize_rwkv_content(content)
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

    let has_tools = tools.is_some_and(|t| !t.is_empty());

    let last_is_assistant = messages
        .last()
        .is_some_and(|m| m.role == "assistant" && m.content.is_some());

    if last_is_assistant {
        // assistant prefill already appended in the loop, do not add another "Assistant: "
    } else if has_tools {
        prompt.push_str("Assistant: {\"name\":\"");
    } else {
        prompt.push_str("Assistant: ");
    }
    prompt
}

fn inject_tools(prompt: &mut String, tools: &[ToolDefinition]) {
    prompt.push_str("System: Tools:\n");
    for tool in tools {
        let params_str = format_params(tool);
        prompt.push_str(&format!("- {}({})\n", tool.name, params_str));
    }
    prompt.push_str("Return only a JSON function call.\n\n");
    for tool in tools {
        if let Some(example) = few_shot_for_tool(&tool.name) {
            prompt.push_str(example);
            prompt.push_str("\n\n");
        }
    }
}

fn sanitize_rwkv_content(content: &str) -> String {
    let s = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut result = String::with_capacity(s.len());
    let mut prev_was_newline = false;
    for ch in s.chars() {
        if ch == '\n' {
            if !prev_was_newline {
                result.push('\n');
            }
            prev_was_newline = true;
        } else {
            result.push(ch);
            prev_was_newline = false;
        }
    }
    let trimmed = result.trim_end_matches('\n');
    trimmed.to_string()
}

fn format_params(tool: &ToolDefinition) -> String {
    if let Some(properties) = tool.parameters.get("properties") {
        if let Some(obj) = properties.as_object() {
            let params: Vec<String> = obj
                .iter()
                .map(|(k, v)| {
                    let type_str = v.get("type").and_then(|t| t.as_str()).unwrap_or("any");
                    format!("{}: {}", k, type_str)
                })
                .collect();
            return params.join(", ");
        }
    }
    String::new()
}

fn estimate_prompt_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let mut count: f32 = 0.0;
    for c in text.chars() {
        if c.is_ascii() {
            count += 0.3;
        } else {
            count += 0.6;
        }
    }
    count as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_json_after_chinese_text() {
        let text = "让我先搜索一下。\n```json\n{\"name\":\"WebSearch\",\"arguments\":{\"query\":\"gold price\"}}\n```";
        let result = try_extract_tool_call(text);
        assert!(result.is_some());
        let tc = result.unwrap();
        assert_eq!(tc.name, Some("WebSearch".to_string()));
        assert_eq!(tc.arguments, Some("{\"query\":\"gold price\"}".to_string()));
    }

    #[test]
    fn extracts_inline_json_after_chinese() {
        let text = "好的，我来搜索。{\"name\":\"Grep\",\"arguments\":{\"pattern\":\"test\"}}";
        let result = try_extract_tool_call(text);
        assert!(result.is_some());
        let tc = result.unwrap();
        assert_eq!(tc.name, Some("Grep".to_string()));
    }

    #[test]
    fn extracts_json_at_start() {
        let text = "{\"name\":\"Read\",\"arguments\":{\"file_path\":\"src/main.rs\"}}";
        let result = try_extract_tool_call(text);
        assert!(result.is_some());
        let tc = result.unwrap();
        assert_eq!(tc.name, Some("Read".to_string()));
    }

    #[test]
    fn extracts_markdown_json_block() {
        let text = "```json\n{\"name\":\"Bash\",\"arguments\":{\"command\":\"echo hello\"}}\n```";
        let result = try_extract_tool_call(text);
        assert!(result.is_some());
        let tc = result.unwrap();
        assert_eq!(tc.name, Some("Bash".to_string()));
    }

    #[test]
    fn returns_none_for_plain_text() {
        let text = "这是普通回复，没有工具调用。";
        let result = try_extract_tool_call(text);
        assert!(result.is_none());
    }

    #[test]
    fn returns_none_for_incomplete_json() {
        let text = "让我搜索。{\"name\":\"WebSearch\",\"arguments\":{\"query\":\"test\"";
        let result = try_extract_tool_call(text);
        assert!(result.is_none());
    }

    #[test]
    fn find_matching_brace_simple() {
        assert_eq!(find_matching_json_end("{\"a\":1}"), Some(7));
    }

    #[test]
    fn find_matching_brace_nested() {
        assert_eq!(find_matching_json_end("{\"a\":{\"b\":2}}"), Some(13));
    }

    #[test]
    fn prompt_ends_with_json_guide_when_tools_present() {
        let msgs = vec![Message {
            role: "user".to_string(),
            content: Some("hello".to_string()),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            tool_image_attachments: None,
            is_error: Some(false),
        }];
        let tools = vec![ToolDefinition {
            name: "WebSearch".to_string(),
            description: "search".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {"query": {"type": "string"}}
            }),
        }];
        let prompt = messages_to_prompt(&msgs, Some(&tools));
        assert!(
            prompt.ends_with("Assistant: {\"name\":\""),
            "Expected prompt to end with JSON guide, got: {:?}",
            &prompt[prompt.len().saturating_sub(50)..]
        );
    }

    #[test]
    fn prompt_ends_with_plain_assistant_when_no_tools() {
        let msgs = vec![Message {
            role: "user".to_string(),
            content: Some("hello".to_string()),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            tool_image_attachments: None,
            is_error: Some(false),
        }];
        let prompt = messages_to_prompt(&msgs, None::<&[ToolDefinition]>);
        assert!(prompt.ends_with("Assistant: "));
        assert!(!prompt.ends_with("```json\n"));
    }
}
