/**
 * Todo core — shared types（本地任务数据 + 服务器游戏化档案）。
 *
 * 任务/清单/目标/专注 = 本地（todo_store_* Tauri 命令，{data}/Ai00-X/todo/data.json）；
 * XP/勋章/等级/金币/连续 = 服务器用户扩展属性（/api/v1/me/xp/*）。
 */

// ============ 本地任务数据 ============

export type RepeatType = 'daily' | 'weekly' | 'monthly' | 'weekdays';

/** 看板状态：需求卡 → 计划中 → 进行中（完成走 completedAt → 足迹）。 */
export type TaskStatus = 'requirement' | 'planning' | 'doing';

export interface ChecklistItem {
  t: string;
  d: boolean;
}

/** 规划对话产出的计划契约（卡片级）：目标 + 步骤 + 验收（DoD）+ 交付物。 */
export interface BoardPlan {
  /** 一段话计划摘要 */
  summary: string;
  /** 一句话目标（人机共同确认的目的） */
  goal: string;
  /** 步骤/子任务 */
  tasks: Array<{ title: string; notes?: string }>;
  /** 验收标准 DoD checklist（可客观检验的完成判据；空=免验收） */
  acceptance: string[];
  /** AI 建议的执行模块 id（AGENT_MODULES 键；可缺省——插件时代用） */
  suggestedModule?: string;
  /** 交付物描述 */
  deliverable?: string;
}

/** AI 结构化提问（ask-user 式：选项点选，也欢迎自由输入）。 */
export interface PlanChatQuestion {
  /** 问题本身（一句话） */
  q: string;
  /** 候选选项 2-4 个 */
  options: string[];
  /** 是否鼓励自由输入补充 */
  allowInput?: boolean;
}

/** 卡片级规划对话消息（策内嵌规划对话历史）。 */
export interface PlanChatMessage {
  role: 'user' | 'ai';
  text: string;
  /** AI 消息附带的结构化提问（可选；仅最新一条渲染为可点选） */
  questions?: PlanChatQuestion[];
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
  /** 看板状态（策 v3：需求卡/计划中/进行中；缺省=需求卡，旧数据兼容） */
  status?: TaskStatus;
  /** 规划对话历史（多轮需求讨论；持久化） */
  chat?: PlanChatMessage[];
  /** 计划草案（规划对话产出；确认交付后保留为参考） */
  plan?: BoardPlan | null;
  /** agent 委托：模块 id（AGENT_MODULES 键） */
  agentModule?: string;
  /** 关联 dsh 会话 id */
  agentSessionId?: string;
  /** 委托任务书（交付给 agent 的完整 prompt；定时任务为执行指令） */
  agentPrompt?: string;
  /** 模型自检通过时刻（双段验收第一段；ai00_task_complete 写入）。
   *  completedAt=人类验收通过——完成的唯一判据。 */
  agentCompletedAt?: number | null;
  /** 委托基线快照 commit（agent 动工前拍；diff 起点/回滚目标） */
  agentBaseCommit?: string | null;
  /** agent 自检快照 commit（执行产物定格；与基线 diff 即 agent 改动） */
  agentCommit?: string | null;
  /** 卡片级模型选择（讨论 + 委托执行同源；null=未选过，回落全局默认）。
   *  按卡存储——并行多任务可各用各的模型。 */
  discussModel?: string | null;
}

/** 里程碑（志的阶段划分，与 plan 方案层平行） */
export interface Milestone {
  id: string;
  title: string;
  done: boolean;
}

/** 志分类（志视图左栏分组）。 */
export interface GoalCategory {
  id: string;
  name: string;
  /** 分组图标（emoji） */
  emoji: string;
}

export interface TodoGoal {
  id: string;
  title: string;
  why: string;
  deadline: string | null;
  remindedAt: number | null;
  doneAt: number | null;
  createdAt: number;
  /** 方案层：实施策略段落（AI 起草/用户编辑；空=未定方案）——旧字段，评估上线后不再写入（历史数据兼容保留） */
  plan: string[];
  /** AI 评估报告（最近一次；固定四段结构。绑定项目目录时结合目录结构/README/git 记录实况生成） */
  assessment?: {
    at: number;
    /** 【阶段】当前阶段判断（一两句） */
    stage: string;
    /** 【亮点】1-3 条 */
    highlights: string[];
    /** 【缺口】1-3 条 */
    gaps: string[];
    /** 【建议】下一步最值得做的一件事 */
    advice: string;
  } | null;
  /** 里程碑层：阶段划分（任务挂 milestoneId 可选） */
  milestones: Milestone[];
  /** 项目目录（可选）：关联行卡委托 agent 的工作区（cwd 解析链 卡→志→默认） */
  workspaceDir?: string;
  /** 志图标（emoji，可选） */
  emoji?: string;
  /** 所属分类（goalCategories.id；缺省 = 未分类） */
  categoryId?: string;
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
  /** 志分类（志视图左栏分组） */
  goalCategories: GoalCategory[];
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
}

export const BADGES: BadgeDef[] = [
  { id: 'first-task', name: '第一件事', desc: '完成第一个任务', tier: 'bronze', when: (s) => s.completed >= 1 },
  { id: 'first-focus', name: '初次专注', desc: '完成第一次专注', tier: 'bronze', when: (s) => s.focusSessions >= 1 },
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
