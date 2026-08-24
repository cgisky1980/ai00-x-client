/**
 * StreamingText —— AI 流式文本（v0.15 AI 系）
 * 数据驱动增量（消费方 append），组件只负责渲染 + streaming 末尾光标 blink。
 * 光标动画 reduced-motion 退化为静态竖线。
 */
import { forwardRef } from 'react';
import { label } from '../../../../lib/labels';
import './StreamingText.scss';

export interface StreamingTextProps {
  /** 已到达的文本（增量由消费方拼接后整体传入） */
  text: string;
  /** 流式进行中：末尾显示光标 */
  streaming?: boolean;
  className?: string;
}

export const StreamingText = forwardRef<HTMLSpanElement, StreamingTextProps>(
  ({ text, streaming = false, className = '' }, ref) => (
    <span
      ref={ref}
      className={['ai-stream', streaming && 'ai-stream--on', className].filter(Boolean).join(' ')}
      aria-live={streaming ? 'polite' : undefined}
      aria-label={streaming ? label('components.ai.generating', '生成中') : undefined}
    >
      {text}
      {streaming && <span className="ai-stream__cursor" aria-hidden="true" />}
    </span>
  ),
);
StreamingText.displayName = 'StreamingText';
