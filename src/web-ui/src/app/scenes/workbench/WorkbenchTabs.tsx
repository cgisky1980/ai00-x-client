/**
 * WorkbenchTabs — 工作台中间区统一标签框架。
 *
 * 规则（所有工作台一致）：
 * - 第一个标签是「首页」，永远存在、永远不可关闭（任务/项目=计划页，插件=插件页）。
 * - 其余标签是只读文件预览或子代理子会话（可关闭、按路径/会话 id 去重）。
 * - 标签栏与内容分离：内容由调用方按 activeKey 渲染，避免隐藏标签也挂载大预览。
 */
import React from 'react';
import { Plus, X } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import './WorkbenchTabs.scss';

export interface WorkbenchTabItem {
  key: string;
  title: string;
  icon?: React.ReactNode;
  /** home = 不可关闭的首页标签；file = 文件预览。 */
  kind: 'home' | 'file';
  /** 悬停提示（默认用 title）。 */
  tooltip?: string;
}

export interface WorkbenchTabsProps {
  tabs: WorkbenchTabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  onClose: (key: string) => void;
  /** 标签栏右侧「+」：选择一个文件在中区预览。 */
  onPickFile?: () => void;
  /** 当前标签内容。 */
  children?: React.ReactNode;
}

export const WorkbenchTabs: React.FC<WorkbenchTabsProps> = ({
  tabs,
  activeKey,
  onChange,
  onClose,
  onPickFile,
  children,
}) => {
  const { t } = useI18n('common');

  return (
    <section className="ai00-x-wb-tabs">
      <div className="ai00-x-wb-tabs__bar">
        <div className="ai00-x-wb-tabs__list" role="tablist">
          {tabs.map((tab) => {
            const active = tab.key === activeKey;
            return (
              <div
                key={tab.key}
                className={`ai00-x-wb-tabs__tab${active ? ' is-active' : ''}${
                  tab.kind === 'home' ? ' is-home' : ''
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="ai00-x-wb-tabs__label"
                  title={tab.tooltip ?? tab.title}
                  onClick={() => onChange(tab.key)}
                >
                  {tab.icon && (
                    <span className="ai00-x-wb-tabs__icon" aria-hidden="true">
                      {tab.icon}
                    </span>
                  )}
                  <span className="ai00-x-wb-tabs__title">{tab.title}</span>
                </button>
                {tab.kind !== 'home' && (
                  <button
                    type="button"
                    className="ai00-x-wb-tabs__close"
                    title={t('nav.workbenchWindow.tabs.closeTab')}
                    aria-label={t('nav.workbenchWindow.tabs.closeTab')}
                    onClick={() => onClose(tab.key)}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {onPickFile && (
          <button
            type="button"
            className="ai00-x-wb-tabs__add"
            title={t('nav.workbenchWindow.tabs.pickFile')}
            aria-label={t('nav.workbenchWindow.tabs.pickFile')}
            onClick={onPickFile}
          >
            <Plus size={13} />
          </button>
        )}
      </div>
      <div className="ai00-x-wb-tabs__panel" role="tabpanel">
        {children}
      </div>
    </section>
  );
};

export default WorkbenchTabs;
