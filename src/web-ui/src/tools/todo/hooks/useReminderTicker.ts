/**
 * useReminderTicker — 常驻提醒扫描（60s，与面板开关无关）。
 *
 * 任务 remindAt（本地 'YYYY-MM-DDTHH:mm'）与目标 deadline（当天 09:00）
 * 到点 → 系统通知（send_system_notification）→ 写 remindedAt 防重发。
 * 7 天补发窗口：错过 ≤7 天的提醒补发一次并加「(已过期)」前缀；
 * 超 7 天静默标记不弹。
 */
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTodoStore } from '../store/todoStore';

const REMINDER_WINDOW_MS = 7 * 86400000;

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
  useEffect(() => {
    let stopped = false;

    const scan = () => {
      if (stopped) return;
      const { data, updateTask, save } = useTodoStore.getState();
      const now = Date.now();

      for (const t of data.tasks) {
        if (!t.remindAt || t.remindedAt || t.completedAt) continue;
        const at = parseLocal(t.remindAt);
        if (now < at) continue;
        const overdue = now - at > REMINDER_WINDOW_MS;
        if (!overdue) {
          notify('待办提醒' + (now - at > 600000 ? '（已过期）' : ''), t.title);
        }
        updateTask(t.id, { remindedAt: now });
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
  }, []);
}
