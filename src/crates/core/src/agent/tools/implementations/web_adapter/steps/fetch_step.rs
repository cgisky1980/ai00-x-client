use async_trait::async_trait;
use serde_json::Value;

use super::{PipelineStep, StepContext};
use crate::agent::tools::implementations::web_adapter::template::{render_template, render_value};
use crate::util::errors::{Ai00XError, Ai00XResult};

pub struct FetchStep {
    url_template: String,
    params: Option<serde_json::Map<String, Value>>,
    headers: Option<serde_json::Map<String, Value>>,
    method: String,
}

impl FetchStep {
    pub fn from_config(config: &Value) -> Result<Self, String> {
        let obj = config
            .as_object()
            .ok_or("fetch step config must be an object")?;

        let url_template = obj
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or("fetch step requires 'url'")?
            .to_string();

        let params = obj.get("params").and_then(|v| v.as_object()).cloned();

        let headers = obj.get("headers").and_then(|v| v.as_object()).cloned();

        let method = obj
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .to_uppercase();

        Ok(Self {
            url_template,
            params,
            headers,
            method,
        })
    }
}

#[async_trait]
impl PipelineStep for FetchStep {
    fn step_type(&self) -> &str {
        "fetch"
    }

    async fn execute(&self, ctx: &StepContext<'_>) -> Ai00XResult<Value> {
        let url = render_template(&self.url_template, &ctx.pipeline_ctx)
            .map_err(|e| Ai00XError::Service(format!("Template error in fetch URL: {e}")))?;

        let mut request = match self.method.as_str() {
            "POST" => ctx.http_client.post(&url),
            "PUT" => ctx.http_client.put(&url),
            "DELETE" => ctx.http_client.delete(&url),
            _ => ctx.http_client.get(&url),
        };

        if let Some(ref params) = self.params {
            let rendered_params = render_value(&Value::Object(params.clone()), &ctx.pipeline_ctx)
                .map_err(|e| {
                Ai00XError::Service(format!("Template error in fetch params: {e}"))
            })?;
            if let Some(obj) = rendered_params.as_object() {
                let mut query_pairs = vec![];
                for (k, v) in obj {
                    query_pairs.push((k.clone(), v.as_str().unwrap_or("").to_string()));
                }
                request = request.query(&query_pairs);
            }
        }

        if let Some(ref headers) = self.headers {
            let rendered_headers = render_value(&Value::Object(headers.clone()), &ctx.pipeline_ctx)
                .map_err(|e| {
                    Ai00XError::Service(format!("Template error in fetch headers: {e}"))
                })?;
            if let Some(obj) = rendered_headers.as_object() {
                for (k, v) in obj {
                    if let Some(vs) = v.as_str() {
                        request = request.header(k, vs);
                    }
                }
            }
        }

        let response = request
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| Ai00XError::Service(format!("Fetch request failed: {e}")))?;

        let status = response.status();
        if !status.is_success() {
            return Err(Ai00XError::Service(format!(
                "Fetch request returned HTTP {}",
                status
            )));
        }

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");

        if content_type.contains("application/json") {
            let json: Value = response
                .json()
                .await
                .map_err(|e| Ai00XError::Service(format!("Failed to parse JSON response: {e}")))?;
            Ok(json)
        } else {
            let text = response
                .text()
                .await
                .map_err(|e| Ai00XError::Service(format!("Failed to read response text: {e}")))?;
            Ok(Value::String(text))
        }
    }
}

pub struct NavigateStep {
    url_template: String,
    settle_ms: u64,
}

impl NavigateStep {
    pub fn from_config(config: &Value) -> Result<Self, String> {
        let obj = config
            .as_object()
            .ok_or("navigate step config must be an object")?;

        let url_template = obj
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or("navigate step requires 'url'")?
            .to_string();

        let settle_ms = obj
            .get("settleMs")
            .and_then(|v| v.as_u64())
            .or_else(|| obj.get("settle_ms").and_then(|v| v.as_u64()))
            .unwrap_or(2000);

        Ok(Self {
            url_template,
            settle_ms,
        })
    }
}

#[async_trait]
impl PipelineStep for NavigateStep {
    fn step_type(&self) -> &str {
        "navigate"
    }

    async fn execute(&self, ctx: &StepContext<'_>) -> Ai00XResult<Value> {
        let browser = ctx.browser.ok_or_else(|| {
            Ai00XError::Service("navigate step requires a browser connection".to_string())
        })?;

        let url = render_template(&self.url_template, &ctx.pipeline_ctx)
            .map_err(|e| Ai00XError::Service(format!("Template error in navigate URL: {e}")))?;

        browser.navigate(&url).await?;

        if self.settle_ms > 0 {
            browser.wait_for(self.settle_ms).await?;
        }

        Ok(Value::Object(serde_json::Map::from_iter([
            ("navigated".to_string(), Value::Bool(true)),
            ("url".to_string(), Value::String(url)),
        ])))
    }
}

pub struct EvaluateStep {
    expression: String,
}

impl EvaluateStep {
    pub fn from_config(config: &Value) -> Result<Self, String> {
        let expression = config
            .as_str()
            .or_else(|| {
                config
                    .as_object()
                    .and_then(|obj| obj.get("expression"))
                    .and_then(|v| v.as_str())
            })
            .ok_or("evaluate step requires a string expression")?
            .to_string();

        Ok(Self { expression })
    }
}

#[async_trait]
impl PipelineStep for EvaluateStep {
    fn step_type(&self) -> &str {
        "evaluate"
    }

    async fn execute(&self, ctx: &StepContext<'_>) -> Ai00XResult<Value> {
        let browser = ctx.browser.ok_or_else(|| {
            Ai00XError::Service("evaluate step requires a browser connection".to_string())
        })?;

        let rendered = render_template(&self.expression, &ctx.pipeline_ctx)
            .map_err(|e| Ai00XError::Service(format!("Template error in evaluate: {e}")))?;

        browser.evaluate(&rendered).await
    }
}

pub struct WaitStep {
    ms: u64,
}

impl WaitStep {
    pub fn from_config(config: &Value) -> Result<Self, String> {
        let ms = config
            .as_u64()
            .or_else(|| config.as_object().and_then(|obj| obj.get("ms")?.as_u64()))
            .ok_or("wait step requires a duration in ms")?;

        Ok(Self { ms })
    }
}

#[async_trait]
impl PipelineStep for WaitStep {
    fn step_type(&self) -> &str {
        "wait"
    }

    async fn execute(&self, ctx: &StepContext<'_>) -> Ai00XResult<Value> {
        if let Some(browser) = ctx.browser {
            browser.wait_for(self.ms).await
        } else {
            tokio::time::sleep(std::time::Duration::from_millis(self.ms)).await;
            Ok(Value::Object(serde_json::Map::from_iter([(
                "waited_ms".to_string(),
                Value::Number(self.ms.into()),
            )])))
        }
    }
}

pub struct ScreenshotStep;

impl ScreenshotStep {
    pub fn from_config(_config: &Value) -> Result<Self, String> {
        Ok(Self)
    }
}

#[async_trait]
impl PipelineStep for ScreenshotStep {
    fn step_type(&self) -> &str {
        "screenshot"
    }

    async fn execute(&self, ctx: &StepContext<'_>) -> Ai00XResult<Value> {
        let browser = ctx.browser.ok_or_else(|| {
            Ai00XError::Service("screenshot step requires a browser connection".to_string())
        })?;

        let data = browser.screenshot().await?;
        Ok(Value::Object(serde_json::Map::from_iter([
            ("type".to_string(), Value::String("jpeg".to_string())),
            ("data".to_string(), Value::String(data)),
        ])))
    }
}
