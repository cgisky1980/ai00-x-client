/**
 * workbenchTaskStore — 工作台任务运行态（非持久化）。
 *
 * 真源仍是 `todoStore`（任务卡/计划书/验收字段）；这里只缓存「会话此刻是否
 * 在跑 / 是否出错」，由任务场景的对话面板上报、看板只读。刻意不复用
 * `TodoOverlay` 的 30s 轮询：工作台窗口是本进程内的宿主，直接拿面板实时状态
 * 更准，也不与策窗口的运行态互相牵制。
 */
import { create } from 'zustand';
import type {
  DshSubagentCatalogEntry,
  DshSubagentMode,
  DshSubagentTiming,
} from '@/infrastructure/api/service-api/DshAPI';

export interface WorkbenchTaskRuntime {
  running: boolean;
  failed: boolean;
  /** 最后更新时刻（调试/排序用） */
  at: number;
}

/** 子代理（子会话）在对话流里的活动条目。 */
export interface WorkbenchChildAgent {
  sessionId: string;
  /** 子会话标题（引擎投影；可能缺失）。 */
  title: string | null;
  /** agent preset（如 code_worker / research_worker）。 */
  preset: string | null;
  running: boolean;
  updatedAt: number;
  /** 本端首次看到该子会话的时刻（引擎不给开始时间，用首次观测近似）。 */
  since: number;
}

/** 子代理目录条目（引擎 `subagentCatalog` 投影；label 是派发时冻结的任务标题）。 */
export interface WorkbenchSubagentMeta {
  id: string;
  createdAt: number;
  mode: DshSubagentMode;
  label?: string;
}

interface WorkbenchTaskState {
  /** sessionId → 运行态 */
  runtime: Record<string, WorkbenchTaskRuntime>;
  /** 主会话 → 正在跑的子代理（子会话）数量；主代理回合结束但子代理仍在跑时用它提示。 */
  delegating: Record<string, number>;
  /** 主会话 → 子代理活动列表（对话流展示用；running 优先、时间倒序）。 */
  children: Record<string, WorkbenchChildAgent[]>;
  /** 父会话 → 子代理目录（`subagentCatalog` 投影，label 来自派发时冻结的任务标题）。 */
  subagentCatalog: Record<string, WorkbenchSubagentMeta[]>;
  /** 子会话 → turn 计时（`subagentTiming` 投影，挂在子会话 id 上，durable）。 */
  subagentTiming: Record<string, DshSubagentTiming>;
  /** 跨任务/看板场景保持选中；仅进程内 UI 状态，不写入任务数据。 */
  selectedTaskId: string | null;
  /** 主区是否展示新任务输入（与「未选中任何任务」区分）。 */
  creatingNew: boolean;
  selectTask: (taskId: string) => void;
  startNewTask: () => void;
  reportRuntime: (sessionId: string, next: { running: boolean; failed: boolean }) => void;
  /**
   * 用引擎 `session/list` 的 running 快照回填全量会话运行态。
   *
   * 面板只在任务被打开时上报；没打开过的任务以前没有运行态，状态会一直停在
   * 「执行中」。宿主定时回填后，停下的任务才能落到「已停止」。
   */
  seedRunning: (entries: Array<{ sessionId: string; running: boolean }>) => void;
  /** 回填子代理运行数（parentSessionId → 运行中的子会话数）。 */
  seedDelegating: (entries: Array<{ parentSessionId: string; running: boolean }>) => void;
  /** 回填子代理活动列表（对话流展示）。`since` 由本 store 维护。 */
  seedChildren: (entries: Array<Omit<WorkbenchChildAgent, 'since'> & { parentSessionId: string }>) => void;
  /**
   * 应用一条 `session/projection` 帧（控制流广播）。
   *
   * 只关心两类子代理投影：父会话的 `subagentCatalog`（谁被派发了、叫什么）
   * 与子会话的 `subagentTiming`（跑了多久、最近一 turn 是否正常收口）。
   * 其余投影（title/modelSelection/inbox…）各有既有消费者，这里不碰。
   */
  applySubagentProjection: (sessionId: string, key: string, value: unknown) => void;
  /** 用 durable `subagent/catalog` 事件补齐目录（投影未必在首帧到达）。 */
  seedSubagentCatalog: (parentSessionId: string, entries: DshSubagentCatalogEntry[]) => void;
}

/** `subagentCatalog` 投影值的宽松归一（坏值不污染 store）。 */
function normalizeCatalog(value: unknown): WorkbenchSubagentMeta[] {
  if (!Array.isArray(value)) return [];
  const rows: WorkbenchSubagentMeta[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; createdAt?: unknown; mode?: unknown; label?: unknown };
    if (typeof row.id !== 'string' || !row.id) continue;
    rows.push({
      id: row.id,
      createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
      mode:
        row.mode === 'one-shot' || row.mode === 'external' || row.mode === 'continuable'
          ? row.mode
          : 'unknown',
      ...(typeof row.label === 'string' && row.label ? { label: row.label } : {}),
    });
  }
  return rows;
}

/** `subagentTiming` 投影值的宽松归一。 */
function normalizeTiming(value: unknown): DshSubagentTiming | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as {
    settledMs?: unknown;
    active?: { since?: unknown; through?: unknown };
    lastTurnCompleted?: unknown;
  };
  const settledMs = typeof raw.settledMs === 'number' ? raw.settledMs : 0;
  const result: DshSubagentTiming = { settledMs };
  if (raw.active && typeof raw.active.since === 'number' && typeof raw.active.through === 'number') {
    result.active = { since: raw.active.since, through: raw.active.through };
  }
  if (typeof raw.lastTurnCompleted === 'boolean') {
    result.lastTurnCompleted = raw.lastTurnCompleted;
  }
  return result;
}

function sameCatalog(a: WorkbenchSubagentMeta[], b: WorkbenchSubagentMeta[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (row, i) =>
        row.id === b[i].id &&
        row.label === b[i].label &&
        row.mode === b[i].mode &&
        row.createdAt === b[i].createdAt,
    )
  );
}

function sameTiming(a: DshSubagentTiming | undefined, b: DshSubagentTiming): boolean {
  return (
    !!a &&
    a.settledMs === b.settledMs &&
    a.lastTurnCompleted === b.lastTurnCompleted &&
    a.active?.since === b.active?.since &&
    a.active?.through === b.active?.through
  );
}

export const useWorkbenchTaskStore = create<WorkbenchTaskState>((set) => ({
  runtime: {},
  delegating: {},
  children: {},
  subagentCatalog: {},
  subagentTiming: {},
  selectedTaskId: null,
  creatingNew: true,
  selectTask: (taskId) => set({ selectedTaskId: taskId, creatingNew: false }),
  startNewTask: () => set({ selectedTaskId: null, creatingNew: true }),
  reportRuntime: (sessionId, next) =>
    set((s) => {
      const prev = s.runtime[sessionId];
      if (prev && prev.running === next.running && prev.failed === next.failed) return s;
      return {
        runtime: {
          ...s.runtime,
          [sessionId]: { running: next.running, failed: next.failed, at: Date.now() },
        },
      };
    }),
  seedRunning: (entries) =>
    set((s) => {
      if (entries.length === 0) return s;
      let changed = false;
      const runtime = { ...s.runtime };
      for (const entry of entries) {
        const prev = runtime[entry.sessionId];
        if (prev?.running === entry.running) continue;
        runtime[entry.sessionId] = {
          running: entry.running,
          failed: prev?.failed ?? false,
          at: Date.now(),
        };
        changed = true;
      }
      return changed ? { runtime } : s;
    }),
  seedDelegating: (entries) =>
    set((s) => {
      const next: Record<string, number> = {};
      for (const entry of entries) {
        if (!entry.running) continue;
        next[entry.parentSessionId] = (next[entry.parentSessionId] ?? 0) + 1;
      }
      const same =
        Object.keys(next).length === Object.keys(s.delegating).length &&
        Object.entries(next).every(([key, count]) => s.delegating[key] === count);
      return same ? s : { delegating: next };
    }),
  seedChildren: (entries) =>
    set((s) => {
      const next: Record<string, WorkbenchChildAgent[]> = {};
      const now = Date.now();
      const knownSince = new Map<string, number>();
      for (const list of Object.values(s.children)) {
        for (const agent of list) knownSince.set(agent.sessionId, agent.since);
      }
      for (const entry of entries) {
        const list = next[entry.parentSessionId] ?? [];
        list.push({
          sessionId: entry.sessionId,
          title: entry.title,
          preset: entry.preset,
          running: entry.running,
          updatedAt: entry.updatedAt,
          since: knownSince.get(entry.sessionId) ?? now,
        });
        next[entry.parentSessionId] = list;
      }
      for (const list of Object.values(next)) {
        list.sort((a, b) => {
          if (a.running !== b.running) return a.running ? -1 : 1;
          return b.updatedAt - a.updatedAt;
        });
        if (list.length > 12) list.length = 12;
      }
      const keys = Object.keys(next);
      const same =
        keys.length === Object.keys(s.children).length &&
        keys.every((key) => {
          const a = next[key];
          const b = s.children[key];
          return (
            b?.length === a.length &&
            a.every(
              (agent, index) =>
                agent.sessionId === b[index].sessionId &&
                agent.running === b[index].running &&
                agent.title === b[index].title &&
                agent.preset === b[index].preset &&
                agent.updatedAt === b[index].updatedAt,
            )
          );
        });
      return same ? s : { children: next };
    }),
  applySubagentProjection: (sessionId, key, value) =>
    set((s) => {
      if (key === 'subagentCatalog') {
        const next = normalizeCatalog(value);
        if (sameCatalog(s.subagentCatalog[sessionId] ?? [], next)) return s;
        return { subagentCatalog: { ...s.subagentCatalog, [sessionId]: next } };
      }
      if (key === 'subagentTiming') {
        const timing = normalizeTiming(value);
        if (!timing || sameTiming(s.subagentTiming[sessionId], timing)) return s;
        return { subagentTiming: { ...s.subagentTiming, [sessionId]: timing } };
      }
      return s;
    }),
  seedSubagentCatalog: (parentSessionId, entries) =>
    set((s) => {
      if (entries.length === 0) return s;
      const existing = s.subagentCatalog[parentSessionId] ?? [];
      const byId = new Map(existing.map(row => [row.id, row]));
      for (const entry of entries) {
        const prev = byId.get(entry.id);
        byId.set(entry.id, {
          id: entry.id,
          createdAt: entry.createdAt || prev?.createdAt || 0,
          mode: entry.mode === 'unknown' ? (prev?.mode ?? 'unknown') : entry.mode,
          ...(entry.label ?? prev?.label ? { label: entry.label ?? prev?.label } : {}),
        });
      }
      const next = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
      if (sameCatalog(existing, next)) return s;
      return { subagentCatalog: { ...s.subagentCatalog, [parentSessionId]: next } };
    }),
}));
