/**
 * todoWindowSync — 「策」跨窗口状态同步。
 *
 * 「策」被拆成两半：
 * - **运行时窗口（overlay 内的 `TodoOverlay`）**：常驻，拥有提醒 ticker、
 *   agent 看门狗（30s 轮询 + AI 卡死判定 + 自动恢复）、DSH mux 连接。
 *   因此它是 `agentRunning` / `agentFailed` / `agentQuestions` 的**唯一 owner**；
 * - **UI 窗口（独立 `todo` 窗口）**：只渲染看板，**不跑**轮询与 mux
 *   （否则会出现两条 WS 连接、两份 AI 卡死判定，可能重复中断同一会话）。
 *
 * 同步三类状态：
 *
 * | 事件 | 方向 | 真源 |
 * |---|---|---|
 * | `todo:data-changed`  | 双向 | Rust 文件（`todo_store_get/set`）|
 * | `todo:runtime-state` | 运行时 → UI | 运行时窗口的 30s 轮询结果 |
 * | `todo:derived-state` | UI → 运行时 | UI 窗口解析计划 MD 得到的步骤/验收进度 |
 * | `todo:focus-task`    | overlay → UI | 一次性动作（点击工灵 → 定位卡片），带 pending 兜时序 |
 *
 * 采用「按需拉取」而非「带载荷广播」：data 可能是上千行 JSON，广播只发一个信号，
 * 接收方自己回 Rust 读盘。`todo_store_set` 已在广播前 await 完成，读到的一定是新值。
 *
 * `derived-state` 反向同步的原因：运行时的看门狗要读 `planSteps[taskId].current`
 * 作为「执行到哪一步」的上下文喂给 AI 评估，而该进度是 UI 侧的 PlanDocPanel
 * 解析计划 MD 得到的——不并回来的话，运行时侧这份缓存永远是空的。
 */
import { invoke } from '@tauri-apps/api/core';
import {
  publishWindowMessage,
  queueWindowIntent,
  subscribeWindowMessage,
  takePendingIntents,
} from '@/infrastructure/windows/windowBus';
import { useTodoStore } from '../store/todoStore';
import type { AgentQuestionBatch } from '../store/todoStore';
import {
  TODO_DATA_CHANGED,
  TODO_DERIVED_STATE,
  TODO_FOCUS_TASK,
  TODO_RUNTIME_STATE,
} from './todoSyncEvents';

interface RuntimeStatePayload {
  agentRunning: Record<string, boolean>;
  agentFailed: Record<string, boolean>;
  agentQuestions: Record<string, AgentQuestionBatch[]>;
}

interface DerivedStatePayload {
  planSteps: Record<string, { done: number; total: number; current: string | null }>;
  planAcceptance: Record<string, { done: number; total: number }>;
}

/** 「定位到卡片」意图载荷 */
export interface FocusTaskPayload {
  taskId: string;
}

/**
 * 请求策窗口定位到指定卡片。
 *
 * 供 overlay 侧的工灵（`AgentImp` 点击）调用——它自己不在策窗口里，只能发意图。
 *
 * **时序处理**：策窗口可能已经开着（广播即时生效），也可能刚被拉起（此时还没有
 * 订阅者，广播会丢）。所以先 `queueWindowIntent` 落盘，再广播：
 * - 已开：广播命中 → 立即定位；落盘的 pending 会在 TTL 后自然过期（无害）。
 * - 刚开：广播丢失 → 新窗口启动时 `takePendingIntents` 取到并定位。
 *
 * 两条路都走到时会重复调用 `locateTask`，但它是幂等的（同一个 view + expandedId），
 * 所以不做去重。
 */
export function requestFocusTask(taskId: string): void {
  const payload: FocusTaskPayload = { taskId };
  queueWindowIntent<FocusTaskPayload>(TODO_FOCUS_TASK, payload);
  publishWindowMessage<FocusTaskPayload>(TODO_FOCUS_TASK, payload);
}

/** 从 Rust 重读数据并采纳（不回声广播，避免两窗口互刷） */
async function pullData(): Promise<void> {
  try {
    const raw = await invoke<unknown>('todo_store_get');
    useTodoStore.getState().applyRemoteData(raw);
  } catch (error) {
    console.warn('[todo] cross-window pull failed:', error);
  }
}

/**
 * 启动本窗口的策同步。
 *
 * @param role `runtime` = overlay 里的常驻运行时（agent 运行态 owner）；
 *             `ui` = 独立策窗口（计划进度 owner）。
 * @returns 退订函数
 */
export function initTodoWindowSync(role: 'runtime' | 'ui'): () => void {
  const unsubMessages = subscribeWindowMessage((message) => {
    switch (message.type) {
      case TODO_DATA_CHANGED:
        void pullData();
        return;

      case TODO_RUNTIME_STATE: {
        if (role !== 'ui') return; // 运行时窗口自己是 owner，不回收自己的态
        const payload = message.payload as RuntimeStatePayload | undefined;
        if (!payload) return;
        useTodoStore.getState().applyRemoteRuntimeState({
          agentRunning: payload.agentRunning ?? {},
          agentFailed: payload.agentFailed ?? {},
          agentQuestions: payload.agentQuestions ?? {},
        });
        return;
      }

      case TODO_DERIVED_STATE: {
        if (role !== 'runtime') return; // UI 窗口是 owner
        const payload = message.payload as DerivedStatePayload | undefined;
        if (!payload) return;
        const store = useTodoStore.getState();
        for (const [taskId, v] of Object.entries(payload.planSteps ?? {})) {
          store.setPlanSteps(taskId, v.done, v.total, v.current);
        }
        for (const [taskId, v] of Object.entries(payload.planAcceptance ?? {})) {
          store.setPlanAcceptance(taskId, v.done, v.total);
        }
        return;
      }

      case TODO_FOCUS_TASK: {
        if (role !== 'ui') return; // 定位是 UI 窗口的事，运行时窗口不渲染看板
        const payload = message.payload as FocusTaskPayload | undefined;
        if (!payload?.taskId) return;
        useTodoStore.getState().locateTask(payload.taskId);
        return;
      }

      default:
        return;
    }
  });

  // 兜住时序：若本窗口是被「点击工灵」拉起的，意图在本窗口订阅建立前就已发出，
  // 那条广播已经丢了——从 sessionStorage 里把它取回来。（窗口本就在跑时这里为空，
  // 因为广播已经即时生效。）
  if (role === 'ui') {
    for (const payload of takePendingIntents<FocusTaskPayload>(TODO_FOCUS_TASK)) {
      if (payload?.taskId) useTodoStore.getState().locateTask(payload.taskId);
    }
  }

  // 本窗口状态变化 → 只广播本角色拥有的切片（避免双向覆盖）
  const unsubStore = useTodoStore.subscribe((state, prev) => {
    if (role === 'runtime') {
      if (
        state.agentRunning !== prev.agentRunning ||
        state.agentFailed !== prev.agentFailed ||
        state.agentQuestions !== prev.agentQuestions
      ) {
        publishWindowMessage<RuntimeStatePayload>(TODO_RUNTIME_STATE, {
          agentRunning: state.agentRunning,
          agentFailed: state.agentFailed,
          agentQuestions: state.agentQuestions,
        });
      }
      return;
    }

    if (state.planSteps !== prev.planSteps || state.planAcceptance !== prev.planAcceptance) {
      publishWindowMessage<DerivedStatePayload>(TODO_DERIVED_STATE, {
        planSteps: state.planSteps,
        planAcceptance: state.planAcceptance,
      });
    }
  });

  return () => {
    unsubMessages();
    unsubStore();
  };
}
