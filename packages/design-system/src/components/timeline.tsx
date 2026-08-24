/**
 * Timeline —— 竖向时间线（规范 5.8）
 * 节点三态：finish（黛青实心）/ active（黛青 + 呼吸光环）/ pending（墨点）。
 * 连接线由 item::before 自绘，末项自动断线；数字/时间走 mono + tabular-nums。
 */
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface TimelineItemProps extends Omit<HTMLAttributes<HTMLLIElement>, 'title'> {
  /** 左列时间戳（mono + tabular-nums） */
  time?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  /** 默认 pending */
  status?: 'finish' | 'active' | 'pending';
  /** 自定义节点内容（替代圆点） */
  dot?: ReactNode;
}

export interface TimelineProps extends HTMLAttributes<HTMLUListElement> {
  children: ReactNode;
}

export const Timeline = forwardRef<HTMLUListElement, TimelineProps>(
  ({ className, children, ...props }, ref) => (
    <ul ref={ref} className={cn('ds-timeline', className)} {...props}>
      {children}
    </ul>
  ),
);
Timeline.displayName = 'Timeline';

export const TimelineItem = forwardRef<HTMLLIElement, TimelineItemProps>(
  ({ className, time, title, description, status = 'pending', dot, children, ...props }, ref) => (
    <li
      ref={ref}
      className={cn('ds-timeline__item', `ds-timeline__item--${status}`, className)}
      {...props}
    >
      {time != null && <span className="ds-timeline__time">{time}</span>}
      <span className="ds-timeline__node">
        {dot != null ? dot : <span className="ds-timeline__dot" aria-hidden="true" />}
        {/* 连接线：末项由 CSS :last-child 断开 */}
        <span className="ds-timeline__line" aria-hidden="true" />
      </span>
      <div className="ds-timeline__body">
        {title != null && <h4 className="ds-timeline__title">{title}</h4>}
        {description != null && <p className="ds-timeline__desc">{description}</p>}
        {children}
      </div>
    </li>
  ),
);
TimelineItem.displayName = 'TimelineItem';
