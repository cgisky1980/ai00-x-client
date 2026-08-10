/**
 * DashboardView — Patina-style today dashboard.
 *
 * Layout:
 *   ┌────────────────────────────┬───────────────────────────────┐
 *   │ Focus ring chart           │ Top Apps list (icon + progress │
 *   │ (category distribution)    │ bars via framer-motion)        │
 *   ├────────────────────────────┤                               │
 *   │ Hourly activity chart      │                               │
 *   │ (total / category toggle)   │                               │
 *   └────────────────────────────┴───────────────────────────────┘
 *
 * Ported from Patina's `features/dashboard/components/Dashboard.tsx`.
 */

import { motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Layers3, Monitor, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import {
  usageStatsApi,
  todayDateStr,
  daysAgoDateStr,
} from '@/infrastructure/api/usageStatsApi';
import type {
  Category,
  DaySummary,
  TimelineItem,
  TopAppItem,
} from '@/infrastructure/api/usageStatsApi';
import { createLogger } from '@/shared/utils/logger';
import {
  buildDashboardReadModel,
  formatDashboardDuration,
} from './shared/dashboardReadModel';
import type { DashboardReadModel } from './shared/dashboardReadModel';
import { useIconThemeColors } from './shared/useIconThemeColors';
import HourlyActivityChart from './shared/HourlyActivityChart';
import type { HourlyActivityChartMode } from './shared/HourlyActivityChart';
import QuietIconAction from './shared/QuietIconAction';
import QuietPageHeader from './shared/QuietPageHeader';

const log = createLogger('DashboardView');

const FOCUS_CATEGORY_LIMIT = 4;
const FOCUS_CATEGORY_EXPANDED_LIMIT = 6;
const FOCUS_CATEGORY_EXPANDED_WIDTH = 440;

function buildFocusCategoryDist(
  categoryDist: DashboardReadModel['categoryDist'],
  limit: number,
) {
  const visible = categoryDist.slice(0, limit);
  const rest = categoryDist.slice(limit);
  const restValue = rest.reduce((sum, item) => sum + item.value, 0);
  if (restValue <= 0) return visible;
  return [
    ...visible,
    {
      name: 'Other',
      value: restValue,
      color: 'var(--qp-text-tertiary)',
    },
  ];
}

const DashboardView: React.FC = () => {
  const { t } = useI18n('common');
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [yesterdaySummary, setYesterdaySummary] = useState<DaySummary | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [topApps, setTopApps] = useState<TopAppItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hourlyMode, setHourlyMode] = useState<HourlyActivityChartMode>('total');

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const today = todayDateStr();
      const yesterday = daysAgoDateStr(1);
      const [s, ys, tl, ta, cats] = await Promise.all([
        usageStatsApi.daySummary(),
        usageStatsApi.daySummary(yesterday).catch(() => null),
        usageStatsApi.timeline(),
        usageStatsApi.topApps(today, today, 10).catch(() => [] as TopAppItem[]),
        usageStatsApi.listCategories().catch(() => [] as Category[]),
      ]);
      setSummary(s);
      setYesterdaySummary(ys);
      setTimeline(tl);
      setTopApps(ta);
      setCategories(cats);
    } catch (e) {
      log.error('Failed to load dashboard data', e);
      setError(String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // Initial load + 60s polling; pause when tab hidden, resume with immediate refresh.
  useEffect(() => {
    void fetchData(false);
    const POLL_MS = 60_000;
    let timer = window.setInterval(() => void fetchData(true), POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        window.clearInterval(timer);
        void fetchData(true);
        timer = window.setInterval(() => void fetchData(true), POLL_MS);
      } else {
        window.clearInterval(timer);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const dashboard = useMemo<DashboardReadModel | null>(() => {
    if (!summary) return null;
    return buildDashboardReadModel(summary, timeline, topApps, categories, yesterdaySummary);
  }, [summary, timeline, topApps, categories, yesterdaySummary]);

  const iconsMap = useMemo<Record<string, string | null>>(() => {
    const map: Record<string, string | null> = {};
    for (const app of topApps) {
      map[app.exe_path] = app.icon;
    }
    return map;
  }, [topApps]);

  const iconThemeColors = useIconThemeColors(iconsMap);

  const focusCardRef = useRef<HTMLDivElement | null>(null);
  const [focusCategoryLimit, setFocusCategoryLimit] = useState(FOCUS_CATEGORY_LIMIT);

  useEffect(() => {
    const card = focusCardRef.current;
    if (!card) return;
    const updateLimit = (width: number) => {
      setFocusCategoryLimit(
        width >= FOCUS_CATEGORY_EXPANDED_WIDTH
          ? FOCUS_CATEGORY_EXPANDED_LIMIT
          : FOCUS_CATEGORY_LIMIT,
      );
    };
    updateLimit(card.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => updateLimit(entry.contentRect.width));
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  if (loading) {
    return (
      <div className="qp-loading">
        <div className="qp-loading__spinner" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="qp-error">
        <span>{error}</span>
      </div>
    );
  }
  if (!dashboard) {
    return (
      <div className="qp-error">
        <span>{t('usageStats.noData', { defaultValue: 'No data yet' })}</span>
      </div>
    );
  }

  const {
    totalTrackedTime,
    dayDeltaTrackedTime,
    topApplications,
    hourlyActivity,
    hourlyCategoryActivity,
    categoryDist,
  } = dashboard;

  const dayDeltaDirection =
    dayDeltaTrackedTime > 0 ? 'increase' : dayDeltaTrackedTime < 0 ? 'decrease' : 'same';
  const DayDeltaIcon =
    dayDeltaDirection === 'increase'
      ? TrendingUp
      : dayDeltaDirection === 'decrease'
        ? TrendingDown
        : Minus;
  const visibleCategoryDist = buildFocusCategoryDist(categoryDist, focusCategoryLimit);

  return (
    <div className="qp-dashboard">
      <QuietPageHeader
        icon={<Monitor size={18} />}
        title={t('usageStats.today', { defaultValue: 'Today' })}
        subtitle={t('usageStats.todaySubtitle', {
          defaultValue: 'Your activity overview for today',
        })}
      />

      <div className="qp-dashboard__workspace">
        <div className="qp-dashboard__left-column">
          <div ref={focusCardRef} className="qp-panel qp-dashboard__focus-card">
            <div className="qp-dashboard__card-header">
              <h3 className="qp-dashboard__card-title">
                {t('usageStats.focusShare', { defaultValue: 'Focus share' })}
              </h3>
            </div>
            <div className="qp-dashboard__focus-layout">
              <div className="qp-dashboard__focus-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={visibleCategoryDist}
                      innerRadius="68%"
                      outerRadius="100%"
                      paddingAngle={4}
                      dataKey="value"
                      startAngle={90}
                      endAngle={-270}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {visibleCategoryDist.map((item, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={item.color || 'var(--qp-accent-default)'}
                        />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="qp-dashboard__focus-total-center">
                  <span className="qp-dashboard__focus-total-value">
                    {formatDashboardDuration(totalTrackedTime)}
                  </span>
                  <span className="qp-dashboard__focus-total-label">
                    {t('usageStats.total', { defaultValue: 'Total' })}
                  </span>
                </div>
              </div>

              <div
                className="qp-dashboard__focus-ranking"
                aria-label={t('usageStats.focusShare', { defaultValue: 'Focus share' })}
              >
                {visibleCategoryDist.map((cat) => (
                  <div key={cat.name} className="qp-dashboard__focus-ranking-row">
                    <div className="qp-dashboard__focus-ranking-left">
                      <span
                        className="qp-dashboard__focus-ranking-dot"
                        style={{ backgroundColor: cat.color || 'var(--qp-accent-default)' }}
                      />
                      <span className="qp-dashboard__focus-ranking-name">{cat.name}</span>
                    </div>
                    <span className="qp-dashboard__focus-ranking-value">
                      {formatDashboardDuration(cat.value)}
                    </span>
                  </div>
                ))}
                {visibleCategoryDist.length === 0 && (
                  <div className="qp-dashboard__empty-state">
                    {t('usageStats.noData', { defaultValue: 'No data yet' })}
                  </div>
                )}
              </div>
            </div>
            <p className="qp-dashboard__focus-delta">
              <DayDeltaIcon size={12} strokeWidth={2} />
              {(() => {
                const absDelta = formatDashboardDuration(Math.abs(dayDeltaTrackedTime));
                if (dayDeltaDirection === 'increase') {
                  return t('usageStats.dayDeltaIncrease', {
                    defaultValue: `+${absDelta} vs yesterday`,
                    delta: absDelta,
                  });
                }
                if (dayDeltaDirection === 'decrease') {
                  return t('usageStats.dayDeltaDecrease', {
                    defaultValue: `-${absDelta} vs yesterday`,
                    delta: absDelta,
                  });
                }
                return t('usageStats.dayDeltaSame', {
                  defaultValue: 'Same as yesterday',
                });
              })()}
            </p>
          </div>

          <div className="qp-panel qp-dashboard__pulse-card">
            <div className="qp-dashboard__card-header">
              <h3 className="qp-dashboard__card-title">
                {t('usageStats.hourlyActivity', { defaultValue: 'Hourly activity' })}
              </h3>
              <QuietIconAction
                icon={<Layers3 size={15} />}
                title={
                  hourlyMode === 'category'
                    ? t('usageStats.showTotalHourly', {
                        defaultValue: 'Show total hourly activity',
                      })
                    : t('usageStats.showByCategory', {
                        defaultValue: 'Show hourly activity by category',
                      })
                }
                pressed={hourlyMode === 'category'}
                showTooltip={false}
                onClick={() =>
                  setHourlyMode(hourlyMode === 'category' ? 'total' : 'category')
                }
              />
            </div>
            <div className="qp-dashboard__pulse-chart">
              <HourlyActivityChart
                mode={hourlyMode}
                hourlyActivity={hourlyActivity}
                hourlyCategoryActivity={hourlyCategoryActivity}
                margin={{ top: 6, right: 12, left: 10, bottom: 4 }}
                padding={{ left: 12, right: 12 }}
              />
            </div>
          </div>
        </div>

        <div className="qp-panel qp-dashboard__top-apps">
          <header className="qp-dashboard__card-header">
            <h3 className="qp-dashboard__card-title">
              {t('usageStats.topApps', { defaultValue: 'Top apps' })}
            </h3>
            <div className="qp-dashboard__chip">
              {t('usageStats.topAppsBadge', {
                defaultValue: '{{count}} apps',
                count: topApplications.length,
              })}
            </div>
          </header>

          <div className="qp-dashboard__top-apps-list">
            {topApplications.length === 0 && (
              <div className="qp-dashboard__empty-state qp-dashboard__empty-state--centered">
                <Monitor size={32} className="qp-dashboard__empty-icon" />
                <p>{t('usageStats.noData', { defaultValue: 'No data yet' })}</p>
              </div>
            )}
            {topApplications.map((app) => {
              const accentColor =
                iconThemeColors[app.exeName] ?? app.color ?? 'var(--qp-accent-default)';
              return (
                <div key={app.exeName} className="qp-dashboard__top-app-row">
                  <div className="qp-dashboard__top-app-left">
                    <div
                      className="qp-dashboard__top-app-icon"
                      style={{ boxShadow: `0 0 0 2px ${accentColor}22` }}
                    >
                      {iconsMap[app.exeName] ? (
                        <img
                          src={iconsMap[app.exeName] ?? ''}
                          alt=""
                          className="qp-dashboard__top-app-img"
                        />
                      ) : (
                        <span className="qp-dashboard__top-app-fallback">
                          {app.categoryInitial}
                        </span>
                      )}
                    </div>
                    <div className="qp-dashboard__top-app-info">
                      <span className="qp-dashboard__top-app-name">{app.name}</span>
                      <span className="qp-dashboard__top-app-pct">
                        {t('usageStats.sharePrefix', { defaultValue: 'Share' })}{' '}
                        {app.percentage}%
                      </span>
                    </div>
                  </div>
                  <div className="qp-dashboard__top-app-right">
                    <div className="qp-dashboard__top-app-duration">
                      {formatDashboardDuration(app.duration)}
                    </div>
                    <div className="qp-dashboard__top-app-bar">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${app.percentage}%` }}
                        transition={{ duration: 0.22, ease: 'easeOut' }}
                        className="qp-dashboard__top-app-bar-fill"
                        style={{ backgroundColor: accentColor }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DashboardView;
