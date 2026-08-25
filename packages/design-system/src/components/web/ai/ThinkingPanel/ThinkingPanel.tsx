/**
 * ThinkingPanel —— AI 思考面板（v0.15 AI 系）
 * ModelThinkingDisplay 降耦重制：折叠头双态（思考中呼吸/已完成+用时），
 * phase: thinking→done 变化时自动折叠（仅非受控）；展开显示流式思考内容。
 * v0.15.1：支持受控展开（open/onToggle）、自定义头部文案（label）、
 * 光标开关（cursor）；展开/折叠走 grid-template-rows 动画（body 常驻 DOM）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { label } from '../../../../lib/labels';
import './ThinkingPanel.scss';

export interface ThinkingPanelProps {
  children: React.ReactNode;
  phase: 'thinking' | 'done';
  /** 秒；done 态显示"用时 Ns" */
  duration?: number;
  defaultOpen?: boolean;
  /** 受控展开态；提供时接管内部状态（thinking→done 自动折叠仅在非受控时生效） */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** 覆盖折叠头默认双态文案 */
  label?: React.ReactNode;
  /** 流式光标（默认显示；children 为滚动容器等场景可关闭） */
  cursor?: boolean;
  className?: string;
}

const fmtDuration = (s?: number) => (s == null ? '' : `（${label('components.ai.duration', '用时')} ${s}s）`);

export const ThinkingPanel: React.FC<ThinkingPanelProps> = ({
  children,
  phase,
  duration,
  defaultOpen = false,
  open,
  onToggle,
  label: labelOverride,
  cursor = true,
  className = '',
}) => {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const prevPhase = useRef(phase);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;

  // thinking→done 自动折叠（仅非受控；用户可手动重开）
  useEffect(() => {
    if (!isControlled && prevPhase.current === 'thinking' && phase === 'done') {
      setInternalOpen(false);
    }
    prevPhase.current = phase;
  }, [phase, isControlled]);

  const handleClick = () => {
    const next = !isOpen;
    if (!isControlled) setInternalOpen(next);
    onToggle?.(next);
  };

  const thinking = phase === 'thinking';
  const headLabel = labelOverride ?? (thinking
    ? label('components.ai.thinkingDeep', '正在深度思考…')
    : `${label('components.ai.thought', '已深度思考')}${fmtDuration(duration)}`);

  return (
    <div className={['ai-thinking', thinking && 'is-thinking', isOpen && 'is-open', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="ai-thinking__head"
        aria-expanded={isOpen}
        onClick={handleClick}
      >
        <span className="ai-thinking__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="ai-thinking__label">
          {headLabel}
        </span>
        <svg className="ai-thinking__chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className={['ai-thinking__collapse', isOpen && 'ai-thinking__collapse--open'].filter(Boolean).join(' ')}>
        <div className="ai-thinking__body">
          <div className="ai-thinking__body-inner">
            {children}
            {thinking && cursor && <span className="ai-thinking__cursor" aria-hidden="true" />}
          </div>
        </div>
      </div>
    </div>
  );
};
