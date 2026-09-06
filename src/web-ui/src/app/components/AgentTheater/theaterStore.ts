// ========================================================================
// theaterStore：工灵运行时状态 + AgentCard 焦点（§3.5 双向联动）
// ========================================================================
// - 悬浮窗 / DshScene 卡片 / 会话浮层宿主各自订阅；交互入口统一走 openChatPanel
// - enabled 持久化 localStorage（默认关，设计 §6）

import { create } from 'zustand';
import type { ImpRuntimeState, TheaterTurnEndedPayload } from './theaterTypes';

const ENABLED_KEY = 'ai00.theater.enabled';

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeEnabled(v: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, v ? '1' : '0');
  } catch {
    // 隐私模式等 → 忽略
  }
}

export interface SettledTurn {
  outcome: 'success' | 'failed';
  toolCalls: number;
  errors: number;
  durationMs: number;
  taskLabel: string;
  sceneRuleKey?: string;
}

export interface ChatPanelInfo {
  taskLabel: string;
  /** 打开顺序（层叠错位用） */
  openedAt: number;
}

interface TheaterState {
  enabled: boolean;
  /** 活跃工灵（sessionId → 快照） */
  imps: Record<string, ImpRuntimeState>;
  /** 已结算 turn（AgentCard 结算态展示） */
  settled: Record<string, SettledTurn>;
  /** 脉冲高亮的工灵（2s 自动清除） */
  focusedSessionId: string | null;
  /** 会话对话浮层（可多开并存；sessionId → 信息） */
  chatPanels: Record<string, ChatPanelInfo>;

  setEnabled: (v: boolean) => void;
  upsertImp: (s: ImpRuntimeState) => void;
  removeImp: (sessionId: string) => void;
  setSettled: (payload: TheaterTurnEndedPayload, sceneRuleKey?: string) => void;
  /** 双向统一入口：打开 AgentCard + 工灵脉冲 */
  /** 打开/关闭会话对话浮层（多实例；重复打开 = 置顶刷新） */
  openChatPanel: (sessionId: string, taskLabel: string) => void;
  closeChatPanel: (sessionId: string) => void;
}

export const useTheaterStore = create<TheaterState>((set, get) => ({
  enabled: readEnabled(),
  imps: {},
  settled: {},
  focusedSessionId: null,
  chatPanels: {},

  setEnabled: (v) => {
    writeEnabled(v);
    if (!v) {
      set({ enabled: false, imps: {}, focusedSessionId: null });
    } else {
      set({ enabled: true });
    }
  },

  upsertImp: (s) => {
    if (!get().enabled) return;
    set((prev) => ({ imps: { ...prev.imps, [s.sessionId]: s } }));
  },

  removeImp: (sessionId) => {
    set((prev) => {
      const imps = { ...prev.imps };
      delete imps[sessionId];
      return { imps };
    });
  },

  setSettled: (payload, sceneRuleKey) => {
    set((prev) => ({
      settled: {
        ...prev.settled,
        [payload.sessionId]: {
          outcome: payload.outcome,
          toolCalls: payload.stats.toolCalls,
          errors: payload.stats.errors,
          durationMs: payload.stats.durationMs,
          taskLabel: payload.taskLabel,
          sceneRuleKey: sceneRuleKey ?? prev.settled[payload.sessionId]?.sceneRuleKey,
        },
      },
    }));
  },

  openChatPanel: (sessionId, taskLabel) => {
    set((prev) => ({
      focusedSessionId: sessionId, // 脉冲反馈
      chatPanels: {
        ...prev.chatPanels,
        [sessionId]: { taskLabel, openedAt: Date.now() },
      },
    }));
    // 浮层出现改变根矩形 → 捕获区域重算（穿透机制）
    setTimeout(() => {
      import('../../../infrastructure/overlay').then(({ refreshRegions }) => refreshRegions()).catch(() => undefined);
    }, 220);
    // 脉冲 2s 自动清除
    setTimeout(() => {
      if (get().focusedSessionId === sessionId) set({ focusedSessionId: null });
    }, 2_000);
  },

  closeChatPanel: (sessionId) => {
    set((prev) => {
      const chatPanels = { ...prev.chatPanels };
      delete chatPanels[sessionId];
      return { chatPanels };
    });
  },
}));
