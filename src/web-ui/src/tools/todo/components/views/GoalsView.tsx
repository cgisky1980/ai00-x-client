/**
 * GoalsView — 志：目标→方案→任务三级。
 * 志卡 = 标题/截止/进度 + 方案折叠区（AI 拟策/手动添加段）+ 阶段链（里程碑）
 * + 关联任务（按阶段分组折叠）。「AI 拟策」走 draftPlan（策略+阶段+任务三段草稿确认）。
 * 立志入口在面板底部固定区（GoalComposer，立志后分流拟策/暂不计划）。
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Circle, CircleCheck, Plus } from 'lucide-react';
import { useTodoStore, goalProgress, dueLabel } from '../../store/todoStore';
import { useGrowthStore } from '../../store/growthStore';
import { draftPlan, type PlanDraft } from '../../ai/consult';
import { XpKinds } from '../../api/types';
import { PlanDraftModal } from './PlanDraftModal';

export const GoalsView: React.FC = () => {
  const data = useTodoStore((s) => s.data);
  const updateGoal = useTodoStore((s) => s.updateGoal);
  const completeGoal = useTodoStore((s) => s.completeGoal);
  const deleteGoal = useTodoStore((s) => s.deleteGoal);
  const addTask = useTodoStore((s) => s.addTask);
  const addXp = useGrowthStore((s) => s.addXp);
  const checkBadges = useGrowthStore((s) => s.checkBadges);
  const showToast = useGrowthStore((s) => s.showToast);

  const [planModal, setPlanModal] = useState<{ goalId: string; draft: PlanDraft } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openPlan, setOpenPlan] = useState<string | null>(null);
  const [openTasks, setOpenTasks] = useState<string | null>(null);
  const [newTaskOf, setNewTaskOf] = useState<string | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');

  const runDraftPlan = async (goalId: string) => {
    const goal = data.goals.find((g) => g.id === goalId);
    if (!goal) return;
    setBusyId(goalId);
    try {
      const draft = await draftPlan(goal.title, goal.why, goal.deadline);
      if (draft && (draft.plan.length || draft.tasks.length)) {
        setPlanModal({ goalId, draft });
      } else {
        showToast('拟策失败', '可手动添加方案段');
      }
    } finally {
      setBusyId(null);
    }
  };

  const adoptPlan = (goalId: string, d: PlanDraft) => {
    const goal = data.goals.find((g) => g.id === goalId);
    if (!goal) return;
    // 方案段追加（保留已有）；阶段重建（清空旧阶段重挂）；任务带 milestone 索引入库
    const ms = d.milestones.map((m) => ({ id: `ms-${goalId}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, title: m, done: false }));
    updateGoal(goalId, { plan: [...goal.plan, ...d.plan].slice(0, 6), milestones: ms });
    for (const t of d.tasks) {
      addTask(t.title, {
        due: t.due,
        goalId,
        milestoneId: t.milestone > 0 && ms[t.milestone - 1] ? ms[t.milestone - 1].id : null,
        listId: null,
      });
    }
    showToast('策已入志', `+${d.tasks.length} 任务`);
  };

  const onDone = (goalId: string) => {
    completeGoal(goalId);
    void addXp(XpKinds.taskDone, 20, { goalDone: goalId });
    void checkBadges();
  };

  const goals = [...data.goals].sort((a, b) => {
    if (!!a.doneAt !== !!b.doneAt) return a.doneAt ? 1 : -1;
    return (a.deadline || '9999').localeCompare(b.deadline || '9999');
  });

  return (
    <div style={{ paddingTop: 8 }}>
      {goals.length === 0 && <div className="todo-panel__empty">尚未立志——在下方写下一个值得奔赴的方向</div>}

      {goals.map((goal) => {
        const p = goalProgress(data, goal.id);
        const due = goal.deadline ? dueLabel(goal.deadline) : null;
        const tasks = data.tasks.filter((t) => t.goalId === goal.id);
        const planOpen = openPlan === goal.id;
        const tasksOpen = openTasks === goal.id;
        return (
          <div key={goal.id} className={`td-goal${goal.doneAt ? ' is-done' : ''}`}>
            {/* 志头 */}
            <div className="td-goal-head">
              <span className="td-goal-title">{goal.title}</span>
              {due && <span className={`td-due${due.overdue && !goal.doneAt ? ' is-overdue' : ''}`}>{due.text}</span>}
              {!goal.doneAt && (
                <button className="td-chip is-on" onClick={() => onDone(goal.id)}>
                  达成
                </button>
              )}
              <button className="td-chip is-danger" onClick={() => deleteGoal(goal.id)}>
                删
              </button>
            </div>
            {goal.why && <div className="td-goal-why">{goal.why}</div>}

            {p.total > 0 && (
              <div className="td-goal-bar">
                <span className="td-goal-fill" style={{ width: `${Math.round((p.done / p.total) * 100)}%` }} />
              </div>
            )}

            {/* 方案折叠区 */}
            <div className="td-goal-meta">
              <button className="td-chip" onClick={() => setOpenPlan(planOpen ? null : goal.id)}>
                {planOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />} 方案（{goal.plan.length}）
              </button>
              {!goal.doneAt && (
                <button className="td-chip" disabled={busyId === goal.id} onClick={() => void runDraftPlan(goal.id)}>
                  {busyId === goal.id ? '拟策中…' : 'AI 拟策'}
                </button>
              )}
              <span style={{ flex: 1 }} />
              <span>任务 {p.done}/{p.total}</span>
            </div>
            {planOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {goal.plan.length === 0 && (
                  <div className="td-sync-hint">未定方案——AI 拟策或手动添加</div>
                )}
                {goal.plan.map((seg, i) => (
                  <div key={i} className="td-consult-draft-row" style={{ alignItems: 'flex-start' }}>
                    <span className="td-label" style={{ flexShrink: 0 }}>{i + 1}.</span>
                    <div
                      style={{ flex: 1, lineHeight: 1.5, userSelect: 'text' }}
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(e) =>
                        updateGoal(goal.id, {
                          plan: goal.plan.map((x, idx) => (idx === i ? e.currentTarget.innerText.trim() : x)),
                        })
                      }
                    >
                      {seg}
                    </div>
                    <button
                      className="td-card-row-del"
                      style={{ opacity: 1 }}
                      onClick={() => updateGoal(goal.id, { plan: goal.plan.filter((_, idx) => idx !== i) })}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {goal.plan.length < 6 && (
                  <button
                    className="td-cl-add"
                    onClick={() => updateGoal(goal.id, { plan: [...goal.plan, ''] })}
                  >
                    <Plus size={10} /> 添加一段
                  </button>
                )}
              </div>
            )}

            {/* 阶段链（里程碑） */}
            {goal.milestones.length > 0 && (
              <div className="td-chips" style={{ padding: '0 2px' }}>
                {goal.milestones.map((m) => (
                  <button
                    key={m.id}
                    className="td-chip"
                    title={m.done ? '已完成' : '未完成'}
                    onClick={() =>
                      updateGoal(goal.id, {
                        milestones: goal.milestones.map((x) => (x.id === m.id ? { ...x, done: !x.done } : x)),
                      })
                    }
                  >
                    {m.done ? <CircleCheck size={11} /> : <Circle size={11} />} {m.title.slice(0, 8)}
                  </button>
                ))}
              </div>
            )}

            {/* 任务分组折叠 */}
            <div className="td-goal-meta">
              <button className="td-chip" onClick={() => setOpenTasks(tasksOpen ? null : goal.id)}>
                {tasksOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />} 任务
              </button>
              <button
                className="td-chip"
                onClick={() => {
                  setNewTaskOf(newTaskOf === goal.id ? null : goal.id);
                  setNewTaskTitle('');
                }}
              >
                <Plus size={11} /> 加任务
              </button>
            </div>
            {newTaskOf === goal.id && (
              <input
                autoFocus
                placeholder="任务名，回车入库挂志"
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && newTaskTitle.trim()) {
                    addTask(newTaskTitle.trim().slice(0, 80), { goalId: goal.id, listId: null });
                    setNewTaskTitle('');
                    setOpenTasks(goal.id);
                  }
                }}
                style={{
                  border: 'none',
                  borderRadius: 6,
                  background: 'color-mix(in oklch, var(--color-text-primary) 8%, transparent)',
                  color: 'var(--color-text-primary)',
                  fontSize: 13,
                  padding: '4px 8px',
                  outline: 'none',
                  fontFamily: 'inherit',
                }}
              />
            )}
            {tasksOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {tasks.length === 0 && <div className="td-sync-hint">尚无关联任务</div>}
                {tasks
                  .filter((t) => !t.milestoneId)
                  .map((t) => (
                    <TaskMiniRow key={t.id} title={t.title} done={!!t.completedAt} due={t.due} />
                  ))}
                {goal.milestones.map((m) => {
                  const group = tasks.filter((t) => t.milestoneId === m.id);
                  if (!group.length) return null;
                  const gDone = group.filter((t) => t.completedAt).length;
                  return (
                    <div key={m.id} style={{ marginTop: 2 }}>
                      <div className="td-goal-meta" style={{ opacity: 0.8 }}>
                        <span>
                          {m.done ? '●' : '○'} {m.title}
                        </span>
                        <span>
                          {gDone}/{group.length}
                        </span>
                      </div>
                      {group.map((t) => (
                        <TaskMiniRow key={t.id} title={t.title} done={!!t.completedAt} due={t.due} />
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {planModal && (
        <PlanDraftModal
          goalTitle={data.goals.find((g) => g.id === planModal.goalId)?.title || ''}
          draft={planModal.draft}
          onClose={() => setPlanModal(null)}
          onAdopt={(d) => adoptPlan(planModal.goalId, d)}
        />
      )}
    </div>
  );
};

const TaskMiniRow: React.FC<{ title: string; done: boolean; due: string | null }> = ({ title, done, due }) => {
  const label = due ? dueLabel(due) : null;
  return (
    <div className="td-cl-row">
      <span style={{ color: done ? 'var(--color-success)' : 'var(--color-text-muted)', fontSize: 11, lineHeight: '13px' }}>
        {done ? '●' : '○'}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          lineHeight: 1.4,
          color: done ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
          textDecoration: done ? 'line-through' : 'none',
        }}
      >
        {title}
      </span>
      {label && <span className={`td-due${label.overdue && !done ? ' is-overdue' : ''}`}>{label.text}</span>}
    </div>
  );
};
