/**
 * RoutineView — 周期之策（一级大项，卡片式）。
 * 任务卡片：标题 + 重复规则徽标 + 下次到期 + 完成统计。
 * 新建入口在面板底部固定区（RoutineComposer）。
 */
import React, { useMemo } from 'react';
import { Repeat as RepeatIcon } from 'lucide-react';
import { useTodoStore, dueLabel } from '../../store/todoStore';
import { REPEAT_LABELS } from '../../api/labels';

export const RoutineView: React.FC = () => {
  const data = useTodoStore((s) => s.data);

  // 注意：不能在选择器里 .filter()（每次返回新数组引用 → useSyncExternalStore
  // 快照不稳定 → React #185 无限渲染）。订阅原始 tasks，useMemo 派生。
  const routines = useMemo(
    () => data.tasks.filter((t) => !t.completedAt && t.repeat),
    [data.tasks]
  );

  return (
    <div style={{ paddingTop: 8 }}>
      <div className="td-growth-section">周期之策（{routines.length}）</div>

      {routines.length === 0 && (
        <div className="todo-panel__empty">尚无周期之事——把日课立起来</div>
      )}

      {routines
        .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))
        .map((t) => {
          const due = t.due ? dueLabel(t.due) : null;
          const doneCount = data.tasks.filter(
            (x) => x.completedAt && x.title === t.title && x.repeat?.type === t.repeat?.type
          ).length;
          return (
            <div key={t.id} className="td-goal">
              <div className="td-goal-head">
                <span className="td-repeat-mark">
                  <RepeatIcon size={9} /> {REPEAT_LABELS[t.repeat!.type]}
                </span>
                <span className="td-goal-title">{t.title}</span>
                {due && (
                  <span className={`td-due${due.overdue ? ' is-overdue' : ''}`}>
                    {due.overdue ? `逾期·${due.text}` : `下次 ${due.text}`}
                  </span>
                )}
              </div>
              <div className="td-goal-meta">
                <span>已行 {doneCount} 次</span>
                <span style={{ flex: 1 }} />
                {t.repeat!.afterCompletion && <span>完成后重复</span>}
              </div>
            </div>
          );
        })}
    </div>
  );
};
