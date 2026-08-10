import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@underlay/components/ui/card";
import {
  usageStatsApi,
  formatDuration,
  todayDateStr,
  type TopAppItem,
  type DaySummary,
} from "@underlay/lib/api/usageStatsApi";

// 柔和色系，配合淡色半透明背景
const PIE_COLORS = [
  "#4a6b5a", // 墨绿
  "#5a6b8a", // 蓝灰
  "#7a6b4a", // 橄榄
  "#6b4a5a", // 酒红灰
  "#8a7a5a", // 暖棕
  "#b0b0b0", // 灰（其他）
];

const CIRCUMFERENCE = 2 * Math.PI * 40; // r=40, ≈251.33
const GAP = 3; // 扇间间隙（像素），对应 recharts paddingAngle≈4°

interface PieSlice {
  name: string;
  secs: number;
  color: string;
  icon: string | null;
  percentage: number;
  cumOffset: number; // 之前段的累积长度
}

export function ClockWidget() {
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [topApps, setTopApps] = useState<TopAppItem[]>([]);
  const [hourlyActivity, setHourlyActivity] = useState<number[]>(() => new Array(24).fill(0));

  // ============ 自动拉取今日专注数据 ============
  const refresh = useCallback(async () => {
    try {
      const today = todayDateStr();
      const [summary, apps, timeline] = await Promise.all([
        usageStatsApi.daySummary().catch(() => null),
        usageStatsApi.topApps(today, today, 5).catch(() => []),
        usageStatsApi.timeline(today).catch(() => [] as never[]),
      ]);
      setDaySummary(summary);
      setTopApps(apps);
      // 按小时聚合 active 时长（排除 AFK）
      const hourly = new Array(24).fill(0);
      for (const item of timeline) {
        if (!item.is_afk) {
          hourly[item.hour] += item.duration_secs;
        }
      }
      setHourlyActivity(hourly);
    } catch {
      // 静默失败，widget 不崩溃
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 60000); // 每 60 秒刷新
    return () => clearInterval(timer);
  }, [refresh]);

  // ============ 构建饼图数据 ============
  const totalActive = daySummary?.total_active_secs ?? 0;
  const top5Total = topApps.reduce((sum, a) => sum + a.total_secs, 0);
  const otherSecs = Math.max(0, totalActive - top5Total);

  const rawSlices: { name: string; secs: number; color: string; icon: string | null }[] =
    topApps.map((app, i) => ({
      name: app.display_name || app.process_name || "未知",
      secs: app.total_secs,
      color: PIE_COLORS[i % PIE_COLORS.length],
      icon: app.icon,
    }));
  if (otherSecs > 0 && totalActive > 0) {
    rawSlices.push({ name: "其他", secs: otherSecs, color: PIE_COLORS[5], icon: null });
  }

  // 计算每个扇形的累积偏移（用于 stroke-dashoffset）
  let cumOffset = 0;
  const slices: PieSlice[] = rawSlices.map((slice) => {
    const percentage = totalActive > 0 ? (slice.secs / totalActive) * 100 : 0;
    const offset = cumOffset;
    cumOffset += (percentage / 100) * CIRCUMFERENCE;
    return {
      ...slice,
      percentage,
      cumOffset: offset,
    };
  });

  const longestSegment = daySummary?.longest_segment_secs ?? 0;

  return (
    <Card
      className="w-full h-full overflow-hidden cursor-default select-none flex flex-col"
      style={{ backgroundColor: "rgba(255, 255, 255, 0.5)" }}
    >
      <CardContent className="flex flex-col h-full p-2 gap-1">
        {/* Donut 饼图区 */}
        <div className="flex items-center justify-center flex-1 min-h-0">
          <div className="relative w-32 h-32 flex-shrink-0">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
              {/* 背景圆环 */}
              <circle
                cx="50"
                cy="50"
                r="40"
                fill="none"
                stroke="rgba(0,0,0,0.05)"
                strokeWidth="14"
              />
              {/* 各扇形（donut 段） */}
              {totalActive > 0 &&
                slices.map((slice, i) => {
                  const length = (slice.percentage / 100) * CIRCUMFERENCE;
                  const dashLength = Math.max(0, length - GAP);
                  return (
                    <circle
                      key={i}
                      cx="50"
                      cy="50"
                      r="40"
                      fill="none"
                      stroke={slice.color}
                      strokeWidth="14"
                      strokeDasharray={`${dashLength} ${CIRCUMFERENCE - dashLength}`}
                      strokeDashoffset={-slice.cumOffset}
                    />
                  );
                })}
            </svg>
            {/* 中心：总专注时长 */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              {totalActive > 0 ? (
                <>
                  <span className="text-lg font-mono font-bold text-zinc-700">
                    {formatDuration(totalActive)}
                  </span>
                  <span className="text-[10px] text-zinc-600">今日专注</span>
                </>
              ) : (
                <span className="text-[9px] text-zinc-500">暂无数据</span>
              )}
            </div>
          </div>
        </div>

        {/* 底部统计区 */}
        <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
          {/* 最长连续专注 */}
          {longestSegment > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-zinc-600">最长连续</span>
              <span className="font-mono font-semibold" style={{ color: "#4a6b5a" }}>
                {formatDuration(longestSegment)}
              </span>
            </div>
          )}
          {/* Top 应用图例（图标 + 百分比） */}
          {slices.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-zinc-600 max-w-full overflow-hidden">
              {slices.slice(0, 3).map((slice, i) => (
                <span key={i} className="flex items-center gap-0.5 flex-shrink-0">
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: slice.color }}
                  />
                  {slice.icon && (
                    <img src={slice.icon} className="w-3.5 h-3.5" alt="" />
                  )}
                  <span>{Math.round(slice.percentage)}%</span>
                </span>
              ))}
            </div>
          )}
          {/* 今日 24 小时活跃热力图 */}
          <div className="flex items-center gap-[1px] w-full py-0.5" title="今日 24h 活跃分布">
            {hourlyActivity.map((secs, hour) => {
              const intensity = Math.min(1, secs / 3600);
              return (
                <div
                  key={hour}
                  className="flex-1 h-2.5 rounded-[1px]"
                  style={{
                    backgroundColor:
                      secs > 0
                        ? `rgba(74, 107, 90, ${0.35 + intensity * 0.65})`
                        : "rgba(0,0,0,0.1)",
                  }}
                />
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
