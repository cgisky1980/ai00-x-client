/**
 * TodoPanel — overlay 核心待办面板「策」（React 重写版）。
 *
 * 浮窗 chrome：useDraggable + usePopupResize（与 MusicPopup/SfxPopup 同套）；
 * 数据：todoStore（本地任务）+ growthStore（服务器 XP）；
 * 视图：即刻（当天到期+今日新增，立刻去做）/ 周期（重复之事）/ 志（目标→方案→任务三级）
 *      / 修行（成长中心）/ 已完成；
 * 创建：捕获行在列表底部（日期/! 语法）+ 细谈模态（ConsultModal）。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, GripVertical, Sparkles } from 'lucide-react';
import { NavMarkNow, NavMarkHabit, NavMarkGoal, NavMarkGrow, NavMarkTrail } from './NavCharMarks';
import { useDraggable } from '../../../infrastructure/overlay/useDraggable';
import { usePopupResize } from '../../island/hooks/usePopupResize';
import { useTodoStore, todayStr, parseCnDate, parseCaptureMeta, countOfView, tasksOfView, type TodoView } from '../store/todoStore';
import { useGrowthStore } from '../store/growthStore';
import { XpKinds } from '../api/types';
import { useConsult } from '../hooks/useConsult';
import { ConsultModal } from './views/ConsultModal';
import { GrowthView } from './views/GrowthView';
import { GoalsView } from './views/GoalsView';
import { RoutineView } from './views/RoutineView';
import { RoutineComposer } from './views/RoutineComposer';
import { GoalComposer } from './views/GoalComposer';
import { TaskRow, TaskDetailPane } from './TaskRow';
import './TodoPanel.scss';
import './todo-theme.scss';

const PANEL_W = 340;
const PANEL_H = 480;
const PANEL_MIN_W = 300;
const PANEL_MIN_H = 380;

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
  const addTask = useTodoStore((s) => s.addTask);

  const toast = useGrowthStore((s) => s.toast);
  const addXp = useGrowthStore((s) => s.addXp);
  const markDayCheck = useGrowthStore((s) => s.markDayCheck);
  const checkBadges = useGrowthStore((s) => s.checkBadges);

  const { position, setPosition, elementRef, handleMouseDown, isDragging } = useDraggable({
    initialPosition: { x: Math.max(8, window.innerWidth - PANEL_W - 24), y: 72 },
    excludeSelector: 'button, input, textarea, select, .todo-panel__resize-handle, .td-check, [contenteditable]',
  });
  const { size, activeResize, handleResizeMouseDown } = usePopupResize({
    initialSize: { width: PANEL_W, height: PANEL_H },
    minWidth: PANEL_MIN_W,
    minHeight: PANEL_MIN_H,
    getPosition: useCallback(() => position, [position]),
    setPosition,
    elementRef,
  });

  const consult = useConsult();
  const [xpFloat, setXpFloat] = useState<{ id: number; text: string } | null>(null);
  const floatIdRef = useRef(0);

  /** 任务完成：XP + 打卡 + 勋章（+XP 浮字由勾选处触发）。 */
  const awardTask = useCallback(
    (taskId: string, title: string, xp: number) => {
      const id = ++floatIdRef.current;
      setXpFloat({ id, text: `+${xp} XP` });
      setTimeout(() => setXpFloat((f) => (f?.id === id ? null : f)), 900);
      void addXp(XpKinds.taskDone, xp, { taskId, title });
      void markDayCheck();
      void checkBadges();
    },
    [addXp, markDayCheck, checkBadges]
  );

  // 导航：单字印记（印章式圆框）+ 现代语短标题（i18n 时标题走翻译、印记不变）。
  // 用字：即=即刻 / 恒=恒常（避「周」与星期撞义）/ 志=志向 / 修=修行 / 迹=足迹。
  const navItems = useMemo(() => {
    const items: { view: TodoView; mark: React.FC<{ size?: number }>; label: string; title: string; count: number }[] = [
      { view: 'today', mark: NavMarkNow, label: '即刻', title: '即刻 · 立刻去做', count: countOfView(data, 'today') },
      { view: 'routine', mark: NavMarkHabit, label: '恒常', title: '恒常 · 周而复始之事', count: countOfView(data, 'routine') },
      { view: 'goal', mark: NavMarkGoal, label: '志向', title: '志向 · 目标与方略', count: countOfView(data, 'goal') },
      { view: 'growth', mark: NavMarkGrow, label: '修行', title: '修行 · 成长与回顾', count: 0 },
    ];
    return items;
  }, [data]);

  const tasks = useMemo(() => tasksOfView(data, view), [data, view]);

  const submitCapture = () => {
    const input = document.querySelector<HTMLInputElement>('.todo-panel__capture input');
    const text = input?.value.trim();
    if (!text || !input) return;
    input.value = '';
    const meta = parseCaptureMeta(text);
    const { due, rest } = parseCnDate(meta.rest);
    addTask(rest || text, { due, flag: meta.flag });
  };

  return (
    <PanelShell
      position={position} size={size} elementRef={elementRef}
      isDragging={isDragging} activeResize={activeResize}
      handleMouseDown={handleMouseDown} handleResizeMouseDown={handleResizeMouseDown}
      onClose={onClose} toast={toast} xpFloat={xpFloat}
    >
      <div className="todo-panel__body">
        <NavSidebar items={navItems} view={view} onSelect={setView} />
        <div className="todo-panel__list">
          {view === 'growth' && <GrowthView />}
          {view === 'goal' && <GoalsView />}
          {view === 'routine' && <RoutineView />}
          {(view === 'today' || view === 'done') && (
            <>
              {/* 左栏：任务列表 */}
              <div className="todo-panel__tasks">
                {view === 'today' && <TodayOverview />}
                {tasks.length === 0 ? (
                  <div className="todo-panel__empty">
                    {view === 'today' && '此刻无事——记一笔，或细谈立策'}
                    {view === 'done' && '还没有完成之事'}
                  </div>
                ) : (
                  tasks.map((task) => <TaskRow key={task.id} task={task} onAward={awardTask} />)
                )}
              </div>
              {/* 右栏：选中任务的详情（点击任务行展开） */}
              {(() => {
                const sel = tasks.find((t) => t.id === expandedId);
                return sel ? (
                  <div className="todo-panel__detail">
                    <TaskDetailPane task={sel} />
                  </div>
                ) : null;
              })()}
            </>
          )}
        </div>
      </div>

      {/* 底部固定创建区：所有视图的添加入口统一沉到面板最底（不随列表滚动） */}
      {view === 'today' && (
        <div className="todo-panel__footer">
          <div className="todo-panel__capture" style={{ padding: 0, margin: 0, border: 'none' }}>
            <input
              placeholder="记一笔，回车即录 · 支持「明天」「周五」"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitCapture();
              }}
            />
            <button
              className="td-chip"
              title="细谈式创建：AI 追问细节，生成任务草稿"
              onClick={() => consult.open(document.querySelector<HTMLInputElement>('.todo-panel__footer input')?.value || '')}
            >
              <Sparkles size={11} /> 细谈
            </button>
          </div>
        </div>
      )}
      {view === 'routine' && (
        <div className="todo-panel__footer">
          <RoutineComposer />
        </div>
      )}
      {view === 'goal' && (
        <div className="todo-panel__footer">
          <GoalComposer />
        </div>
      )}

      {consult.state.open && (
        <ConsultModal
          state={consult.state}
          answer={consult.answer}
          skip={consult.skip}
          close={consult.close}
          adopt={consult.adopt}
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
  const doneCount = useTodoStore((s) => countOfView(s.data, 'done'));
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
      <div className="todo-panel__nav-sep" />
      <button
        className={`todo-panel__nav-item${view === 'done' ? ' is-active' : ''}`}
        onClick={() => onSelect('done')}
        title="足迹 · 已成之事"
      >
        <span className="todo-panel__nav-seal">
          <NavMarkTrail size={15} />
        </span>
        <span className="todo-panel__nav-label">足迹</span>
        {doneCount > 0 && <span className="todo-panel__nav-count">{doneCount}</span>}
      </button>
    </div>
  );
};

// ===== 今日概览条 =====
const TodayOverview: React.FC = () => {
  const data = useTodoStore((s) => s.data);
  const profile = useGrowthStore((s) => s.profile);
  const today = todayStr();
  const dueTasks = data.tasks.filter((t) => !t.completedAt && t.due && t.due <= today);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const doneToday = data.tasks.filter((t) => t.completedAt && t.completedAt >= dayStart.getTime()).length;
  const focusToday = data.focusSessions
    .filter((s) => s.startedAt >= dayStart.getTime())
    .reduce((a, s) => a + s.minutes, 0);

  return (
    <div className="todo-panel__overview">
      <span style={{ color: 'var(--color-success)' }}>✓ {doneToday}/{doneToday + dueTasks.length}</span>
      <span style={{ color: 'var(--color-accent)' }}>⏱ {focusToday}m</span>
      <span style={{ color: 'var(--color-warning)' }}>🔥 {profile.streak}</span>
    </div>
  );
};
