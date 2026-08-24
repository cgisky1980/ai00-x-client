/**
 * Skeleton —— 占位骨架（规范 5.8）；墨阶底慢速脉冲，尺寸由消费方给
 */
import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export const Skeleton = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('ds-skeleton', className)} {...props} />
  ),
);
Skeleton.displayName = 'Skeleton';
