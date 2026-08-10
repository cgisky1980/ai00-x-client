/**
 * HistoryHorizontalTimeline — Patina-style horizontal 24h timeline.
 *
 * Renders a horizontal track where each segment is positioned by its
 * start/width ratio across the 24h day. Supports `app` and `category` modes.
 *
 * Adapted from Patina's `features/history/components/HistoryHorizontalTimeline.tsx`.
 */

import React, { useState } from 'react';
import type {
  HistoryTimelineViewModel,
  HistoryTimelineSegment,
} from './historyReadModel';
import { formatHistoryDuration, formatTime } from './historyReadModel';

const MAX_LEGEND_ITEMS = 7;

export type HistoryTimelineMode = 'app' | 'category';

interface Props {
  viewModel: HistoryTimelineViewModel;
  mode: HistoryTimelineMode;
  iconThemeColors: Record<string, string>;
  title?: string | null;
  actions?: React.ReactNode;
  showEmptyMessage?: boolean;
  emptyMessage?: string;
}

function resolveSegmentColor(
  segment: HistoryTimelineSegment,
  mode: HistoryTimelineMode,
  iconThemeColors: Record<string, string>,
): string {
  if (mode === 'category') {
    return segment.color ?? 'var(--qp-text-tertiary)';
  }
  return (
    segment.color ??
    iconThemeColors[segment.appKey] ??
    iconThemeColors[segment.exeName] ??
    'var(--qp-accent-default)'
  );
}

function getSegmentLabel(segment: HistoryTimelineSegment, mode: HistoryTimelineMode): string {
  return mode === 'category' ? segment.categoryLabel : segment.displayName;
}

const HistoryHorizontalTimeline: React.FC<Props> = ({
  viewModel,
  mode,
  iconThemeColors,
  title,
  actions,
  showEmptyMessage = true,
  emptyMessage = 'No activity on this day',
}) => {
  const [tooltipSegmentId, setTooltipSegmentId] = useState<string | null>(null);
  const tooltipSegment = tooltipSegmentId
    ? viewModel.segments.find((s) => s.id === tooltipSegmentId)
    : undefined;
  const tooltipColor = tooltipSegment
    ? resolveSegmentColor(tooltipSegment, mode, iconThemeColors)
    : undefined;
  const tooltipLabel = tooltipSegment ? getSegmentLabel(tooltipSegment, mode) : '';
  const tooltipCenterRatio = tooltipSegment
    ? (tooltipSegment.startRatio + tooltipSegment.startRatio + tooltipSegment.widthRatio) / 2
    : 0.5;
  const tooltipEdgeClass =
    tooltipCenterRatio < 0.12
      ? 'history-h-timeline__tooltip--start'
      : tooltipCenterRatio > 0.88
        ? 'history-h-timeline__tooltip--end'
        : '';

  const visibleLegend = viewModel.legendItems.slice(0, MAX_LEGEND_ITEMS);
  const hiddenCount = Math.max(0, viewModel.legendItems.length - visibleLegend.length);

  return (
    <section
      className={[
        'history-h-timeline',
        `history-h-timeline--${mode}`,
      ].join(' ')}
      aria-label="Daily activity timeline"
    >
      <header className="history-h-timeline__header">
        <div className="history-h-timeline__title-row">
          {title && <h3 className="history-h-timeline__title">{title}</h3>}
        </div>
        <div className="history-h-timeline__meta">
          {visibleLegend.length > 0 && (
            <div className="history-h-timeline__legend">
              {visibleLegend.map((item) => {
                const seg = viewModel.segments.find((s) => s.appKey === item.key);
                const color = seg
                  ? resolveSegmentColor(seg, mode, iconThemeColors)
                  : 'var(--qp-text-tertiary)';
                return (
                  <span key={item.key} className="history-h-timeline__legend-item">
                    <span
                      className="history-h-timeline__legend-dot"
                      style={{ backgroundColor: color }}
                      aria-hidden="true"
                    />
                    <span className="history-h-timeline__legend-label">{item.label}</span>
                  </span>
                );
              })}
              {hiddenCount > 0 && (
                <span className="history-h-timeline__legend-more" tabIndex={0}>
                  +{hiddenCount}
                </span>
              )}
            </div>
          )}
          {actions && <div className="history-h-timeline__actions">{actions}</div>}
        </div>
      </header>

      <div className="history-h-timeline__canvas">
        <div className="history-h-timeline__track">
          {viewModel.segments.map((segment) => {
            const color = resolveSegmentColor(segment, mode, iconThemeColors);
            const label = getSegmentLabel(segment, mode);
            return (
              <span
                key={segment.id}
                tabIndex={0}
                aria-label={`${label} ${formatTime(segment.startTime)} - ${formatTime(segment.endTime)} ${formatHistoryDuration(segment.duration)}`}
                className="history-h-timeline__segment"
                style={
                  {
                    '--seg-left': `${segment.startRatio * 100}%`,
                    '--seg-width': `${segment.widthRatio * 100}%`,
                    '--seg-color': color,
                  } as React.CSSProperties
                }
                onPointerEnter={() => setTooltipSegmentId(segment.id)}
                onPointerLeave={() =>
                  setTooltipSegmentId((cur) => (cur === segment.id ? null : cur))
                }
                onFocus={() => setTooltipSegmentId(segment.id)}
                onBlur={() =>
                  setTooltipSegmentId((cur) => (cur === segment.id ? null : cur))
                }
              />
            );
          })}
          {tooltipSegment && tooltipColor && (
            <div
              className={`history-h-timeline__tooltip ${tooltipEdgeClass}`.trim()}
              style={
                {
                  '--tip-left': `${tooltipCenterRatio * 100}%`,
                  '--tip-color': tooltipColor,
                } as React.CSSProperties
              }
              role="tooltip"
            >
              <div className="history-h-timeline__tooltip-title">
                <span className="history-h-timeline__tooltip-dot" aria-hidden="true" />
                <span className="history-h-timeline__tooltip-label">{tooltipLabel}</span>
              </div>
              <div className="history-h-timeline__tooltip-time">
                {formatTime(tooltipSegment.startTime)} - {formatTime(tooltipSegment.endTime)}
                <span aria-hidden="true"> · </span>
                {formatHistoryDuration(tooltipSegment.duration)}
              </div>
            </div>
          )}
          {viewModel.segments.length === 0 && showEmptyMessage && (
            <span className="history-h-timeline__empty">{emptyMessage}</span>
          )}
        </div>
        <div className="history-h-timeline__axis" aria-hidden="true">
          {viewModel.axisTicks.map((tick) => (
            <span key={tick.label} style={{ left: `${tick.ratio * 100}%` }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
};

export default HistoryHorizontalTimeline;
