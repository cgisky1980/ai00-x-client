/**
 * Todo core — shared types（本地任务数据 + 服务器游戏化档案）。
 *
 * 任务/清单/目标/专注 = 本地（todo_store_* Tauri 命令，{data}/Ai00-X/todo/data.json）；
 * XP/勋章/等级/金币/连续 = 服务器用户扩展属性（/api/v1/me/xp/*）。
 */

// ============ 本地任务数据 ============

export type RepeatType = 'daily' | 'weekly' | 'monthly' | 'weekdays';

export interface ChecklistItem {
  t: string;
  d: boolean;
}

export interface TodoTask {
  id: string;
  listId: string | null;
  title: string;
  notes: string;
  due: string | null; // 'YYYY-MM-DD'
  repeat: { type: RepeatType; afterCompletion: boolean } | null;
  checklist: ChecklistItem[];
  flag: boolean;
  completedAt: number | null;
  createdAt: number;
  order: number;
  focus: { pomodoros: number; minutes: number };
  goalId: string | null;
  /** 所属里程碑（志的阶段；null=未分阶段） */
  milestoneId: string | null;
  /** 提醒（本地时间 'YYYY-MM-DDTHH:mm'） */
  remindAt: string | null;
  /** 已提醒时间戳（防重发；跨设备由本地文件保证） */
  remindedAt: number | null;
}

/** 里程碑（志的阶段划分，与 plan 方案层平行） */
export interface Milestone {
  id: string;
  title: string;
  done: boolean;
}

export interface TodoGoal {
  id: string;
  title: string;
  why: string;
  deadline: string | null;
  remindedAt: number | null;
  doneAt: number | null;
  createdAt: number;
  /** 方案层：实施策略段落（AI 起草/用户编辑；空=未定方案） */
  plan: string[];
  /** 里程碑层：阶段划分（任务挂 milestoneId 可选） */
  milestones: Milestone[];
}

export interface TodoList {
  id: string;
  name: string;
  order: number;
}

export interface FocusSession {
  taskId: string | null;
  startedAt: number;
  minutes: number;
  outcome: string | null;
}

export interface TodoData {
  version: number;
  lists: TodoList[];
  goals: TodoGoal[];
  tasks: TodoTask[];
  focusSessions: FocusSession[];
  /** 自定义奖励（本地） */
  rewards: { id: string; name: string; cost: number }[];
  /** 上次连续奖励结算日（'YYYY-MM-DD'） */
  lastStreakSettleDate: string | null;
  /** 插件→核心迁移完成标记 */
  migratedFromPlugin: boolean;
}

// ============ 服务器游戏化（用户扩展属性） ============

export interface XpProfile {
  totalXp: number;
  level: number;
  into: number;
  need: number;
  coins: number;
  streak: number;
  badges: string[];
  dayChecks: string[];
}

export interface XpEvent {
  id: number;
  kind: string;
  amount: number;
  meta: Record<string, unknown>;
  createdAt: string;
}

/** XP 事件 kind（todo 模块命名空间） */
export const XpKinds = {
  taskDone: 'todo.task_done',
  focusDone: 'todo.focus_done',
  badgeUnlock: 'todo.badge_unlock',
  dayCheck: 'todo.day_check',
  streakBonus: 'todo.streak_bonus',
  rewardSpend: 'todo.reward_spend',
  legacyImport: 'todo.legacy_import',
} as const;

/** 勋章目录（17 枚，铜/银/金）。客户端判定条件，解锁入服务器账本。 */
export interface BadgeDef {
  id: string;
  name: string;
  desc: string;
  tier: 'bronze' | 'silver' | 'gold';
  when: (s: BadgeStats) => boolean;
}

export interface BadgeStats {
  completed: number;
  focusSessions: number;
  focusMin: number;
  streak: number;
  lists: number;
  goals: number;
  goalsDone: number;
  consults: number;
}

export const BADGES: BadgeDef[] = [
  { id: 'first-task', name: '第一件事', desc: '完成第一个任务', tier: 'bronze', when: (s) => s.completed >= 1 },
  { id: 'first-focus', name: '初次专注', desc: '完成第一次专注', tier: 'bronze', when: (s) => s.focusSessions >= 1 },
  { id: 'first-consult', name: '细谈成事', desc: '用细谈创建任务', tier: 'bronze', when: (s) => s.consults >= 1 },
  { id: 'tasks-10', name: '渐入佳境', desc: '累计完成 10 个任务', tier: 'bronze', when: (s) => s.completed >= 10 },
  { id: 'tasks-50', name: '轻车熟路', desc: '累计完成 50 个任务', tier: 'silver', when: (s) => s.completed >= 50 },
  { id: 'tasks-200', name: '百炼成钢', desc: '累计完成 200 个任务', tier: 'gold', when: (s) => s.completed >= 200 },
  { id: 'tasks-500', name: '登峰造极', desc: '累计完成 500 个任务', tier: 'gold', when: (s) => s.completed >= 500 },
  { id: 'focus-1h', name: '静水流深', desc: '累计专注 1 小时', tier: 'bronze', when: (s) => s.focusMin >= 60 },
  { id: 'focus-10h', name: '心无旁骛', desc: '累计专注 10 小时', tier: 'silver', when: (s) => s.focusMin >= 600 },
  { id: 'focus-50h', name: '入定', desc: '累计专注 50 小时', tier: 'gold', when: (s) => s.focusMin >= 3000 },
  { id: 'streak-3', name: '三日不辍', desc: '连续 3 天有完成', tier: 'bronze', when: (s) => s.streak >= 3 },
  { id: 'streak-7', name: '七日一周', desc: '连续 7 天有完成', tier: 'silver', when: (s) => s.streak >= 7 },
  { id: 'streak-30', name: '月盈则满', desc: '连续 30 天有完成', tier: 'gold', when: (s) => s.streak >= 30 },
  { id: 'streak-100', name: '百日筑基', desc: '连续 100 天有完成', tier: 'gold', when: (s) => s.streak >= 100 },
  { id: 'first-list', name: '开卷立目', desc: '创建第一个清单', tier: 'bronze', when: (s) => s.lists >= 1 },
  { id: 'first-goal', name: '志存高远', desc: '设立第一个目标', tier: 'bronze', when: (s) => s.goals >= 1 },
  { id: 'first-goal-done', name: '有志竟成', desc: '达成第一个目标', tier: 'gold', when: (s) => s.goalsDone >= 1 },
];
