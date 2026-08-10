/**
 * QuietIconAction — Patina-style icon button with optional tooltip.
 *
 * Ported from Patina's `shared/components/QuietIconAction.tsx`.
 */

import React, { useState } from 'react';

export interface QuietIconActionProps {
  icon: React.ReactNode;
  title?: string;
  tone?: 'neutral' | 'danger';
  pressed?: boolean;
  disabled?: boolean;
  showTooltip?: boolean;
  className?: string;
  onClick?: () => void;
}

const QuietIconAction: React.FC<QuietIconActionProps> = ({
  icon,
  title,
  tone = 'neutral',
  pressed = false,
  disabled = false,
  showTooltip = true,
  className,
  onClick,
}) => {
  const [hovered, setHovered] = useState(false);

  const button = (
    <button
      type="button"
      className={[
        'qp-icon-action',
        `qp-icon-action--${tone}`,
        pressed && 'qp-icon-action--pressed',
        disabled && 'qp-icon-action--disabled',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  if (!showTooltip || !title) return button;

  return (
    <span className="qp-tooltip-wrapper">
      {button}
      {hovered && (
        <span className="qp-tooltip" role="tooltip">
          {title}
        </span>
      )}
    </span>
  );
};

export default QuietIconAction;
