/**
 * PlanChatPanel — 策下半区右半：选中卡片的规划讨论对话。
 *
 * 形式多轮、实质单发（RWKV 无多轮状态，历史清洗压缩后作为材料注入）：
 * 两段式——第一段每轮结构化 JSON（questions 选项卡点选即答 / ready 标记），
 * AI 判定就绪后第二段独立单发专出计划契约 → 落计划 MD（todo_plan_set）+
 * 卡片进「计划中」；之后对话不关闭，可继续讨论修改再次触发即覆盖更新。
 * 默认本地 RWKV 单发 + 可切模型（auto=本地优先回退主模型）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { HelpCircle, Send } from 'lucide-react';
import { PromptInput } from '@/component-library';
import ModelSelector from '@/flow_chat/components/ModelSelector';
import { useTodoStore } from '../../store/todoStore';
import { planChatReply, generateBoardPlan, DELEGATION_RE } from '../../ai/consult';
import type { PlanChatTurn } from '../../ai/consult';
import { getDiscussModel, setDiscussModel, MODEL_AUTO } from '../../ai/modelCatalog';
import type { BoardPlan, PlanChatMessage, TodoTask } from '../../api/types';

/** 旧版讨论模型选择存过 'primary'/'fast' 内置引用——新概念下回落自动。 */
function loadDiscussModel(): string {
  const saved = getDiscussModel();
  return saved === 'primary' || saved === 'fast' ? MODEL_AUTO : saved;
}

/** BoardPlan → 计划契约 MD（文件化存档，人与 agent 共享读写）。
 *  四段：目标 / 步骤 / 验收（DoD 可勾选）/ 交付物。 */
function planToMarkdown(task: TodoTask, plan: BoardPlan): string {
  const lines: string[] = [`# ${task.title}`, ''];
  lines.push(`## 目标`, '', plan.goal || plan.summary, '');
  if (plan.tasks.length) {
    lines.push('## 步骤', '');
    plan.tasks.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.title}${t.notes ? ` — ${t.notes}` : ''}`);
    });
    lines.push('');
  }
  if (plan.acceptance.length) {
    lines.push('## 验收', '');
    plan.acceptance.forEach((a) => {
      lines.push(`- [ ] ${a}`);
    });
    lines.push('');
  }
  if (plan.deliverable) lines.push(`## 交付物`, '', plan.deliverable, '');
  lines.push('---', `生成于 ${new Date().toLocaleString('zh-CN')}`);
  return lines.join('\n');
}

/** 问询卡草稿：单选 chip 与内联自定义输入互斥（对齐 ExecQuestionCard 契约）。 */
interface QDraft {
  selected: string | null;
  custom: string;
}

/**
 * PlanQuestionCard — ask-user 式问询卡，覆盖输入框（答完才恢复）。
 * 一次只呈现一问（步进式：答完当前才可下一步，可回退修改）；
 * allowInput 提供内联输入与选项互斥；最后一问答完点「发送回答」，
 * 所有答案合成一条消息走讨论通道。
 */
const PlanQuestionCard: React.FC<{
  questions: PlanChatMessage['questions'];
  onSend: (text: string) => void;
}> = ({ questions, onSend }) => {
  const qs = questions ?? [];
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Record<number, QDraft>>(() =>
    Object.fromEntries(qs.map((_, i) => [i, { selected: null, custom: '' }]))
  );
  const setChip = (i: number, opt: string) =>
    setDrafts((p) => ({ ...p, [i]: { selected: p[i]?.selected === opt ? null : opt, custom: '' } }));
  const setCustom = (i: number, v: string) =>
    setDrafts((p) => ({ ...p, [i]: { selected: null, custom: v } }));

  const answerOf = (i: number) => (drafts[i]?.custom.trim() || drafts[i]?.selected || '').trim();
  const cur = qs[step];
  const curAnswered = qs.length > 0 && answerOf(step).length > 0;
  const isLast = step === qs.length - 1;
  const allAnswered = qs.length > 0 && qs.every((_, i) => answerOf(i).length > 0);

  return (
    <div className="td-planchat__qcard">
      <div className="td-planchat__qcard-head">
        <HelpCircle size={12} />
        <span>AI 想确认 {qs.length} 点</span>
        {qs.length > 1 && (
          <span className="td-planchat__qstep">
            第 {step + 1}/{qs.length} 问
          </span>
        )}
      </div>
      {cur && (
        <div className="td-planchat__q">
          <div className="td-planchat__qlabel">{cur.q}</div>
          <div className="td-planchat__opts">
            {cur.options.map((opt) => (
              <button
                key={opt}
                type="button"
                className={`td-planchat__opt${drafts[step]?.selected === opt ? ' is-active' : ''}`}
                onClick={() => setChip(step, opt)}
              >
                {opt}
              </button>
            ))}
          </div>
          {cur.allowInput && (
            <input
              type="text"
              className="td-planchat__qinput"
              placeholder="以上都不合适？直接输入…"
              value={drafts[step]?.custom ?? ''}
              onChange={(e) => setCustom(step, e.target.value)}
            />
          )}
        </div>
      )}
      <div className="td-planchat__qnav">
        {step > 0 ? (
          <button type="button" className="td-planchat__qback" onClick={() => setStep((s) => s - 1)}>
            上一题
          </button>
        ) : (
          <span />
        )}
        {isLast ? (
          <button
            type="button"
            className="td-planchat__qsubmit"
            disabled={!allAnswered}
            title={allAnswered ? '发送回答' : '还有问题没回答（可点「上一题」回去补）'}
            onClick={() => onSend(qs.map((_, i) => answerOf(i)).join('；'))}
          >
            <Send size={11} /> 发送回答
          </button>
        ) : (
          <button
            type="button"
            className="td-planchat__qsubmit"
            disabled={!curAnswered}
            title={curAnswered ? '下一问' : '先选一个选项或直接输入'}
            onClick={() => setStep((s) => s + 1)}
          >
            下一问
          </button>
        )}
      </div>
    </div>
  );
};

/** 后端通道错误 → 用户可读文案（显存不足给可操作指引，其余原样透出）。 */
function describeAiError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const need = msg.match(/need (\d+) MB/i);
  if (/insufficient VRAM/i.test(msg) && need) {
    const free = msg.match(/free (\d+) MB/i);
    const freeGb = free ? `，当前可用 ${Math.round(Number(free[1]) / 1024)}GB` : '';
    return `显存不足以加载该模型（约需 ${Math.round(Number(need[1]) / 1024)}GB${freeGb}），请先释放显存（关闭占用显存的程序/引擎）或改用 RWKV / 云端模型`;
  }
  return `AI 暂时没有回应：${msg}`;
}

export const PlanChatPanel: React.FC<{
  task: TodoTask;
}> = ({ task }) => {  const updateTask = useTodoStore((s) => s.updateTask);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  /** 当前忙什么：chat=讨论一轮；plan=AI 判定就绪后第二段独立单发出计划 */
  const [phase, setPhase] = useState<'chat' | 'plan'>('chat');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 讨论模型选择（'auto' = 本地 RWKV 优先 + primary 自动回退）；
  // 控件与 task 窗口同一个 ModelSelector（受控模式），选择只持久化到本面板
  const [modelId, setModelId] = useState(loadDiscussModel);

  // 引用稳定：task.chat 缺省时固定空数组，避免每次渲染新引用扰动 useMemo 依赖
  const chat = useMemo(() => task.chat ?? [], [task.chat]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.length, busy]);

  /**
   * 两段式流程：发送一条用户消息 → 第一段讨论单发（澄清/追问或 ready 标记）；
   * ready=true 时第二段独立单发专门产出计划契约 JSON → 写入计划 MD（todo_plan_set）
   * + 卡片进「计划中」。已有草案时作为材料注入——后续讨论按反馈再触发即覆盖更新。
   * 选项点选与自由输入共用此通道。
   */
  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setInput('');
    setError(null);
    setBusy(true);
    setPhase('chat');
    const nextChat = [...chat, { role: 'user' as const, text }];
    updateTask(task.id, { chat: nextChat });
    let turn: PlanChatTurn | null = null;
    try {
      turn = await planChatReply(task.title, task.notes, nextChat, modelId, task.goalId, task.plan ?? null);
    } catch (e) {
      setBusy(false);
      setError(describeAiError(e));
      return;
    }
    if (!turn) {
      setBusy(false);
      setError('AI 暂时没有回应，稍后再试');
      return;
    }
    // 模型调用 create_plan 工具 → 前端作为运行时执行：计划契约已随参数给出
    // 就直接落盘；只有调用哨兵时补一发计划专用单发（30/30 实证的稳定通道）。
    // 计划文件的创建决定权在模型，前端只做工具执行器。
    if (turn.tool === 'create_plan') {
      const aiMsg: PlanChatMessage = {
        role: 'ai',
        text: turn.reply || (turn.plan ? `已调用 create_plan 创建计划：${turn.plan.goal || turn.plan.summary}` : '好的，信息够了，我来创建计划文件。'),
      };
      const fullChat = [...nextChat, aiMsg];
      updateTask(task.id, { chat: fullChat });
      setPhase('plan');
      const plan = turn.plan ?? (await generateBoardPlan(task.title, task.notes, fullChat, modelId, task.goalId, task.plan ?? null));
      setBusy(false);
      if (!plan) {
        setError('计划生成失败，请再发一条消息让我重新拟（或补充点细节）');
        return;
      }
      try {
        await invoke('todo_plan_set', { taskId: task.id, markdown: planToMarkdown(task, plan) });
        updateTask(task.id, { plan, status: 'planning' });
      } catch (e) {
        setError(`计划保存失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    // 回退通道 + 循环终结器：用户已回答过 AI 的追问轮（answeredRound）时，
    // 无论模型是否又输出 questions 都强制进拟策——保证「答完必出计划」，
    // 不会陷入「问完又问」循环（生产实测 2026-08-28）。
    const answeredRound = chat.length > 0 && chat[chat.length - 1].role === 'ai' && !!chat[chat.length - 1].questions?.length;
    const delegationIntent = DELEGATION_RE.test(text) || answeredRound;
    const ready = turn.ready === true || (!turn.questions?.length && delegationIntent) || answeredRound;
    const aiMsg: PlanChatMessage = {
      role: 'ai',
      text: turn.reply,
      ...(turn.questions && !ready ? { questions: turn.questions } : {}),
    };
    const fullChat = [...nextChat, aiMsg];
    updateTask(task.id, { chat: fullChat });
    if (ready) {
      // 第二段：独立单发，专注出计划契约
      setPhase('plan');
      const plan = await generateBoardPlan(task.title, task.notes, fullChat, modelId, task.goalId, task.plan ?? null);
      setBusy(false);
      if (!plan) {
        setError('计划生成失败，请再发一条消息让我重新拟（或补充点细节）');
        return;
      }
      try {
        await invoke('todo_plan_set', { taskId: task.id, markdown: planToMarkdown(task, plan) });
        updateTask(task.id, { plan, status: 'planning' });
      } catch (e) {
        setError(`计划保存失败：${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      setBusy(false);
    }
  };

  /** 最新一条 AI 消息的选项卡才可点选（旧消息仅展示，防误触错位）。 */
  const canAnswer = !busy && chat.length > 0 && chat[chat.length - 1].role === 'ai';
  /** 待答问询（挂在最新 AI 消息上）：存在时覆盖底部输入框。 */
  const pendingQ = useMemo(
    () => (canAnswer && chat.length > 0 ? (chat[chat.length - 1].questions ?? null) : null),
    [canAnswer, chat]
  );

  return (
    <div className="td-planchat">
      <div className="td-planchat__head">
        <span className="td-planchat__title">讨论 · {task.title}</span>
        <span className="td-planchat__hint">
          {task.status === 'planning' ? '可继续讨论修改计划，满意后交付执行' : '需求聊清楚后 AI 会直接拟定计划'}
        </span>
      </div>
      <div className="td-planchat__messages" ref={scrollRef}>
        {chat.length === 0 && (
          <div className="td-planchat__empty">说说你想怎么做这件事，AI 会帮你把需求聊清楚</div>
        )}
        {chat.map((m, i) => (
          <React.Fragment key={i}>
            <div className={`td-planchat__msg is-${m.role}`}>
              <div className="td-planchat__bubble">{m.text}</div>
            </div>
            {/* ask-user 选项只在底部问询卡交互；消息流只保留 AI 的文字回应 */}
          </React.Fragment>
        ))}
        {busy && (
          <div className="td-planchat__msg is-ai">
            <div className="td-planchat__bubble is-typing">
              {phase === 'plan' ? '正在拟定计划…' : '思考中…'}
            </div>
          </div>
        )}
        {error && <div className="td-planchat__error">{error}</div>}
      </div>
      {/* 输入区：有未答问询时由问询卡覆盖输入框（答完即恢复） */}
      <div className="td-planchat__input">
        {pendingQ && pendingQ.length > 0 ? (
          <PlanQuestionCard questions={pendingQ} onSend={(t) => void send(t)} />
        ) : (
          <PromptInput
            value={input}
            onChange={setInput}
            onSubmit={() => void send(input)}
            loading={busy}
            placeholder={task.status === 'planning' ? '对计划提出修改意见，或自由讨论…' : '补充需求、点选上面的选项，或自由回答…'}
            maxHeight={120}
            footerLeft={
              <ModelSelector
                currentMode="plan-discuss"
                controlledValue={modelId}
                onControlledSelect={(ref) => {
                  setModelId(ref);
                  setDiscussModel(ref);
                }}
              />
            }
          />
        )}
      </div>
    </div>
  );
};
