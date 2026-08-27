/**
 * PlanChatPanel — 策下半区右半：选中卡片的规划讨论对话。
 *
 * 标准对话输入框（design-system PromptInput + ModelSelector）：多轮需求
 * 讨论（默认本地 RWKV 单发 + 历史拼接，可切模型）；「生成计划」产出
 * BoardPlan → 转成计划 MD 落文件（todo_plan_set）+ 卡片进「计划中」。
 */
import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sparkles } from 'lucide-react';
import { ModelSelector, PromptInput } from '@/component-library';
import type { ModelGroup } from '@/component-library';
import { useTodoStore } from '../../store/todoStore';
import { planChatReply, generateBoardPlan } from '../../ai/consult';
import {
  fetchDiscussModelGroups,
  getDiscussModel,
  setDiscussModel,
} from '../../ai/modelCatalog';
import type { BoardPlan, TodoTask } from '../../api/types';

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

export const PlanChatPanel: React.FC<{
  task: TodoTask;
}> = ({ task }) => {
  const updateTask = useTodoStore((s) => s.updateTask);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 模型目录 + 当前选择（'auto' = 本地 RWKV 优先 + primary 自动回退）
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [modelId, setModelId] = useState(getDiscussModel());

  const chat = task.chat ?? [];

  useEffect(() => {
    let cancelled = false;
    void fetchDiscussModelGroups().then(groups => {
      if (!cancelled) setModelGroups(groups);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.length, busy]);

  /** 讨论一轮：用户消息入史 → AI 回复入史（自动落「计划中」之前保持需求卡）。 */
  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setError(null);
    const nextChat = [...chat, { role: 'user' as const, text }];
    updateTask(task.id, { chat: nextChat });
    setBusy(true);
    const reply = await planChatReply(task.title, task.notes, nextChat, modelId, task.goalId);
    setBusy(false);
    if (reply) {
      updateTask(task.id, { chat: [...nextChat, { role: 'ai', text: reply }] });
    } else {
      setError('AI 暂时没有回应，稍后再试');
    }
  };

  /** 生成计划：BoardPlan → MD 文件 + 卡片进「计划中」。 */
  const genPlan = async () => {
    if (busy || chat.length === 0) return;
    setBusy(true);
    setError(null);
    const plan = await generateBoardPlan(task.title, task.notes, chat, modelId, task.goalId);
    setBusy(false);
    if (!plan) {
      setError('计划生成失败，请多补充一些需求细节再试');
      return;
    }
    const md = planToMarkdown(task, plan);
    try {
      await invoke('todo_plan_set', { taskId: task.id, markdown: md });
    } catch (e) {
      setError(`计划保存失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    updateTask(task.id, { plan, status: 'planning' });
  };

  return (
    <div className="td-planchat">
      <div className="td-planchat__head">
        <span className="td-planchat__title">讨论 · {task.title}</span>
        <button
          className="td-chip"
          onClick={genPlan}
          disabled={busy || chat.length === 0}
          title={chat.length === 0 ? '先和 AI 聊几句需求' : '根据讨论生成计划文档'}
        >
          <Sparkles size={11} /> 生成计划
        </button>
      </div>
      <div className="td-planchat__messages" ref={scrollRef}>
        {chat.length === 0 && (
          <div className="td-planchat__empty">说说你想怎么做这件事，AI 会帮你把需求聊清楚</div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`td-planchat__msg is-${m.role}`}>
            <div className="td-planchat__bubble">{m.text}</div>
          </div>
        ))}
        {busy && <div className="td-planchat__msg is-ai"><div className="td-planchat__bubble is-typing">思考中…</div></div>}
        {error && <div className="td-planchat__error">{error}</div>}
      </div>
      {/* 标准对话输入框（可切模型：auto=本地优先回退主模型） */}
      <div className="td-planchat__input">
        <PromptInput
          value={input}
          onChange={setInput}
          onSubmit={send}
          loading={busy}
          placeholder="补充需求、回答 AI 的追问…"
          maxHeight={120}
          footerLeft={
            <ModelSelector
              groups={modelGroups}
              currentId={modelId}
              onSelect={(_gid, mid) => {
                setModelId(mid);
                setDiscussModel(mid);
              }}
              loading={modelGroups.length === 0}
            />
          }
        />
      </div>
    </div>
  );
};
