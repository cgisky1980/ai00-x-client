/**
 * TasksWindowApp — 「策」独立窗口根组件（窗口 label = tasks）。
 *
 * 只做三件事：加载数据 → 接上跨窗口同步 → 渲染看板。
 *
 * **刻意不在这里挂 `TodoOverlay`**：提醒 ticker、agent 看门狗、DSH mux 连接
 * 仍由常驻 overlay 窗口的运行时承担。若把它们搬到本窗口，窗口一关，到点提醒、
 * 卡死自动恢复就全停了——这是本次拆分里最容易踩的坑。
 */
import React, { useEffect } from 'react';
import { TodoPanel } from '../tools/todo/components/TodoPanel';
import { useTodoStore } from '../tools/todo/store/todoStore';
import { initTodoWindowSync } from '../tools/todo/sync/todoWindowSync';

const TasksWindowApp: React.FC = () => {
  const loaded = useTodoStore((s) => s.loaded);

  useEffect(() => {
    void useTodoStore.getState().load();
    return initTodoWindowSync('ui');
  }, []);

  if (!loaded) return null;
  return <TodoPanel />;
};

export default TasksWindowApp;
