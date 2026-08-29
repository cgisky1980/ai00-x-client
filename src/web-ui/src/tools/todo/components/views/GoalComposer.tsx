/**
 * GoalComposer — 立志弹窗（v3 弹窗版）。
 * 立志（标题+为何+可选项目目录）→ 落库即关闭；怎么做交给策窗口的
 * 结构化讨论（AI 判定就绪自动出计划契约）。
 * 志 = 远期方向，无截止日期（2026-08-27 定稿）；截止属于行卡（due）。
 * 项目目录可选：志 = 项目——绑定后关联行卡委托 agent 以此为工作区（cwd 解析链）。
 */
import React, { useEffect, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { useTodoStore } from '../../store/todoStore';
import { useGrowthStore } from '../../store/growthStore';
import { pickWorkspaceDir } from '../../ai/workspace';

export const GoalComposer: React.FC<{
  close: () => void;
  /** 预选分类（志树分类行尾加号传入——立志自动归属该分类） */
  defaultCategoryId?: string;
}> = ({ close, defaultCategoryId }) => {
  const data = useTodoStore((s) => s.data);
  const addGoal = useTodoStore((s) => s.addGoal);
  const checkBadges = useGrowthStore((s) => s.checkBadges);

  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  /** 项目目录（可选——关联行卡委托 agent 的工作区） */
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  /** 所属分类（可选——落左栏对应分组；分类加号进入时预选） */
  const [categoryId, setCategoryId] = useState<string | undefined>(defaultCategoryId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

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
    close();
  };

  return (
    <div className="td-consult" onClick={e => e.target === e.currentTarget && close()}>
      <div className="td-consult-card td-create-card">
        <div className="td-consult-head">
          立志
          <span style={{ flex: 1 }} />
          <button className="todo-panel__close" style={{ width: 24, height: 24 }} onClick={close} title="关闭">
            <X size={14} />
          </button>
        </div>

        {/* 立志模式 */}
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
            </div>
          </div>
          <div className="td-consult-foot">
            <button className="td-chip" onClick={close}>取消</button>
            <button className="td-chip is-on" onClick={commit} disabled={!title.trim()}>立志</button>
          </div>
        </>
      </div>
    </div>
  );
};
