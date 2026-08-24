/**
 * Button —— 规范 5.1
 * primary：黛青实体 + 纸白文字（对比 5.69）
 * seal：朱砂印章按钮，全页唯一 CTA（一屏一处！文字 seal-foreground）
 * default：墨阶次级按钮；ghost：透明幽灵；destructive：语义危险
 * active 反馈走 motion.css 的 ink-ripple（白名单场景 4）
 */
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

const buttonVariants = cva('ds-btn', {
  variants: {
    variant: {
      primary: 'ds-btn--primary',
      seal: 'ds-btn--seal',
      default: 'ds-btn--default',
      outline: 'ds-btn--default',
      ghost: 'ds-btn--ghost',
      destructive: 'ds-btn--destructive',
    },
    size: {
      sm: 'ds-btn--sm',
      base: 'ds-btn--base',
      lg: 'ds-btn--lg',
      icon: 'ds-btn--icon',
    },
  },
  defaultVariants: { variant: 'default', size: 'base' },
});

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
