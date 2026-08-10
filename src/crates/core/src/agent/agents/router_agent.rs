use super::{to_tool_vec, Agent, RequestContextPolicy, READONLY_FILE_TOOLS};
use async_trait::async_trait;

pub struct RouterAgent {
    default_tools: Vec<String>,
}

impl Default for RouterAgent {
    fn default() -> Self {
        Self::new()
    }
}

impl RouterAgent {
    pub fn new() -> Self {
        Self {
            default_tools: to_tool_vec(READONLY_FILE_TOOLS),
        }
    }
}

#[async_trait]
impl Agent for RouterAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Router"
    }

    fn name(&self) -> &str {
        "Router"
    }

    fn description(&self) -> &str {
        r#"Readonly subagent that analyzes user intent and recommends routing strategy to the most suitable subagent"#
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "router_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn request_context_policy(&self) -> RequestContextPolicy {
        RequestContextPolicy::instructions_only()
    }

    fn is_readonly(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{Agent, RouterAgent};

    #[test]
    fn uses_read_first_default_tool_order() {
        let agent = RouterAgent::new();
        assert_eq!(
            agent.default_tools(),
            vec![
                "LS".to_string(),
                "Read".to_string(),
                "Grep".to_string(),
                "Glob".to_string(),
            ]
        );
    }

    #[test]
    fn always_uses_default_prompt_template() {
        let agent = RouterAgent::new();
        assert_eq!(agent.prompt_template_name(Some("gpt-5.1")), "router_agent");
        assert_eq!(
            agent.prompt_template_name(Some("claude-sonnet-4")),
            "router_agent"
        );
        assert_eq!(agent.prompt_template_name(None), "router_agent");
    }
}
