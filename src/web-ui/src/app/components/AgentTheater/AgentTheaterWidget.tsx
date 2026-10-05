// ========================================================================
// AgentTheaterWidget：工灵悬浮窗（island 式，portal 全局挂载）
// ========================================================================
// 职责：
// - enabled 开关驱动 ImpManager + connectMux 生命周期（方案 B）
// - 结算级消息过桥：theater://turn-ended / theater://scene（Tauri 全局 emit）
// - 渲染活跃工灵 + AgentCard；可拖拽（useDraggable + 区域跟随）、位置记忆
//
// 穿透机制对齐 SettingsDialog/MusicPopup 配方：
//  1) 根节点挂 `.no-penetrate`（mouseThrough 上报捕获区域）
//  2) 拖拽走 useDraggable：拖动中 setDragging(true)、结束后 refreshRegions
//  3) 位置变化后 refreshRegions 跟随（否则捕获区域滞留旧位，拖拽中断）

import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { emit } from '@tauri-apps/api/event';
import { connectMux, dshSession } from '../../../infrastructure/api/service-api/DshAPI';
import type { DshMuxFrame } from '../../../infrastructure/api/service-api/DshAPI';
import { useDraggable, refreshRegions, setDragging } from '../../../infrastructure/overlay';
import { WindowAPI } from '@/infrastructure/windows/WindowAPI';
import { ImpManager } from './ImpManager';
import { useTheaterStore } from './theaterStore';
import { useTodoStore } from '@/tools/todo/store/todoStore';
import { requestFocusTask } from '@/tools/todo/sync/todoWindowSync';
import { AgentImp } from './AgentImp';
import type { TheaterTurnEndedPayload } from './theaterTypes';
import './AgentTheater.scss';

const POSITION_KEY = 'ai00.theater.widget-pos';

async function emitBridgeEvent(name: string, payload: unknown): Promise<void> {
  try {
    await emit(name, payload);
  } catch {
    // 纯 web dev（无 Tauri）→ 桥不可用，静默
  }
}

/**
 * P2-A：回合结束 OS 通知（给不在屏幕前的人）。
 * 文本刻意泛化——只到结果粒度，不含 prompt/回复/路径/模型名；
 * 页面可见时不弹（用户在场，剧场动画已足够）；开关走 app.notifications.*。
 */
async function notifyTurnEnded(
  payload: TheaterTurnEndedPayload,
  text: { success: string; failed: string },
): Promise<void> {
  try {
    if (typeof window === 'undefined' || !('__TAURI__' in window)) return;
    // 注意：不做 visibilityState 检查——overlay 常驻可见，查了等于永不通知；
    // 「前台不弹」的克制由用户开关承担（不需要就关掉）。
    const { configManager } = await import('@/infrastructure/config');
    const failed = payload.outcome === 'failed';
    const key = failed
      ? 'app.notifications.dialog_failure_notify'
      : 'app.notifications.dialog_completion_notify';
    const enabled = await configManager
      .getConfig<boolean>(key)
      .then((v) => v !== false)
      .catch(() => true);
    if (!enabled) return;
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      '@tauri-apps/plugin-notification'
    );
    if (!(await isPermissionGranted())) {
      const granted = await requestPermission();
      if (!granted) return;
    }
    sendNotification({
      title: `Ai00-X · ${failed ? text.failed : text.success}`,
      body: failed ? text.failed : text.success,
    });
  } catch {
    // 通知链路任何失败都静默（提示条不是关键路径）
  }
}

function readPosition(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { x: number; y: number };
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    }
  } catch {
    // ignore
  }
  // 默认右上停靠
  return { x: Math.max(0, window.innerWidth - 220), y: 64 };
}

export const AgentTheaterWidget: React.FC = () => {
  const { t } = useTranslation('agentTheater');
  const enabled = useTheaterStore((s) => s.enabled);
  const imps = useTheaterStore((s) => s.imps);
  const focusedSessionId = useTheaterStore((s) => s.focusedSessionId);
  const upsertImp = useTheaterStore((s) => s.upsertImp);
  const removeImp = useTheaterStore((s) => s.removeImp);
  const setSettled = useTheaterStore((s) => s.setSettled);

  const managerRef = useRef<ImpManager | null>(null);
  const settledRef = useRef<Map<string, TheaterTurnEndedPayload>>(new Map());

  const initialPos = useRef(readPosition());
  const {
    position,
    elementRef,
    handleMouseDown,
    isDragging,
  } = useDraggable({
    initialPosition: initialPos.current,
    // 拖拽期间捕获区域进入跟随模式（mouseThrough.setDragging），
    // 否则鼠标离开旧区域瞬间窗口恢复穿透、拖拽中断
    onDragStart: () => setDragging(true),
    onDragEnd: () => {
      setDragging(false);
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify(position));
      } catch {
        // ignore
      }
    },
  });

  // 验收完成 → 对应工灵离场（task.completedAt 即验收结束信号）
  const tasks = useTodoStore((st) => st.data.tasks);
  useEffect(() => {
    const completedSessions = new Set(
      tasks.filter(t => t.completedAt && t.agentSessionId).map(t => t.agentSessionId as string),
    );
    for (const sid of completedSessions) {
      managerRef.current?.markCompleted(sid);
    }
  }, [tasks]);

  // 位置变化 → 捕获区域跟随（对齐 SettingsDialog 的 refreshRegions 配方）
  useEffect(() => {
    const timer = setTimeout(() => refreshRegions(), 200);
    return () => clearTimeout(timer);
  }, [position]);

  // T4：事件源生命周期（enabled 驱动）
  useEffect(() => {
    if (!enabled) return undefined;
    const manager = new ImpManager(
      {
        onImpState: upsertImp,
        onImpRemoved: removeImp,
        onTurnEnded: (payload) => {
          settledRef.current.set(payload.sessionId, payload);
          setSettled(payload);
          void emitBridgeEvent('theater://turn-ended', payload);
          void notifyTurnEnded(payload, {
            success: t('notifyTurnSuccess'),
            failed: t('notifyTurnFailed'),
          });
        },
        onScene: (payload) => {
          const turn = settledRef.current.get(payload.sessionId);
          if (turn) setSettled(turn, payload.ruleKey);
          void emitBridgeEvent('theater://scene', payload);
        },
      },
      {
        // 任务标签为空时回退会话标题（store 里没有列表，先留空，DshScene 侧可回填）
      },
    );
    manager.start();
    managerRef.current = manager;
    const settledMap = settledRef.current;

    // 方案 B：悬浮窗自建 mux 连接（指数退避重连在 connectMux 内建）
    const conn = connectMux((frame: DshMuxFrame) => manager.handleMuxFrame(frame));

    // 运行中会话对账（10s）：中途开启剧场 / 错过 turn/start 的会话也补出工灵
    const reconcile = async (): Promise<void> => {
      try {
        const { items } = await dshSession.list();
        const running = items
          .filter((it) => it.running)
          .map((it) => ({
            sessionId: it.sessionId,
            title: it.projections?.values?.title ?? undefined,
          }));
        manager.syncRunningSessions(running);
        // 已停止的会话：活跃阶段工灵收敛到 待验收/失败警示
        const failed = useTodoStore.getState().agentFailed;
        manager.settleNotRunning(new Set(running.map(r => r.sessionId)), failed);
      } catch {
        // 引擎未启动 → 静默
      }
    };
    void reconcile();
    const pollTimer = setInterval(() => void reconcile(), 10_000);

    return () => {
      conn.close();
      clearInterval(pollTimer);
      manager.dispose();
      managerRef.current = null;
      settledMap.clear();
    };
  }, [enabled, upsertImp, removeImp, setSettled, t]);

  if (!enabled) return null;
  const list = Object.values(imps).sort((a, b) => a.startedAt - b.startedAt);

  /**
   * 点击工灵 → 激活策窗口并定位到对应卡片。
   *
   * 不再打开会话浮层（2026-09-12 决策变更）：浮层与策窗口的 ExecChatPanel
   * 是同一份对话的两个入口，并存会让用户困惑；且策窗口能同时给出卡片的
   * 计划/验收/讨论上下文，信息更完整。
   *
   * 工灵驻留不因点击离场——验收完成才离场。
   */
  const handleLocate = (sessionId: string): void => {
    // sessionId → 卡片：靠 task.agentSessionId 反查（useAgentDelegate 回写时落的字段）
    const task = useTodoStore.getState().data.tasks.find(t => t.agentSessionId === sessionId);
    if (!task) return; // 会话未绑定卡片（非策委派来源）→ 无卡片可定位，忽略

    void WindowAPI.open('tasks');
    requestFocusTask(task.id);
  };

  const handleDismissImp = (sessionId: string): void => {
    managerRef.current?.dismiss(sessionId);
  };

  return createPortal(
    <div
      ref={elementRef}
      className={`ai00-agent-theater no-penetrate${isDragging ? ' is-dragging' : ''}`}
      onMouseDown={handleMouseDown}
      style={{ left: position.x, top: position.y }}
    >
      {list.map((s) => (
        <AgentImp
          key={s.sessionId}
          state={s}
          focused={focusedSessionId === s.sessionId}
          onLocate={handleLocate}
          onDismiss={handleDismissImp}
        />
      ))}
    </div>,
    document.body,
  );
};
