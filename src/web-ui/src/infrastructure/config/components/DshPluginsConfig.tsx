import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ChevronDown,
  Download,
  PackagePlus,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Button, Input, ConfirmDialog } from '@/component-library';
import {
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageContent,
  ConfigPageSection,
} from './common';
import { useNotification } from '@/shared/notification-system';
import {
  dshPlugins,
  pluginInventoryList,
  type DshPluginInventoryEntry,
  type DshPluginManifestEntry,
} from '@/infrastructure/api/service-api/DshAPI';
import {
  listMarketItems,
  getMarketItem,
  type DshMarketItem,
} from '@/infrastructure/api/service-api/DshMarketApi';
import './DshPluginsConfig.scss';

/** 运行时状态聚合（pluginInventory 按 moduleName 去重取最差状态）。 */
type RunState = 'active' | 'failed' | 'disabled' | 'unknown';

function aggregateRunState(inventory: DshPluginInventoryEntry[], moduleName: string): RunState {
  const hits = inventory.filter(e => e.moduleName === moduleName);
  if (hits.length === 0) return 'unknown';
  if (hits.some(e => e.fiberPhase === 'failed')) return 'failed';
  if (hits.some(e => e.fiberPhase === 'active')) return 'active';
  if (hits.every(e => !e.enabled)) return 'disabled';
  return 'unknown';
}

/** 市场排序：装得多的优先，其次最近更新。 */
type MarketSort = 'installs' | 'updated';

interface MarketDetail {
  descriptionMd: string;
  homepage: string;
  repoUrl: string;
  versions: Array<{ version: string; npmSpec: string }>;
}

/** 安装确认目标：npmSpec 精确到版本行（缺省装 latest）。 */
interface InstallTarget {
  item: DshMarketItem;
  npmSpec?: string;
}

const DshPluginsConfig: React.FC = () => {
  const { t } = useTranslation('settings/dsh-plugins');
  const notification = useNotification();

  // 已装扩展（manifest 层）
  const [manifestPlugins, setManifestPlugins] = useState<DshPluginManifestEntry[]>([]);
  const [inventory, setInventory] = useState<DshPluginInventoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [installSpec, setInstallSpec] = useState('');
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [togglingEnabled, setTogglingEnabled] = useState<string | null>(null);
  const [showComponents, setShowComponents] = useState(false);
  /** 来自 Agent 场景横幅「前往插件设置」的高亮目标（自动消退）。 */
  const [highlightName, setHighlightName] = useState<string | null>(null);

  // 插件市场
  const [marketItems, setMarketItems] = useState<DshMarketItem[]>([]);
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sort, setSort] = useState<MarketSort>('installs');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, MarketDetail>>({});
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<InstallTarget | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [list, inv] = await Promise.all([
        dshPlugins.list(),
        pluginInventoryList().catch(() => [] as DshPluginInventoryEntry[]),
      ]);
      setManifestPlugins(list);
      setInventory(inv);
    } catch (err) {
      notification.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [notification]);

  /** 市场列表加载（公开接口，失败静默降级为空态文案）。 */
  const loadMarket = useCallback(async () => {
    try {
      setMarketLoading(true);
      setMarketError(null);
      setMarketItems(await listMarketItems());
    } catch (err) {
      setMarketError(err instanceof Error ? err.message : String(err));
    } finally {
      setMarketLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadMarket(); }, [loadMarket]);

  // Agent 场景横幅「前往插件设置」跨组件高亮信号（window 事件，避免 app↔infra 循环依赖）
  useEffect(() => {
    const onHighlight = (e: Event) => {
      const name = (e as CustomEvent<string | null>).detail;
      if (name) setHighlightName(name);
    };
    window.addEventListener('dsh-plugin-highlight', onHighlight);
    return () => window.removeEventListener('dsh-plugin-highlight', onHighlight);
  }, []);

  useEffect(() => {
    if (!highlightName) return;
    const timer = window.setTimeout(() => setHighlightName(null), 8000);
    return () => window.clearTimeout(timer);
  }, [highlightName]);

  /** 展开卡片时按需拉详情（含版本历史）。 */
  const toggleExpand = async (item: DshMarketItem) => {
    if (expandedId === item.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(item.id);
    if (!details[item.id]) {
      try {
        const d = await getMarketItem(item.id);
        setDetails(prev => ({
          ...prev,
          [item.id]: {
            descriptionMd: d.package.descriptionMd,
            homepage: d.package.homepage,
            repoUrl: d.package.repoUrl,
            versions: d.versions.filter(v => !!v.npmSpec),
          },
        }));
      } catch {
        /* 详情拉取失败不阻塞浏览 */
      }
    }
  };

  const handleInstall = async () => {
    const spec = installSpec.trim();
    if (!spec) return;
    try {
      setInstalling(true);
      await dshPlugins.install(spec);
      notification.success(t('messages.installSuccess', { spec }));
      setInstallSpec('');
      await load();
    } catch (err) {
      notification.error(t('messages.installFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setInstalling(false);
    }
  };

  /**
   * 市场一键安装（verified 链路）：npmSpec 只取自服务端详情版本行，
   * 拒绝使用任何用户手输 spec。
   */
  const doInstallVerified = async (target: InstallTarget) => {
    const { item, npmSpec: specOverride } = target;
    try {
      setInstallingId(item.id);
      let npmSpec =
        specOverride ??
        details[item.id]?.versions.find(v => v.version === item.latestVersion)?.npmSpec;
      if (!npmSpec) {
        const fresh = await getMarketItem(item.id);
        npmSpec = fresh.versions.find(v => v.version === item.latestVersion)?.npmSpec;
      }
      if (!npmSpec) throw new Error(t('messages.noApprovedVersion'));
      await dshPlugins.install(npmSpec);
      notification.success(t('messages.marketInstallSuccess', { title: item.title }));
      setExpandedId(null);
      await load();
    } catch (err) {
      notification.error(t('messages.installFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setInstallingId(null);
      setConfirmTarget(null);
    }
  };

  const handleRemove = async (plugin: DshPluginManifestEntry) => {
    try {
      setRemoving(plugin.name);
      await dshPlugins.remove(plugin.name);
      notification.success(t('messages.removeSuccess', { name: plugin.name }));
      await load();
    } catch (err) {
      notification.error(t('messages.removeFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRemoving(null);
    }
  };

  /** 一键停用/启用（bundles 摘除/加回 + 引擎重启；依赖保留不卸载）。 */
  const handleSetEnabled = async (plugin: DshPluginManifestEntry) => {
    try {
      setTogglingEnabled(plugin.name);
      await dshPlugins.setEnabled(plugin.name, !plugin.inBundles);
      notification.success(
        plugin.inBundles
          ? t('messages.disableSuccess', { name: plugin.name })
          : t('messages.enableSuccess', { name: plugin.name }),
      );
      await load();
    } catch (err) {
      notification.error(t('messages.toggleFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setTogglingEnabled(null);
    }
  };

  /** 引擎组件（运行时快照，去重聚合）。 */
  const components = useMemo(() => {
    const byName = new Map<string, RunState>();
    for (const e of inventory) {
      const cur = byName.get(e.moduleName);
      const next = aggregateRunState(inventory, e.moduleName);
      if (cur !== 'failed') byName.set(e.moduleName, next);
    }
    return Array.from(byName.entries())
      .map(([name, state]) => ({ name, state }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [inventory]);

  const failedComponents = components.filter(c => c.state === 'failed');

  const installedIds = useMemo(
    () => new Set(manifestPlugins.map(p => p.name)),
    [manifestPlugins],
  );

  /** 市场列表：本地搜索 / 标签 / 排序（一期目录量小，避免额外请求）。 */
  const filteredMarket = useMemo(() => {
    const kw = searchText.trim().toLowerCase();
    const items = marketItems.filter(it => {
      if (activeTag && !it.tags.includes(activeTag)) return false;
      if (!kw) return true;
      return (
        it.title.toLowerCase().includes(kw) ||
        it.summary.toLowerCase().includes(kw) ||
        it.id.toLowerCase().includes(kw)
      );
    });
    return items.sort((a, b) =>
      sort === 'installs'
        ? b.installedCount - a.installedCount || b.updatedAt - a.updatedAt
        : b.updatedAt - a.updatedAt || b.installedCount - a.installedCount,
    );
  }, [marketItems, searchText, activeTag, sort]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const it of marketItems) for (const tg of it.tags) s.add(tg);
    return Array.from(s).sort();
  }, [marketItems]);

  return (
    <ConfigPageLayout>
      <ConfigPageContent>
        <ConfigPageHeader
          title={t('title')}
          subtitle={t('subtitle')}
        />

        <ConfigPageSection
          title={t('market.title')}
          description={t('market.description')}
        >
          <div className="dsh-plugins-config">
            <div className="dsh-plugins-config__toolbar dsh-plugins-config__toolbar--market">
              <Input
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                placeholder={t('market.searchPlaceholder')}
              />
              <Button
                variant="ghost"
                size="small"
                onClick={() => setSort(s => (s === 'installs' ? 'updated' : 'installs'))}
              >
                {t(`market.sort.${sort}`)}
              </Button>
              <Button variant="ghost" size="small" onClick={loadMarket} disabled={marketLoading}>
                <RefreshCw size={13} className={marketLoading ? 'is-spinning' : undefined} />
                {t('actions.refresh')}
              </Button>
            </div>

            {allTags.length > 0 && (
              <div className="dsh-plugins-config__tag-filter">
                <button
                  type="button"
                  className={`dsh-plugins-config__tag-chip ${activeTag === null ? 'is-active' : ''}`}
                  onClick={() => setActiveTag(null)}
                >
                  {t('market.allTags')}
                </button>
                {allTags.map(tg => (
                  <button
                    key={tg}
                    type="button"
                    className={`dsh-plugins-config__tag-chip ${activeTag === tg ? 'is-active' : ''}`}
                    onClick={() => setActiveTag(cur => (cur === tg ? null : tg))}
                  >
                    {tg}
                  </button>
                ))}
              </div>
            )}

            {marketLoading && (
              <div className="dsh-plugins-config__empty">{t('market.loading')}</div>
            )}
            {!marketLoading && marketError && (
              <div className="dsh-plugins-config__empty">{t('market.loadFailed')}</div>
            )}
            {!marketLoading && !marketError && filteredMarket.length === 0 && (
              <div className="dsh-plugins-config__empty">{t('market.empty')}</div>
            )}

            {filteredMarket.map(item => {
              const installed = installedIds.has(item.id);
              const detail = details[item.id];
              const unhealthy = item.failReportCount > 0;
              return (
                <div key={item.id} className="dsh-plugins-config__market-card">
                  <button
                    type="button"
                    className="dsh-plugins-config__market-main"
                    onClick={() => toggleExpand(item)}
                  >
                    <span className="dsh-plugins-config__market-title">{item.title}</span>
                    <span className="dsh-plugins-config__market-id">{item.id}</span>
                    {item.summary && (
                      <span className="dsh-plugins-config__market-summary">{item.summary}</span>
                    )}
                    <span className="dsh-plugins-config__item-tags">
                      {item.permissions.map(p => (
                        <span key={p} className="dsh-plugins-config__tag is-permission">
                          <ShieldCheck size={10} />
                          {t(`market.permissions.${p}`, { defaultValue: p })}
                        </span>
                      ))}
                      {item.tags.map(tg => (
                        <span key={tg} className="dsh-plugins-config__tag">{tg}</span>
                      ))}
                      <span className="dsh-plugins-config__count">
                        {t('market.installs', { count: item.installedCount })}
                      </span>
                      {unhealthy && (
                        <span className="dsh-plugins-config__count is-warn">
                          <AlertTriangle size={10} />
                          {t('market.failReports', { count: item.failReportCount })}
                        </span>
                      )}
                    </span>
                  </button>
                  {installed ? (
                    <span className="dsh-plugins-config__tag is-installed">
                      <ShieldCheck size={10} />
                      {t('market.installed')}
                    </span>
                  ) : (
                    <Button
                      variant="primary"
                      size="small"
                      disabled={installingId === item.id}
                      onClick={() =>
                        item.permissions.length > 0
                          ? setConfirmTarget({ item })
                          : doInstallVerified({ item })
                      }
                    >
                      <Download size={13} />
                      {installingId === item.id ? t('install.installing') : t('market.install')}
                    </Button>
                  )}

                  {expandedId === item.id && (
                    <div className="dsh-plugins-config__market-detail">
                      {detail?.descriptionMd ? (
                        <pre className="dsh-plugins-config__market-desc">{detail.descriptionMd}</pre>
                      ) : (
                        <p className="dsh-plugins-config__hint">{t('market.noDescription')}</p>
                      )}
                      {(detail?.homepage || detail?.repoUrl) && (
                        <p className="dsh-plugins-config__market-links">
                          {detail.homepage && (
                            <a href={detail.homepage} target="_blank" rel="noreferrer">
                              {t('market.homepage')}
                            </a>
                          )}
                          {detail.repoUrl && (
                            <a href={detail.repoUrl} target="_blank" rel="noreferrer">
                              {t('market.repo')}
                            </a>
                          )}
                        </p>
                      )}
                      {detail?.versions && detail.versions.length > 0 && (
                        <ul className="dsh-plugins-config__market-versions">
                          {detail.versions.slice(0, 5).map(v => (
                            <li key={v.version}>
                              <code>{v.npmSpec}</code>
                              {!installed && (
                                <Button
                                  variant="ghost"
                                  size="small"
                                  onClick={() => setConfirmTarget({ item, npmSpec: v.npmSpec })}
                                >
                                  {v.version === item.latestVersion ? t('market.install') : t('market.installThisVersion')}
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('extensions.title')}
          description={t('extensions.description')}
        >
          <div className="dsh-plugins-config">
            <div className="dsh-plugins-config__toolbar">
              <Button variant="ghost" size="small" onClick={load} disabled={loading}>
                <RefreshCw size={13} className={loading ? 'is-spinning' : undefined} />
                {t('actions.refresh')}
              </Button>
            </div>

            {manifestPlugins.length === 0 && !loading && (
              <div className="dsh-plugins-config__empty">{t('extensions.empty')}</div>
            )}

            {manifestPlugins.map(p => {
              const runState = aggregateRunState(inventory, p.name);
              const isHighlighted = p.name === highlightName;
              return (
                <div
                  key={p.name}
                  className={`dsh-plugins-config__item${isHighlighted ? ' is-highlighted' : ''}`}
                >
                  <div className="dsh-plugins-config__item-main">
                    <span className="dsh-plugins-config__item-name">{p.name}</span>
                    <div className="dsh-plugins-config__item-tags">
                      {p.bundled && (
                        <span className="dsh-plugins-config__tag is-bundled">
                          <ShieldCheck size={10} />
                          {t('extensions.bundled')}
                        </span>
                      )}
                      {p.inBundles ? (
                        <span className={`dsh-plugins-config__tag is-${runState}`}>
                          {t(`extensions.state.${runState}`)}
                        </span>
                      ) : (
                        <span className="dsh-plugins-config__tag is-unknown">
                          {t('extensions.state.notLoaded')}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="dsh-plugins-config__item-spec">{p.spec}</div>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => handleSetEnabled(p)}
                    disabled={p.bundled || togglingEnabled === p.name}
                    aria-label={p.inBundles ? t('actions.disable') : t('actions.enable')}
                  >
                    {p.inBundles ? (
                      <>
                        <Pause size={13} />
                        {t('actions.disable')}
                      </>
                    ) : (
                      <>
                        <Play size={13} />
                        {t('actions.enable')}
                      </>
                    )}
                  </Button>
                  {!p.bundled && (
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => handleRemove(p)}
                      disabled={removing === p.name}
                      aria-label={t('actions.remove')}
                    >
                      <Trash2 size={13} />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('install.title')}
          description={t('install.description')}
        >
          <div className="dsh-plugins-config__install">
            <Input
              value={installSpec}
              onChange={e => setInstallSpec(e.target.value)}
              placeholder={t('install.placeholder')}
              onKeyDown={e => {
                if (e.key === 'Enter' && !installing) handleInstall();
              }}
            />
            <Button
              variant="primary"
              size="small"
              onClick={handleInstall}
              disabled={installing || !installSpec.trim()}
            >
              <PackagePlus size={13} />
              {installing ? t('install.installing') : t('install.install')}
            </Button>
          </div>
          <p className="dsh-plugins-config__hint">{t('install.restartHint')}</p>
        </ConfigPageSection>

        {failedComponents.length > 0 && (
          <div className="dsh-plugins-config__failed-banner">
            {t('components.failedBanner', { count: failedComponents.length })}
            <ul>
              {failedComponents.map(c => (
                <li key={c.name}>{c.name}</li>
              ))}
            </ul>
          </div>
        )}

        <ConfigPageSection
          title={t('components.title')}
          description={t('components.description')}
        >
          <button
            type="button"
            className="dsh-plugins-config__components-toggle"
            onClick={() => setShowComponents(v => !v)}
          >
            {t('components.toggle', {
              total: components.length,
              failed: failedComponents.length,
            })}
            <ChevronDown
              size={14}
              className={showComponents ? 'is-open' : undefined}
            />
          </button>
          {showComponents && (
            <div className="dsh-plugins-config__components">
              {components.map(c => (
                <div
                  key={c.name}
                  className={`dsh-plugins-config__component is-${c.state}`}
                >
                  <span className="dsh-plugins-config__component-name">{c.name}</span>
                  <span className={`dsh-plugins-config__component-state is-${c.state}`}>
                    {t(`extensions.state.${c.state === 'disabled' ? 'notLoaded' : c.state === 'unknown' ? 'notLoaded' : c.state}`)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </ConfigPageSection>
      </ConfigPageContent>

      {/* 权限确认：市场插件声明了宿主能力（通知/壁纸/待办/XP/工具），装机前明示 */}
      <ConfirmDialog
        isOpen={confirmTarget !== null}
        onClose={() => setConfirmTarget(null)}
        onConfirm={() => confirmTarget && doInstallVerified(confirmTarget)}
        title={t('market.confirmTitle')}
        message={
          <>
            <p>{t('market.confirmIntro', { title: confirmTarget?.item.title ?? '' })}</p>
            {confirmTarget && confirmTarget.item.permissions.length > 0 && (
              <ul className="dsh-plugins-config__confirm-perms">
                {confirmTarget.item.permissions.map(p => (
                  <li key={p}>{t(`market.permissions.${p}`, { defaultValue: p })}</li>
                ))}
              </ul>
            )}
          </>
        }
        confirmText={t('market.confirmInstall')}
        cancelText={t('market.cancel')}
      />
    </ConfigPageLayout>
  );
};

export default DshPluginsConfig;
