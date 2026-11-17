/**
 * 编排 loop 提示词基件（策 + 工作台共用一份）。
 *
 * 2026-11-08 从 `tools/todo/ai/prompts.ts` 平移：这些文案不属于「策」这个 UI，
 * 而属于「先规划 → 派子代理执行 → 自检 → 人类验收」的编排契约，工作台任务
 * （默认任务场景 + 插件工作台）复用同一份，避免两份口径漂移。
 *
 * 收口边界不变：dsh-plugins/tools 的 ai00_task_complete 验收拒绝文案留在插件
 * 包内（独立 npm 构建无法 import web-ui 模块），调口径时须与本文件同步。
 */

export const DELEGATE_RULES_HEADER = '【User rules — must follow】';

export const DELEGATE_MEMORY_HEADER = '【User memory — reference only】';

export const DELEGATE_BOOK_TITLE = '════ TASK BRIEF ════';

export const DELEGATE_COMPLETION_TITLE = '════ COMPLETION ════';

/** 交付物缺省口径（计划未写明时；四段「交付物」必填的兜底值）。 */
export const DELEGATE_DELIVERABLE_DEFAULT =
  'Produce at least one summary file (e.g. report.md) — even pure research/consulting tasks must leave a written deliverable. When the plan already declares "## Deliverables", that section wins.';

/** 执行协议（编排者保留职责；收进「工具与资料」段）。 */
export const DELEGATE_PROTOCOL_ORCHESTRATION = (
  taskId: string,
  localFirst = false,
): string => {
  if (localFirst) {
    return `- Execution protocol (you orchestrate; you never execute yourself): start with ai00_plan_read (taskId: "${taskId}") to load the full plan, then dispatch "## Steps" by T id and dependencies. Default to local_code_worker (local model); only after a second local failure or when a cloud fix is clearly needed, dispatch code_worker. Dispatch research_worker for investigation (conclusions only — never ask it to create or modify files). Dispatch in parallel only when "Depends on: none" and scopes do not overlap. Every brief must state: goal and acceptance criteria, boundaries, relevant files and context, implementation details, acceptance commands, and the expected return format — workers cannot see this conversation, so each brief must be self-contained. **Write every subagent brief in English** (paths, identifiers and quoted user text may stay as-is). After each local worker run, call ai00_task_verify for real evidence; for strict mode, high risk or needs-review, dispatch review_worker on the evidence.`;
  }
  return `- Execution protocol (you orchestrate; you never execute yourself): start with ai00_plan_read (taskId: "${taskId}") to load the full plan, then split "## Steps" into dispatchable subtasks. Dispatch research_worker for investigation (conclusions only — never ask it to create or modify files) and code_worker for implementation, execution and file writes (reports and research notes can only be produced by it). Dispatch independent subtasks in the same reply. Every brief must state: goal and acceptance criteria, boundaries, relevant files and context, and the expected return format — workers cannot see this conversation, so each brief must be self-contained. **Write every subagent brief in English** (paths, identifiers and quoted user text may stay as-is).`;
};

/** 子代理完成通知处理（有计划文档时注入）。 */
export const DELEGATE_SUBAGENT_NOTIFY = (localFirst = false): string =>
  localFirst
    ? '- Subagent completion notice: the notice only means the turn ended, not that the task succeeded. First call ai00_task_verify for that step to get real evidence (commands, changed files, diff when needed). Only when verdict=passed and risk is low/medium, flip the matching "## Steps" item to "- [x]". On failed or needs-review, send local_code_worker back to rework once; if it fails again, fall back to code_worker. Intent-only replies ("I will…", "ready to…"), missing artifacts, or "[tool] …" calls simulated in prose all count as not done.'
    : '- Subagent completion notice: the notice only means the turn ended, not that the task succeeded. Check the stop reason, actual tool results and deliverables first; dispatch code_worker when verification is needed. Only after confirming completion, flip the matching "## Steps" item to "- [x]" (full write-back via ai00_plan_write) and record the result plus remaining risks. Intent-only replies, missing artifacts, or "[tool] …" calls simulated in prose all count as not done — dispatch code_worker to rework and state the problem.';

/** 人类验收打回时发回会话的固定话术（对话内退回与详情页退回共用一份）。 */
export const buildRejectPrompt = (reason: string): string =>
  `[Acceptance rejected] ${reason}. Re-read the plan with ai00_plan_read first; if the rejection changes requirements or the approach, update the plan before continuing.`;

/** 长耗时操作预告（有计划文档时注入）。 */
export const DELEGATE_LONG_OP_NOTICE =
  '- Long-running operations (builds/training/downloads, expected > 2 minutes): after the subagent-start notice, tell the user the expected duration (e.g. "about 20 minutes") before continuing — the user plans their check-ins around that estimate.';

/** 后台命令引导（有计划文档时注入；策执行流程审视 §2.6 的任务书引导）。 */
export const DELEGATE_BG_COMMAND_NOTICE =
  '- Long commands: in every execution brief, remind the worker to run anything expected to exceed 2 minutes in the background via pwsh run_in_background: true — that returns a job id immediately, the engine notifies on completion, and job_output reads the output. Never let long commands block the foreground.';

/** 边界一：计划优先铁律（有计划文档时注入）。 */
export const DELEGATE_BOUNDARY_PLAN_FIRST =
  '- Plan-first (hard rule): any message arriving during execution that changes requirements, approach, steps or acceptance criteria must first be written into the plan (ai00_plan_read → ai00_plan_write updating "## Steps" / "## Acceptance"), then re-dispatched from the updated plan — the plan is the single source of truth. Pure acknowledgements or nudges need no plan change: just answer briefly. When you yourself spot a needed change, same rule: update the plan, then dispatch.';

/** 边界二：新想法落想法池、不私自扩范围。 */
export const DELEGATE_BOUNDARY_IDEA_POOL = (taskId: string): string =>
  `- New subtasks or ideas discovered while executing go to the idea pool via ai00_task_create (optionally sourceTaskId: "${taskId}", goalId to attach the goal) — never stuff them into the current plan's step list and never expand scope on your own.`;

/** 完工三步（收尾段；与 dsh-plugins/tools 验收拒绝文案口径同步）。 */
export const DELEGATE_COMPLETION_THREE_STEP = (taskId: string, cwd: string | null): string =>
  `When every subagent has finished and each acceptance item is confirmed (human criteria ticked "- [x]" in the plan), finish with the three-step wrap-up: ① Materialize the deliverables — every artifact promised by "## Deliverables" must exist as a real file under the working directory (have subagents fill any gaps); even pure research/consulting tasks must leave a summary file (e.g. report.md). ② Call ai00_task_complete to submit the self-check (taskId: "${taskId}"${cwd ? `, snapshotDir: "${cwd}" — it git-snapshots the working directory automatically, do not commit manually` : ''}) and pass deliverables (absolute paths of the artifacts, required); the tool rejects the call while acceptance items are unticked. ③ After submitting, report in the session: conclusion summary (≤200 chars) + deliverables list (file name + one line) + awaiting-review notice. The task then enters human acceptance: completion is granted only when the user clicks approve in this workbench's task panel (no separate window), but the report and deliverables list must still be given proactively.`;

/** Unified loop contract (workbench AGENTS.local.md addendum; prompts stay English). */
export const WORKBENCH_LOOP_RULES = (taskId: string): string =>
  [
    '## Delivery workflow (Ai00-X orchestration loop — additive to existing plugin instructions)',
    `Before any step, write the plan with ai00_plan_write (taskId: "${taskId}") using exactly five sections: "## Execution Policy", "## Goal", "## Steps", "## Acceptance", "## Deliverables".`,
    "Write the plan body in the user's current UI language, but keep section headings and field keys exactly as shown here (English keys).",
    'Execution Policy has exactly two lines: `- Execution: local-first` and `- Review: adaptive` (switch to strict when the user asks for per-step cloud review).',
    'Each entry under "## Steps" must be independently dispatchable:',
    '- [ ] T1 one-line title',
    '  - Depends on: none OR T0, T1',
    '  - Risk: low / medium / high',
    '  - Scope: comma separated file paths',
    '  - Implementation: concrete instructions the local model can execute without follow-ups (what to change, how, what NOT to do)',
    '  - Acceptance: objectively checkable criteria {cmd: whitelisted command}',
    'Do not list planning/self-check as steps. Any requirement or scope change updates the plan first and requires human re-approval.',
    '1. Plan approval (hard gate): stop after writing the plan — summarize key points and acceptance criteria only, and tell the user the plan is ready right here in this chat (the approve button renders inline under the plan card; there is no separate plan window). Wait for the user to click it; if the plan is returned, revise it and stop again.',
    '2. Execution: dispatch to local_code_worker by default, with goal, implementation, scope, dependency results, acceptance commands, working directory and a compact return format. **Write every subagent brief in English** — the plan body may stay in the user\'s language, but briefs, constraints and expected return formats must be English so workers receive a consistent instruction format. Run in parallel only when dependency is none AND scopes do not overlap. Never call file/terminal/network tools yourself.',
    '3. Evidence gate: after every local worker run call ai00_task_verify (taskId + snapshotDir + stepId) to actually run the step acceptance and capture evidence; never trust the worker self-report. Pass includeDiff: true for strict, high risk and cloud fallback.',
    '3.1 Search rule: use ai00_search (Ai00-X self-hosted search, no key) for web search; use ai00_web_extract with a url for a specific page body, or with a query for distilled per-page summaries. Put this rule into every research brief.',
    '4. Tiered review: in adaptive mode, low/medium risk with verdict=passed may be checked off immediately without a separate full-diff cloud review. For strict, risk=high, or verdict=needs-review, dispatch review_worker with the evidence package (plus diff when needed) and require "verdict / problems (files and symbols) / minimal rework instructions".',
    '5. Rework and fallback: on verdict=failed or a review rejection, let local_code_worker rework once with the review notes. If it fails again, switch to code_worker (cloud fallback); never loop locally. Fallback results must pass the evidence gate and review too.',
    '6. Integration review: when all steps pass, call ai00_task_verify without stepId to re-run the global "## Acceptance", checking cross-task interfaces, missing criteria and scope creep. Reopen affected steps on failure.',
    '7. Self-check and human acceptance: verify deliverables exist on disk, call ai00_task_complete with the absolute deliverables list, then report a short summary + deliverables + awaiting-review notice. Completion is only granted when the human clicks the accept button in this workbench\'s task panel; never claim the task is done by yourself.',
  ].join('\n');
