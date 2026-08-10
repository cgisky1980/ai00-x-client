/**
 * HistoryView — Patina-style single-day history view.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ PageHeader (icon + title + date navigator)                          │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │ Horizontal timeline panel (24h track with segments)                │
 *   ├──────────────────────────┬──────────────────────────────────────────┤
 *   │ Day summary + Hourly     │ Day distribution (app/category toggle)   │
 *   │ activity chart           │                                          │
 *   └──────────────────────────┴──────────────────────────────────────────┘
 *
 * Ported from Patina's `features/history/components/History.tsx`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Clock, Tags } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import {
  usageStatsApi,
  localDateStr,
} from '@/infrastructure/api/usageStatsApi';
import type { TimelineItem, Category } from '@/infrastructure/api/usageStatsApi';
import { createLogger } from '@/shared/utils/logger';
import { buildHistoryReadModel } from './shared/historyReadModel';
import type { HistoryDistributionMode } from './shared/historyReadModel';
import { useIconThemeColors } from './shared/useIconThemeColors';
import HourlyActivityChart from './shared/HourlyActivityChart';
import type { HourlyActivityChartMode } from './shared/HourlyActivityChart';
import HistoryHorizontalTimeline from './shared/HistoryHorizontalTimeline';
import type { HistoryTimelineMode } from './shared/HistoryHorizontalTimeline';
import HistoryDaySummaryPanel from './shared/HistoryDaySummaryPanel';
import HistoryDayDistributionPanel from './shared/HistoryDayDistributionPanel';
import QuietIconAction from './shared/QuietIconAction';
import QuietPageHeader from './shared/QuietPageHeader';
import type { QuietSegmentedFilterOption } from './shared/QuietSegmentedFilter';

const log = createLogger('HistoryView');

function formatDateLabel(date: Date): string {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return `Today · ${localDateStr(date)}`;
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday · ${localDateStr(date)}`;
  }
  return localDateStr(date);
}

const HistoryView: React.FC = () => {
  const { t } = useI18n('common');
  const [date, setDate] = useState<Date>(new Date());
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hourlyMode, setHourlyMode] = useState<HourlyActivityChartMode>('total');
  const [timelineMode, setTimelineMode] = useState<HistoryTimelineMode>('app');
  const [distributionMode, setDistributionMode] =
    useState<HistoryDistributionMode>('app');

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const dateKey = localDateStr(date);
      const [tl, cats] = await Promise.all([
        usageStatsApi.timeline(dateKey),
        usageStatsApi.listCategories().catch(() => [] as Category[]),
      ]);
      setTimeline(tl);
      setCategories(cats);
    } catch (e) {
      log.error('Failed to load history data', e);
      setError(String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void fetchData(false);
  }, [fetchData]);

  const isToday = date.toDateString() === new Date().toDateString();

  const changeDate = (delta: number) => {
    const next = new Date(date);
    next.setDate(next.getDate() + delta);
    if (next > new Date()) return;
    setDate(next);
  };

  const history = useMemo(() => {
    if (loading && timeline.length === 0) return null;
    return buildHistoryReadModel(timeline, categories, date);
  }, [timeline, categories, date, loading]);

  const iconsMap = useMemo<Record<string, string | null>>(() => {
    const map: Record<string, string | null> = {};
    for (const seg of history?.timeline.segments ?? []) {
      map[seg.appKey] = seg.icon;
    }
    return map;
  }, [history]);

  const iconThemeColors = useIconThemeColors(iconsMap);

  const distributionItems = distributionMode === 'category'
    ? history?.categoryDistribution ?? []
    : history?.appDistribution ?? [];

  const distributionOptions: QuietSegmentedFilterOption<HistoryDistributionMode>[] = [
    {
      value: 'app',
      label: t('usageStats.distributionByApp', { defaultValue: 'App' }),
    },
    {
      value: 'category',
      label: t('usageStats.distributionByCategory', { defaultValue: 'Category' }),
    },
  ];

  if (loading && !history) {
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
  if (!history) {
    return (
      <div className="qp-error">
        <span>{t('usageStats.noData', { defaultValue: 'No data yet' })}</span>
      </div>
    );
  }

  const dateNavigator = (
    <div className="qp-history-date-nav">
      <button
        type="button"
        className="qp-history-date-nav__btn"
        onClick={() => changeDate(-1)}
        aria-label={t('usageStats.previousDay', { defaultValue: 'Previous day' })}
      >
        <ChevronLeft size={16} />
      </button>
      <div className="qp-history-date-nav__label-wrap">
        <Calendar size={14} />
        <span className="qp-history-date-nav__label">{formatDateLabel(date)}</span>
      </div>
      <button
        type="button"
        className="qp-history-date-nav__btn"
        onClick={() => changeDate(1)}
        disabled={isToday}
        aria-label={t('usageStats.nextDay', { defaultValue: 'Next day' })}
      >
        <ChevronRight size={16} />
      </button>
      {!isToday && (
        <button
          type="button"
          className="qp-history-date-nav__today"
          onClick={() => setDate(new Date())}
        >
          {t('usageStats.today', { defaultValue: 'Today' })}
        </button>
      )}
    </div>
  );

  const timelineActions = (
    <QuietIconAction
      icon={<Tags size={15} />}
      title={
        timelineMode === 'category'
          ? t('usageStats.showTimelineByApp', { defaultValue: 'Show timeline by app' })
          : t('usageStats.showTimelineByCategory', { defaultValue: 'Show timeline by category' })
      }
      pressed={timelineMode === 'category'}
      showTooltip={false}
      onClick={() => setTimelineMode(timelineMode === 'category' ? 'app' : 'category')}
    />
  );

  return (
    <div className="qp-history">
      <QuietPageHeader
        icon={<Clock size={18} />}
        title={t('usageStats.history', { defaultValue: 'History' })}
        subtitle={t('usageStats.historySubtitle', {
          defaultValue: 'Review your activity for any day',
        })}
        rightSlot={dateNavigator}
      />

      <div className="qp-panel qp-history__timeline-card">
        <HistoryHorizontalTimeline
          viewModel={history.timeline}
          mode={timelineMode}
          iconThemeColors={iconThemeColors}
          title={t('usageStats.timelineAxis', { defaultValue: 'Timeline' })}
          actions={timelineActions}
          showEmptyMessage
        />
      </div>

      <div className="qp-history__body">
        <div className="qp-history__left-column">
          <HistoryDaySummaryPanel view={history.daySummary} />
          <div className="qp-panel qp-history__hourly-card">
            <div className="qp-history__hourly-header">
              <h3 className="qp-history__hourly-title">
                {t('usageStats.hourlyActivity', { defaultValue: 'Hourly activity' })}
              </h3>
              <QuietIconAction
                icon={<Tags size={15} />}
                title={
                  hourlyMode === 'category'
                    ? t('usageStats.showTotalHourly', { defaultValue: 'Show total hourly activity' })
                    : t('usageStats.showByCategory', { defaultValue: 'Show hourly activity by category' })
                }
                pressed={hourlyMode === 'category'}
                showTooltip={false}
                onClick={() => setHourlyMode(hourlyMode === 'category' ? 'total' : 'category')}
              />
            </div>
            <div className="qp-history__hourly-chart">
              <HourlyActivityChart
                mode={hourlyMode}
                hourlyActivity={history.hourlyActivity}
                hourlyCategoryActivity={history.hourlyCategoryActivity}
                margin={{ top: 6, right: 12, left: 10, bottom: 4 }}
                padding={{ left: 12, right: 12 }}
              />
            </div>
          </div>
        </div>

        <div className="qp-panel qp-history__distribution-card">
          <HistoryDayDistributionPanel
            mode={distributionMode}
            modeOptions={distributionOptions}
            items={distributionItems}
            showQuietPlaceholder={loading && timeline.length === 0}
            onModeChange={setDistributionMode}
          />
        </div>
      </div>
    </div>
  );
};

export default HistoryView;
