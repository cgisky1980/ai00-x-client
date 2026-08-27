/**
 * GoalComposer — 立志弹窗（v3 弹窗版）+ 立志后分流。
 * 立志（标题+为何+可选项目目录）→ 弹窗内分流：「AI 拟策 · 分解怎么做」/「暂不计划」
 * → 拟策出 PlanDraftModal 确认采纳（策略+阶段+任务一次入志）。
 * 志 = 远期方向，无截止日期（2026-08-27 定稿）；截止属于行卡（due）。
 * 项目目录可选：志 = 项目——绑定后关联行卡委托 agent 以此为工作区（cwd 解析链）。
 */
import React, { useEffect, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { useTodoStore } from '../../store/todoStore';
import { useGrowthStore } from '../../store/growthStore';
import { draftPlan, type PlanDraft } from '../../ai/consult';
import { pickWorkspaceDir } from '../../ai/workspace';
import { XpKinds } from '../../api/types';
import { PlanDraftModal } from './PlanDraftModal';
import { useAdoptPlan } from '../../hooks/useAdoptPlan';

export const GoalComposer: React.FC<{
  close: () => void;
  /** 预选分类（志树分类行尾加号传入——立志自动归属该分类） */
  defaultCategoryId?: string;
}> = ({ close, defaultCategoryId }) => {
  const data = useTodoStore((s) => s.data);
  const addGoal = useTodoStore((s) => s.addGoal);
  const adoptPlan = useAdoptPlan();
  const addXp = useGrowthStore((s) => s.addXp);
  const checkBadges = useGrowthStore((s) => s.checkBadges);

  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  /** 项目目录（可选——关联行卡委托 agent 的工作区） */
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  /** 所属分类（可选——落左栏对应分组；分类加号进入时预选） */
  const [categoryId, setCategoryId] = useState<string | undefined>(defaultCategoryId);
  /** 刚立志待分流的 goalId */
  const [planChoice, setPlanChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planModal, setPlanModal] = useState<{ goalId: string; draft: PlanDraft } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !planModal) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, planModal]);

  const commit = () => {
    if (!title.trim()) return;
    const goal = addGoal(
      title.trim().slice(0, 60),
      why.trim().slice(0, 80),
      null,
      undefined,
      undefined,
      workspaceDir ?? undefined
    );
    if (categoryId) {
      useTodoStore.getState().updateGoal(goal.id, { categoryId });
    }
    void checkBadges();
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

  const onAdoptPlan = (goalId: string, d: PlanDraft) => {
    const n = adoptPlan(goalId, d);
    void addXp(XpKinds.taskDone, 0, { planAdopted: goalId });
    useGrowthStore.getState().showToast('策已入志', `+${n} 任务已落想法池`);
  };

  return (
    <div className="td-consult" onClick={e => e.target === e.currentTarget && !planModal && close()}>
      <div className="td-consult-card td-create-card">
        <div className="td-consult-head">
          立志
          <span style={{ flex: 1 }} />
          <button className="todo-panel__close" style={{ width: 24, height: 24 }} onClick={close} title="关闭">
            <X size={14} />
          </button>
        </div>

        {planChoice ? (
          // 分流模式：刚立完志，选择怎么到达
          (() => {
            const goal = data.goals.find((g) => g.id === planChoice);
            if (!goal) {
              setPlanChoice(null);
              return null;
            }
            return (
              <>
                <div className="td-consult-body td-create-body">
                  <div className="td-create-hint" style={{ textAlign: 'left' }}>
                    「{goal.title.slice(0, 24)}」怎么到达？
                  </div>
                </div>
                <div className="td-consult-foot">
                  <button className="td-chip" onClick={close}>稍后再说</button>
                  <button
                    className="td-chip is-on"
                    disabled={busy}
                    onClick={() => void runDraftPlan(planChoice)}
                  >
                    {busy ? '拟策中…' : 'AI 拟策 · 分解怎么做'}
                  </button>
                </div>
                {planModal && (
                  <PlanDraftModal
                    goalTitle={goal.title}
                    draft={planModal.draft}
                    onClose={() => {
                      setPlanModal(null);
                      close();
                    }}
                    onAdopt={(d) => {
                      onAdoptPlan(planModal.goalId, d);
                      setPlanModal(null);
                      close();
                    }}
                  />
                )}
              </>
            );
          })()
        ) : (
          // 立志模式
          <>
            <div className="td-consult-body td-create-body">
              <input
                className="td-create-title"
                placeholder="立志，如「通读 RWKV 论文」"
                value={title}
                autoFocus
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && title.trim()) commit();
                }}
              />
              <input
                className="td-create-notes"
                placeholder="为何（可选）"
                value={why}
                onChange={e => setWhy(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && title.trim()) commit();
                }}
              />
              {/* 分类选择（chips：未分类 + 各分类 emoji·名） */}
              {data.goalCategories.length > 0 && (
                <div className="td-chips">
                  <span className="td-label">分类</span>
                  <button
                    type="button"
                    className={`td-chip${!categoryId ? ' is-on' : ''}`}
                    onClick={() => setCategoryId(undefined)}
                    title="不归任何分类"
                  >
                    未分类
                  </button>
                  {data.goalCategories.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      className={`td-chip${categoryId === c.id ? ' is-on' : ''}`}
                      onClick={() => setCategoryId(c.id)}
                      title={c.name}
                    >
                      {c.emoji} {c.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="td-chips">
                <span className="td-label">目录</span>
                <button
                  type="button"
                  className="td-chip"
                  onClick={() => {
                    void pickWorkspaceDir().then(dir => {
                      if (dir) setWorkspaceDir(dir);
                    });
                  }}
                  title="选择项目目录（可选）——关联行卡委托 agent 时以此为工作区；不选则走全局默认工作区"
                >
                  <FolderOpen size={10} />
                  {workspaceDir ? workspaceDir : '项目目录（可选）'}
                </button>
                <span className="td-label">立完志再定怎么做</span>
              </div>
            </div>
            <div className="td-consult-foot">
              <button className="td-chip" onClick={close}>取消</button>
              <button className="td-chip is-on" onClick={commit} disabled={!title.trim()}>立志</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
