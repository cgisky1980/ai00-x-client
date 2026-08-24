/**
 * ThinkingPanel —— AI 思考面板（v0.15 AI 系）
 * ModelThinkingDisplay 降耦重制：折叠头双态（思考中呼吸/已完成+用时），
 * phase: thinking→done 变化时自动折叠；展开显示流式思考内容。
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
  className?: string;
}

const fmtDuration = (s?: number) => (s == null ? '' : `（${label('components.ai.duration', '用时')} ${s}s）`);

export const ThinkingPanel: React.FC<ThinkingPanelProps> = ({
  children,
  phase,
  duration,
  defaultOpen = false,
  className = '',
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const prevPhase = useRef(phase);

  // thinking→done 自动折叠（用户可手动重开）
  useEffect(() => {
    if (prevPhase.current === 'thinking' && phase === 'done') {
      setOpen(false);
    }
    prevPhase.current = phase;
  }, [phase]);

  const thinking = phase === 'thinking';
  return (
    <div className={['ai-thinking', thinking && 'is-thinking', open && 'is-open', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="ai-thinking__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ai-thinking__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="ai-thinking__label">
          {thinking
            ? label('components.ai.thinkingDeep', '正在深度思考…')
            : `${label('components.ai.thought', '已深度思考')}${fmtDuration(duration)}`}
        </span>
        <svg className="ai-thinking__chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ai-thinking__body">
          {children}
          {thinking && <span className="ai-thinking__cursor" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
};
