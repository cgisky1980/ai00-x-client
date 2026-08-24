/**
 * Tooltip —— Radix 封装；L4 墨面玻璃小字（规范 4.7 / 5.8）。仅 ./react 出口
 * （web 系自有 BEM 版 Tooltip 同名，避免 star-export 冲突）
 */
import { forwardRef } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '../lib/cn';

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipPortal = TooltipPrimitive.Portal;

/** 组合快捷用法：<Tooltip content="..."><button /></Tooltip>（自包含 Provider，可独立使用） */
export const Tooltip = ({
  content,
  children,
  side = 'top',
  delayDuration = 300,
  ...props
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delayDuration?: number;
} & Omit<React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>, 'children'>) => (
  <TooltipPrimitive.Provider>
    <TooltipPrimitive.Root delayDuration={delayDuration} {...props}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} className="ds-tooltip">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>
);
Tooltip.displayName = 'Tooltip';

export const TooltipContent = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn('ds-tooltip', className)}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = 'TooltipContent';
