/**
 * todoStore — 待办核心本地数据 store（任务/清单/目标/专注/奖励）。
 *
 * 持久化：Tauri `todo_store_get/set`（{data}/Ai00-X/todo/data.json 原子写），
 * 脱离插件数据接口。游戏化 XP 走 growthStore（服务器）。
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { ChecklistItem, FocusSession, RepeatType, TodoData, TodoGoal, TodoList, TodoTask } from '../api/types';

const DATA_VERSION = 3;
const SAVE_DEBOUNCE_MS = 400;

export type TodoView = 'today' | 'routine' | 'goal' | 'done' | 'growth';

function emptyData(): TodoData {
  return {
    version: DATA_VERSION,
    lists: [],
    goals: [],
    tasks: [],
    focusSessions: [],
    rewards: [],
    lastStreakSettleDate: null,
    migratedFromPlugin: false,
  };
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
}

/** v1/v2（插件版）→ v3 兼容清洗：补新字段、去非法值。 */
function sanitize(raw: unknown): TodoData {
  const base = emptyData();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;

  const lists: TodoList[] = Array.isArray(r.lists)
    ? (r.lists as TodoList[])
        .filter((l) => l && typeof l.id === 'string' && typeof l.name === 'string')
        .map((l) => ({ id: l.id, name: l.name, order: Number(l.order) || 0 }))
    : [];

  const goals: TodoGoal[] = Array.isArray(r.goals)
    ? (r.goals as TodoGoal[])
        .filter((g) => g && typeof g.id === 'string' && typeof g.title === 'string')
        .map((g) => ({
          id: g.id,
          title: g.title,
          why: typeof g.why === 'string' ? g.why : '',
          deadline: typeof g.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(g.deadline) ? g.deadline : null,
          remindedAt: typeof g.remindedAt === 'number' ? g.remindedAt : null,
          doneAt: typeof g.doneAt === 'number' ? g.doneAt : null,
          createdAt: typeof g.createdAt === 'number' ? g.createdAt : Date.now(),
          // v2 迁移：方案/里程碑补空（旧数据 schema 无此二字段）
          plan: Array.isArray(g.plan)
            ? g.plan.filter((s) => typeof s === 'string').slice(0, 6).map((s) => String(s).slice(0, 200))
            : [],
          milestones: Array.isArray(g.milestones)
            ? g.milestones
                .filter((m) => m && typeof m === 'object' && typeof m.title === 'string')
                .slice(0, 6)
                .map((m) => ({
                  id: typeof m.id === 'string' ? m.id : genId('ms'),
                  title: String(m.title).slice(0, 40),
                  done: !!m.done,
                }))
            : [],
        }))
    : [];

  const REPEATS: RepeatType[] = ['daily', 'weekly', 'monthly', 'weekdays'];
  const tasks: TodoTask[] = Array.isArray(r.tasks)
    ? (r.tasks as TodoTask[])
        .filter((t) => t && typeof t === 'object' && typeof t.id === 'string' && typeof t.title === 'string')
        .map((t) => ({
          id: t.id,
          listId: typeof t.listId === 'string' ? t.listId : null,
          title: t.title,
          notes: typeof t.notes === 'string' ? t.notes : '',
          due: typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : null,
          repeat:
            t.repeat && REPEATS.includes(t.repeat.type)
              ? { type: t.repeat.type, afterCompletion: !!t.repeat.afterCompletion }
              : null,
          checklist: Array.isArray(t.checklist)
            ? (t.checklist as ChecklistItem[])
                .filter((c) => c && typeof c === 'object')
                .map((c) => ({ t: String(c.t ?? ''), d: !!c.d }))
            : [],
          flag: !!t.flag,
          completedAt: typeof t.completedAt === 'number' ? t.completedAt : null,
          createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
          order: typeof t.order === 'number' ? t.order : 0,
          focus:
            t.focus && typeof t.focus === 'object'
              ? { pomodoros: Number(t.focus.pomodoros) || 0, minutes: Number(t.focus.minutes) || 0 }
              : { pomodoros: 0, minutes: 0 },
          goalId: typeof t.goalId === 'string' ? t.goalId : null,
          milestoneId: typeof t.milestoneId === 'string' ? t.milestoneId : null,
          remindAt: typeof t.remindAt === 'string' ? t.remindAt : null,
          remindedAt: typeof t.remindedAt === 'number' ? t.remindedAt : null,
        }))
    : [];

  const focusSessions: FocusSession[] = Array.isArray(r.focusSessions)
    ? (r.focusSessions as FocusSession[])
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({
          taskId: s.taskId ?? null,
          startedAt: typeof s.startedAt === 'number' ? s.startedAt : 0,
          minutes: Number(s.minutes) || 0,
          outcome: s.outcome ?? null,
        }))
    : [];

  const rewards = Array.isArray(r.rewards)
    ? (r.rewards as TodoData['rewards'])
        .filter((x) => x && typeof x.name === 'string')
        .map((x) => ({
          id: typeof x.id === 'string' ? x.id : genId('r'),
          name: String(x.name).slice(0, 40),
          cost: Math.max(1, Number(x.cost) || 10),
        }))
    : [];

  return {
    version: DATA_VERSION,
    lists,
    goals,
    tasks,
    focusSessions,
    rewards,
    lastStreakSettleDate: typeof r.lastStreakSettleDate === 'string' ? r.lastStreakSettleDate : null,
    migratedFromPlugin: !!r.migratedFromPlugin,
  };
}

// ---- 日期工具（本地、确定性） ----

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addMonths(base: Date, n: number): Date {
  const r = new Date(base);
  const day = r.getDate();
  r.setMonth(r.getMonth() + n);
  if (r.getDate() < day) r.setDate(0);
  return r;
}

export function parseDue(due: string): Date {
  const [y, m, d] = due.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

export function fmtDue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dueLabel(due: string): { text: string; overdue: boolean } {
  const today = new Date();
  const d = parseDue(due);
  const diff = Math.round((d.getTime() - today.setHours(12, 0, 0, 0)) / 86400000);
  if (diff < 0) return { text: `${d.getMonth() + 1}月${d.getDate()}日`, overdue: true };
  if (diff === 0) return { text: '今天', overdue: false };
  if (diff === 1) return { text: '明天', overdue: false };
  if (diff === 2) return { text: '后天', overdue: false };
  if (diff < 7) return { text: `周${['日', '一', '二', '三', '四', '五', '六'][d.getDay()]}`, overdue: false };
  return { text: `${d.getMonth() + 1}月${d.getDate()}日`, overdue: false };
}

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

/** 中文日期解析（快速捕获）：今天/明天/后天/周X/下周X/X月X日/MM-DD。 */
export function parseCnDate(text: string): { due: string | null; rest: string } {
  const today = new Date();
  const tryMatch = (re: RegExp, fn: (m: RegExpMatchArray) => string | null): { due: string; rest: string } | null => {
    const m = text.match(re);
    if (!m) return null;
    const due = fn(m);
    if (!due) return null;
    return { due, rest: (text.slice(0, m.index!) + text.slice(m.index! + m[0].length)).trim() };
  };
  let r = tryMatch(/^今天|^今日/, () => fmtDue(today));
  if (r) return r;
  r = tryMatch(/^明天|^明日/, () => fmtDue(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12)));
  if (r) return r;
  r = tryMatch(/^后天/, () => fmtDue(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2, 12)));
  if (r) return r;
  r = tryMatch(/(下?)(?:周|星期|礼拜)([一二三四五六日天])/, (m) => {
    const target = WEEK_CN.indexOf(m[2]);
    if (target < 0) return null;
    let diff = (target - today.getDay() + 7) % 7;
    if (m[1] === '下') diff += 7;
    else if (diff === 0) diff = 7;
    return fmtDue(new Date(today.getFullYear(), today.getMonth(), today.getDate() + diff, 12));
  });
  if (r) return r;
  r = tryMatch(/(\d{1,2})月(\d{1,2})[日号]?/, (m) => {
    const mo = Number(m[1]);
    const day = Number(m[2]);
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
    let d = new Date(today.getFullYear(), mo - 1, day, 12);
    if (d < today) d = new Date(today.getFullYear() + 1, mo - 1, day, 12);
    return fmtDue(d);
  });
  if (r) return r;
  r = tryMatch(/\b(\d{1,2})-(\d{1,2})\b/, (m) => {
    const mo = Number(m[1]);
    const day = Number(m[2]);
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
    let d = new Date(today.getFullYear(), mo - 1, day, 12);
    if (d < today) d = new Date(today.getFullYear() + 1, mo - 1, day, 12);
    return fmtDue(d);
  });
  if (r) return r;
  return { due: null, rest: text };
}

/** 捕获行元语法：`#清单名` 归档 · `!` 旗标（日期另由 parseCnDate 处理）。 */
export function parseCaptureMeta(text: string): { flag: boolean; listName: string | null; rest: string } {
  let rest = ` ${text} `;
  const meta = { flag: false, listName: null as string | null };
  const lm = rest.match(/\s#([^\s]{1,24})\s/);
  if (lm) {
    meta.listName = lm[1];
    rest = rest.replace(/\s#[^\s]{1,24}\s/, ' ');
  }
  if (/\s!\s/.test(rest)) {
    meta.flag = true;
    rest = rest.replace(/\s!\s/, ' ');
  }
  return { ...meta, rest: rest.replace(/\s+/g, ' ').trim() };
}

// ---- Store ----

interface TodoState {
  loaded: boolean;
  panelOpen: boolean;
  view: TodoView;
  expandedId: string | null;
  data: TodoData;
  /** 专注胶囊状态（persist 到 data 文件外单独 key，简化：并入 data） */
  load: () => Promise<void>;
  save: () => void;
  togglePanel: (force?: boolean) => void;
  setView: (v: TodoView) => void;
  setExpanded: (id: string | null) => void;

  addTask: (title: string, opts?: Partial<Pick<TodoTask, 'due' | 'flag' | 'listId' | 'goalId' | 'milestoneId' | 'remindAt' | 'repeat' | 'checklist' | 'notes'>>) => TodoTask;
  updateTask: (id: string, patch: Partial<TodoTask>) => void;
  completeTask: (id: string, done: boolean) => void;
  deleteTask: (id: string) => void;
  addGoal: (title: string, why: string, deadline: string | null, plan?: string[], milestones?: { title: string }[]) => TodoGoal;
  updateGoal: (id: string, patch: Partial<TodoGoal>) => void;
  completeGoal: (id: string) => void;
  deleteGoal: (id: string) => void;
  addFocusSession: (s: FocusSession) => void;
  /** 事件并入（Rust todo_focus_append 已落盘，仅同步内存，不触发 save） */
  mergeFocusSession: (s: FocusSession) => void;
  addReward: (name: string, cost: number) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useTodoStore = create<TodoState>((set, get) => ({
  loaded: false,
  panelOpen: false,
  view: 'today',
  expandedId: null,
  data: emptyData(),

  load: async () => {
    // 一次性迁移：旧插件数据 → 核心存储（schema 同构，直搬 + 标记）。
    try {
      let raw = await invoke<unknown>('todo_store_get');
      if (raw == null) {
        const legacy = await invoke<unknown>('plugin_data_get', {
          pluginId: 'com.ai00x.todo',
          key: 'data',
        });
        if (legacy && typeof legacy === 'object') {
          raw = legacy;
        }
      }
      const data = sanitize(raw);
      data.migratedFromPlugin = true;
      set({ data, loaded: true });
      get().save();
    } catch (e) {
      console.warn('[todo] load failed:', e);
      set({ data: emptyData(), loaded: true });
    }
  },

  save: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      invoke('todo_store_set', { value: get().data }).catch((e) =>
        console.error('[todo] save failed:', e)
      );
    }, SAVE_DEBOUNCE_MS);
  },

  togglePanel: (force) =>
    set((s) => ({ panelOpen: force !== undefined ? force : !s.panelOpen })),

  setView: (v) => set({ view: v, expandedId: null }),
  setExpanded: (id) => set({ expandedId: id }),

  addTask: (title, opts = {}) => {
    const task: TodoTask = {
      id: genId('t'),
      listId: opts.listId ?? null,
      title,
      notes: opts.notes ?? '',
      due: opts.due ?? null,
      repeat: opts.repeat ?? null,
      checklist: opts.checklist ?? [],
      flag: !!opts.flag,
      completedAt: null,
      createdAt: Date.now(),
      order: Date.now(),
      focus: { pomodoros: 0, minutes: 0 },
      goalId: opts.goalId ?? null,
      milestoneId: opts.milestoneId ?? null,
      remindAt: opts.remindAt ?? null,
      remindedAt: null,
    };
    set((s) => ({ data: { ...s.data, tasks: [...s.data.tasks, task] } }));
    get().save();
    return task;
  },

  updateTask: (id, patch) => {
    set((s) => ({
      data: {
        ...s.data,
        tasks: s.data.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      },
    }));
    get().save();
  },

  completeTask: (id, done) => {
    const task = get().data.tasks.find((t) => t.id === id);
    if (!task) return;
    if (done) {
      // 周期任务：克隆下一次（due 推进、remindAt 同时刻映射、状态复位）
      if (task.repeat) {
        const base =
          task.repeat.afterCompletion || !task.due ? new Date() : parseDue(task.due);
        let next: Date;
        switch (task.repeat.type) {
          case 'daily': next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 12); break;
          case 'weekly': next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7, 12); break;
          case 'monthly': next = addMonths(base, 1); break;
          case 'weekdays': {
            next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 12);
            while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
            break;
          }
        }
        const nextDue = fmtDue(next);
        const nextRemind = task.remindAt
          ? nextDue + task.remindAt.slice(10) // 'YYYY-MM-DD' + 'THH:mm'
          : null;
        set((s) => ({
          data: {
            ...s.data,
            tasks: [
              ...s.data.tasks,
              {
                ...task,
                id: genId('t'),
                completedAt: null,
                createdAt: Date.now(),
                order: Date.now(),
                checklist: task.checklist.map((c) => ({ ...c, d: false })),
                focus: { pomodoros: 0, minutes: 0 },
                due: nextDue,
                remindAt: nextRemind,
                remindedAt: null,
              },
            ],
          },
        }));
      }
      set((s) => ({
        data: {
          ...s.data,
          tasks: s.data.tasks.map((t) => (t.id === id ? { ...t, completedAt: Date.now() } : t)),
        },
      }));
    } else {
      set((s) => ({
        data: {
          ...s.data,
          tasks: s.data.tasks.map((t) => (t.id === id ? { ...t, completedAt: null } : t)),
        },
      }));
    }
    get().save();
  },

  deleteTask: (id) => {
    set((s) => ({
      expandedId: s.expandedId === id ? null : s.expandedId,
      data: { ...s.data, tasks: s.data.tasks.filter((t) => t.id !== id) },
    }));
    get().save();
  },

  addGoal: (title, why, deadline, plan = [], milestones = []) => {
    const goal: TodoGoal = {
      id: genId('g'),
      title,
      why,
      deadline,
      remindedAt: null,
      doneAt: null,
      createdAt: Date.now(),
      plan,
      milestones: milestones.map((m) => ({ id: genId('ms'), title: m.title, done: false })),
    };
    set((s) => ({ data: { ...s.data, goals: [...s.data.goals, goal] } }));
    get().save();
    return goal;
  },

  updateGoal: (id, patch) => {
    set((s) => ({
      data: {
        ...s.data,
        goals: s.data.goals.map((g) => (g.id === id ? { ...g, ...patch } : g)),
      },
    }));
    get().save();
  },

  completeGoal: (id) => {
    set((s) => ({
      data: {
        ...s.data,
        goals: s.data.goals.map((g) => (g.id === id ? { ...g, doneAt: Date.now() } : g)),
      },
    }));
    get().save();
  },

  deleteGoal: (id) => {
    set((s) => ({
      data: {
        ...s.data,
        goals: s.data.goals.filter((g) => g.id !== id),
        tasks: s.data.tasks.map((t) => (t.goalId === id ? { ...t, goalId: null } : t)),
      },
    }));
    get().save();
  },

  addFocusSession: (session) => {
    set((s) => ({
      data: { ...s.data, focusSessions: [...s.data.focusSessions, session] },
    }));
    get().save();
  },

  mergeFocusSession: (session) => {
    const { data } = get();
    // 去重：同一 startedAt 视为同一会话（事件重放/竞态防护）
    if (data.focusSessions.some((x) => x.startedAt === session.startedAt)) return;
    set({ data: { ...data, focusSessions: [...data.focusSessions, session] } });
  },

  addReward: (name, cost) => {
    set((s) => ({
      data: {
        ...s.data,
        rewards: [...s.data.rewards, { id: genId('r'), name: name.slice(0, 40), cost: Math.max(1, cost) }],
      },
    }));
    get().save();
  },
}));

// ---- 视图查询（纯函数，组件用 selector） ----

/** 性质推导：有 repeat→周期。目标关联性由志视图自行按 goalId 聚合。 */
export function taskNature(t: TodoTask): 'routine' | 'goal' | 'quick' {
  if (t.repeat) return 'routine';
  if (t.goalId) return 'goal';
  return 'quick';
}

/** 今日之策：当天到期 + 今日新增（吸收原临时/收集箱的无 due 任务）。 */
function isTodayTask(t: TodoTask, today: string): boolean {
  if (t.completedAt) return false;
  if (t.due && t.due <= today) return true;
  // 今日新增（createdAt 在今天；无 due 者借此入口可见）
  const d = new Date(t.createdAt);
  const created = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return created === today;
}

export function tasksOfView(data: TodoData, view: TodoView): TodoTask[] {
  const today = todayStr();
  switch (view) {
    case 'today':
      return data.tasks
        .filter((t) => isTodayTask(t, today))
        .sort((a, b) => {
          if (a.flag !== b.flag) return a.flag ? -1 : 1;
          if ((a.due || '9999') !== (b.due || '9999')) return (a.due || '9999') < (b.due || '9999') ? -1 : 1;
          return a.order - b.order;
        });
    case 'routine':
      return data.tasks.filter((t) => !t.completedAt && taskNature(t) === 'routine').sort((a, b) => a.order - b.order);
    case 'done':
      return data.tasks
        .filter((t) => t.completedAt)
        .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
        .slice(0, 100);
    default:
      return [];
  }
}

export function countOfView(data: TodoData, view: TodoView): number {
  const today = todayStr();
  switch (view) {
    case 'today':
      return data.tasks.filter((t) => isTodayTask(t, today)).length;
    case 'routine':
      return data.tasks.filter((t) => !t.completedAt && taskNature(t) === 'routine').length;
    case 'goal':
      return data.goals.filter((g) => !g.doneAt).length;
    case 'done':
      return data.tasks.filter((t) => t.completedAt).length;
    default:
      return 0;
  }
}

/** 目标关联任务进度 */
export function goalProgress(data: TodoData, goalId: string): { done: number; total: number } {
  const ts = data.tasks.filter((t) => t.goalId === goalId);
  return { done: ts.filter((t) => t.completedAt).length, total: ts.length };
}

export { addDaysStr };
