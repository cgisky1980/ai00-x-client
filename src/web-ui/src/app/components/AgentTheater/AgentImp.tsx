// ========================================================================
// AgentImp：单个工灵的渲染（状态动画 + 气泡），AgentCard 唯一详情入口
// ========================================================================

import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { ImpRuntimeState } from './theaterTypes';
import { APPEAR_EMOJI, BUBBLE_EMOJI, THEATER_LINES, TOOL_ACTION_LABELS, pickFrom } from './theaterCopy';
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
  return pickFrom(pool, sessionId, phase);
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

  // 工具动作并入 tooltip（信息保留）；实时标签改剧场台词池——
  // 以 sessionId+phase 哈希稳定选取，同会话同状态不跳动
  const toolLabel = state.lastToolName
    ? (TOOL_ACTION_LABELS[state.lastToolName] ?? state.lastToolName)
    : null;
  let label: string;
  switch (state.phase) {
    case 'acceptance':
      label = pickFrom(THEATER_LINES.acceptance, state.sessionId, 'acceptance');
      break;
    case 'alert':
      label = t('live.alert');
      break;
    case 'thinking':
      label = pickFrom(THEATER_LINES.thinking, state.sessionId, 'thinking');
      break;
    case 'working':
    case 'trouble':
    case 'milestone':
    case 'deliver-big':
      label = pickFrom(THEATER_LINES[state.phase], state.sessionId, state.phase);
      break;
    default:
      label = state.taskLabel;
  }
  const tooltipTitle = [
    state.taskLabel,
    toolLabel,
    '（点击：打开对话）',
  ]
    .filter(Boolean)
    .join(' · ');
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
      title={tooltipTitle}
    >
      {bubble && <span className="ai00-agent-imp__bubble">{bubble}</span>}
      <span className="ai00-agent-imp__avatar">
        <ImpVisual sessionId={state.sessionId} category={state.category} size={30} />
      </span>
      <span className="ai00-agent-imp__label">{label}</span>
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
