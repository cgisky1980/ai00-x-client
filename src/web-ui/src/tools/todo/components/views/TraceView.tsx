/**
 * TraceView — 迹 · 电脑使用足迹。
 *
 * 数据源：usage_stats（前台应用采集，usage_stats.db，与任务窗口统计页同源）。
 * 排版（新东方极简）：
 * - 今日概览卡：活跃大数字（mono）+ 次级指标（应用/段/最长/挂机）
 * - 今日每小时活动：24 格 CSS 柱状（活跃黛青/挂机墨阶）
 * - 近 7 日：条形 + 每日时长，今日高亮
 * - 今日 Top 应用：图标 + 名称 + mono 时长 + 黛青进度条
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  usageStatsApi,
  todayDateStr,
  daysAgoDateStr,
  type DaySummary,
  type TimelineItem,
  type TopAppItem,
} from '@/infrastructure/api/usageStatsApi';

/** 秒 → 中文时长（"6 小时 32 分" / "48 分钟" / "<1 分钟"）。 */
function fmtDur(secs: number): string {
  const m = Math.round(secs / 60);
  if (m < 1) return '<1 分钟';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

export const TraceView: React.FC = () => {
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  /** 近 7 日 date('YYYY-MM-DD') → total_active_secs（无数据日补 0） */
  const [trend, setTrend] = useState<{ date: string; secs: number }[]>([]);
  const [apps, setApps] = useState<TopAppItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const today = todayDateStr();
    const weekStart = daysAgoDateStr(6);
    const days = Array.from({ length: 7 }, (_, i) => daysAgoDateStr(6 - i));

    setLoading(true);
    Promise.all([
      usageStatsApi.daySummary(),
      usageStatsApi.timeline(),
      usageStatsApi.trends(weekStart, today),
      usageStatsApi.topApps(today, today, 8),
    ])
      .then(([sum, line, trends, tops]) => {
        if (cancelled) return;
        setSummary(sum);
        setTimeline(line);
        const byDate = new Map(trends.map((t) => [t.date, t.total_active_secs]));
        setTrend(days.map((date) => ({ date, secs: byDate.get(date) ?? 0 })));
        setApps(tops);
        setError(null);
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 每小时聚合：活跃/挂机分开累计
  const hourly = useMemo(() => {
    const active = new Array(24).fill(0);
    const afk = new Array(24).fill(0);
    for (const t of timeline) {
      if (t.hour < 0 || t.hour > 23) continue;
      if (t.is_afk) afk[t.hour] += t.duration_secs;
      else active[t.hour] += t.duration_secs;
    }
    return { active, afk };
  }, [timeline]);

  const maxHourSecs = Math.max(1, ...hourly.active, ...hourly.afk);
  const maxTrendSecs = Math.max(1, ...trend.map(d => d.secs));
  const maxAppSecs = Math.max(1, ...apps.map(a => a.total_secs));
  const today = todayDateStr();
  const weekTotal = trend.reduce((a, d) => a + d.secs, 0);

  return (
    <div className="td-view td-trace">
      {/* ===== 今日概览卡 ===== */}
      <div className="td-trace__card">
        <div className="td-trace__hero">
          <div className="td-trace__hero-num">
            {loading ? '…' : ((summary?.total_active_secs ?? 0) / 3600).toFixed(1)}
            <span className="td-trace__hero-unit">小时</span>
          </div>
          <div className="td-trace__hero-sub">今日电脑活跃</div>
        </div>
        <div className="td-trace__stats">
          <div className="td-trace__stat">
            <span className="td-trace__stat-num">
              {loading ? '—' : Math.round((summary?.total_afk_secs ?? 0) / 60)}
            </span>
            <span className="td-trace__stat-label">挂机 分钟</span>
          </div>
          <div className="td-trace__stat">
            <span className="td-trace__stat-num">{loading ? '—' : summary?.app_count ?? 0}</span>
            <span className="td-trace__stat-label">应用</span>
          </div>
          <div className="td-trace__stat">
            <span className="td-trace__stat-num">{loading ? '—' : summary?.segment_count ?? 0}</span>
            <span className="td-trace__stat-label">切换段</span>
          </div>
          <div className="td-trace__stat">
            <span className="td-trace__stat-num">
              {loading ? '—' : fmtDur(summary?.longest_segment_secs ?? 0)}
            </span>
            <span className="td-trace__stat-label">最长专注</span>
          </div>
        </div>
      </div>

      {/* ===== 今日每小时活动（24 格柱状：活跃黛青 / 挂机墨阶）===== */}
      <div className="td-trace__card">
        <div className="td-trace__card-title">今日每小时</div>
        <div className="td-trace__hours">
          {Array.from({ length: 24 }, (_, h) => {
            const a = hourly.active[h];
            const k = hourly.afk[h];
            const idle = a === 0 && k === 0;
            return (
              <div
                key={h}
                className="td-trace__hour"
                title={`${String(h).padStart(2, '0')}:00 · 活跃 ${fmtDur(a)}${k ? ` · 挂机 ${fmtDur(k)}` : ''}`}
              >
                <div className="td-trace__hour-bars">
                  {!idle && k > 0 && (
                    <span
                      className="td-trace__hour-bar is-afk"
                      style={{ height: `${Math.max(6, Math.round((k / maxHourSecs) * 44))}px` }}
                    />
                  )}
                  {!idle && (
                    <span
                      className="td-trace__hour-bar"
                      style={{ height: `${Math.max(6, Math.round((a / maxHourSecs) * 44))}px` }}
                    />
                  )}
                </div>
                <span className="td-trace__hour-label">{h % 3 === 0 ? h : ''}</span>
              </div>
            );
          })}
        </div>
        <div className="td-trace__legend">
          <span className="td-trace__legend-item"><i className="td-trace__dot" />活跃</span>
          <span className="td-trace__legend-item"><i className="td-trace__dot is-afk" />挂机</span>
        </div>
      </div>

      {/* ===== 近 7 日（条形 + 总计，今日黛青高亮）===== */}
      <div className="td-trace__card">
        <div className="td-trace__card-title">
          近 7 日
          <span className="td-trace__card-sub">累计 {fmtDur(weekTotal)}</span>
        </div>
        <div className="td-trace__bars">
          {trend.map(d => (
            <div
              key={d.date}
              className={`td-trace__bar-col${d.date === today ? ' is-today' : ''}`}
              title={`${d.date} · ${fmtDur(d.secs)}`}
            >
              <span className="td-trace__bar-val">{d.secs > 0 ? Math.round(d.secs / 3600) : ''}</span>
              <div
                className="td-trace__bar"
                style={{ height: `${Math.max(3, Math.round((d.secs / maxTrendSecs) * 48))}px` }}
              />
              <span className="td-trace__bar-label">{WEEK_CN[new Date(`${d.date}T12:00`).getDay()]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ===== 今日 Top 应用 ===== */}
      <div className="td-trace__card">
        <div className="td-trace__card-title">今日 Top 应用</div>
        <div className="td-trace__apps">
          {loading && <div className="td-trace__empty">读取中…</div>}
          {!loading && error && <div className="td-trace__empty">统计暂不可用（{error}）</div>}
          {!loading && !error && apps.length === 0 && (
            <div className="td-trace__empty">今日暂无使用记录</div>
          )}
          {!loading &&
            !error &&
            apps.map(a => (
              <div key={a.exe_path} className="td-trace__app" title={a.display_name ?? a.process_name}>
                <div className="td-trace__app-head">
                  {a.icon ? (
                    <img className="td-trace__app-icon" src={a.icon} alt="" />
                  ) : (
                    <span className="td-trace__app-icon td-trace__app-icon--fallback">
                      {(a.display_name ?? a.process_name).slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="td-trace__app-name">{a.display_name ?? a.process_name}</span>
                  <span className="td-trace__app-dur">{fmtDur(a.total_secs)}</span>
                </div>
                <div className="td-trace__app-track">
                  <span
                    className="td-trace__app-fill"
                    style={{ width: `${Math.max(2, Math.round((a.total_secs / maxAppSecs) * 100))}%` }}
                  />
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
};
