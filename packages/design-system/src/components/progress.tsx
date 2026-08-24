/**
 * Progress —— Radix Progress 封装（规范 5.8）；轨道沉底，填充黛青或语义色
 */
import { forwardRef } from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cn } from '../lib/cn';

export interface ProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  /** 0–100 */
  value?: number;
  /** default=黛青；语义变体仅表状态（规范 4.6） */
  variant?: 'default' | 'success' | 'warning' | 'error';
}

const variantClass = {
  default: '',
  success: 'ds-progress--success',
  warning: 'ds-progress--warning',
  error: 'ds-progress--error',
} as const;

export const Progress = forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value, variant = 'default', ...props }, ref) => (
    <ProgressPrimitive.Root
      ref={ref}
      value={value}
      className={cn('ds-progress', variantClass[variant], className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="ds-progress__indicator"
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  ),
);
Progress.displayName = 'Progress';
