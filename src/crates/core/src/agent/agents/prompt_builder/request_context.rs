#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestContextSection {
    WorkspaceInstructions,
    WorkspaceMemoryFiles,
    AIRules,
    AIMemories,
    ProjectLayout,
    AgentMemoryInject,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestContextPolicy {
    pub sections: Vec<RequestContextSection>,
}

impl RequestContextPolicy {
    pub fn new(sections: Vec<RequestContextSection>) -> Self {
        Self { sections }
    }

    pub fn full() -> Self {
        Self::new(vec![
            RequestContextSection::WorkspaceInstructions,
            RequestContextSection::WorkspaceMemoryFiles,
            RequestContextSection::AIRules,
            RequestContextSection::AIMemories,
            RequestContextSection::ProjectLayout,
            RequestContextSection::AgentMemoryInject,
        ])
    }

    pub fn full_without_layout() -> Self {
        Self::new(vec![
            RequestContextSection::WorkspaceInstructions,
            RequestContextSection::WorkspaceMemoryFiles,
            RequestContextSection::AIRules,
            RequestContextSection::AIMemories,
            RequestContextSection::AgentMemoryInject,
        ])
    }

    pub fn instructions_only() -> Self {
        Self::new(vec![RequestContextSection::WorkspaceInstructions])
    }

    pub fn instructions_and_layout() -> Self {
        Self::new(vec![
            RequestContextSection::WorkspaceInstructions,
            RequestContextSection::ProjectLayout,
        ])
    }

    pub fn includes(&self, section: RequestContextSection) -> bool {
        self.sections.contains(&section)
    }

    pub fn has_override_sections(&self) -> bool {
        self.includes(RequestContextSection::WorkspaceMemoryFiles)
            || self.includes(RequestContextSection::AIRules)
            || self.includes(RequestContextSection::AIMemories)
            || self.includes(RequestContextSection::AgentMemoryInject)
    }
}

impl Default for RequestContextPolicy {
    fn default() -> Self {
        Self::full()
    }
}
