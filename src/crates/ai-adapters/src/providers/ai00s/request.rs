use crate::client::sse::execute_sse_request;
use crate::client::{AIClient, StreamResponse};
use crate::providers::openai::{self, OpenAIMessageConverter};
use crate::stream::handle_ai00s_stream;
use crate::types::{Message, ToolDefinition};
use anyhow::Result;
use log::debug;

pub(crate) async fn send_stream(
    client: &AIClient,
    messages: Vec<Message>,
    tools: Option<Vec<ToolDefinition>>,
    extra_body: Option<serde_json::Value>,
    max_tries: usize,
) -> Result<StreamResponse> {
    let url = client.config.request_url.clone();
    debug!(
        "Ai00-S config: model={}, request_url={}, max_tries={}",
        client.config.model, client.config.request_url, max_tries
    );

    let openai_messages = OpenAIMessageConverter::convert_messages(messages);
    let openai_tools = OpenAIMessageConverter::convert_tools(tools);
    let request_body =
        openai::chat::build_request_body(client, &url, openai_messages, openai_tools, extra_body);

    execute_sse_request(
        "Ai00-S Streaming API",
        &url,
        &request_body,
        max_tries,
        || openai::common::apply_headers(client, client.client.post(&url)),
        move |response, tx, tx_raw| {
            tokio::spawn(handle_ai00s_stream(response, tx, tx_raw));
        },
    )
    .await
}
