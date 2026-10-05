/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * TodoPanel — 「策」看板（独立窗口形态）。
 *
 * 窗口由 `src/apps/desktop/src/window_registry.rs` 的 `todo` spec 承载
 * （900×640 / min 640×480 / 居中 / 原生边框），因此这里**不再自绘窗口装饰**：
 * 拖拽、8 向缩放、关闭按钮改由原生窗口提供——省掉一整套手写 chrome，也省掉
 * 浮层时代必须维护的 no-penetrate 穿透命中区。
 *
 * 布局：「行」= 三栏看板（需求卡/计划中/进行中）+ 下半区（计划文档 MD + 讨论对话）；
 * 恒（周期）/ 志（目标三级）/ 修行 / 足迹 视图维持原状。
 */
import React, { useMemo, useState } from 'react';
import { Settings, Palette } from 'lucide-react';
import { NavMarkAction, NavMarkHabit, NavMarkGoal, NavMarkGrow, NavMarkTrail } from './NavCharMarks';
import CreditsScene from '../../../app/scenes/credits/CreditsScene';
import { useTodoStore, countOfView, type TodoView } from '../store/todoStore';
import { useGrowthStore } from '../store/growthStore';
import { GrowthView } from './views/GrowthView';
import { GoalsView } from './views/GoalsView';
import { RoutineView } from './views/RoutineView';
import { RoutineComposer } from './views/RoutineComposer';
import { GoalComposer } from './views/GoalComposer';
import { BoardView } from './views/BoardView';
import { PlanChatPanel } from './views/PlanChatPanel';
import { PlanDocPanel } from './views/PlanDocPanel';
import { ExecChatPanel } from './views/ExecChatPanel';
import { TaskCreateModal } from './views/TaskCreateModal';
import { TraceView } from './views/TraceView';
import { SettingsView } from './views/SettingsView';
import { BeautyView } from './views/BeautyView';
import './TodoPanel.scss';
import './todo-theme.scss';
import './board.scss';

export const TodoPanel: React.FC = () => {
  const data = useTodoStore((s) => s.data);
  const view = useTodoStore((s) => s.view);
  const setView = useTodoStore((s) => s.setView);
  const expandedId = useTodoStore((s) => s.expandedId);

  const toast = useGrowthStore((s) => s.toast);

  /** 创建类弹窗（需求卡/恒/志——弹窗化创建，支持完整字段与 agent 参与方式） */
  const [createModal, setCreateModal] = useState<'task' | 'routine' | 'goal' | null>(null);
  /** 志视图「加行」入口预挂的志（id + 标题，传给 TaskCreateModal） */
  const [taskGoalSeed, setTaskGoalSeed] = useState<{ id: string; title: string } | null>(null);
  /** 立志时预选分类（志树分类行尾加号传入） */
  const [goalCategorySeed, setGoalCategorySeed] = useState<string | undefined>(undefined);

  // 看板选中卡片（下半区联动）；优先 expandedId 复用既有选中语义
  const boardSelectedId = view === 'today' ? expandedId : null;
  const selectedTask = useMemo(
    () => (boardSelectedId ? data.tasks.find((t) => t.id === boardSelectedId) ?? null : null),
    [data.tasks, boardSelectedId]
  );

  // 导航：单字印记（印章式圆框）+ 现代语短标题。笃行→恒常→志向→修行（志归恒下）。
  const navItems = useMemo(() => {
    const items: { view: TodoView; mark: React.FC<{ size?: number }>; label: string; title: string; count: number }[] = [
      { view: 'today', mark: NavMarkAction, label: '笃行', title: '笃行 · 想法看板与计划', count: countOfView(data, 'today') },
      { view: 'routine', mark: NavMarkHabit, label: '恒常', title: '恒常 · 周而复始之事', count: countOfView(data, 'routine') },
      { view: 'goal', mark: NavMarkGoal, label: '志向', title: '志向 · 远期方向与项目', count: countOfView(data, 'goal') },
      { view: 'growth', mark: NavMarkGrow, label: '修行', title: '修行 · 成长与回顾', count: 0 },
    ];
    return items;
  }, [data]);

  return (
    <div className="todo-panel todo-panel--window">
      <div className="todo-panel__body">
        <NavSidebar items={navItems} view={view} onSelect={setView} />
        <div className="todo-panel__main">
          {view === 'growth' && <GrowthView />}
          {view === 'goal' && (
            <GoalsView
              onOpenCreate={(categoryId?: string) => {
                setGoalCategorySeed(categoryId);
                setCreateModal('goal');
              }}
              onOpenCreateTask={(goalId, goalTitle) => {
                setTaskGoalSeed({ id: goalId, title: goalTitle });
                setCreateModal('task');
              }}
            />
          )}
          {view === 'routine' && <RoutineView onOpenCreate={() => setCreateModal('routine')} />}

          {/* 行 = 看板 + 细节区：选中卡联动下半区（讨论占想法池+计划中宽，
              计划文档占右列）。进行中卡（已委托）左列 = 执行过程对话（会话
              本体即讨论：实时流+干预+审批/提问应答）；其余卡 = 规划讨论。
              Fragment key 按卡重挂——模型/会话流等面板状态不跨卡串扰 */}
          {view === 'today' && (
            <BoardView
              selectedId={boardSelectedId}
              onSelect={id => useTodoStore.getState().setExpanded(id)}
              onOpenCreate={() => {
                setTaskGoalSeed(null);
                setCreateModal('task');
              }}
            >
              {selectedTask && (
                <React.Fragment key={selectedTask.id}>
                  {(selectedTask.status ?? 'requirement') === 'doing' && selectedTask.agentSessionId ? (
                    <>
                      <ExecChatPanel task={selectedTask} />
                      <PlanDocPanel task={selectedTask} />
                    </>
                  ) : (
                    <>
                      <PlanChatPanel task={selectedTask} />
                      <PlanDocPanel task={selectedTask} />
                    </>
                  )}
                </React.Fragment>
              )}
            </BoardView>
          )}

          {/* 迹 = 电脑使用足迹（usage_stats 同源；不展示完成任务列表） */}
          {view === 'done' && <TraceView />}

          {/* 设 = 系统设置（自 task 窗口迁移；竖列二级导航复用设置内容组件） */}
          {view === 'settings' && <SettingsView />}

          {/* 美 = 界面美化（主题外观/点击特效/智能桌面/桌面插件） */}
          {view === 'beauty' && <BeautyView />}

          {/* 积 = 积分中心（充值/会员/邀请有礼；标题栏积分徽标点击进入） */}
          {view === 'credits' && (
            <div className="todo-panel__credits-view">
              <CreditsScene />
            </div>
          )}
        </div>
      </div>

      {/* 创建类弹窗 */}
      {createModal === 'task' && (
        <TaskCreateModal
          close={() => {
            setCreateModal(null);
            setTaskGoalSeed(null);
          }}
          defaultGoalId={taskGoalSeed?.id}
          goalTitle={taskGoalSeed?.title}
        />
      )}
      {createModal === 'routine' && (
        <RoutineComposer close={() => setCreateModal(null)} />
      )}
      {createModal === 'goal' && (
        <GoalComposer
          close={() => {
            setCreateModal(null);
            setGoalCategorySeed(undefined);
          }}
          defaultCategoryId={goalCategorySeed}
        />
      )}

      {/* 本窗口内的操作反馈（XP 结算、验收结果等）。
          注意常驻提醒与看门狗类的提示在 overlay 窗口弹出——见 TodoWindowApp 注释。 */}
      {toast && (
        <div className="todo-panel__toast">
          <div className="todo-panel__toast-title">{toast.title}</div>
          {toast.sub && <div className="todo-panel__toast-sub">{toast.sub}</div>}
        </div>
      )}
    </div>
  );
};

// ===== Nav 侧栏（印章圆框印记 + 短标题 + 计数）=====
const NavSidebar: React.FC<{
  items: { view: TodoView; mark: React.FC<{ size?: number }>; label: string; title: string; count: number }[];
  view: TodoView;
  onSelect: (v: TodoView) => void;
}> = ({ items, view, onSelect }) => {
  return (
    <div className="todo-panel__nav">
      {items.map((item) => {
        const Mark = item.mark;
        return (
          <button
            key={item.view}
            className={`todo-panel__nav-item${view === item.view ? ' is-active' : ''}`}
            onClick={() => onSelect(item.view)}
            title={item.title}
          >
            <span className="todo-panel__nav-seal">
              <Mark size={15} />
            </span>
            <span className="todo-panel__nav-label">{item.label}</span>
            {item.count > 0 && <span className="todo-panel__nav-count">{item.count}</span>}
          </button>
        );
      })}
      {/* 美：界面美化（修行正下方，功能组末位；常规图标） */}
      <button
        className={`todo-panel__nav-item${view === 'beauty' ? ' is-active' : ''}`}
        onClick={() => onSelect('beauty')}
        title="美化 · 界面外观"
      >
        <span className="todo-panel__nav-seal">
          <Palette size={15} />
        </span>
        <span className="todo-panel__nav-label">美化</span>
      </button>
      <div className="todo-panel__nav-sep" />
      <button
        className={`todo-panel__nav-item${view === 'done' ? ' is-active' : ''}`}
        onClick={() => onSelect('done')}
        title="迹 · 电脑使用足迹"
      >
        <span className="todo-panel__nav-seal">
          <NavMarkTrail size={15} />
        </span>
        <span className="todo-panel__nav-label">足迹</span>
      </button>
      {/* 设：沉底固定在导航最下方（常规图标） */}
      <div className="todo-panel__nav-sep todo-panel__nav-sep--bottom" />
      <button
        className={`todo-panel__nav-item${view === 'settings' ? ' is-active' : ''}`}
        onClick={() => onSelect('settings')}
        title="设置 · 系统与模型"
      >
        <span className="todo-panel__nav-seal">
          <Settings size={15} />
        </span>
        <span className="todo-panel__nav-label">设置</span>
      </button>
    </div>
  );
};
