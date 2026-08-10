use super::{to_tool_vec, Agent, READONLY_FILE_TOOLS};
use async_trait::async_trait;

pub struct InitAgent {
    default_tools: Vec<String>,
}

impl Default for InitAgent {
    fn default() -> Self {
        Self::new()
    }
}

impl InitAgent {
    pub fn new() -> Self {
        let mut tools = to_tool_vec(READONLY_FILE_TOOLS);
        tools.extend_from_slice(&[
            "Write".to_string(),
            "Edit".to_string(),
            "Bash".to_string(),
            "ComputerUse".to_string(),
        ]);
        Self {
            default_tools: tools,
        }
    }
}

#[async_trait]
impl Agent for InitAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Init"
    }

    fn name(&self) -> &str {
        "Init"
    }

    fn description(&self) -> &str {
        "Agent for /init command"
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "init_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}
