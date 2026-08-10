/**
 * ScoreBadge — displays a song quality score with color coding.
 *
 * Shows the overall score (0-100) as a colored badge. On hover, a tooltip
 * reveals the 5 per-dimension scores (loudness, dynamic range, clipping,
 * tempo stability, spectral balance).
 *
 * The tooltip uses the shared portal-based Tooltip component so it is not
 * clipped by ancestor `overflow: hidden` containers (e.g. the session audio
 * list scroll area) and renders above other UI (z-index 9999).
 */

import React from 'react';
import { Tooltip } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n';
import type { SongScore } from '../types';
import './ScoreBadge.scss';

interface ScoreBadgeProps {
  score?: SongScore;
}

/** Map a 0-100 score to a CSS color-class. */
function scoreClass(score: number): string {
  if (score >= 80) return 'score-badge--high';
  if (score >= 60) return 'score-badge--mid';
  if (score >= 40) return 'score-badge--low';
  return 'score-badge--bad';
}

const DIMENSIONS: Array<{ key: keyof SongScore['audio']; labelKey: string }> = [
  { key: 'loudness', labelKey: 'scoreBadge.loudness' },
  { key: 'dynamicRange', labelKey: 'scoreBadge.dynamicRange' },
  { key: 'clipping', labelKey: 'scoreBadge.clipping' },
  { key: 'tempoStability', labelKey: 'scoreBadge.tempoStability' },
  { key: 'spectralBalance', labelKey: 'scoreBadge.spectralBalance' },
];

export const ScoreBadge: React.FC<ScoreBadgeProps> = ({ score }) => {
  const { t } = useI18n('acestep');

  if (!score) return null;

  const cls = scoreClass(score.overall);

  const tooltipContent = (
    <div className="score-badge__tooltip">
      <div className="score-badge__tooltip-title">
        {t('scoreBadge.tooltipTitle', { defaultValue: 'Audio Quality' })}
      </div>
      {DIMENSIONS.map(({ key, labelKey }) => (
        <div key={key} className="score-badge__row">
          <span className="score-badge__label">
            {t(labelKey, { defaultValue: key })}
          </span>
          <span className="score-badge__num">
            {Math.round(score.audio[key])}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <Tooltip
      content={tooltipContent}
      placement="top"
      delay={0}
      interactive={false}
    >
      <span className={`score-badge ${cls}`}>
        <span className="score-badge__value">{Math.round(score.overall)}</span>
      </span>
    </Tooltip>
  );
};
