use async_trait::async_trait;
use serde_json::{json, Value};

use super::web_adapter::{
    discover_builtin_adapters, discover_user_adapters, fetch_remote_adapters,
    get_global_adapter_registry, load_cached_remote_adapters, RemoteAdapterConfig,
};
use crate::agent::tools::framework::{Tool, ToolResult, ToolUseContext};
use crate::util::errors::{Ai00XError, Ai00XResult};

pub struct WebAdapterManagerTool;

impl Default for WebAdapterManagerTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WebAdapterManagerTool {
    pub fn new() -> Self {
        Self
    }

    async fn list_adapters(&self, filter: Option<&str>) -> Ai00XResult<Vec<Value>> {
        let registry = get_global_adapter_registry();
        let reg = registry.read().await;
        let all = reg.list_all();

        let mut result = Vec::new();
        for adapter in all {
            if let Some(f) = filter {
                let f_lower = f.to_lowercase();
                let site_match = adapter.site.to_lowercase().contains(&f_lower);
                let domain_match = adapter
                    .domain
                    .as_ref()
                    .map(|d| d.to_lowercase().contains(&f_lower))
                    .unwrap_or(false);
                if !site_match && !domain_match {
                    continue;
                }
            }

            let pipeline_len = adapter.pipeline.as_ref().map(|p| p.len()).unwrap_or(0);
            result.push(json!({
                "site": adapter.site,
                "name": adapter.name,
                "domain": adapter.domain,
                "strategy": adapter.strategy.to_string(),
                "description": adapter.description.as_ref().unwrap_or(&String::new()),
                "pipeline_steps": pipeline_len,
                "needs_browser": adapter.needs_browser(),
            }));
        }
        Ok(result)
    }

    async fn get_adapter_detail(&self, site: &str) -> Ai00XResult<Value> {
        let registry = get_global_adapter_registry();
        let reg = registry.read().await;

        let adapters = reg
            .find_by_site(site)
            .ok_or_else(|| Ai00XError::validation(format!("Adapter '{}' not found", site)))?;

        let adapter = adapters
            .first()
            .ok_or_else(|| Ai00XError::validation(format!("Adapter '{}' not found", site)))?;

        let args_info: Vec<Value> = adapter
            .args
            .iter()
            .map(|(k, arg)| {
                json!({
                    "name": k,
                    "type": arg.arg_type.map(|t| format!("{:?}", t)).unwrap_or_default(),
                    "required": arg.required,
                    "default": arg.default,
                    "description": arg.description,
                })
            })
            .collect();

        let pipeline_info: Vec<Value> = adapter
            .pipeline
            .as_ref()
            .map(|steps| {
                steps
                    .iter()
                    .map(|step| {
                        if let Some(obj) = step.as_object() {
                            json!(obj)
                        } else {
                            step.clone()
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(json!({
            "site": adapter.site,
            "name": adapter.name,
            "domain": adapter.domain,
            "strategy": adapter.strategy.to_string(),
            "description": adapter.description,
            "args": args_info,
            "pipeline": pipeline_info,
            "columns": adapter.columns,
            "needs_browser": adapter.needs_browser(),
            "timeout_seconds": adapter.timeout_seconds,
        }))
    }

    async fn update_remote(&self, use_mirror: bool) -> Ai00XResult<Value> {
        let config = RemoteAdapterConfig::default();
        let config = if use_mirror {
            config
        } else {
            config.without_mirror()
        };

        let registry = get_global_adapter_registry();
        let mut reg = registry.write().await;

        let count = fetch_remote_adapters(&config, &mut reg)
            .await
            .map_err(Ai00XError::service)?;

        Ok(json!({
            "action": "update_remote",
            "fetched_count": count,
            "use_mirror": use_mirror,
            "repo": config.repo,
        }))
    }

    async fn reload(&self) -> Ai00XResult<Value> {
        let registry = get_global_adapter_registry();
        let mut reg = registry.write().await;
        reg.clear();

        discover_builtin_adapters(&mut reg);
        let _ = discover_user_adapters(&mut reg);
        let _ = load_cached_remote_adapters(&RemoteAdapterConfig::default(), &mut reg).await;

        let count = reg.list_all().len();
        Ok(json!({
            "action": "reload",
            "total_adapters": count,
        }))
    }
}

#[async_trait]
impl Tool for WebAdapterManagerTool {
    fn name(&self) -> &str {
        "WebAdapterManager"
    }

    async fn description(&self) -> Ai00XResult<String> {
        Ok(r#"Manage web adapters for site-specific content extraction.

Available actions:
- list: List all registered adapters (optional 'filter' to search by site/domain)
- detail: Show detailed info for a specific adapter (requires 'site' parameter)
- update_remote: Fetch/update remote adapters from GitHub repository (supports mirror for China users)
- reload: Reload all adapters from builtin, user, and cached remote sources

When to use this tool:
- When you need to check available web adapters for a specific site
- When you want to update remote adapters from the community repository
- When troubleshooting adapter issues and need to inspect adapter configuration
- When the user asks about available site-specific extraction capabilities

Usage examples:
1. List all adapters:
   WebAdapterManager(action="list")

2. Filter adapters by keyword:
   WebAdapterManager(action="list", filter="github")

3. Get adapter details:
   WebAdapterManager(action="detail", site="github")

4. Update remote adapters (with mirror for China):
   WebAdapterManager(action="update_remote", use_mirror=true)

5. Update remote adapters (direct GitHub):
   WebAdapterManager(action="update_remote", use_mirror=false)

6. Reload all adapters:
   WebAdapterManager(action="reload")"#.to_string())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "Action to perform: 'list', 'detail', 'update_remote', 'reload'",
                    "enum": ["list", "detail", "update_remote", "reload"]
                },
                "filter": {
                    "type": "string",
                    "description": "Filter keyword for list action (matches site name or domain)"
                },
                "site": {
                    "type": "string",
                    "description": "Site identifier for detail action (e.g. 'github', 'reddit')"
                },
                "use_mirror": {
                    "type": "boolean",
                    "description": "Use GitHub mirror for China users (default: true). Only for update_remote action.",
                    "default": true
                }
            },
            "required": ["action"]
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    fn needs_permissions(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn call_impl(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> Ai00XResult<Vec<ToolResult>> {
        let action = input
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| Ai00XError::validation("Missing required field: action"))?;

        let result = match action {
            "list" => {
                let filter = input.get("filter").and_then(|v| v.as_str());
                let adapters = self.list_adapters(filter).await?;
                json!({
                    "action": "list",
                    "count": adapters.len(),
                    "adapters": adapters,
                })
            }
            "detail" => {
                let site = input.get("site").and_then(|v| v.as_str()).ok_or_else(|| {
                    Ai00XError::validation("'site' parameter is required for detail action")
                })?;
                self.get_adapter_detail(site).await?
            }
            "update_remote" => {
                let use_mirror = input
                    .get("use_mirror")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                self.update_remote(use_mirror).await?
            }
            "reload" => self.reload().await?,
            _ => {
                return Err(Ai00XError::validation(format!(
                    "Unknown action '{}'. Must be one of: list, detail, update_remote, reload",
                    action
                )));
            }
        };

        let result_for_assistant =
            serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string());
        Ok(vec![ToolResult::Result {
            data: result,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }
}
