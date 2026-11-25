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
  DshSessionStats,
  DshSubagentCatalogEntry,
  DshSubagentMode,
  DshSubagentTiming,
} from '@/infrastructure/api/service-api/DshAPI';

export interface WorkbenchTaskRuntime {
  running: boolean;
  failed: boolean;
  /** 会话有未回答的 ask user 提问（「需要你」徽标用；仅面板打开时可知）。 */
  asking?: boolean;
  /** 最后一轮失败的原文：计划卡据此判断「再点继续执行有没有意义」。 */
  lastError?: { code?: string; message: string };
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

/**
 * 待人类批准的 exit_plan_mode 审批（规范 §9.6：与 ai00_plan_write 路径汇入计划卡同一个「待批准」态）。
 * 对话面板收到审批帧后登记，计划卡负责应答；approval/resolved 帧到达后面板清除。
 */
export interface WorkbenchPlanReview {
  rpcId: string;
  approvalId: string;
  /** exit_plan_mode 的 plan 参数（计划文件缺失时计划卡用它渲染）。 */
  planText?: string;
}

/** 子代理目录条目（引擎 `subagentCatalog` 投影；label 是派发时冻结的任务标题）。 */
export interface WorkbenchSubagentMeta {
  id: string;
  createdAt: number;
  mode: DshSubagentMode;
  label?: string;
  /** 派发时调用方给的名字（worker 工具回执 `started subagent <name>` 用它反查 id）。 */
  name?: string;
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
  /** 主会话 → 待批准的 exit_plan_mode 审批。 */
  planReviews: Record<string, WorkbenchPlanReview>;
  /** 主会话 → 执行过程统计（对话面板由事件流水账算出后上报；计划卡读）。 */
  sessionStats: Record<string, DshSessionStats>;
  /** 跨任务/看板场景保持选中；仅进程内 UI 状态，不写入任务数据。 */
  selectedTaskId: string | null;
  /** 主区是否展示新任务输入（与「未选中任何任务」区分）。 */
  creatingNew: boolean;
  selectTask: (taskId: string) => void;
  startNewTask: () => void;
  reportStats: (sessionId: string, stats: DshSessionStats) => void;
  setPlanReview: (sessionId: string, review: WorkbenchPlanReview | null) => void;
  reportRuntime: (
    sessionId: string,
    next: { running: boolean; failed: boolean; asking?: boolean; lastError?: { code?: string; message: string } },
  ) => void;
  /**
   * 用引擎 `session/list` 的 running 快照回填全量会话运行态。
   *
   * 面板只在任务被打开时上报；没打开过的任务以前没有运行态，状态会一直停在
   * 「执行中」。宿主定时回填后，停下的任务才能落到「已停止」。
   */
  seedRunning: (entries: Array<{ sessionId: string; running: boolean }>) => void;
  /**
   * 回填会话「最后一轮是否报错」及其错误原文（`todoStore.agentFailed` /
   * `agentErrors`，由 overlay 轮询回填）。
   *
   * 没被打开过的任务只有引擎快照，面板不上报 failed，卡片会一直显示「执行」而看不出
   * 这一轮已经以错误收尾——把轮询结论并进来，列表/看板的阶段点才能落到失败态。
   * 错误原文一起回填：额度不足 / 凭据失效这类错误要让人在卡片上直接看到原因，
   * 而不是等打开会话对齐历史才知道「点了重试也不会有用」。
   */
  seedFailed: (
    entries: Array<{
      sessionId: string;
      failed: boolean;
      lastError?: { code?: string; message: string };
    }>,
  ) => void;
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
    const row = item as {
      id?: unknown;
      createdAt?: unknown;
      mode?: unknown;
      label?: unknown;
      name?: unknown;
    };
    if (typeof row.id !== 'string' || !row.id) continue;
    rows.push({
      id: row.id,
      createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
      mode:
        row.mode === 'one-shot' || row.mode === 'external' || row.mode === 'continuable'
          ? row.mode
          : 'unknown',
      ...(typeof row.label === 'string' && row.label ? { label: row.label } : {}),
      ...(typeof row.name === 'string' && row.name ? { name: row.name } : {}),
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
        row.name === b[i].name &&
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
  sessionStats: {},
  planReviews: {},
  selectedTaskId: null,
  creatingNew: true,
  selectTask: (taskId) => set({ selectedTaskId: taskId, creatingNew: false }),
  startNewTask: () => set({ selectedTaskId: null, creatingNew: true }),
  setPlanReview: (sessionId, review) =>
    set((s) => {
      const prev = s.planReviews[sessionId];
      if (!review) {
        if (!prev) return s;
        const next = { ...s.planReviews };
        delete next[sessionId];
        return { planReviews: next };
      }
      if (prev && prev.rpcId === review.rpcId && prev.planText === review.planText) return s;
      return { planReviews: { ...s.planReviews, [sessionId]: review } };
    }),
  reportStats: (sessionId, stats) =>
    set((s) => {
      const prev = s.sessionStats[sessionId];
      if (prev && JSON.stringify(prev) === JSON.stringify(stats)) return s;
      return { sessionStats: { ...s.sessionStats, [sessionId]: stats } };
    }),
  reportRuntime: (sessionId, next) =>
    set((s) => {
      const prev = s.runtime[sessionId];
      const asking = Boolean(next.asking);
      if (
        prev &&
        prev.running === next.running &&
        prev.failed === next.failed &&
        Boolean(prev.asking) === asking &&
        prev.lastError?.code === next.lastError?.code &&
        prev.lastError?.message === next.lastError?.message
      ) {
        return s;
      }
      return {
        runtime: {
          ...s.runtime,
          [sessionId]: {
            running: next.running,
            failed: next.failed,
            asking,
            lastError: next.lastError,
            at: Date.now(),
          },
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
          asking: prev?.asking ?? false,
          lastError: prev?.lastError,
          at: Date.now(),
        };
        changed = true;
      }
      return changed ? { runtime } : s;
    }),
  seedFailed: (entries) =>
    set((s) => {
      if (entries.length === 0) return s;
      let changed = false;
      const runtime = { ...s.runtime };
      for (const entry of entries) {
        const prev = runtime[entry.sessionId];
        // 失败态消失（回合成功 / 会话被清）时错误原文也要清，不能留下过期原因。
        const lastError = entry.failed ? (entry.lastError ?? prev?.lastError) : undefined;
        if (
          prev?.failed === entry.failed &&
          prev?.lastError?.code === lastError?.code &&
          prev?.lastError?.message === lastError?.message
        ) {
          continue;
        }
        runtime[entry.sessionId] = {
          running: prev?.running ?? false,
          failed: entry.failed,
          asking: prev?.asking ?? false,
          lastError,
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
          ...(entry.name ?? prev?.name ? { name: entry.name ?? prev?.name } : {}),
        });
      }
      const next = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
      if (sameCatalog(existing, next)) return s;
      return { subagentCatalog: { ...s.subagentCatalog, [parentSessionId]: next } };
    }),
}));
