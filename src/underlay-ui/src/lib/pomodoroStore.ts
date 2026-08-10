/**
 * Pomodoro session store.
 *
 * 持久化番茄钟会话到 Tauri KV（pref store），支持：
 * - 当前进行中的会话（刷新/重启后恢复）
 * - 近 7 天历史会话（自动清理）
 * - 今日统计聚合
 */
import { storage } from '@underlay/lib/storage';
import { todayDateStr, localDateStr } from '@underlay/lib/api/usageStatsApi';

// ============ Types ============

export type PomodoroState = 'idle' | 'running' | 'break' | 'finished' | 'aborted';

export interface PomodoroTopApp {
  name: string;
  icon: string | null;
  secs: number;
}

export interface PomodoroSession {
  /** uuid */
  id: string;
  /** epoch ms */
  startedAt: number;
  /** epoch ms，null 表示进行中 */
  endedAt: number | null;
  /** 计划时长（分钟），通常 25 */
  plannedDurationMin: number;
  state: PomodoroState;
  /** 番茄钟结束时填充（来自 usage_stats_timeline 时间窗口聚合） */
  actualActiveSecs: number | null;
  actualAfkSecs: number | null;
  topApps: PomodoroTopApp[];
}

export interface PomodoroStats {
  todaySessions: PomodoroSession[];
  todayCompletedCount: number;
  todayTotalFocusSecs: number;
}

// ============ Constants ============

const SESSIONS_KEY = 'ai00.pomodoro.sessions';
const CURRENT_KEY = 'ai00.pomodoro.current';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAILY_GOAL = 8;

// ============ Helpers ============

/** 生成简单 uuid（crypto.randomUUID 优先，回退到时间戳+随机） */
function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 判断会话是否属于今天（按本地日期） */
function isToday(session: PomodoroSession): boolean {
  if (!session.endedAt) return false;
  return localDateStr(new Date(session.endedAt)) === todayDateStr();
}

/** 判断会话是否在 7 天内 */
function isWithinSevenDays(session: PomodoroSession): boolean {
  if (!session.endedAt) return true;
  return Date.now() - session.endedAt < SEVEN_DAYS_MS;
}

// ============ Store API ============

export const pomodoroStore = {
  DAILY_GOAL,

  /** 读取所有历史会话（已自动清理 7 天前数据） */
  async listSessions(): Promise<PomodoroSession[]> {
    const sessions = await storage.getJson<PomodoroSession[]>(SESSIONS_KEY);
    if (!sessions || !Array.isArray(sessions)) return [];
    // 清理 7 天前的会话
    const valid = sessions.filter(isWithinSevenDays);
    if (valid.length !== sessions.length) {
      await storage.setJson(SESSIONS_KEY, valid);
    }
    return valid;
  },

  /** 获取今日已完成的会话（state=finished） */
  async getTodaySessions(): Promise<PomodoroSession[]> {
    const all = await this.listSessions();
    return all.filter(s => s.state === 'finished' && isToday(s));
  },

  /** 获取今日统计 */
  async getTodayStats(): Promise<PomodoroStats> {
    const todaySessions = await this.getTodaySessions();
    const todayCompletedCount = todaySessions.length;
    const todayTotalFocusSecs = todaySessions.reduce(
      (sum, s) => sum + (s.actualActiveSecs ?? 0),
      0
    );
    return { todaySessions, todayCompletedCount, todayTotalFocusSecs };
  },

  /** 添加一个完成的会话到历史 */
  async addSession(session: PomodoroSession): Promise<void> {
    const all = await this.listSessions();
    all.push(session);
    // 按 endedAt 升序排序
    all.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    await storage.setJson(SESSIONS_KEY, all);
  },

  /** 读取当前进行中的会话（null 表示无） */
  async getCurrentSession(): Promise<PomodoroSession | null> {
    return await storage.getJson<PomodoroSession | null>(CURRENT_KEY);
  },

  /** 设置当前进行中的会话（启动番茄钟时调用） */
  async setCurrentSession(session: PomodoroSession | null): Promise<void> {
    if (session === null) {
      await storage.remove(CURRENT_KEY);
    } else {
      await storage.setJson(CURRENT_KEY, session);
    }
  },

  /** 启动一个新的番茄钟会话 */
  async startSession(plannedDurationMin: number = 25): Promise<PomodoroSession> {
    const session: PomodoroSession = {
      id: genId(),
      startedAt: Date.now(),
      endedAt: null,
      plannedDurationMin,
      state: 'running',
      actualActiveSecs: null,
      actualAfkSecs: null,
      topApps: [],
    };
    await this.setCurrentSession(session);
    return session;
  },

  /** 完成当前会话（填充使用统计数据后存入历史并清除 current） */
  async finishCurrentSession(
    actualActiveSecs: number,
    actualAfkSecs: number,
    topApps: PomodoroTopApp[]
  ): Promise<PomodoroSession | null> {
    const current = await this.getCurrentSession();
    if (!current) return null;
    const finished: PomodoroSession = {
      ...current,
      endedAt: Date.now(),
      state: 'finished',
      actualActiveSecs,
      actualAfkSecs,
      topApps,
    };
    await this.addSession(finished);
    await this.setCurrentSession(null);
    return finished;
  },

  /** 中止当前会话（不计入今日完成数，但保留记录） */
  async abortCurrentSession(): Promise<PomodoroSession | null> {
    const current = await this.getCurrentSession();
    if (!current) return null;
    const aborted: PomodoroSession = {
      ...current,
      endedAt: Date.now(),
      state: 'aborted',
      actualActiveSecs: null,
      actualAfkSecs: null,
      topApps: [],
    };
    await this.addSession(aborted);
    await this.setCurrentSession(null);
    return aborted;
  },
};
