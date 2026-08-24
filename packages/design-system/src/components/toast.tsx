/**
 * Toast —— Radix Toast + zustand 命令式 API（规范 5.8）
 *
 * 用法：根部挂一次 <ToastProvider />，任意位置调用 toast('已保存', { variant: 'success' })。
 * variant = info/success/warning/error —— 语义色只表状态（左缘 2px 状态条，规范 4.6）。
 */
import { type ReactNode } from 'react';
import { create } from 'zustand';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';
import { label } from '../lib/labels';
import { usePortalContainer } from '../lib/portal';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  variant?: ToastVariant;
  description?: ReactNode;
  /** 毫秒；默认 4000，传 Infinity 常驻 */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem {
  id: number;
  message: ReactNode;
  variant: ToastVariant;
  description?: ReactNode;
  duration: number;
  action?: ToastOptions['action'];
}

interface ToastStore {
  toasts: ToastItem[];
  push: (message: ReactNode, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const useToastStore = create<ToastStore>()((set) => ({
  toasts: [],
  push: (message, options) => {
    const id = Date.now() + Math.random();
    set((s) => ({
      toasts: [
        ...s.toasts,
        {
          id,
          message,
          variant: options?.variant ?? 'info',
          description: options?.description,
          duration: options?.duration ?? 4000,
          action: options?.action,
        },
      ],
    }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 命令式 API：toast('已保存', { variant: 'success' }) */
export const toast = (message: ReactNode, options?: ToastOptions) =>
  useToastStore.getState().push(message, options);

export const toastSuccess = (message: ReactNode, options?: Omit<ToastOptions, 'variant'>) =>
  toast(message, { ...options, variant: 'success' });
export const toastWarning = (message: ReactNode, options?: Omit<ToastOptions, 'variant'>) =>
  toast(message, { ...options, variant: 'warning' });
export const toastError = (message: ReactNode, options?: Omit<ToastOptions, 'variant'>) =>
  toast(message, { ...options, variant: 'error' });

/** 根部挂载一次；渲染 viewport 与当前 toast 队列（portal 到消费方容器或 body） */
export const ToastProvider = () => {
  const container = usePortalContainer();
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return createPortal(
    <ToastPrimitive.Provider swipeDirection="right">
      {toasts.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          open
          duration={t.duration}
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
          className={cn('ds-toast', `ds-toast--${t.variant}`)}
        >
          <div className="ds-toast__body">
            <ToastPrimitive.Title className="ds-toast__title">{t.message}</ToastPrimitive.Title>
            {t.description != null && (
              <ToastPrimitive.Description className="ds-toast__desc">
                {t.description}
              </ToastPrimitive.Description>
            )}
          </div>
          {t.action && (
            <ToastPrimitive.Action
              asChild
              altText={t.action.label}
              onClick={() => {
                dismiss(t.id);
                t.action?.onClick();
              }}
            >
              <button type="button" className="ds-toast__action">
                {t.action.label}
              </button>
            </ToastPrimitive.Action>
          )}
          <ToastPrimitive.Close className="ds-toast__close" aria-label={label('toast.close', '关闭')}>
            ×
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="ds-toast-viewport" />
    </ToastPrimitive.Provider>,
    container,
  );
};
