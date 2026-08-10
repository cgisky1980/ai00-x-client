/**
 * DataTrendsView — Patina-style data view.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ PageHeader (icon + title + range selector)                          │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │ Trend panel (AreaChart + inline metrics: Total / Daily Avg)         │
 *   │   + 4-column metric strip (Total / Daily Avg / Active Days / Peak)  │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │ Calendar heatmap (weeks × 7 days + month labels, GitHub style)     │
 *   │   + Top apps panel (animated bars)                                  │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Adapted from Patina's `features/data/components/Data.tsx`. The calendar
 * heatmap is built from the trends API (per-day totals) rather than the
 * 7×24 hourly heatmap, matching Patina's GitHub-style calendar grid.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { BarChart3, CalendarDays, Clock3, Monitor } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import {
  usageStatsApi,
  formatDuration,
  todayDateStr,
  daysAgoDateStr,
} from '@/infrastructure/api/usageStatsApi';
import type {
  TopAppItem,
  TrendItem,
} from '@/infrastructure/api/usageStatsApi';
import { createLogger } from '@/shared/utils/logger';
import { useIconThemeColors } from './shared/useIconThemeColors';
import QuietChartTooltip from './shared/QuietChartTooltip';
import QuietPageHeader from './shared/QuietPageHeader';
import QuietSegmentedFilter from './shared/QuietSegmentedFilter';
import type { QuietSegmentedFilterOption } from './shared/QuietSegmentedFilter';

const log = createLogger('DataTrendsView');

type RangeDays = '7' | '14' | '30' | '90';

const RANGE_OPTIONS: QuietSegmentedFilterOption<RangeDays>[] = [
  { value: '7', label: '7d' },
  { value: '14', label: '14d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
];

// Calendar heatmap always shows a full year (GitHub-style), independent of
// the range selector (which only drives the trend chart + top apps).
const CALENDAR_DAYS = 365;

function parseRangeDays(v: RangeDays): number {
  return Number(v);
}

function formatHours(secs: number): number {
  return Math.round((secs / 3600) * 10) / 10;
}

function formatChartHours(value: number): string {
  if (value <= 0) return '0h';
  if (value < 1) return '<1h';
  return `${value}h`;
}

function formatTrendDateLabel(date: string): string {
  // date format: "YYYY-MM-DD" → "MM/DD"
  return date.slice(5).replace('-', '/');
}

function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatMonthLabel(month: number, locale: string): string {
  return new Date(2000, month, 1).toLocaleString(locale, { month: 'short' });
}

// Fill in missing dates between start and end (inclusive) with zero-valued
// TrendItems, so the trend chart shows a continuous axis instead of gaps.
function fillMissingDates(
  trends: TrendItem[],
  start: string,
  end: string,
): TrendItem[] {
  if (trends.length === 0) return trends;
  const map = new Map(trends.map((t) => [t.date, t]));
  const out: TrendItem[] = [];
  const cursor = new Date(`${start}T00:00:00`);
  const endD = new Date(`${end}T00:00:00`);
  while (cursor <= endD) {
    const key = formatDateKey(cursor);
    const existing = map.get(key);
    if (existing) {
      out.push(existing);
    } else {
      out.push({
        date: key,
        total_active_secs: 0,
        total_afk_secs: 0,
        app_count: 0,
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

// Calendar cell for GitHub-style heatmap (one cell = one day)
interface CalendarCell {
  date: string;
  secs: number;
  isFuture: boolean;
  isOutside: boolean;
}

interface CalendarWeek {
  cells: CalendarCell[];
  monthLabel: string;
}

function buildCalendarWeeks(
  trends: TrendItem[],
  rangeDays: number,
  locale: string,
): CalendarWeek[] {
  if (trends.length === 0) return [];

  const dateSecs = new Map<string, number>();
  for (const t of trends) {
    dateSecs.set(t.date, t.total_active_secs);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = new Date(today);
  start.setDate(start.getDate() - rangeDays + 1);

  // Align to Sunday of the week containing `start`
  const startSunday = new Date(start);
  startSunday.setDate(start.getDate() - start.getDay());

  const weeks: CalendarWeek[] = [];
  const cursor = new Date(startSunday);
  let lastMonth = -1;

  while (cursor <= today) {
    const cells: CalendarCell[] = [];
    for (let d = 0; d < 7; d++) {
      const dateStr = formatDateKey(cursor);
      const isFuture = cursor > today;
      const isOutside = !isFuture && cursor < start;
      const secs = dateSecs.get(dateStr) ?? 0;
      cells.push({ date: dateStr, secs, isFuture, isOutside });
      cursor.setDate(cursor.getDate() + 1);
    }

    // Month label: show when month changes (use first in-range cell's month)
    const repCell = cells.find((c) => !c.isOutside && !c.isFuture) ?? cells[0];
    const repMonth = new Date(repCell.date).getMonth();
    const monthLabel =
      repMonth !== lastMonth ? formatMonthLabel(repMonth, locale) : '';
    if (repMonth !== lastMonth) lastMonth = repMonth;

    weeks.push({ cells, monthLabel });
  }

  return weeks;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DataTrendsView: React.FC = () => {
  const { t, currentLanguage } = useI18n('common');
  const locale = currentLanguage === 'zh-CN' ? 'zh-CN' : 'en-US';
  const [range, setRange] = useState<RangeDays>('14');
  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [calendarTrends, setCalendarTrends] = useState<TrendItem[]>([]);
  const [topApps, setTopApps] = useState<TopAppItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const days = parseRangeDays(range);
      const start = daysAgoDateStr(days - 1);
      const end = todayDateStr();
      // Calendar heatmap fetches a full year independently so the grid is
      // always "filled" (GitHub-style), regardless of the range selector.
      const calStart = daysAgoDateStr(CALENDAR_DAYS - 1);
      const [tr, ta, calTr] = await Promise.all([
        usageStatsApi.trends(start, end),
        usageStatsApi.topApps(start, end, 10),
        usageStatsApi.trends(calStart, end),
      ]);
      setTrends(tr);
      setTopApps(ta);
      setCalendarTrends(calTr);
    } catch (e) {
      log.error('Failed to load trends data', e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Chart data — fill missing dates with 0 so the area chart shows a
  // continuous axis (no gaps at the start of the range).
  const chartData = useMemo(() => {
    const days = parseRangeDays(range);
    const start = daysAgoDateStr(days - 1);
    const end = todayDateStr();
    const filled = fillMissingDates(trends, start, end);
    return filled.map((d) => ({
      label: formatTrendDateLabel(d.date),
      date: d.date,
      hours: formatHours(d.total_active_secs),
      total_active_secs: d.total_active_secs,
    }));
  }, [trends, range]);

  const yDomain = useMemo(() => {
    const maxHours = Math.max(1, ...chartData.map((d) => d.hours));
    const top = Math.ceil(maxHours) + 1;
    return { domainMax: top, ticks: [0, Math.ceil(top / 2), top] };
  }, [chartData]);

  // Calendar heatmap (GitHub style) — always a full year, independent of
  // the range selector.
  const calendarWeeks = useMemo(
    () => buildCalendarWeeks(calendarTrends, CALENDAR_DAYS, locale),
    [calendarTrends, locale],
  );

  const heatmapMaxSecs = useMemo(() => {
    let max = 0;
    for (const w of calendarWeeks) {
      for (const c of w.cells) {
        if (!c.isOutside && !c.isFuture && c.secs > max) max = c.secs;
      }
    }
    return max;
  }, [calendarWeeks]);

  const heatmapIntensityFor = (secs: number): number => {
    if (secs <= 0) return 0;
    const ratio = Math.min(secs / Math.max(heatmapMaxSecs, 1), 1);
    // Patina: 0.22~0.88 continuous scale
    return Math.max(0.22, ratio * 0.88);
  };

  // Metric strip aggregates — use the filled (zero-padded) range so daily
  // average divides by the full range length, not just active days.
  const filledTrends = useMemo(() => {
    const days = parseRangeDays(range);
    const start = daysAgoDateStr(days - 1);
    const end = todayDateStr();
    return fillMissingDates(trends, start, end);
  }, [trends, range]);

  const totalActiveSecs = useMemo(
    () => filledTrends.reduce((s, x) => s + x.total_active_secs, 0),
    [filledTrends],
  );
  const dailyAverageSecs =
    filledTrends.length > 0 ? totalActiveSecs / filledTrends.length : 0;
  const activeDays = filledTrends.filter((d) => d.total_active_secs > 60).length; // >1min
  const peakDay = useMemo(() => {
    if (filledTrends.length === 0) return null;
    let peak = filledTrends[0];
    for (const t of filledTrends) {
      if (t.total_active_secs > peak.total_active_secs) peak = t;
    }
    return peak;
  }, [filledTrends]);

  // Icons
  const iconsMap = useMemo<Record<string, string | null>>(() => {
    const map: Record<string, string | null> = {};
    for (const app of topApps) map[app.exe_path] = app.icon;
    return map;
  }, [topApps]);
  const iconThemeColors = useIconThemeColors(iconsMap);

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

  return (
    <div className="qp-data">
      <QuietPageHeader
        icon={<BarChart3 size={18} />}
        title={t('usageStats.data', { defaultValue: 'Data' })}
        subtitle={t('usageStats.dataSubtitle', {
          defaultValue: 'Daily activity over the selected range',
        })}
        rightSlot={
          <QuietSegmentedFilter
            value={range}
            options={RANGE_OPTIONS}
            onChange={(v) => setRange(v)}
            className="qp-data__range-switch"
          />
        }
      />

      {/* Trend panel with inline metrics + metric strip */}
      <div className="qp-panel qp-data__trend-card">
        <div className="qp-data__trend-header">
          <h3 className="qp-data__trend-title">
            {t('usageStats.activityTrend', { defaultValue: 'Activity Trend' })}
          </h3>
          <div className="qp-data__trend-inline-metrics">
            <div className="qp-data__trend-inline-metric">
              <Clock3 size={13} />
              <span>{t('usageStats.total', { defaultValue: 'Total' })}</span>
              <strong>{formatDuration(totalActiveSecs)}</strong>
            </div>
            <div className="qp-data__trend-inline-metric">
              <CalendarDays size={13} />
              <span>{t('usageStats.dailyAverage', { defaultValue: 'Daily Avg' })}</span>
              <strong>{formatDuration(dailyAverageSecs)}</strong>
            </div>
          </div>
        </div>
        <div className="qp-data__trend-chart">
          {chartData.length === 0 ? (
            <p className="qp-data__empty">
              {t('usageStats.noDataForRange', { defaultValue: 'No data for this range' })}
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 22, left: -18, bottom: 0 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--qp-chart-grid)"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'var(--qp-text-tertiary)' }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--qp-text-tertiary)' }}
                  axisLine={false}
                  tickLine={false}
                  ticks={yDomain.ticks}
                  domain={[0, yDomain.domainMax]}
                  tickFormatter={(value) => formatChartHours(Number(value))}
                />
                <Tooltip
                  cursor={{ stroke: 'var(--qp-accent-default)', strokeWidth: 1 }}
                  content={(innerProps) => (
                    <QuietChartTooltip
                      {...innerProps}
                      formatter={(_value, _name, item) => {
                        const secs = Number(
                          item?.payload &&
                            (item.payload as { total_active_secs?: number })
                              .total_active_secs,
                        ) || 0;
                        return [
                          formatDuration(secs),
                          t('usageStats.activeTime', {
                            defaultValue: 'Active time',
                          }),
                        ];
                      }}
                      labelFormatter={(label) => String(label)}
                    />
                  )}
                />
                <Area
                  type="monotone"
                  dataKey="hours"
                  stroke="var(--qp-accent-default)"
                  strokeWidth={2}
                  fill="var(--qp-accent-default)"
                  fillOpacity={0.12}
                  dot={{ fill: 'var(--qp-accent-default)', r: 3 }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* 4-column metric strip */}
        {filledTrends.length > 0 && (
          <div className="qp-data__metric-strip">
            <div className="qp-data__metric">
              <span>{t('usageStats.total', { defaultValue: 'Total' })}</span>
              <strong>{formatDuration(totalActiveSecs)}</strong>
            </div>
            <div className="qp-data__metric">
              <span>{t('usageStats.dailyAverage', { defaultValue: 'Daily Avg' })}</span>
              <strong>{formatDuration(dailyAverageSecs)}</strong>
            </div>
            <div className="qp-data__metric">
              <span>{t('usageStats.activeDays', { defaultValue: 'Active Days' })}</span>
              <strong>{activeDays}</strong>
            </div>
            <div className="qp-data__metric">
              <span>{t('usageStats.peakDay', { defaultValue: 'Peak Day' })}</span>
              <strong>{peakDay ? formatTrendDateLabel(peakDay.date) : '—'}</strong>
            </div>
          </div>
        )}
      </div>

      <div className="qp-data__body">
        {/* Calendar heatmap (GitHub style) */}
        <div className="qp-panel qp-data__heatmap-card">
          <div className="qp-data__heatmap-header">
            <h3 className="qp-data__heatmap-title">
              {t('usageStats.activityHeatmap', { defaultValue: 'Activity Heatmap' })}
            </h3>
            <p className="qp-data__heatmap-hint">
              {t('usageStats.activityHeatmapHint', {
                defaultValue: 'Each cell = one day · darker = more active',
              })}
            </p>
          </div>
          <div className="qp-data__heatmap-calendar">
            <div
              className="qp-data__heatmap-scroll"
              style={
                {
                  '--data-heatmap-week-count': calendarWeeks.length,
                } as CSSProperties
              }
            >
              <div className="qp-data__heatmap-months" aria-hidden>
                <span />
                {calendarWeeks.map((w, i) => (
                  <span key={`m-${i}`}>{w.monthLabel}</span>
                ))}
              </div>
              <div className="qp-data__heatmap-body">
                <div className="qp-data__heatmap-weekdays" aria-hidden>
                  {WEEKDAY_LABELS.map((w, i) => (
                    <span key={`${w}-${i}`}>{i % 2 === 1 ? w.slice(0, 1) : ''}</span>
                  ))}
                </div>
                <div className="qp-data__heatmap-weeks">
                  {calendarWeeks.map((week, wi) => (
                    <div key={`w-${wi}`} className="qp-data__heatmap-week">
                      {week.cells.map((cell, ci) => {
                        if (cell.isOutside) {
                          return (
                            <span
                              key={`c-${wi}-${ci}`}
                              className="qp-data__heatmap-cell qp-data__heatmap-cell--outside"
                            />
                          );
                        }
                        return (
                          <span
                            key={`c-${wi}-${ci}`}
                            className={`qp-data__heatmap-cell${
                              cell.isFuture ? ' qp-data__heatmap-cell--future' : ''
                            }`}
                            style={
                              {
                                '--heatmap-intensity': heatmapIntensityFor(cell.secs),
                              } as CSSProperties
                            }
                            title={`${cell.date} — ${formatDuration(cell.secs)}`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Top apps panel (unchanged) */}
        <div className="qp-panel qp-data__top-apps-card">
          <div className="qp-data__top-apps-header">
            <h3 className="qp-data__top-apps-title">
              {t('usageStats.topApps', { defaultValue: 'Top Apps' })}
            </h3>
            <span className="qp-data__top-apps-chip">
              {t('usageStats.topAppsBadge', {
                defaultValue: '{{count}} apps',
                count: topApps.length,
              })}
            </span>
          </div>
          <div className="qp-data__top-apps-list">
            {topApps.length === 0 && (
              <div className="qp-data__top-apps-empty">
                <Monitor size={32} className="qp-data__empty-icon" />
                <p>
                  {t('usageStats.noDataForRange', {
                    defaultValue: 'No data for this range',
                  })}
                </p>
              </div>
            )}
            {topApps.map((app) => {
              const accentColor =
                iconThemeColors[app.exe_path] ??
                app.color ??
                'var(--qp-accent-default)';
              const pct = (app.percentage * 100).toFixed(1);
              return (
                <div key={app.exe_path} className="qp-data__top-app-row">
                  <div className="qp-data__top-app-left">
                    <span className="qp-data__top-app-icon-wrap">
                      {app.icon ? (
                        <img
                          src={app.icon}
                          alt=""
                          className="qp-data__top-app-img"
                          draggable={false}
                        />
                      ) : (
                        <span className="qp-data__top-app-fallback">
                          {(app.display_name ?? app.process_name)
                            .charAt(0)
                            .toUpperCase()}
                        </span>
                      )}
                    </span>
                    <div className="qp-data__top-app-info">
                      <span className="qp-data__top-app-name">
                        {app.display_name ?? app.process_name}
                      </span>
                      <span className="qp-data__top-app-pct">{pct}%</span>
                    </div>
                  </div>
                  <div className="qp-data__top-app-right">
                    <span className="qp-data__top-app-duration">
                      {formatDuration(app.total_secs)}
                    </span>
                    <div className="qp-data__top-app-bar">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${app.percentage * 100}%` }}
                        transition={{ duration: 0.22, ease: 'easeOut' }}
                        className="qp-data__top-app-bar-fill"
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

export default DataTrendsView;
