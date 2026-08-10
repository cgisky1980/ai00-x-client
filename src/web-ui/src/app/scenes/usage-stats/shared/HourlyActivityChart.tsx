/**
 * HourlyActivityChart — Patina-style recharts BarChart.
 *
 * Supports two modes:
 *   - "total": single-color bars showing total active minutes per hour.
 *   - "category": stacked bars split by category.
 *
 * Ported from Patina's `shared/charts/HourlyActivityChart.tsx`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, Rectangle, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { BarShapeProps } from 'recharts';
import QuietChartTooltip from './QuietChartTooltip';
import {
  getHourlyCategorySlotDataKeyByIndex,
  limitHourlyCategoryActivity,
} from './dashboardReadModel';
import type {
  HourlyActivityPoint,
  HourlyCategoryActivity,
  HourlyCategoryActivityPoint,
  HourlyCategoryActivitySegment,
} from './dashboardReadModel';

export type HourlyActivityChartMode = 'total' | 'category';

interface Props {
  mode: HourlyActivityChartMode;
  hourlyActivity: HourlyActivityPoint[];
  hourlyCategoryActivity: HourlyCategoryActivity;
  margin: { top: number; right: number; left: number; bottom: number };
  padding: { left: number; right: number };
}

const BAR_TOP_RADIUS: [number, number, number, number] = [3, 3, 0, 0];
const COMPACT_CATEGORY_LIMIT = 4;
const EXPANDED_CATEGORY_LIMIT = 6;
const EXPANDED_CATEGORY_WIDTH = 400;
const X_AXIS_HEIGHT = 30;

function readRenderedBarBaseline(chart: HTMLDivElement): number | undefined {
  const barShapes = Array.from(chart.querySelectorAll<SVGPathElement>('.recharts-rectangle'));
  const baselines = barShapes
    .map((shape) => {
      const y = Number(shape.getAttribute('y'));
      const height = Number(shape.getAttribute('height'));
      return Number.isFinite(y) && Number.isFinite(height) ? y + height : undefined;
    })
    .filter((value): value is number => value !== undefined);
  return baselines.length > 0 ? Math.max(...baselines) : undefined;
}

function renderStackedBarShape(dataKey: string, higherDataKeys: string[]) {
  return ({ height, payload, width, x, y }: BarShapeProps) => {
    const point = payload as HourlyCategoryActivityPoint | undefined;
    const segment = point?.segmentDetails[dataKey];
    const hasHigherActiveSegment = higherDataKeys.some(
      (higherDataKey) => Number(payload?.[higherDataKey] ?? 0) > 0,
    );
    return (
      <Rectangle
        fill={segment?.color}
        height={height}
        radius={hasHigherActiveSegment ? 0 : BAR_TOP_RADIUS}
        width={width}
        x={x}
        y={y}
      />
    );
  };
}

export default function HourlyActivityChart({
  mode,
  hourlyActivity,
  hourlyCategoryActivity,
  margin,
  padding,
}: Props) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [visibleCategoryLimit, setVisibleCategoryLimit] = useState(COMPACT_CATEGORY_LIMIT);
  const [tooltipBottomY, setTooltipBottomY] = useState<number | undefined>();
  const categoryMode = mode === 'category';

  const visibleHourlyCategoryActivity = useMemo(
    () => limitHourlyCategoryActivity(hourlyCategoryActivity, visibleCategoryLimit),
    [hourlyCategoryActivity, visibleCategoryLimit],
  );

  const chartData = categoryMode ? visibleHourlyCategoryActivity.points : hourlyActivity;
  const stackedDataKeyCount = visibleHourlyCategoryActivity.points.reduce(
    (maxCount, point) => Math.max(maxCount, Object.keys(point.segmentDetails).length),
    0,
  );
  const stackedDataKeys = Array.from({ length: stackedDataKeyCount }, (_, index) =>
    getHourlyCategorySlotDataKeyByIndex(index),
  );

  const getTooltipSegment = (item: { dataKey?: string | number; payload?: unknown }) => {
    const dataKey = String(item.dataKey ?? '');
    const point = item.payload as HourlyCategoryActivityPoint | undefined;
    return point?.segmentDetails[dataKey] as HourlyCategoryActivitySegment | undefined;
  };

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let frameId: number | undefined;

    const updateTooltipBottom = (height: number) => {
      const renderedBaseline = readRenderedBarBaseline(chart);
      const fallbackBaseline = height - X_AXIS_HEIGHT - margin.bottom;
      setTooltipBottomY(Math.round(renderedBaseline ?? fallbackBaseline));
    };

    const updateLayout = (width: number, height: number) => {
      setVisibleCategoryLimit(
        width >= EXPANDED_CATEGORY_WIDTH ? EXPANDED_CATEGORY_LIMIT : COMPACT_CATEGORY_LIMIT,
      );
      if (height > 0) {
        updateTooltipBottom(height);
        frameId = requestAnimationFrame(() => updateTooltipBottom(height));
      }
    };

    const rect = chart.getBoundingClientRect();
    updateLayout(rect.width, rect.height);
    const observer = new ResizeObserver(([entry]) => {
      updateLayout(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(chart);
    return () => {
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [chartData, margin.bottom]);

  return (
    <div ref={chartRef} className="h-full w-full" data-hourly-activity-chart-mode={mode}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData as any[]} margin={margin}>
          <XAxis
            dataKey="hour"
            tick={{ fontSize: 10, fill: 'var(--qp-text-tertiary)' }}
            axisLine={false}
            tickLine={false}
            tickMargin={8}
            height={X_AXIS_HEIGHT}
            interval={5}
            padding={padding}
          />
          <YAxis hide domain={[0, 60]} allowDataOverflow />
          <Tooltip
            cursor={{ fill: 'var(--qp-chart-cursor)' }}
            content={(innerProps) => (
              <QuietChartTooltip
                {...innerProps}
                filterZeroValues
                reverseItems={categoryMode}
                verticalPlacement="fixed-bottom"
                fixedBottomY={tooltipBottomY}
                colorFormatter={(item: any) =>
                  categoryMode ? getTooltipSegment(item)?.color : undefined
                }
                labelFormatter={(label: unknown, payload: any[]) => {
                  if (!categoryMode) return label as React.ReactNode;
                  const totalMinutes = Number(
                    payload[0]?.payload && (payload[0].payload as { minutes?: number }).minutes,
                  ) || 0;
                  return `${String(label)} · Active ${Math.round(totalMinutes)}m`;
                }}
                formatter={(value: number, _name: string, item: any) => [
                  `${Math.round(Number(value))}m`,
                  categoryMode
                    ? getTooltipSegment(item)?.name ?? 'Active'
                    : 'Active minutes',
                ]}
              />
            )}
          />
          {categoryMode ? (
            stackedDataKeys.map((dataKey, index) => (
              <Bar
                key={dataKey}
                dataKey={dataKey}
                stackId="hourly-category"
                shape={renderStackedBarShape(
                  dataKey,
                  stackedDataKeys.slice(index + 1),
                ) as any}
                barSize={8}
                isAnimationActive={false}
              />
            ))
          ) : (
            <Bar
              dataKey="minutes"
              fill="var(--qp-accent-default)"
              radius={BAR_TOP_RADIUS}
              barSize={8}
              isAnimationActive={false}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
