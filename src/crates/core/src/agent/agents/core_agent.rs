use super::{to_tool_vec, Agent, RequestContextPolicy, READONLY_FILE_TOOLS};
use async_trait::async_trait;

pub struct CoreAgent {
    default_tools: Vec<String>,
}

impl Default for CoreAgent {
    fn default() -> Self {
        Self::new()
    }
}

impl CoreAgent {
    pub fn new() -> Self {
        let mut tools = vec![
            "AskUserQuestion".to_string(),
            "TodoWrite".to_string(),
            "Task".to_string(),
            "Skill".to_string(),
        ];
        tools.extend(to_tool_vec(READONLY_FILE_TOOLS));
        tools.extend_from_slice(&[
            "Write".to_string(),
            "Edit".to_string(),
            "GetFileDiff".to_string(),
            "Bash".to_string(),
            "WebSearch".to_string(),
            "CreatePlan".to_string(),
            "WebFetch".to_string(),
        ]);
        Self {
            default_tools: tools,
        }
    }
}

#[async_trait]
impl Agent for CoreAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Core"
    }

    fn name(&self) -> &str {
        "Core"
    }

    fn description(&self) -> &str {
        "Core agent: Think-Plan-Execute-Review workflow with intelligent routing and multi-perspective review"
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "core_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn request_context_policy(&self) -> RequestContextPolicy {
        RequestContextPolicy::default()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{Agent, CoreAgent};

    #[test]
    fn core_agent_has_expected_tools() {
        let agent = CoreAgent::new();
        let tools = agent.default_tools();
        assert!(tools.contains(&"AskUserQuestion".to_string()));
        assert!(tools.contains(&"TodoWrite".to_string()));
        assert!(tools.contains(&"Task".to_string()));
        assert!(tools.contains(&"Skill".to_string()));
        assert!(tools.contains(&"Bash".to_string()));
        assert!(tools.contains(&"WebSearch".to_string()));
        assert!(tools.contains(&"CreatePlan".to_string()));
        assert!(tools.contains(&"WebFetch".to_string()));
    }

    #[test]
    fn core_agent_is_not_readonly() {
        let agent = CoreAgent::new();
        assert!(!agent.is_readonly());
    }

    #[test]
    fn core_agent_uses_core_prompt_template() {
        let agent = CoreAgent::new();
        assert_eq!(agent.prompt_template_name(None), "core_agent");
    }
}
