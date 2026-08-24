/**
 * TabOverflowMenu component.
 * Combines mission control entry and overflow tabs menu.
 * - Mission control without overflow: click to open mission control
 * - Overflow: show +N badge and dropdown; first item is mission control (if available)
 * - Overflow without mission control: show overflow menu only
 *
 * v0.13：浮层收敛至 DS Popover（.ds-popover，Radix 定位/外点关闭）。
 */

import React, { useState, useCallback } from 'react';
import { LayoutGrid, ChevronDown, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, Popover, PopoverTrigger, PopoverContent } from '@/component-library';
import type { CanvasTab } from '../types';
import './TabOverflowMenu.scss';
export interface TabOverflowMenuProps {
  /** Overflow tabs */
  overflowTabs: CanvasTab[];
  /** Active tab ID */
  activeTabId: string | null;
  /** Tab click callback */
  onTabClick: (tabId: string) => void;
  /** Close tab callback */
  onTabClose: (tabId: string) => Promise<void> | void;
  /** Reorder tab callback (move to index) */
  onReorderTab: (tabId: string, newIndex: number) => void;
  /** Open mission control (optional, only for primary group) */
  onOpenMissionControl?: () => void;
}

export const TabOverflowMenu: React.FC<TabOverflowMenuProps> = ({
  overflowTabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onReorderTab,
  onOpenMissionControl,
}) => {
  const { t } = useTranslation('components');
  const [isOpen, setIsOpen] = useState(false);

  const hasOverflow = overflowTabs.length > 0;
  const hasMissionControl = !!onOpenMissionControl;

  // Handle mission control click
  const handleMissionControlClick = useCallback(() => {
    onOpenMissionControl?.();
    setIsOpen(false);
  }, [onOpenMissionControl]);

  // Handle tab click
  const handleTabClick = useCallback((tabId: string) => {
    // Move tab to front (index 0) so it becomes visible
    onReorderTab(tabId, 0);
    // Then switch to the tab
    onTabClick(tabId);
    setIsOpen(false);
  }, [onTabClick, onReorderTab]);

  // Handle close click
  const handleCloseClick = useCallback(async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    await onTabClose(tabId);
  }, [onTabClose]);

  const handleItemMiddleMouseDown = useCallback((e: React.MouseEvent, tab: CanvasTab) => {
    if (e.button !== 1) return;
    if (tab.state === 'pinned') return;
    const target = e.target as HTMLElement;
    if (target.closest('.canvas-tab-overflow-menu__item-close')) return;
    e.preventDefault();
  }, []);

  const handleItemAuxClick = useCallback(
    async (e: React.MouseEvent, tab: CanvasTab) => {
      if (e.button !== 1) return;
      if (tab.state === 'pinned') return;
      const target = e.target as HTMLElement;
      if (target.closest('.canvas-tab-overflow-menu__item-close')) return;
      e.preventDefault();
      e.stopPropagation();
      await onTabClose(tab.id);
      setIsOpen(false);
    },
    [onTabClose]
  );

  // Decide whether to show button: overflow tabs or mission control
  const shouldShowButton = hasOverflow || hasMissionControl;

  // Hide button when no overflow and no mission control
  if (!shouldShowButton) {
    return null;
  }

  const tooltipContent = hasOverflow
    ? hasMissionControl
      ? `${t('tabs.missionControl')} · ${t('tabs.hiddenTabsCount', { count: overflowTabs.length })}`
      : t('tabs.hiddenTabsCount', { count: overflowTabs.length })
    : hasMissionControl
      ? t('tabs.missionControl')
      : '';

  const triggerButton = (
    <button
      className={`canvas-tab-panorama-btn ${hasOverflow ? 'has-overflow' : ''} ${isOpen ? 'is-open' : ''} ${!hasMissionControl ? 'overflow-only' : ''}`}
      onClick={hasOverflow ? undefined : handleMissionControlClick}
    >
      {hasMissionControl ? (
        <LayoutGrid size={14} />
      ) : (
        <ChevronDown size={14} />
      )}
      {hasOverflow && (
        <span className="canvas-tab-panorama-btn__badge">
          +{overflowTabs.length}
        </span>
      )}
    </button>
  );

  return (
    <div className="canvas-tab-panorama-wrapper">
      <Popover open={hasOverflow ? isOpen : false} onOpenChange={setIsOpen}>
        <Tooltip content={tooltipContent} placement="bottom">
          {hasOverflow ? (
            <PopoverTrigger asChild>
              {triggerButton}
            </PopoverTrigger>
          ) : (
            triggerButton
          )}
        </Tooltip>

        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={4}
          className="canvas-tab-overflow-menu"
          data-no-penetrate
        >
          {/* Mission control entry - shown only when available */}
          {hasMissionControl && (
            <>
              <div
                className="canvas-tab-overflow-menu__mission-control"
                onClick={handleMissionControlClick}
              >
                <LayoutGrid size={14} />
                <span>{t('tabs.missionControl')}</span>
                <kbd>⌘.</kbd>
              </div>

              {/* Divider */}
              <div className="canvas-tab-overflow-menu__divider" />
            </>
          )}

          {/* Overflow tab list */}
          <div className="canvas-tab-overflow-menu__list">
            {overflowTabs.map((tab) => {
              const deletedSuffix = tab.fileDeletedFromDisk ? ` - ${t('tabs.fileDeleted')}` : '';
              const titleWithDeleted = `${tab.title}${deletedSuffix}`;
              return (
              <div
                key={tab.id}
                className={`canvas-tab-overflow-menu__item ${
                  activeTabId === tab.id ? 'is-active' : ''
                } ${tab.isDirty ? 'is-dirty' : ''} ${tab.fileDeletedFromDisk ? 'is-file-deleted' : ''}`}
                onClick={() => handleTabClick(tab.id)}
                onMouseDown={(e) => handleItemMiddleMouseDown(e, tab)}
                onAuxClick={(e) => void handleItemAuxClick(e, tab)}
              >
                <span className="canvas-tab-overflow-menu__item-title">
                  {tab.state === 'preview' && <em>{titleWithDeleted}</em>}
                  {tab.state !== 'preview' && titleWithDeleted}
                </span>

                {tab.isDirty && (
                  <span className="canvas-tab-overflow-menu__item-dirty">●</span>
                )}

                <button
                  className="canvas-tab-overflow-menu__item-close"
                  onClick={(e) => handleCloseClick(e, tab.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

TabOverflowMenu.displayName = 'TabOverflowMenu';

export default TabOverflowMenu;
