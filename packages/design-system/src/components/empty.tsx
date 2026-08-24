/**
 * Empty —— 墨韵空态（规范 5.7 / 5.8）；大留白居中，默认灵印 line muted
 */
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { label } from '../lib/labels';
import { BrandMark } from './brand-mark';

export interface EmptyProps {
  /** 主文案；默认「空空如也」 */
  title?: ReactNode;
  description?: ReactNode;
  /** 自定义图标；默认 BrandMark line muted */
  icon?: ReactNode;
  /** 唯一主行动（朱砂合法落点之一） */
  action?: ReactNode;
  className?: string;
}

export const Empty = ({ title, description, icon, action, className }: EmptyProps) => (
  <div className={cn('ds-empty', className)}>
    <div className="ds-empty__icon">{icon ?? <BrandMark variant="line" size={48} />}</div>
    <div className="ds-empty__title">{title ?? label('empty.title', '空空如也')}</div>
    {description != null && <div className="ds-empty__desc">{description}</div>}
    {action != null && <div className="ds-empty__action">{action}</div>}
  </div>
);
