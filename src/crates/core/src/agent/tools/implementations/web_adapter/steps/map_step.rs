use async_trait::async_trait;
use serde_json::Value;

use super::{PipelineStep, StepContext};
use crate::agent::tools::implementations::web_adapter::template::{
    render_template, PipelineContext,
};
use crate::util::errors::{Ai00XError, Ai00XResult};

pub struct SelectStep {
    path: String,
}

impl SelectStep {
    pub fn from_config(config: &Value) -> Result<Self, String> {
        let path = config
            .as_str()
            .ok_or("select step requires a path string")?
            .to_string();
        Ok(Self { path })
    }
}

#[async_trait]
impl PipelineStep for SelectStep {
    fn step_type(&self) -> &str {
        "select"
    }

    async fn execute(&self, ctx: &StepContext<'_>) -> Ai00XResult<Value> {
        select_path(&ctx.data, &self.path)
    }
}

fn select_path(data: &Value, path: &str) -> Ai00XResult<Value> {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = data;
    for part in parts {
        if part.is_empty() {
            continue;
        }
        if let Ok(idx) = part.parse::<usize>() {
            current = current
                .as_array()
                .and_then(|arr| arr.get(idx))
                .ok_or_else(|| Ai00XError::Service(format!("Array index {} out of bounds", idx)))?;
        } else {
            current = current
                .as_object()
                .and_then(|obj| obj.get(part))
                .ok_or_else(|| {
                    Ai00XError::Service(format!("Key '{}' not found in object", part))
                })?;
        }
    }
    Ok(current.clone())
}

pub struct MapStep {
    mappings: serde_json::Map<String, Value>,
}

impl MapStep {
    pub fn from_config(config: &Value) -> Result<Self, String> {
        let mappings = config
            .as_object()
            .ok_or("map step requires an object with field mappings")?
            .clone();
        Ok(Self { mappings })
    }
}

#[async_trait]
impl PipelineStep for MapStep {
    fn step_type(&self) -> &str {
        "map"
    }

    async fn execute(&self, ctx: &StepContext<'_>) -> Ai00XResult<Value> {
        let items = ctx
            .data
            .as_array()
            .ok_or_else(|| Ai00XError::Service("map step requires array input".to_string()))?;

        let mut result = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let item_ctx = PipelineContext::with_args_and_item(
                ctx.pipeline_ctx.args.clone(),
                item.clone(),
                index,
            );

            let mut mapped = serde_json::Map::new();
            for (field, template) in &self.mappings {
                if let Some(template_str) = template.as_str() {
                    let rendered = render_template(template_str, &item_ctx)
                        .map_err(|e| Ai00XError::Service(format!("Template error in map: {e}")))?;
                    mapped.insert(field.clone(), Value::String(rendered));
                } else {
                    mapped.insert(field.clone(), template.clone());
                }
            }
            result.push(Value::Object(mapped));
        }

        Ok(Value::Array(result))
    }
}

pub struct FilterStep {
    field: String,
    operator: String,
    value: Value,
}

impl FilterStep {
    pub fn from_config(config: &Value) -> Result<Self, String> {
        let obj = config.as_object().ok_or("filter step requires an object")?;

        let field = obj
            .get("field")
            .and_then(|v| v.as_str())
            .ok_or("filter step requires 'field'")?
            .to_string();

        let operator = obj
            .get("op")
            .and_then(|v| v.as_str())
            .unwrap_or("eq")
            .to_string();

        let value = obj.get("value").cloned().unwrap_or(Value::Null);

        Ok(Self {
            field,
            operator,
            value,
        })
    }
}

#[async_trait]
impl PipelineStep for FilterStep {
    fn step_type(&self) -> &str {
        "filter"
    }

    async fn execute(&self, ctx: &StepContext<'_>) -> Ai00XResult<Value> {
        let items = ctx
            .data
            .as_array()
            .ok_or_else(|| Ai00XError::Service("filter step requires array input".to_string()))?;

        let result: Vec<Value> = items
            .iter()
            .filter(|item| {
                let field_val = item.as_object().and_then(|obj| obj.get(&self.field));
                match field_val {
                    Some(fv) => match self.operator.as_str() {
                        "eq" => fv == &self.value,
                        "ne" => fv != &self.value,
                        "gt" => compare_values(fv, &self.value) == std::cmp::Ordering::Greater,
                        "gte" => compare_values(fv, &self.value) != std::cmp::Ordering::Less,
                        "lt" => compare_values(fv, &self.value) == std::cmp::Ordering::Less,
                        "lte" => compare_values(fv, &self.value) != std::cmp::Ordering::Greater,
                        "contains" => fv
                            .as_str()
                            .and_then(|s| self.value.as_str().map(|v| s.contains(v)))
                            .unwrap_or(false),
                        _ => false,
                    },
                    None => false,
                }
            })
            .cloned()
            .collect();

        Ok(Value::Array(result))
    }
}

fn compare_values(a: &Value, b: &Value) -> std::cmp::Ordering {
    match (a.as_f64(), b.as_f64()) {
        (Some(an), Some(bn)) => an.partial_cmp(&bn).unwrap_or(std::cmp::Ordering::Equal),
        _ => {
            let as_str = a.as_str().unwrap_or("");
            let bs_str = b.as_str().unwrap_or("");
            as_str.cmp(bs_str)
        }
    }
}

pub struct LimitStep {
    count: usize,
}

impl LimitStep {
    pub fn from_config(config: &Value) -> Result<Self, String> {
        let count = config
            .as_u64()
            .or_else(|| {
                config
                    .as_object()
                    .and_then(|obj| obj.get("count")?.as_u64())
            })
            .ok_or("limit step requires a count")? as usize;
        Ok(Self { count })
    }
}

#[async_trait]
impl PipelineStep for LimitStep {
    fn step_type(&self) -> &str {
        "limit"
    }

    async fn execute(&self, ctx: &StepContext<'_>) -> Ai00XResult<Value> {
        match ctx.data.as_array() {
            Some(arr) => {
                let limited: Vec<Value> = arr.iter().take(self.count).cloned().collect();
                Ok(Value::Array(limited))
            }
            None => Ok(ctx.data.clone()),
        }
    }
}

pub struct SortStep {
    field: String,
    descending: bool,
}

impl SortStep {
    pub fn from_config(config: &Value) -> Result<Self, String> {
        let obj = config.as_object().ok_or("sort step requires an object")?;

        let field = obj
            .get("field")
            .and_then(|v| v.as_str())
            .ok_or("sort step requires 'field'")?
            .to_string();

        let descending = obj
            .get("order")
            .and_then(|v| v.as_str())
            .map(|s| s == "desc")
            .unwrap_or(false);

        Ok(Self { field, descending })
    }
}

#[async_trait]
impl PipelineStep for SortStep {
    fn step_type(&self) -> &str {
        "sort"
    }

    async fn execute(&self, ctx: &StepContext<'_>) -> Ai00XResult<Value> {
        let mut items = ctx
            .data
            .as_array()
            .ok_or_else(|| Ai00XError::Service("sort step requires array input".to_string()))?
            .clone();

        let field = self.field.clone();
        let desc = self.descending;
        items.sort_by(|a, b| {
            let av = a.as_object().and_then(|obj| obj.get(&field));
            let bv = b.as_object().and_then(|obj| obj.get(&field));
            let ord = compare_values(av.unwrap_or(&Value::Null), bv.unwrap_or(&Value::Null));
            if desc {
                ord.reverse()
            } else {
                ord
            }
        });

        Ok(Value::Array(items))
    }
}
