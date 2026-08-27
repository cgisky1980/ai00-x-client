/**
 * useAdoptPlan — 拟策草稿（PlanDraft）采纳的共用逻辑（GoalsView / GoalComposer 消重）。
 *
 * 志行打通语义（2026-08-26 定稿）：志 = 远期目标/项目（愿景容器）；行卡归纳于
 * 志（goalId）。拟策产出的任务**全部落想法池**（status: 'requirement'）——每个
 * 任务走完整的 想法→计划→执行→验收 生命周期，而非隐式待办。
 * milestones **合并**（保留旧 id → 旧任务挂点稳定；新阶段追加、同题去重）——
 * 修复整体重建导致旧任务失挂的问题。
 */
import { useCallback } from 'react';
import type { PlanDraft } from '../ai/consult';
import { useTodoStore } from '../store/todoStore';

export function useAdoptPlan() {
  return useCallback((goalId: string, d: PlanDraft): number => {
    const store = useTodoStore.getState();
    const goal = store.data.goals.find(g => g.id === goalId);
    if (!goal) return 0;

    // milestones 合并：旧阶段保留（id 不变）；新阶段同题去重后追加
    const merged = [...goal.milestones];
    const draftIdxToMerged: number[] = d.milestones.map(title => {
      const exist = merged.findIndex(m => m.title === title);
      if (exist >= 0) return exist;
      merged.push({
        id: `ms-${goalId}-${Date.now()}-${merged.length}-${Math.random().toString(36).slice(2, 5)}`,
        title,
        done: false,
      });
      return merged.length - 1;
    });
    // 志的阶段上限 6（与 sanitize 口径一致；旧阶段在前优先保留）
    const kept = merged.slice(0, 6);

    store.updateGoal(goalId, {
      milestones: kept,
    });

    // 任务全部落想法池（带志/阶段关联，走完整生命周期）
    let added = 0;
    for (const t of d.tasks) {
      const msIdx =
        t.milestone >= 1 && t.milestone <= draftIdxToMerged.length
          ? draftIdxToMerged[t.milestone - 1]
          : -1;
      store.addTask(t.title, {
        due: t.due,
        goalId,
        milestoneId: msIdx >= 0 && msIdx < kept.length ? kept[msIdx].id : null,
        listId: null,
        status: 'requirement',
      });
      added++;
    }
    return added;
  }, []);
}
