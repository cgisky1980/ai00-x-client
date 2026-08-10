/**
 * Usage Statistics API client.
 *
 * Mirrors the Rust types in `usage_stats/queries.rs` and `usage_stats/storage.rs`.
 * All commands are registered in `usage_stats_api.rs` and exposed via Tauri.
 *
 * 三包共用（web-ui / underlay-ui）：统一实现点，避免两份重复定义。
 */
import { invoke } from '@tauri-apps/api/core';

// ============ Types (1:1 mirror of Rust types) ============

export interface DaySummary {
  total_active_secs: number;
  total_afk_secs: number;
  app_count: number;
  segment_count: number;
  longest_segment_secs: number;
}

export interface TimelineItem {
  hour: number;
  exe_path: string;
  process_name: string;
  display_name: string | null;
  color: string | null;
  category_id: number | null;
  /** Base64 PNG data URL (`data:image/png;base64,...`) or null. */
  icon: string | null;
  duration_secs: number;
  is_afk: boolean;
}

export interface TrendItem {
  date: string; // "YYYY-MM-DD"
  total_active_secs: number;
  total_afk_secs: number;
  app_count: number;
}

export interface TopAppItem {
  exe_path: string;
  process_name: string;
  display_name: string | null;
  category_id: number | null;
  category_name: string | null;
  color: string | null;
  /** Base64 PNG data URL (`data:image/png;base64,...`) or null. */
  icon: string | null;
  total_secs: number;
  segment_count: number;
  percentage: number;
}

export interface HeatmapCell {
  day_of_week: number; // 0 = Sunday
  hour: number; // 0..=23
  total_secs: number;
}

export interface AppRule {
  id: number | null;
  exe_path: string;
  process_name: string;
  display_name: string | null;
  category_id: number | null;
  color: string | null;
  exclude_from_stats: boolean;
  capture_title: boolean;
  /** Base64 PNG data URL (`data:image/png;base64,...`) or null. */
  icon: string | null;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: number;
  name: string;
  color: string | null;
  sort_order: number;
}

// ============ API client ============

export const usageStatsApi = {
  /** Day summary card (today if date omitted). */
  async daySummary(date?: string): Promise<DaySummary> {
    return invoke('usage_stats_day_summary', { date: date ?? null });
  },

  /** Per-hour timeline for a single day (today if date omitted). */
  async timeline(date?: string): Promise<TimelineItem[]> {
    return invoke('usage_stats_timeline', { date: date ?? null });
  },

  /** Daily trends for an inclusive date range. */
  async trends(start: string, end: string): Promise<TrendItem[]> {
    return invoke('usage_stats_trends', { start, end });
  },

  /** Top apps by total active time in an inclusive date range. */
  async topApps(start: string, end: string, limit?: number): Promise<TopAppItem[]> {
    return invoke('usage_stats_top_apps', { start, end, limit: limit ?? null });
  },

  /** 7x24 heatmap for an inclusive date range. */
  async heatmap(start: string, end: string): Promise<HeatmapCell[]> {
    return invoke('usage_stats_heatmap', { start, end });
  },

  // ── app_rules CRUD ──────────────────────────────────────────────────

  async listAppRules(): Promise<AppRule[]> {
    return invoke('usage_stats_list_app_rules');
  },

  async updateAppRule(rule: AppRule): Promise<void> {
    return invoke('usage_stats_update_app_rule', { rule });
  },

  async deleteAppRule(exePath: string): Promise<void> {
    return invoke('usage_stats_delete_app_rule', { exePath });
  },

  // ── categories CRUD ──────────────────────────────────────────────────

  async listCategories(): Promise<Category[]> {
    return invoke('usage_stats_list_categories');
  },

  async createCategory(name: string, color?: string): Promise<number> {
    return invoke('usage_stats_create_category', { name, color: color ?? null });
  },

  async deleteCategory(id: number): Promise<void> {
    return invoke('usage_stats_delete_category', { id });
  },
};

// ============ Helpers ============

/** Format seconds as "Xh Ym" or "Ym" or "<1m". */
export function formatDuration(secs: number): string {
  if (secs < 60) return '<1m';
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (remM === 0) return `${h}h`;
  return `${h}h ${remM}m`;
}

/** Format seconds as "H:MM" hours (decimal hours, 1 fraction digit). */
export function formatHours(secs: number): string {
  return (secs / 3600).toFixed(1);
}

/** Return today's date as "YYYY-MM-DD" in local timezone. */
export function todayDateStr(): string {
  return localDateStr(new Date());
}

/** Format a Date as "YYYY-MM-DD" in local timezone. */
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Return date N days ago as "YYYY-MM-DD". */
export function daysAgoDateStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDateStr(d);
}

/** Human-readable label for day-of-week (0=Sunday). */
export function dayOfWeekLabel(dow: number): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow] ?? '';
}