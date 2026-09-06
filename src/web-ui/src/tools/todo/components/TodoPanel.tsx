/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * TodoPanel — overlay 核心待办面板「策」（React 重写版，v3 大窗）。
 *
 * 浮窗 chrome：useDraggable + usePopupResize（初始 ~900×640 屏幕居中）；
 * 「行」= 三栏看板（想法池/计划中/进行中）+ 下半区（计划文档 MD + 讨论对话）；
 * 恒（周期）/ 志（目标三级）/ 修行 / 足迹 视图维持原状。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, GripVertical, Settings, Palette } from 'lucide-react';
import { NavMarkAction, NavMarkHabit, NavMarkGoal, NavMarkGrow, NavMarkTrail } from './NavCharMarks';
import { useDraggable } from '../../../infrastructure/overlay/useDraggable';
import { usePopupResize } from '../../island/hooks/usePopupResize';
import { CreditsBadge } from './CreditsBadge';
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
import { ExecutionPanel } from './views/ExecutionPanel';
import { TaskCreateModal } from './views/TaskCreateModal';
import { TraceView } from './views/TraceView';
import { SettingsView } from './views/SettingsView';
import { BeautyView } from './views/BeautyView';
import './TodoPanel.scss';
import './todo-theme.scss';
import './board.scss';

const PANEL_W = 900;
const PANEL_H = 640;
const PANEL_MIN_W = 640;
const PANEL_MIN_H = 480;

const GRIP_SVG = <GripVertical size={14} />;

export const TodoPanel: React.FC = () => {
  const panelOpen = useTodoStore((s) => s.panelOpen);
  const togglePanel = useTodoStore((s) => s.togglePanel);
  if (!panelOpen) return null;
  return <TodoPanelInner onClose={() => togglePanel(false)} />;
};

const TodoPanelInner: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const data = useTodoStore((s) => s.data);
  const view = useTodoStore((s) => s.view);
  const setView = useTodoStore((s) => s.setView);
  const expandedId = useTodoStore((s) => s.expandedId);

  const toast = useGrowthStore((s) => s.toast);

  // 初始屏幕居中（尺寸不超过视口）
  const initialW = Math.min(PANEL_W, window.innerWidth - 48);
  const initialH = Math.min(PANEL_H, window.innerHeight - 48);
  const { position, setPosition, elementRef, handleMouseDown, isDragging } = useDraggable({
    initialPosition: {
      x: Math.max(8, Math.round((window.innerWidth - initialW) / 2)),
      y: Math.max(8, Math.round((window.innerHeight - initialH) / 2)),
    },
    excludeSelector: 'button, input, textarea, select, .todo-panel__resize-handle, .td-check, [contenteditable]',
  });
  const { size, activeResize, handleResizeMouseDown } = usePopupResize({
    initialSize: { width: initialW, height: initialH },
    minWidth: PANEL_MIN_W,
    minHeight: PANEL_MIN_H,
    getPosition: useCallback(() => position, [position]),
    setPosition,
    elementRef,
  });

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
    <PanelShell
      position={position} size={size} elementRef={elementRef}
      isDragging={isDragging} activeResize={activeResize}
      handleMouseDown={handleMouseDown} handleResizeMouseDown={handleResizeMouseDown}
      onClose={onClose} toast={toast}
    >
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

          {/* 行 = 看板 + 细节区：想法池/计划中卡 = 讨论常驻+计划文档（讨论占
              想法池+计划中宽，计划全高占右列）；进行中卡 = 执行视图（结果导向：
              验收进度+计划+干预入口，过程不常驻——跨三列占下半） */}
          {view === 'today' && (
            <BoardView
              selectedId={boardSelectedId}
              onSelect={id => useTodoStore.getState().setExpanded(id)}
              onOpenCreate={() => {
                setTaskGoalSeed(null);
                setCreateModal('task');
              }}
              detailMode={
                selectedTask
                  ? (selectedTask.status ?? 'requirement') === 'doing'
                    ? 'exec'
                    : 'plan'
                  : null
              }
            >
              {selectedTask &&
                ((selectedTask.status ?? 'requirement') === 'doing' ? (
                  <ExecutionPanel task={selectedTask} />
                ) : (
                  <>
                    <PlanChatPanel task={selectedTask} />
                    <PlanDocPanel task={selectedTask} />
                  </>
                ))}
            </BoardView>
          )}

          {/* 迹 = 电脑使用足迹（usage_stats 同源；不展示完成任务列表） */}
          {view === 'done' && <TraceView />}

          {/* 设 = 系统设置（自 task 窗口迁移；竖列二级导航复用设置内容组件） */}
          {view === 'settings' && <SettingsView />}

          {/* 美 = 界面美化（主题外观/点击特效/智能桌面/桌面插件） */}
          {view === 'beauty' && <BeautyView />}
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
    </PanelShell>
  );
};

// ===== 浮窗外壳（拖动/缩放/头/toast/模态挂载点）=====
const PanelShell: React.FC<{
  position: { x: number; y: number };
  size: { width: number; height: number };
  elementRef: React.MutableRefObject<HTMLDivElement | null>;
  isDragging: boolean;
  activeResize: string | null;
  handleMouseDown: (e: React.MouseEvent) => void;
  handleResizeMouseDown: (dir: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw') => (e: React.MouseEvent) => void;
  onClose: () => void;
  toast: { id: number; title: string; sub?: string } | null;
  xpFloat?: { id: number; text: string } | null;
  children: React.ReactNode;
}> = ({ position, size, elementRef, isDragging, activeResize, handleMouseDown, handleResizeMouseDown, onClose, toast, xpFloat, children }) => {
  const profile = useGrowthStore((s) => s.profile);

  return createPortal(
    <div
      ref={elementRef}
      className={`todo-panel no-penetrate${isDragging ? ' is-dragging' : ''}${activeResize ? ' is-resizing' : ''}`}
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
    >
      {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const).map((dir) => (
        <div
          key={dir}
          className={`todo-panel__resize-handle todo-panel__resize-handle--${dir}`}
          onMouseDown={handleResizeMouseDown(dir)}
        />
      ))}

      <div className="todo-panel__header" onMouseDown={handleMouseDown}>
        <span className="todo-panel__grip">{GRIP_SVG}</span>
        <span className="todo-panel__title">策</span>
        <span className="todo-panel__spacer" />
        <span className="todo-panel__lv">Lv.{profile.level}</span>
        <span className="todo-panel__xpbar">
          <span
            className="todo-panel__xpfill"
            style={{ width: `${Math.min(100, Math.round((profile.into / Math.max(1, profile.need)) * 100))}%` }}
          />
        </span>
        <CreditsBadge />
        <button
          className="todo-panel__close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title="关闭"
        >
          <X size={16} />
        </button>
      </div>

      {children}

      {toast && (
        <div className="todo-panel__toast">
          <div className="todo-panel__toast-title">{toast.title}</div>
          {toast.sub && <div className="todo-panel__toast-sub">{toast.sub}</div>}
        </div>
      )}
      {xpFloat && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 60,
            transform: 'translateX(-50%)',
            fontFamily: 'var(--font-family-mono)',
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--color-accent)',
            pointerEvents: 'none',
            zIndex: 30,
            animation: 'todoXpFloat 0.8s ease forwards',
          }}
        >
          {xpFloat.text}
        </div>
      )}
    </div>,
    document.body
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
