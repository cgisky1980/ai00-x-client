/**
 * Steps —— 横向步骤条（规范 5.8）
 * current 之前 finish（黛青）、当前 process（黛青实心+呼吸）、之后 wait（墨阶）。
 * 连接线随 finish 流转填充；序号 mono + tabular-nums。
 */
import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export interface StepItem {
  title: string;
  description?: string;
}

export interface StepsProps extends HTMLAttributes<HTMLOListElement> {
  steps: StepItem[];
  /** 当前步索引（0 起） */
  current: number;
}

export const Steps = forwardRef<HTMLOListElement, StepsProps>(
  ({ className, steps, current, ...props }, ref) => (
    <ol ref={ref} className={cn('ds-steps', className)} {...props}>
      {steps.map((s, i) => {
        const status = i < current ? 'finish' : i === current ? 'process' : 'wait';
        return (
          <li
            key={s.title}
            className={cn('ds-steps__item', `ds-steps__item--${status}`)}
            aria-current={status === 'process' ? 'step' : undefined}
          >
            <span className="ds-steps__node">
              {status === 'finish' ? (
                <svg viewBox="0 0 12 12" className="ds-steps__check" aria-hidden="true">
                  <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <span className="ds-data">{i + 1}</span>
              )}
            </span>
            <span className="ds-steps__line" aria-hidden="true" />
            <span className="ds-steps__text">
              <span className="ds-steps__title">{s.title}</span>
              {s.description && <span className="ds-steps__desc">{s.description}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  ),
);
Steps.displayName = 'Steps';
