/**
 * BoardView — 策「行」三栏看板：想法·计划（合并，颜色区分）/ 进行中 / 已完成。
 *
 * 卡片生命周期：新建想法（栏头＋落卡）→（点开讨论生成计划，黛青点）→
 * （交付 agent / 手动开始）→ 进行中（中间栏）→（人类验收）→ 已完成（右栏收集）。
 * 合并栏内拖拽不改状态；拖到进行中 = 开始执行；拖回合并栏 = 回流计划中。
 * 点卡片选中 → 下半区（讨论/执行 + 计划）联动；hover 右上「×」删除（防误删确认）。
 */
import React, { useMemo, useState } from 'react';
import { Bot, FileText, LoaderCircle, MessageSquare, Plus, Sparkles, X } from 'lucide-react';
import { useTheaterStore } from '@/app/components/AgentTheater/theaterStore';
import { useTodoStore } from '../../store/todoStore';
import { getAgentModule } from '../../agent-modules';
import type { TodoTask } from '../../api/types';

/** 看板栏定义：想法·计划合并栏（颜色区分状态）/ 进行中 / 已完成（只读收集）。 */
const LANES: Array<{
  key: 'idea-plan' | 'doing' | 'done';
  label: string;
  hint: string;
  /** 该栏包含的看板状态（done 栏只读收集，不绑定状态） */
  statuses: Array<'requirement' | 'planning' | 'doing'>;
  readOnly?: boolean;
}> = [
  {
    key: 'idea-plan',
    label: '想法 · 计划',
    hint: '想做的事，点右上＋落此（灰点=想法 · 青点=计划中）',
    statuses: ['requirement', 'planning'],
  },
  { key: 'doing', label: '进行中', hint: '正在执行', statuses: ['doing'] },
  { key: 'done', label: '已完成', hint: '人类验收通过的任务（最近 50 张）', statuses: [], readOnly: true },
];

/** 单张看板卡片。 */
const Card: React.FC<{
  task: TodoTask;
  selected: boolean;
  running: boolean;
  onSelect: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDelete: () => void;
}> = ({ task, selected, running, onSelect, onDragStart, onDelete }) => {
  const module = getAgentModule(task.agentModule);
  const hasChat = !!task.chat?.length;
  const hasPlan = !!task.plan;
  const isDone = !!task.completedAt;
  const isPlanning = (task.status ?? 'requirement') === 'planning';
  // 验收进度徽标数据（缓存由细节区加载计划 MD 时解析回填；仅进行中卡显示）
  const acc = useTodoStore(s => s.planAcceptance[task.id]);
  const accDone = acc?.done ?? 0;
  const accTotal = acc?.total ?? 0;
  // 步骤进度（真源=计划 MD「## 步骤」勾选态；PlanDocPanel 解析回填）
  const steps = useTodoStore(s => s.planSteps[task.id]);
  // agent 提问待处理（内嵌问题卡入口提示——accent 呼吸）
  const hasQuestion = useTodoStore(
    s => !isDone && !!task.agentSessionId && (s.agentQuestions[task.agentSessionId]?.length ?? 0) > 0
  );
  // 最后一轮执行出错（TodoOverlay 轮询回填）
  const failed = useTodoStore(
    s => !isDone && !!task.agentSessionId && (s.agentFailed[task.agentSessionId] ?? false)
  );
  // 有实质内容（计划/讨论/委托）时确认删除，防误删（应用内弹窗，禁原生）
  const handleDelete = async () => {
    if (hasPlan || hasChat || task.agentSessionId) {
      if (!(await window.confirm(`删除「${task.title}」？其计划文档与讨论记录将一并丢弃。`))) return;
    }
    onDelete();
  };
  const isDoing = (task.status ?? 'requirement') === 'doing';
  return (
    <div
      className={`td-card${selected ? ' is-selected' : ''}${isDone ? ' is-done' : ''}`}
      draggable={!isDone}
      onDragStart={onDragStart}
      onClick={onSelect}
      title={task.title}
    >
      <button
        className="td-card__del"
        onClick={e => {
          e.stopPropagation();
          void handleDelete();
        }}
        title="删除此卡"
      >
        <X size={10} />
      </button>
      <div className="td-card__titlerow">
        <span
          className={`td-card__dot${isDone ? ' is-done' : isPlanning ? ' is-planning' : ''}`}
          title={isDone ? '已完成' : isPlanning ? '计划中' : '想法'}
        />
        <div className="td-card__title">{task.title}</div>
      </div>
      <div className="td-card__meta">
        {isDone ? (
          <span className="td-card__badge is-acceptance is-passed" title="人类验收通过时间">
            ✓ {new Date(task.completedAt as number).toLocaleDateString()}
          </span>
        ) : (
          <>
            {running && (
              <span className="td-card__badge is-running" title="agent 正在执行">
                <LoaderCircle size={10} className="td-spin" />
                执行中
              </span>
            )}
            {module && (
              <span className="td-card__badge is-agent" title={`${module.title} agent`}>
                <Bot size={10} />
                {module.title}
              </span>
            )}
            {hasChat && (
              <span className="td-card__badge" title="有讨论记录">
                <MessageSquare size={10} />
              </span>
            )}
            {hasPlan && (
              <span className="td-card__badge" title="已生成计划">
                <FileText size={10} />
              </span>
            )}
            {task.repeat && <span className="td-card__badge">恒</span>}
            {task.flag && <span className="td-card__badge is-flag">⚑</span>}
            {hasQuestion && (
              <span className="td-card__badge is-question" title="agent 正在提问——点开卡片作答">
                问
              </span>
            )}
            {isDoing && failed && (
              <span className="td-card__badge is-failed" title="agent 最后一轮执行出错——点开卡片处理 / 重新规划">
                执行出错
              </span>
            )}
            {isDoing && !failed && task.agentCompletedAt && (
              <span
                className="td-card__badge is-verify"
                title="模型已自检——等待人类验收（验收通过才算完成）"
              >
                待验收
              </span>
            )}
            {isDoing && steps && steps.total > 0 && (
              <span
                className={`td-card__badge is-acceptance${steps.done === steps.total ? ' is-passed' : ''}`}
                title={steps.current ? `当前：${steps.current}` : '步骤全部完成'}
              >
                ▶{steps.done}/{steps.total}
              </span>
            )}
            {isDoing && accTotal > 0 && (
              <span
                className={`td-card__badge is-acceptance${accDone === accTotal ? ' is-passed' : ''}`}
                title={`验收进度 ${accDone}/${accTotal}${accDone === accTotal ? '（已全过，可标记完成）' : ''}`}
              >
                ✓{accDone}/{accTotal}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export const BoardView: React.FC<{
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenCreate: () => void;
  /** 细节区（讨论/执行 + 计划）——有内容时看板压缩到上半、细节占下方（非空才渲染 children） */
  children?: React.ReactNode;
}> = ({ selectedId, onSelect, onOpenCreate, children }) => {
  const data = useTodoStore((s) => s.data);
  const agentRunning = useTodoStore((s) => s.agentRunning);
  const updateTask = useTodoStore((s) => s.updateTask);
  const deleteTask = useTodoStore((s) => s.deleteTask);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  // 工作剧场开关（进行中栏头 ✨——与灵岛 Dock / dsh 场景侧栏同一状态）
  const theaterEnabled = useTheaterStore((st) => st.enabled);
  const setTheaterEnabled = useTheaterStore((st) => st.setEnabled);
  const toggleTheater = () => setTheaterEnabled(!theaterEnabled);

  const lanes = useMemo(
    () =>
      LANES.map((lane) => {
        if (lane.key === 'idea-plan') {
          // 合并栏：想法（requirement）+ 计划中（planning），颜色点区分
          const tasks = data.tasks.filter(
            (t) => !t.completedAt && ((t.status ?? 'requirement') === 'requirement' || t.status === 'planning'),
          );
          return { ...lane, tasks, count: tasks.length };
        }
        if (lane.key === 'doing') {
          const tasks = data.tasks.filter((t) => !t.completedAt && (t.status ?? 'requirement') === 'doing');
          return { ...lane, tasks, count: tasks.length };
        }
        // 已完成：全部 completedAt 任务，新完成的在前；栏内只渲染最近 50 张
        const done = data.tasks
          .filter((t) => t.completedAt)
          .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
        return { ...lane, tasks: done.slice(0, 50), count: done.length };
      }),
    [data]
  );

  const dropTo = (lane: (typeof lanes)[number]) => {
    if (dragId && !lane.readOnly) {
      const t = data.tasks.find((x) => x.id === dragId);
      const cur = (t?.status ?? 'requirement') as 'requirement' | 'planning' | 'doing';
      // 栏内拖拽不改状态；跨栏落点取该栏末位状态（合并栏回流 = 回到计划中）
      if (!lane.statuses.includes(cur)) {
        updateTask(dragId, { status: lane.statuses[lane.statuses.length - 1] });
      }
    }
    setDragId(null);
    setDragOver(null);
  };

  const hasDetail = !!children;

  return (
    <div className={`td-board${hasDetail ? ' has-detail' : ''}`}>
      {lanes.map(lane => (
        <div
          key={lane.key}
          className={`td-board__lane${dragOver === lane.key && !lane.readOnly ? ' is-over' : ''}`}
          onDragOver={e => {
            if (lane.readOnly) return;
            e.preventDefault();
            setDragOver(lane.key);
          }}
          onDragLeave={() => setDragOver(prev => (prev === lane.key ? null : prev))}
          onDrop={e => {
            e.preventDefault();
            dropTo(lane);
          }}
        >
          <div className="td-board__lane-head">
            <span className="td-board__lane-title">{lane.label}</span>
            <span className="td-board__lane-count">{lane.count}</span>
            {lane.key === 'doing' && (
              <button
                className={`td-board__lane-theater${theaterEnabled ? ' is-on' : ''}`}
                onClick={toggleTheater}
                title={theaterEnabled ? '工作剧场 · 开（工灵悬浮窗）' : '工作剧场 · 关'}
              >
                <Sparkles size={11} />
              </button>
            )}
            {lane.key === 'idea-plan' && (
              <button className="td-board__lane-add" onClick={onOpenCreate} title="新建想法（说明 / 执行方式 / 截止提醒）">
                <Plus size={11} />
              </button>
            )}
          </div>
          <div className="td-board__lane-body">
            {lane.tasks.length === 0 && <div className="td-board__lane-empty">{lane.hint}</div>}
            {lane.tasks.map(t => (
              <Card
                key={t.id}
                task={t}
                selected={t.id === selectedId}
                running={!!(t.agentSessionId && agentRunning[t.agentSessionId])}
                onSelect={() => onSelect(t.id)}
                onDragStart={() => setDragId(t.id)}
                onDelete={() => deleteTask(t.id)}
              />
            ))}
          </div>
        </div>
      ))}
      {hasDetail ? (
        children
      ) : (
        // 未选中：下半区为看板使用说明（白为息——不撑满，留白呼吸）
        <div className="td-board__guide">
          <div className="td-board__guide-title">谋而后动</div>
          <div className="td-board__guide-text">
            点选一张想法卡——下方与 AI 讨论澄清需求，右侧生成可交付的计划文档
          </div>
          <div className="td-board__guide-steps">
            <span>想法 落卡</span>
            <i>→</i>
            <span>讨论 出计划</span>
            <i>→</i>
            <span>执行 · 人类验收</span>
          </div>
        </div>
      )}
    </div>
  );
};
