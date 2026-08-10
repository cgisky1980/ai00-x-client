use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowPhase {
    #[default]
    Planning,
    AwaitingPlanConfirmation,
    Executing,
    Reviewing,
}

impl std::fmt::Display for WorkflowPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkflowPhase::Planning => write!(f, "planning"),
            WorkflowPhase::AwaitingPlanConfirmation => write!(f, "awaiting_plan_confirmation"),
            WorkflowPhase::Executing => write!(f, "executing"),
            WorkflowPhase::Reviewing => write!(f, "reviewing"),
        }
    }
}

const READONLY_TOOLS: &[&str] = &[
    "Read",
    "Glob",
    "Grep",
    "LS",
    "WebSearch",
    "WebFetch",
    "GetFileDiff",
    "SessionHistory",
    "Log",
    "Skill",
    "MermaidInteractive",
    "GenerativeUI",
    "Playbook",
    "ListMCPResources",
    "ReadMCPResource",
    "ListMCPPrompts",
    "GetMCPPrompt",
];

const PLANNING_REMINDER: &str = "\
You are now in the PLANNING phase.\n\
⚠️  CRITICAL: You are REQUIRED to create a plan. This phase CANNOT be skipped.\n\
STAGE GOAL: Understand the user's request and create a PLAN.md document, \
then get user confirmation before ANY execution.\n\
WHAT YOU CAN DO:\n\
- Read files (Read, Glob, Grep, LS) to understand the codebase\n\
- Search the web (WebSearch, WebFetch) for concepts you don't understand\n\
- Ask the user (AskUserQuestion) if the request is unclear or ambiguous\n\
- Use Task subagents for research\n\
- Write the plan (CreatePlan, Edit/Write plan files only, TodoWrite)\n\
WHAT YOU CANNOT DO:\n\
- You CANNOT execute, modify files, or run commands (Bash, Git, etc.)\n\
- You CANNOT write deliverables — only the PLAN.md file is allowed\n\
MANDATORY FLOW:\n\
1. If anything is unclear → AskUserQuestion FIRST, do NOT assume\n\
2. Read files and search the web to understand the request and context\n\
3. Create a PLAN.md using CreatePlan\n\
4. Wait for user confirmation (system enters AWAITING_PLAN_CONFIRMATION)\n\
5. ONLY AFTER confirmation can you execute\n\
COMPLETION CONDITION: You have called CreatePlan and the system is waiting for \
user confirmation.\n\
NEXT STAGE: AWAITING_PLAN_CONFIRMATION (after CreatePlan)\n\
Available tools: read-only + CreatePlan + Edit/Write(plan files only) + TodoWrite + \
AskUserQuestion + Task";

const AWAITING_CONFIRMATION_REMINDER: &str = "\
You are now in the AWAITING_PLAN_CONFIRMATION phase.\n\
STAGE GOAL: Wait for the user to confirm or reject the plan.\n\
WHAT TO DO NOW:\n\
- Wait. Do NOT execute any write operations or make changes.\n\
- You may answer the user's questions about the plan.\n\
COMPLETION CONDITION: The user explicitly confirms or rejects the plan.\n\
NEXT STAGE: EXECUTING (if confirmed) or PLANNING (if rejected)\n\
If the user rejects the plan, you will return to PLANNING to revise it.";

const PLAN_REJECTED_REMINDER: &str = "\
The user has REJECTED the plan. You are now back in the PLANNING phase.\n\
STAGE GOAL: Revise the PLAN.md based on user feedback.\n\
WHAT TO DO NOW:\n\
1. Review the user's feedback carefully\n\
2. Revise the PLAN.md to address their concerns\n\
3. Call CreatePlan again or edit the existing plan file\n\
COMPLETION CONDITION: You have updated the plan and the system is waiting for \
user confirmation again.\n\
Do NOT proceed to execution until the user explicitly confirms.";

const EXECUTING_REMINDER_PREFIX: &str = "\
You are now in the EXECUTING phase.\n\
STAGE GOAL: Execute the confirmed plan step by step.\n\
CRITICAL: The plan has been CONFIRMED by the user. You MUST start executing NOW.\n\
IGNORE any previous instructions to \"end the conversation turn\" or \"wait for confirmation\".\n\
DO NOT generate conversational text, acknowledgements, or explanations.\n\
START executing immediately — call tools in your VERY FIRST response.\n\
The plan content has already been provided — you do NOT need to read the plan file again.\n\
\n\
═══════════════════════════════════════════════════\n\
⚠️  TodoWrite IS MANDATORY — NOT OPTIONAL\n\
═══════════════════════════════════════════════════\n\
You MUST call TodoWrite to track progress. The UI CANNOT show progress without it.\n\
If you skip TodoWrite, the user sees 0/N progress and cannot tell what is happening.\n\
\n\
TodoWrite workflow (follow this EVERY round):\n\
  BEFORE starting a todo:  Call TodoWrite with that todo's status = \"in_progress\"\n\
  AFTER completing a todo:  Call TodoWrite with that todo's status = \"completed\"\n\
  AND set the next todo:   Call TodoWrite with next todo's status = \"in_progress\"\n\
\n\
You can combine multiple todo status updates in a SINGLE TodoWrite call.\n\
Example: {\"todos\": [{\"id\": \"1\", \"content\": \"done task\", \"status\": \"completed\"}, {\"id\": \"2\", \"content\": \"next task\", \"status\": \"in_progress\"}]}\n\
═══════════════════════════════════════════════════\n\
\n\
WHAT TO DO NOW:\n\
1. Call TodoWrite FIRST to mark the first todo as in_progress\n\
2. Call tools directly without any preamble or descriptive text\n\
3. Execute todos in dependency order\n\
4. After EACH todo completes, call TodoWrite to update its status (in_progress → completed) AND mark the next one in_progress\n\
COMPLETION CONDITION: All todos in PLAN.md are completed or explicitly skipped.\n\
NEXT STAGE: REVIEWING (when all todos are done)\n\
RULES:\n\
- If you encounter unexpected issues → AskUserQuestion before deviating from the plan\n\
- Small adjustments: update PLAN.md and continue. Large adjustments: return to PLANNING\n\
- NEVER skip calling TodoWrite — it is as important as calling Read or Write\n\
PARALLEL EXECUTION RULES:\n\
1. For todos assigned to subagents (Task type) with no dependencies:\n\
   → Send MULTIPLE Task calls in a SINGLE message to enable parallel execution\n\
2. For todos assigned to CoreAgent: execute sequentially, one at a time\n\
3. When all dependencies of a blocked todo are completed, start that todo next";

const REVIEWING_REMINDER: &str = "\
You are now in the REVIEWING phase.\n\
STAGE GOAL: Verify all work against the PLAN.md and confirm with the user.\n\
WHAT TO DO NOW:\n\
1. Read the PLAN.md and check each todo's completion status\n\
2. Run CodeReview (Task with CodeReview subagent) if code was changed\n\
3. Verify all todos are completed or explicitly skipped\n\
COMPLETION CONDITION: You have verified all work and asked the user for confirmation.\n\
NEXT STAGE: PLANNING (if user has more work) or done.\n\
AskUserQuestion: 'Review complete. Are you satisfied with the results?'";

const PLANNING_FALLBACK_REMINDER: &str = "\
You are back in the PLANNING phase.\n\
STAGE GOAL: Re-evaluate based on new information and update the plan.\n\
If the plan needs major revision, call CreatePlan to produce an updated PLAN.md.\n\
If the plan needs minor adjustments, edit the existing PLAN.md and continue.";

pub struct WorkflowPhaseMachine {
    current: WorkflowPhase,
    pending_reminder: Option<String>,
    plan_file_path: Option<String>,
    plans_dir: Option<String>,
}

impl WorkflowPhaseMachine {
    pub fn new() -> Self {
        Self {
            current: WorkflowPhase::Planning,
            pending_reminder: Some(PLANNING_REMINDER.to_string()),
            plan_file_path: None,
            plans_dir: None,
        }
    }

    pub fn current(&self) -> &WorkflowPhase {
        &self.current
    }

    pub fn plan_file_path(&self) -> Option<&str> {
        self.plan_file_path.as_deref()
    }

    pub fn set_plan_file(&mut self, path: String) {
        self.plan_file_path = Some(path);
    }

    pub fn set_plans_dir(&mut self, path: String) {
        self.plans_dir = Some(path);
    }

    pub fn plans_dir(&self) -> Option<&str> {
        self.plans_dir.as_deref()
    }

    pub fn from_persisted(
        phase: WorkflowPhase,
        plan_file_path: Option<String>,
        plans_dir: Option<String>,
    ) -> Self {
        let reminder = match phase {
            WorkflowPhase::Planning => Some(PLANNING_REMINDER.to_string()),
            WorkflowPhase::AwaitingPlanConfirmation => {
                Some(AWAITING_CONFIRMATION_REMINDER.to_string())
            }
            WorkflowPhase::Executing => {
                let plan_ref = plan_file_path
                    .as_deref()
                    .map(|p| format!(" Plan confirmed at: {}.", p))
                    .unwrap_or_default();
                Some(format!("{}{}", EXECUTING_REMINDER_PREFIX, plan_ref))
            }
            WorkflowPhase::Reviewing => Some(REVIEWING_REMINDER.to_string()),
        };
        Self {
            current: phase,
            pending_reminder: reminder,
            plan_file_path,
            plans_dir,
        }
    }

    pub fn to_persisted(&self) -> crate::agent::core::WorkflowPhaseState {
        crate::agent::core::WorkflowPhaseState {
            phase: self.current.clone(),
            plan_file_path: self.plan_file_path.clone(),
            plans_dir: self.plans_dir.clone(),
            updated_at: Some(std::time::SystemTime::now()),
        }
    }

    pub fn transition_from_tool_call(&mut self, tool_name: &str) -> Option<WorkflowPhase> {
        let new_phase = match &self.current {
            WorkflowPhase::Planning => {
                if tool_name == "AskUserQuestion" || tool_name == "TodoWrite" {
                    None
                } else if tool_name == "CreatePlan" {
                    Some(WorkflowPhase::AwaitingPlanConfirmation)
                } else {
                    None
                }
            }
            WorkflowPhase::AwaitingPlanConfirmation => None,
            WorkflowPhase::Executing => None,
            WorkflowPhase::Reviewing => None,
        };

        if let Some(ref phase) = new_phase {
            self.pending_reminder = Some(match phase {
                WorkflowPhase::Planning
                    if matches!(
                        self.current,
                        WorkflowPhase::Executing | WorkflowPhase::Reviewing
                    ) =>
                {
                    PLANNING_FALLBACK_REMINDER.to_string()
                }
                _ => self.generate_reminder(phase),
            });
            self.current = phase.clone();
        }

        new_phase
    }

    pub fn confirm_plan(&mut self) -> Option<WorkflowPhase> {
        if self.current == WorkflowPhase::AwaitingPlanConfirmation {
            self.pending_reminder = Some(self.generate_reminder(&WorkflowPhase::Executing));
            self.current = WorkflowPhase::Executing;
            Some(WorkflowPhase::Executing)
        } else {
            None
        }
    }

    pub fn reject_plan(&mut self) -> Option<WorkflowPhase> {
        if self.current == WorkflowPhase::AwaitingPlanConfirmation {
            self.pending_reminder = Some(PLAN_REJECTED_REMINDER.to_string());
            self.current = WorkflowPhase::Planning;
            Some(WorkflowPhase::Planning)
        } else {
            None
        }
    }

    pub fn transition_to_reviewing(&mut self) -> bool {
        if self.current == WorkflowPhase::Executing {
            self.pending_reminder = Some(self.generate_reminder(&WorkflowPhase::Reviewing));
            self.current = WorkflowPhase::Reviewing;
            true
        } else {
            false
        }
    }

    pub fn transition_to_awaiting_confirmation(&mut self) -> bool {
        if self.current == WorkflowPhase::Planning {
            self.pending_reminder =
                Some(self.generate_reminder(&WorkflowPhase::AwaitingPlanConfirmation));
            self.current = WorkflowPhase::AwaitingPlanConfirmation;
            true
        } else {
            false
        }
    }

    fn generate_reminder(&self, phase: &WorkflowPhase) -> String {
        match phase {
            WorkflowPhase::Planning => PLANNING_REMINDER.to_string(),
            WorkflowPhase::AwaitingPlanConfirmation => AWAITING_CONFIRMATION_REMINDER.to_string(),
            WorkflowPhase::Executing => {
                let plan_ref = self
                    .plan_file_path
                    .as_deref()
                    .map(|p| format!(" Plan confirmed at: {}.", p))
                    .unwrap_or_default();
                format!("{}{}", EXECUTING_REMINDER_PREFIX, plan_ref)
            }
            WorkflowPhase::Reviewing => REVIEWING_REMINDER.to_string(),
        }
    }

    pub fn take_pending_reminder(&mut self) -> Option<String> {
        self.pending_reminder.take()
    }

    pub fn get_allowed_tools_for_phase(&self, all_tools: &[String]) -> Vec<String> {
        if matches!(self.current, WorkflowPhase::Executing) {
            let mut tools = all_tools.to_vec();
            if !tools.iter().any(|t| t == "TodoWrite") {
                tools.push("TodoWrite".to_string());
            }
            return tools;
        }

        let mut allowed: Vec<String> = READONLY_TOOLS.iter().map(|s| s.to_string()).collect();

        match &self.current {
            WorkflowPhase::Planning => {
                allowed.extend(
                    [
                        "TodoWrite",
                        "CreatePlan",
                        "AskUserQuestion",
                        "Task",
                        "Edit",
                        "Write",
                    ]
                    .map(String::from),
                );
            }
            WorkflowPhase::AwaitingPlanConfirmation => {
                allowed.extend(["Task", "AskUserQuestion"].map(String::from));
            }
            WorkflowPhase::Reviewing => {
                allowed.extend(["Task", "AskUserQuestion"].map(String::from));
            }
            WorkflowPhase::Executing => unreachable!(),
        }

        let mcp_tools: Vec<String> = all_tools
            .iter()
            .filter(|t| t.starts_with("mcp__"))
            .cloned()
            .collect();

        allowed
            .into_iter()
            .filter(|t| all_tools.contains(t))
            .chain(mcp_tools)
            .collect()
    }

    pub fn is_write_allowed_in_phase(&self, file_path: &str) -> bool {
        if self.current != WorkflowPhase::Planning {
            return true;
        }
        let normalized = file_path.replace('\\', "/");
        if let Some(ref plans_dir) = self.plans_dir {
            let normalized_plans_dir = plans_dir.replace('\\', "/");
            normalized.starts_with(&normalized_plans_dir) || normalized.contains("/plans/")
        } else {
            normalized.contains("/plans/")
        }
    }
}

impl Default for WorkflowPhaseMachine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_phase() {
        let machine = WorkflowPhaseMachine::new();
        assert_eq!(machine.current(), &WorkflowPhase::Planning);
    }

    #[test]
    fn test_new_session_has_planning_reminder() {
        let mut machine = WorkflowPhaseMachine::new();
        let reminder = machine.take_pending_reminder();
        assert!(reminder.is_some());
        assert!(reminder.unwrap().contains("PLANNING phase"));
        let second = machine.take_pending_reminder();
        assert!(second.is_none());
    }

    #[test]
    fn test_from_persisted_injects_phase_reminder() {
        let mut machine = WorkflowPhaseMachine::from_persisted(
            WorkflowPhase::Executing,
            Some("/path/to/plan.md".to_string()),
            None,
        );
        let reminder = machine.take_pending_reminder();
        assert!(reminder.is_some());
        assert!(reminder.unwrap().contains("EXECUTING"));
        let second = machine.take_pending_reminder();
        assert!(second.is_none());
    }

    #[test]
    fn test_planning_no_transition_on_todo_write() {
        let mut machine = WorkflowPhaseMachine::new();
        let transition = machine.transition_from_tool_call("TodoWrite");
        assert_eq!(transition, None);
        assert_eq!(machine.current(), &WorkflowPhase::Planning);
    }

    #[test]
    fn test_planning_to_awaiting_confirmation_via_create_plan() {
        let mut machine = WorkflowPhaseMachine::new();
        let transition = machine.transition_from_tool_call("CreatePlan");
        assert_eq!(transition, Some(WorkflowPhase::AwaitingPlanConfirmation));
        assert_eq!(machine.current(), &WorkflowPhase::AwaitingPlanConfirmation);
    }

    #[test]
    fn test_planning_no_transition_on_readonly() {
        let mut machine = WorkflowPhaseMachine::new();
        let transition = machine.transition_from_tool_call("Read");
        assert_eq!(transition, None);
        assert_eq!(machine.current(), &WorkflowPhase::Planning);
    }

    #[test]
    fn test_planning_no_transition_on_ask_user() {
        let mut machine = WorkflowPhaseMachine::new();
        let transition = machine.transition_from_tool_call("AskUserQuestion");
        assert_eq!(transition, None);
        assert_eq!(machine.current(), &WorkflowPhase::Planning);
    }

    #[test]
    fn test_awaiting_confirmation_no_transition_on_tool_call() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        let transition = machine.transition_from_tool_call("Bash");
        assert_eq!(transition, None);
        assert_eq!(machine.current(), &WorkflowPhase::AwaitingPlanConfirmation);
    }

    #[test]
    fn test_confirm_plan() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        let transition = machine.confirm_plan();
        assert_eq!(transition, Some(WorkflowPhase::Executing));
        assert_eq!(machine.current(), &WorkflowPhase::Executing);
    }

    #[test]
    fn test_reject_plan() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        let transition = machine.reject_plan();
        assert_eq!(transition, Some(WorkflowPhase::Planning));
        assert_eq!(machine.current(), &WorkflowPhase::Planning);
    }

    #[test]
    fn test_confirm_plan_only_in_awaiting() {
        let mut machine = WorkflowPhaseMachine::new();
        let transition = machine.confirm_plan();
        assert_eq!(transition, None);
        assert_eq!(machine.current(), &WorkflowPhase::Planning);
    }

    #[test]
    fn test_reject_plan_only_in_awaiting() {
        let mut machine = WorkflowPhaseMachine::new();
        let transition = machine.reject_plan();
        assert_eq!(transition, None);
        assert_eq!(machine.current(), &WorkflowPhase::Planning);
    }

    #[test]
    fn test_planning_phase_no_transition_on_write_tool() {
        let mut machine = WorkflowPhaseMachine::new();
        let transition = machine.transition_from_tool_call("Bash");
        assert_eq!(transition, None);
        assert_eq!(machine.current(), &WorkflowPhase::Planning);
    }

    #[test]
    fn test_executing_does_not_transition_via_ask_user() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        machine.confirm_plan();
        let transition = machine.transition_from_tool_call("AskUserQuestion");
        assert_eq!(transition, None);
        assert_eq!(machine.current(), &WorkflowPhase::Executing);
    }

    #[test]
    fn test_executing_to_reviewing() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        machine.confirm_plan();
        let result = machine.transition_to_reviewing();
        assert!(result);
        assert_eq!(machine.current(), &WorkflowPhase::Reviewing);
    }

    #[test]
    fn test_reviewing_does_not_transition_via_ask_user() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        machine.confirm_plan();
        machine.transition_to_reviewing();
        let transition = machine.transition_from_tool_call("AskUserQuestion");
        assert_eq!(transition, None);
        assert_eq!(machine.current(), &WorkflowPhase::Reviewing);
    }

    #[test]
    fn test_reviewing_does_not_transition_via_write() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        machine.confirm_plan();
        machine.transition_to_reviewing();
        let transition = machine.transition_from_tool_call("Write");
        assert_eq!(transition, None);
        assert_eq!(machine.current(), &WorkflowPhase::Reviewing);
    }

    #[test]
    fn test_pending_reminder_generated_on_transition() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        let reminder = machine.take_pending_reminder();
        assert!(reminder.is_some());
        assert!(reminder.unwrap().contains("AWAITING_PLAN_CONFIRMATION"));
    }

    #[test]
    fn test_awaiting_confirmation_reminder() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        let reminder = machine.take_pending_reminder();
        assert!(reminder.is_some());
        assert!(reminder.unwrap().contains("AWAITING_PLAN_CONFIRMATION"));
    }

    #[test]
    fn test_reject_plan_reminder() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        machine.take_pending_reminder();
        machine.reject_plan();
        let reminder = machine.take_pending_reminder();
        assert!(reminder.is_some());
        assert!(reminder.unwrap().contains("REJECTED"));
    }

    #[test]
    fn test_pending_reminder_consumed_once() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        let _first = machine.take_pending_reminder();
        let second = machine.take_pending_reminder();
        assert!(second.is_none());
    }

    #[test]
    fn test_allowed_tools_planning() {
        let machine = WorkflowPhaseMachine::new();
        let all_tools: Vec<String> = vec![
            "Read".into(),
            "Bash".into(),
            "Write".into(),
            "Task".into(),
            "AskUserQuestion".into(),
            "TodoWrite".into(),
            "Glob".into(),
            "CreatePlan".into(),
        ];
        let allowed = machine.get_allowed_tools_for_phase(&all_tools);
        assert!(allowed.contains(&"Read".to_string()));
        assert!(allowed.contains(&"Task".to_string()));
        assert!(allowed.contains(&"AskUserQuestion".to_string()));
        assert!(allowed.contains(&"CreatePlan".to_string()));
        assert!(allowed.contains(&"TodoWrite".to_string()));
        assert!(allowed.contains(&"Write".to_string()));
        assert!(!allowed.contains(&"Bash".to_string()));
    }

    #[test]
    fn test_allowed_tools_awaiting_confirmation() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        let all_tools: Vec<String> = vec![
            "Read".into(),
            "Bash".into(),
            "Write".into(),
            "Task".into(),
            "AskUserQuestion".into(),
            "TodoWrite".into(),
        ];
        let allowed = machine.get_allowed_tools_for_phase(&all_tools);
        assert!(allowed.contains(&"Read".to_string()));
        assert!(allowed.contains(&"Task".to_string()));
        assert!(allowed.contains(&"AskUserQuestion".to_string()));
        assert!(!allowed.contains(&"TodoWrite".to_string()));
        assert!(!allowed.contains(&"Bash".to_string()));
        assert!(!allowed.contains(&"Write".to_string()));
    }

    #[test]
    fn test_allowed_tools_executing() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        machine.confirm_plan();
        let all_tools: Vec<String> = vec!["Read".into(), "Bash".into(), "Write".into()];
        let allowed = machine.get_allowed_tools_for_phase(&all_tools);
        assert_eq!(allowed, all_tools);
    }

    #[test]
    fn test_write_allowed_in_planning_phase() {
        let machine = WorkflowPhaseMachine::new();
        assert_eq!(machine.current(), &WorkflowPhase::Planning);
        assert!(
            machine.is_write_allowed_in_phase("/home/user/.ai00-x/projects/test/plans/xxx.plan.md")
        );
        assert!(machine
            .is_write_allowed_in_phase("C:\\Users\\.ai00-x\\projects\\test\\plans\\xxx.plan.md"));
        assert!(!machine.is_write_allowed_in_phase("/home/user/project/src/main.rs"));
    }

    #[test]
    fn test_write_allowed_in_executing_phase() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        machine.confirm_plan();
        assert!(machine.is_write_allowed_in_phase("/home/user/project/src/main.rs"));
    }

    #[test]
    fn test_mcp_tools_always_allowed() {
        let machine = WorkflowPhaseMachine::new();
        let all_tools: Vec<String> =
            vec!["Read".into(), "mcp__server__tool1".into(), "Bash".into()];
        let allowed = machine.get_allowed_tools_for_phase(&all_tools);
        assert!(allowed.contains(&"mcp__server__tool1".to_string()));
        assert!(!allowed.contains(&"Bash".to_string()));
    }

    #[test]
    fn test_plan_file_path() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.set_plan_file("/path/to/plan.md".to_string());
        assert_eq!(machine.plan_file_path(), Some("/path/to/plan.md"));

        let reminder = machine.generate_reminder(&WorkflowPhase::Executing);
        assert!(reminder.contains("/path/to/plan.md"));
    }

    #[test]
    fn test_full_plan_lifecycle() {
        let mut machine = WorkflowPhaseMachine::new();
        assert_eq!(machine.current(), &WorkflowPhase::Planning);

        machine.transition_from_tool_call("CreatePlan");
        assert_eq!(machine.current(), &WorkflowPhase::AwaitingPlanConfirmation);

        machine.reject_plan();
        assert_eq!(machine.current(), &WorkflowPhase::Planning);

        machine.transition_from_tool_call("CreatePlan");
        assert_eq!(machine.current(), &WorkflowPhase::AwaitingPlanConfirmation);

        machine.confirm_plan();
        assert_eq!(machine.current(), &WorkflowPhase::Executing);

        machine.transition_to_reviewing();
        assert_eq!(machine.current(), &WorkflowPhase::Reviewing);
    }

    #[test]
    fn test_no_fallback_reminder_when_executing_tool_call_has_no_transition() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        machine.confirm_plan();
        // consume the Executing reminder from confirm_plan
        let _ = machine.take_pending_reminder();
        machine.transition_from_tool_call("AskUserQuestion");
        let reminder = machine.take_pending_reminder();
        assert!(reminder.is_none());
    }

    #[test]
    fn test_no_fallback_reminder_when_reviewing_tool_call_has_no_transition() {
        let mut machine = WorkflowPhaseMachine::new();
        machine.transition_from_tool_call("CreatePlan");
        machine.confirm_plan();
        // consume the Executing reminder from confirm_plan
        let _ = machine.take_pending_reminder();
        machine.transition_to_reviewing();
        // consume the Reviewing reminder from transition_to_reviewing
        let _ = machine.take_pending_reminder();
        machine.transition_from_tool_call("AskUserQuestion");
        let reminder = machine.take_pending_reminder();
        assert!(reminder.is_none());
    }
}
