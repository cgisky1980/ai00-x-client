use serde_json::Value;
use std::collections::HashMap;

use super::types::{ArgDef, ArgType, Strategy, WebAdapter};

pub fn parse_yaml_adapter(content: &str) -> Result<WebAdapter, String> {
    let yaml: HashMap<String, Value> =
        serde_yaml::from_str(content).map_err(|e| format!("YAML parse error: {e}"))?;

    let site = yaml
        .get("site")
        .and_then(|v| v.as_str())
        .ok_or("Missing required field: site")?
        .to_string();

    let name = yaml
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing required field: name")?
        .to_string();

    let description = yaml
        .get("description")
        .and_then(|v| v.as_str())
        .map(String::from);

    let domain = yaml
        .get("domain")
        .and_then(|v| v.as_str())
        .map(String::from);

    let strategy = yaml
        .get("strategy")
        .and_then(|v| v.as_str())
        .map(|s| match s.to_lowercase().as_str() {
            "cookie" => Strategy::Cookie,
            "header" => Strategy::Header,
            "intercept" => Strategy::Intercept,
            "ui" => Strategy::Ui,
            _ => Strategy::Public,
        })
        .unwrap_or(Strategy::Public);

    let args = parse_args(yaml.get("args"));

    let pipeline = yaml
        .get("pipeline")
        .and_then(|v| v.as_array())
        .map(|arr| arr.to_vec());

    let columns = yaml.get("columns").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect()
    });

    let timeout_seconds = yaml
        .get("timeout_seconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(30);

    Ok(WebAdapter {
        site,
        name,
        description,
        domain,
        strategy,
        args,
        pipeline,
        columns,
        timeout_seconds,
    })
}

fn parse_args(args_value: Option<&Value>) -> HashMap<String, ArgDef> {
    let mut result = HashMap::new();
    let Some(args_obj) = args_value.and_then(|v| v.as_object()) else {
        return result;
    };

    for (name, def) in args_obj {
        let arg_def = if let Some(obj) = def.as_object() {
            let arg_type = obj
                .get("type")
                .and_then(|v| v.as_str())
                .and_then(|t| match t {
                    "int" => Some(ArgType::Int),
                    "number" => Some(ArgType::Number),
                    "bool" | "boolean" => Some(ArgType::Bool),
                    "str" | "string" => Some(ArgType::Str),
                    _ => None,
                });

            let default = obj.get("default").cloned();
            let required = obj
                .get("required")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let positional = obj
                .get("positional")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let description = obj
                .get("description")
                .and_then(|v| v.as_str())
                .map(String::from);
            let choices = obj.get("choices").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });

            ArgDef {
                arg_type,
                default,
                required,
                positional,
                description,
                choices,
            }
        } else {
            ArgDef {
                arg_type: None,
                default: Some(def.clone()),
                required: false,
                positional: false,
                description: None,
                choices: None,
            }
        };

        result.insert(name.clone(), arg_def);
    }

    result
}
