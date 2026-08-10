/**
 * Usage Statistics API client.
 *
 * 统一实现见 packages/shared/src/usageStatsApi.ts（@ai00-x/shared）。
 * 此处 re-export 以保持既有导入路径（./usageStatsApi）不变。
 */
export {
  usageStatsApi,
  type DaySummary,
  type TimelineItem,
  type TrendItem,
  type TopAppItem,
  type HeatmapCell,
  type AppRule,
  type Category,
  formatDuration,
  formatHours,
  todayDateStr,
  localDateStr,
  daysAgoDateStr,
  dayOfWeekLabel,
} from '@ai00-x/shared';