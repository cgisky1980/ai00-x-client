/**
 * TodoOverlay — todo 核心功能根组件「策」（App.tsx 挂载）。
 *
 * 职责：数据加载 + XP profile 初始化 + 常驻提醒 ticker + 面板渲染
 * + 专注会话事件并入（underlay 番茄钟 → Rust todo_focus_append → 此处入账 XP）。
 * 面板关闭时数据与提醒仍在跑（60s ticker 与面板开关无关）。
 */
import React, { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTodoStore } from '../store/todoStore';
import { useGrowthStore } from '../store/growthStore';
import { useReminderTicker } from '../hooks/useReminderTicker';
import { XpKinds, type FocusSession } from '../api/types';
import { connectMux, dshSession, type DshMuxFrame } from '@/infrastructure/api/service-api/DshAPI';
import { TodoPanel } from './TodoPanel';

export const TodoOverlay: React.FC = () => {
  const loaded = useTodoStore((s) => s.loaded);
  const load = useTodoStore((s) => s.load);
  const initGrowth = useGrowthStore((s) => s.init);
  const setAgentRunning = useTodoStore((s) => s.setAgentRunning);

  useEffect(() => {
    void load();
    void initGrowth();
  }, [load, initGrowth]);

  // 专注会话并入：underlay 番茄钟完成 → Rust 落盘 + 广播 → 内存并入 + XP（1 XP/分钟，封顶 50）
  useEffect(() => {
    const un = listen<FocusSession>('todo-focus-appended', (e) => {
      const s = e.payload;
      if (!s || typeof s.startedAt !== 'number') return;
      useTodoStore.getState().mergeFocusSession({
        taskId: s.taskId ?? null,
        startedAt: s.startedAt,
        minutes: Number(s.minutes) || 0,
        outcome: s.outcome ?? null,
      });
      const minutes = Math.max(1, Math.min(50, Number(s.minutes) || 1));
      void useGrowthStore
        .getState()
        .addXp(XpKinds.focusDone, minutes, { startedAt: s.startedAt })
        .then(() => useGrowthStore.getState().checkBadges());
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // 连续奖励结算：次日首次打开面板时 streak×2（一次性）
  useEffect(() => {
    if (!loaded) return;
    const { data, save } = useTodoStore.getState();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (data.lastStreakSettleDate === todayStr) return;
    useTodoStore.setState((s) => ({ data: { ...s.data, lastStreakSettleDate: todayStr } }));
    save();
    // 连续奖励基于服务器 dayChecks（growthStore init 已拉取）
    const { profile, addXp } = useGrowthStore.getState();
    if (profile.streak >= 2) {
      void addXp('todo.streak_bonus', profile.streak * 2, { streak: profile.streak });
    }
  }, [loaded]);

  // agent 侧 todo 写入（ai00_task_complete / ai00_todo_write / ai00_task_create）
  // → 宿主广播 → 重读盘同步内存态（load 内部 save 幂等无害）
  useEffect(() => {
    const un = listen('todo-agent-updated', () => {
      void useTodoStore.getState().load();
    });
    return () => {
      void un.then(f => f());
    };
  }, []);

  // agent 提问订阅（ask_user_question → 策内嵌问题卡，一步应答不跳主窗）：
  // 独立 mux WS 连接（与主窗 DshScene 并行；指数退避重连，引擎未起静默）
  useEffect(() => {
    const conn = connectMux((frame: DshMuxFrame, rpcId: string) => {
      const store = useTodoStore.getState();
      if (frame.type === 'question/requested') {
        store.upsertAgentQuestion(frame.sessionId, { rpcId, questions: frame.questions });
      } else if (frame.type === 'question/resolved') {
        store.removeAgentQuestion(frame.sessionId, frame.questionRpcId);
      }
    });
    return () => conn.close();
  }, []);

  // agent 会话运行态轮询（30s，非持久化；引擎未起时静默）
  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    const poll = async () => {
      try {
        const { items } = await dshSession.list();
        if (stopped) return;
        const map: Record<string, boolean> = {};
        for (const s of items) map[s.sessionId] = !!s.running;
        setAgentRunning(map);
      } catch {
        // 引擎未启动/接口不可用 → 保留上次态
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 30000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [loaded, setAgentRunning]);

  useReminderTicker();

  if (!loaded) return null;
  return <TodoPanel />;
};
