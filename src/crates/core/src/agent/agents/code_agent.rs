//! CodeAgent — Code-oriented agent for software development.
//!
//! Inherits the Core workflow (Plan-Execute-Review) with code-specific emphasis.

use super::core_agent::CoreAgent;
use super::Agent;
use async_trait::async_trait;

pub struct CodeAgent {
    default_tools: Vec<String>,
}

impl Default for CodeAgent {
    fn default() -> Self {
        Self::new()
    }
}

impl CodeAgent {
    pub fn new() -> Self {
        let tools = CoreAgent::new().default_tools();
        Self {
            default_tools: tools,
        }
    }
}

#[async_trait]
impl Agent for CodeAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Code"
    }

    fn name(&self) -> &str {
        "Code"
    }

    fn description(&self) -> &str {
        "Code-oriented agent for software development — inherits Core workflow with code-specific focus"
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "code_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{Agent, CodeAgent};

    #[test]
    fn code_agent_has_core_tools() {
        let agent = CodeAgent::new();
        let tools = agent.default_tools();
        assert!(tools.contains(&"AskUserQuestion".to_string()));
        assert!(tools.contains(&"Write".to_string()));
        assert!(tools.contains(&"Edit".to_string()));
        assert!(tools.contains(&"Bash".to_string()));
    }

    #[test]
    fn code_agent_uses_code_prompt_template() {
        let agent = CodeAgent::new();
        assert_eq!(agent.prompt_template_name(None), "code_agent");
    }

    #[test]
    fn code_agent_id_is_code() {
        let agent = CodeAgent::new();
        assert_eq!(agent.id(), "Code");
    }
}
