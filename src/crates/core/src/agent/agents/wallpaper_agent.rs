//! WallpaperAgent — AI-powered wallpaper design assistant.

use super::{to_tool_vec, Agent, READONLY_FILE_TOOLS};
use async_trait::async_trait;

pub struct WallpaperAgent {
    default_tools: Vec<String>,
}

impl Default for WallpaperAgent {
    fn default() -> Self {
        Self::new()
    }
}

impl WallpaperAgent {
    pub fn new() -> Self {
        let mut tools = to_tool_vec(READONLY_FILE_TOOLS);
        tools.extend_from_slice(&[
            "Write".to_string(),
            "Edit".to_string(),
            "CreatePlan".to_string(),
        ]);
        Self {
            default_tools: tools,
        }
    }
}

#[async_trait]
impl Agent for WallpaperAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Wallpaper"
    }

    fn name(&self) -> &str {
        "Wallpaper Designer"
    }

    fn description(&self) -> &str {
        "AI-powered wallpaper designer — describe what you want, see it live on your desktop"
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "wallpaper_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}
