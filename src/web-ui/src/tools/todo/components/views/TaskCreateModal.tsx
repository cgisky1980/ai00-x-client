/**
 * TaskCreateModal — 想法卡创建弹窗（唯一创建入口，看板「想法池」栏头＋）。
 *
 * 创建：标题 + 说明 + agent 参与方式（人做/Auto/模块）。
 * 想法池无截止压力（2026-08-27 定稿）：不设截止/提醒——想法先收集，
 * 进入计划时再由人定节奏；截止/提醒仍属恒（周期）等日程类场景。
 */
import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTodoStore } from '../../store/todoStore';
import AgentModePicker, { type AgentModeValue } from '../AgentModePicker';

export const TaskCreateModal: React.FC<{
  close: () => void;
  /** 预挂志（志详情「加任务」入口传入：创建即关联该志） */
  defaultGoalId?: string;
  /** 预挂志标题（弹窗头部提示用） */
  goalTitle?: string;
}> = ({ close, defaultGoalId, goalTitle }) => {
  const addTask = useTodoStore((s) => s.addTask);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [agent, setAgent] = useState<AgentModeValue>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    addTask(t.slice(0, 120), {
      notes: notes.trim().slice(0, 2000),
      agentModule: agent || undefined,
      goalId: defaultGoalId ?? null,
    });
    close();
  };

  return (
    <div className="td-consult" onClick={e => e.target === e.currentTarget && close()}>
      <div className="td-consult-card td-create-card">
        <div className="td-consult-head">
          {defaultGoalId ? `为志加行${goalTitle ? ` · ${goalTitle.slice(0, 10)}` : ''}` : '新建想法'}
          <span style={{ flex: 1 }} />
          <button className="todo-panel__close" style={{ width: 24, height: 24 }} onClick={close} title="关闭">
            <X size={14} />
          </button>
        </div>
        <div className="td-consult-body td-create-body">
          <input
            className="td-create-title"
            placeholder="想做什么？一句话说清想法"
            value={title}
            autoFocus
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && title.trim()) submit();
            }}
          />
          <textarea
            className="td-create-notes"
            placeholder="补充说明（背景、期望、约束…可留空）"
            value={notes}
            rows={3}
            onChange={e => setNotes(e.target.value)}
          />
          <AgentModePicker value={agent} onChange={setAgent} />
        </div>
        <div className="td-consult-foot">
          <button className="td-chip" onClick={close}>取消</button>
          <button className="td-chip is-on" onClick={submit} disabled={!title.trim()}>立入看板</button>
        </div>
      </div>
    </div>
  );
};
