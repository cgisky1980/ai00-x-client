/**
 * ScrollArea —— Radix ScrollArea 封装（规范 5.8）；8px 命中区 4px 可见墨阶 thumb
 */
import { forwardRef } from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cn } from '../lib/cn';

export const ScrollArea = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root ref={ref} className={cn('ds-scroll-area', className)} {...props}>
    <ScrollAreaPrimitive.Viewport className="ds-scroll-area__viewport">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar
      orientation="vertical"
      className="ds-scroll-area__bar"
    >
      <ScrollAreaPrimitive.Thumb className="ds-scroll-area__thumb" />
    </ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Scrollbar
      orientation="horizontal"
      className="ds-scroll-area__bar ds-scroll-area__bar--horizontal"
    >
      <ScrollAreaPrimitive.Thumb className="ds-scroll-area__thumb" />
    </ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner className="ds-scroll-area__corner" />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = 'ScrollArea';
