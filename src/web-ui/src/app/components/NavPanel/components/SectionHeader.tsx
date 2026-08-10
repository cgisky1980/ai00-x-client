/**
 * SectionHeader — collapsible, scene-opening, or static section title row.
 */

import React, { useCallback } from 'react';
import { ChevronRight } from 'lucide-react';

interface SectionHeaderProps {
  label: string;
  icon?: React.ReactNode;
  collapsible: boolean;
  isOpen: boolean;
  onToggle?: () => void;
  onSceneOpen?: () => void;
  actions?: React.ReactNode;
}

const SectionHeader: React.FC<SectionHeaderProps> = ({
  label,
  icon,
  collapsible,
  isOpen,
  onToggle,
  onSceneOpen,
  actions,
}) => {
  const isInteractive = collapsible || !!onSceneOpen;
  const isSceneEntry = !collapsible && !!onSceneOpen;

  const handleActivate = useCallback(() => {
    if (collapsible) {
      onToggle?.();
      return;
    }
    onSceneOpen?.();
  }, [collapsible, onSceneOpen, onToggle]);

  return (
    <div
      className={[
        'ai00-x-nav-panel__section-header',
        isInteractive && 'ai00-x-nav-panel__section-header--interactive',
        collapsible && 'ai00-x-nav-panel__section-header--collapsible',
        onSceneOpen && 'ai00-x-nav-panel__section-header--scene-link',
        isSceneEntry && 'ai00-x-nav-panel__section-header--scene-entry',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={isInteractive ? handleActivate : undefined}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-expanded={collapsible ? isOpen : undefined}
      onKeyDown={
        isInteractive
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleActivate();
              }
            }
          : undefined
      }
    >
      {icon ? <span className="ai00-x-nav-panel__section-icon" aria-hidden="true">{icon}</span> : null}
      <span className="ai00-x-nav-panel__section-label">{label}</span>
      {onSceneOpen ? (
        <span className="ai00-x-nav-panel__section-indicator" aria-hidden="true">
          <ChevronRight size={14} />
        </span>
      ) : null}
      {actions ? (
        <div
          className="ai00-x-nav-panel__section-actions"
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
};

export default SectionHeader;
