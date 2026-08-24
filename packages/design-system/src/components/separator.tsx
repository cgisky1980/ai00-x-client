/**
 * Separator —— Radix Separator 封装（规范 5.8）；1px border.subtle 分组分隔
 */
import { forwardRef } from 'react';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import { cn } from '../lib/cn';

export const Separator = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    orientation={orientation}
    decorative={decorative}
    className={cn('ds-separator', `ds-separator--${orientation}`, className)}
    {...props}
  />
));
Separator.displayName = 'Separator';
