//! 工具循环临时会话支撑：折叠器 + 轮次计量（纯函数，无状态）。
//!
//! 设计（2026-09-11 定稿）：RWKV 工具循环走「零状态 + 折叠转录全量 prefill」——
//! 每轮本地推理不传 session_id（引擎不写会话缓存，主会话状态零污染、零残留，
//! 隔离由构造保证）；历史中的已闭合工具段由本模块折叠为紧凑结论行。
//! 本地收敛出结论草稿后，由远端模型基于折叠历史合成终答
//!（编排见 ai_gateway::hybrid_tool_loop）。

use serde_json::{json, Value};

/// 折叠时工具参数最大字符数。
const ARGS_MAX_CHARS: usize = 80;
/// 折叠时单条工具结果最大字符数。
const RESULT_MAX_CHARS: usize = 300;
/// 折叠时段首 assistant 文本最大字符数。
const SEGMENT_TEXT_MAX_CHARS: usize = 120;

/// 混合工具循环总开关：`AI00X_TOOL_LOOP_LOCAL=0` 关闭回退旧路径；默认开。
pub fn tool_loop_local_enabled() -> bool {
    std::env::var("AI00X_TOOL_LOOP_LOCAL")
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}

/// 全本地闭环工具集（工具轮与终答都不出本地）：web 信息提取 / 长文总结。
/// 这些工具的「终答」只是转述工具已算好的结果，本地模型足以胜任。
pub const LOCAL_FINAL_TOOLS: &[&str] = &["ai00_web_extract", "ai00_text_summarize"];

/// 请求的 tools 是否全部在全本地闭环集合内。
pub fn tools_all_local_final(body: &Value) -> bool {
    body.get("tools")
        .and_then(|v| v.as_array())
        .map(|t| {
            !t.is_empty()
                && t.iter().all(|tool| {
                    tool.get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|n| n.as_str())
                        .map(|n| LOCAL_FINAL_TOOLS.contains(&n))
                        .unwrap_or(false)
                })
        })
        .unwrap_or(false)
}

/// 本地终答质量门（确定性启发式，零成本）。命中问题清单；空 Vec = 合格。
///
/// 覆盖 RWKV 本地已知失效模式：敷衍短答、数组复读循环、角色残渣（stop 未
/// 兜住）、JSON 残渣（想调工具但解析失败）、max_tokens 截断。
pub fn quality_gate(text: &str, hit_len: bool) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    let trimmed = text.trim();

    if trimmed.chars().count() < 20 {
        problems.push(format!("too_short({} chars)", trimmed.chars().count()));
    }

    // 复读检测：任一 24 字符滑窗出现 ≥3 次
    const WINDOW: usize = 24;
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() >= WINDOW * 2 {
        let mut counts = std::collections::HashMap::new();
        for w in chars.windows(WINDOW) {
            *counts.entry(w).or_insert(0usize) += 1;
        }
        if let Some(max) = counts.values().max() {
            if *max >= 3 {
                problems.push(format!("repetition(24-char window x{max})"));
            }
        }
    }

    for marker in ["\nUser:", "\nAssistant:", "\nSystem:", "\nInstruction:"] {
        if trimmed.contains(marker) {
            problems.push(format!("role_residue({})", marker.trim_start()));
            break;
        }
    }

    if trimmed.starts_with('{') || trimmed.starts_with("```json") {
        problems.push("json_residue".to_string());
    }

    if hit_len {
        let ends_sentence = trimmed
            .chars()
            .last()
            .map(|c| "。！？!?.…\"”』」)）】>`.;".contains(c))
            .unwrap_or(false);
        if !ends_sentence {
            problems.push("truncated(max_tokens mid-sentence)".to_string());
        }
    }

    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

/// 单回合工具循环熔断轮数（`AI00X_TOOL_LOOP_MAX_ROUNDS`，默认 6）。
pub fn tool_loop_max_rounds() -> usize {
    std::env::var("AI00X_TOOL_LOOP_MAX_ROUNDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6)
}

/// 当前回合已进行的工具轮数 = 最后一条 user 消息之后含 tool_calls 的
/// assistant 消息条数（无状态轮次计量，替代会话注册表）。
pub fn count_turn_rounds(messages: &[Value]) -> usize {
    let mut rounds = 0;
    for msg in messages.iter().rev() {
        match msg.get("role").and_then(|r| r.as_str()) {
            Some("user") => break,
            Some("assistant") if has_tool_calls(msg) => rounds += 1,
            _ => {}
        }
    }
    rounds
}

fn has_tool_calls(msg: &Value) -> bool {
    msg.get("tool_calls")
        .and_then(|t| t.as_array())
        .is_some_and(|t| !t.is_empty())
}

fn is_tool_msg(msg: &Value) -> bool {
    msg.get("role").and_then(|r| r.as_str()) == Some("tool")
}

/// 字符安全截断（按 chars，不按字节）。
fn truncate_chars(s: &str, max: usize) -> String {
    let mut chars = s.chars();
    let truncated: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

/// 折叠历史中的工具段。
///
/// 段 = assistant(含 tool_calls) + 紧随的若干 tool 消息。
/// `fold_active = false`：延伸到 messages 末尾的进行中段**原样保留**
/// （远端 llama-server 需要原始 tool 消息续接循环），其余已闭合段折叠为
/// 一条 assistant 文本消息；`fold_active = true`：全部折叠（终答合成用，
/// tools 已摘除，不再需要续接）。对已折叠输入幂等。
pub fn fold_tool_segments(messages: &[Value], fold_active: bool) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(messages.len());
    let mut i = 0;
    while i < messages.len() {
        let msg = &messages[i];
        let is_tc_assistant =
            msg.get("role").and_then(|r| r.as_str()) == Some("assistant") && has_tool_calls(msg);
        if !is_tc_assistant {
            out.push(msg.clone());
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < messages.len() && is_tool_msg(&messages[j]) {
            j += 1;
        }
        if j >= messages.len() && !fold_active {
            // 进行中段：原样保留并结束
            out.extend_from_slice(&messages[i..]);
            break;
        }
        out.push(fold_segment(&messages[i..j]));
        i = j;
    }
    out
}

/// 单段折叠为一条 assistant 文本消息：段首文本截断保留 +
/// `[工具] name({args…}) → 结果…` 每调用一行。
fn fold_segment(segment: &[Value]) -> Value {
    let mut lines: Vec<String> = Vec::new();
    let head = &segment[0];
    if let Some(text) = crate::ai_gateway::message_text(head) {
        let t = truncate_chars(text.trim(), SEGMENT_TEXT_MAX_CHARS);
        if !t.is_empty() {
            lines.push(t);
        }
    }
    let calls = head
        .get("tool_calls")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    let results: Vec<(Option<&str>, String)> = segment[1..]
        .iter()
        .map(|m| {
            (
                m.get("tool_call_id").and_then(|v| v.as_str()),
                crate::ai_gateway::message_text(m).unwrap_or_default(),
            )
        })
        .collect();
    for (idx, call) in calls.iter().enumerate() {
        let func = call.get("function").cloned().unwrap_or(Value::Null);
        let name = func
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("unknown");
        let args_raw = match func.get("arguments") {
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => "{}".to_string(),
        };
        // 优先按 tool_call_id 配对，失败按位置兜底
        let call_id = call.get("id").and_then(|v| v.as_str());
        let result = call_id
            .and_then(|id| results.iter().find(|(rid, _)| *rid == Some(id)))
            .or_else(|| results.get(idx));
        let result_text = result
            .map(|(_, c)| truncate_chars(c.trim(), RESULT_MAX_CHARS))
            .unwrap_or_else(|| "(no output)".to_string());
        lines.push(format!(
            "[工具] {}({}) → {}",
            name,
            truncate_chars(args_raw.trim(), ARGS_MAX_CHARS),
            result_text
        ));
    }
    json!({"role": "assistant", "content": lines.join("\n")})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str) -> Value {
        json!({"role": "user", "content": text})
    }

    fn assistant_text(text: &str) -> Value {
        json!({"role": "assistant", "content": text})
    }

    fn assistant_tc(id: &str, name: &str, args: &str) -> Value {
        json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": id,
                "type": "function",
                "function": {"name": name, "arguments": args},
            }],
        })
    }

    fn tool_result(id: &str, text: &str) -> Value {
        json!({"role": "tool", "tool_call_id": id, "content": text})
    }

    #[test]
    fn folds_closed_segment() {
        let msgs = vec![
            user("查待办"),
            assistant_tc("call_1", "ai00_todo_read", "{}"),
            tool_result("call_1", "3 条待办"),
            assistant_text("你有 3 条待办"),
            user("谢谢"),
        ];
        let folded = fold_tool_segments(&msgs, false);
        assert_eq!(folded.len(), 4);
        assert_eq!(folded[0], msgs[0]);
        // 段被折叠为单条 assistant 文本
        let note = folded[1].get("content").and_then(|c| c.as_str()).unwrap();
        assert!(note.contains("ai00_todo_read"));
        assert!(note.contains("3 条待办"));
        assert_eq!(folded[2], msgs[3]);
        assert_eq!(folded[3], msgs[4]);
    }

    #[test]
    fn keeps_active_tail_unless_fold_active() {
        let msgs = vec![
            user("查待办"),
            assistant_tc("call_1", "ai00_todo_read", "{}"),
            tool_result("call_1", "3 条待办"),
        ];
        // 进行中段：fold_active=false 原样保留
        let folded = fold_tool_segments(&msgs, false);
        assert_eq!(folded, msgs);
        // fold_active=true 全部折叠
        let folded_all = fold_tool_segments(&msgs, true);
        assert_eq!(folded_all.len(), 2);
        assert!(folded_all[1]
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap()
            .contains("ai00_todo_read"));
    }

    #[test]
    fn folds_multiple_segments() {
        let mut msgs = vec![user("开始")];
        for i in 0..2 {
            msgs.push(assistant_tc(&format!("call_{i}"), "ai00_notify", "{}"));
            msgs.push(tool_result(&format!("call_{i}"), "ok"));
            msgs.push(assistant_text("已处理"));
        }
        msgs.push(user("继续"));
        let folded = fold_tool_segments(&msgs, false);
        // user + (note + text) * 2 + user = 6
        assert_eq!(folded.len(), 6);
    }

    #[test]
    fn idempotent_on_folded_input() {
        let msgs = vec![
            user("查待办"),
            assistant_tc("call_1", "ai00_todo_read", "{}"),
            tool_result("call_1", "3 条待办"),
            assistant_text("你有 3 条待办"),
        ];
        let once = fold_tool_segments(&msgs, false);
        let twice = fold_tool_segments(&once, false);
        assert_eq!(once, twice);
    }

    #[test]
    fn truncates_long_result() {
        let long = "x".repeat(1000);
        let msgs = vec![
            user("查"),
            assistant_tc("call_1", "ai00_todo_read", "{}"),
            tool_result("call_1", &long),
            assistant_text("完"),
        ];
        let folded = fold_tool_segments(&msgs, false);
        let note = folded[1].get("content").and_then(|c| c.as_str()).unwrap();
        assert!(note.chars().count() < 600);
        assert!(note.contains('…'));
    }

    #[test]
    fn counts_turn_rounds() {
        let msgs = vec![
            user("任务"),
            assistant_tc("call_1", "a", "{}"),
            tool_result("call_1", "r1"),
            assistant_tc("call_2", "b", "{}"),
            tool_result("call_2", "r2"),
        ];
        assert_eq!(count_turn_rounds(&msgs), 2);
        // 上一回合的工具段不计入当前回合
        let msgs2 = vec![
            user("旧任务"),
            assistant_tc("call_0", "a", "{}"),
            tool_result("call_0", "r0"),
            assistant_text("完成"),
            user("新任务"),
            assistant_tc("call_1", "a", "{}"),
            tool_result("call_1", "r1"),
        ];
        assert_eq!(count_turn_rounds(&msgs2), 1);
        assert_eq!(count_turn_rounds(&[user("你好")]), 0);
    }

    #[test]
    fn leaves_plain_messages_untouched() {
        let msgs = vec![user("你好"), assistant_text("你好！")];
        assert_eq!(fold_tool_segments(&msgs, false), msgs);
        assert_eq!(fold_tool_segments(&msgs, true), msgs);
    }

    #[test]
    fn quality_gate_passes_normal_text() {
        let text = "已为你查到 3 条待办：写周报、复盘会议、回复邮件。其中最紧急的是写周报。";
        assert!(quality_gate(text, false).is_ok());
    }

    #[test]
    fn quality_gate_rejects_short_and_repetitive() {
        assert!(quality_gate("好的", false).is_err());
        let repeated = "已调用工具读取待办列表内容。".repeat(5);
        assert!(quality_gate(&repeated, false).is_err());
    }

    #[test]
    fn quality_gate_rejects_residues() {
        let role = "这是答复。\nUser: 再来一句";
        assert!(quality_gate(role, false).is_err());
        assert!(quality_gate("{\"name\":\"ai00_todo_read\"", false).is_err());
        assert!(quality_gate("```json\n{\"name\":1}", false).is_err());
    }

    #[test]
    fn quality_gate_truncation_only_when_hit_len() {
        let text = "这句话没有句读结尾但足够长可以通过长度检查";
        assert!(quality_gate(text, false).is_ok());
        assert!(quality_gate(text, true).is_err());
        let ended = format!("{}。", text);
        assert!(quality_gate(&ended, true).is_ok());
    }

    #[test]
    fn local_final_tools_gate() {
        let body = json!({
            "tools": [{"type":"function","function":{"name":"ai00_web_extract","parameters":{}}}]
        });
        assert!(tools_all_local_final(&body));
        let mixed = json!({
            "tools": [
                {"type":"function","function":{"name":"ai00_web_extract","parameters":{}}},
                {"type":"function","function":{"name":"ai00_todo_read","parameters":{}}}
            ]
        });
        assert!(!tools_all_local_final(&mixed));
        assert!(!tools_all_local_final(&json!({"tools": []})));
    }
}
