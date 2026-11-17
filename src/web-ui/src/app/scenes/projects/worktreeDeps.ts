/**
 * worktreeDeps — 隔离 worktree 的依赖与本地配置准备。
 *
 * 调研结论（2026-11，含本机实测）：
 * - **依赖树不共享**：每个 worktree 自己的 `node_modules`，靠包管理器的内容寻址 store
 *   把"重装"变成建链接（pnpm 实测：3 个依赖 1.5s / 1518 个硬链接 / 磁盘几乎不涨）。
 * - **共享目录是数据破坏**：把 worktree 的 `node_modules` junction 到主仓库后，在
 *   worktree 里跑一次 `pnpm install` 会把主仓库的 `node_modules` 直接 prune 掉
 *   （实测：主 checkout 只剩 `.pnpm`，`require('lodash')` 直接 MODULE_NOT_FOUND）。
 * - **本地配置靠复制**：`.worktreeinclude`（与 Claude Code / VS Code 约定一致）逐条
 *   复制到 worktree；缺省 `.env` / `.env.local` / `.env.development`。
 */
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { getTerminalService } from '@/tools/terminal/services/TerminalService';

export type DepsManager = 'pnpm' | 'bun' | 'yarn' | 'npm' | 'uv' | 'poetry' | 'none';

export interface DepsPlan {
  manager: DepsManager;
  /** null = 没有可识别的依赖清单，不用装。 */
  command: string | null;
}

/** 锁文件 → 安装命令。顺序即优先级（同一目录多锁文件时取第一个）。 */
const LOCKFILE_PLANS: Array<{ file: string; plan: DepsPlan }> = [
  {
    file: 'pnpm-lock.yaml',
    // pnpm 从全局 store 硬链接，新 worktree 基本只是建链接
    plan: { manager: 'pnpm', command: 'pnpm install --frozen-lockfile --prefer-offline' },
  },
  { file: 'bun.lock', plan: { manager: 'bun', command: 'bun install' } },
  { file: 'bun.lockb', plan: { manager: 'bun', command: 'bun install' } },
  { file: 'yarn.lock', plan: { manager: 'yarn', command: 'yarn install --immutable' } },
  // npm 是唯一"真复制整棵树"的，慢且吃盘
  { file: 'package-lock.json', plan: { manager: 'npm', command: 'npm ci' } },
  { file: 'uv.lock', plan: { manager: 'uv', command: 'uv sync' } },
  { file: 'poetry.lock', plan: { manager: 'poetry', command: 'poetry install' } },
];

/** 读锁文件识别包管理器；识别不到返回 `none`（不猜、不装）。 */
export async function detectDepsPlan(repoDir: string): Promise<DepsPlan> {
  for (const entry of LOCKFILE_PLANS) {
    if (await workspaceAPI.pathExists(`${repoDir}/${entry.file}`)) return entry.plan;
  }
  return { manager: 'none', command: null };
}

/** 没有 `.worktreeinclude` 时默认带上的本地配置。 */
const DEFAULT_INCLUDE = ['.env', '.env.local', '.env.development'];

async function readIncludePatterns(repoDir: string): Promise<string[]> {
  try {
    const raw = await workspaceAPI.readFileContent(`${repoDir}/.worktreeinclude`);
    const patterns = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.includes('*'));
    if (patterns.length) return patterns.slice(0, 40);
  } catch {
    // 没有该文件：走默认清单
  }
  return DEFAULT_INCLUDE;
}

/** 把本地配置（.env 之类）复制进 worktree；只复制确实存在的文件，逐条容错。 */
export async function copyLocalConfig(
  repoDir: string,
  worktreePath: string,
): Promise<string[]> {
  const patterns = await readIncludePatterns(repoDir);
  const copied: string[] = [];
  for (const pattern of patterns) {
    const from = `${repoDir}/${pattern}`;
    if (!(await workspaceAPI.pathExists(from))) continue;
    try {
      const content = await workspaceAPI.readFileContent(from);
      await workspaceAPI.writeFileContent(worktreePath, `${worktreePath}/${pattern}`, content);
      copied.push(pattern);
    } catch {
      // 单个文件失败不影响整体准备（可能只是权限/不支持的类型）
    }
  }
  return copied;
}

export interface DepsInstallResult {
  ok: boolean;
  manager: DepsManager;
  /** 失败时的尾部输出（截断后用于提示）。 */
  detail: string;
}

/**
 * 在 worktree 里跑一次依赖安装。失败不抛错——依赖没装好只影响构建，不影响改代码。
 * 走终端会话执行（内核已有的执行通道），跑完立刻关会话。
 */
export async function installWorktreeDeps(
  worktreePath: string,
  plan: DepsPlan,
): Promise<DepsInstallResult> {
  if (!plan.command) return { ok: true, manager: plan.manager, detail: '' };
  const service = getTerminalService();
  let sessionId: string | null = null;
  try {
    const session = await service.createSession({
      name: 'ai00 deps',
      workingDirectory: worktreePath,
    });
    sessionId = session.id;
    const result = await service.executeCommand(sessionId, plan.command, {
      timeoutMs: 15 * 60 * 1000,
      preventHistory: true,
    });
    const ok = (result.exitCode ?? 1) === 0;
    const tail = ok ? '' : result.output.split(/\r?\n/).slice(-12).join('\n').slice(-800);
    return { ok, manager: plan.manager, detail: tail };
  } catch (e) {
    return {
      ok: false,
      manager: plan.manager,
      detail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    if (sessionId) await service.closeSession(sessionId).catch(() => undefined);
  }
}

/** worktree 建好后的一次性准备：复制本地配置（总是）+ 装依赖（按项目开关）。 */
export async function prepareWorktree(
  repoDir: string,
  worktreePath: string,
  options: { installDeps: boolean },
): Promise<{ copied: string[]; deps: DepsInstallResult | null }> {
  const copied = await copyLocalConfig(repoDir, worktreePath);
  if (!options.installDeps) return { copied, deps: null };
  const plan = await detectDepsPlan(repoDir);
  const deps = await installWorktreeDeps(worktreePath, plan);
  return { copied, deps };
}
