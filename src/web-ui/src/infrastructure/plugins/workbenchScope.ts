/**
 * Workbench write-scope guard (host side).
 *
 * Implements 《工作台插件规范》§6.2 precondition ③: write-class tool calls
 * made by a workbench-bound session must stay inside the project root.
 *
 * Enforcement point: the approval flow. The engine's `workspace-write`
 * permission tier auto-approves in-scope writes and only escalates
 * out-of-scope ones to an approval frame — so checking at `approval/requested`
 * time intercepts exactly the out-of-scope writes. The approval frame carries
 * no path, but `tool/call` / `assistant/chunk` block-end events (which arrive
 * earlier) carry the JSON arguments; this module tracks `callId → args` and
 * extracts the path on demand.
 */

/** Write-class tool names whose path arguments are scope-checked. */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'multi_edit',
  'notebook_edit',
]);

/** Argument keys that may carry a target file path (first hit wins). */
const PATH_ARG_KEYS = ['file_path', 'path', 'filePath', 'notebook_path'] as const;

/** Normalize a path for containment comparison (separators, `.`/`..`, case). */
export function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      // Never pop past the root segment (drive letter / first component)
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/').toLowerCase();
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * Is `target` inside `root` (or equal)? Relative targets resolve against root.
 * Comparison is case-insensitive (Windows hosts).
 */
export function isPathWithin(root: string, target: string): boolean {
  const resolved = isAbsolute(target) ? target : `${root.replace(/[\\/]+$/, '')}/${target}`;
  const nRoot = normalizePath(root);
  const nTarget = normalizePath(resolved);
  return nTarget === nRoot || nTarget.startsWith(`${nRoot}/`);
}

/** Extract the target path from a write-class tool's JSON arguments. */
export function extractWritePath(toolName: string, argsJson: string): string | null {
  if (!WRITE_TOOLS.has(toolName)) return null;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/** True when the tool name is a write-class tool (path-carrying). */
export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

interface TrackedCall {
  name: string;
  args: string;
}

export interface ScopeViolation {
  toolName: string;
  path: string;
  cwd: string;
}

/**
 * Per-session `callId → {name, args}` tracker. The owning chat panel feeds it
 * from `tool/call` and `assistant/chunk` block-end events; approval frames
 * query it by `callId`. Entries are cheap and session-scoped.
 */
export class ToolCallTracker {
  private calls = new Map<string, TrackedCall>();

  note(callId: string, name: string, args: string): void {
    if (!callId || !name) return;
    if (!this.calls.has(callId)) {
      this.calls.set(callId, { name, args });
    }
  }

  /**
   * Scope-check an approval frame. Returns a violation when the tracked call
   * is a write-class tool whose path escapes `cwd`; null otherwise (including
   * unknown callId — fail open, the user still sees the approval card).
   */
  checkApproval(toolName: string, callId: string | undefined, cwd: string): ScopeViolation | null {
    const tracked = callId ? this.calls.get(callId) : undefined;
    const effectiveName = tracked?.name ?? toolName;
    const argsJson = tracked?.args;
    if (!argsJson || !isWriteTool(effectiveName)) return null;
    const path = extractWritePath(effectiveName, argsJson);
    if (!path) return null;
    if (isPathWithin(cwd, path)) return null;
    return { toolName: effectiveName, path, cwd };
  }

  /** Extract the paths touched by a successful write-class call (for
   * `workbench:project-written`). */
  writtenPaths(callId: string): string[] {
    const tracked = this.calls.get(callId);
    if (!tracked || !isWriteTool(tracked.name)) return [];
    const path = extractWritePath(tracked.name, tracked.args);
    return path ? [path] : [];
  }

  clear(): void {
    this.calls.clear();
  }
}
