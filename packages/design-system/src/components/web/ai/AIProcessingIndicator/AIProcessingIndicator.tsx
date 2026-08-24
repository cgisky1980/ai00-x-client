/**
 * AIProcessingIndicator —— AI 处理中指示（v0.15 AI 系）
 * 三点波浪呼吸 + 文案；visible=false 时完全卸载。
 */
import React from 'react';
import { label } from '../../../../lib/labels';
import './AIProcessingIndicator.scss';

export interface AIProcessingIndicatorProps {
  visible: boolean;
  /** 默认「正在思考…」 */
  text?: string;
  className?: string;
}

export const AIProcessingIndicator: React.FC<AIProcessingIndicatorProps> = ({
  visible,
  text,
  className = '',
}) => {
  if (!visible) return null;
  const content = text ?? label('components.ai.thinking', '正在思考…');
  return (
    <div className={['ai-processing', className].filter(Boolean).join(' ')} role="status" aria-live="polite">
      <span className="ai-processing__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="ai-processing__text">{content}</span>
    </div>
  );
};
