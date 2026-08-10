use serde_json::Value;
use std::time::Duration;

use super::browser_page::{create_browser_page, BrowserPage};
use super::steps::{create_step, StepContext};
use super::template::PipelineContext;
use super::types::WebAdapter;
use crate::util::errors::{Ai00XError, Ai00XResult};

pub struct PipelineExecutor {
    http_client: reqwest::Client,
}

impl Default for PipelineExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl PipelineExecutor {
    pub fn new() -> Self {
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .user_agent("ai00-x/1.0")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self { http_client }
    }

    pub async fn execute(
        &self,
        adapter: &WebAdapter,
        user_args: &serde_json::Map<String, Value>,
        daemon_port: Option<u16>,
        cdp_port: Option<u16>,
        workspace: Option<String>,
    ) -> Ai00XResult<Value> {
        let resolved_args = adapter.resolve_args(user_args);
        let pipeline = adapter.pipeline.as_ref().ok_or_else(|| {
            Ai00XError::Service(format!("Adapter '{}' has no pipeline", adapter.key()))
        })?;

        let needs_browser = adapter.needs_browser();
        let browser_instance = if needs_browser {
            match create_browser_page(daemon_port, cdp_port, workspace).await {
                Ok(instance) => Some(instance),
                Err(e) => {
                    if adapter.strategy.requires_user_browser() {
                        return Err(Ai00XError::Service(format!(
                            "Adapter '{}' requires a logged-in browser but none is available: {}",
                            adapter.key(),
                            e
                        )));
                    }
                    log::warn!(
                        "Browser not available for adapter '{}', proceeding without browser: {}",
                        adapter.key(),
                        e
                    );
                    None
                }
            }
        } else {
            None
        };

        let browser_ref: Option<&dyn BrowserPage> = browser_instance.as_ref().map(|bi| bi.as_dyn());

        let pipeline_ctx = PipelineContext::new(resolved_args);
        let mut data = Value::Null;
        let mut current_ctx = pipeline_ctx;

        for (step_index, step_config) in pipeline.iter().enumerate() {
            let step_obj = step_config.as_object().ok_or_else(|| {
                Ai00XError::Service(format!("Pipeline step {} must be an object", step_index))
            })?;

            let (step_type, step_value) = step_obj.iter().next().ok_or_else(|| {
                Ai00XError::Service(format!("Pipeline step {} is empty", step_index))
            })?;

            let step = create_step(step_type, step_value).map_err(|e| {
                Ai00XError::Service(format!(
                    "Failed to create step '{}' at index {}: {}",
                    step_type, step_index, e
                ))
            })?;

            let step_ctx = StepContext {
                data: data.clone(),
                pipeline_ctx: current_ctx.clone(),
                browser: browser_ref,
                http_client: self.http_client.clone(),
            };

            log::debug!(
                "Executing pipeline step {} ({}) for adapter '{}'",
                step_index,
                step_type,
                adapter.key()
            );

            data = step.execute(&step_ctx).await.map_err(|e| {
                Ai00XError::Service(format!(
                    "Pipeline step {} ({}) failed for adapter '{}': {}",
                    step_index,
                    step_type,
                    adapter.key(),
                    e
                ))
            })?;

            if let Some(obj) = data.as_object() {
                if let Some(args_update) = obj.get("_args") {
                    if let Some(args_map) = args_update.as_object() {
                        for (k, v) in args_map {
                            current_ctx.args.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
        }

        if let Some(ref columns) = adapter.columns {
            data = apply_columns(&data, columns);
        }

        Ok(data)
    }
}

fn apply_columns(data: &Value, columns: &[String]) -> Value {
    match data {
        Value::Array(items) => {
            let result: Vec<Value> = items
                .iter()
                .map(|item| {
                    if let Some(obj) = item.as_object() {
                        let mut filtered = serde_json::Map::new();
                        for col in columns {
                            if let Some(val) = obj.get(col) {
                                filtered.insert(col.clone(), val.clone());
                            }
                        }
                        Value::Object(filtered)
                    } else {
                        item.clone()
                    }
                })
                .collect();
            Value::Array(result)
        }
        Value::Object(obj) => {
            let mut filtered = serde_json::Map::new();
            for col in columns {
                if let Some(val) = obj.get(col) {
                    filtered.insert(col.clone(), val.clone());
                }
            }
            Value::Object(filtered)
        }
        other => other.clone(),
    }
}

pub async fn execute_adapter(
    adapter: &WebAdapter,
    user_args: &serde_json::Map<String, Value>,
    daemon_port: Option<u16>,
    cdp_port: Option<u16>,
    workspace: Option<String>,
) -> Ai00XResult<Value> {
    let executor = PipelineExecutor::new();
    executor
        .execute(adapter, user_args, daemon_port, cdp_port, workspace)
        .await
}
