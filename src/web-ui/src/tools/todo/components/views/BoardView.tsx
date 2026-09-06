/**
 * BoardView — 策「行」三栏看板：想法池 / 计划中 / 进行中。
 *
 * 卡片生命周期：新建想法（栏头＋）→（点开讨论生成计划）→ 计划中 →
 * （交付 agent / 手动开始）→ 进行中 →（勾选完成）→ 足迹。
 * 拖拽跨栏即改 status；点卡片选中 → 下半区（计划/讨论）联动；
 * hover 卡片右上角「×」删除（有内容时确认防误删）。
 */
import React, { useMemo, useState } from 'react';
import { Bot, FileText, LoaderCircle, MessageSquare, Plus, Sparkles, X } from 'lucide-react';
import { useTheaterStore } from '@/app/components/AgentTheater/theaterStore';
import { useTodoStore, boardLane, boardLaneCount } from '../../store/todoStore';
import { getAgentModule } from '../../agent-modules';
import type { TaskStatus, TodoTask } from '../../api/types';

const LANES: Array<{ status: TaskStatus; label: string; hint: string }> = [
  { status: 'requirement', label: '想法池', hint: '想做的事，点右上＋落此' },
  { status: 'planning', label: '计划中', hint: '讨论已出计划' },
  { status: 'doing', label: '进行中', hint: '正在执行' },
];

/** 单张看板卡片。 */
const Card: React.FC<{
  task: TodoTask;
  selected: boolean;
  /** agent 会话运行态（TodoOverlay 30s 轮询） */
  running: boolean;
  onSelect: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDelete: () => void;
}> = ({ task, selected, running, onSelect, onDragStart, onDelete }) => {
  const module = getAgentModule(task.agentModule);
  const hasChat = !!task.chat?.length;
  const hasPlan = !!task.plan;
  // 验收进度徽标数据（缓存由细节区加载计划 MD 时解析回填；仅进行中卡显示）
  const acc = useTodoStore(s => s.planAcceptance[task.id]);
  const accDone = acc?.done ?? 0;
  const accTotal = acc?.total ?? 0;
  // agent 提问待处理（内嵌问题卡入口提示——accent 呼吸）
  const hasQuestion = useTodoStore(
    s => !!task.agentSessionId && (s.agentQuestions[task.agentSessionId]?.length ?? 0) > 0
  );
  // 最后一轮执行出错（TodoOverlay 轮询回填）
  const failed = useTodoStore(
    s => !!task.agentSessionId && (s.agentFailed[task.agentSessionId] ?? false)
  );
  // 有实质内容（计划/讨论/委托）时确认删除，防误删
  const handleDelete = () => {
    if (hasPlan || hasChat || task.agentSessionId) {
      if (!window.confirm(`删除「${task.title}」？其计划文档与讨论记录将一并丢弃。`)) return;
    }
    onDelete();
  };
  return (
    <div
      className={`td-card${selected ? ' is-selected' : ''}`}
      draggable
      onDragStart={onDragStart}
      onClick={onSelect}
      title={task.title}
    >
      <button
        className="td-card__del"
        onClick={e => {
          e.stopPropagation();
          handleDelete();
        }}
        title="删除此卡"
      >
        <X size={10} />
      </button>
      <div className="td-card__title">{task.title}</div>
      <div className="td-card__meta">
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
        {(task.status ?? 'requirement') === 'doing' && task.agentSessionId && !running && (
          <span
            className={`td-card__badge ${failed ? 'is-failed' : 'is-verify'}`}
            title={failed
              ? 'agent 最后一轮执行出错——点开卡片查看错误 / 重新规划'
              : 'agent 执行已结束——点开卡片验收（勾 DoD / 标记完成 / 重新规划）'}
          >
            {failed ? '执行出错' : '待验收'}
          </span>
        )}
        {(task.status ?? 'requirement') === 'doing' && accTotal > 0 && (
          <span
            className={`td-card__badge is-acceptance${accDone === accTotal ? ' is-passed' : ''}`}
            title={`验收进度 ${accDone}/${accTotal}${accDone === accTotal ? '（已全过，可标记完成）' : ''}`}
          >
            ✓{accDone}/{accTotal}
          </span>
        )}
      </div>
    </div>
  );
};

export const BoardView: React.FC<{
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenCreate: () => void;
  /** 细节区模式：plan=讨论+计划双区（进行中栏让位）；exec=执行视图（三栏保留，跨列占下半） */
  detailMode?: 'plan' | 'exec' | null;
  /** 细节区（讨论+计划）——有内容时看板压缩到上半、细节占下方（非空才渲染 children） */
  children?: React.ReactNode;
}> = ({ selectedId, onSelect, onOpenCreate, detailMode, children }) => {
  const data = useTodoStore((s) => s.data);
  const agentRunning = useTodoStore((s) => s.agentRunning);
  const updateTask = useTodoStore((s) => s.updateTask);
  const deleteTask = useTodoStore((s) => s.deleteTask);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  // 工作剧场开关（进行中栏头 ✨——与灵岛 Dock / dsh 场景侧栏同一状态）
  const theaterEnabled = useTheaterStore((st) => st.enabled);
  const setTheaterEnabled = useTheaterStore((st) => st.setEnabled);
  const toggleTheater = () => setTheaterEnabled(!theaterEnabled);

  const lanes = useMemo(
    () => LANES.map(l => ({ ...l, tasks: boardLane(data, l.status), count: boardLaneCount(data, l.status) })),
    [data]
  );

  const dropTo = (status: TaskStatus) => {
    if (dragId) updateTask(dragId, { status });
    setDragId(null);
    setDragOver(null);
  };

  const hasDetail = !!children;
  // 计划文档半高模式：进行中栏恢复显示，计划只占下半（全高=顶替到底）
  const planDocExpanded = useTodoStore((s) => s.planDocExpanded);

  return (
    <div
      className={`td-board${hasDetail ? ' has-detail' : ''}${detailMode === 'exec' ? ' is-exec' : ''}${detailMode === 'plan' && !planDocExpanded ? ' is-plandoc-half' : ''}`}
    >
      {lanes.map(lane => (
        <div
          key={lane.status}
          className={`td-board__lane${dragOver === lane.status ? ' is-over' : ''}`}
          onDragOver={e => {
            e.preventDefault();
            setDragOver(lane.status);
          }}
          onDragLeave={() => setDragOver(prev => (prev === lane.status ? null : prev))}
          onDrop={e => {
            e.preventDefault();
            dropTo(lane.status);
          }}
        >
          <div className="td-board__lane-head">
            <span className="td-board__lane-title">{lane.label}</span>
            <span className="td-board__lane-count">{lane.count}</span>
            {lane.status === 'doing' && (
              <button
                className={`td-board__lane-theater${theaterEnabled ? ' is-on' : ''}`}
                onClick={toggleTheater}
                title={theaterEnabled ? '工作剧场 · 开（工灵悬浮窗）' : '工作剧场 · 关'}
              >
                <Sparkles size={11} />
              </button>
            )}
            {lane.status === 'requirement' && (
              <button
                className="td-board__lane-add"
                onClick={onOpenCreate}
                title="新建想法（说明 / 执行方式 / 截止提醒）"
              >
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
            <span>想法池 落想法</span>
            <i>→</i>
            <span>讨论 出计划</span>
            <i>→</i>
            <span>交付 agent 执行</span>
          </div>
        </div>
      )}
    </div>
  );
};
