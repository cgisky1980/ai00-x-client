/**
 * Tag component
 */

import React from 'react';
import './Tag.scss';

export interface TagProps {
  children: React.ReactNode;
  color?: 'blue' | 'green' | 'red' | 'yellow' | 'purple' | 'gray';
  size?: 'small' | 'medium' | 'large';
  title?: string;
  closable?: boolean;
  onClose?: () => void;
  className?: string;
  rounded?: boolean;
}

export const Tag: React.FC<TagProps> = ({
  children,
  color = 'blue',
  size = 'medium',
  title,
  closable = false,
  onClose,
  className = '',
  rounded = false,
}) => {
  const classNames = [
    'tag',
    `tag--${color}`,
    `tag--${size}`,
    rounded && 'tag--rounded',
    className
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classNames} title={title}>
      <span className="tag__content">{children}</span>
      {closable && (
        <button className="tag__close" onClick={onClose}>
          ×
        </button>
      )}
    </span>
  );
};
