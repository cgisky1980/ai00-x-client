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
  hasPlanDoc = true,
  /** 计划正文是否真的嵌进了本条提示词（决定能否要求模型「不要为载入而 plan_read」）。 */
  planEmbedded = true,
): string => {
  // 新任务（无计划）只允许「写计划 → 停」。此前这里也写「先读计划再派发」，
  // 与 loop 的批准闸口直接矛盾：模型 plan_write 完就顺势派了子代理，
  // 人类确认变成事后队列消息（2026-11-20 实测 session-215065cf）。
  if (!hasPlanDoc) {
    return `- Planning phase (this turn only): this task has NO plan yet. Call ai00_plan_write (taskId: "${taskId}") with the complete plan (sections, T-numbered steps, acceptance, deliverables per the loop contract), then END this turn — reply with a 3–6 line plan summary and wait. Do NOT call ai00_plan_read first (there is nothing to read), do NOT dispatch any worker (research_worker / local_code_worker / code_worker) in the same turn as the plan write, and do NOT call ai00_task_complete. Dispatching before the user confirms the plan is a protocol violation.`;
  }
  if (localFirst) {
    const planHint = planEmbedded
      ? `the plan is ALREADY in this prompt — do not call ai00_plan_read just to load it (only when this prompt says the plan was truncated, or after the user edits the plan)`
      : `start with ai00_plan_read (taskId: "${taskId}") to load the full plan`;
    return `- Execution protocol (you orchestrate; you never execute yourself): ${planHint}. Dispatch "## Steps" by T id and dependencies. Default to local_code_worker (local model); only after a second local failure or when a cloud fix is clearly needed, dispatch code_worker. Dispatch research_worker for investigation: it collects sources with ONE ai00_research_collect call (topic + optional queries + save_to; the host resolves the working directory) and may produce exactly one notes file — never ask it to modify code or run commands; anything needing many files, edits or commands goes to code_worker. Dispatch in parallel only when "Depends on: none" and scopes do not overlap. Every brief must state: goal and acceptance criteria, boundaries, relevant files and context, implementation details, acceptance commands, and the expected return format — workers cannot see this conversation, so each brief must be self-contained. The host already prepends the plan to every brief: never restate plan text or step lists in the brief, and keep it under ~250 words. **Write every subagent brief in English** (paths, identifiers and quoted user text may stay as-is). After each local worker run, call ai00_task_verify for real evidence; for strict mode, high risk or needs-review, dispatch review_worker on the evidence.`;
  }
  const planHint = planEmbedded
    ? `the plan is ALREADY in this prompt — do not call ai00_plan_read just to load it (only when this prompt says the plan was truncated, or after the user edits the plan)`
    : `start with ai00_plan_read (taskId: "${taskId}") to load the full plan`;
  return `- Execution protocol (you orchestrate; you never execute yourself): ${planHint}. Split "## Steps" into dispatchable subtasks. Dispatch research_worker for investigation: it collects sources with ONE ai00_research_collect call and may produce exactly one notes file (never ask it to modify code or run commands); code_worker handles implementation, execution and every other file write. Dispatch independent subtasks in the same reply. Every brief must state: goal and acceptance criteria, boundaries, relevant files and context, and the expected return format — workers cannot see this conversation, so each brief must be self-contained. The host already prepends the plan to every brief: never restate plan text or step lists in the brief, and keep it under ~250 words. **Write every subagent brief in English** (paths, identifiers and quoted user text may stay as-is).`;
};

/** 子代理完成通知处理（有计划文档时注入）。 */
export const DELEGATE_SUBAGENT_NOTIFY = (localFirst = false): string =>
  localFirst
    ? '- Subagent completion notice: the notice only means the turn ended, not that the task succeeded. First call ai00_task_verify for that step to get real evidence (commands, changed files, diff when needed). Only when verdict=passed and risk is low/medium, flip the matching "## Steps" item with ai00_plan_check (match = the step id, e.g. "T2") — do not rewrite the whole plan for a status change. On failed or needs-review, send local_code_worker back to rework once; if it fails again, fall back to code_worker. Intent-only replies ("I will…", "ready to…"), missing artifacts, or "[tool] …" calls simulated in prose all count as not done.'
    : '- Subagent completion notice: the notice only means the turn ended, not that the task succeeded. Check the stop reason, actual tool results and deliverables first; dispatch code_worker when verification is needed. Only after confirming completion, flip the matching "## Steps" item with ai00_plan_check (match = the step id) — full ai00_plan_write is only for structural edits — and record the result plus remaining risks. Intent-only replies, missing artifacts, or "[tool] …" calls simulated in prose all count as not done — dispatch code_worker to rework and state the problem.';

/** 人类验收打回时发回会话的固定话术（对话内退回与详情页退回共用一份）。 */
export const buildRejectPrompt = (reason: string): string =>
  `[Acceptance rejected] ${reason}. The acceptance checklist in the plan has been reset to unchecked — overall acceptance is red again, so re-submitting ai00_task_complete without new work will be refused. Re-read the plan with ai00_plan_read; if the rejection changes requirements or the approach, update the plan first. Then fix the deliverables, re-run ai00_task_verify, and only re-tick the acceptance lines you have actually satisfied (batch them with ai00_plan_check {matches: [...]}).`;

/** 长耗时操作预告（有计划文档时注入）。 */
export const DELEGATE_LONG_OP_NOTICE =
  '- Long-running operations (builds/training/downloads, expected > 2 minutes): after the subagent-start notice, tell the user the expected duration (e.g. "about 20 minutes") before continuing — the user plans their check-ins around that estimate.';

/** 后台命令引导（有计划文档时注入；策执行流程审视 §2.6 的任务书引导）。 */
export const DELEGATE_BG_COMMAND_NOTICE =
  '- Long commands: in every execution brief, remind the worker to run anything expected to exceed 2 minutes in the background via pwsh run_in_background: true — that returns a job id immediately, the engine notifies on completion, and job_output reads the output. Never let long commands block the foreground.';

/** 边界一：计划优先铁律（有计划文档时注入）。 */
export const DELEGATE_BOUNDARY_PLAN_FIRST =
  '- Plan-first (hard rule): any message arriving during execution that changes requirements, approach, steps or acceptance criteria must first be written into the plan (ai00_plan_read → ai00_plan_write updating "## Steps" / "## Acceptance"), then re-dispatched from the updated plan — the plan is the single source of truth. Pure status flips (step done/undone) are not structural: use ai00_plan_check (match = step id), never a full rewrite. Pure acknowledgements or nudges need no plan change: just answer briefly. When you yourself spot a needed change, same rule: update the plan, then dispatch.';

/** 边界二：新想法落想法池、不私自扩范围。 */
export const DELEGATE_BOUNDARY_IDEA_POOL = (taskId: string): string =>
  `- New subtasks or ideas discovered while executing go to the idea pool via ai00_task_create (optionally sourceTaskId: "${taskId}", goalId to attach the goal) — never stuff them into the current plan's step list and never expand scope on your own.`;

/** 完工三步（收尾段；与 dsh-plugins/tools 验收拒绝文案口径同步）。 */
export const DELEGATE_COMPLETION_THREE_STEP = (taskId: string, cwd: string | null): string =>
  `When every subagent has finished and each acceptance item is confirmed (human criteria ticked "- [x]" in the plan), finish with the three-step wrap-up: ① Materialize the deliverables — every artifact promised by "## Deliverables" must exist as a real file under the working directory (have subagents fill any gaps); even pure research/consulting tasks must leave a summary file (e.g. report.md). ② Call ai00_task_complete to submit the self-check (taskId: "${taskId}"${cwd ? `, snapshotDir: "${cwd}" — it git-snapshots the working directory automatically, do not commit manually` : ''}) and pass deliverables (absolute paths of the artifacts, required); the tool rejects the call while acceptance items are unticked. ③ After submitting, report in the session: conclusion summary (≤200 chars) + deliverables list (file name + one line) + awaiting-review notice. The task then enters human acceptance: completion is granted only when the user clicks approve in this workbench's task panel (no separate window), but the report and deliverables list must still be given proactively.`;

/** 快速问答任务书（工作台「快速问答」模式：不写计划、不派子代理、不落文件）。 */
export const QUICK_TASK_RULES = [
  '## Quick answer mode (Ai00-X workbench)',
  'This task is a quick question. Answer it directly in this chat.',
  '- Do NOT write a plan, do NOT call ai00_plan_write, do NOT spawn subagents, do NOT create files, do NOT ask for approval.',
  '- Use ai00_web_extract (query = web search + per-page summaries) only when the answer needs fresh facts; keep it to at most 3 tool calls and read as few pages as possible.',
  "- Reply in the user's UI language, concise and grounded; when web results were used, cite the source URLs inline.",
  '- If the question actually needs files or multi-step delivery, say so in one sentence and suggest switching the task to 完整交付 (delivery mode) — never start the heavy flow on your own.',
].join('\n');

/**
 * 统一 loop 契约（工作台 AGENTS.local.md 追加段；提示词保持英文）。
 *
 * 2026-11-20 压缩：每轮都会进上下文，长文案直接变成每轮固定成本。
 * 与宿主 `apps/desktop/src/api/workbench_api.rs::loop_rules_section` 同一份口径，
 * 改一处必须同步另一处。
 */
export const WORKBENCH_LOOP_RULES = (taskId: string): string =>
  [
    '## Delivery workflow (Ai00-X loop)',
    '',
    `Before any step write the plan with ai00_plan_write (taskId: "${taskId}"), using exactly these sections: "## Execution Policy" (\`- Execution: local-first\`, \`- Review: adaptive\`), "## Goal", "## Steps", "## Acceptance", "## Deliverables". Plan body in the user's language; headings and keys stay English. Each step: \`- [ ] T1 title\` with \`Depends on\`, \`Risk\` (low/medium/high), \`Scope\` (paths), \`Implementation\`, \`Acceptance\` ({cmd: ...}). Planning and self-check are never steps. Acceptance must assert CONTENT — a required section, table or citation (e.g. grep/node check that the heading exists) — never only character counts or file length: a length-only check is satisfied by filler and hides missing or misnamed deliverables. Deliverable file names in "## Deliverables" must be exactly the names workers will produce (integration verify fails when one is missing).`,
    '1. Approval gate (hard stop): after writing the plan, end the turn and wait — never dispatch a worker in the same turn as the plan write; continue only after the user confirms.',
    '2. Dispatch: local_code_worker by default — brief in English, self-contained (goal, scope, files, acceptance commands, working directory, return format). The host already prepends the plan (goal, steps, acceptance) to every brief: never restate plan text or step lists in `prompt` — that is duplicated output paid twice. Keep a brief under ~250 words; if it needs more, the step is too big — split it. Every brief must open with the plan step it executes (`Step T2: <title>`) and may reference only files listed in that step `Scope` — if you catch yourself writing another project paths, scripts or config that the plan never mentions, that is hallucination: discard the draft and rewrite from the plan before dispatching. Worker tools take exactly one argument: `prompt` (required string) plus optional `description` — never pass cwd/command/taskId as tool arguments. Never dispatch a writer before the material it must write exists: embed the upstream findings verbatim in the brief (a writer with no input ends its turn doing nothing). Long-form authoring (a report or document longer than ~1500 chars, or multi-chapter) goes to the cloud `code_worker` from the FIRST attempt — a local 3B writer degenerates into repeated characters, malformed tool arguments and empty files; `local_code_worker` is for short files (≤ ~120 lines), edits and commands. Never call file/terminal/network tools yourself. Parallel only when dependency is none and scopes do not overlap. Research steps: tell research_worker to collect sources with ONE `ai00_research_collect` call (`topic`, optional <=8 short English `queries`, `save_to`) — never pass a working directory or a filesystem path, and never hand a small local model a "search ten times then summarize" loop. It may leave one notes file; anything needing several files, code edits or commands goes to code_worker.',
    '3. Evidence gate: call ai00_task_verify after every worker run; never trust self-reports (includeDiff for strict/high risk/fallback). Pass `tick: true` when you expect a pass — the step is then ticked in the same call (one round trip; only acceptance lines still need ai00_plan_check). A worker result with no artifact and no tool evidence is a failed dispatch, not progress — do not tick the step and do not relay it as success. A worker reply that starts with `BLOCKED:` is a failed dispatch: escalate to the next model tier within the dispatch budget.',
    '4. Review: adaptive — low/medium risk with verdict=passed may be checked off; strict, high risk or needs-review go through review_worker. review_worker only judges and may write ONE review record (e.g. review.md); applying fixes to the report is a code_worker job, never the reviewer\'s.',
    '5. Dispatch budget (hard, per step): at most 3 attempts for each T step, failed attempts included. Attempt 1 fails → repair the brief and retry once; attempt 2 fails → escalate to the cloud `code_worker`; attempt 3 fails → mark that step `BLOCKED`, keep going with the remaining steps and offer a degraded delivery. The budget resets for every step — never let one step consume the whole task. A failure (transport error, empty result, missing deliverable) never justifies resending the same brief. Briefs are closed-scope — never ask a worker to "verify the overall state" or "review and improve".',
    '6. Search: `ai00_research_collect` for a research step (one call writes the notes file); `ai00_web_extract` for a single lookup (`url` = page body, `query` = search + per-page summaries).',
    '7. Wrap-up: call ai00_task_verify without stepId to re-run the global "## Acceptance", confirm deliverables exist, then ai00_task_complete with absolute paths (rejects while acceptance items are unticked) and report summary + deliverables. Completion is granted by the human.',
    '8. Plan upkeep (cheap): to tick or untick step/acceptance lines call `ai00_plan_check` {taskId, match} — or {taskId, matches: [...]} to tick several lines in ONE call (the 3–4 "## Acceptance" items after the integration verify belong in one call, not one per item). Never rewrite the whole document for a status change (a full rewrite is 2–3k output tokens; the check is a few dozen). Use ai00_plan_write only for structural edits (new steps, changed scope or acceptance wording). Do not re-read the plan just to update it.',
  ].join('\n');
