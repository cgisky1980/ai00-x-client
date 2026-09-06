/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * ExecutionPanel — 进行中卡片的执行视图（结果导向：进度+产出+验收）。
 *
 * 设计哲学落地：执行过程不常驻策主界面——「打开对话·干预」一步唤起传统
 * 对话窗口（dsh 会话，可发消息/回答提问/纠偏）；策内只看验收进度、
 * 计划文档（人机共享的实时产出落点）、可勾选的 DoD checklist。
 * 完成判定 = DoD 全勾（total=0 免验收）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Check, ChevronDown, ChevronRight, HelpCircle, MessageSquareText, RotateCcw, Send, Wrench, X } from 'lucide-react';
import { Markdown } from '@/component-library';
import {
  dshQuestion,
  dshSession,
  foldEvents,
  type DshMessage,
  type DshQuestionAnswerItem,
} from '@/infrastructure/api/service-api/DshAPI';
import type { TodoTask } from '../../api/types';
import { useTodoStore, type AgentQuestionBatch } from '../../store/todoStore';
import { useGrowthStore } from '../../store/growthStore';
import { parseAcceptance, toggleAcceptanceLine } from '../../utils/planAcceptance';
import { useTheaterStore } from '@/app/components/AgentTheater/theaterStore';

export const ExecutionPanel: React.FC<{
  task: TodoTask;
}> = ({ task }) => {
  const [md, setMd] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  // 执行过程抽屉（默认收起——过程不常驻，可查不弱视）
  const [histOpen, setHistOpen] = useState(false);
  const [histMsgs, setHistMsgs] = useState<DshMessage[] | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const agentRunning = useTodoStore((s) => s.agentRunning[task.agentSessionId ?? ''] ?? false);
  /** 最后一轮执行是否出错（agent 停止后从历史尾判定；驱动状态文案） */
  const [lastFailed, setLastFailed] = useState(false);
  const questionBatches =
    useTodoStore((s) => (task.agentSessionId ? s.agentQuestions[task.agentSessionId] : undefined)) ?? [];
  const setPlanAcceptance = useTodoStore((s) => s.setPlanAcceptance);
  const updateTask = useTodoStore((s) => s.updateTask);
  const completeTask = useTodoStore((s) => s.completeTask);
  const showToast = useGrowthStore((s) => s.showToast);
  const checkBadges = useGrowthStore((s) => s.checkBadges);
  const busyRef = useRef(false);

  const reload = useCallback(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    invoke<string | null>('todo_plan_get', { taskId: task.id })
      .then(content => {
        if (cancelled) return;
        setMd(content);
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  // 选中变化 / agent 写入广播 → 重读（解析结果顺带回填徽标缓存）
  useEffect(() => {
    return reload();
  }, [task.id, task.plan, reload]);

  useEffect(() => {
    const un = listen<{ taskId: string }>('todo-plan-updated', e => {
      if (e.payload?.taskId === task.id) reload();
    });
    return () => {
      void un.then(f => f());
    };
  }, [task.id, reload]);

  const acceptance = useMemo(() => parseAcceptance(md), [md]);
  const done = acceptance.filter(a => a.done).length;
  const total = acceptance.length;

  // 解析结果回填看板徽标缓存（唯一真源=MD）
  useEffect(() => {
    setPlanAcceptance(task.id, done, total);
  }, [task.id, done, total, setPlanAcceptance]);

  /** 勾/取消一项验收：改 MD 行 → 落盘（触发广播，各处热刷新）。 */
  const toggle = async (lineIndex: number, next: boolean) => {
    if (md == null || busyRef.current) return;
    busyRef.current = true;
    try {
      const nextMd = toggleAcceptanceLine(md, lineIndex, next);
      await invoke('todo_plan_set', { taskId: task.id, markdown: nextMd });
      setMd(nextMd);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
    }
  };

  /** webui 内会话对话浮层干预执行（可多开；不再开老 taskWindow）。 */
  const openChatPanel = useTheaterStore((st) => st.openChatPanel);
  const openConversation = () => {
    if (!task.agentSessionId) return;
    openChatPanel(task.agentSessionId, task.title);
  };

  /** 执行过程抽屉开关：每次展开拉最新 history（只读折叠渲染）。 */
  const toggleHistory = async () => {
    const next = !histOpen;
    setHistOpen(next);
    if (!next || !task.agentSessionId) return;
    setHistLoading(true);
    try {
      const { events } = await dshSession.history(task.agentSessionId);
      setHistMsgs(foldEvents(events.map(e => e.event)));
    } catch {
      setHistMsgs([]);
    } finally {
      setHistLoading(false);
    }
  };

  const markComplete = async () => {
    setCompleting(true);
    try {
      completeTask(task.id, true);
      void checkBadges();
      showToast('验收通过', `「${task.title.slice(0, 16)}」已成`);
    } finally {
      setCompleting(false);
    }
  };

  const allPassed = total === 0 || done === total;

  // 执行四态：执行中 / 已结束·待验收 / 执行出错（最后有 error 信号）/ 等待中
  const hasSession = !!task.agentSessionId;
  const stateText = agentRunning
    ? 'agent 执行中'
    : hasSession && !task.completedAt
      ? lastFailed
        ? '执行出错 · 待处理'
        : '已结束 · 待验收'
      : '等待中';

  // agent 停止后拉一次历史尾判定成败（turn 结束信号：finish reason=error / 工具错误）
  useEffect(() => {
    if (agentRunning || !task.agentSessionId || task.completedAt) {
      setLastFailed(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { events } = await dshSession.history(task.agentSessionId as string);
        if (cancelled) return;
        const msgs = foldEvents(events.map(e => e.event));
        // 只看最后一轮（最后一条用户消息之后）：assistant 带 error 或工具结果错误
        const lastUserIdx = msgs.map(m => m.role).lastIndexOf('user');
        const tail = msgs.slice(lastUserIdx + 1);
        const failed = tail.some(
          m => Boolean(m.error) || m.toolCalls.some(tc => tc.isError),
        );
        setLastFailed(failed);
      } catch {
        // 历史拉不到 → 不标失败
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentRunning, task.agentSessionId, task.completedAt]);

  return (
    <div className="td-exec">
      <div className="td-exec__head">
        <span className="td-exec__title">执行 · {task.title}</span>
        <span
          className={`td-exec__state${agentRunning ? ' is-running' : ''}${lastFailed ? ' is-failed' : ''}${!agentRunning && hasSession && !task.completedAt ? ' is-ended' : ''}`}
        >
          {stateText}
        </span>
        <span style={{ flex: 1 }} />
        {task.agentSessionId && (
          <button
            className="td-chip"
            onClick={openConversation}
            title="在 webui 内打开本会话对话：发消息、纠正方向"
          >
            <MessageSquareText size={11} /> 打开对话 · 干预
          </button>
        )}

        <button
          className="td-chip"
          onClick={() => updateTask(task.id, { status: 'planning' })}
          title="回流「计划中」：继续讨论并重新生成计划（契约重签）"
        >
          <RotateCcw size={11} /> 重新规划
        </button>
        <button
          className="td-chip is-on"
          onClick={markComplete}
          disabled={!allPassed || completing}
          title={allPassed ? '验收通过，标记完成' : `还有 ${total - done} 项验收未通过`}
        >
          <Check size={11} /> 标记完成{total > 0 ? ` ${done}/${total}` : ''}
        </button>
      </div>

      {/* agent 提问（ask_user_question 内嵌应答——人在计划边界一步介入） */}
      {questionBatches.map(b =>
        task.agentSessionId ? (
          <ExecQuestionCard key={b.rpcId} batch={b} sessionId={task.agentSessionId} />
        ) : null
      )}

      {/* 验收进度条（DoD 契约的目标态） */}
      {total > 0 && (
        <div className="td-exec__progress">
          <div className="td-exec__track">
            <span className="td-exec__fill" style={{ width: `${Math.round((done / total) * 100)}%` }} />
          </div>
          <span className="td-exec__progress-num">{done}/{total}</span>
        </div>
      )}

      <div className="td-exec__body">
        {/* 验收 checklist（可勾选——人与 agent 对等操作同一文件） */}
        {total > 0 && (
          <div className="td-exec__acceptance">
            {acceptance.map(a => (
              <button
                key={a.lineIndex}
                className={`td-exec__check${a.done ? ' is-done' : ''}`}
                onClick={() => void toggle(a.lineIndex, !a.done)}
                title={a.done ? '点击取消勾选' : '点击确认通过'}
              >
                <span className="td-exec__checkbox">{a.done ? '✓' : ''}</span>
                <span className="td-exec__check-text">{a.text}</span>
              </button>
            ))}
          </div>
        )}

        {/* 计划文档（实时产出落点，Markdown 渲染） */}
        <div className="td-exec__doc">
          {loading && <div className="td-exec__empty">读取中…</div>}
          {!loading && error && <div className="td-exec__empty">{error}</div>}
          {!loading && !error && md === null && (
            <div className="td-exec__empty">
              <Send size={14} /> 已交付——计划文档将由 agent 实时回写，此处可见进度与产出
            </div>
          )}
          {!loading && !error && md !== null && (
            <div className="td-exec__doc-view">
              <Markdown content={md} />
            </div>
          )}
        </div>
      </div>

      {/* 执行过程抽屉（默认收起——过程不常驻，可查不弱视；只读） */}
      {task.agentSessionId && (
        <div className={`td-exec__hist${histOpen ? ' is-open' : ''}`}>
          <button className="td-exec__hist-toggle" onClick={() => void toggleHistory()}>
            {histOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            执行过程（只读 · {histOpen ? '收起' : '展开'}）
          </button>
          {histOpen && (
            <div className="td-exec__hist-body">
              {histLoading && <div className="td-exec__empty">读取中…</div>}
              {!histLoading && (!histMsgs || histMsgs.length === 0) && (
                <div className="td-exec__empty">暂无执行记录</div>
              )}
              {!histLoading &&
                histMsgs?.map(m => (
                  <div key={m.id} className={`td-exec__hist-msg is-${m.role}`}>
                    {m.text && <div className="td-exec__hist-text">{m.text.slice(0, 300)}</div>}
                    {m.toolCalls.map(tc => (
                      <div key={tc.id} className="td-exec__hist-tool">
                        <Wrench size={10} /> {tc.name}
                      </div>
                    ))}
                    {m.error && <div className="td-exec__hist-err">{m.error}</div>}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ===== 内嵌问题卡（agent ask_user_question → 策内一步作答，与主窗 DshScene 同契约）=====
const ExecQuestionCard: React.FC<{
  batch: AgentQuestionBatch;
  sessionId: string;
}> = ({ batch, sessionId }) => {
  /** 每个问题的草稿作答（selected 与 custom 互斥——引擎严格校验）。 */
  const [drafts, setDrafts] = useState<Record<string, { selected: string[]; custom: string }>>(() =>
    Object.fromEntries(batch.questions.map(q => [q.id, { selected: [] as string[], custom: '' }]))
  );
  const [busy, setBusy] = useState(false);
  const removeAgentQuestion = useTodoStore((s) => s.removeAgentQuestion);

  const canSubmit = batch.questions.every(q => {
    const d = drafts[q.id];
    return !!d && (d.selected.length > 0 || d.custom.trim().length > 0);
  });

  const toggleOption = (qid: string, label: string, multi: boolean) => {
    setDrafts(prev => {
      const d = prev[qid] ?? { selected: [], custom: '' };
      if (multi) {
        const selected = d.selected.includes(label)
          ? d.selected.filter(l => l !== label)
          : [...d.selected, label];
        return { ...prev, [qid]: { selected, custom: '' } };
      }
      return { ...prev, [qid]: { selected: [label], custom: '' } };
    });
  };

  const setCustom = (qid: string, custom: string) => {
    setDrafts(prev => {
      const d = prev[qid] ?? { selected: [], custom: '' };
      return { ...prev, [qid]: { selected: custom ? [] : d.selected, custom } };
    });
  };

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      const answers: DshQuestionAnswerItem[] = batch.questions.map(q => {
        const d = drafts[q.id];
        const custom = d.custom.trim();
        return {
          id: q.id,
          selected: custom ? [] : d.selected,
          ...(custom ? { custom } : {}),
        };
      });
      await dshQuestion.respond(batch.rpcId, sessionId, answers);
      removeAgentQuestion(sessionId, batch.rpcId); // 乐观移除（resolved 帧兜底）
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await dshQuestion.cancel(batch.rpcId);
      removeAgentQuestion(sessionId, batch.rpcId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="td-exec__question">
      <div className="td-exec__q-head">
        <HelpCircle size={12} />
        <span className="td-exec__q-label">agent 提问 · 待作答</span>
        <span style={{ flex: 1 }} />
        <button
          className="td-exec__q-cancel"
          onClick={() => void cancel()}
          disabled={busy}
          title="取消提问（agent 收到取消错误）"
        >
          <X size={11} />
        </button>
      </div>
      {batch.questions.map(q => {
        const d = drafts[q.id] ?? { selected: [], custom: '' };
        const multi = q.multiSelect === true;
        return (
          <div key={q.id} className="td-exec__q-item">
            <div className="td-exec__q-text">{q.question}</div>
            {q.detail && <div className="td-exec__q-detail">{q.detail}</div>}
            {!!q.options?.length && (
              <div className={`td-exec__q-options${multi ? ' is-multi' : ''}`}>
                {q.options.map(opt => (
                  <button
                    key={opt.label}
                    type="button"
                    className={`td-exec__q-option${d.selected.includes(opt.label) ? ' is-active' : ''}`}
                    onClick={() => toggleOption(q.id, opt.label, multi)}
                    title={opt.description}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
            <input
              type="text"
              className="td-exec__q-custom"
              placeholder="自定义回答（与选项互斥）…"
              value={d.custom}
              onChange={e => setCustom(q.id, e.target.value)}
              disabled={busy}
            />
          </div>
        );
      })}
      <div className="td-exec__q-actions">
        <button
          className="td-chip is-on"
          onClick={() => void submit()}
          disabled={!canSubmit || busy}
          title={canSubmit ? '提交作答' : '每项都需作答（选项或自定义）'}
        >
          <Send size={11} /> {busy ? '提交中…' : '提交作答'}
        </button>
      </div>
    </div>
  );
};
