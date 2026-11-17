/**
 * ExecSessionSummary — 策「进行中」卡的下半区（2026-11-08 P1）。
 *
 * 执行对话（历史基线/实时流/干预/停止/审批与提问应答）已整体移交工作台 AI 区，
 * 策窗口不再承载任何 dsh 会话：这里只保留**只读摘要 + 移交入口**。
 *
 * 运行态 / 失败态 / 待应答提问全部来自 overlay 运行时同步（`todoWindowSync`），
 * 本组件不发任何 dsh 请求，也不创建或切换会话——会话本体、cwd、历史都留在
 * 引擎侧（P1 边界：只迁入口，不迁数据）。
 */
import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { WindowAPI } from '@/infrastructure/windows/WindowAPI';
import { publishWindowMessage, queueWindowIntent } from '@/infrastructure/windows/windowBus';
import {
  WORKBENCH_OPEN_SESSION,
  type WorkbenchOpenSessionIntent,
} from '@/infrastructure/plugins/workbenchSession';
import { useTodoStore } from '../../store/todoStore';
import type { TodoTask } from '../../api/types';

export const ExecSessionSummary: React.FC<{
  task: TodoTask;
}> = ({ task }) => {
  const sessionId = task.agentSessionId as string;
  const running = useTodoStore((s) => s.agentRunning[sessionId] ?? false);
  const failed = useTodoStore((s) => s.agentFailed[sessionId] ?? false);
  const questions = useTodoStore((s) => s.agentQuestions[sessionId]?.length ?? 0);
  const steps = useTodoStore((s) => s.planSteps[task.id]);

  // 执行五态（与移交前的判定保持一致：完成必须人类确认）
  const awaitingHuman = Boolean(task.agentCompletedAt) && !task.completedAt;
  const stateText = task.completedAt
    ? '已完成 · 人类验收通过'
    : awaitingHuman
      ? '待人类验收'
      : running
        ? 'agent 执行中'
        : failed
          ? '执行出错 · 待处理'
          : '已结束 · 待继续';
  const stateClass = task.completedAt || awaitingHuman
    ? ' is-await'
    : running
      ? ' is-running'
      : failed
        ? ' is-failed'
        : '';

  const openInWorkbench = (): void => {
    const intent: WorkbenchOpenSessionIntent = { sessionId, title: task.title };
    // 两条时序都覆盖：先落待处理意图（窗口可能还没开，冷启动可能超过默认 10s
    // 的意图存活期，这里显式放宽到 120s），再广播（已开则即时到达）
    queueWindowIntent(WORKBENCH_OPEN_SESSION, intent, 120_000);
    publishWindowMessage(WORKBENCH_OPEN_SESSION, intent);
    void WindowAPI.open('workbench');
  };

  return (
    <div className="td-execchat">
      <div className="td-execchat__head">
        <span
          className={`td-execchat__dot${running ? ' is-running' : ''}${
            failed ? ' is-failed' : ''
          }${awaitingHuman || task.completedAt ? ' is-await' : ''}`}
        />
        <span className="td-execchat__title" title={task.title}>
          执行 · {task.title}
        </span>
        {steps && steps.total > 0 && (
          <span className="td-execchat__state">
            步骤 {steps.done}/{steps.total}
          </span>
        )}
        <span className={`td-execchat__state${stateClass}`}>{stateText}</span>
        {questions > 0 && (
          <span className="td-execchat__state is-await" title="agent 提问待应答">
            待应答 {questions}
          </span>
        )}
      </div>

      <div className="td-execchat__summary">
        <p className="td-execchat__summary-text">
          执行对话已移至工作台：历史、实时输出、干预与审批/提问都在工作台右栏完成，
          会话与工作目录保持不变。
        </p>
        <button type="button" className="td-execchat__open" onClick={openInWorkbench}>
          在工作台继续
          <ArrowUpRight size={13} aria-hidden="true" />
        </button>
        <p className="td-execchat__summary-meta" title={sessionId}>
          会话 {sessionId.replace(/^session-/, '').slice(0, 8)}
        </p>
      </div>
    </div>
  );
};
