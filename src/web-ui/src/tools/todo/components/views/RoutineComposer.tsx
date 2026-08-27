/**
 * RoutineComposer — 恒·周期任务创建弹窗（v3 弹窗版）。
 *
 * 人做：普通周期任务（提醒时刻到点通知）；
 * AI 做：定时 agent 任务（触发时刻自动创建/唤醒 dsh 会话执行指令，
 * agent 完成后调 ai00_task_complete 周期克隆下一轮——闭环见 useReminderTicker）。
 */
import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTodoStore, todayStr } from '../../store/todoStore';
import type { RepeatType } from '../../api/types';
import AgentModePicker, { type AgentModeValue } from '../AgentModePicker';

export const RoutineComposer: React.FC<{
  close: () => void;
}> = ({ close }) => {
  const addTask = useTodoStore((s) => s.addTask);

  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [rule, setRule] = useState<RepeatType>('daily');
  const [firstDue, setFirstDue] = useState(todayStr());
  const [time, setTime] = useState('09:00');
  const [agent, setAgent] = useState<AgentModeValue>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const commit = () => {
    const name = title.trim();
    if (!name || !firstDue) return;
    addTask(name.slice(0, 120), {
      notes: notes.trim().slice(0, 2000),
      repeat: { type: rule, afterCompletion: false },
      due: firstDue,
      // 触发时刻：人做=提醒通知；AI 做=定时执行
      remindAt: time ? `${firstDue}T${time}` : null,
      agentModule: agent,
      agentPrompt: agent ? name : undefined,
    });
    close();
  };

  return (
    <div className="td-consult" onClick={e => e.target === e.currentTarget && close()}>
      <div className="td-consult-card td-create-card">
        <div className="td-consult-head">
          新立恒常
          <span style={{ flex: 1 }} />
          <button className="todo-panel__close" style={{ width: 24, height: 24 }} onClick={close} title="关闭">
            <X size={14} />
          </button>
        </div>
        <div className="td-consult-body td-create-body">
          <input
            className="td-create-title"
            placeholder={agent ? '周期指令，如「每天 8 点生成晨曦壁纸并应用」' : '周期之事，如「每天晨读 20 分钟」'}
            value={title}
            autoFocus
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && title.trim() && firstDue) commit();
            }}
          />
          <textarea
            className="td-create-notes"
            placeholder="补充说明（AI 任务这里写给 agent 的执行要点…可留空）"
            value={notes}
            rows={2}
            onChange={e => setNotes(e.target.value)}
          />
          <AgentModePicker value={agent} onChange={setAgent} excludeStudio />
          <div className="td-chips">
            <span className="td-label">规则</span>
            <select className="td-select" value={rule} onChange={e => setRule(e.target.value as RepeatType)}>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="weekdays">工作日</option>
            </select>
            <span className="td-label">首次</span>
            <input type="date" className="td-date-input" value={firstDue} onChange={e => setFirstDue(e.target.value)} />
            <span className="td-label">{agent ? '执行' : '提醒'}</span>
            <input type="time" className="td-date-input" value={time} onChange={e => setTime(e.target.value)} />
          </div>
          {agent && (
            <div className="td-create-hint">
              到点将自动唤起 agent 执行，完成后周期自动滚入下一轮
            </div>
          )}
        </div>
        <div className="td-consult-foot">
          <button className="td-chip" onClick={close}>取消</button>
          <button className="td-chip is-on" onClick={commit} disabled={!title.trim() || !firstDue}>立入周期</button>
        </div>
      </div>
    </div>
  );
};
