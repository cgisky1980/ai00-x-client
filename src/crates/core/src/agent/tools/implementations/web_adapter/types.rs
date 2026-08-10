use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum Strategy {
    #[default]
    Public,
    Cookie,
    Header,
    Intercept,
    Ui,
}

impl Strategy {
    pub fn requires_user_browser(&self) -> bool {
        !matches!(self, Self::Public)
    }
}

impl fmt::Display for Strategy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Public => write!(f, "public"),
            Self::Cookie => write!(f, "cookie"),
            Self::Header => write!(f, "header"),
            Self::Intercept => write!(f, "intercept"),
            Self::Ui => write!(f, "ui"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArgType {
    #[serde(rename = "int")]
    Int,
    #[serde(rename = "number")]
    Number,
    #[serde(rename = "bool")]
    Bool,
    #[serde(rename = "boolean")]
    Boolean,
    #[serde(rename = "str")]
    #[serde(alias = "string")]
    Str,
}

impl ArgType {
    pub fn coerce(&self, value: &serde_json::Value) -> serde_json::Value {
        match self {
            Self::Int => value
                .as_i64()
                .map_or(value.clone(), |v| serde_json::Value::Number(v.into())),
            Self::Number => value.as_f64().map_or(value.clone(), |v| {
                serde_json::Number::from_f64(v).map_or(value.clone(), serde_json::Value::Number)
            }),
            Self::Bool | Self::Boolean => value
                .as_bool()
                .map_or(value.clone(), serde_json::Value::Bool),
            Self::Str => value
                .as_str()
                .map_or(value.clone(), |s| serde_json::Value::String(s.to_string())),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArgDef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arg_type: Option<ArgType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub positional: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebAdapter {
    pub site: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default)]
    pub strategy: Strategy,
    #[serde(default)]
    pub args: HashMap<String, ArgDef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<String>>,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}

fn default_timeout() -> u64 {
    30
}

impl WebAdapter {
    pub fn key(&self) -> String {
        format!("{}/{}", self.site, self.name)
    }

    pub fn needs_browser(&self) -> bool {
        if self.strategy.requires_user_browser() {
            return true;
        }
        if let Some(pipeline) = &self.pipeline {
            let browser_step_keys = [
                "navigate",
                "click",
                "type",
                "wait",
                "press",
                "evaluate",
                "snapshot",
                "screenshot",
                "intercept",
                "tap",
            ];
            for step in pipeline {
                if let Some(obj) = step.as_object() {
                    for key in obj.keys() {
                        if browser_step_keys.contains(&key.as_str()) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    pub fn resolve_args(
        &self,
        user_args: &serde_json::Map<String, serde_json::Value>,
    ) -> serde_json::Map<String, serde_json::Value> {
        let mut resolved = serde_json::Map::new();
        for (name, def) in &self.args {
            let value = if let Some(v) = user_args.get(name) {
                if let Some(ref arg_type) = def.arg_type {
                    arg_type.coerce(v)
                } else {
                    v.clone()
                }
            } else if let Some(ref default) = def.default {
                default.clone()
            } else {
                continue;
            };
            resolved.insert(name.clone(), value);
        }
        resolved
    }
}

#[derive(Debug, Clone)]
pub struct AdapterMatch {
    pub adapter: Arc<WebAdapter>,
    pub source: AdapterSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterSource {
    Builtin,
    User,
    Remote,
}
