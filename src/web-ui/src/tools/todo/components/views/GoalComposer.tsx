/**
 * GoalComposer — 立志表单 + 立志后分流（面板底部固定区，从 GoalsView 抽出）。
 * 立志（标题+为何，无截止）→ 分流：「AI 拟策 · 分解怎么做」/「暂不计划」
 * → 拟策出 PlanDraftModal 确认采纳（策略+阶段+任务一次入志）。
 */
import React, { useState } from 'react';
import { useTodoStore } from '../../store/todoStore';
import { useGrowthStore } from '../../store/growthStore';
import { draftPlan, type PlanDraft } from '../../ai/consult';
import { XpKinds } from '../../api/types';
import { PlanDraftModal } from './PlanDraftModal';

export const GoalComposer: React.FC = () => {
  const data = useTodoStore((s) => s.data);
  const addGoal = useTodoStore((s) => s.addGoal);
  const updateGoal = useTodoStore((s) => s.updateGoal);
  const addTask = useTodoStore((s) => s.addTask);
  const addXp = useGrowthStore((s) => s.addXp);
  const checkBadges = useGrowthStore((s) => s.checkBadges);

  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  /** 刚立志待分流的 goalId */
  const [planChoice, setPlanChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planModal, setPlanModal] = useState<{ goalId: string; draft: PlanDraft } | null>(null);

  const commit = () => {
    if (!title.trim()) return;
    const goal = addGoal(title.trim().slice(0, 60), why.trim().slice(0, 80), null);
    void checkBadges();
    setTitle('');
    setWhy('');
    setPlanChoice(goal.id);
  };

  const runDraftPlan = async (goalId: string) => {
    const goal = data.goals.find((g) => g.id === goalId);
    if (!goal) return;
    setPlanChoice(null);
    setBusy(true);
    try {
      const draft = await draftPlan(goal.title, goal.why, goal.deadline);
      if (draft && (draft.plan.length || draft.tasks.length)) {
        setPlanModal({ goalId, draft });
      } else {
        useGrowthStore.getState().showToast('拟策失败', '可在志卡片上重试或手动添加');
      }
    } finally {
      setBusy(false);
    }
  };

  const adoptPlan = (goalId: string, d: PlanDraft) => {
    const goal = data.goals.find((g) => g.id === goalId);
    if (!goal) return;
    const ms = d.milestones.map((m, i) => ({
      id: `ms-${goalId}-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 5)}`,
      title: m,
      done: false,
    }));
    updateGoal(goalId, { plan: [...goal.plan, ...d.plan].slice(0, 6), milestones: ms });
    for (const t of d.tasks) {
      addTask(t.title, {
        due: t.due,
        goalId,
        milestoneId: t.milestone > 0 && ms[t.milestone - 1] ? ms[t.milestone - 1].id : null,
        listId: null,
      });
    }
    void addXp(XpKinds.taskDone, 0, { planAdopted: goalId });
    useGrowthStore.getState().showToast('策已入志', `+${d.tasks.length} 任务`);
  };

  // 分流模式：刚立完志，选择怎么到达
  if (planChoice) {
    const goal = data.goals.find((g) => g.id === planChoice);
    if (!goal) {
      setPlanChoice(null);
      return null;
    }
    return (
      <div className="td-goal-add" style={{ marginBottom: 0 }}>
        <div className="td-goal-title" style={{ fontSize: 13 }}>「{goal.title.slice(0, 16)}」怎么到达？</div>
        <div className="td-chips">
          <button className="td-chip is-on" disabled={busy} onClick={() => void runDraftPlan(planChoice)}>
            {busy ? '拟策中…' : 'AI 拟策 · 分解怎么做'}
          </button>
          <button className="td-chip" onClick={() => setPlanChoice(null)}>
            暂不计划
          </button>
        </div>
        {planModal && (
          <PlanDraftModal
            goalTitle={goal.title}
            draft={planModal.draft}
            onClose={() => setPlanModal(null)}
            onAdopt={(d) => adoptPlan(planModal.goalId, d)}
          />
        )}
      </div>
    );
  }

  // 立志模式
  return (
    <div className="td-goal-add" style={{ marginBottom: 0 }}>
      <input
        placeholder="立志，如「通读 RWKV 论文」"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commit()}
      />
      <input
        placeholder="为何（可选）"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commit()}
      />
      <div className="td-chips">
        <button className="td-chip is-on" onClick={commit}>
          立志
        </button>
        <span className="td-label">立完志再定怎么做</span>
      </div>
    </div>
  );
};
