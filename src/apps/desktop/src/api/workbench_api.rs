//! Workbench host-side API.
//!
//! Commands backing the host-side session integration declared in
//! `参考/2026-11-07-工作台插件规范.md` §6.2:
//! - `workbench_prepare_project` — 解析/创建工作台的**固定总工作目录**、
//!   确保工作台自己的 `AGENTS.md`、解析/创建项目子目录，并写入项目级
//!   `AGENTS.local.md`（宿主生成，供 dsh standard preset 注入 system 段）。
//!
//! 目录约定（每类工作台一个总目录，每个项目一个子目录）：
//! - `wallpaper`：总目录 `<exe_dir>/workspaces/wallpaper`，项目
//!   `<root>/projects/<projectId>`（目录由壁纸服务创建，宿主只解析）。
//! - 其他工作台：总目录 `{data_dir}/Ai00-X/workbenches/<dataDir>`，
//!   项目 `<root>/<projectId>`（宿主按需创建）。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::api::app_state::AppState;
use ai00_x_core::wallpaper::service as wallpaper_service;

/// Slug guard: project ids / dataDir names must stay path-safe.
fn is_safe_slug(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 工作台总目录 + 项目工作目录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchProjectContext {
    /// 工作台固定总工作目录（承载 `AGENTS.md`）。
    pub workbench_root: String,
    /// 本次会话的工作目录（项目子目录）。
    pub project_root: String,
}

/// 工作台没有声明 `workbench.agentInstructions` 时的兜底骨架。
fn default_workbench_agents(title: &str, workbench_id: &str) -> String {
    format!(
        "# {title} 工作台约定（{workbench_id}）\n\n\
本文件是「{title}」这一类工作台的固定 agent.md，由 Ai00-X 宿主在首次运行时生成；\n\
可以直接编辑，宿主只在文件缺失时重建，不会覆盖你的修改。\n\n\
## 目录约定\n\n\
- 工作台总目录：本文件所在目录。\n\
- 每个项目占一个子目录，AI 会话的工作目录是该子目录，而不是总目录。\n\n\
## 通用约定\n\n\
- 只在当前项目子目录内创建/修改文件；越界写入会被宿主直接拒绝。\n\
- 产物保持可独立打开：不依赖 CDN 或外部网络资源。\n\
- 完成改动后同步更新项目内的说明文件（README 等）。\n"
    )
}

/// 写入（或读取）工作台总目录的 `AGENTS.md`；已存在则原样返回，不覆盖。
fn ensure_workbench_agents(
    root: &Path,
    title: &str,
    workbench_id: &str,
    declared: Option<&str>,
) -> Result<String, String> {
    let file = root.join("AGENTS.md");
    if let Ok(existing) = std::fs::read_to_string(&file) {
        if !existing.trim().is_empty() {
            return Ok(existing);
        }
    }
    let content = match declared.map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => text.to_string(),
        None => default_workbench_agents(title, workbench_id),
    };
    std::fs::write(&file, &content)
        .map_err(|e| format!("Failed to write workbench AGENTS.md: {e}"))?;
    Ok(content)
}

/// 统一交付流程（规划 → 执行 → 验收）规约段。
///
/// 与前端 `agent/orchestrator/promptParts.ts` 的 `WORKBENCH_LOOP_RULES` 同一份
/// 语义：宿主写进 `AGENTS.local.md` 是为了让**每一轮**会话都受约束，而不只是
/// 首条 prompt。文案定位是「在既有约定之上追加」，不覆盖工作台/插件自己的
/// 工具说明（R2）。
fn loop_rules_section(task_id: Option<&str>) -> String {
    let plan_hint = match task_id {
        Some(id) => format!("ai00_plan_write (taskId: \"{id}\")"),
        None => "ai00_plan_write (taskId from the first task brief)".to_string(),
    };
    format!(
        "## Delivery workflow (Ai00-X loop)\n\n\
Before any step write the plan with {plan_hint}, using exactly these sections: \"## Execution Policy\" (`- Execution: local-first`, `- Review: adaptive`), \"## Goal\", \"## Steps\", \"## Acceptance\", \"## Deliverables\". Plan body in the user's language; headings and keys stay English. Each step: `- [ ] T1 title` with `Depends on`, `Risk` (low/medium/high), `Scope` (paths), `Implementation`, `Acceptance` ({{cmd: ...}}). `Implementation` must name the worker tier once, chosen by the tools the step needs: reading/inspection → `local_reader`; creating or overwriting one file whose content is already given in the brief → `local_writer`; running commands or tests → `local_cmd`; a step needing several tools → `local_code_worker`; assembly of section files → `assemble`; document polish → `polish`; document deliverables → the cloud `code_worker` (a local draft is allowed only when the cloud owns the final revision); a long document (>= ~1500 chars) is split per rule 9 into one step per section, each `local_compose` (host tool, no worker) — a plan that leaves a whole-document step on a local tier is self-contradictory. Planning and self-check are never steps. Acceptance must assert CONTENT — a required section, keyword, fact or citation (e.g. grep/node check that the heading and a topic keyword exist). Never use word or character counts, and never file length, as an acceptance check: length gates fail good drafts and pass filler. Length is a soft hint in the brief, not a gate. Put each command inside {{cmd: …}} at the END of its line (nothing after the closing brace), under 500 ASCII characters, with no backticks and no $( ) — the first word must be one of cargo/rustc/pnpm/npm/npx/node/python/python3/uv/git/go/dotnet; anything else is never executed and silently becomes a manual check. Deliverable file names in \"## Deliverables\" must be exactly the names workers will produce (integration verify fails when one is missing). Keep the plan compact — Goal at most 3 sentences, one short line per step field, no restating the user brief or these rules (plan length is generation time the user waits on).\n\
1. Approval gate (hard stop): after writing the plan, end the turn and wait — never dispatch a worker in the same turn as the plan write; continue only after the user confirms.\n\
2. Dispatch: pick the tier by the tools the step needs (`local_reader` = read/glob/grep/read_image + ai00_text_summarize (long files), `local_writer` = write+read, `local_cmd` = pwsh+read, `local_code_worker` = mixed, `local_compose` = one long-document section, a host tool per rule 9, `assemble` = ai00_assemble host tool, `polish` = ai00_polish host tool) — brief in English, self-contained (goal, scope, files, acceptance commands, working directory, return format). Workers cannot see this session or the plan: every brief must carry its own material; never restate the whole plan or step list in `prompt` — that is duplicated output paid twice. Keep a brief under ~250 words; if it needs more, the step is too big — split it. Every brief must open with the plan step it executes (`Step T2: <title>`) and may reference only files inside that step's `Scope` — if you catch yourself writing another project's paths, scripts or config that the plan never mentions, that is hallucination: discard the draft and rewrite from the plan before dispatching. Worker tools take exactly one argument: `prompt` (required string) plus optional `description` — never pass cwd/command/taskId as tool arguments. Never dispatch a writer before the material it must write exists: embed the upstream findings verbatim in the brief (a writer with no input ends its turn doing nothing). Document deliverables — a whole document written in one pass (a step whose `Scope` lists output documents .md/.txt/.json/.csv/.html) — are owned by the cloud `code_worker`: it writes or revises the final file. A local draft is optional there: dispatch `local_writer` first to write the final-named file as a draft (the brief must carry the exact content or a concrete outline), then dispatch the cloud `code_worker` to read it, revise it in place with `edit`, and verify — the cloud must own the final bytes, and such a step whose last writer was a local tier never counts as done. If the draft is empty, `BLOCKED:` or off-topic, skip straight to the cloud write. A local draft plus its cloud revision counts as ONE attempt on that step, not a failure escalation. Even one short page can fail the local 3B writer as a single write (实测 979 字节的一次性写入连败两轮，留下空文件), so a one-pass local write is never the deliverable. Exception: a step that expands ONE section of a long document authored by rule 9 is owned by `ai00_local_compose`. Long-form authoring (above ~1500 chars or multi-chapter) is never a single cloud write either — split it with rule 9. If the approved plan's `Implementation` names a local tier for a whole-document step, that plan instruction is a defect: this rule wins — dispatch the cloud `code_worker` anyway and note the deviation in your summary. Never call file/terminal/network tools yourself. Parallel only when dependency is none and scopes do not overlap. Never call `wait_agent` to poll for workers: after dispatching, end the turn and let each subagent-settled notice wake you. Research steps: tell research_worker to collect sources with ONE `ai00_research_collect` call (`topic`, optional <=8 short English `queries`, `save_to`) — never pass a working directory or a filesystem path, and never hand a small local model a \"search ten times then summarize\" loop. It may leave one notes file; anything needing several files, code edits or commands goes to code_worker. End every brief with: delete any scratch files you create (probe scripts, partials, temp notes) before returning — only the step Scope files may remain; write throwaway output under the system temp directory.\n\
3. Evidence gate: call `ai00_task_verify` after every worker run — only once that step's own subagent-settled notice has arrived (when workers run in parallel, verify each step after its own notice; verifying a sibling early sees a missing file and burns the dispatch budget with a false failure). Never trust self-reports (`includeDiff` for strict/high risk/fallback). Pass `tick: true` when you expect a pass — the step is then ticked in the same call (one round trip; only acceptance lines still need ai00_plan_check). A worker result with no artifact and no tool evidence is a failed dispatch, not progress — do not tick the step and do not relay it as success. A worker reply that starts with `BLOCKED:` is a failed dispatch: escalate to the next model tier within the dispatch budget. If the step's `Scope` files come back missing or 0 bytes, the verdict is needs-review — have the worker rewrite them before ticking. Loose local gate: if the worker was a local tier (`local_*`) and the verdict is needs-review or failed, do not retry local and do not send the step to the reviewer — escalate it to the cloud `code_worker` to finish or repair it (cloud tolerance beats local strictness).\n\
4. Review: adaptive — low/medium risk with verdict=passed may be checked off; strict or high risk go through review_worker. Output produced by a local tier and judged needs-review is never reviewed locally: escalate it to the cloud `code_worker` instead. review_worker only judges and may write ONE review record (e.g. review.md); applying fixes to the report is a code_worker job, never the reviewer's.\n\
5. Dispatch budget (hard, per step): at most 3 attempts for each T step, failed attempts included. A failed attempt by a local tier (`local_*`) escalates to the cloud `code_worker` immediately — local output is not worth a strict retry loop; repair the brief for that cloud attempt. A failed cloud attempt may be retried once with a repaired brief (attempt 3); after that mark the step `BLOCKED`, keep going with the remaining steps and offer a degraded delivery. An empty artifact, an empty write or a `BLOCKED:` reply escalates straight to the cloud `code_worker` on any attempt — never retry the same tier after an empty result. The budget resets for every step — never let one step consume the whole task. A failure (transport error, empty result, missing deliverable) never justifies resending the same brief. Briefs are closed-scope — never ask a worker to \"verify the overall state\" or \"review and improve\".\n\
6. Search: `ai00_research_collect` for a research step (one call writes the notes file); `ai00_web_extract` for a single lookup (`url` = page body, `query` = search + per-page summaries). Never paste a source longer than ~6000 chars into a local brief and expect exact facts — local 3B long-context recall is ~30% at 12k versus 100% when the host extracts first. For any long text whose facts matter, call `ai00_text_summarize` with `focus` = the concrete question or keyword (the host appends matching source sentences even when the model summary misses them), then answer from the returned summary; for a long file on disk use `ai00_text_summarize` with `path` (+ the same `focus`) so the host reads it from the session working directory — never inline a long file body in arguments; research briefs must tell the worker to pass that same `focus` (and `path` for file inputs).\n\
7. Wrap-up: call `ai00_task_verify` without stepId to re-run the global \"## Acceptance\" (it also re-runs every step acceptance command as regression and reports `regression`), confirm deliverables exist, then `ai00_task_complete` with absolute paths (rejects while acceptance items are unticked) and report summary + deliverables. Plain-text acceptance items are judged by the human in the board — do not invent new commands for them. Completion is granted by the human. A 0-byte deliverable counts as missing — both ai00_task_verify and ai00_task_complete reject it; have the worker write long files in chunks and merge, never accept an empty file as done.\n\
8. Plan upkeep (cheap): to tick or untick step/acceptance lines call `ai00_plan_check {{taskId, match}}` — or `{{taskId, matches: [...]}}` to tick several lines in ONE call (the 3–4 \"## Acceptance\" items after the integration verify belong in one call, not one per item). Never rewrite the whole document for a status change (a full rewrite is 2–3k output tokens; the check is a few dozen). Use `ai00_plan_write` only for structural edits (new steps, changed scope or acceptance wording). Editing the goal, the step list or any acceptance wording after the plan was approved resets the approval: the write succeeds, but end the turn at once and wait for the human to approve again — never loosen an acceptance item to make it pass. Do not re-read the plan just to update it.\n\
9. Long documents (>= ~1500 chars): local map-reduce authoring. ① Compose each section with `ai00_local_compose` (host tool, no worker dispatch): one call per section, up to 8 calls in the same turn (parallel allowed); plan each section step with `Implementation: local_compose` and `Scope: section-<n>.md`. Args: `file_path: section-<n>.md`; `heading` = the exact heading text without `##`; `topic` = one sentence in the target document language; `language` = the language the user asked for (never forced Chinese). The local model writes only the body text; the host prepends `## <heading>` and writes the file — never ask a small model to carry a whole paragraph inside tool-call JSON, and never dispatch `local_writer` for a section. ② Check each result: `{{ok:false}}` (empty or clearly garbled local output — wrong language, prompt echo, garbage symbols) means that section alone escalates to the cloud `code_worker` (rule 5) to rewrite the same file; sections that passed stay local. If a composed section fails its step acceptance content check, do not dispatch a reader/inspector subagent — dispatch the cloud `code_worker` to rewrite that same section file. ③ Assemble deterministically with `ai00_assemble` (host tool; plan the step with `Implementation: assemble`): `{{output: report.md, sections: [section-1.md, …]}}` concatenates in the given order, deletes the section files and returns the heading list — never write a node one-liner and never dispatch `local_cmd` for assembly. ④ Polish with `ai00_polish` (host tool, cloud model; plan the step with `Implementation: polish`): it rewrites the assembled file, keeps every `## ` heading, validates before an atomic write, and leaves the draft untouched on failure — never dispatch a `code_worker` to rewrite a document. If it returns ok:false, fix the draft or escalate that document alone; only the polished file is the deliverable. The split keeps authoring local: do not hand sections to the cloud pre-emptively.\n"
    )
}

/// 快速问答模式（工作台任务勾选「快速问答」）：不写计划、不派子代理、不落文件。
///
/// 这类任务走完整 loop 会把一次问答膨胀成十几次模型调用（实测 26 分钟），
/// 所以宿主写入的 `AGENTS.local.md` 也要换掉整段 loop 规约，而不是让首轮
/// 任务书孤军作战——否则每一轮会话都会被合约拉回计划模式。
fn quick_rules_section() -> String {
    "## Quick answer mode (Ai00-X workbench)\n\n\
This task is a quick question. Answer it directly in this chat.\n\
- Do NOT write a plan, do NOT call ai00_plan_write, do NOT spawn subagents, do NOT create files, do NOT ask for approval.\n\
- Use ai00_web_extract (query = web search + per-page summaries) only when the answer needs fresh facts; keep it to at most 3 tool calls and read as few pages as possible.\n\
- Reply in the user's UI language, concise and grounded; when web results were used, cite the source URLs inline.\n\
- If the question actually needs files or multi-step delivery, say so in one sentence and suggest switching the task to 完整交付 (delivery mode) — never start the heavy flow on your own.\n"
        .to_string()
}

/// 项目级 `AGENTS.local.md`：宿主生成块 + 工作台约定的内联副本。
///
/// 内联而非引用，是因为 workbench preset 把指令根发现止于工程子目录
/// （`projectRootMarkers = ['AGENTS.local.md']`），不会向上读取总目录的
/// `AGENTS.md`。
fn compose_project_agents(opts: &ComposeOptions<'_>) -> String {
    let project_label = match opts.project_title.filter(|t| !t.trim().is_empty()) {
        Some(title) => format!("{title}（id: {}）", opts.project_id),
        None => opts.project_id.to_string(),
    };
    format!(
        "# Ai00-X 工作台会话约定（宿主生成，请勿手改）\n\n\
本会话由 Ai00-X 工作台「{workbench_title}」（id: {workbench_id}）创建并绑定到工程 {project_label}。\n\n\
- 工作台总目录：`{workbench_root}`\n\
- 工程根路径（本会话工作目录）：`{project_root}`\n\
- 写入范围：只允许读写该工程根路径之内；越界写入会被宿主拒绝（path_out_of_scope），工程外资料只读引用、产物写回根内。\n\n\
## 工作台约定\n\n\
{workbench_agents}\n\n\
{loop_rules}\n",
        workbench_title = opts.workbench_title,
        workbench_id = opts.workbench_id,
        project_label = project_label,
        workbench_root = opts.workbench_root.display(),
        project_root = opts.project_root.display(),
        workbench_agents = opts.workbench_agents.trim(),
        loop_rules = if opts.quick_mode {
            quick_rules_section()
        } else {
            loop_rules_section(opts.task_id)
        },
    )
}

struct ComposeOptions<'a> {
    workbench_id: &'a str,
    workbench_title: &'a str,
    workbench_root: &'a Path,
    project_id: &'a str,
    project_title: Option<&'a str>,
    project_root: &'a Path,
    workbench_agents: &'a str,
    /// 工作台任务卡 id（内置任务场景有；插件工作台新建会话时由宿主补登）。
    task_id: Option<&'a str>,
    /// 快速问答任务：用精简规约替换整段交付 loop。
    quick_mode: bool,
}

/// Resolve the workbench root and its project subdirectory, then make sure both
/// the workbench-level `AGENTS.md` and the project-level `AGENTS.local.md` exist.
// 参数逐个平铺是 Tauri 命令的惯例（前端按字段名 invoke），打包成结构体会让
// 调用方多套一层；这里按既有约定豁免参数个数检查。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn workbench_prepare_project(
    _state: State<'_, AppState>,
    workbench_id: String,
    data_dir_name: Option<String>,
    workbench_title: Option<String>,
    agent_instructions: Option<String>,
    project_id: String,
    project_title: Option<String>,
    task_id: Option<String>,
    // 'quick' = 快速问答（精简规约，不写计划/不派子代理）；缺省/其它 = 完整交付。
    execution_mode: Option<String>,
    // 外部项目目录（工作台「项目」工作台）：给定时直接使用该已存在目录，
    // 不建目录、不写 AGENTS.local.md——避免污染用户已有工程。
    project_root: Option<String>,
) -> Result<WorkbenchProjectContext, String> {
    if !is_safe_slug(&project_id) {
        return Err(format!("Invalid project id '{project_id}'"));
    }
    let title = workbench_title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| workbench_id.clone());

    // 外部项目目录分支：完全跳过宿主目录生成与 AGENTS.local.md 落盘，
    // loop 约束仍由会话首轮任务书注入。
    if let Some(dir) = project_root.filter(|d| !d.trim().is_empty()) {
        let external = PathBuf::from(dir.trim());
        if !external.is_absolute() {
            return Err(format!(
                "Project root must be absolute: {}",
                external.display()
            ));
        }
        if !external.is_dir() {
            return Err(format!(
                "Project root does not exist or is not a directory: {}",
                external.display()
            ));
        }
        let shown = external.to_string_lossy().to_string();
        return Ok(WorkbenchProjectContext {
            workbench_root: shown.clone(),
            project_root: shown,
        });
    }

    let (root, resolved_project) = if workbench_id == "wallpaper" {
        let workspaces_root = ai00_x_core::infrastructure::PathManager::exe_dir()
            .map_err(|e| e.to_string())?
            .join("workspaces");
        let root = wallpaper_service::workspace_wallpaper_dir(&workspaces_root);
        let projects = wallpaper_service::list_workspace_projects(&workspaces_root)
            .map_err(|e| e.to_string())?;
        let project = projects
            .into_iter()
            .find(|p| p.id == project_id)
            .and_then(|p| p.project_path)
            .ok_or_else(|| format!("project-root-not-found:{project_id}"))?;
        (root, Some(PathBuf::from(project)))
    } else {
        let data_dir_name = data_dir_name
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| workbench_id.clone());
        if !is_safe_slug(&data_dir_name) {
            return Err(format!("Invalid workbench dataDir '{data_dir_name}'"));
        }
        // plugins_dir() = {data_dir}/Ai00-X/plugins → parent = {data_dir}/Ai00-X.
        let root = crate::api::plugin_api::plugins_dir()
            .parent()
            .ok_or_else(|| "Failed to resolve Ai00-X data dir".to_string())?
            .join("workbenches")
            .join(&data_dir_name);
        (root, None)
    };

    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create workbench root {}: {e}", root.display()))?;
    let workbench_agents =
        ensure_workbench_agents(&root, &title, &workbench_id, agent_instructions.as_deref())?;

    let project_root = resolved_project.unwrap_or_else(|| root.join(&project_id));
    std::fs::create_dir_all(&project_root).map_err(|e| {
        format!(
            "Failed to create project root {}: {e}",
            project_root.display()
        )
    })?;

    let content = compose_project_agents(&ComposeOptions {
        workbench_id: &workbench_id,
        workbench_title: &title,
        workbench_root: &root,
        project_id: &project_id,
        project_title: project_title.as_deref(),
        project_root: &project_root,
        workbench_agents: &workbench_agents,
        task_id: task_id.as_deref(),
        quick_mode: execution_mode.as_deref() == Some("quick"),
    });
    let local = project_root.join("AGENTS.local.md");
    let unchanged = std::fs::read_to_string(&local)
        .map(|existing| existing == content)
        .unwrap_or(false);
    if !unchanged {
        std::fs::write(&local, content)
            .map_err(|e| format!("Failed to write AGENTS.local.md: {e}"))?;
    }

    Ok(WorkbenchProjectContext {
        workbench_root: root.to_string_lossy().to_string(),
        project_root: project_root.to_string_lossy().to_string(),
    })
}
