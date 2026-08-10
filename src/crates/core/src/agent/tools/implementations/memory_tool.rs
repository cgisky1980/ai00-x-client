//! Memory tool for storing and recalling information across sessions

use super::super::framework::{Tool, ToolResult, ToolUseContext};
use crate::service::memory_graph;
use crate::util::errors::Ai00XResult;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

pub struct MemoryTool;

impl MemoryTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MemoryTool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Deserialize)]
struct MemoryInput {
    action: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    #[allow(dead_code)]
    scope: Option<String>,
    #[serde(default)]
    from_id: Option<String>,
    #[serde(default)]
    to_id: Option<String>,
    #[serde(default)]
    weight: Option<f32>,
    #[serde(default)]
    depth: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    mode: Option<String>,
}

#[async_trait]
impl Tool for MemoryTool {
    fn name(&self) -> &str {
        "memory"
    }

    async fn description(&self) -> Ai00XResult<String> {
        Ok(
            "Manage persistent memory. Use 'remember' to store facts/preferences/corrections, \
             'recall' to retrieve relevant memories (supports recent/semantic/cascade modes), \
             'search' for keyword search, 'list' to show all, 'forget' to remove, \
             'tag' to add tags, 'link' to create relationships, and 'related' to find \
             graph-connected memories."
                .to_string(),
        )
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["remember", "recall", "search", "list", "forget", "tag", "link", "related"],
                    "description": "Action to perform."
                },
                "content": { "type": "string", "description": "Memory content (for remember)." },
                "category": {
                    "type": "string",
                    "enum": ["fact", "preference", "entity", "correction"],
                    "description": "Memory category."
                },
                "query": { "type": "string", "description": "Search query (for recall/search)." },
                "id": { "type": "string", "description": "Memory ID (for forget/tag/link/related)." },
                "tags": { "type": "array", "items": { "type": "string" } },
                "scope": { "type": "string", "enum": ["project", "global", "all"] },
                "from_id": { "type": "string", "description": "Source memory ID for link." },
                "to_id": { "type": "string", "description": "Target memory ID for link." },
                "weight": { "type": "number", "description": "Link weight (0-1)." },
                "depth": { "type": "integer", "description": "Traversal depth for related search." },
                "limit": { "type": "integer", "description": "Max results." },
                "mode": { "type": "string", "enum": ["recent", "semantic", "cascade"], "description": "Retrieval mode for recall." }
            },
            "required": ["action"]
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        let parsed: MemoryInput = serde_json::from_value(input.clone())
            .map_err(|e| crate::util::errors::Ai00XError::tool(format!("Invalid input: {}", e)))?;

        let manager = memory_graph::manager::MemoryManager::global()
            .await
            .map_err(|e| {
                crate::util::errors::Ai00XError::service(format!(
                    "Failed to get MemoryManager: {}",
                    e
                ))
            })?;

        let result = match parsed.action.as_str() {
            "remember" => {
                let content = match parsed.content {
                    Some(c) if !c.trim().is_empty() => c,
                    Some(_) => {
                        return Err(crate::util::errors::Ai00XError::tool(
                            "content must not be empty",
                        ))
                    }
                    None => {
                        return Err(crate::util::errors::Ai00XError::tool(
                            "content required for remember action",
                        ))
                    }
                };
                let category: memory_graph::MemoryCategory = parsed
                    .category
                    .as_deref()
                    .unwrap_or("fact")
                    .parse()
                    .unwrap_or_default();
                let mut entry = memory_graph::MemoryEntry::new(category, &content);
                if let Some(ref sid) = context.session_id {
                    entry = entry.with_source(sid);
                }
                if let Some(tags) = parsed.tags {
                    entry = entry.with_tags(tags);
                }
                // Generate embedding for dedup (manager.remember uses embedding for duplicate check)
                if let Some(provider) =
                    crate::agent::tools::implementations::skills::embedding_provider::get_embedding_provider()
                {
                    let content_clone = content.clone();
                    if let Ok(emb) = tokio::task::spawn_blocking(move || {
                        provider.embed_text(&content_clone)
                    })
                    .await
                    .unwrap_or(Err("spawn failed".to_string()))
                    {
                        entry = entry.with_embedding(emb);
                    }
                }
                let id = manager.remember(entry).await.map_err(|e| {
                    crate::util::errors::Ai00XError::tool(format!("Failed to store: {}", e))
                })?;
                format!("Remembered: {} [{}]", content, id)
            }
            "recall" => {
                let limit = parsed.limit.unwrap_or(10);
                let mode = parsed.mode.as_deref().unwrap_or("recent");

                match mode {
                    "recent" => match manager.get_relevant_for_prompt(limit).await {
                        Some(memories) => format!("Recent memories:\n{}", memories),
                        None => "No memories stored yet.".to_string(),
                    },
                    "semantic" | "cascade" => {
                        let query = parsed.query.unwrap_or_default();
                        if query.is_empty() {
                            return Err(crate::util::errors::Ai00XError::tool(
                                "query required for semantic/cascade mode",
                            ));
                        }
                        // For semantic/cascade, we need embedding provider
                        let provider =
                            crate::agent::tools::implementations::skills::embedding_provider::get_embedding_provider();
                        if let Some(provider) = provider {
                            let query_clone = query.clone();
                            let emb =
                                match tokio::task::spawn_blocking(move || {
                                    provider.embed_text(&query_clone)
                                })
                                .await
                                {
                                    Ok(Ok(emb)) => emb,
                                    Ok(Err(e)) => {
                                        return Err(crate::util::errors::Ai00XError::tool(
                                            format!("Embedding failed: {}", e),
                                        ));
                                    }
                                    Err(e) => {
                                        return Err(crate::util::errors::Ai00XError::tool(
                                            format!("Embedding spawn failed: {}", e),
                                        ));
                                    }
                                };
                            let results =
                                manager.find_similar(&emb, 0.4, limit).await.map_err(|e| {
                                    crate::util::errors::Ai00XError::tool(format!(
                                        "Search failed: {}",
                                        e
                                    ))
                                })?;

                            if results.is_empty() {
                                format!("No memories found matching '{}'.", query)
                            } else {
                                let mut out = format!(
                                    "Found {} relevant memories for '{}':\n\n",
                                    results.len(),
                                    query
                                );
                                for (entry, score) in results {
                                    let tags_str = if entry.tags.is_empty() {
                                        String::new()
                                    } else {
                                        format!(" [{}]", entry.tags.join(", "))
                                    };
                                    out.push_str(&format!(
                                        "- [{}] {}{}\n  id: {} (relevance: {:.0}%)\n\n",
                                        entry.category,
                                        entry.content,
                                        tags_str,
                                        entry.id,
                                        score * 100.0
                                    ));
                                }
                                out
                            }
                        } else {
                            "Embedding provider not available for semantic search. Use 'recent' mode or 'search' action.".to_string()
                        }
                    }
                    other => {
                        return Err(crate::util::errors::Ai00XError::tool(format!(
                            "Unknown mode: {}. Use recent, semantic, or cascade",
                            other
                        )));
                    }
                }
            }
            "search" => {
                let query = parsed.query.unwrap_or_default();
                let results = manager.search(&query).await;
                if results.is_empty() {
                    format!("No memories matching '{}'", query)
                } else {
                    let mut out = format!("Found {} memories:\n\n", results.len());
                    for e in results {
                        out.push_str(&format!(
                            "- [{}] {}\n  id: {}\n\n",
                            e.category, e.content, e.id
                        ));
                    }
                    out
                }
            }
            "list" => {
                let all = manager.get_all_memories().await;
                if all.is_empty() {
                    "No memories stored.".to_string()
                } else {
                    let mut out = format!("All memories ({}):\n\n", all.len());
                    for e in all {
                        let inactive_mark = if e.active { "" } else { " [inactive]" };
                        let line = format!(
                            "- [{}]{}{}\n  id: {}\n\n",
                            e.category, inactive_mark, e.content, e.id
                        );
                        out.push_str(&line);
                    }
                    out
                }
            }
            "forget" => {
                let Some(id) = parsed.id else {
                    return Err(crate::util::errors::Ai00XError::tool(
                        "id required for forget",
                    ));
                };
                match manager.remove_memory(&id).await {
                    Ok(Some(_)) => format!("Forgot: {}", id),
                    Ok(None) => format!("Not found: {}", id),
                    Err(e) => format!("Error: {}", e),
                }
            }
            "tag" => {
                let Some(id) = parsed.id else {
                    return Err(crate::util::errors::Ai00XError::tool("id required for tag"));
                };
                let tags = parsed.tags.unwrap_or_default();
                if tags.is_empty() {
                    return Err(crate::util::errors::Ai00XError::tool(
                        "At least one tag required",
                    ));
                }
                for tag in &tags {
                    manager.tag_memory(&id, tag).await.map_err(|e| {
                        crate::util::errors::Ai00XError::tool(format!("Failed to tag: {}", e))
                    })?;
                }
                format!("Tagged memory {} with: {}", id, tags.join(", "))
            }
            "link" => {
                let Some(from_id) = parsed.from_id else {
                    return Err(crate::util::errors::Ai00XError::tool(
                        "from_id required for link",
                    ));
                };
                let Some(to_id) = parsed.to_id else {
                    return Err(crate::util::errors::Ai00XError::tool(
                        "to_id required for link",
                    ));
                };
                let weight = parsed.weight.unwrap_or(0.5);
                manager
                    .link_memories(&from_id, &to_id, weight)
                    .await
                    .map_err(|e| {
                        crate::util::errors::Ai00XError::tool(format!("Failed to link: {}", e))
                    })?;
                format!(
                    "Linked memories {} -> {} (weight {:.2})",
                    from_id, to_id, weight
                )
            }
            "related" => {
                let Some(id) = parsed.id else {
                    return Err(crate::util::errors::Ai00XError::tool(
                        "id required for related",
                    ));
                };
                let depth = parsed.depth.unwrap_or(2);
                let related = manager
                    .get_related(&id, depth)
                    .await
                    .map_err(|e| crate::util::errors::Ai00XError::tool(format!("Failed: {}", e)))?;
                if related.is_empty() {
                    format!("No related memories found for {}", id)
                } else {
                    let mut out = format!(
                        "Found {} memories related to {} (depth {}):\n\n",
                        related.len(),
                        id,
                        depth
                    );
                    for e in related {
                        out.push_str(&format!(
                            "- [{}] {}\n  id: {}\n\n",
                            e.category, e.content, e.id
                        ));
                    }
                    out
                }
            }
            other => format!("Unknown action: {}", other),
        };

        Ok(vec![ToolResult::Result {
            data: json!({"text": result}),
            result_for_assistant: Some(result),
            image_attachments: None,
        }])
    }
}
