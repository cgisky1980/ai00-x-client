/**
 * useSessionRunningSync — 把引擎会话的 running 快照回填到 workbenchTaskStore。
 *
 * 为什么会话运行态要全量回填：任务列表/看板里没被打开过的任务没有面板上报，
 * 以前只能靠「有计划书」猜成「执行中」，停下的任务会永远挂着这个标签。
 * 这里挂载时拉一次 `session/list`，之后每 5s 校准一次（窗口重新可见也立即校准）。
 */
import { useEffect } from 'react';
import { dshSession } from '@/infrastructure/api/service-api/DshAPI';
import { useTodoStore } from '@/tools/todo/store/todoStore';
import { useWorkbenchTaskStore } from './workbenchTaskStore';

/**
 * 轮询间隔（5s）：子代理（子会话）跑在独立 session 里，主代理回合一结束
 * 主会话就是 running=false；只有靠快照把「子代理仍在跑」聚合回来，
 * 任务才不会误判成「已停止」。
 */
const REFRESH_MS = 5_000;

export function useSessionRunningSync(): void {
  const seedRunning = useWorkbenchTaskStore((s) => s.seedRunning);
  const seedDelegating = useWorkbenchTaskStore((s) => s.seedDelegating);
  const seedChildren = useWorkbenchTaskStore((s) => s.seedChildren);

  useEffect(() => {
    let alive = true;

    const refresh = (): void => {
      void dshSession
        .list()
        .then(({ items }) => {
          if (!alive) return;
          // 子会话按 parentSessionId 归并：任一子代理在跑 → 主会话也算在跑
          const childRunning = new Map<string, number>();
          for (const item of items) {
            if (!item.parentSessionId || !item.running) continue;
            childRunning.set(
              item.parentSessionId,
              (childRunning.get(item.parentSessionId) ?? 0) + 1,
            );
          }
          seedRunning(
            items.map((item) => ({
              sessionId: item.sessionId,
              running: item.running || (childRunning.get(item.sessionId) ?? 0) > 0,
            })),
          );
          // 会话已不存在（引擎清了会话 / 换了数据目录）的任务：`session/list` 永远
          // 不会给它回填，运行态就一直「未知」，卡片永远显示「执行中」，也没有
          // 「继续执行」可点——用户只能干等。这里按「不在列表 = 没在跑」补一条
          // 停住的快照，让它落到「已停止」，把推进权交回给人。
          const listed = new Set(items.map((item) => item.sessionId));
          const now = useWorkbenchTaskStore.getState().runtime;
          const vanished = useTodoStore
            .getState()
            .data.tasks.filter(
              (task) =>
                task.agentSessionId &&
                !task.completedAt &&
                !listed.has(task.agentSessionId) &&
                !now[task.agentSessionId],
            )
            .map((task) => ({ sessionId: task.agentSessionId as string, running: false }));
          if (vanished.length > 0) seedRunning(vanished);
          seedDelegating(
            items
              .filter((item) => Boolean(item.parentSessionId))
              .map((item) => ({
                parentSessionId: item.parentSessionId as string,
                running: item.running,
              })),
          );
          seedChildren(
            items
              .filter((item) => Boolean(item.parentSessionId))
              .map((item) => ({
                parentSessionId: item.parentSessionId as string,
                sessionId: item.sessionId,
                title: item.projections?.values?.title ?? null,
                preset: item.agentPreset ?? null,
                running: item.running,
                updatedAt: item.updatedAt,
              })),
          );
        })
        .catch(() => undefined); // 引擎未就绪/暂时不可达：保持上一次快照
    };

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };

    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [seedRunning, seedDelegating, seedChildren]);
}
