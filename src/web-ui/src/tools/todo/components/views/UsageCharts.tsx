/**
 * UsageCharts — todo 用量统计共享图表组件（新东方极简数据可视化）。
 *
 * 设计纪律：本地 = 中性墨色半透明、远程 = 黛青 accent（不引第二交互色）；
 * 数字 mono + tabular-nums；无网格或极淡网格；tooltip 走 sunken 面风格。
 * recharts 3.x（web-ui 既有依赖）。
 */
import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtNum } from '../../ai/usageApi';

// ---- 指标卡（mono 大数字 + muted 小标） ----

export const StatChip: React.FC<{
  label: string;
  value: string;
  /** 右上小徽标（如「本地 n / 远程 n」） */
  sub?: string;
}> = ({ label, value, sub }) => (
  <div className="td-usage__stat">
    <span className="td-usage__stat-label">{label}</span>
    <span className="td-usage__stat-value">{value}</span>
    {sub && <span className="td-usage__stat-sub">{sub}</span>}
  </div>
);

// ---- 通用 tooltip（sunken 面风格） ----

interface TipItem {
  name: string;
  value: number;
  color: string;
}

const MiniTooltip: React.FC<{
  active?: boolean;
  label?: string;
  items: TipItem[];
}> = ({ active, label, items }) => {
  if (!active || !label) return null;
  return (
    <div className="td-usage__tip">
      <span className="td-usage__tip-date">{label}</span>
      {items
        .filter(i => i.value > 0)
        .map(i => (
          <span key={i.name} className="td-usage__tip-row">
            <span className="td-usage__tip-dot" style={{ background: i.color }} />
            {i.name}
            <span className="td-usage__tip-val">{fmtNum(i.value)}</span>
          </span>
        ))}
    </div>
  );
};

// ---- 单色迷你柱图（专注分钟等） ----

export const MiniBarChart: React.FC<{
  data: { date: string; value: number }[];
  colorVar?: string;
  unit?: string;
}> = ({ data, colorVar = 'var(--color-text-secondary)', unit = '' }) => (
  <ResponsiveContainer width="100%" height={96}>
    <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="30%">
      <CartesianGrid vertical={false} stroke="var(--border-subtle)" strokeDasharray="2 4" />
      <XAxis
        dataKey="date"
        tickFormatter={(d: string) => d.slice(5)}
        tick={{ fontSize: 10, fill: 'var(--color-text-muted)', fontFamily: 'var(--font-family-mono, monospace)' }}
        axisLine={false}
        tickLine={false}
        interval="preserveStartEnd"
      />
      <YAxis hide />
      <Tooltip
        cursor={{ fill: 'color-mix(in oklch, var(--color-text-primary) 6%, transparent)' }}
        content={({ active, label, payload }) => (
          <MiniTooltip
            active={active}
            label={String(label ?? '')}
            items={(payload ?? []).map(p => ({
              name: `${p.value}${unit}`,
              value: Number(p.value ?? 0),
              color: colorVar,
            }))}
          />
        )}
      />
      <Bar dataKey="value" fill={colorVar} radius={[2, 2, 0, 0]} isAnimationActive={false} />
    </BarChart>
  </ResponsiveContainer>
);

// ---- 本地/远程堆叠柱图（token） ----

export const StackedTokenChart: React.FC<{
  data: { date: string; local: number; remote: number }[];
}> = ({ data }) => {
  const localColor = 'color-mix(in oklch, var(--color-text-primary) 32%, transparent)';
  const remoteColor = 'var(--color-accent)';
  return (
    <div className="td-usage__chart">
      <div className="td-usage__legend">
        <span className="td-usage__legend-item">
          <span className="td-usage__legend-dot" style={{ background: localColor }} />
          本地
        </span>
        <span className="td-usage__legend-item">
          <span className="td-usage__legend-dot" style={{ background: remoteColor }} />
          远程
        </span>
      </div>
      <ResponsiveContainer width="100%" height={96}>
        <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" strokeDasharray="2 4" />
          <XAxis
            dataKey="date"
            tickFormatter={(d: string) => d.slice(5)}
            tick={{ fontSize: 10, fill: 'var(--color-text-muted)', fontFamily: 'var(--font-family-mono, monospace)' }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis hide />
          <Tooltip
            cursor={{ fill: 'color-mix(in oklch, var(--color-text-primary) 6%, transparent)' }}
            content={({ active, label, payload }) => (
              <MiniTooltip
                active={active}
                label={String(label ?? '')}
                items={[
                  { name: '本地 token', value: Number(payload?.[0]?.value ?? 0), color: localColor },
                  { name: '远程 token', value: Number(payload?.[1]?.value ?? 0), color: remoteColor },
                ]}
              />
            )}
          />
          <Bar dataKey="local" stackId="t" fill={localColor} isAnimationActive={false} />
          <Bar dataKey="remote" stackId="t" fill={remoteColor} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};
