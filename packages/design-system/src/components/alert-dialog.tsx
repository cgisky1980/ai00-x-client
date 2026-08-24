/**
 * AlertDialog —— Radix AlertDialog 封装（规范 5.8）；L4 玻璃确认框原语（组合式）
 * 命令式场景用 web 系 confirmService。
 */
import { forwardRef } from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { cn } from '../lib/cn';
import { label } from '../lib/labels';

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogPortal = AlertDialogPrimitive.Portal;

export const AlertDialogOverlay = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay ref={ref} className={cn('ds-dialog-overlay', className)} {...props} />
));
AlertDialogOverlay.displayName = 'AlertDialogOverlay';

export const AlertDialogContent = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <AlertDialogPrimitive.Portal>
    <AlertDialogPrimitive.Overlay className="ds-dialog-overlay" />
    <AlertDialogPrimitive.Content ref={ref} className={cn('ds-dialog', className)} {...props}>
      {children}
    </AlertDialogPrimitive.Content>
  </AlertDialogPrimitive.Portal>
));
AlertDialogContent.displayName = 'AlertDialogContent';

export const AlertDialogTitle = forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title ref={ref} className={cn('ds-dialog__title', className)} {...props} />
));
AlertDialogTitle.displayName = 'AlertDialogTitle';

export const AlertDialogDescription = forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn('ds-dialog__desc', className)}
    {...props}
  />
));
AlertDialogDescription.displayName = 'AlertDialogDescription';

export const AlertDialogCancel = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Cancel ref={ref} className={cn('ds-btn ds-btn--default', className)} {...props} />
));
AlertDialogCancel.displayName = 'AlertDialogCancel';

export const AlertDialogAction = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action> & {
    variant?: 'primary' | 'destructive';
  }
>(({ className, variant = 'primary', ...props }, ref) => (
  <AlertDialogPrimitive.Action
    ref={ref}
    className={cn(
      'ds-btn',
      variant === 'destructive' ? 'ds-btn--destructive' : 'ds-btn--primary',
      className,
    )}
    {...props}
  />
));
AlertDialogAction.displayName = 'AlertDialogAction';

/** 快捷组合：带标题/描述/取消/确认的确认框内容（默认文案走 label()） */
export const AlertDialogSimple = ({
  title,
  description,
  cancelText,
  actionText,
  variant = 'primary',
  onAction,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  cancelText?: string;
  actionText?: string;
  variant?: 'primary' | 'destructive';
  onAction?: () => void;
}) => (
  <AlertDialogContent>
    <AlertDialogTitle>{title}</AlertDialogTitle>
    {description != null && <AlertDialogDescription>{description}</AlertDialogDescription>}
    <div className="ds-dialog__footer">
      <AlertDialogCancel>{cancelText ?? label('dialog.confirm.cancel', '取消')}</AlertDialogCancel>
      <AlertDialogAction variant={variant} onClick={onAction}>
        {actionText ?? label('dialog.confirm.ok', '确定')}
      </AlertDialogAction>
    </div>
  </AlertDialogContent>
);
