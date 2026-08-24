/**
 * Button component — 薄壳适配层
 * props API 保持不变（调用点零改动），内部样式切换到 @ai00-x/design-system 的
 * ds-btn 类体系（黛青唯一交互色，规范 参考/前端视觉设计规范-新东方极简.md 5.1）。
 * variant 映射（新东方极简语义重解释）：
 *   primary/accent/ai/success → ds-btn--primary（黛青；AI 紫与语义色按钮退役，统一黛青）
 *   secondary → ds-btn--default；ghost → ds-btn--ghost
 *   danger → ds-btn--destructive（de-escalated：hover 才红）
 *   dashed → ds-btn--default + 虚线补充
 */

import React, { forwardRef } from 'react';
import './Button.scss';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'dashed' | 'danger' | 'success' | 'accent' | 'ai';
  size?: 'small' | 'medium' | 'large';
  isLoading?: boolean;
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({
  children,
  variant = 'primary',
  size = 'medium',
  isLoading = false,
  iconOnly = false,
  className = '',
  disabled,
  ...props
}, ref) => {
  const sizeClassMap = {
    small: 'ds-btn--sm btn-sm',
    medium: 'ds-btn--base btn-base',
    large: 'ds-btn--lg btn-lg'
  };

  const getVariantClass = (v: string) => {
    switch (v) {
      case 'primary':
      case 'accent':
      case 'ai':
      case 'success':
        return 'ds-btn--primary';
      case 'secondary':
        return 'ds-btn--default';
      case 'danger':
        return 'ds-btn--destructive';
      case 'ghost':
        return 'ds-btn--ghost';
      case 'dashed':
        return 'ds-btn--default btn-dashed';
      default:
        return 'ds-btn--default';
    }
  };

  const classNames = [
    'ds-btn',
    getVariantClass(variant),
    sizeClassMap[size] || 'ds-btn--base',
    iconOnly && 'btn-icon-only',
    isLoading && 'btn-loading',
    className
  ].filter(Boolean).join(' ');

  return (
    <button
      ref={ref}
      className={classNames}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading ? (
        <>
          <span className="btn-loading-icon"></span>
          <span className="btn-loading-text">Loading...</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});

Button.displayName = 'Button';
