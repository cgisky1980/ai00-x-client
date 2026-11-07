/**
 * Workbench session binding (host side).
 *
 * Implements 《工作台插件规范》§6.2 precondition ①②:
 * - The host owns the `projectId → sessionId` mapping (plugins never store
 *   session ids). Persisted in localStorage, validated against
 *   `dshSession.list()` on use (stale entries are dropped).
 * - 目录约定：每类工作台有一个**固定总工作目录**（承载工作台自己的
 *   `AGENTS.md`），每个项目是其中的一个子目录，也就是会话的工作目录。
 *   建会话前宿主写入项目级 `AGENTS.local.md`（内联工作台约定），dsh
 *   workbench preset 只从工程子目录发现指令（不向上递归）。
 */

import { invoke } from '@tauri-apps/api/core';
import { dshEngine, dshSession } from '@/infrastructure/api/service-api/DshAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type { WorkbenchEntry } from './workbenchRegistry';

const STORAGE_KEY = 'ai00-x.workbench-sessions.v1';

/**
 * 应用侧主模型引用 → dsh 引擎可用的模型引用。
 *
 * 引擎（ai-bridge）只认 `ai00-x` provider 下的模型 id；网关会把
 * `ai00s:<子模型>` 交给 client_factory 解析，本地则走 `rwkv-local`。
 * 其他应用模型（自定义 API 等）在引擎侧没有凭据，回落到 AI00-API 主模型槽。
 */
function toEngineModelRef(primary: string | null | undefined): string {
  const ref = (primary ?? '').trim();
  if (!ref || ref === 'auto') return 'ai00-api';
  if (ref.startsWith('ai00s:')) return ref;
  if (ref === 'rwkv-local' || ref.startsWith('gguf-local:')) return 'rwkv-local';
  return 'ai00-api';
}

/**
 * 复用会话的旧入口模型迁移：`ai00-salvo` → 当前应用主模型。
 * 失败不影响使用（网关仍接受旧 id）。
 */
async function migrateLegacyModel(sessionId: string): Promise<void> {
  try {
    const models = await dshSession.models(sessionId);
    if (models.current?.model !== 'ai00-salvo') return;
    const defaults = await configManager.getConfig<{ primary?: string }>('ai.default_models');
    await dshSession.selectModel(sessionId, 'ai00-x', toEngineModelRef(defaults?.primary));
  } catch {
    // 迁移失败不阻断绑定
  }
}

interface BoundSession {
  sessionId: string;
  cwd: string;
}

type BindingTable = Record<string, Record<string, BoundSession>>;

function readTable(): BindingTable {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as BindingTable;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeTable(table: BindingTable): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(table));
  } catch {
    // 写盘失败不影响本次会话（运行态调用方仍持有 sessionId）
  }
}

/** Look up the persisted binding (no liveness check). */
export function getBoundSession(workbenchId: string, projectId: string): BoundSession | null {
  return readTable()[workbenchId]?.[projectId] ?? null;
}

function noteBoundSession(workbenchId: string, projectId: string, binding: BoundSession): void {
  const table = readTable();
  table[workbenchId] = { ...table[workbenchId], [projectId]: binding };
  writeTable(table);
}

/** Drop a binding (stale session or explicit reset). */
export function forgetBoundSession(workbenchId: string, projectId: string): void {
  const table = readTable();
  if (!table[workbenchId]?.[projectId]) return;
  delete table[workbenchId][projectId];
  writeTable(table);
}

export interface EnsuredWorkbenchSession {
  sessionId: string;
  cwd: string;
  /** True when a new dsh session was created (false = reused binding). */
  created: boolean;
}

/**
 * Ensure a live dsh session is bound to (workbench, project):
 * prepare workbench root + project subdir + agent files → reuse or create the
 * session with `cwd = project root`.
 */
async function doEnsureWorkbenchSession(
  entry: WorkbenchEntry,
  projectId: string,
  projectTitle?: string,
): Promise<EnsuredWorkbenchSession> {
  // 引擎必须先就绪（session/create 依赖 sidecar 在线）
  await dshEngine.ensureReady();

  // 宿主侧准备目录与 agent 文件：工作台总目录 / 工作台 AGENTS.md /
  // 项目子目录 / 项目 AGENTS.local.md（全部幂等）
  const ctx = await invoke<{ workbenchRoot: string; projectRoot: string }>(
    'workbench_prepare_project',
    {
      workbenchId: entry.id,
      dataDirName: entry.dataDir,
      workbenchTitle: entry.title,
      agentInstructions: entry.agentInstructions ?? null,
      projectId,
      projectTitle: projectTitle ?? null,
    },
  );
  const root = ctx.projectRoot;

  const bound = getBoundSession(entry.id, projectId);
  if (bound && bound.cwd === root) {
    try {
      const { items } = await dshSession.list();
      if (items.some((s) => s.sessionId === bound.sessionId)) {
        await migrateLegacyModel(bound.sessionId);
        return { sessionId: bound.sessionId, cwd: bound.cwd, created: false };
      }
    } catch {
      // 引擎暂不可达 → 按失效处理，重建会话
    }
    forgetBoundSession(entry.id, projectId);
  }

  // workbench preset：指令根发现止于工程自身（AGENTS.local.md 作 rootMarker），
  // 不向上递归收集宿主仓库的 AGENTS.md
  const { sessionId } = await dshSession.create({ cwd: root, agentPreset: 'workbench' });
  // 新建会话的默认模型：跟随应用侧主模型（AI00-API 具体子模型 / 本地 RWKV），
  // 而不是把会话钉在网关入口上——用户看到的应是具体模型名。
  // 引擎默认（deepseek-official）未配 key 时每回合 MISSING_CREDENTIAL，必须覆盖。
  // 只对新会话设置；复用会话尊重用户已选模型。
  try {
    const defaults = await configManager.getConfig<{ primary?: string }>('ai.default_models');
    await dshSession.selectModel(sessionId, 'ai00-x', toEngineModelRef(defaults?.primary));
  } catch {
    // 配置或模型目录暂不可用时保持引擎默认，用户可在输入区自己选
  }
  noteBoundSession(entry.id, projectId, { sessionId, cwd: root });
  return { sessionId, cwd: root, created: true };
}

/** 同一 (workbench, project) 的并发 ensure 共享一个 promise（快速连点/重复上报时防重复建会话）。 */
const inflight = new Map<string, Promise<EnsuredWorkbenchSession>>();

/**
 * Ensure a live dsh session is bound to (workbench, project)。同键并发去重；
 * 不同工程的绑定互不阻塞（调用方自行处理「最后一次选择生效」的时序）。
 */
export async function ensureWorkbenchSession(
  entry: WorkbenchEntry,
  projectId: string,
  projectTitle?: string,
): Promise<EnsuredWorkbenchSession> {
  const key = `${entry.id}/${projectId}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = doEnsureWorkbenchSession(entry, projectId, projectTitle).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}
