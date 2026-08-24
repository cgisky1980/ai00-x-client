/**
 * Drawer —— Radix Dialog side 变体（规范 5.8，shadcn Sheet 模式）
 * 滑入 0.3s；遮罩 + L4 玻璃面板；桌面端 right 侧默认宽 400px（≤480 纪律）
 */
import { forwardRef, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../lib/cn';
import { label } from '../lib/labels';

export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerClose = DialogPrimitive.Close;
export const DrawerPortal = DialogPrimitive.Portal;

export const DrawerOverlay = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay ref={ref} className={cn('ds-drawer-overlay', className)} {...props} />
));
DrawerOverlay.displayName = 'DrawerOverlay';

export interface DrawerContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: 'right' | 'left' | 'top' | 'bottom';
}

const sideClass = {
  right: 'ds-drawer__content--right',
  left: 'ds-drawer__content--left',
  top: 'ds-drawer__content--top',
  bottom: 'ds-drawer__content--bottom',
} as const;

export const DrawerContent = forwardRef<HTMLDivElement, DrawerContentProps>(
  ({ className, children, side = 'right', ...props }, ref) => (
    <DrawerPortal>
      <DrawerOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn('ds-drawer__content', sideClass[side], className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="ds-drawer__close" aria-label={label('drawer.close', '关闭')}>
          ×
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DrawerPortal>
  ),
);
DrawerContent.displayName = 'DrawerContent';

export const DrawerTitle = forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('ds-drawer__title', className)} {...props} />
));
DrawerTitle.displayName = 'DrawerTitle';

export const DrawerDescription = forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('ds-drawer__desc', className)}
    {...props}
  />
));
DrawerDescription.displayName = 'DrawerDescription';

/** 快捷组合：带标题/描述的侧拉面板（children 为正文） */
export const DrawerPanel = ({
  title,
  description,
  children,
  side,
  ...props
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  side?: DrawerContentProps['side'];
} & Omit<DrawerContentProps, 'children' | 'title'>) => (
  <DrawerContent side={side} {...props}>
    <div className="ds-drawer__header">
      <DrawerTitle>{title}</DrawerTitle>
      {description != null && <DrawerDescription>{description}</DrawerDescription>}
    </div>
    <div className="ds-drawer__body">{children}</div>
  </DrawerContent>
);
