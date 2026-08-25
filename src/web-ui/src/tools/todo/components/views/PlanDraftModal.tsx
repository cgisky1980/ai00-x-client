/**
 * PlanDraftModal — AI 方案草稿确认模态（面板内）。
 * 三区：策略段（可编辑/删）/ 阶段（可编辑/删）/ 任务（勾选+阶段归属可改）→ 一次入库。
 */
import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { PlanDraft } from '../../ai/consult';

export const PlanDraftModal: React.FC<{
  goalTitle: string;
  draft: PlanDraft;
  onClose: () => void;
  onAdopt: (d: PlanDraft) => void;
}> = ({ goalTitle, draft, onClose, onAdopt }) => {
  const [plan, setPlan] = useState(draft.plan);
  const [milestones, setMilestones] = useState(draft.milestones);
  const [tasks, setTasks] = useState(draft.tasks.map((t) => ({ ...t, checked: true })));

  const setTask = (i: number, patch: Partial<(typeof tasks)[number]>) =>
    setTasks((ts) => ts.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));

  return (
    <div className="td-consult" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="td-consult-card">
        <div className="td-consult-head">
          拟策 · {goalTitle.slice(0, 10)}
          <span style={{ flex: 1 }} />
          <button className="todo-panel__close" style={{ width: 24, height: 24 }} onClick={onClose} title="关闭">
            <X size={14} />
          </button>
        </div>

        <div className="td-consult-body">
          {/* 策略 */}
          {plan.length > 0 && (
            <>
              <div className="td-growth-section" style={{ margin: '4px 0' }}>策略</div>
              {plan.map((p, i) => (
                <div key={i} className="td-consult-draft-row" style={{ alignItems: 'flex-start' }}>
                  <span className="td-label" style={{ flexShrink: 0 }}>{i + 1}.</span>
                  <div
                    className="td-consult-a"
                    style={{ flex: 1, maxWidth: 'none', background: 'transparent', padding: 0 }}
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(e) => setPlan((ps) => ps.map((x, idx) => (idx === i ? e.currentTarget.innerText : x)))}
                  >
                    {p}
                  </div>
                  <button className="td-card-row-del" style={{ opacity: 1 }} onClick={() => setPlan((ps) => ps.filter((_, idx) => idx !== i))}>×</button>
                </div>
              ))}
            </>
          )}

          {/* 阶段 */}
          {milestones.length > 0 && (
            <>
              <div className="td-growth-section" style={{ margin: '4px 0' }}>阶段</div>
              <div className="td-chips" style={{ padding: '0 8px' }}>
                {milestones.map((m, i) => (
                  <span key={i} className="td-chip is-on" style={{ cursor: 'text', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    {i + 1}. {m}
                    <button
                      className="td-card-row-del"
                      style={{ opacity: 0.7, marginLeft: 2 }}
                      title="删除该阶段（挂靠任务自动归「未分」）"
                      onClick={() => {
                        setMilestones((ms) => ms.filter((_, idx) => idx !== i));
                        setTasks((ts) => ts.map((t) => (t.milestone === i + 1 ? { ...t, milestone: 0 } : t)));
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </>
          )}

          {/* 任务 */}
          {tasks.length > 0 && (
            <>
              <div className="td-growth-section" style={{ margin: '4px 0' }}>任务（勾选采纳）</div>
              {tasks.map((t, i) => (
                <div key={i} className="td-consult-draft-row">
                  <input
                    type="checkbox"
                    className="td-check"
                    checked={t.checked}
                    onChange={(e) => setTask(i, { checked: e.target.checked })}
                  />
                  <div
                    style={{ flex: 1, minWidth: 0 }}
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(e) => setTask(i, { title: e.currentTarget.innerText.trim() || t.title })}
                  >
                    {t.title}
                  </div>
                  {t.due && <span className="td-due">{t.due.slice(5)}</span>}
                  {milestones.length > 0 && (
                    <select
                      className="td-select"
                      value={t.milestone}
                      onChange={(e) => setTask(i, { milestone: Number(e.target.value) })}
                      title="所属阶段"
                    >
                      <option value={0}>未分</option>
                      {milestones.map((m, mi) => (
                        <option key={mi} value={mi + 1}>
                          {mi + 1}.{m.slice(0, 6)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="td-consult-foot">
          <button className="td-chip" onClick={onClose}>
            取消
          </button>
          <button
            className="td-chip is-on"
            onClick={() => {
              onAdopt({
                plan,
                milestones,
                tasks: tasks.filter((t) => t.checked).map(({ checked, ...rest }) => rest),
              });
              onClose();
            }}
          >
            采纳入志
          </button>
        </div>
      </div>
    </div>
  );
};
