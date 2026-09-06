// ========================================================================
// AgentImp：单个工灵的渲染（状态动画 + 气泡），AgentCard 唯一详情入口
// ========================================================================

import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { ImpRuntimeState } from './theaterTypes';
import { APPEAR_EMOJI, BUBBLE_EMOJI, TOOL_ACTION_LABELS } from './theaterCopy';
import { ImpVisual } from './ImpVisual';

interface AgentImpProps {
  state: ImpRuntimeState;
  focused: boolean;
  /** 单击/双击：打开会话对话浮层（可发消息干预） */
  onOpenChat: (sessionId: string, taskLabel: string) => void;
  /** 手动关闭（待验收/警示驻留态的 ✕；验收完成也会自动离场） */
  onDismiss: (sessionId: string) => void;
}

function pickEmoji(pool: string[], sessionId: string, phase: string): string {
  // 以 sessionId+phase 哈希选一个，避免每次渲染随机跳动
  let h = 0;
  const key = `${sessionId}:${phase}`;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return pool[Math.abs(h) % pool.length];
}

function bubbleFor(state: ImpRuntimeState): string | null {
  switch (state.phase) {
    case 'appear':
      return pickEmoji(APPEAR_EMOJI, state.sessionId, 'appear');
    case 'trouble':
      return pickEmoji(BUBBLE_EMOJI.trouble, state.sessionId, 'trouble');
    case 'thinking':
      return pickEmoji(BUBBLE_EMOJI.thinking, state.sessionId, 'thinking');
    case 'milestone':
      return pickEmoji(BUBBLE_EMOJI.milestone, state.sessionId, 'milestone');
    case 'deliver-big':
      return pickEmoji(BUBBLE_EMOJI['deliver-big'], state.sessionId, 'deliver-big');
    case 'alert':
      return pickEmoji(['❌', '🚨'], state.sessionId, 'alert');
    case 'acceptance':
      return '📋';
    default:
      return null; // working/leaving：零气泡（设计 §3.3）
  }
}

export const AgentImp: React.FC<AgentImpProps> = ({ state, focused, onOpenChat, onDismiss }) => {
  const { t } = useTranslation('agentTheater');
  const bubble = bubbleFor(state);

  // 实时标签：反映 agent 此刻在干什么（会话标题退为 tooltip）
  const toolLabel = state.lastToolName
    ? (TOOL_ACTION_LABELS[state.lastToolName] ?? state.lastToolName)
    : null;
  let label: string;
  let labelMono = false;
  switch (state.phase) {
    case 'acceptance': label = t('live.acceptance'); break;
    case 'alert': label = t('live.alert'); break;
    case 'thinking': label = t('live.thinking'); break;
    case 'working':
    case 'trouble':
    case 'milestone':
      if (toolLabel) { label = toolLabel; labelMono = TOOL_ACTION_LABELS[state.lastToolName ?? ''] === undefined; }
      else { label = state.taskLabel || t('live.idle_tool') || state.taskLabel; }
      break;
    default:
      label = state.taskLabel;
  }
  // 点击位移阈值：拖拽起手（useDraggable 无阈值，1px 抖动也会移动浮层）会吞掉
  // click 事件——用 mousedown/mouseup 屏幕距离 <5px 判定"原地点击"再开状态卡
  const downPos = useRef<{ x: number; y: number } | null>(null);
  const handleUp = (e: React.MouseEvent): void => {
    const d = downPos.current;
    downPos.current = null;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) {
      onOpenChat(state.sessionId, state.taskLabel);
    }
  };
  return (
    <button
      type="button"
      className={`ai00-agent-imp ai00-agent-imp--${state.phase} ai00-agent-imp--i${state.intensity}${
        focused ? ' is-focused' : ''
      }`}
      onMouseDown={e => {
        downPos.current = { x: e.clientX, y: e.clientY };
      }}
      onMouseUp={handleUp}
      onDoubleClick={() => onOpenChat(state.sessionId, state.taskLabel)}
      title={`${state.taskLabel}（点击：打开对话）`}
    >
      {bubble && <span className="ai00-agent-imp__bubble">{bubble}</span>}
      <span className="ai00-agent-imp__avatar">
        <ImpVisual sessionId={state.sessionId} category={state.category} size={30} />
      </span>
      <span className={`ai00-agent-imp__label${labelMono ? ' ai00-agent-imp__label--mono' : ''}`}>{label}</span>
      {(state.phase === 'acceptance' || state.phase === 'alert') && (
        <span
          role="button"
          tabIndex={0}
          className="ai00-agent-imp__dismiss"
          title="关闭此工灵"
          onMouseDown={e => e.stopPropagation()}
          onClick={e => {
            e.stopPropagation();
            onDismiss(state.sessionId);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.stopPropagation();
              onDismiss(state.sessionId);
            }
          }}
        >
          <X size={10} />
        </span>
      )}
    </button>
  );
};
