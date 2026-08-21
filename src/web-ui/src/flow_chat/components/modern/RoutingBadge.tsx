import React from 'react';
import { useTranslation } from 'react-i18next';
import { Route } from 'lucide-react';
import type { ModelRoutingInfo } from '../../types/flow-chat';
import './RoutingBadge.scss';

interface RoutingBadgeProps {
  routing: ModelRoutingInfo;
}

/**
 * Small inline badge showing the smart-router decision for a model round
 * (auto mode only): tier, resolved model reference and confidence.
 * Hover for the full decision including safety/sticky post-processing marks.
 */
export const RoutingBadge: React.FC<RoutingBadgeProps> = ({ routing }) => {
  const { t } = useTranslation('flow-chat');

  const sourceLabel =
    routing.source === 'trivial_ack'
      ? t('modelRound.routing.sourceRule')
      : routing.source === 'fallback'
        ? t('modelRound.routing.sourceFallback')
        : t('modelRound.routing.sourceModel');

  const marks: string[] = [];
  if (routing.safetyApplied) marks.push(t('modelRound.routing.safetyMark'));
  if (routing.stickyApplied) marks.push(t('modelRound.routing.stickyMark'));

  const tooltip = t('modelRound.routing.tooltip', {
    tier: routing.tier,
    model: routing.modelRef,
    source: sourceLabel,
    confidence: Math.round(routing.confidence * 100),
    marks: marks.length > 0 ? ` (${marks.join(' + ')})` : '',
  });

  return (
    <div className="routing-badge" title={tooltip}>
      <Route size={11} />
      <span className="routing-badge__text">
        Auto · {routing.tier} · {routing.modelRef} · {Math.round(routing.confidence * 100)}%
      </span>
    </div>
  );
};

export default RoutingBadge;
