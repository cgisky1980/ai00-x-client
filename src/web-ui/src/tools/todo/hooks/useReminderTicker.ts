/**
 * useReminderTicker — 常驻提醒扫描（60s，与面板开关无关）。
 *
 * 任务 remindAt（本地 'YYYY-MM-DDTHH:mm'）与目标 deadline（当天 09:00）
 * 到点 → 系统通知（send_system_notification）→ 写 remindedAt 防重发。
 * 7 天补发窗口：错过 ≤7 天的提醒补发一次并加「(已过期)」前缀；
 * 超 7 天静默标记不弹。
 *
 * 恒·AI 做（agentModule 非空）：到点不弹通知，直接委托 dsh agent
 * 执行（useAgentDelegate），完成后由 ai00_task_complete 闭环并滚动
 * 下一周期（completeTask 的 repeat 克隆）。
 */
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTodoStore } from '../store/todoStore';
import { useAgentDelegate } from './useAgentDelegate';
import type { TodoTask } from '../api/types';

const REMINDER_WINDOW_MS = 7 * 86400000;
/** 恒·AI 做：错过超过此窗口不再自动触发（防休眠唤醒后集中开火） */
const AGENT_TRIGGER_WINDOW_MS = 30 * 60000;

function parseLocal(dt: string): number {
  // 'YYYY-MM-DDTHH:mm' → 本地时间戳
  const [date, time] = dt.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '09:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

async function notify(title: string, body: string) {
  try {
    await invoke('send_system_notification', { request: { title, body } });
  } catch {
    // 通知权限拒绝等 → 静默（今天视图 overdue 兜底可见）
  }
}

export function useReminderTicker(): void {
  const { delegate } = useAgentDelegate();

  useEffect(() => {
    let stopped = false;

    const scan = () => {
      if (stopped) return;
      const { data, updateTask, save } = useTodoStore.getState();
      const now = Date.now();

      const dueAgentTasks: TodoTask[] = [];
      for (const t of data.tasks) {
        if (!t.remindAt || t.remindedAt || t.completedAt) continue;
        const at = parseLocal(t.remindAt);
        if (now < at) continue;

        // 恒·AI 做：到点委托 agent（错过 >30min 静默跳过，防休眠唤醒集中触发）
        if (t.agentModule) {
          if (now - at <= AGENT_TRIGGER_WINDOW_MS) dueAgentTasks.push(t);
          updateTask(t.id, { remindedAt: now });
          continue;
        }

        const overdue = now - at > REMINDER_WINDOW_MS;
        if (!overdue) {
          notify('待办提醒' + (now - at > 600000 ? '（已过期）' : ''), t.title);
        }
        updateTask(t.id, { remindedAt: now });
      }

      // 串行委托（await 逐个完成，避免 busy 锁丢弃）
      if (dueAgentTasks.length) {
        void (async () => {
          for (const t of dueAgentTasks) {
            await delegate(t);
          }
        })();
      }

      // 目标 deadline 当天 09:00
      const now2 = new Date();
      const todayKey = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, '0')}-${String(now2.getDate()).padStart(2, '0')}`;
      const d2 = useTodoStore.getState().data;
      const goalPatch: { id: string; remindedAt: number }[] = [];
      for (const g of d2.goals) {
        if (!g.deadline || g.doneAt || g.remindedAt) continue;
        if (g.deadline !== todayKey) continue;
        if (now2.getHours() >= 9) {
          notify('目标截止', g.title);
          goalPatch.push({ id: g.id, remindedAt: now });
        }
      }
      if (goalPatch.length) {
        useTodoStore.setState((s) => ({
          data: {
            ...s.data,
            goals: s.data.goals.map((g) => {
              const p = goalPatch.find((x) => x.id === g.id);
              return p ? { ...g, remindedAt: p.remindedAt } : g;
            }),
          },
        }));
        save();
      }
    };

    scan();
    const timer = setInterval(scan, 60000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [delegate]);
}
