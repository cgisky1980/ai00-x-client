import React, { useState, createContext, useContext, useMemo, useRef, useId, useCallback } from 'react';
import './Tabs.scss';

export interface TabItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  closable?: boolean;
}

export interface TabsProps {
  activeKey?: string;
  defaultActiveKey?: string;
  onChange?: (key: string) => void;
  onTabClose?: (key: string) => void;
  type?: 'line' | 'card' | 'pill';
  size?: 'small' | 'medium' | 'large';
  stretch?: boolean;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export interface TabPaneProps {
  tabKey: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  closable?: boolean;
  children?: React.ReactNode;
  className?: string;
}

interface TabsContextValue {
  activeKey: string;
  onChange: (key: string) => void;
  /** E3b a11y：id 前缀，TabPane 生成 panel id 并反向关联 tab */
  idPrefix: string;
}

const TabsContext = createContext<TabsContextValue | undefined>(undefined);

/** tab key → 安全的 DOM id 片段 */
const safeIdPart = (key: string) => key.replace(/[^\w-]/g, '_');

export const TabPane: React.FC<TabPaneProps> = ({ tabKey, className = '', children }) => {
  const context = useContext(TabsContext);
  if (!context) return null;

  const panelId = `${context.idPrefix}-panel-${safeIdPart(tabKey)}`;
  const tabId = `${context.idPrefix}-tab-${safeIdPart(tabKey)}`;

  return (
    <div
      className={`ai00-x-tab-pane ${className}`}
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabId}
      tabIndex={0}
    >
      {children}
    </div>
  );
};

TabPane.displayName = 'TabPane';

export const Tabs: React.FC<TabsProps> = ({
  activeKey: controlledActiveKey,
  defaultActiveKey,
  onChange,
  onTabClose,
  type = 'line',
  size = 'medium',
  stretch = false,
  children,
  className = '',
  style,
}) => {
  const [internalActiveKey, setInternalActiveKey] = useState<string>(
    defaultActiveKey || ''
  );

  const activeKey = controlledActiveKey !== undefined ? controlledActiveKey : internalActiveKey;
  const idPrefix = useId();

  // E3b a11y：roving tabindex 焦点管理
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const { tabs, panes } = useMemo(() => {
    const nextTabs: TabItem[] = [];
    const nextPanes: { [key: string]: React.ReactNode } = {};

    React.Children.forEach(children, (child) => {
      if (React.isValidElement<TabPaneProps>(child) && child.type === TabPane) {
        const { tabKey, label, icon, disabled, closable } = child.props;
        nextTabs.push({ key: tabKey, label, icon, disabled, closable });
        nextPanes[tabKey] = child;
      }
    });

    return { tabs: nextTabs, panes: nextPanes };
  }, [children]);

  React.useEffect(() => {
    if (!activeKey && tabs.length > 0) {
      const firstKey = tabs[0].key;
      if (controlledActiveKey === undefined) {
        setInternalActiveKey(firstKey);
      }
    }
  }, [activeKey, controlledActiveKey, tabs]);

  const handleTabClick = (key: string, disabled?: boolean) => {
    if (disabled) return;

    if (controlledActiveKey === undefined) {
      setInternalActiveKey(key);
    }
    onChange?.(key);
  };

  // E3b a11y：WAI-ARIA Tabs 键盘模式 —— ←/→ 循环、Home/End 首尾，
  // 焦点即选中（automatic activation，与 antd 一致）
  const handleTablistKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const enabled = tabs.filter((t) => !t.disabled);
      if (enabled.length === 0) return;

      const currentIndex = enabled.findIndex((t) => t.key === activeKey);
      let targetIndex = -1;

      switch (e.key) {
        case 'ArrowRight':
          targetIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % enabled.length;
          break;
        case 'ArrowLeft':
          targetIndex = currentIndex < 0 ? 0 : (currentIndex - 1 + enabled.length) % enabled.length;
          break;
        case 'Home':
          targetIndex = 0;
          break;
        case 'End':
          targetIndex = enabled.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      const target = enabled[targetIndex];
      handleTabClick(target.key, target.disabled);
      requestAnimationFrame(() => {
        tabRefs.current[target.key]?.focus();
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, activeKey]
  );

  const handleTabClose = (e: React.MouseEvent, key: string) => {
    e.stopPropagation();
    onTabClose?.(key);
  };

  const containerClass = [
    'ai00-x-tabs',
    `ai00-x-tabs--${type}`,
    `ai00-x-tabs--${size}`,
    stretch && 'ai00-x-tabs--stretch',
    className
  ].filter(Boolean).join(' ');

  const contextValue: TabsContextValue = {
    activeKey,
    onChange: handleTabClick,
    idPrefix,
  };

  return (
    <TabsContext.Provider value={contextValue}>
      <div className={containerClass} style={style}>
        <div className="ai00-x-tabs__nav">
          <div
            className="ai00-x-tabs__nav-list"
            role="tablist"
            onKeyDown={handleTablistKeyDown}
          >
            {tabs.map((tab) => {
              const isActive = activeKey === tab.key;
              const tabId = `${idPrefix}-tab-${safeIdPart(tab.key)}`;
              const panelId = `${idPrefix}-panel-${safeIdPart(tab.key)}`;
              return (
                <div
                  key={tab.key}
                  ref={(node) => {
                    tabRefs.current[tab.key] = node;
                  }}
                  className={[
                    'ai00-x-tabs__tab',
                    isActive && 'ai00-x-tabs__tab--active',
                    tab.disabled && 'ai00-x-tabs__tab--disabled',
                  ].filter(Boolean).join(' ')}
                  role="tab"
                  id={tabId}
                  aria-selected={isActive}
                  aria-controls={panelId}
                  aria-disabled={tab.disabled || undefined}
                  tabIndex={isActive && !tab.disabled ? 0 : -1}
                  onClick={() => handleTabClick(tab.key, tab.disabled)}
                >
                  {tab.icon && <span className="ai00-x-tabs__tab-icon">{tab.icon}</span>}
                  <span className="ai00-x-tabs__tab-label">{tab.label}</span>
                  {tab.closable && (
                    <span
                      className="ai00-x-tabs__tab-close"
                      onClick={(e) => handleTabClose(e, tab.key)}
                      aria-hidden="true"
                    >
                      ×
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {type === 'line' && <div className="ai00-x-tabs__ink-bar" />}
        </div>
        <div className="ai00-x-tabs__content">
          {panes[activeKey]}
        </div>
      </div>
    </TabsContext.Provider>
  );
};

Tabs.displayName = 'Tabs';
