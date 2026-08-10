//! Memory sidecar implementation using RWKV for lightweight relevance verification
//! and memory extraction. Uses rwkv_infer_sync — web-rwkv supports concurrent inference
//! (GPU multi-stream), so sidecar calls can run in parallel with the main conversation.

use ai00_x_core::service::memory_graph::sidecar::{
    ExtractedMemory, MemorySidecar, RelevanceResult,
};

/// Max chars of context to feed into relevance check prompt (RWKV context ~4096 tokens).
const RELEVANCE_CONTEXT_MAX_CHARS: usize = 1200;

/// Max chars of memory content in relevance/contradiction check prompts.
const RELEVANCE_MEMORY_MAX_CHARS: usize = 500;

/// Max chars of transcript to feed into extraction prompt.
const EXTRACTION_TRANSCRIPT_MAX_CHARS: usize = 2500;

/// Ratio of tail content preserved when truncating conversation context.
/// 0.6 means 40% head + 60% tail — both ends matter for relevance judgment.
const TAIL_RATIO: f32 = 0.6;

/// Sentence/paragraph terminators for truncation boundary detection.
fn is_sentence_boundary(ch: char) -> bool {
    matches!(
        ch,
        '.' | '!' | '?' | '\n' | '。' | '！' | '？' | '…' | '）' | '」'
    )
}

/// Truncate text to at most `max_chars` chars, breaking at the last sentence
/// or paragraph boundary. Returns a slice of the original text (zero-allocation).
fn truncate_to_chars(text: &str, max_chars: usize) -> &str {
    if text.len() <= max_chars && text.chars().count() <= max_chars {
        return text;
    }
    // Count chars (not bytes) until max_chars
    let mut byte_end = 0;
    for (char_count, (i, _)) in text.char_indices().enumerate() {
        if char_count >= max_chars {
            byte_end = i;
            break;
        }
        byte_end = i + text[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(0);
    }
    if byte_end == 0 || byte_end >= text.len() {
        return text;
    }
    // Walk back to last sentence boundary within limit
    let slice = &text[..byte_end];
    if let Some(pos) = slice.rfind(is_sentence_boundary) {
        let len = pos + 1; // include the boundary char
        return &text[..len];
    }
    // No boundary found — fall back to last space or hard cut
    slice.rfind(' ').map(|p| &text[..p]).unwrap_or(slice)
}

/// Truncate conversation context with tail priority.
/// Keeps `(1-TAIL_RATIO)` of head chars and `TAIL_RATIO` of tail chars,
/// joining with "…" separator. Each part uses sentence-boundary truncation.
fn truncate_context_with_tail(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }

    let head_chars = ((1.0 - TAIL_RATIO) * max_chars as f32) as usize;
    let tail_chars = max_chars - head_chars;

    if head_chars == 0 || tail_chars == 0 {
        return truncate_to_chars(text, max_chars).to_string();
    }

    let text_len = text.chars().count();
    // Take head portion
    let head = truncate_to_chars(text, head_chars);

    // Take tail portion: find the starting point for the last tail_chars chars
    let tail_start_bytes = tail_start(text, tail_chars);
    let tail = &text[tail_start_bytes..];

    // Don't double-count overlap
    if text_len <= head.len() + tail.len() {
        return text.to_string();
    }

    let mut result = String::with_capacity(head.len() + tail.len() + 3);
    result.push_str(head);
    result.push_str("\n…\n");
    result.push_str(tail);
    result
}

/// Find the byte offset to start cutting for the last N chars.
fn tail_start(text: &str, tail_chars: usize) -> usize {
    let total_chars = text.chars().count();
    if total_chars <= tail_chars {
        return 0;
    }
    let skip_chars = total_chars - tail_chars;
    for (chars_seen, (i, _)) in text.char_indices().enumerate() {
        if chars_seen >= skip_chars {
            // Walk forward to next sentence boundary for clean cut
            if let Some(offset) = text[i..].find(is_sentence_boundary) {
                return (i + offset + 1).min(text.len());
            }
            return i;
        }
    }
    text.len()
}

struct RwkvMemorySidecar;

impl RwkvMemorySidecar {
    async fn infer(
        &self,
        prompt: &str,
        max_tokens: usize,
    ) -> Result<(String, usize, usize), String> {
        let result = crate::rwkv_llm::rwkv_infer_sync(prompt, max_tokens).await?;
        if let Some(svc) = ai00_x_core::service::token_usage::get_global_token_usage_service() {
            let _ = svc
                .record_usage(
                    "rwkv-local".to_string(),
                    "rwkv-memory-sidecar".to_string(),
                    format!("sidecar-{}", chrono::Utc::now().timestamp_millis()),
                    result.1 as u32,
                    result.2 as u32,
                    0,
                    true,
                )
                .await;
        }
        Ok(result)
    }
}

#[async_trait::async_trait]
impl MemorySidecar for RwkvMemorySidecar {
    async fn check_relevance(
        &self,
        memory_content: &str,
        context: &str,
    ) -> Result<RelevanceResult, String> {
        let memory_snippet = truncate_to_chars(memory_content, RELEVANCE_MEMORY_MAX_CHARS);
        let context_snippet = truncate_context_with_tail(context, RELEVANCE_CONTEXT_MAX_CHARS);

        let prompt = format!(
            "You are a memory relevance checker. Given a memory and a conversation context, answer only \"yes\" or \"no\".\n\
             Memory: {}\n\
             Context:\n{}\n\
             Is this memory relevant to the conversation? Answer only yes or no.",
            memory_snippet, context_snippet
        );

        let (text, input_tokens, output_tokens) = self.infer(&prompt, 12).await?;
        log::debug!(
            "[MemorySidecar] check_relevance tokens: input={}, output={}",
            input_tokens,
            output_tokens
        );
        let lower = text.trim().to_lowercase();
        Ok(RelevanceResult {
            relevant: lower.contains("yes") && !lower.contains("no"),
            reason: text.trim().to_string(),
        })
    }

    async fn extract_memories(
        &self,
        transcript: &str,
        existing_memories: &[String],
    ) -> Result<Vec<ExtractedMemory>, String> {
        let existing_ctx = if existing_memories.is_empty() {
            String::new()
        } else {
            let items: Vec<_> = existing_memories.iter().take(20).cloned().collect();
            format!(
                "Existing memories (avoid duplicates):\n{}\n",
                items
                    .iter()
                    .enumerate()
                    .map(|(i, m)| format!("{}. {}", i + 1, m))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };

        let transcript_snippet =
            truncate_context_with_tail(transcript, EXTRACTION_TRANSCRIPT_MAX_CHARS);

        let prompt = format!(
            "You are a memory extraction assistant. Extract key facts, preferences, corrections, \
             and entities from this conversation transcript.\n\
             For each finding, output a JSON object with these fields:\n\
             - \"category\": one of \"fact\", \"preference\", \"correction\", \"entity\"\n\
             - \"content\": the extracted information (1-2 sentences)\n\
             - \"trust\": \"high\" (explicitly stated), \"medium\" (observed), or \"low\" (inferred)\n\
             {}\
             Conversation transcript:\n{}\n\
             Output only a JSON array of the extracted memories. Do not include any other text.",
            existing_ctx, transcript_snippet
        );

        let (text, input_tokens, output_tokens) = self.infer(&prompt, 384).await?;
        log::debug!(
            "[MemorySidecar] extract_memories tokens: input={}, output={}",
            input_tokens,
            output_tokens
        );
        parse_extracted_memories(&text)
    }

    async fn check_contradiction(
        &self,
        new_content: &str,
        existing_content: &str,
    ) -> Result<bool, String> {
        let prompt = format!(
            "You are a contradiction checker. Given two statements, answer only \"yes\" or \"no\".\n\
             Statement A: {}\n\
             Statement B: {}\n\
             Do these two statements contradict each other? Answer only yes or no.",
            truncate_to_chars(new_content, RELEVANCE_MEMORY_MAX_CHARS),
            truncate_to_chars(existing_content, RELEVANCE_MEMORY_MAX_CHARS),
        );

        let (text, input_tokens, output_tokens) = self.infer(&prompt, 12).await?;
        log::debug!(
            "[MemorySidecar] check_contradiction tokens: input={}, output={}",
            input_tokens,
            output_tokens
        );
        let lower = text.trim().to_lowercase();
        Ok(lower.contains("yes") && !lower.contains("no"))
    }
}

fn parse_extracted_memories(text: &str) -> Result<Vec<ExtractedMemory>, String> {
    let trimmed = text.trim();

    let json_str = if let (Some(start), Some(end)) = (trimmed.find('['), trimmed.rfind(']')) {
        &trimmed[start..=end]
    } else {
        return Ok(Vec::new());
    };

    let value: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("JSON parse: {}", e))?;

    let arr = match value {
        serde_json::Value::Array(a) => a,
        _ => return Ok(Vec::new()),
    };

    let mut memories = Vec::new();
    for item in arr {
        let category = item
            .get("category")
            .and_then(|v| v.as_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_else(|| "fact".to_string());
        let content = item.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let trust = item
            .get("trust")
            .and_then(|v| v.as_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_else(|| "medium".to_string());

        if !content.is_empty() {
            memories.push(ExtractedMemory {
                category,
                content: content.to_string(),
                trust,
            });
        }
    }

    Ok(memories)
}

pub fn init_memory_sidecar() {
    ai00_x_core::service::memory_graph::sidecar::set_memory_sidecar(Box::new(RwkvMemorySidecar));
    log::info!("[MemorySidecar] Initialized");
}
