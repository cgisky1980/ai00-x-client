/**
 * Input component
 */

import React, { forwardRef } from 'react';
import './Input.scss';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  variant?: 'default' | 'filled' | 'outlined';
  inputSize?: 'small' | 'medium' | 'large';
  size?: 'small' | 'medium' | 'large';
  error?: boolean;
  errorMessage?: string;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  label?: string;
  hint?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({
  variant = 'default',
  inputSize = 'medium',
  size,
  error = false,
  errorMessage,
  prefix,
  suffix,
  label,
  hint,
  className = '',
  disabled,
  ...props
}, ref) => {
  const resolvedInputSize = size ?? inputSize;
  const classNames = [
    'ai00-x-input-wrapper',
    `ai00-x-input-wrapper--${variant}`,
    `ai00-x-input-wrapper--${resolvedInputSize}`,
    error && 'ai00-x-input-wrapper--error',
    disabled && 'ai00-x-input-wrapper--disabled',
    className
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classNames}>
      {label && <label className="ai00-x-input-label">{label}</label>}
      <div className="ai00-x-input-container">
        {prefix && <span className="ai00-x-input-prefix">{prefix}</span>}
        <input
          ref={ref}
          className="ai00-x-input"
          disabled={disabled}
          {...props}
        />
        {suffix && <span className="ai00-x-input-suffix">{suffix}</span>}
      </div>
      {!error && hint && (
        <span className="ai00-x-input-error-message">{hint}</span>
      )}
      {error && errorMessage && (
        <span className="ai00-x-input-error-message">{errorMessage}</span>
      )}
    </div>
  );
});

Input.displayName = 'Input';
