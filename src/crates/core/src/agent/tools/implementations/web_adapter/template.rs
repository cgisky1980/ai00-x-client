use serde_json::Value;
use std::collections::HashMap;

pub fn render_template(template: &str, context: &PipelineContext) -> Result<String, String> {
    let mut result = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '$' && chars.peek() == Some(&'{') {
            chars.next();
            if chars.peek() == Some(&'{') {
                chars.next();
                let expr = read_expr(&mut chars)?;
                let val = eval_expr(&expr, context)?;
                result.push_str(&val);
                // read_expr consumed only the first '}', consume the second '}' of the closing '}}'
                chars.next();
            } else {
                result.push_str("${");
            }
        } else {
            result.push(ch);
        }
    }
    Ok(result)
}

fn read_expr(chars: &mut std::iter::Peekable<std::str::Chars>) -> Result<String, String> {
    let mut expr = String::new();
    let mut depth = 1;
    for ch in chars.by_ref() {
        match ch {
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(expr.trim().to_string());
                }
                expr.push(ch);
            }
            '{' => {
                depth += 1;
                expr.push(ch);
            }
            _ => expr.push(ch),
        }
    }
    Err("Unclosed ${{ expression }}".to_string())
}

fn eval_expr(expr: &str, context: &PipelineContext) -> Result<String, String> {
    let parts: Vec<&str> = expr.splitn(2, '|').collect();
    let path = parts[0].trim();
    let filter = if parts.len() > 1 {
        Some(parts[1].trim())
    } else {
        None
    };

    let value = resolve_path(path, context)?;

    match filter {
        Some("urlencode") => Ok(urlencoding::encode(&value).to_string()),
        Some("json") => Ok(serde_json::to_string(&Value::String(value.clone()))
            .unwrap_or_else(|_| format!("\"{}\"", value))),
        Some("lower") => Ok(value.to_lowercase()),
        Some("upper") => Ok(value.to_uppercase()),
        Some("trim") => Ok(value.trim().to_string()),
        Some(f) if f.starts_with("default:") => {
            let default_val = f.strip_prefix("default:").unwrap_or("");
            if value.is_empty() {
                Ok(default_val.to_string())
            } else {
                Ok(value)
            }
        }
        Some(f) if f.starts_with("slice:") => {
            let range = f.strip_prefix("slice:").unwrap_or("");
            let num: usize = range
                .parse()
                .map_err(|_| format!("Invalid slice: {range}"))?;
            Ok(value.chars().take(num).collect())
        }
        Some(f) => Err(format!("Unknown filter: {f}")),
        None => Ok(value),
    }
}

fn resolve_path(path: &str, context: &PipelineContext) -> Result<String, String> {
    let path = path.trim();

    // String literal: strip single quotes
    if path.starts_with('\'') && path.ends_with('\'') && path.len() >= 2 {
        return Ok(path[1..path.len() - 1].to_string());
    }

    if path == "index" {
        return Ok(context.index.to_string());
    }

    if path == "item" {
        return value_to_string(&context.current_item);
    }

    // Ternary: check BEFORE prefix stripping, to handle expressions like args.sort == 'x' ? 'a' : 'b'
    if path.contains(" ? ") && path.contains(" : ") {
        let ternary = parse_ternary(path)?;
        let cond = resolve_path(&ternary.condition, context)?;
        if cond == "true" || cond == "1" {
            return resolve_path(&ternary.true_val, context);
        } else {
            return resolve_path(&ternary.false_val, context);
        }
    }

    // Equality comparison: check BEFORE prefix stripping
    if path.contains(" == ") {
        let parts: Vec<&str> = path.splitn(2, " == ").collect();
        if parts.len() == 2 {
            let left = resolve_path(parts[0].trim(), context).unwrap_or_default();
            let right = resolve_path(parts[1].trim(), context)
                .unwrap_or_else(|_| parts[1].trim().to_string());
            return Ok(if left == right { "true" } else { "false" }.to_string());
        }
    }

    if let Some(key) = path.strip_prefix("args.") {
        return context
            .args
            .get(key)
            .map(value_to_string)
            .unwrap_or_else(|| Ok(String::new()));
    }

    if let Some(key) = path.strip_prefix("item.") {
        return context
            .current_item
            .as_object()
            .and_then(|obj| obj.get(key))
            .map(value_to_string)
            .unwrap_or_else(|| Ok(String::new()));
    }

    if let Some(key) = path.strip_prefix("env.") {
        return context
            .env
            .get(key)
            .cloned()
            .ok_or_else(|| format!("Unknown env variable: {key}"));
    }

    if path.starts_with("args[") && path.ends_with(']') {
        let key = &path[5..path.len() - 1];
        return context
            .args
            .get(key)
            .map(value_to_string)
            .unwrap_or_else(|| Ok(String::new()));
    }

    context
        .args
        .get(path)
        .map(value_to_string)
        .unwrap_or_else(|| Ok(String::new()))
}

struct TernaryExpr {
    condition: String,
    true_val: String,
    false_val: String,
}

fn parse_ternary(expr: &str) -> Result<TernaryExpr, String> {
    let q_pos = expr.find(" ? ").ok_or("Invalid ternary: missing ?")?;
    let condition = expr[..q_pos].trim().to_string();
    let rest = &expr[q_pos + 3..];
    let c_pos = rest.find(" : ").ok_or("Invalid ternary: missing :")?;
    let true_val = rest[..c_pos].trim().to_string();
    let false_val = rest[c_pos + 3..].trim().to_string();
    Ok(TernaryExpr {
        condition,
        true_val,
        false_val,
    })
}

fn value_to_string(val: &Value) -> Result<String, String> {
    match val {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Null => Ok(String::new()),
        other => Ok(other.to_string()),
    }
}

#[derive(Debug, Clone)]
pub struct PipelineContext {
    pub args: serde_json::Map<String, Value>,
    pub current_item: Value,
    pub index: usize,
    pub env: HashMap<String, String>,
}

impl PipelineContext {
    pub fn new(args: serde_json::Map<String, Value>) -> Self {
        Self {
            args,
            current_item: Value::Null,
            index: 0,
            env: HashMap::new(),
        }
    }

    pub fn with_item(item: Value, index: usize) -> Self {
        Self {
            args: serde_json::Map::new(),
            current_item: item,
            index,
            env: HashMap::new(),
        }
    }

    pub fn with_args_and_item(
        args: serde_json::Map<String, Value>,
        item: Value,
        index: usize,
    ) -> Self {
        Self {
            args,
            current_item: item,
            index,
            env: HashMap::new(),
        }
    }

    pub fn set_env(&mut self, key: String, value: String) {
        self.env.insert(key, value);
    }
}

pub fn render_value(value: &Value, context: &PipelineContext) -> Result<Value, String> {
    match value {
        Value::String(s) => {
            let rendered = render_template(s, context)?;
            Ok(Value::String(rendered))
        }
        Value::Object(map) => {
            let mut result = serde_json::Map::new();
            for (k, v) in map {
                result.insert(k.clone(), render_value(v, context)?);
            }
            Ok(Value::Object(result))
        }
        Value::Array(arr) => {
            let mut result = Vec::new();
            for v in arr {
                result.push(render_value(v, context)?);
            }
            Ok(Value::Array(result))
        }
        other => Ok(other.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_context() -> PipelineContext {
        let mut args = serde_json::Map::new();
        args.insert("query".to_string(), json!("rust lang"));
        args.insert("limit".to_string(), json!(10));
        args.insert("sort".to_string(), json!("relevance"));
        PipelineContext::new(args)
    }

    #[test]
    fn test_simple_arg() {
        let ctx = make_context();
        assert_eq!(
            render_template("${{ args.query }}", &ctx).unwrap(),
            "rust lang"
        );
    }

    #[test]
    fn test_urlencode_filter() {
        let ctx = make_context();
        assert_eq!(
            render_template("${{ args.query | urlencode }}", &ctx).unwrap(),
            "rust%20lang"
        );
    }

    #[test]
    fn test_json_filter() {
        let ctx = make_context();
        assert_eq!(
            render_template("${{ args.query | json }}", &ctx).unwrap(),
            "\"rust lang\""
        );
    }

    #[test]
    fn test_ternary() {
        let ctx = make_context();
        assert_eq!(
            render_template(
                "${{ args.sort == 'date' ? 'search_by_date' : 'search' }}",
                &ctx
            )
            .unwrap(),
            "search"
        );
    }

    #[test]
    fn test_mixed_template() {
        let ctx = make_context();
        let result = render_template(
            "https://example.com?q=${{ args.query | urlencode }}&limit=${{ args.limit }}",
            &ctx,
        )
        .unwrap();
        assert_eq!(result, "https://example.com?q=rust%20lang&limit=10");
    }

    #[test]
    fn test_item_path() {
        let mut ctx = make_context();
        ctx.current_item = json!({"title": "Hello", "score": 42});
        assert_eq!(render_template("${{ item.title }}", &ctx).unwrap(), "Hello");
        assert_eq!(render_template("${{ item.score }}", &ctx).unwrap(), "42");
    }

    #[test]
    fn test_index() {
        let ctx = PipelineContext::with_item(Value::Null, 5);
        assert_eq!(render_template("${{ index }}", &ctx).unwrap(), "5");
    }
}
