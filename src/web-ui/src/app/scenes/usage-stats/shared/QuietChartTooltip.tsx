/**
 * QuietChartTooltip — Patina-style recharts Tooltip content renderer.
 *
 * This component is rendered via recharts' `<Tooltip content={...} />` prop.
 * Recharts injects `active`, `payload`, `label` automatically.
 *
 * Ported from Patina's `shared/components/QuietChartTooltip.tsx`, trimmed to
 * only the features used by the usage-stats scene.
 */

import React from 'react';

export interface QuietChartTooltipRenderProps {
  active?: boolean;
  payload?: readonly any[];
  label?: unknown;
}

export interface QuietChartTooltipProps extends QuietChartTooltipRenderProps {
  formatter?: (
    value: number,
    name: string,
    item: any,
    index: number,
  ) => [React.ReactNode, React.ReactNode];
  labelFormatter?: (label: unknown, payload: any[]) => React.ReactNode;
  colorFormatter?: (item: any) => string | undefined;
  filterZeroValues?: boolean;
  reverseItems?: boolean;
  verticalPlacement?: 'auto' | 'fixed-bottom';
  fixedBottomY?: number;
}

interface RenderedItem {
  color?: string;
  name: React.ReactNode;
  value: React.ReactNode;
}

const QuietChartTooltip: React.FC<QuietChartTooltipProps> = (props) => {
  const {
    formatter,
    labelFormatter,
    colorFormatter,
    filterZeroValues = false,
    reverseItems = false,
    verticalPlacement = 'auto',
    fixedBottomY,
    active,
    payload,
    label,
  } = props;

  if (!active || !payload || payload.length === 0) return null;

  let items: RenderedItem[] = payload.map((entry: any, index: number) => {
    const rawValue = Number(entry.value ?? 0);
    const name = String(entry.name ?? '');
    const [renderedValue, renderedName] = formatter
      ? formatter(rawValue, name, entry, index)
      : [`${Math.round(rawValue)}m`, name];
    return {
      color: colorFormatter ? colorFormatter(entry) : entry.color,
      name: renderedName,
      value: renderedValue,
    };
  });

  if (filterZeroValues) {
    items = items.filter((item) => {
      const numeric = parseFloat(String(item.value));
      return Number.isFinite(numeric) && numeric > 0;
    });
  }

  if (reverseItems) items = items.reverse();
  if (items.length === 0) return null;

  const renderedLabel: React.ReactNode = labelFormatter
    ? labelFormatter(label, payload as any[])
    : (label as React.ReactNode);
  const style: React.CSSProperties =
    verticalPlacement === 'fixed-bottom' && typeof fixedBottomY === 'number'
      ? { left: 0, top: fixedBottomY, transform: 'translateX(-50%)' }
      : {};

  return (
    <div className="qp-chart-tooltip" style={style}>
      {renderedLabel !== undefined && renderedLabel !== '' && (
        <div className="qp-chart-tooltip-label">{renderedLabel}</div>
      )}
      <ul className="qp-chart-tooltip-list">
        {items.map((item, idx) => (
          <li key={idx} className="qp-chart-tooltip-item">
            <span
              className="qp-chart-tooltip-dot"
              style={{ backgroundColor: item.color ?? 'var(--qp-accent-default)' }}
            />
            <span className="qp-chart-tooltip-name">{item.name}</span>
            <span className="qp-chart-tooltip-value">{item.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default QuietChartTooltip;
