//! TaskAgent — Task-oriented agent for focused task execution.
//!
//! Inherits the Core workflow (Plan-Execute-Review) with task-specific emphasis.

use super::core_agent::CoreAgent;
use super::Agent;
use async_trait::async_trait;

pub struct TaskAgent {
    default_tools: Vec<String>,
}

impl Default for TaskAgent {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskAgent {
    pub fn new() -> Self {
        let tools = CoreAgent::new().default_tools();
        Self {
            default_tools: tools,
        }
    }
}

#[async_trait]
impl Agent for TaskAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Task"
    }

    fn name(&self) -> &str {
        "Task"
    }

    fn description(&self) -> &str {
        "Task-oriented agent for focused task execution — inherits Core workflow with task-specific focus"
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "task_agent"
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
    use super::{Agent, TaskAgent};

    #[test]
    fn task_agent_has_core_tools() {
        let agent = TaskAgent::new();
        let tools = agent.default_tools();
        assert!(tools.contains(&"AskUserQuestion".to_string()));
        assert!(tools.contains(&"Write".to_string()));
        assert!(tools.contains(&"Edit".to_string()));
        assert!(tools.contains(&"Bash".to_string()));
    }

    #[test]
    fn task_agent_uses_task_prompt_template() {
        let agent = TaskAgent::new();
        assert_eq!(agent.prompt_template_name(None), "task_agent");
    }

    #[test]
    fn task_agent_id_is_task() {
        let agent = TaskAgent::new();
        assert_eq!(agent.id(), "Task");
    }
}
