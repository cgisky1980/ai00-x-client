/** 工作台任务计划书：与 ai00_plan_read/write 共用同一文件，事件到达即热刷新。 */
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TodoTask } from '@/tools/todo/api/types';

export function useTaskPlans(tasks: TodoTask[]): {
  plans: Record<string, string | null>;
  setPlan: (taskId: string, markdown: string) => void;
} {
  const [plans, setPlans] = useState<Record<string, string | null>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        tasks.map(async (task): Promise<[string, string | null]> => {
          try {
            const md = await invoke<string | null>('todo_plan_get', { taskId: task.id });
            return [task.id, md];
          } catch {
            return [task.id, null];
          }
        }),
      );
      if (!cancelled) setPlans(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [tasks]);

  useEffect(() => {
    const un = listen<{ taskId: string }>('todo-plan-updated', (event) => {
      const taskId = event.payload?.taskId;
      if (!taskId) return;
      void invoke<string | null>('todo_plan_get', { taskId })
        .then((md) => setPlans((prev) => ({ ...prev, [taskId]: md })))
        .catch(() => undefined);
    });
    return () => {
      void un.then((dispose) => dispose());
    };
  }, []);

  const setPlan = useCallback((taskId: string, markdown: string): void => {
    setPlans((prev) => ({ ...prev, [taskId]: markdown }));
  }, []);

  return { plans, setPlan };
}
