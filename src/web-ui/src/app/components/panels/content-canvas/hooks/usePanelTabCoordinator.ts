/**
 * usePanelTabCoordinator Hook
 * Tab and panel state coordinator.
 *
 * Responsibilities:
 * 1. Watch tab count changes and manage panel expand/collapse
 * 2. Sync panel state on tab open/close
 * 3. Ensure state consistency and avoid race conditions
 */

import { useEffect, useRef, useCallback } from 'react';
import { useCanvasStore } from '../stores';
import { useApp } from '@/app/hooks/useApp';
import { TAB_EVENTS } from '../types';
import { loadPanelWidth, STORAGE_KEYS, RIGHT_PANEL_CONFIG } from '@/app/layout/panelConfig';
import { appManager } from '@/app/services/AppManager';

interface UsePanelTabCoordinatorOptions {
  autoCollapseOnEmpty?: boolean;
  autoExpandOnTabOpen?: boolean;
}

export const usePanelTabCoordinator = (options: UsePanelTabCoordinatorOptions = {}) => {
  const {
    autoCollapseOnEmpty = true,
    autoExpandOnTabOpen = true,
  } = options;

  const {
    primaryGroup,
    secondaryGroup,
  } = useCanvasStore();

  const { state, updateRightPanelWidth } = useApp();

  const rightPanelCollapsedRef = useRef(
    state?.layout?.rightPanelCollapsed ?? true
  );
  const isInitializedRef = useRef(false);
  const prevVisibleCountRef = useRef(0);

  useEffect(() => {
    if (state?.layout) {
      rightPanelCollapsedRef.current = state.layout.rightPanelCollapsed ?? true;
    }
    if (!isInitializedRef.current) {
      isInitializedRef.current = true;
    }
  }, [state?.layout]);

  const expandPanel = useCallback(() => {
    if (rightPanelCollapsedRef.current && updateRightPanelWidth) {
      const lastWidth = loadPanelWidth(STORAGE_KEYS.RIGHT_PANEL_LAST_WIDTH, RIGHT_PANEL_CONFIG.COMFORTABLE_DEFAULT);
      updateRightPanelWidth(lastWidth);
      
      window.dispatchEvent(new CustomEvent('expand-right-panel-immediate', { 
        detail: { noAnimation: true } 
      }));

      appManager.updateLayout({ rightPanelCollapsed: false });
    }
  }, [updateRightPanelWidth]);

  const collapsePanel = useCallback(() => {
    if (!rightPanelCollapsedRef.current) {
      appManager.updateLayout({ rightPanelCollapsed: true });
    }
  }, []);

  useEffect(() => {
    if (!isInitializedRef.current) {
      return;
    }

    const primaryVisible = primaryGroup.tabs.filter(t => !t.isHidden).length;
    const secondaryVisible = secondaryGroup.tabs.filter(t => !t.isHidden).length;
    const visibleCount = primaryVisible + secondaryVisible;
    
    const isCollapsed = rightPanelCollapsedRef.current;
    const prevCount = prevVisibleCountRef.current;

    if (visibleCount === 0 && autoCollapseOnEmpty && !isCollapsed && prevCount > 0) {
      collapsePanel();
    }
    else if (visibleCount > 0 && autoExpandOnTabOpen && isCollapsed) {
      expandPanel();
    }

    prevVisibleCountRef.current = visibleCount;
  }, [
    primaryGroup.tabs,
    secondaryGroup.tabs,
    autoCollapseOnEmpty,
    autoExpandOnTabOpen,
    expandPanel,
    collapsePanel,
  ]);

  useEffect(() => {
    const handleExpandRightPanel = () => {
      if (autoExpandOnTabOpen) {
        expandPanel();
      }
    };

    window.addEventListener(TAB_EVENTS.EXPAND_RIGHT_PANEL, handleExpandRightPanel);

    return () => {
      window.removeEventListener(TAB_EVENTS.EXPAND_RIGHT_PANEL, handleExpandRightPanel);
    };
  }, [autoExpandOnTabOpen, expandPanel]);

  return {
    expandPanel,
    collapsePanel,
  };
};
