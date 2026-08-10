//! Microcompact: lightweight pre-compression that clears old tool results.
//!
//! Before the heavier full-context compression kicks in, microcompact replaces
//! the content of old, compactable tool results with a short structured summary.
//! This frees significant tokens (tool output is often the largest part of context)
//! while preserving a concise record of what happened so the model retains key
//! context without the verbatim output.

use crate::agent::core::{Message, MessageContent};
use log::{debug, info};
use std::collections::HashSet;

/// Generate a concise structured summary for a compacted tool result.
/// Preserves key context (what was done, what the outcome was) in a single line.
fn summarize_tool_result(tool_name: &str, args: &serde_json::Value, result_text: &str) -> String {
    let result_len = result_text.len();
    let result_chars = if result_len > 0 {
        format!(" ({} chars)", result_len)
    } else {
        String::new()
    };

    match tool_name {
        "Read" => {
            if let Some(path) = args.get("file_path").and_then(|v| v.as_str()) {
                let basename = path.rsplit(&['/', '\\']).next().unwrap_or(path);
                format!("[Read] {} {}{}", basename, result_len, {
                    if result_len >= 1000 {
                        format!(" [{:.1}K chars]", result_len as f32 / 1000.0)
                    } else {
                        result_chars
                    }
                })
            } else {
                format!("[Read] file{}", result_chars)
            }
        }
        "Write" => {
            if let Some(path) = args.get("file_path").and_then(|v| v.as_str()) {
                let basename = path.rsplit(&['/', '\\']).next().unwrap_or(path);
                format!("[Write] wrote {}", basename)
            } else {
                "[Write] file".to_string()
            }
        }
        "Edit" => {
            if let Some(path) = args.get("file_path").and_then(|v| v.as_str()) {
                let basename = path.rsplit(&['/', '\\']).next().unwrap_or(path);
                format!("[Edit] edited {}", basename)
            } else {
                "[Edit] file".to_string()
            }
        }
        "Bash" => {
            let cmd = result_text
                .lines()
                .next()
                .unwrap_or("command")
                .chars()
                .take(80)
                .collect::<String>();
            let lines = result_text.lines().count();
            format!("[Bash] ran '{}' -> {} lines output", cmd, lines)
        }
        "Grep" => {
            let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("?");
            let matches = result_text.lines().count();
            format!("[Grep] '{}' -> {} matches", pattern, matches)
        }
        "Glob" => {
            let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("?");
            let count = result_text.lines().count();
            format!("[Glob] '{}' -> {} files", pattern, count)
        }
        "WebSearch" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("?");
            format!("[WebSearch] '{}'", query)
        }
        "WebFetch" => {
            if let Some(url) = args.get("url").and_then(|v| v.as_str()) {
                let host = url
                    .split("://")
                    .nth(1)
                    .unwrap_or(url)
                    .split('/')
                    .next()
                    .unwrap_or(url);
                format!("[WebFetch] {} {}", host, result_chars)
            } else {
                format!("[WebFetch] url{}", result_chars)
            }
        }
        "LS" => {
            if let Some(path) = args.get("path").and_then(|v| v.as_str()) {
                let entries = result_text.lines().count();
                format!("[LS] {} -> {} entries", path, entries)
            } else {
                "[LS] directory".to_string()
            }
        }
        "Git" => {
            let cmd = result_text
                .lines()
                .next()
                .unwrap_or("git")
                .chars()
                .take(60)
                .collect::<String>();
            format!("[Git] {}", cmd)
        }
        _ => {
            format!("[{}] {}", tool_name, result_chars)
        }
    }
}

/// Tools whose results can be safely cleared after they become stale.
/// These are read/search/write tools whose output is transient context.
fn default_compactable_tools() -> HashSet<&'static str> {
    [
        "Read",
        "Bash",
        "Grep",
        "Glob",
        "WebSearch",
        "WebFetch",
        "Edit",
        "Write",
        "LS",
        "Delete",
        "Git",
        "GetFileDiff",
    ]
    .into_iter()
    .collect()
}

/// Configuration for microcompact behaviour.
pub struct MicrocompactConfig {
    /// Number of most-recent compactable tool results to keep intact.
    pub keep_recent: usize,
    /// Minimum token-usage ratio before microcompact activates.
    pub trigger_ratio: f32,
}

impl Default for MicrocompactConfig {
    fn default() -> Self {
        Self {
            keep_recent: 8,
            trigger_ratio: 0.5,
        }
    }
}

/// Statistics returned after a microcompact pass.
#[derive(Debug, Clone)]
pub struct MicrocompactResult {
    pub tools_cleared: usize,
    pub tools_kept: usize,
}

/// Run microcompact on the message list **in place**.
///
/// Returns `None` if no clearing was performed (e.g. not enough compactable
/// results, or all are within the keep window).
pub fn microcompact_messages(
    messages: &mut [Message],
    config: &MicrocompactConfig,
) -> Option<MicrocompactResult> {
    let compactable = default_compactable_tools();

    // Collect indices of compactable tool-result messages (in encounter order).
    let compactable_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(idx, msg)| {
            if let MessageContent::ToolResult { ref tool_name, .. } = msg.content {
                if compactable.contains(tool_name.as_str()) {
                    return Some(idx);
                }
            }
            None
        })
        .collect();

    if compactable_indices.len() <= config.keep_recent {
        return None;
    }

    // Keep the last `keep_recent` intact; clear everything before that.
    let keep_start = compactable_indices.len() - config.keep_recent;
    let to_clear = &compactable_indices[..keep_start];

    if to_clear.is_empty() {
        return None;
    }

    let mut cleared = 0usize;
    for &idx in to_clear {
        let msg = &mut messages[idx];
        if let MessageContent::ToolResult {
            ref tool_name,
            ref result,
            ref mut result_for_assistant,
            ref mut image_attachments,
            ..
        } = msg.content
        {
            if result_for_assistant
                .as_deref()
                .map(|s| s.starts_with('['))
                .unwrap_or(false)
            {
                continue;
            }
            let old_text = result_for_assistant.as_deref().unwrap_or("");
            let summary = summarize_tool_result(tool_name, result, old_text);
            *result_for_assistant = Some(summary);
            *image_attachments = None;
            msg.metadata.tokens = None;
            cleared += 1;
        }
    }

    if cleared == 0 {
        return None;
    }

    let kept = compactable_indices.len() - cleared;
    info!(
        "Microcompact: cleared {} tool result(s), kept {} recent",
        cleared, kept
    );
    debug!(
        "Microcompact details: total_compactable={}, keep_recent={}, cleared={}",
        compactable_indices.len(),
        config.keep_recent,
        cleared
    );

    Some(MicrocompactResult {
        tools_cleared: cleared,
        tools_kept: kept,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::core::{Message, ToolResult};

    fn make_tool_result(tool_name: &str, content: &str) -> Message {
        Message::tool_result(ToolResult {
            tool_id: format!("id_{}", tool_name),
            tool_name: tool_name.to_string(),
            result: serde_json::json!(content),
            result_for_assistant: Some(content.to_string()),
            is_error: false,
            duration_ms: None,
            image_attachments: None,
        })
    }

    #[test]
    fn clears_old_compactable_results() {
        let mut messages = vec![
            Message::user("hello".to_string()),
            Message::assistant("ok".to_string()),
            make_tool_result("Read", "file content 1"),
            make_tool_result("Read", "file content 2"),
            make_tool_result("Grep", "grep output"),
            make_tool_result("Read", "file content 3"),
        ];

        let config = MicrocompactConfig {
            keep_recent: 2,
            trigger_ratio: 0.0,
        };

        let result = microcompact_messages(&mut messages, &config);
        assert!(result.is_some());
        let stats = result.unwrap();
        assert_eq!(stats.tools_cleared, 2);
        assert_eq!(stats.tools_kept, 2);

        // First two tool results should be summarized
        if let MessageContent::ToolResult {
            ref result_for_assistant,
            ..
        } = messages[2].content
        {
            let text = result_for_assistant.as_deref().unwrap();
            assert!(
                text.starts_with("[Read]"),
                "expected summary prefix, got: {}",
                text
            );
        } else {
            panic!("expected ToolResult");
        }

        // Last two should be intact
        if let MessageContent::ToolResult {
            ref result_for_assistant,
            ..
        } = messages[5].content
        {
            assert!(
                !result_for_assistant
                    .as_deref()
                    .map(|s| s.starts_with('['))
                    .unwrap_or(false),
                "most recent results should not be summarized"
            );
        } else {
            panic!("expected ToolResult");
        }
    }

    #[test]
    fn skips_non_compactable_tools() {
        let mut messages = vec![
            make_tool_result("TodoWrite", "todo data"),
            make_tool_result("Read", "file content"),
        ];

        let config = MicrocompactConfig {
            keep_recent: 1,
            trigger_ratio: 0.0,
        };

        let result = microcompact_messages(&mut messages, &config);
        assert!(result.is_none());
    }

    #[test]
    fn no_op_when_within_keep_window() {
        let mut messages = vec![make_tool_result("Read", "a"), make_tool_result("Grep", "b")];

        let config = MicrocompactConfig {
            keep_recent: 5,
            trigger_ratio: 0.0,
        };

        let result = microcompact_messages(&mut messages, &config);
        assert!(result.is_none());
    }

    #[test]
    fn idempotent_on_already_cleared() {
        let mut messages = vec![
            make_tool_result("Read", "content 1"),
            make_tool_result("Read", "content 2"),
            make_tool_result("Read", "content 3"),
        ];

        let config = MicrocompactConfig {
            keep_recent: 1,
            trigger_ratio: 0.0,
        };

        let r1 = microcompact_messages(&mut messages, &config);
        assert_eq!(r1.unwrap().tools_cleared, 2);

        // Second pass should be a no-op
        let r2 = microcompact_messages(&mut messages, &config);
        assert!(r2.is_none());
    }
}
