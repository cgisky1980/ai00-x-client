/**
 * Button —— 规范 5.1
 * primary：交互色实体 + 皮肤按钮字色（皮肤体检保证 ≥4.5）；data-buttons=tonal 时为浅底
 * seal：高亮笔色签名按钮，一屏一处的唯一 CTA（文字 seal-foreground）
 * default：墨阶次级按钮；ghost：透明幽灵；destructive：语义危险
 * hover 上抬 / 按下反馈走 motion.css（taste-skill 微动效层）
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
