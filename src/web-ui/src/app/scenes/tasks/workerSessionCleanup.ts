/**
 * workerSessionCleanup — 清理「已完成 / 已归档任务」遗留的子代理会话目录。
 *
 * 引擎每次派发 worker 都是一个子会话（目录名是裸 UUID，父会话是 `session-<uuid>`），
 * 一个多步任务会留下十几个；引擎没有删除会话的 RPC。宿主启动时会自动清掉 7 天前的
 * 子会话（`dsh_manager::prune_stale_worker_sessions`），但刚完成的任务仍会越积越多。
 *
 * 这里提供**显式**清理：只挑「父任务已完成 / 已归档且子会话不在运行」的 id，
 * 逐个交给宿主 `delete_worker_session_dir`（只删子会话目录，父会话永不动）。
 */
import { invoke } from '@tauri-apps/api/core';
import { dshSession } from '@/infrastructure/api/service-api/DshAPI';
import { useTodoStore } from '@/tools/todo/store/todoStore';

export interface WorkerCleanupPlan {
  ids: string[];
}

/** 计算可安全清理的子代理会话（不落盘、不删除）。 */
export async function collectWorkerCleanupPlan(): Promise<WorkerCleanupPlan> {
  const { items } = await dshSession.list();
  const tasks = useTodoStore.getState().data.tasks;
  const taskBySession = new Map<string, (typeof tasks)[number]>();
  for (const task of tasks) {
    if (task.agentSessionId) taskBySession.set(task.agentSessionId, task);
  }
  const ids: string[] = [];
  for (const item of items) {
    if (!item.parentSessionId || item.running) continue;
    const parent = taskBySession.get(item.parentSessionId);
    if (!parent) continue; // 找不到父任务：保守起见不动
    if (!parent.completedAt && !parent.archivedAt) continue; // 任务还没收口：可能还要看 worker 记录
    ids.push(item.sessionId);
  }
  return { ids };
}

/** 逐个删除子会话目录；返回成功/失败计数。 */
export async function deleteWorkerSessions(
  ids: string[],
): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  for (const sessionId of ids) {
    try {
      const res = await invoke<{ removed: boolean }>('delete_worker_session_dir', {
        request: { sessionId },
      });
      if (res?.removed) removed += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}
