//! Code Review Agent - Agent-driven code review with context gathering capabilities
//!
//! This agent can use Read/Grep/Glob/LS tools to gather context before
//! submitting a code review, reducing false positives from missing context.

use super::{to_tool_vec, Agent, READONLY_FILE_TOOLS};
use async_trait::async_trait;

pub struct CodeReviewAgent {
    default_tools: Vec<String>,
}

impl CodeReviewAgent {
    pub fn new() -> Self {
        let mut tools = to_tool_vec(READONLY_FILE_TOOLS);
        tools.extend_from_slice(&[
            "GetFileDiff".to_string(),
            "submit_code_review".to_string(),
            "AskUserQuestion".to_string(),
            "Git".to_string(),
        ]);
        Self {
            default_tools: tools,
        }
    }
}

impl Default for CodeReviewAgent {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Agent for CodeReviewAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "CodeReview"
    }

    fn name(&self) -> &str {
        "CodeReview"
    }

    fn description(&self) -> &str {
        r#"Subagent for agent-driven code review with context gathering. Supports perspective parameterization for multi-perspective analysis. The agent will use Read/Grep/Glob tools to understand function definitions, type structures, and related code before reporting issues."#
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "code_review"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn is_readonly(&self) -> bool {
        false // Code review agent can use Git tools for staging and committing after review
    }
}
