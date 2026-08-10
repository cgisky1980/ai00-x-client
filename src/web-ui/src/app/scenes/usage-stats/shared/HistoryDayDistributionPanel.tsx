/**
 * HistoryDayDistributionPanel — Patina-style distribution panel.
 *
 * Toggle between app/category views; renders animated progress bars.
 *
 * Ported from Patina's `features/history/components/HistoryDayDistributionPanel.tsx`.
 */

import React from 'react';
import { motion } from 'framer-motion';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import QuietSegmentedFilter from './QuietSegmentedFilter';
import type { QuietSegmentedFilterOption } from './QuietSegmentedFilter';
import { formatHistoryDuration } from './historyReadModel';
import type { HistoryDistributionItem, HistoryDistributionMode } from './historyReadModel';

interface Props {
  mode: HistoryDistributionMode;
  modeOptions: QuietSegmentedFilterOption<HistoryDistributionMode>[];
  items: HistoryDistributionItem[];
  showQuietPlaceholder?: boolean;
  onModeChange: (mode: HistoryDistributionMode) => void;
}

function formatPercentage(percentage: number): string {
  if (!Number.isFinite(percentage)) return '0%';
  const bounded = Math.min(100, Math.max(0, percentage));
  return `${Math.round(bounded)}%`;
}

const HistoryDayDistributionPanel: React.FC<Props> = ({
  mode,
  modeOptions,
  items,
  showQuietPlaceholder = false,
  onModeChange,
}) => {
  const { t } = useI18n('common');
  return (
    <div className="qp-history-day-distribution">
      <div className="qp-history-day-distribution__header">
        <h3 className="qp-history-day-distribution__title">
          {t('usageStats.dayDistribution', { defaultValue: 'Day distribution' })}
        </h3>
        <QuietSegmentedFilter
          value={mode}
          options={modeOptions}
          onChange={onModeChange}
          className="qp-history-day-distribution__mode-switch"
        />
      </div>
      <div className="qp-history-day-distribution__list">
        {showQuietPlaceholder ? (
          <div className="qp-history-day-distribution__placeholder" aria-hidden="true" />
        ) : items.length === 0 ? (
          <p className="qp-history-day-distribution__empty">
            {t('usageStats.noData', { defaultValue: 'No data yet' })}
          </p>
        ) : (
          <div className="qp-history-day-distribution__items">
            {items.map((item) => (
              <div key={item.key} className="qp-history-day-distribution__item">
                <div className="qp-history-day-distribution__item-head">
                  <span className="qp-history-day-distribution__item-label-wrap">
                    {item.iconSrc ? (
                      <img
                        src={item.iconSrc}
                        className="qp-history-day-distribution__item-icon"
                        alt=""
                      />
                    ) : (
                      <span
                        className="qp-history-day-distribution__item-dot"
                        style={{ backgroundColor: item.color }}
                        aria-hidden="true"
                      />
                    )}
                    <span className="qp-history-day-distribution__item-label">
                      {item.label}
                    </span>
                  </span>
                  <span className="qp-history-day-distribution__item-value">
                    <span>{formatHistoryDuration(item.duration)}</span>
                    <span className="qp-history-day-distribution__item-pct">
                      {' '}
                      · {formatPercentage(item.percentage)}
                    </span>
                  </span>
                </div>
                <div className="qp-history-day-distribution__bar">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${item.percentage}%` }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="qp-history-day-distribution__bar-fill"
                    style={{ backgroundColor: item.color }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default HistoryDayDistributionPanel;
