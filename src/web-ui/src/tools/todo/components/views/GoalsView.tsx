/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * GoalsView — 志：左栏标题栏 + 分类树（顶格铺满）+ 右侧详情。
 * 标题栏「🧭 鸿鹄之志」不在树里——右侧两按钮：＋分类 / ＋立志（无分类归属）。
 * 树：默认分类（置顶）→ 自建分类（emoji + 名 + 计数 + 行尾小加号=该分类下立志 + hover 删）
 * → 志子节点（可拖拽换分类）；层级靠缩进 + chevron（无竖线）。
 * 默认首页态（不自动选志），点树节点进详情。
 */
import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Circle, CircleCheck, Coins, FolderOpen, FolderPlus, Plus, Timer, Trash2, X, Zap } from 'lucide-react';
import { InputDialog, Popover, PopoverContent, PopoverTrigger, Tree, confirmDanger, type TreeNodeData } from '@/component-library';
import { useTodoStore, goalProgress, dueLabel } from '../../store/todoStore';
import { pickWorkspaceDir } from '../../ai/workspace';
import { useGrowthStore } from '../../store/growthStore';
import { assessGoal } from '../../ai/consult';
import { collectProjectSummary } from '../../ai/projectSummary';
import { queryLocalUsage, fetchServerUsage, fmtNum, type LocalUsage } from '../../ai/usageApi';
import { MiniBarChart, StackedTokenChart, StatChip } from './UsageCharts';
import { XpKinds, type TodoGoal } from '../../api/types';

/** emoji 备选（志/分类图标）。 */
const EMOJIS = ['🎯', '🚀', '📚', '💻', '🎨', '🌱', '💪', '🧠', '💰', '🏠', '✈️', '🎵', '🔬', '⚙️', '❤️', '⭐', '🔥', '🌊', '🧭', '🏆'];

/** emoji 选择器（Popover 预设网格；chrome 层宿主内弹层须提 z 到 chrome-popup）。 */
const EmojiPicker: React.FC<{
  value?: string;
  onPick: (emoji: string) => void;
  title?: string;
}> = ({ value, onPick, title }) => {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="td-goals__emoji-btn" title={title ?? '设置图标'}>
          {value?.trim() || '😐'}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="td-goals__emoji-pop"
        style={{ zIndex: 'var(--z-chrome-popup, 50030)' }}
      >
        {EMOJIS.map(e => (
          <button
            key={e}
            type="button"
            className={`td-goals__emoji-item${e === value ? ' is-active' : ''}`}
            onClick={() => {
              onPick(e);
              setOpen(false);
            }}
          >
            {e}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
};

export const GoalsView: React.FC<{
  /** 打开立志弹窗；传 categoryId = 该分类行尾加号进入（自动归属） */
  onOpenCreate: (categoryId?: string) => void;
  /** 打开行卡创建弹窗（复用新建想法模式；创建即挂该志） */
  onOpenCreateTask: (goalId: string, goalTitle: string) => void;
}> = ({ onOpenCreate, onOpenCreateTask }) => {
  const data = useTodoStore((s) => s.data);
  const updateGoal = useTodoStore((s) => s.updateGoal);
  const completeGoal = useTodoStore((s) => s.completeGoal);
  const deleteGoal = useTodoStore((s) => s.deleteGoal);
  const addGoalCategory = useTodoStore((s) => s.addGoalCategory);
  const updateGoalCategory = useTodoStore((s) => s.updateGoalCategory);
  const deleteGoalCategory = useTodoStore((s) => s.deleteGoalCategory);
  const addXp = useGrowthStore((s) => s.addXp);
  const checkBadges = useGrowthStore((s) => s.checkBadges);
  const showToast = useGrowthStore((s) => s.showToast);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [openTasks, setOpenTasks] = useState<string | null>(null);
  // 左栏：选中志 / 新建分类 / 拖放
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  /** 显式首页态；详情只在用户点树节点后出现（默认不选志），X 关闭回首页 */
  const [showHome, setShowHome] = useState(true);
  const [newCatOpen, setNewCatOpen] = useState(false);
  const [dragGoalId, setDragGoalId] = useState<string | null>(null);
  const [dragOverCat, setDragOverCat] = useState<string | null>(null);

  // 排序：未达成的在前，各自按创建时间（新志在前）
  const goals = useMemo(
    () =>
      [...data.goals].sort((a, b) => {
        if (!!a.doneAt !== !!b.doneAt) return a.doneAt ? 1 : -1;
        return b.createdAt - a.createdAt;
      }),
    [data.goals]
  );

  const categories = data.goalCategories;
  const selected = useMemo(
    () => (showHome ? null : goals.find(g => g.id === selectedGoalId) ?? null),
    [goals, selectedGoalId, showHome]
  );

  /** 拖放落分类：改志的 categoryId（'__none' = 默认分类）。 */
  const dropToCategory = (catKey: string) => {
    if (dragGoalId) {
      updateGoal(dragGoalId, { categoryId: catKey === '__none' ? undefined : catKey });
    }
    setDragGoalId(null);
    setDragOverCat(null);
  };

  /** 树节点：根「鸿鹄之志」→ 分类（cat:<id>）→ 志（goal:<id>）。 */
  const treeNodes: TreeNodeData[] = useMemo(() => {
    const catGroups = categories.map(c => ({
      c,
      gs: goals.filter(g => g.categoryId === c.id),
    }));
    const noneGoals = goals.filter(
      g => !g.categoryId || !categories.some(c => c.id === g.categoryId)
    );
    /** 分类删除（危险操作：弹窗确认防误删；志自动回默认分类）。 */
    const onDeleteCategory = (catId: string) => {
      const name = categories.find(c => c.id === catId)?.name ?? '该分类';
      void confirmDanger(
        '删除分类',
        `确定删除分类「${name}」吗？其中的志不会丢失，将自动归入默认分类。`,
      ).then(ok => {
        if (ok) deleteGoalCategory(catId);
      });
    };

    /** 分类节点 actions：计数 + 小加号（该分类下立志）+ hover 删。 */
    const catActions = (catId: string, count: number, canDel: boolean) => (
      <span className="td-goals__tree-actions">
        <span className="td-goals__group-count">{count}</span>
        <button
          className="td-goals__tree-add"
          onClick={e => {
            e.stopPropagation();
            onOpenCreate(catId === '__none' ? undefined : catId);
          }}
          title="在此分类下立志"
        >
          <Plus size={10} />
        </button>
        {canDel && (
          <button
            className="td-goals__group-del"
            onClick={e => {
              e.stopPropagation();
              onDeleteCategory(catId);
            }}
            title="删除分类（志自动回默认分类）"
          >
            <Trash2 size={10} />
          </button>
        )}
      </span>
    );
    /** 志子节点。 */
    const goalNode = (g: (typeof goals)[number]): TreeNodeData => ({
      id: `goal:${g.id}`,
      icon: <span className="td-goals__item-emoji">{g.emoji?.trim() || '🎯'}</span>,
      label: <span className={`td-goals__item-title${g.doneAt ? ' is-done' : ''}`}>{g.title}</span>,
    });

    return [
      {
        id: 'cat:__none',
        // 与自建分类的 EmojiPicker 按钮同盒尺寸（emoji-btn 类），保证计数/+行尾动作与名横向对齐
        icon: <span className="td-goals__emoji-btn" aria-hidden>🗂️</span>,
        label: <span className="td-goals__group-name">默认分类</span>,
        actions: catActions('__none', noneGoals.length, false),
        children: noneGoals.map(goalNode),
      },
      ...catGroups.map(({ c, gs }): TreeNodeData => ({
        id: `cat:${c.id}`,
        icon: (
          <EmojiPicker
            value={c.emoji}
            title="设置分类图标"
            onPick={e => updateGoalCategory(c.id, { emoji: e })}
          />
        ),
        label: <span className="td-goals__group-name">{c.name}</span>,
        actions: catActions(c.id, gs.length, true),
        children: gs.map(goalNode),
      })),
    ];
  }, [categories, goals, updateGoalCategory, deleteGoalCategory, onOpenCreate]);

  /** 分类节点 id → catKey（拖放目标映射）。 */
  const catKeyOfNode = (nodeId: string): string | null => {
    if (!nodeId.startsWith('cat:')) return null;
    return nodeId.slice(4);
  };

  /** AI 评估：绑定目录的志先采集项目实况（树/README/git），再生成结构化评估报告（四段）。 */
  const runAssess = async (goalId: string) => {
    const goal = data.goals.find(g => g.id === goalId);
    if (!goal) return;
    setBusyId(goalId);
    try {
      const summary = goal.workspaceDir
        ? await collectProjectSummary(goal.workspaceDir).catch(() => null)
        : null;
      const tasks = data.tasks.filter(t => t.goalId === goalId);
      const report = await assessGoal(
        {
          title: goal.title,
          why: goal.why,
          deadline: goal.deadline,
          milestones: goal.milestones.map(m => ({ title: m.title, done: m.done })),
          progress: {
            done: tasks.filter(t => t.completedAt).length,
            total: tasks.length,
            openTitles: tasks.filter(t => !t.completedAt).map(t => t.title),
          },
          workspaceSummary: summary,
        },
        undefined,
        `todo:assess:${goalId}`
      );
      if (report) {
        updateGoal(goalId, { assessment: { at: Date.now(), ...report } });
      } else {
        showToast('评估失败', '稍后再试');
      }
    } finally {
      setBusyId(null);
    }
  };

  const onDone = (goalId: string) => {
    completeGoal(goalId);
    void addXp(XpKinds.taskDone, 20, { goalDone: goalId });
    void checkBadges();
  };

  return (
    <div className="td-goals">
      {/* ===== 左栏：标题栏（鸿鹄之志，不在树里）+ 分类树（顶格铺满）===== */}
      <aside className="td-goals__side">
        {/* 标题栏：根题 + 右侧两按钮（加分类 / 立志） */}
        <div className="td-goals__side-head">
          <span className="td-goals__root-name">
            <span className="td-goals__item-emoji">🧭</span> 鸿鹄之志
          </span>
          <span className="td-goals__tree-actions">
            <button
              className="td-goals__tree-add"
              onClick={() => setNewCatOpen(true)}
              title="新建分类"
            >
              <FolderPlus size={10} />
            </button>
            <button
              className="td-goals__tree-add"
              onClick={() => onOpenCreate()}
              title="立志（不指定分类）"
            >
              <Plus size={10} />
            </button>
          </span>
        </div>
        <div className="td-goals__side-scroll td-goals__tree">
          {goals.length === 0 && categories.length === 0 && (
            <div className="td-goals__side-empty">尚无志——点右上「＋」立下第一个方向</div>
          )}
          <Tree
            nodes={treeNodes}
            defaultExpandedIds={['cat:__none', ...categories.map(c => `cat:${c.id}`)]}
            selectedId={selected ? `goal:${selected.id}` : null}
            onSelect={node => {
              if (node.id.startsWith('goal:')) {
                setSelectedGoalId(node.id.slice(5));
                setShowHome(false);
              }
            }}
            renderLabel={({ id, label }) => {
              const catKey = catKeyOfNode(id);
              // 志节点：可拖拽（换分类）
              if (!catKey) {
                return (
                  <span
                    className="td-goals__tree-label"
                    draggable
                    onDragStart={() => setDragGoalId(id.slice(5))}
                  >
                    {label}
                  </span>
                );
              }
              // 分类节点：拖放目标（拖志入内换分类）
              return (
                <span
                  className={`td-goals__tree-label td-goals__tree-cat${dragOverCat === catKey ? ' is-over' : ''}`}
                  onDragOver={e => {
                    e.preventDefault();
                    setDragOverCat(catKey);
                  }}
                  onDragLeave={() => setDragOverCat(prev => (prev === catKey ? null : prev))}
                  onDrop={e => {
                    e.preventDefault();
                    dropToCategory(catKey);
                  }}
                >
                  {label}
                </span>
              );
            }}
          />
        </div>
      </aside>

      {/* 新建分类弹窗（ds InputDialog；触发在标题栏 FolderPlus 按钮） */}
      <InputDialog
        isOpen={newCatOpen}
        onClose={() => setNewCatOpen(false)}
        onConfirm={name => addGoalCategory(name)}
        title="新建分类"
        description="为志建一个归类容器，建后可在树下拖拽志入内。"
        placeholder="分类名"
        confirmText="创建"
      />

      {/* ===== 右栏：选中志详情 ===== */}
      <div className="td-goals__main">
        {selected ? (
          <GoalDetail
            goal={selected}
            categoryName={categories.find(c => c.id === selected.categoryId)?.name}
            onClosed={() => setShowHome(true)}
            onDeleted={() => {
              setSelectedGoalId(null);
              setShowHome(true);
            }}
            onOpenCreateTask={onOpenCreateTask}
            {...{
              updateGoal,
              completeGoal: onDone,
              deleteGoal,
              busyId,
              setBusyId,
              runAssess,
              openTasks,
              setOpenTasks,
            }}
          />
        ) : (
          <div className="td-goals__main-empty">
            <div className="td-goals__main-empty-kicker">ZHIXING · GOALS</div>
            <div className="td-goals__main-empty-title">鸿鹄之志</div>
            <div className="td-goals__main-empty-text">
              写下一个值得奔赴的方向，用行卡一步步抵达
            </div>
            <button className="td-chip is-on" onClick={() => onOpenCreate()}>
              <Plus size={11} /> 立志
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ===== 右栏详情（门面化：hero + toolbar + 分区 sections；逻辑同旧版零改动）=====
type GoalDetailProps = {
  goal: TodoGoal;
  /** 所属分类名（hero kicker 眉线展示） */
  categoryName?: string;
  /** 右上角关闭：回志首页 */
  onClosed: () => void;
  onDeleted: () => void;
  /** 加行：唤起行卡创建弹窗（复用新建想法模式，创建即挂该志） */
  onOpenCreateTask: (goalId: string, goalTitle: string) => void;
  updateGoal: (id: string, patch: Partial<TodoGoal>) => void;
  completeGoal: (id: string) => void;
  deleteGoal: (id: string) => void;
  busyId: string | null;
  setBusyId: (v: string | null) => void;
  /** AI 评估（绑定目录时基于项目实况） */
  runAssess: (goalId: string) => Promise<void>;
  openTasks: string | null;
  setOpenTasks: (v: string | null) => void;
};

const GoalDetail: React.FC<GoalDetailProps> = ({
  goal,
  categoryName,
  onClosed,
  onDeleted,
  onOpenCreateTask,
  updateGoal,
  completeGoal,
  deleteGoal,
  runAssess,
  busyId,
  openTasks,
  setOpenTasks,
}) => {
  const data = useTodoStore((s) => s.data);
  const p = goalProgress(data, goal.id);
  const tasks = data.tasks.filter(t => t.goalId === goal.id);
  const tasksOpen = openTasks === goal.id;

  // ===== 统计（本地 ledger 按志过滤 + 专注时间 + 服务端费用均价）=====
  const [usage, setUsage] = useState<LocalUsage | null>(null);
  const [pricePerToken, setPricePerToken] = useState<number | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void queryLocalUsage(30)
      .then(u => {
        if (!cancelled) setUsage(u);
      })
      .catch(() => undefined);
    void fetchServerUsage(30).then(s => {
      if (cancelled || !s) return;
      const tokens = s.totals.promptTokens + s.totals.completionTokens;
      setPricePerToken(tokens > 0 && s.totals.credits > 0 ? s.totals.credits / tokens : null);
    });
    return () => {
      cancelled = true;
    };
  }, [goal.id]);

  // 该志的 AI 消耗（tag 后缀 :{goalId} 聚合：assess/draft/chat）
  const goalUsage = useMemo(() => {
    if (!usage) return { local: 0, remote: 0 };
    let local = 0;
    let remote = 0;
    for (const [tag, agg] of Object.entries(usage.byTag)) {
      if (tag.startsWith('todo:') && tag.endsWith(`:${goal.id}`)) {
        local += agg.localTokens;
        remote += agg.remoteTokens;
      }
    }
    return { local, remote };
  }, [usage, goal.id]);

  // 该志专注时间（7 日分布 + 合计；sessions 挂该志任务）
  const focus = useMemo(() => {
    const taskIds = new Set(tasks.map(t => t.id));
    const sessions = data.focusSessions.filter(s => s.taskId && taskIds.has(s.taskId));
    const totalMin = sessions.reduce((a, s) => a + s.minutes, 0);
    const now = new Date();
    const days: { date: string; value: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push({ date: key, value: 0 });
    }
    const dayMap = new Map(days.map(d => [d.date, d]));
    for (const s of sessions) {
      const d = new Date(s.startedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const bucket = dayMap.get(key);
      if (bucket) bucket.value += s.minutes;
    }
    return { totalMin, days };
  }, [data.focusSessions, tasks]);

  // 7 日 token 堆叠（该志 tag 过滤 + 按日分桶：由 byTag 拿不到按日明细，
  // 用全局 days × 志占比近似不可行——直接展示该志 tag 合计 + 全局 7 日趋势）
  const tokenDays = useMemo(() => {
    if (!usage) return [];
    return usage.days.slice(-7).map(d => ({ date: d.date, local: d.localTokens, remote: d.remoteTokens }));
  }, [usage]);

  const hasStats = focus.totalMin > 0 || goalUsage.local > 0 || goalUsage.remote > 0;

  return (
    <div className="td-goalpage" key={goal.id}>
      {/* ① hero：kicker 眉线 + 衬线大标 + why + 状态条/进度带 */}
      <div className="td-goalpage__hero">
        <div className="td-goalpage__kicker">
          志 · GOAL{categoryName ? ` ─ ${categoryName}` : ''}
        </div>
        <div className="td-goalpage__title-row">
          <span className="td-goalpage__emoji">
            <EmojiPicker value={goal.emoji} onPick={e => updateGoal(goal.id, { emoji: e })} title="设置志图标" />
          </span>
          <h1 className="td-goalpage__title">{goal.title}</h1>
          <button className="td-chip" onClick={onClosed} title="关闭详情，回志首页">
            <X size={11} />
          </button>
        </div>
        {goal.why && <div className="td-goalpage__why">{goal.why}</div>}
        <div className="td-goalpage__status">
          {goal.doneAt ? (
            <span className="td-goalpage__done-badge">已达成</span>
          ) : (
            <button
              className="td-chip is-on"
              onClick={() => completeGoal(goal.id)}
              disabled={p.done < p.total}
              title={
                p.done < p.total
                  ? `关联行卡尚有 ${p.total - p.done} 项未验收完成`
                  : '关联行卡已全部验收完成'
              }
            >
              达成
            </button>
          )}
          <span className="td-goalpage__count" title="验收进度（关联行卡已完成数/总数）">
            任务 ✓{p.done}/{p.total}
          </span>
        </div>
        {p.total > 0 && (
          <div className="td-goalpage__bar">
            <span
              className="td-goalpage__bar-fill"
              style={{ width: `${Math.round((p.done / p.total) * 100)}%` }}
            />
          </div>
        )}
      </div>

      {/* ② toolbar：项目目录 / AI 拟策 / 删志（删右对齐） */}
      <div className="td-goalpage__toolbar">
        <button
          className="td-chip"
          title={
            goal.workspaceDir
              ? `${goal.workspaceDir}——点击改绑项目目录`
              : '未绑定项目目录——点击选择（关联行卡委托 agent 的工作区）'
          }
          onClick={() => {
            void pickWorkspaceDir().then(dir => {
              if (dir) updateGoal(goal.id, { workspaceDir: dir });
            });
          }}
        >
          <FolderOpen size={11} />
          <span className="td-goalpage__dir">
            {goal.workspaceDir ? goal.workspaceDir : '绑定项目目录'}
          </span>
        </button>
        {goal.workspaceDir && (
          <button
            className="td-chip is-danger"
            title="解除目录绑定（行卡委托走全局默认工作区）"
            onClick={() => updateGoal(goal.id, { workspaceDir: undefined })}
          >
            解绑
          </button>
        )}
        <span className="td-goalpage__toolbar-spacer" />
        <button
          className="td-chip is-danger"
          onClick={() => {
            // 危险操作：弹窗确认防误删（志及其方案/里程碑一并移除）
            void confirmDanger(
              '删除志',
              `确定删除志「${goal.title}」吗？其方案、阶段与任务关联将一并移除，不可恢复。`,
            ).then(ok => {
              if (!ok) return;
              deleteGoal(goal.id);
              onDeleted();
            });
          }}
        >
          删志
        </button>
      </div>

      {/* ② 统计 STATS：图标化指标卡置顶（专注/token/费用）+ 近 7 日趋势 */}
      <section className="td-goalpage__section">
        <div className="td-goalpage__section-head is-static">
          <span className="td-goalpage__section-title">统计 STATS</span>
        </div>
        {hasStats ? (
          <div className="td-goalpage__section-body td-usage">
            <div className="td-usage__stats">
              <StatChip
                icon={<Timer size={11} />}
                label="专注时间"
                value={focus.totalMin >= 60 ? `${Math.floor(focus.totalMin / 60)}h${focus.totalMin % 60}m` : `${focus.totalMin}m`}
              />
              <StatChip
                icon={<Zap size={11} />}
                label="Token 消耗"
                value={fmtNum(goalUsage.local + goalUsage.remote)}
                sub={`本地 ${fmtNum(goalUsage.local)} · 远程 ${fmtNum(goalUsage.remote)}`}
              />
              <StatChip
                icon={<Coins size={11} />}
                label="费用"
                value={
                  goalUsage.remote > 0 && pricePerToken
                    ? `≈${fmtNum(Math.round(goalUsage.remote * pricePerToken))}`
                    : goalUsage.remote > 0
                      ? '—'
                      : '0'
                }
                sub={goalUsage.remote > 0 ? (pricePerToken ? 'credit · 按服务端均价估算' : '登录后可见费用估算') : '本地调用免费'}
              />
            </div>
            <div className="td-usage__charts">
              <div className="td-usage__chart-block">
                <span className="td-usage__chart-label">近 7 日专注（分钟）</span>
                <MiniBarChart data={focus.days} unit=" 分钟" />
              </div>
              <div className="td-usage__chart-block">
                <span className="td-usage__chart-label">近 7 日 AI 消耗（token · 全部业务）</span>
                <StackedTokenChart data={tokenDays} />
              </div>
            </div>
          </div>
        ) : (
          <div className="td-goalpage__section-body">
            <div className="td-sync-hint">暂无统计——评估/讨论/专注后累积</div>
          </div>
        )}
      </section>

      {/* ③ 评估 section：AI 结合项目实况（绑定目录时）的阶段评估报告 */}
      <section className="td-goalpage__section">
        <div className="td-goalpage__section-head">
          <span className="td-goalpage__section-title">评估 ASSESSMENT</span>
          <button
            className="td-chip"
            disabled={busyId === goal.id}
            onClick={() => void runAssess(goal.id)}
            title={goal.workspaceDir ? 'AI 读取项目目录（结构/README/git 记录）生成阶段评估' : 'AI 基于志向与任务进度评估；绑定项目目录可获得基于实况的深度评估'}
          >
            {busyId === goal.id ? '评估中…' : 'AI 评估'}
          </button>
        </div>
        {goal.assessment ? (
          <div className="td-goalpage__section-body">
            <div className="td-goalpage__assess-meta">
              <span className="td-goalpage__assess-time">{new Date(goal.assessment.at).toLocaleString('zh-CN')}</span>
              <span className="td-goalpage__assess-src">
                {goal.workspaceDir ? '基于项目实况' : '未绑定项目目录'}
              </span>
            </div>
            {goal.assessment.stage && (
              <p className="td-goalpage__assess-stage">{goal.assessment.stage}</p>
            )}
            {goal.assessment.highlights.length > 0 && (
              <div className="td-goalpage__assess-block">
                <span className="td-goalpage__assess-label">亮点</span>
                <ul className="td-goalpage__assess-list is-hi">
                  {goal.assessment.highlights.map((h, i) => <li key={i}>{h}</li>)}
                </ul>
              </div>
            )}
            {goal.assessment.gaps.length > 0 && (
              <div className="td-goalpage__assess-block">
                <span className="td-goalpage__assess-label">缺口</span>
                <ul className="td-goalpage__assess-list is-gap">
                  {goal.assessment.gaps.map((g2, i) => <li key={i}>{g2}</li>)}
                </ul>
              </div>
            )}
            {goal.assessment.advice && (
              <p className="td-goalpage__assess-advice">{goal.assessment.advice}</p>
            )}
          </div>
        ) : (
          <div className="td-goalpage__section-body">
            <div className="td-sync-hint">
              尚未评估——AI 将生成阶段/亮点/缺口/建议四段报告
              {!goal.workspaceDir && '；绑定项目目录后可结合代码实况深度评估'}
            </div>
          </div>
        )}
      </section>

      {/* ④ 阶段 section（里程碑） */}
      {goal.milestones.length > 0 && (
        <section className="td-goalpage__section">
          <div className="td-goalpage__section-head is-static">
            <span className="td-goalpage__section-title">阶段 MILESTONES</span>
          </div>
          <div className="td-goalpage__section-body">
            <div className="td-goalpage__chips">
              {goal.milestones.map(m => (
                <button
                  key={m.id}
                  className="td-chip"
                  title={m.done ? '已完成' : '未完成'}
                  onClick={() =>
                    updateGoal(goal.id, {
                      milestones: goal.milestones.map(x => (x.id === m.id ? { ...x, done: !x.done } : x)),
                    })
                  }
                >
                  {m.done ? <CircleCheck size={11} /> : <Circle size={11} />} {m.title.slice(0, 8)}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ⑤ 任务 section */}
      <section className="td-goalpage__section">
        <div className="td-goalpage__section-head">
          <button
            className="td-goalpage__section-toggle"
            onClick={() => setOpenTasks(tasksOpen ? null : goal.id)}
          >
            {tasksOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="td-goalpage__section-title">任务 TASKS</span>
            <span className="td-goalpage__section-count">{tasks.length}</span>
          </button>
          <button
            className="td-chip"
            onClick={() => onOpenCreateTask(goal.id, goal.title)}
            title="新建行卡并挂到本志（复用新建想法弹窗）"
          >
            <Plus size={11} /> 加行
          </button>
        </div>
        {tasksOpen && (
          <div className="td-goalpage__section-body">
            {tasks.length === 0 && <div className="td-sync-hint">尚无关联行卡——点「加行」新建</div>}
            {tasks
              .filter(t => !t.milestoneId)
              .map(t => (
                <TaskMiniRow key={t.id} title={t.title} done={!!t.completedAt} due={t.due} />
              ))}
            {goal.milestones.map(m => {
              const group = tasks.filter(t => t.milestoneId === m.id);
              if (!group.length) return null;
              const gDone = group.filter(t => t.completedAt).length;
              return (
                <div key={m.id} className="td-goalpage__task-group">
                  <div className="td-goalpage__task-group-head">
                    <span>
                      {m.done ? '●' : '○'} {m.title}
                    </span>
                    <span className="td-goalpage__task-group-count">{gDone}/{group.length}</span>
                  </div>
                  {group.map(t => (
                    <TaskMiniRow key={t.id} title={t.title} done={!!t.completedAt} due={t.due} />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </section>

    </div>
  );
};

const TaskMiniRow: React.FC<{ title: string; done: boolean; due: string | null }> = ({ title, done, due }) => {
  const label = due ? dueLabel(due) : null;
  return (
    <div className={`td-goalpage__task${done ? ' is-done' : ''}`}>
      <span className="td-goalpage__task-dot">{done ? '●' : '○'}</span>
      <span className="td-goalpage__task-title">{title}</span>
      {label && <span className={`td-due${label.overdue && !done ? ' is-overdue' : ''}`}>{label.text}</span>}
    </div>
  );
};
