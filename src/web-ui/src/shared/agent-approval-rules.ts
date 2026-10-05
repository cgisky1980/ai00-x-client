/**
 * 工具授权记忆——「总是允许」的客户端实现（会话级 + 持久级两层）。
 *
 * 引擎审批词汇只有 allowed-once（每次都问），但应答权在客户端：记住
 * 「本会话 + 工具名」的授权后，后续同类 approval/requested 帧由客户端
 * 自动应答 allowed-once，不再弹卡（TodoOverlay / DshScene / 执行面板 /
 * 会话浮层四处订阅方共用本模块判定）。
 *
 * 两层记忆（R2-11b，2026-09-12）：
 * 1. **会话级**（运行态 Set，随客户端退出消亡）——任意工具可记；
 * 2. **持久级**（localStorage，按「工作区 + 工具名」存盘）——**仅 read 类
 *    工具**可入白名单。安全红线：写类/执行类工具永不持久化，防止一次误点
 *    把「改文件 / 跑命令」的授权永久放开。
 *
 * 工作区解析：approval 帧只带 sessionId，故由 DshAPI 在 session/list 与
 * session/create 时调用 noteSessionWorkspace 回填「会话 → cwd」映射；映射
 * 缺失时只走会话级判定（安全降级，不会误命中持久白名单）。
 */
const allowed = new Set<string>();

/** 会话 → 工作区（cwd）映射；由 DshAPI 回填，仅运行态。 */
const sessionWorkspace = new Map<string, string>();

/** 持久白名单 localStorage 键（带版本，结构变更时换键即可作废旧数据）。 */
const PERSIST_KEY = 'ai00-x.approval-allowlist.v1';

/**
 * read 类工具白名单——与编排架构里 research_worker 的 toolFilter.allow 同源
 * （dsh_manager.rs ensure_orchestration_patch），是该代码库对「只读」的权威定义。
 * 注意：只收真只读工具；写类/执行类（edit/write/bash/pwsh/skill/todo_write 等）
 * 一律不许持久化。
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
]);

export interface PersistentAllowance {
  /** 工作区绝对路径（会话 cwd）。 */
  workspace: string;
  /** 工具名。 */
  tool: string;
  /** 记录时间戳（ms）。 */
  at: number;
}

interface PersistFile {
  version: 1;
  entries: PersistentAllowance[];
}

function key(sessionId: string, toolName: string): string {
  return `${sessionId}\u0000${toolName}`;
}

/** 该工具是否为 read 类（只有 read 类才允许进持久白名单）。 */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

// ===== 工作区映射（DshAPI 回填） =====

/** 记录某会话的工作目录（session/list、session/create 时调用）。 */
export function noteSessionWorkspace(sessionId: string, cwd?: string | null): void {
  if (!sessionId || !cwd) return;
  sessionWorkspace.set(sessionId, cwd);
}

/** 取某会话的工作目录（未登记返回 null → 只走会话级判定）。 */
export function workspaceForSession(sessionId: string): string | null {
  return sessionWorkspace.get(sessionId) ?? null;
}

// ===== 会话级记忆 =====

/** 记住：本会话内该工具不再询问（点「总是允许」时调用）。 */
export function rememberSessionAllow(sessionId: string, toolName: string): void {
  allowed.add(key(sessionId, toolName));
  // R2-11b：read 类工具顺带落盘（跨会话/重启继续免问）；写类/执行类只留本会话
  const workspace = sessionWorkspace.get(sessionId);
  if (workspace && isReadOnlyTool(toolName)) {
    rememberPersistentAllow(workspace, toolName);
  }
}

/** 该会话该工具是否已被「总是允许」（帧到达时先查这里，命中即自动应答）。 */
export function isSessionAllowed(sessionId: string, toolName: string): boolean {
  return allowed.has(key(sessionId, toolName));
}

/** 会话结束/移除时清理（防集合无限增长；持久白名单不受影响）。 */
export function forgetSessionAllowances(sessionId: string): void {
  const prefix = `${sessionId}\u0000`;
  for (const k of Array.from(allowed)) {
    if (k.startsWith(prefix)) allowed.delete(k);
  }
  sessionWorkspace.delete(sessionId);
}

// ===== 持久级白名单（R2-11b） =====

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      // 订阅方异常不影响授权主流程
    }
  }
}

/** 订阅白名单变更（设置页用），返回取消订阅函数。 */
export function subscribeAllowances(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function readPersistFile(): PersistFile {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return { version: 1, entries: [] };
    const parsed = JSON.parse(raw) as Partial<PersistFile>;
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return {
      version: 1,
      entries: entries.filter(
        (e): e is PersistentAllowance =>
          Boolean(e) && typeof e.workspace === 'string' && typeof e.tool === 'string',
      ),
    };
  } catch {
    // 解析失败按空处理（不抛，授权判定必须永远可用）
    return { version: 1, entries: [] };
  }
}

function writePersistFile(file: PersistFile): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(file));
  } catch {
    // 写盘失败静默：会话级记忆仍然生效，不影响本次执行
  }
  notify();
}

/** 列出全部持久白名单项（设置页展示用）。 */
export function listPersistentAllowances(): PersistentAllowance[] {
  return readPersistFile().entries;
}

/** 该工作区该工具是否在持久白名单里。 */
export function isPersistentlyAllowed(workspace: string | null, toolName: string): boolean {
  if (!workspace) return false;
  return readPersistFile().entries.some(e => e.workspace === workspace && e.tool === toolName);
}

/**
 * 写入持久白名单。**非 read 类工具直接拒绝**（安全红线，调用方无需自行判定）。
 * 返回是否为实际写入。
 */
export function rememberPersistentAllow(workspace: string, toolName: string): boolean {
  if (!workspace || !isReadOnlyTool(toolName)) return false;
  const file = readPersistFile();
  const exists = file.entries.some(e => e.workspace === workspace && e.tool === toolName);
  if (exists) return false;
  file.entries.push({ workspace, tool: toolName, at: Date.now() });
  writePersistFile(file);
  return true;
}

/** 移除单条持久白名单。 */
export function forgetPersistentAllow(workspace: string, toolName: string): void {
  const file = readPersistFile();
  const next = file.entries.filter(e => !(e.workspace === workspace && e.tool === toolName));
  if (next.length === file.entries.length) return;
  file.entries = next;
  writePersistFile(file);
}

/** 清空全部持久白名单。 */
export function clearPersistentAllowances(): void {
  if (readPersistFile().entries.length === 0) return;
  writePersistFile({ version: 1, entries: [] });
}

// ===== 统一判定入口（消费方用这个） =====

/**
 * 该会话该工具是否已被授权（会话级 ∪ 持久级）。
 * 帧到达时先查这里，命中即自动应答 allowed-once，不再弹卡。
 */
export function isApprovalAllowed(sessionId: string, toolName: string): boolean {
  if (isSessionAllowed(sessionId, toolName)) return true;
  return isPersistentlyAllowed(sessionWorkspace.get(sessionId) ?? null, toolName);
}
