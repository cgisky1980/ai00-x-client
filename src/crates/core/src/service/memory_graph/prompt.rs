//! Context formatting utilities for memory relevance checking and extraction.

use super::types::{MemoryCategory, MemoryEntry};
use std::collections::{BTreeMap, HashMap, HashSet};

const RELEVANCE_CONTEXT_MAX_CHARS: usize = 8_000;
const RELEVANCE_CONTEXT_MAX_MESSAGES: usize = 12;
const RELEVANCE_BLOCK_MAX_CHARS: usize = 1_200;
const EXTRACTION_CONTEXT_MAX_CHARS: usize = 24_000;
const EXTRACTION_CONTEXT_MAX_MESSAGES: usize = 40;

pub const EMBEDDING_SIMILARITY_THRESHOLD: f32 = 0.4;
pub const EMBEDDING_MAX_HITS: usize = 30;
pub const MAX_MEMORIES_PER_TURN: usize = 5;

pub fn format_context_for_relevance(messages: &[crate::agent::core::Message]) -> String {
    let count = messages.len().min(RELEVANCE_CONTEXT_MAX_MESSAGES);
    let recent: Vec<_> = messages.iter().rev().take(count).collect();

    let mut chunks: Vec<String> = Vec::new();
    let mut total_chars = 0usize;

    for message in recent.iter().rev() {
        let chunk = format_message_relevance(message);
        if chunk.is_empty() {
            continue;
        }
        let chunk_len = chunk.chars().count();
        if total_chars + chunk_len > RELEVANCE_CONTEXT_MAX_CHARS {
            if total_chars == 0 {
                chunks.push(truncate_chars(&chunk, RELEVANCE_CONTEXT_MAX_CHARS));
            }
            break;
        }
        total_chars += chunk_len;
        chunks.push(chunk);
    }

    chunks.join("\n").trim().to_string()
}

pub fn format_context_for_extraction(messages: &[crate::agent::core::Message]) -> String {
    let count = messages.len().min(EXTRACTION_CONTEXT_MAX_MESSAGES);
    let recent: Vec<_> = messages.iter().rev().take(count).collect();

    let mut chunks: Vec<String> = Vec::new();
    let mut total_chars = 0usize;

    for message in recent.iter().rev() {
        let chunk = format_message_extraction(message);
        if chunk.is_empty() {
            continue;
        }
        let chunk_len = chunk.chars().count();
        if total_chars + chunk_len > EXTRACTION_CONTEXT_MAX_CHARS {
            if total_chars == 0 {
                chunks.push(truncate_chars(&chunk, EXTRACTION_CONTEXT_MAX_CHARS));
            }
            break;
        }
        total_chars += chunk_len;
        chunks.push(chunk);
    }

    chunks.join("\n").trim().to_string()
}

fn format_message_with_truncation(
    message: &crate::agent::core::Message,
    tool_result_max_chars: usize,
) -> String {
    let role = match message.role {
        crate::agent::core::MessageRole::User => "User",
        crate::agent::core::MessageRole::Assistant => "Assistant",
        crate::agent::core::MessageRole::System => "System",
        crate::agent::core::MessageRole::Tool => "Tool",
    };

    let content = match &message.content {
        crate::agent::core::MessageContent::Text(text) => {
            truncate_chars(text.trim(), RELEVANCE_BLOCK_MAX_CHARS)
        }
        crate::agent::core::MessageContent::Multimodal { text, .. } => {
            truncate_chars(text.trim(), RELEVANCE_BLOCK_MAX_CHARS)
        }
        crate::agent::core::MessageContent::Mixed {
            text, tool_calls, ..
        } => {
            let mut parts = Vec::new();
            if !text.is_empty() {
                parts.push(truncate_chars(text.trim(), RELEVANCE_BLOCK_MAX_CHARS / 2));
            }
            for tc in tool_calls {
                parts.push(format!("[ToolCall: {}]", tc.tool_name));
            }
            parts.join(" ")
        }
        crate::agent::core::MessageContent::ToolResult {
            ref result_for_assistant,
            ref tool_name,
            is_error,
            ..
        } => {
            let label = if *is_error { "Error" } else { "Result" };
            let preview = result_for_assistant.as_deref().unwrap_or("");
            format!(
                "[{}.{}: {}]",
                tool_name,
                label,
                truncate_chars(preview.trim(), tool_result_max_chars)
            )
        }
    };

    if content.is_empty() {
        String::new()
    } else {
        format!("{}:\n{}", role, content)
    }
}

fn format_message_relevance(message: &crate::agent::core::Message) -> String {
    format_message_with_truncation(message, 200)
}

fn format_message_extraction(message: &crate::agent::core::Message) -> String {
    format_message_with_truncation(message, 400)
}

// ==================== Prompt Formatting ====================

pub fn format_relevant_prompt(entries: &[MemoryEntry], limit: usize) -> Option<String> {
    format_entries_inner(entries, limit, false)
        .map(|formatted| format!("# Memory (auto-retrieved)\n\n{}", formatted))
}

pub fn format_relevant_display_prompt(entries: &[MemoryEntry], limit: usize) -> Option<String> {
    format_entries_inner(entries, limit, true)
        .map(|formatted| format!("# Memory (auto-retrieved)\n\n{}", formatted.trim()))
}

fn format_entries_inner(
    entries: &[MemoryEntry],
    limit: usize,
    include_metadata: bool,
) -> Option<String> {
    let mut sections: HashMap<MemoryCategory, Vec<&MemoryEntry>> = HashMap::new();

    for entry in selected_entries_for_prompt(entries, limit) {
        sections
            .entry(entry.category.clone())
            .or_default()
            .push(entry);
    }

    if sections.is_empty() {
        return None;
    }

    let mut output = String::new();
    let order = [
        MemoryCategory::Correction,
        MemoryCategory::Fact,
        MemoryCategory::Preference,
        MemoryCategory::Entity,
    ];

    let write_section = |output: &mut String, title: &str, items: Vec<&MemoryEntry>| {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&format!("## {}\n", title));
        for (idx, item) in items.into_iter().enumerate() {
            output.push_str(&format!("{}. {}\n", idx + 1, item.content.trim()));
            if include_metadata {
                output.push_str(&format!(
                    "<!-- updated_at: {} -->\n",
                    item.updated_at.to_rfc3339()
                ));
            }
        }
    };

    for cat in &order {
        if let Some(items) = sections.remove(cat) {
            let title = category_title(cat);
            write_section(&mut output, title, items);
        }
    }

    let mut custom_sections: BTreeMap<String, Vec<&MemoryEntry>> = BTreeMap::new();
    for (cat, items) in sections {
        custom_sections.insert(cat.to_string(), items);
    }
    for (name, items) in custom_sections {
        write_section(&mut output, &name, items);
    }

    if output.is_empty() {
        None
    } else {
        Some(output.trim().to_string())
    }
}

fn selected_entries_for_prompt(entries: &[MemoryEntry], limit: usize) -> Vec<&MemoryEntry> {
    let mut selected = Vec::new();
    let mut seen_content = HashSet::new();

    for entry in entries.iter().filter(|e| e.active) {
        if selected.len() >= limit {
            break;
        }
        let dedupe_key = entry
            .content
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if dedupe_key.is_empty() || !seen_content.insert(dedupe_key) {
            continue;
        }
        selected.push(entry);
    }
    selected
}

fn category_title(cat: &MemoryCategory) -> &str {
    match cat {
        MemoryCategory::Correction => "Corrections",
        MemoryCategory::Fact => "Facts",
        MemoryCategory::Preference => "Preferences",
        MemoryCategory::Entity => "Entities",
        MemoryCategory::Custom(_) => "Custom",
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_string()
    } else {
        value.chars().take(max_chars).collect()
    }
}
