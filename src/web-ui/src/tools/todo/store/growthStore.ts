/**
 * growthStore — 游戏化（XP/等级/勋章/金币/连续）store。
 *
 * 账本在服务器（member_xp_events，用户扩展属性，跨设备）；未登录/离线时
 * 事件进本地待同步队列（上限 200 条），登录/恢复后重放（服务器按 kind
 * 去重保证幂等）。勋章解锁条件在客户端判定（读本地任务统计），解锁事实
 * 写服务器账本（badgeId 去重）。
 */
import { create } from 'zustand';
import { addXpEvent, getXpProfile } from '../api/XpApi';
import { BADGES, XpKinds, type BadgeStats, type XpProfile } from '../api/types';
import { todayStr, useTodoStore } from './todoStore';

const QUEUE_KEY = 'todo.xp.queue.v1';
const QUEUE_MAX = 200;

interface QueuedEvent {
  kind: string;
  amount: number;
  meta: Record<string, unknown>;
}

function loadQueue(): QueuedEvent[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedEvent[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(q: QueuedEvent[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX)));
  } catch {
    /* 忽略配额错误 */
  }
}

/** 本地勋章统计（含服务器 streak） */
function badgeStats(streak: number): BadgeStats {
  const data = useTodoStore.getState().data;
  return {
    completed: data.tasks.filter((t) => t.completedAt).length,
    focusSessions: data.focusSessions.length,
    focusMin: data.focusSessions.reduce((a, s) => a + (s.minutes || 0), 0),
    streak,
    lists: data.lists.length,
    goals: data.goals.length,
    goalsDone: data.goals.filter((g) => g.doneAt).length,
  };
}

interface ToastMsg {
  id: number;
  title: string;
  sub?: string;
}

interface GrowthState {
  profile: XpProfile;
  syncing: boolean;
  toast: ToastMsg | null;
  /** 服务器不可用时的本地影子累计（未入账 XP） */
  pendingXp: number;
  init: () => Promise<void>;
  addXp: (kind: string, amount: number, meta?: Record<string, unknown>) => Promise<void>;
  markDayCheck: () => Promise<void>;
  checkBadges: () => Promise<void>;
  spendCoins: (cost: number, name: string) => Promise<boolean>;
  showToast: (title: string, sub?: string) => void;
  dismissToast: () => void;
}

const EMPTY_PROFILE: XpProfile = {
  totalXp: 0,
  level: 1,
  into: 0,
  need: 120,
  coins: 0,
  streak: 0,
  badges: [],
  dayChecks: [],
};

/** 本地推导等级（影子模式：profile + pendingXp） */
function localLevel(totalXp: number): { level: number; into: number; need: number } {
  let level = 1;
  let into = totalXp;
  for (;;) {
    const need = 80 + level * 40;
    if (into < need) return { level, into, need };
    into -= need;
    level++;
  }
}

export const useGrowthStore = create<GrowthState>((set, get) => ({
  profile: EMPTY_PROFILE,
  syncing: false,
  toast: null,
  pendingXp: 0,

  init: async () => {
    set({ syncing: true });
    try {
      const profile = await getXpProfile();
      set({ profile, syncing: false });
      await get().checkBadges();
      // 重放离线队列（服务器按 kind/meta 去重，幂等）
      const queue = loadQueue();
      if (queue.length) {
        saveQueue([]);
        for (const ev of queue) {
          await addXpEvent(ev.kind, ev.amount, ev.meta).catch(() => {});
        }
        const fresh = await getXpProfile();
        set({ profile: fresh });
      }
    } catch {
      // 未登录 / 服务器不可用：保持影子模式
      set({ syncing: false });
    }
  },

  addXp: async (kind, amount, meta = {}) => {
    // 乐观更新（影子 XP 先加）
    set((s) => {
      const total = s.profile.totalXp + s.pendingXp + amount;
      const lv = localLevel(total);
      return {
        pendingXp: s.pendingXp + amount,
        profile: {
          ...s.profile,
          level: lv.level,
          into: lv.into,
          need: lv.need,
        },
      };
    });
    try {
      await addXpEvent(kind, amount, meta);
      const profile = await getXpProfile();
      set({ profile, pendingXp: 0 });
    } catch {
      const q = loadQueue();
      q.push({ kind, amount, meta });
      saveQueue(q);
    }
  },

  markDayCheck: async () => {
    const today = todayStr();
    if (get().profile.dayChecks.includes(today)) return;
    set((s) => ({ profile: { ...s.profile, dayChecks: [...s.profile.dayChecks, today] } }));
    try {
      await addXpEvent(XpKinds.dayCheck, 0, { date: today });
    } catch {
      const q = loadQueue();
      q.push({ kind: XpKinds.dayCheck, amount: 0, meta: { date: today } });
      saveQueue(q);
    }
  },

  checkBadges: async () => {
    const stats = badgeStats(get().profile.streak);
    const unlocked = new Set(get().profile.badges);
    for (const b of BADGES) {
      if (!unlocked.has(b.id) && b.when(stats)) {
        set((s) => ({ profile: { ...s.profile, badges: [...s.profile.badges, b.id] } }));
        get().showToast(`勋章解锁 · ${b.name}`, b.desc);
        try {
          await addXpEvent(XpKinds.badgeUnlock, 0, { badgeId: b.id });
        } catch {
          const q = loadQueue();
          q.push({ kind: XpKinds.badgeUnlock, amount: 0, meta: { badgeId: b.id } });
          saveQueue(q);
        }
      }
    }
  },

  spendCoins: async (cost, name) => {
    if (get().profile.coins + Math.floor(get().pendingXp / 10) < cost) return false;
    // 金币扣减走负值 reward_spend 事件（服务器 coins = floor(xp/10) - spent）
    set((s) => ({ profile: { ...s.profile, coins: s.profile.coins - cost } }));
    try {
      await addXpEvent(XpKinds.rewardSpend, -cost, { name });
    } catch {
      const q = loadQueue();
      q.push({ kind: XpKinds.rewardSpend, amount: -cost, meta: { name } });
      saveQueue(q);
    }
    get().showToast(`兑换成功 · ${name.slice(0, 12)}`, '好好犒劳自己');
    return true;
  },

  showToast: (title, sub) => {
    const id = Date.now();
    set({ toast: { id, title, sub } });
    setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 2600);
  },

  dismissToast: () => set({ toast: null }),
}));
