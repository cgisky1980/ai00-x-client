pub mod fetch_step;
pub mod map_step;

use async_trait::async_trait;
use serde_json::Value;

use super::browser_page::BrowserPage;
use super::template::PipelineContext;
use crate::util::errors::Ai00XResult;

pub struct StepContext<'a> {
    pub data: Value,
    pub pipeline_ctx: PipelineContext,
    pub browser: Option<&'a dyn BrowserPage>,
    pub http_client: reqwest::Client,
}

#[async_trait]
pub trait PipelineStep: Send + Sync {
    fn step_type(&self) -> &str;
    async fn execute(&self, ctx: &StepContext<'_>) -> Ai00XResult<Value>;
}

pub fn create_step(step_type: &str, config: &Value) -> Result<Box<dyn PipelineStep>, String> {
    match step_type {
        "fetch" => Ok(Box::new(fetch_step::FetchStep::from_config(config)?)),
        "navigate" => Ok(Box::new(fetch_step::NavigateStep::from_config(config)?)),
        "evaluate" => Ok(Box::new(fetch_step::EvaluateStep::from_config(config)?)),
        "select" => Ok(Box::new(map_step::SelectStep::from_config(config)?)),
        "map" => Ok(Box::new(map_step::MapStep::from_config(config)?)),
        "filter" => Ok(Box::new(map_step::FilterStep::from_config(config)?)),
        "limit" => Ok(Box::new(map_step::LimitStep::from_config(config)?)),
        "sort" => Ok(Box::new(map_step::SortStep::from_config(config)?)),
        "wait" => Ok(Box::new(fetch_step::WaitStep::from_config(config)?)),
        "screenshot" => Ok(Box::new(fetch_step::ScreenshotStep::from_config(config)?)),
        _ => Err(format!("Unknown pipeline step type: {step_type}")),
    }
}
