/**
 * QuietPageHeader — Patina-style page header.
 *
 * Layout: [icon] [title + subtitle] [right slot]
 *
 * Ported from Patina's `shared/components/QuietPageHeader.tsx`, adapted to use
 * the SCSS module system (no Tailwind).
 */

import React from 'react';

export interface QuietPageHeaderProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  titleSuffix?: React.ReactNode;
  subtitle?: React.ReactNode;
  rightSlot?: React.ReactNode;
  className?: string;
}

const QuietPageHeader: React.FC<QuietPageHeaderProps> = ({
  icon,
  title,
  titleSuffix,
  subtitle,
  rightSlot,
  className,
}) => {
  return (
    <header className={['qp-page-header', className].filter(Boolean).join(' ')}>
      <div className="qp-page-header-left">
        {icon && <span className="qp-page-header-icon">{icon}</span>}
        <div className="qp-page-header-copy">
          <div className="qp-page-header-title-row">
            <h2 className="qp-page-header-title">{title}</h2>
            {titleSuffix}
          </div>
          {subtitle && <p className="qp-page-header-subtitle">{subtitle}</p>}
        </div>
      </div>
      {rightSlot && <div className="qp-page-header-right">{rightSlot}</div>}
    </header>
  );
};

export default QuietPageHeader;
