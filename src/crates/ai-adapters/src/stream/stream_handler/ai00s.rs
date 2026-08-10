use crate::stream::types::unified::{UnifiedResponse, UnifiedTokenUsage, UnifiedToolCall};
use anyhow::{anyhow, Result};
use eventsource_stream::Eventsource;
use futures::StreamExt;
use log::{error, trace, warn};
use reqwest::Response;
use serde_json::Value;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

pub async fn handle_ai00s_stream(
    response: Response,
    tx_event: mpsc::UnboundedSender<Result<UnifiedResponse>>,
    tx_raw_sse: Option<mpsc::UnboundedSender<String>>,
) {
    let mut stream = response.bytes_stream().eventsource();
    let idle_timeout = Duration::from_secs(600);

    loop {
        let sse_event = timeout(idle_timeout, stream.next()).await;
        let sse = match sse_event {
            Ok(Some(Ok(sse))) => sse,
            Ok(None) => return,
            Ok(Some(Err(e))) => {
                let error_msg = format!("Ai00-S SSE stream error: {}", e);
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
            Err(_) => {
                let error_msg = format!(
                    "Ai00-S SSE stream timeout after {}s",
                    idle_timeout.as_secs()
                );
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
        };

        let raw = sse.data;
        trace!(target: "ai::ai00s_stream_response", "Ai00-S SSE: {:?}", raw);

        if let Some(ref tx) = tx_raw_sse {
            let _ = tx.send(raw.clone());
        }

        if raw == "[DONE]" {
            return;
        }

        let event_json: Value = match serde_json::from_str(&raw) {
            Ok(json) => json,
            Err(e) => {
                warn!("Ai00-S SSE parsing skipped: {} data={}", e, &raw);
                continue;
            }
        };

        if event_json.get("error").is_some() {
            let error_msg = format!(
                "Ai00-S SSE API error: {}",
                event_json
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
            );
            error!("{}", error_msg);
            let _ = tx_event.send(Err(anyhow!(error_msg)));
            return;
        }

        let text = event_json
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let finish_reason = event_json
            .get("finish_reason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let tool_call = event_json.get("tool_call").map(|tc| UnifiedToolCall {
            id: tc.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()),
            name: tc
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            arguments: tc
                .get("arguments")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            arguments_is_snapshot: false,
        });

        let usage = event_json.get("usage").map(|u| UnifiedTokenUsage {
            prompt_token_count: u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            candidates_token_count: u
                .get("completion_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            total_token_count: u.get("total_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            reasoning_token_count: None,
            cached_content_token_count: None,
        });

        if text.is_none() && finish_reason.is_none() && tool_call.is_none() && usage.is_none() {
            continue;
        }

        let unified = UnifiedResponse {
            text,
            reasoning_content: None,
            thinking_signature: None,
            tool_call,
            usage,
            finish_reason,
            provider_metadata: None,
        };

        let _ = tx_event.send(Ok(unified));
    }
}
