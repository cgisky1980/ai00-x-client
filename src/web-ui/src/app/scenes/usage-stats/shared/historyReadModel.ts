/**
 * History read model — Patina-style adapter for a single-day history view.
 *
 * Our API returns per-hour aggregated `TimelineItem`s (not actual sessions),
 * so the horizontal timeline is built by placing each item sequentially within
 * its hour bucket. All durations are in **milliseconds** to match Patina.
 */

import type {
  TimelineItem,
  Category,
} from '@/infrastructure/api/usageStatsApi';

// ── Types ─────────────────────────────────────────────────────────────

export interface HistoryTimelineSegment {
  id: string;
  /** Start ratio within the 24h day (0..1). */
  startRatio: number;
  /** Width ratio within the 24h day (0..1). */
  widthRatio: number;
  startTime: number; // ms since epoch (local day start + offset)
  endTime: number;
  duration: number; // ms
  appKey: string;
  exeName: string;
  displayName: string;
  category: string;
  categoryLabel: string;
  color: string | null;
  icon: string | null;
}

export interface HistoryTimelineLegendItem {
  key: string;
  label: string;
  category: string;
  exeName: string;
}

export interface HistoryTimelineAxisTick {
  ratio: number;
  label: string;
}

export interface HistoryTimelineViewModel {
  segments: HistoryTimelineSegment[];
  legendItems: HistoryTimelineLegendItem[];
  axisTicks: HistoryTimelineAxisTick[];
  dayStartMs: number;
  dayEndMs: number;
}

export interface HistoryDaySummaryView {
  activeDurationMs: number;
  activeDurationLabel: string;
  activeSpanLabel: string;
  peakHourLabel: string;
}

export type HistoryDistributionMode = 'app' | 'category';

export interface HistoryDistributionItem {
  key: string;
  label: string;
  duration: number; // ms
  percentage: number; // 0..100
  color: string;
  iconSrc?: string | null;
  kind: 'app' | 'category';
}

export interface HistoryReadModel {
  timeline: HistoryTimelineViewModel;
  daySummary: HistoryDaySummaryView;
  appDistribution: HistoryDistributionItem[];
  categoryDistribution: HistoryDistributionItem[];
  hourlyActivity: { hour: string; minutes: number }[];
  hourlyCategoryActivity: {
    points: {
      hour: string;
      minutes: number;
      segmentDetails: Record<
        string,
        { dataKey: string; name: string; color: string; minutes: number }
      >;
    }[];
    series: { dataKey: string; name: string; color: string }[];
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

const DEFAULT_CATEGORY_COLOR = 'var(--qp-text-tertiary)';
const UNKNOWN_CATEGORY = 'Uncategorized';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatHistoryDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return '<1m';
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (remM === 0) return `${h}h`;
  return `${h}h ${remM}m`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ── Builders ──────────────────────────────────────────────────────────

export function buildHistoryReadModel(
  items: TimelineItem[],
  categories: Category[],
  selectedDate: Date,
): HistoryReadModel {
  const dayStart = startOfLocalDay(selectedDate);
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayStartMs + DAY_MS;

  const catMap = new Map<number, { name: string; color: string }>();
  for (const c of categories) {
    catMap.set(c.id, { name: c.name, color: c.color ?? DEFAULT_CATEGORY_COLOR });
  }

  // Group items by hour for sequential placement within each hour.
  const itemsByHour = new Map<number, TimelineItem[]>();
  for (let h = 0; h < 24; h++) itemsByHour.set(h, []);
  for (const item of items) {
    if (item.is_afk) continue;
    itemsByHour.get(item.hour)?.push(item);
  }

  // Sort each hour's items by duration desc so the largest apps show first.
  for (const list of itemsByHour.values()) {
    list.sort((a, b) => b.duration_secs - a.duration_secs);
  }

  // Build segments — each item gets a slice of its hour proportional to its
  // duration. This produces a continuous colored bar across the 24h day.
  const segments: HistoryTimelineSegment[] = [];
  const legendKeys = new Map<string, HistoryTimelineLegendItem>();

  for (let h = 0; h < 24; h++) {
    const list = itemsByHour.get(h) ?? [];
    const hourTotal = list.reduce((s, x) => s + x.duration_secs, 0);
    if (hourTotal === 0) continue;
    const hourWidthRatio = 1 / 24;
    const hourStartRatio = h * hourWidthRatio;
    let cursor = 0; // seconds consumed within this hour
    for (const item of list) {
      const ratio = hourTotal > 0 ? item.duration_secs / hourTotal : 0;
      const segStartRatio = hourStartRatio + cursor * hourWidthRatio / Math.max(hourTotal, 1);
      const segWidthRatio = ratio * hourWidthRatio;
      cursor += item.duration_secs;
      const startTime = dayStartMs + h * HOUR_MS + Math.max(0, segStartRatio - hourStartRatio) * HOUR_MS * 24;
      const endTime = startTime + item.duration_secs * 1000;
      const categoryMeta = item.category_id != null
        ? catMap.get(item.category_id) ?? { name: UNKNOWN_CATEGORY, color: DEFAULT_CATEGORY_COLOR }
        : { name: UNKNOWN_CATEGORY, color: DEFAULT_CATEGORY_COLOR };
      const segId = `${h}-${item.exe_path}-${segments.length}`;
      segments.push({
        id: segId,
        startRatio: segStartRatio,
        widthRatio: segWidthRatio,
        startTime,
        endTime,
        duration: item.duration_secs * 1000,
        appKey: item.exe_path,
        exeName: item.exe_path,
        displayName: item.display_name ?? item.process_name,
        category: String(item.category_id ?? 'unknown'),
        categoryLabel: categoryMeta.name,
        color: item.color,
        icon: item.icon,
      });
      if (!legendKeys.has(item.exe_path)) {
        legendKeys.set(item.exe_path, {
          key: item.exe_path,
          label: item.display_name ?? item.process_name,
          category: String(item.category_id ?? 'unknown'),
          exeName: item.exe_path,
        });
      }
    }
  }

  // Build axis ticks every 4 hours.
  const axisTicks: HistoryTimelineAxisTick[] = [];
  for (let h = 0; h <= 24; h += 4) {
    axisTicks.push({
      ratio: h / 24,
      label: h === 24 ? '24:00' : `${pad2(h)}:00`,
    });
  }

  // Sort legend by total duration desc.
  const durationByKey = new Map<string, number>();
  for (const seg of segments) {
    durationByKey.set(seg.appKey, (durationByKey.get(seg.appKey) ?? 0) + seg.duration);
  }
  const legendItems = Array.from(legendKeys.values()).sort(
    (a, b) => (durationByKey.get(b.key) ?? 0) - (durationByKey.get(a.key) ?? 0),
  );

  // Day summary
  const activeDurationMs = segments.reduce((s, x) => s + x.duration, 0);
  const activeItems = items.filter((x) => !x.is_afk && x.duration_secs > 0);
  let activeSpanLabel = '—';
  let peakHourLabel = '—';
  if (activeItems.length > 0) {
    const byHour = new Map<number, number>();
    for (const it of activeItems) {
      byHour.set(it.hour, (byHour.get(it.hour) ?? 0) + it.duration_secs);
    }
    const hours = Array.from(byHour.keys()).sort((a, b) => a - b);
    if (hours.length > 0) {
      const firstH = hours[0];
      const lastH = hours[hours.length - 1];
      activeSpanLabel = `${pad2(firstH)}:00 - ${pad2(lastH + 1)}:00`;
    }
    let peakH = -1;
    let peakSecs = 0;
    for (const [h, s] of byHour) {
      if (s > peakSecs) {
        peakSecs = s;
        peakH = h;
      }
    }
    if (peakH >= 0) {
      peakHourLabel = `${pad2(peakH)}:00 · ${formatHistoryDuration(peakSecs * 1000)}`;
    }
  }
  const daySummary: HistoryDaySummaryView = {
    activeDurationMs,
    activeDurationLabel: activeDurationMs > 0 ? formatHistoryDuration(activeDurationMs) : '0m',
    activeSpanLabel,
    peakHourLabel,
  };

  // App distribution
  const appAgg = new Map<string, { duration: number; color: string | null; icon: string | null; label: string }>();
  for (const seg of segments) {
    const cur = appAgg.get(seg.appKey) ?? {
      duration: 0,
      color: seg.color,
      icon: seg.icon,
      label: seg.displayName,
    };
    cur.duration += seg.duration;
    appAgg.set(seg.appKey, cur);
  }
  const appList = Array.from(appAgg.entries()).sort((a, b) => b[1].duration - a[1].duration);
  const appDistribution: HistoryDistributionItem[] = appList.map(([key, v]) => ({
    key,
    label: v.label,
    duration: v.duration,
    percentage: activeDurationMs > 0 ? (v.duration / activeDurationMs) * 100 : 0,
    color: v.color ?? DEFAULT_CATEGORY_COLOR,
    iconSrc: v.icon,
    kind: 'app' as const,
  }));

  // Category distribution
  const catAgg = new Map<string, { duration: number; color: string; label: string }>();
  for (const seg of segments) {
    const cur = catAgg.get(seg.category) ?? {
      duration: 0,
      color: catMap.get(Number(seg.category))?.color ?? DEFAULT_CATEGORY_COLOR,
      label: seg.categoryLabel,
    };
    cur.duration += seg.duration;
    catAgg.set(seg.category, cur);
  }
  const catList = Array.from(catAgg.entries()).sort((a, b) => b[1].duration - a[1].duration);
  const categoryDistribution: HistoryDistributionItem[] = catList.map(([key, v]) => ({
    key,
    label: v.label,
    duration: v.duration,
    percentage: activeDurationMs > 0 ? (v.duration / activeDurationMs) * 100 : 0,
    color: v.color,
    kind: 'category' as const,
  }));

  // Hourly activity (total)
  const minutesPerHour = new Array(24).fill(0);
  for (const item of items) {
    if (item.is_afk) continue;
    minutesPerHour[item.hour] += item.duration_secs / 60;
  }
  const hourlyActivity = minutesPerHour.map((minutes, h) => ({
    hour: `${pad2(h)}:00`,
    minutes: Math.round(minutes),
  }));

  // Hourly category activity (stacked)
  const perHourCat: Record<string, number>[] = Array.from({ length: 24 }, () => ({}));
  const catOrder: { key: string; name: string; color: string }[] = [];
  const catKeyToMeta = new Map<string, { name: string; color: string }>();
  for (const item of items) {
    if (item.is_afk) continue;
    const meta = item.category_id != null
      ? catMap.get(item.category_id) ?? { name: UNKNOWN_CATEGORY, color: DEFAULT_CATEGORY_COLOR }
      : { name: UNKNOWN_CATEGORY, color: DEFAULT_CATEGORY_COLOR };
    const key = item.category_id != null ? `cat-${item.category_id}` : 'cat-unknown';
    if (!catKeyToMeta.has(key)) {
      catKeyToMeta.set(key, meta);
      catOrder.push({ key, name: meta.name, color: meta.color });
    }
    const hourMap = perHourCat[item.hour];
    if (!hourMap) continue;
    hourMap[key] = (hourMap[key] ?? 0) + item.duration_secs / 60;
  }
  const catTotals = new Map<string, number>();
  for (let h = 0; h < 24; h++) {
    const hourMap = perHourCat[h];
    if (!hourMap) continue;
    for (const [key, mins] of Object.entries(hourMap)) {
      catTotals.set(key, (catTotals.get(key) ?? 0) + mins);
    }
  }
  catOrder.sort((a, b) => (catTotals.get(b.key) ?? 0) - (catTotals.get(a.key) ?? 0));
  const newIndex = new Map<string, string>();
  const series: { dataKey: string; name: string; color: string }[] = [];
  catOrder.forEach((c, idx) => {
    const dataKey = `cat-${idx}`;
    newIndex.set(c.key, dataKey);
    series.push({ dataKey, name: c.name, color: c.color });
  });
  const points = perHourCat.map((hourMap, h) => {
    const segmentDetails: Record<string, { dataKey: string; name: string; color: string; minutes: number }> = {};
    let total = 0;
    for (const c of catOrder) {
      const dataKey = newIndex.get(c.key)!;
      const mins = hourMap[c.key] ?? 0;
      if (mins > 0) {
        segmentDetails[dataKey] = {
          dataKey,
          name: c.name,
          color: c.color,
          minutes: Math.round(mins),
        };
        total += mins;
      }
    }
    return {
      hour: `${pad2(h)}:00`,
      minutes: Math.round(total),
      segmentDetails,
    };
  });
  const hourlyCategoryActivity = { points, series };

  return {
    timeline: {
      segments,
      legendItems,
      axisTicks,
      dayStartMs,
      dayEndMs,
    },
    daySummary,
    appDistribution,
    categoryDistribution,
    hourlyActivity,
    hourlyCategoryActivity,
  };
}

export { formatHistoryDuration, formatTime };
