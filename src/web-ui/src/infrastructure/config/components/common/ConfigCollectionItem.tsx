import React, { useState } from 'react';
import './ConfigCollectionItem.scss';

export interface ConfigCollectionItemProps {
  label: React.ReactNode;
  badge?: React.ReactNode;
  badgePlacement?: 'inline' | 'below';
  control: React.ReactNode;
  details?: React.ReactNode;
  disabled?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  className?: string;
}

export const ConfigCollectionItem: React.FC<ConfigCollectionItemProps> = ({
  label,
  badge,
  badgePlacement = 'inline',
  control,
  details,
  disabled = false,
  expanded: expandedProp,
  onToggle,
  className = '',
}) => {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isControlled = expandedProp !== undefined;
  const isExpanded = isControlled ? expandedProp : internalExpanded;
  const hasDetails = Boolean(details);

  const handleRowClick = () => {
    if (!hasDetails) return;
    if (isControlled) {
      onToggle?.();
    } else {
      setInternalExpanded((prev) => !prev);
    }
  };

  return (
    <div
      className={`ai00-x-collection-item ${isExpanded ? 'is-expanded' : ''} ${disabled ? 'is-disabled' : ''} ${className}`}
    >
      <div
        className={`ai00-x-config-page-row ai00-x-config-page-row--center ai00-x-collection-item__row ${hasDetails ? 'is-clickable' : ''}`}
        onClick={handleRowClick}
      >
        <div className="ai00-x-config-page-row__meta">
          <div
            className={`ai00-x-config-page-row__label ai00-x-collection-item__label ${
              badgePlacement === 'below' ? 'ai00-x-collection-item__label--stacked' : ''
            }`}
          >
            <span className="ai00-x-collection-item__name">{label}</span>
            {badge && (
              <span
                className={`ai00-x-collection-item__badges ${
                  badgePlacement === 'below'
                    ? 'ai00-x-collection-item__badges--stacked'
                    : 'ai00-x-collection-item__badges--inline'
                }`}
              >
                {badge}
              </span>
            )}
          </div>
        </div>
        <div
          className="ai00-x-config-page-row__control"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ai00-x-collection-item__control">{control}</div>
        </div>
      </div>

      {isExpanded && details && (
        <div className="ai00-x-collection-item__details">{details}</div>
      )}
    </div>
  );
};

export default ConfigCollectionItem;
