/**
 * ExecChatPanel — 策下半区左列（进行中卡）：执行过程对话（内嵌，非浮层）。
 *
 * 进行中卡片的「讨论」= agent 会话本体：历史基线（dshSession.history）+
 * 实时流（connectMux 过滤本会话）统一进事件数组后 foldEvents 折叠展示；
 * 可发消息干预（dshSession.prompt）/ 停止（cancel）；审批/提问卡内嵌应答；
 * 底部 ModelSelector 直选会话模型（会话级状态——按卡隔离，并行任务可
 * 各用各的模型；委托时已用卡片讨论模型初始化，此处可随时改）。
 * 数据逻辑与 SessionChatPanel（剧场浮层）同构；组件按卡片 key 重挂载。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PromptInput } from '@/component-library';
import ModelSelector from '@/shared/components/ModelSelector';
import {
  aggregateUsage,
  connectMux,
  dshApproval,
  dshQuestion,
  dshSession,
  foldEvents,
  type DshApproval,
  type DshMessage,
  type DshMuxFrame,
  type DshQuestion,
  type DshQuestionAnswerItem,
  type DshSessionEvent,
} from '@/infrastructure/api/service-api/DshAPI';
import { ApprovalCard, MessageBubble, QuestionCard } from '@/app/scenes/dsh/DshChatPieces';
import { getDiscussModel, MODEL_AUTO } from '../../ai/modelCatalog';
import { WATCH_STALL_SOFT_MS, recoverSession } from '../../utils/watchdog';
import { useTodoStore } from '../../store/todoStore';
import type { TodoTask } from '../../api/types';
// 消息/输入区样式类来自策场景（__msg* / __composer），必须引入该样式表
import '@/app/scenes/dsh/DshScene.scss';

export const ExecChatPanel: React.FC<{
  task: TodoTask;
}> = ({ task }) => {
  const sessionId = task.agentSessionId as string;
  const failed = useTodoStore((s) => s.agentFailed[sessionId] ?? false);
  const [messages, setMessages] = useState<DshMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [approvals, setApprovals] = useState<DshApproval[]>([]);
  const [questions, setQuestions] = useState<DshQuestion[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** 基线 + 实时事件统一数组（foldEvents 的输入） */
  const eventsRef = useRef<DshSessionEvent[]>([]);
  // 卡死观察：最近事件时间 + 30s 重渲染（驱动「无响应 X 分钟」提示）
  const lastEventRef = useRef(Date.now());
  const [, setRenderTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setRenderTick(v => v + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  // 模型选择与计划讨论同源（同一控件、同一卡片字段 discussModel）：
  // 切换时写卡 + 同步到运行中的会话——讨论/执行/下次委托永远同一个模型
  const updateTask = useTodoStore((s) => s.updateTask);
  const discussModel = task.discussModel ?? getDiscussModel();
  // 会话累计 token 用量（与 DshScene 同源；eventsRef 每次渲染重算，量级可忽略）
  const usage = aggregateUsage(eventsRef.current);
  const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  const refreshRunning = useCallback(async (): Promise<void> => {
    try {
      const { items } = await dshSession.list();
      const self = items.find((it) => it.sessionId === sessionId);
      setAgentRunning(Boolean(self?.running));
    } catch {
      // 列表拉不到 → 保持现状
    }
  }, [sessionId]);

  const reloadBaseline = useCallback(async (): Promise<void> => {
    try {
      const { events } = await dshSession.history(sessionId);
      eventsRef.current = events.map(e => e.event);
      setMessages(foldEvents(eventsRef.current));
      lastEventRef.current = Date.now();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  // 打开时拉历史基线 + 运行态
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    eventsRef.current = [];
    void (async () => {
      await reloadBaseline();
      await refreshRunning();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadBaseline, refreshRunning]);

  // 实时流（面板存在期间订阅）
  useEffect(() => {
    if (!sessionId) return undefined;
    const conn = connectMux((frame: DshMuxFrame, frameRpcId: string) => {
      lastEventRef.current = Date.now();
      // 审批/提问（mux 重连会重放 pending 帧 → 按 rpcId 去重）
      if (frame.type === 'approval/requested' && frame.sessionId === sessionId) {
        setApprovals(prev =>
          prev.some(a => a.rpcId === frameRpcId)
            ? prev
            : [...prev, {
                rpcId: frameRpcId,
                sessionId,
                approvalId: frame.approvalId,
                toolName: frame.toolName,
                callId: frame.callId,
                reason: frame.reason,
              }],
        );
        return;
      }
      if (frame.type === 'approval/resolved' && frame.sessionId === sessionId) {
        setApprovals(prev => prev.filter(a => a.approvalId !== frame.approvalId));
        return;
      }
      if (frame.type === 'question/requested' && frame.sessionId === sessionId) {
        setQuestions(prev =>
          prev.some(q => q.rpcId === frameRpcId)
            ? prev
            : [...prev, { rpcId: frameRpcId, sessionId, questions: frame.questions }],
        );
        return;
      }
      if (frame.type === 'question/resolved' && frame.sessionId === sessionId) {
        setQuestions(prev => prev.filter(q => q.rpcId !== frame.questionRpcId));
        return;
      }
      if (frame.type !== 'session/event' || frame.sessionId !== sessionId) return;
      if (frame.event.type === 'turn/end') {
        // turn 结束后以引擎基线为权威重拉（含 usage 与完整折叠），并刷新运行态
        void reloadBaseline();
        void refreshRunning();
        return;
      }
      eventsRef.current = [...eventsRef.current, frame.event];
      setMessages(foldEvents(eventsRef.current));
    });
    return () => conn.close();
  }, [sessionId, reloadBaseline, refreshRunning]);

  // 自动滚底
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSend = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await dshSession.prompt(sessionId, text);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleStop = async (): Promise<void> => {
    try {
      await dshSession.cancel(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 手动中断卡住的轮次 + 从计划断点继续（应用内确认，非原生弹窗）。 */
  const handleInterruptContinue = async (): Promise<void> => {
    if (!(await window.confirm('中断当前轮次并让 agent 从计划断点继续？未完成的工具调用会重新执行。'))) return;
    lastEventRef.current = Date.now();
    await recoverSession(sessionId);
  };

  /** 继续执行（会话已停、未提交自检——发标准续跑指令，无需 cancel）。 */
  const handleResume = async (): Promise<void> => {
    setResuming(true);
    try {
      await dshSession.prompt(
        sessionId,
        '【继续】从计划断点继续执行（先用 ai00_plan_read 重读计划文档）；刚才未完成的工具调用请重新执行。',
      );
      lastEventRef.current = Date.now();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResuming(false);
    }
  };

  const respondApproval = async (rpcId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> => {
    const a = approvals.find(x => x.rpcId === rpcId);
    if (!a) return;
    const receipt = await dshApproval.respond(rpcId, sessionId, a.approvalId, outcome);
    if (receipt.accepted) setApprovals(prev => prev.filter(x => x.rpcId !== rpcId));
  };

  const respondQuestion = async (rpcId: string, answers: DshQuestionAnswerItem[]): Promise<void> => {
    const receipt = await dshQuestion.respond(rpcId, sessionId, answers);
    if (receipt.accepted) setQuestions(prev => prev.filter(q => q.rpcId !== rpcId));
  };

  const cancelQuestion = (rpcId: string): void => {
    void dshQuestion.cancel(rpcId);
    setQuestions(prev => prev.filter(q => q.rpcId !== rpcId));
  };

  /** 执行中切模型：写卡片字段（讨论/下次委托同源）+ 同步到运行中的会话。 */
  const handleSelectModel = (ref: string): void => {
    updateTask(task.id, { discussModel: ref });
    dshSession
      .selectModel(sessionId, 'ai00-x', ref === MODEL_AUTO ? 'ai00-auto' : ref)
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  };

  // 执行五态（双段验收：模型自检提交后进入「待人类验收」，完成必须人类确认）
  const awaitingHuman = Boolean(task.agentCompletedAt) && !task.completedAt;
  const stateText = task.completedAt
    ? '已完成 · 人类验收通过'
    : awaitingHuman
      ? '待人类验收'
      : agentRunning
        ? 'agent 执行中'
        : failed
          ? '执行出错 · 待处理'
          : messages.length === 0 && !loading
            ? '等待中'
            : '已结束 · 未提交自检';
  const stateClass = task.completedAt
    ? ' is-await'
    : awaitingHuman
      ? ' is-await'
      : agentRunning
        ? ' is-running'
        : failed
          ? ' is-failed'
          : '';
  const steps = useTodoStore((s) => s.planSteps[task.id]);

  return (
    <div className="td-execchat">
      <div className="td-execchat__head">
        <span className={`td-execchat__dot${agentRunning ? ' is-running' : ''}${failed ? ' is-failed' : ''}${awaitingHuman ? ' is-await' : ''}`} />
        <span className="td-execchat__title" title={task.title}>执行 · {task.title}</span>
        {steps && steps.total > 0 && (
          <span
            className="td-execchat__state"
            title={steps.current ? `当前：${steps.current}` : '全部步骤已勾选'}
          >
            步骤 {steps.done}/{steps.total}{agentRunning && steps.current ? ` · ${steps.current}` : ''}
          </span>
        )}
        <span className={`td-execchat__state${stateClass}`}>
          {stateText}
        </span>
        {usage && (
          <span className="td-execchat__state" title="会话累计 token 用量">
            ↑{fmtK(usage.inputTokens)} ↓{fmtK(usage.outputTokens)} · {usage.requests}
          </span>
        )}
        {/* 会话已停、未提交自检 → 一键续跑（重启断联/执行中断的恢复入口） */}
        {!agentRunning && !awaitingHuman && !task.completedAt && task.agentSessionId && (
          <button className="td-chip" onClick={() => void handleResume()} disabled={resuming} title="发标准续跑指令：重读计划、从断点继续">
            {resuming ? '发送中…' : '继续执行'}
          </button>
        )}
        {/* 卡死观察（软阈值）：等人工场景豁免，只提示 + 手动开关，不自动杀 */}
        {agentRunning &&
          !awaitingHuman &&
          questions.length === 0 &&
          approvals.length === 0 &&
          Date.now() - lastEventRef.current > WATCH_STALL_SOFT_MS && (
            <>
              <span
                className="td-execchat__state is-await"
                title="长时间无事件——正常长任务请再等等；确认卡死可点「中断并继续」"
              >
                ⚠ 无响应 {Math.round((Date.now() - lastEventRef.current) / 60_000)} 分钟
              </span>
              <button className="td-chip" onClick={() => void handleInterruptContinue()}>
                中断并继续
              </button>
            </>
          )}
      </div>
      <div className="td-execchat__chat" onMouseDown={e => e.stopPropagation()}>
        <div className="ai00-x-dsh-scene__messages" ref={bodyRef}>
          {loading && <div className="ai00-x-dsh-scene__messages-empty">读取中…</div>}
          {!loading && messages.length === 0 && !error && (
            <div className="ai00-x-dsh-scene__messages-empty">等待 agent 开始执行…（计划文档见右侧）</div>
          )}
          {messages.map(m => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {error && <div className="ai00-x-dsh-scene__error">{error}</div>}
        </div>

        {approvals.length > 0 && (
          <div className="ai00-x-dsh-scene__approvals">
            {approvals.map(a => (
              <ApprovalCard
                key={a.rpcId}
                approval={a}
                onRespond={(rpcId, outcome) => void respondApproval(rpcId, outcome)}
              />
            ))}
          </div>
        )}
        {questions.length > 0 && (
          <div className="ai00-x-dsh-scene__approvals">
            {questions.map(q => (
              <QuestionCard key={q.rpcId} batch={q} onRespond={respondQuestion} onCancel={cancelQuestion} />
            ))}
          </div>
        )}

        {/* 标准对话输入框（与计划讨论同款 PromptInput + ModelSelector，模型按卡存储） */}
        <div className="ai00-x-dsh-scene__composer">
          <PromptInput
            value={draft}
            onChange={setDraft}
            onSubmit={() => void handleSend()}
            onStop={() => void handleStop()}
            loading={sending}
            placeholder="执行中交流：需求/方案有变时 agent 会先改计划再继续（以计划文档为准）…"
            footerLeft={
              <ModelSelector
                currentMode="plan-discuss"
                controlledValue={discussModel}
                onControlledSelect={handleSelectModel}
              />
            }
          />
        </div>
      </div>
    </div>
  );
};
