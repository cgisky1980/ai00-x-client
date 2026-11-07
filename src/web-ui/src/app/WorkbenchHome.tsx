/**
 * WorkbenchHome — 工作台窗口首页（参照 DSH desktop 布局）。
 *
 * Hero（标题/副标题/「了解工作台开发」入口/搜索）+ 页签（市场 / 我的收藏 /
 * 已安装）+ 卡片网格。市场与收藏是预留 UI（对接后做，只留诚实空态）；
 * 「已安装」为真实数据（workbenchRegistry），点击卡片进入对应工作台页。
 * 搜索只作用于「已安装」：市场/收藏没有数据时不提供假筛选。
 */
import React, { useMemo, useState } from 'react';
import { Bookmark, LayoutGrid, Plus, Search, Store, X } from 'lucide-react';
import { EMBEDDED_SERVER_PORT } from '@ai00-x/shared';
import { Modal } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { WorkbenchEntry } from '@/infrastructure/plugins/workbenchRegistry';

type HomeTab = 'market' | 'favorites' | 'installed';

interface WorkbenchHomeProps {
  workbenches: WorkbenchEntry[];
  onOpen: (workbenchId: string) => void;
}

export const WorkbenchHome: React.FC<WorkbenchHomeProps> = ({ workbenches, onOpen }) => {
  const { t } = useI18n('common');
  const [tab, setTab] = useState<HomeTab>('installed');
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  /** 搜索只在「已安装」页签生效（其他页签没有真实数据）。 */
  const showSearch = tab === 'installed';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workbenches;
    return workbenches.filter(w =>
      [w.title, w.author, w.pluginId, w.description]
        .filter(Boolean)
        .some(text => text!.toLowerCase().includes(q)),
    );
  }, [workbenches, query]);

  const tabs: Array<{ id: HomeTab; label: string; count: number | null }> = [
    { id: 'market', label: t('nav.workbenchWindow.home.market'), count: null },
    { id: 'favorites', label: t('nav.workbenchWindow.home.favorites'), count: 0 },
    { id: 'installed', label: t('nav.workbenchWindow.home.installed'), count: workbenches.length },
  ];

  return (
    <div className="ai00-x-workbench-home">
      <header className="ai00-x-workbench-home__hero">
        <div className="ai00-x-workbench-home__hero-row">
          <h1 className="ai00-x-workbench-home__title">{t('nav.sections.workbench')}</h1>
          <button
            type="button"
            className="ai00-x-workbench-home__create"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} aria-hidden="true" />
            {t('nav.workbenchWindow.home.learnCreate')}
          </button>
        </div>
        <p className="ai00-x-workbench-home__subtitle">{t('nav.workbenchWindow.home.subtitle')}</p>
        {showSearch && (
          <div className="ai00-x-workbench-home__search">
            <Search size={14} aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('nav.workbenchWindow.home.searchPlaceholder')}
              aria-label={t('nav.workbenchWindow.home.searchPlaceholder')}
            />
            {query && (
              <button
                type="button"
                className="ai00-x-workbench-home__search-clear"
                onClick={() => setQuery('')}
                aria-label={t('nav.workbenchWindow.home.clearSearch')}
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}
      </header>

      <div className="ai00-x-workbench-home__tabs-row">
        <div className="ai00-x-workbench-home__tabs" role="tablist">
          {tabs.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`ai00-x-workbench-home__tab${tab === item.id ? ' is-active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {item.count !== null && (
                <span className="ai00-x-workbench-home__tab-count">({item.count})</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="ai00-x-workbench-home__content">
        {tab === 'market' && (
          <div className="ai00-x-workbench-home__empty">
            <Store size={28} aria-hidden="true" />
            <p>{t('nav.workbenchWindow.home.marketEmpty')}</p>
          </div>
        )}
        {tab === 'favorites' && (
          <div className="ai00-x-workbench-home__empty">
            <Bookmark size={28} aria-hidden="true" />
            <p>{t('nav.workbenchWindow.home.favoritesEmpty')}</p>
          </div>
        )}
        {tab === 'installed' && (
          filtered.length === 0 ? (
            <div className="ai00-x-workbench-home__empty">
              <LayoutGrid size={28} aria-hidden="true" />
              <p>{query ? t('nav.workbenchWindow.home.noMatch') : t('nav.workbenchWindow.empty')}</p>
            </div>
          ) : (
            <div className="ai00-x-workbench-home__grid">
              {filtered.map(w => (
                <button
                  key={w.id}
                  type="button"
                  className="ai00-x-workbench-home__card"
                  onClick={() => onOpen(w.id)}
                >
                  <span className="ai00-x-workbench-home__card-preview" aria-hidden="true">
                    {w.icon ? (
                      <img
                        src={`http://127.0.0.1:${EMBEDDED_SERVER_PORT}/plugins/${w.pluginId}/${w.icon.replace(/^\/+/, '')}`}
                        alt=""
                      />
                    ) : (
                      <LayoutGrid size={40} />
                    )}
                  </span>
                  <span className="ai00-x-workbench-home__card-body">
                    <span className="ai00-x-workbench-home__card-title">{w.title}</span>
                    <span className="ai00-x-workbench-home__card-meta">
                      {w.author || w.pluginId} · v{w.version}
                    </span>
                    {w.description && (
                      <span className="ai00-x-workbench-home__card-desc">{w.description}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )
        )}
      </div>

      <Modal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('nav.workbenchWindow.home.createDialogTitle')}
      >
        <p className="ai00-x-workbench-home__create-dialog-body">
          {t('nav.workbenchWindow.home.createDialogBody')}
        </p>
      </Modal>
    </div>
  );
};

export default WorkbenchHome;
