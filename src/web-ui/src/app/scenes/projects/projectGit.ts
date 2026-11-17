/**
 * projectGit — 项目目录的 Git 只读探测与轻操作（对齐 ZCode：工作区级分支，不是任务级）。
 *
 * 分工：引擎只认会话 cwd，不认识分支；宿主这一层负责把「项目现在在哪条分支、
 * 有没有未提交改动」显示出来，并在建任务前守住主干分支（P3）。
 */
import { gitAPI, type GitBranch } from '@/infrastructure/api/service-api/GitAPI';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';

/** 项目 Git 快照（每次探测都是只读，不改工作区）。 */
export interface ProjectGitState {
  isRepo: boolean;
  /** 当前分支；非 git 仓库为空串。 */
  branch: string;
  /** 有未提交改动（暂存/未暂存/未跟踪/冲突任一）。 */
  dirty: boolean;
}

/** 视为「主干」的分支：在这些分支上直接让 Agent 动手风险最高。 */
const TRUNK_BRANCHES = new Set(['main', 'master', 'trunk']);

export const EMPTY_GIT_STATE: ProjectGitState = { isRepo: false, branch: '', dirty: false };

export function isTrunkBranch(branch: string): boolean {
  return TRUNK_BRANCHES.has(branch.trim().toLowerCase());
}

/** 读项目 Git 快照；任何失败（非仓库/无权限/Git 缺失）都归为「未纳入 git」。 */
export async function readProjectGit(dir: string): Promise<ProjectGitState> {
  if (!dir) return EMPTY_GIT_STATE;
  try {
    if (!(await gitAPI.isGitRepository(dir))) return EMPTY_GIT_STATE;
    const status = await gitAPI.getStatus(dir);
    const dirty =
      status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length >
      0;
    return { isRepo: true, branch: status.current_branch || 'HEAD', dirty };
  } catch {
    return EMPTY_GIT_STATE;
  }
}

export async function listLocalBranches(dir: string): Promise<GitBranch[]> {
  try {
    return await gitAPI.getBranches(dir, false);
  } catch {
    return [];
  }
}

/**
 * 切分支。不做自动提交：未提交改动由 Git 一并带走，冲突时 Git 自己拒绝切换
 * （宿主只负责提前告知，不替用户决定要不要提交）。
 */
export async function switchProjectBranch(dir: string, branch: string): Promise<void> {
  const result = await gitAPI.checkoutBranch(dir, branch);
  if (!result.success) {
    throw new Error(result.error || result.message || 'checkout failed');
  }
}

/** 任务分支名：`ai00/<英文摘要>`，摘要取不到时退回任务 id 尾段。 */
export function taskBranchName(title: string, taskId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return `ai00/${slug || taskId.slice(-6)}`;
}

/** 生成不与现有分支重名的任务分支名（重名依次加 `-2`、`-3`）。 */
async function uniqueBranchName(dir: string, title: string, taskId: string): Promise<string> {
  const existing = new Set((await listLocalBranches(dir)).map((b) => b.name));
  const base = taskBranchName(title, taskId);
  let name = base;
  for (let i = 2; existing.has(name); i += 1) name = `${base}-${i}`;
  return name;
}

/**
 * 为任务新建并切换到独立分支（`git checkout -b`，未提交改动会一并带到新分支，
 * 因此不需要先 commit）。
 */
export async function createTaskBranch(dir: string, title: string, taskId: string): Promise<string> {
  const name = await uniqueBranchName(dir, title, taskId);
  const result = await gitAPI.createBranch(dir, name);
  if (!result.success) {
    throw new Error(result.error || result.message || 'create branch failed');
  }
  return name;
}

/**
 * 把 `<repo>/.tasks/` 写进 `.git/info/exclude`（幂等）。
 *
 * worktree 目录建在仓库内（后端约定 `<repo>/.tasks/<branch>`），不排除的话用户
 * 自己的 `git status` 会多出一条未跟踪目录。用 `info/exclude` 而不是 `.gitignore`，
 * 是为了不往用户仓库里塞文件。
 */
async function ensureTasksExcluded(repoDir: string): Promise<void> {
  const root = repoDir.replace(/[\\/]+$/, '');
  const excludePath = `${root}/.git/info/exclude`;
  let current = '';
  try {
    current = await workspaceAPI.readFileContent(excludePath);
  } catch {
    current = '';
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === '.tasks/' || line.trim() === '.tasks')) {
    return;
  }
  const prefix = current && !current.endsWith('\n') ? `${current}\n` : current;
  try {
    await workspaceAPI.writeFileContent(root, excludePath, `${prefix}.tasks/\n`);
  } catch {
    // 排除失败不影响隔离执行本身（只是用户 git status 里多一条目录）
  }
}

/** 项目未纳入 git 时无法做 worktree 隔离。 */
export class WorktreeUnavailableError extends Error {
  readonly dir: string;

  constructor(dir: string) {
    super('worktree-unavailable');
    this.name = 'WorktreeUnavailableError';
    this.dir = dir;
  }
}

/**
 * 为任务创建独立 worktree（`<repo>/.tasks/<分支目录>`），返回该目录与新分支名。
 * 分支从仓库当前 HEAD 切出，主干分支本身不动。
 */
export async function createIsolatedWorktree(
  repoDir: string,
  title: string,
  taskId: string,
): Promise<{ path: string; branch: string }> {
  const git = await readProjectGit(repoDir);
  if (!git.isRepo) throw new WorktreeUnavailableError(repoDir);
  await ensureTasksExcluded(repoDir);
  const branch = await uniqueBranchName(repoDir, title, taskId);
  const info = await gitAPI.addWorktree(repoDir, branch, true);
  if (!info?.path) throw new Error('worktree path missing');
  return { path: info.path, branch: info.branch ?? branch };
}

/** 删除任务的 worktree：脏目录会被 Git 拒绝（force=false 是刻意的护栏）。 */
export async function releaseWorktree(repoDir: string, worktreePath: string): Promise<void> {
  await gitAPI.removeWorktree(repoDir, worktreePath, false);
}

/** 主干分支守卫：命中时由宿主弹窗决定「开分支 / 照旧 / 取消」。 */
export const TRUNK_DECISIONS = ['branch', 'proceed', 'cancel'] as const;
export type TrunkDecision = (typeof TRUNK_DECISIONS)[number];

export class TrunkBranchError extends Error {
  readonly branch: string;
  readonly dir: string;

  constructor(branch: string, dir: string) {
    super(`trunk-branch:${branch}`);
    this.name = 'TrunkBranchError';
    this.branch = branch;
    this.dir = dir;
  }
}
