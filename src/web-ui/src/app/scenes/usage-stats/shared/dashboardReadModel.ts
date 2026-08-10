/**
 * Dashboard read model — Patina-style adapter over the existing usage_stats API.
 *
 * Mirrors the shape of Patina's `DashboardReadModel` so the dashboard UI can be
 * ported with minimal changes. All durations are in **milliseconds** to match
 * Patina's convention; the API gives us seconds, so we multiply by 1000 here.
 */

import type {
  DaySummary,
  TimelineItem,
  TopAppItem,
  Category,
} from '@/infrastructure/api/usageStatsApi';

// ── Types (ported from Patina) ─────────────────────────────────────────

export interface HourlyActivityPoint {
  hour: string; // "HH:00"
  minutes: number;
}

export interface HourlyCategoryActivitySegment {
  dataKey: string;
  name: string;
  color: string;
  minutes: number;
}

export interface HourlyCategoryActivityPoint {
  hour: string;
  minutes: number; // total minutes for this hour
  segmentDetails: Record<string, HourlyCategoryActivitySegment>;
}

export interface HourlyCategoryActivity {
  points: HourlyCategoryActivityPoint[];
  series: { dataKey: string; name: string; color: string }[];
}

export interface TopApplicationItem {
  exeName: string;
  name: string;
  color: string | null;
  duration: number; // ms
  percentage: number; // 0..100
  categoryInitial: string;
  categoryId: number | null;
  categoryName: string | null;
}

export interface CategoryDistItem {
  name: string;
  value: number; // ms
  color: string;
}

export interface DashboardStats {
  totalActiveMs: number;
  totalAfkMs: number;
  appCount: number;
  longestSegmentMs: number;
}

export interface DashboardReadModel {
  stats: DashboardStats;
  totalTrackedTime: number; // ms — active only
  yesterdayTrackedTime: number; // ms
  dayDeltaTrackedTime: number; // ms (today - yesterday, can be negative)
  topApplications: TopApplicationItem[];
  hourlyActivity: HourlyActivityPoint[];
  hourlyCategoryActivity: HourlyCategoryActivity;
  categoryDist: CategoryDistItem[];
}

// ── Helpers ────────────────────────────────────────────────────────────

const DEFAULT_CATEGORY_COLOR = 'var(--qp-text-tertiary)';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function categoryInitial(name: string | null): string {
  if (!name) return '?';
  return name.charAt(0).toUpperCase();
}

function getHourlyCategorySlotDataKey(index: number): string {
  return `cat-${index}`;
}

/**
 * Build 24-hour activity points from raw timeline items.
 */
export function buildHourlyActivity(items: TimelineItem[]): HourlyActivityPoint[] {
  const minutesPerHour = new Array(24).fill(0);
  for (const item of items) {
    if (item.is_afk) continue;
    minutesPerHour[item.hour] += item.duration_secs / 60;
  }
  return minutesPerHour.map((minutes, hour) => ({
    hour: `${pad2(hour)}:00`,
    minutes: Math.round(minutes),
  }));
}

/**
 * Build stacked hourly activity grouped by category.
 */
export function buildHourlyCategoryActivity(
  items: TimelineItem[],
  categories: Category[],
): HourlyCategoryActivity {
  // Map category_id → { name, color }
  const catMap = new Map<number, { name: string; color: string }>();
  for (const c of categories) {
    catMap.set(c.id, { name: c.name, color: c.color ?? DEFAULT_CATEGORY_COLOR });
  }
  // Unknown category placeholder
  const UNKNOWN = { name: 'Uncategorized', color: DEFAULT_CATEGORY_COLOR };

  // Group timeline items by (hour, categoryId)
  // perHour[h][catKey] = minutes
  const perHour: Record<string, number>[] = Array.from({ length: 24 }, () => ({}));
  const catOrder: { key: string; name: string; color: string }[] = [];
  const catKeyToMeta = new Map<string, { name: string; color: string }>();

  for (const item of items) {
    if (item.is_afk) continue;
    const meta = item.category_id != null ? catMap.get(item.category_id) ?? UNKNOWN : UNKNOWN;
    const key =
      item.category_id != null ? `cat-${item.category_id}` : 'cat-unknown';
    if (!catKeyToMeta.has(key)) {
      catKeyToMeta.set(key, meta);
      catOrder.push({ key, name: meta.name, color: meta.color });
    }
    const hourMap = perHour[item.hour];
    if (!hourMap) continue;
    const slot = hourMap[key] ?? 0;
    hourMap[key] = slot + item.duration_secs / 60;
  }

  // Sort categories by total minutes desc
  const catTotals = new Map<string, number>();
  for (let h = 0; h < 24; h++) {
    const hourMap = perHour[h];
    if (!hourMap) continue;
    for (const [key, mins] of Object.entries(hourMap)) {
      catTotals.set(key, (catTotals.get(key) ?? 0) + mins);
    }
  }
  catOrder.sort((a, b) => (catTotals.get(b.key) ?? 0) - (catTotals.get(a.key) ?? 0));

  // Re-key categories to cat-0, cat-1, ... based on sorted order
  const newIndex = new Map<string, string>();
  const series: { dataKey: string; name: string; color: string }[] = [];
  catOrder.forEach((c, idx) => {
    const dataKey = getHourlyCategorySlotDataKey(idx);
    newIndex.set(c.key, dataKey);
    series.push({ dataKey, name: c.name, color: c.color });
  });

  // Build points
  const points: HourlyCategoryActivityPoint[] = [];
  for (let h = 0; h < 24; h++) {
    const segmentDetails: Record<string, HourlyCategoryActivitySegment> = {};
    let total = 0;
    const hourMap = perHour[h] ?? {};
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
    points.push({
      hour: `${pad2(h)}:00`,
      minutes: Math.round(total),
      segmentDetails,
    });
  }

  return { points, series };
}

/**
 * Limit visible categories in hourly chart; group overflow into "Other".
 */
export function limitHourlyCategoryActivity(
  activity: HourlyCategoryActivity,
  limit: number,
): HourlyCategoryActivity {
  if (activity.series.length <= limit) return activity;
  const visible = activity.series.slice(0, limit);
  const hiddenKeys = new Set(activity.series.slice(limit).map((s) => s.dataKey));
  const otherKey = getHourlyCategorySlotDataKey(limit);
  const otherMeta = { dataKey: otherKey, name: 'Other', color: 'var(--qp-text-tertiary)' };

  const points = activity.points.map((p) => {
    const segmentDetails: Record<string, HourlyCategoryActivitySegment> = {};
    let otherMinutes = 0;
    let total = 0;
    for (const [key, seg] of Object.entries(p.segmentDetails)) {
      if (hiddenKeys.has(key)) {
        otherMinutes += seg.minutes;
      } else {
        segmentDetails[key] = seg;
      }
      total += seg.minutes;
    }
    if (otherMinutes > 0) {
      segmentDetails[otherKey] = { ...otherMeta, minutes: Math.round(otherMinutes) };
    }
    return { ...p, segmentDetails, minutes: Math.round(total) };
  });

  return {
    points,
    series: [...visible, { dataKey: otherKey, name: 'Other', color: 'var(--qp-text-tertiary)' }],
  };
}

export function getHourlyCategorySlotDataKeyByIndex(index: number): string {
  return getHourlyCategorySlotDataKey(index);
}

/**
 * Build top-applications list with percentage relative to the busiest app.
 * (Patina uses total tracked time as the denominator; we use the same.)
 */
export function buildTopApplications(
  topApps: TopAppItem[],
  totalActiveMs: number,
): TopApplicationItem[] {
  if (topApps.length === 0) return [];
  return topApps.map((app) => {
    const durationMs = app.total_secs * 1000;
    const pct = totalActiveMs > 0 ? (app.total_secs * 1000) / totalActiveMs : 0;
    return {
      exeName: app.exe_path,
      name: app.display_name ?? app.process_name,
      color: app.color,
      duration: durationMs,
      percentage: Math.max(0, Math.min(100, Math.round(pct * 100))),
      categoryInitial: categoryInitial(app.category_name),
      categoryId: app.category_id,
      categoryName: app.category_name,
    };
  });
}

/**
 * Build category distribution from timeline items.
 *
 * Apps without an assigned category (or whose category has been deleted)
 * are bucketed into an "Uncategorized" group so the focus-share ring reflects
 * total tracked time — not just the subset the user has manually classified.
 * This mirrors `buildHourlyCategoryActivity`'s handling of unknown categories.
 */
export function buildCategoryDistribution(
  items: TimelineItem[],
  categories: Category[],
): CategoryDistItem[] {
  const catMap = new Map<number, { name: string; color: string }>();
  for (const c of categories) {
    catMap.set(c.id, { name: c.name, color: c.color ?? DEFAULT_CATEGORY_COLOR });
  }
  const UNKNOWN = { name: 'Uncategorized', color: DEFAULT_CATEGORY_COLOR };
  const totals = new Map<string, { minutes: number; color: string }>();
  for (const item of items) {
    if (item.is_afk) continue;
    const meta =
      item.category_id != null ? catMap.get(item.category_id) ?? UNKNOWN : UNKNOWN;
    const cur = totals.get(meta.name) ?? { minutes: 0, color: meta.color };
    cur.minutes += item.duration_secs / 60;
    totals.set(meta.name, cur);
  }
  const result: CategoryDistItem[] = [];
  for (const [name, { minutes, color }] of totals) {
    result.push({ name, value: Math.round(minutes * 60 * 1000), color });
  }
  result.sort((a, b) => b.value - a.value);
  return result;
}

/**
 * Format a duration given in milliseconds as "Xh Ym" or "Ym" or "<1m".
 */
export function formatDashboardDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return '<1m';
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (remM === 0) return `${h}h`;
  return `${h}h ${remM}m`;
}

/**
 * Build the full dashboard read model.
 */
export function buildDashboardReadModel(
  summary: DaySummary,
  timeline: TimelineItem[],
  topApps: TopAppItem[],
  categories: Category[],
  yesterdaySummary: DaySummary | null,
): DashboardReadModel {
  const totalActiveMs = summary.total_active_secs * 1000;
  const yesterdayTrackedTime = yesterdaySummary ? yesterdaySummary.total_active_secs * 1000 : 0;
  const dayDeltaTrackedTime = totalActiveMs - yesterdayTrackedTime;

  return {
    stats: {
      totalActiveMs,
      totalAfkMs: summary.total_afk_secs * 1000,
      appCount: summary.app_count,
      longestSegmentMs: summary.longest_segment_secs * 1000,
    },
    totalTrackedTime: totalActiveMs,
    yesterdayTrackedTime,
    dayDeltaTrackedTime,
    topApplications: buildTopApplications(topApps, totalActiveMs),
    hourlyActivity: buildHourlyActivity(timeline),
    hourlyCategoryActivity: buildHourlyCategoryActivity(timeline, categories),
    categoryDist: buildCategoryDistribution(timeline, categories),
  };
}
