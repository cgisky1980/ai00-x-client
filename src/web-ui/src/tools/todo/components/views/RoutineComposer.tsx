/**
 * RoutineComposer — 周期新建表单（面板底部固定区，从 RoutineView 抽出）。
 * 标题 + 规则 + 首次日期 → 一步入库。
 */
import React, { useState } from 'react';
import { useTodoStore } from '../../store/todoStore';
import type { RepeatType } from '../../api/types';

export const RoutineComposer: React.FC = () => {
  const addTask = useTodoStore((s) => s.addTask);

  const [title, setTitle] = useState('');
  const [rule, setRule] = useState<RepeatType>('daily');
  const [firstDue, setFirstDue] = useState('');

  const commit = () => {
    const name = title.trim();
    if (!name) return;
    addTask(name.slice(0, 80), {
      repeat: { type: rule, afterCompletion: false },
      due: firstDue || null,
    });
    setTitle('');
    setFirstDue('');
  };

  return (
    <div className="td-goal-add" style={{ marginBottom: 0 }}>
      <input
        placeholder="周期之事，如「每天晨读 20 分钟」"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commit()}
      />
      <div className="td-chips">
        <span className="td-label">规则</span>
        <select className="td-select" value={rule} onChange={(e) => setRule(e.target.value as RepeatType)}>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
          <option value="monthly">每月</option>
          <option value="weekdays">工作日</option>
        </select>
        <span className="td-label">首次</span>
        <input type="date" className="td-date-input" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
        <button className="td-chip is-on" onClick={commit}>
          立入周期
        </button>
      </div>
    </div>
  );
};
