/**
 * TaskRow — 任务行（点击选中 → 详情在面板右侧栏 TaskDetailPane 展开）。
 * TaskDetailPane — 右侧详情面板：备注/目标·阶段/截止/提醒/重复/检查项/删除。
 */
import React, { useState } from 'react';
import { Bell, Repeat as RepeatIcon } from 'lucide-react';
import type { TodoTask } from '../api/types';
import { REPEAT_LABELS } from '../api/labels';
import { useTodoStore, dueLabel, todayStr } from '../store/todoStore';
import { breakdownTask } from '../ai/consult';

function fmtReminder(remindAt: string): string {
  const [d, time] = remindAt.split('T');
  const today = todayStr();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tmStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  let label = d;
  if (d === today) label = '今天';
  else if (d === tmStr) label = '明天';
  else label = `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
  return `${label} ${time}`;
}

export const TaskRow: React.FC<{ task: TodoTask; onAward: (taskId: string, title: string, xp: number) => void }> = ({ task, onAward }) => {
  const expandedId = useTodoStore((s) => s.expandedId);
  const setExpanded = useTodoStore((s) => s.setExpanded);
  const updateTask = useTodoStore((s) => s.updateTask);
  const completeTask = useTodoStore((s) => s.completeTask);

  const expanded = expandedId === task.id;
  const due = task.due ? dueLabel(task.due) : null;

  const onCheck = (checked: boolean) => {
    if (checked) {
      // XP：10 基础 + 今日到期 5 + 检查项全勾 3（上限 20）
      const today = todayStr();
      let xp = 10;
      if (task.due && task.due <= today) xp += 5;
      if (task.checklist.length > 0 && task.checklist.every((c) => c.d)) xp += 3;
      xp = Math.min(xp, 20);
      completeTask(task.id, true);
      onAward(task.id, task.title, xp);
    } else {
      completeTask(task.id, false);
    }
  };

  return (
    <div className={`td-row${task.completedAt ? ' is-done' : ''}${expanded ? ' is-selected' : ''}`}>
      <div className="td-row-main" onClick={() => setExpanded(expanded ? null : task.id)}>
        <input
          type="checkbox"
          className="td-check"
          checked={!!task.completedAt}
          onChange={(e) => {
            e.stopPropagation();
            onCheck(e.target.checked);
          }}
          onClick={(e) => e.stopPropagation()}
        />
        <div
          className="td-title"
          contentEditable
          suppressContentEditableWarning
          onBlur={(e) => updateTask(task.id, { title: e.currentTarget.innerText.trim() || task.title })}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              (e.currentTarget as HTMLElement).blur();
            }
          }}
        >
          {task.title}
        </div>

        {task.repeat && (
          <span className="td-repeat-mark" title={REPEAT_LABELS[task.repeat.type]}>
            <RepeatIcon size={9} /> {REPEAT_LABELS[task.repeat.type]}
          </span>
        )}
        {task.checklist.length > 0 && (
          <span className="td-count">
            {task.checklist.filter((c) => c.d).length}/{task.checklist.length}
          </span>
        )}
        {due && <span className={`td-due${due.overdue && !task.completedAt ? ' is-overdue' : ''}`}>{due.text}</span>}
        {task.remindAt && !task.remindedAt && !task.completedAt && (
          <span className="td-bell is-set" title={`提醒 ${fmtReminder(task.remindAt)}`}>
            <Bell size={11} />
          </span>
        )}
        <button
          className="td-flag"
          style={{ display: task.flag ? 'block' : undefined }}
          onClick={(e) => {
            e.stopPropagation();
            updateTask(task.id, { flag: !task.flag });
          }}
          title={task.flag ? '取消旗标' : '旗标（今天视图置顶）'}
        >
          ⚑
        </button>
      </div>
    </div>
  );
};

const REPEAT_OPTIONS = [
  { value: '', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'weekdays', label: '工作日' },
] as const;

/** 右侧详情面板（TodoPanel 双栏布局的右栏；选中任务后出现）。 */
export const TaskDetailPane: React.FC<{ task: TodoTask }> = ({ task }) => {
  const deleteTask = useTodoStore((s) => s.deleteTask);
  const [breakdownBusy, setBreakdownBusy] = useState(false);

  const runBreakdown = async () => {
    setBreakdownBusy(true);
    try {
      const items = await breakdownTask(task.title);
      if (items) {
        useTodoStore.getState().updateTask(task.id, { checklist: items.map((t) => ({ t, d: false })) });
      }
    } finally {
      setBreakdownBusy(false);
    }
  };

  return (
    <TaskDetail task={task} onRunBreakdown={runBreakdown} breakdownBusy={breakdownBusy} onDelete={() => deleteTask(task.id)} />
  );
};

const TaskDetail: React.FC<{
  task: TodoTask;
  onRunBreakdown: () => void;
  breakdownBusy: boolean;
  onDelete: () => void;
}> = ({ task, onRunBreakdown, breakdownBusy, onDelete }) => {
  const data = useTodoStore((s) => s.data);
  const updateTask = useTodoStore((s) => s.updateTask);

  const today = todayStr();
  const tomorrow = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const nextWeek = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  const quickReminders = [
    { label: '今天 09:00', value: `${today}T09:00` },
    { label: '明天 09:00', value: `${tomorrow}T09:00` },
    ...(task.due ? [{ label: '截止日 09:00', value: `${task.due}T09:00` }] : []),
  ];

  return (
    <div className="td-detail" onClick={(e) => e.stopPropagation()}>
      <textarea
        placeholder="备注…"
        defaultValue={task.notes}
        onChange={(e) => updateTask(task.id, { notes: e.target.value })}
      />

      {/* 目标关联 + 阶段 */}
      {data.goals.length > 0 && (
        <div className="td-chips">
          <span className="td-label">目标</span>
          <select
            className="td-select"
            value={task.goalId || ''}
            onChange={(e) => updateTask(task.id, { goalId: e.target.value || null, milestoneId: null })}
          >
            <option value="">无</option>
            {data.goals.filter((g) => !g.doneAt).map((g) => (
              <option key={g.id} value={g.id}>{g.title.slice(0, 12)}</option>
            ))}
          </select>
          {(() => {
            const goal = data.goals.find((g) => g.id === task.goalId);
            if (!goal || goal.milestones.length === 0) return null;
            return (
              <>
                <span className="td-label">阶段</span>
                <select
                  className="td-select"
                  value={task.milestoneId || ''}
                  onChange={(e) => updateTask(task.id, { milestoneId: e.target.value || null })}
                >
                  <option value="">未分</option>
                  {goal.milestones.map((m) => (
                    <option key={m.id} value={m.id}>{m.title.slice(0, 10)}</option>
                  ))}
                </select>
              </>
            );
          })()}
        </div>
      )}

      {/* 截止 */}
      <div className="td-chips">
        <span className="td-label">截止</span>
        {[
          { label: '今天', value: today },
          { label: '明天', value: tomorrow },
          { label: '下周', value: nextWeek },
        ].map((c) => (
          <button
            key={c.label}
            className={`td-chip${task.due === c.value ? ' is-on' : ''}`}
            onClick={() => updateTask(task.id, { due: c.value })}
          >
            {c.label}
          </button>
        ))}
        <input
          type="date"
          className="td-date-input"
          value={task.due || ''}
          onChange={(e) => updateTask(task.id, { due: e.target.value || null })}
        />
        {task.due && (
          <button className="td-chip is-danger" onClick={() => updateTask(task.id, { due: null })}>
            清除
          </button>
        )}
      </div>

      {/* 提醒 */}
      <div className="td-chips">
        <span className="td-label">提醒</span>
        {quickReminders.map((r) => (
          <button
            key={r.label}
            className={`td-chip${task.remindAt === r.value ? ' is-on' : ''}`}
            onClick={() => updateTask(task.id, { remindAt: r.value, remindedAt: null })}
          >
            {r.label}
          </button>
        ))}
        <input
          type="datetime-local"
          className="td-date-input"
          value={task.remindAt || ''}
          onChange={(e) => updateTask(task.id, { remindAt: e.target.value || null, remindedAt: null })}
        />
        {task.remindAt && (
          <button className="td-chip is-danger" onClick={() => updateTask(task.id, { remindAt: null, remindedAt: null })}>
            清除
          </button>
        )}
      </div>

      {/* 重复 */}
      <div className="td-chips">
        <span className="td-label">重复</span>
        <select
          className="td-select"
          value={task.repeat?.type || ''}
          onChange={(e) =>
            updateTask(task.id, {
              repeat: e.target.value ? { type: e.target.value as TodoTask['repeat'] extends null ? never : NonNullable<TodoTask['repeat']>['type'], afterCompletion: task.repeat?.afterCompletion ?? false } : null,
            })
          }
        >
          {REPEAT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {task.repeat && (
          <label className="td-checkline">
            <input
              type="checkbox"
              className="td-check"
              checked={task.repeat.afterCompletion}
              onChange={(e) =>
                updateTask(task.id, {
                  repeat: { type: task.repeat!.type, afterCompletion: e.target.checked },
                })
              }
            />
            完成后重复
          </label>
        )}
      </div>

      {/* 检查项 */}
      <div className="td-cl">
        <div className="td-chips">
          <span className="td-label">检查项</span>
          {task.checklist.length > 0 && (
            <span className="td-count">
              {task.checklist.filter((c) => c.d).length}/{task.checklist.length}
            </span>
          )}
          <button className="td-chip" disabled={breakdownBusy} onClick={onRunBreakdown}>
            {breakdownBusy ? '拆解中…' : 'AI 拆解'}
          </button>
        </div>
        {task.checklist.map((item, idx) => (
          <div key={idx} className={`td-cl-row${item.d ? ' is-done' : ''}`}>
            <input
              type="checkbox"
              className="td-check"
              checked={item.d}
              onChange={(e) => {
                const next = [...task.checklist];
                next[idx] = { ...item, d: e.target.checked };
                updateTask(task.id, { checklist: next });
              }}
            />
            <div
              className="td-cl-text"
              contentEditable
              suppressContentEditableWarning
              onBlur={(e) => {
                const next = [...task.checklist];
                next[idx] = { ...item, t: e.currentTarget.innerText };
                updateTask(task.id, { checklist: next });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  (e.currentTarget as HTMLElement).blur();
                }
              }}
            >
              {item.t}
            </div>
            <button
              className="td-cl-del"
              onClick={() => updateTask(task.id, { checklist: task.checklist.filter((_, i) => i !== idx) })}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="td-cl-add"
          onClick={() => updateTask(task.id, { checklist: [...task.checklist, { t: '', d: false }] })}
        >
          + 检查项
        </button>
      </div>

      <div className="td-detail-foot">
        <button className="td-chip is-danger" onClick={onDelete}>
          删除任务
        </button>
      </div>
    </div>
  );
};
