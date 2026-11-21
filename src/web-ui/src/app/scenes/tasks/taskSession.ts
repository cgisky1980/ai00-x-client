/**
 * taskSession — 工作台内置「任务」场景的会话绑定与首轮任务书。
 *
 * 每个任务 = 一张 `origin='workbench'` 的 todo 卡 + 一个独立 dsh 会话：
 * 1. 建卡（workbenchId='tasks'）；
 * 2. `workbench_prepare_project` 准备任务子目录与 `AGENTS.local.md`；
 * 3. `createWorkbenchPresetSession` 建 workbench preset 会话；
 * 4. 首条 prompt = 任务书 + 统一 loop 规约；编排者 persona 由 workbench preset 提供。
 *
 * 会话 id 写回 `TodoTask.agentSessionId`，任务场景把选中任务映射成
 * `WorkbenchOpenSessionIntent` 交给 `WorkbenchChatPanel`（面板零新分支）。
 */
import { invoke } from '@tauri-apps/api/core';
import { dshEngine, dshSession } from '@/infrastructure/api/service-api/DshAPI';
import { createWorkbenchPresetSession } from '@/infrastructure/plugins/workbenchSession';
import { WORKBENCH_LOOP_RULES, QUICK_TASK_RULES, DELEGATE_BOOK_TITLE, assembleDelegationPrompt } from '@/agent/orchestrator';
import { applyModelProfile, getActiveProfile } from '@/agent/modelProfiles';
import type { TodoTask, WorkbenchProject } from '@/tools/todo/api/types';
import { useTodoStore } from '@/tools/todo/store/todoStore';
import { TrunkBranchError, createIsolatedWorktree, isTrunkBranch, readProjectGit } from '../projects/projectGit';
import { prepareWorktree } from '../projects/worktreeDeps';

/** 内置任务场景在 rail 中的保留 id（工作台插件 id 不会以 `@` 开头）。 */
export const TASKS_SCENE_ID = '@tasks';

/** 内置任务场景的任务卡归属标记（`TodoTask.workbenchId`）。 */
export const TASKS_WORKBENCH_ID = 'tasks';

export interface TaskWorkspaceContext {
  workbenchRoot: string;
  projectRoot: string;
}

/**
 * 准备任务的工作目录（幂等）：
 * - 默认工作区：`{data}/Ai00-X/workbenches/tasks/<taskId>`，并写入 `AGENTS.local.md`；
 * - 项目任务：直接用项目目录（用户已有工程），宿主不建目录、不写文件。
 */
async function prepareTaskWorkspace(
  taskId: string,
  taskTitle: string,
  workbenchTitle: string,
  project: WorkbenchProject | null,
  executionMode?: 'quick' | 'delivery',
): Promise<TaskWorkspaceContext> {
  await dshEngine.ensureReady();
  return invoke<TaskWorkspaceContext>('workbench_prepare_project', {
    workbenchId: TASKS_WORKBENCH_ID,
    dataDirName: TASKS_WORKBENCH_ID,
    workbenchTitle,
    agentInstructions: null,
    projectId: taskId,
    projectTitle: taskTitle,
    taskId,
    ...(executionMode ? { executionMode } : {}),
    ...(project ? { projectRoot: project.dir } : {}),
  });
}

/**
 * 首轮任务书：任务书四段（+ 未由宿主注入时的 loop 规约）。
 * 角色说明由 preset 系统提示提供。
 *
 * `hostRules` = 宿主已把 loop / 快速问答规约写进工程根的 `AGENTS.local.md`
 * （默认工作区任务）。此时每轮都会注入那份文件，任务书再带一份就是纯重复，
 * 只留一句指路；外部项目目录不写 `AGENTS.local.md`，必须自带完整规约。
 */
export function buildTaskBrief(
  task: Pick<TodoTask, 'id' | 'title' | 'notes' | 'executionMode'>,
  cwd: string,
  hostRules = false,
): string {
  // 快速问答：不写计划、不派子代理、不落文件，直接回答（见 QUICK_TASK_RULES）。
  // 这类任务若走完整 loop，单次问答会膨胀成十几次模型调用、二十多分钟。
  if (task.executionMode === 'quick') {
    const goal = task.notes?.trim() ? `${task.title}\n\n${task.notes.trim()}` : task.title;
    const rules = hostRules ? 'Quick answer mode: follow ./AGENTS.local.md.' : QUICK_TASK_RULES;
    return `${DELEGATE_BOOK_TITLE}\n[GOAL] ${goal}\n\n${rules}`;
  }
  const brief = assembleDelegationPrompt({
    promptPrefix: '',
    rules: '',
    memories: [],
    task: { title: task.title, notes: task.notes },
    planMd: null,
    cwd,
    taskId: task.id,
    hasPlanDoc: false,
    // 工作台新任务默认本地优先 + 自适应云审（组合在模型选择器里按阶段配置）
    execution: 'local-first',
  });
  const loopRules = hostRules
    ? 'Loop contract: see ./AGENTS.local.md (delivery workflow, approval gate, evidence gate).'
    : WORKBENCH_LOOP_RULES(task.id);
  return `${brief}\n\n${loopRules}`;
}

/** 从首句需求派生列表标题；完整需求仍写入 notes 并进入首轮任务书。 */
export function taskTitleFromRequest(request: string): string {
  const firstLine = request.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  const chars = Array.from(firstLine);
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : firstLine;
}

/** 新建工作台任务卡（不建会话）。先确保读过盘——save() 是整份内存落盘。 */
export async function createTask(
  title: string,
  notes?: string,
  projectId?: string,
  executionMode?: 'quick' | 'delivery',
): Promise<TodoTask> {
  if (!useTodoStore.getState().loaded) await useTodoStore.getState().load();
  return useTodoStore.getState().createWorkbenchTask({
    title: title.trim(),
    notes: notes?.trim(),
    workbenchId: TASKS_WORKBENCH_ID,
    ...(projectId ? { projectId } : {}),
    ...(executionMode ? { executionMode } : {}),
  });
}

/** `ensureTaskSession` 的调用方选项。 */
export interface EnsureTaskSessionOptions {
  /** 用户已确认「就在主干分支上执行」，跳过守卫。 */
  allowTrunk?: boolean;
}

/**
 * 决定会话落地在哪个目录：
 * - 项目开启了隔离执行 → 任务专属 worktree（首次现建，`ai00/<摘要>` 分支）；
 * - 否则用项目目录本身，并过主干守卫（worktree 分支天然不在主干上，无需守卫）。
 */
async function resolveTaskRoot(
  task: TodoTask,
  project: WorkbenchProject,
  options: EnsureTaskSessionOptions,
): Promise<WorkbenchProject> {
  if (project.isolate) {
    let worktreePath = task.worktreePath || '';
    if (!worktreePath) {
      const created = await createIsolatedWorktree(project.dir, task.title, task.id);
      worktreePath = created.path;
      useTodoStore.getState().updateTask(task.id, {
        branch: created.branch,
        worktreePath: created.path,
      });
      // 本地配置总是复制；装依赖是项目级开关（默认关，避免跑依赖的 postinstall）
      await prepareWorktree(project.dir, created.path, {
        installDeps: project.autoDeps === true,
      });
    }
    return { ...project, dir: worktreePath };
  }

  if (!options.allowTrunk) {
    const git = await readProjectGit(project.dir);
    if (git.isRepo && isTrunkBranch(git.branch)) {
      throw new TrunkBranchError(git.branch, project.dir);
    }
  }
  return project;
}

/**
 * 确保任务有可用的 dsh 会话：已有 `agentSessionId` 直接复用（cwd 由面板按
 * session/list 反查）；否则准备目录 → 建会话 → 写回任务卡 → 发送首轮任务书。
 * `project` 非空时，会话 cwd 为用户指定的项目目录。
 * `preferredModelRef` 非空时在发首轮任务书前把新会话切到该模型（空态预选）。
 *
 * 主干守卫（P3）：项目停在 main/master/trunk 时抛 `TrunkBranchError`，
 * 由宿主弹窗决定「开分支 / 照旧 / 取消」；确认照旧后带 `allowTrunk` 重入。
 */
export async function ensureTaskSession(
  task: TodoTask,
  workbenchTitle: string,
  project: WorkbenchProject | null = null,
  preferredModelRef: string | null = null,
  options: EnsureTaskSessionOptions = {},
): Promise<{ sessionId: string; cwd: string }> {
  if (task.agentSessionId) {
    // 已绑定的会话也刷新一次宿主注入的 `AGENTS.local.md`：它是每轮进上下文的
    // 常驻文件，规约文案更新后旧任务不刷新就会一直带着过期的长文案。
    // 仅默认工作区走这条路（外部项目目录不写该文件），失败不阻塞。
    if (!project) {
      await prepareTaskWorkspace(task.id, task.title, workbenchTitle, null, task.executionMode).catch(
        () => undefined,
      );
    }
    return { sessionId: task.agentSessionId, cwd: '' };
  }

  const root = project ? await resolveTaskRoot(task, project, options) : null;
  const ctx = await prepareTaskWorkspace(task.id, task.title, workbenchTitle, root, task.executionMode);
  // 建会话前把「当前模型组合」落到四个工人（幂等：模型没变就不写盘、不重启引擎）。
  // 这一步是默认组合生效的唯一保证——新装用户不改设置时，execute 也不会落到
  // 实测产不出文件的本地 RWKV。
  try {
    await applyModelProfile(getActiveProfile());
  } catch {
    // 组合应用失败不阻断任务创建：工人按 md 默认模型继续
  }
  // 按执行模式选 preset：两者插件链一致，工具集按契约裁剪
  // （快速问答不写计划/不派子代理/不落文件 → 只留检索+通知+提问）。
  const agentPreset = task.executionMode === 'quick' ? 'workbench-quick' : 'workbench-task';
  const sessionId = await createWorkbenchPresetSession(ctx.projectRoot, agentPreset);
  useTodoStore.getState().updateTask(task.id, { agentSessionId: sessionId });
  // 主会话模型：用户手动预选优先，否则用组合的「规划」阶段。
  // 不切的话会话停在 Auto（SmartRouter），实测会被路由到 GLM 系，
  // 它把工具调用写成纯文本 → 批准后整轮空转。
  const planModel = preferredModelRef || getActiveProfile().models.plan;
  if (planModel) {
    try {
      await dshSession.selectModel(sessionId, 'ai00-x', planModel);
    } catch {
      // 切模型失败不阻塞任务创建：引擎按默认模型继续
    }
  }
  await dshSession.prompt(sessionId, buildTaskBrief(task, ctx.projectRoot, project === null));
  return { sessionId, cwd: ctx.projectRoot };
}

/**
 * 会话实际挂的 preset（工具面的权威来源）。
 *
 * 不能用 `task.executionMode` 单独判断：旧数据可能根本没有该字段，
 * 而卡片已按 quick 建了会话——实测「今日英伟达股价」就是这种情况，
 * 按 executionMode 走交付提示词会让模型在只有检索工具时会话里空转一轮。
 * 也不能用 `session/list`：它的 `projections` 常为空。查不到就回落到任务字段。
 */
async function sessionPresetOf(sessionId: string): Promise<string> {
  try {
    const values = await dshSession.projections(sessionId);
    return typeof values.agentPreset === 'string' ? values.agentPreset : '';
  } catch {
    return '';
  }
}

/**
 * 「继续执行」的话术与动作统一收口在 `tools/todo/utils/continueRun`（overlay 通知同源）。
 * 这里只做转出，保持既有调用点（计划卡 / 外部触发）不变。
 */
import { buildContinuePrompt } from '@/tools/todo/utils/continueRun';
export { buildContinuePrompt, continueTaskRun } from '@/tools/todo/utils/continueRun';

/**
 * 恢复一次工作台任务的执行（外部触发 / 重跑 / 看板「继续」）。
 *
 * 为什么不能复用 `useAgentDelegate`：那条链路按 `agent` 模块解析 cwd，工作台卡片
 * 不属于任何项目，cwd 会落到默认工作区（甚至弹目录选择框），实机表现为
 * 「`tasks/trigger` 返回 202，但没有任何新会话」。
 *
 * 语义与计划契约一致：计划存在 → 从第一个未勾选步骤继续；计划不存在 → 按 loop
 * 契约先写计划并停机等确认，绝不代用户跳过批准闸口。
 */
export async function resumeTaskRun(task: TodoTask, workbenchTitle: string): Promise<string> {
  // 先对齐执行模式：旧数据可能丢了 executionMode，但会话建的是 quick preset。
  // 不补这一步，`prepareTaskWorkspace` 会把「交付 loop 契约」写进 AGENTS.local.md，
  // 只有检索工具的快速会话每轮都会读到它，于是白转一轮问能不能写计划。
  let resolved = task;
  if (task.agentSessionId) {
    const preset = await sessionPresetOf(task.agentSessionId);
    const mode = preset === 'workbench-quick' ? 'quick' : preset ? 'delivery' : task.executionMode;
    if (mode && mode !== task.executionMode) {
      useTodoStore.getState().updateTask(task.id, { executionMode: mode });
      resolved = { ...task, executionMode: mode };
    }
  }
  const { sessionId } = await ensureTaskSession(resolved, workbenchTitle, null, null, {
    allowTrunk: true,
  });
  const plan = await invoke<string | null>('todo_plan_get', { taskId: task.id }).catch(
    () => null,
  );
  await dshSession.prompt(sessionId, buildContinuePrompt(resolved.executionMode, plan));
  useTodoStore.getState().updateTask(task.id, { status: 'doing' });
  return sessionId;
}
