/**
 * HistoryDaySummaryPanel — Patina-style day summary card.
 *
 * Shows: active duration, active span, peak hour.
 *
 * Ported from Patina's `features/history/components/HistoryDaySummaryPanel.tsx`.
 */

import React from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { HistoryDaySummaryView } from './historyReadModel';

interface Props {
  view: HistoryDaySummaryView;
}

const HistoryDaySummaryPanel: React.FC<Props> = ({ view }) => {
  const { t } = useI18n('common');
  return (
    <div className="qp-panel qp-history-day-summary">
      <h3 className="qp-history-day-summary__title">
        {t('usageStats.daySummary', { defaultValue: 'Day summary' })}
      </h3>
      <div className="qp-history-day-summary__body">
        <div className="qp-history-day-summary__primary">
          <span className="qp-history-day-summary__label">
            {t('usageStats.activeDuration', { defaultValue: 'Active duration' })}
          </span>
          <strong className="qp-history-day-summary__value">
            {view.activeDurationLabel}
          </strong>
        </div>
        <div className="qp-history-day-summary__details">
          <div className="qp-history-day-summary__detail">
            <span>{t('usageStats.activeSpan', { defaultValue: 'Active span' })}</span>
            <strong>{view.activeSpanLabel}</strong>
          </div>
          <div className="qp-history-day-summary__detail">
            <span>{t('usageStats.peakHour', { defaultValue: 'Peak hour' })}</span>
            <strong>{view.peakHourLabel}</strong>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HistoryDaySummaryPanel;
