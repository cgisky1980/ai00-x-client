import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelRound } from '../types/flow-chat';
import './TurnTokenSummary.scss';

interface TurnTokenSummaryProps {
  rounds: ModelRound[];
}

interface ModelTokenAgg {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  count: number;
}

export const TurnTokenSummary: React.FC<TurnTokenSummaryProps> = ({ rounds }) => {
  const { t } = useTranslation('flow-chat');
  const modelStats = useMemo(() => {
    const map = new Map<string, ModelTokenAgg>();

    for (const round of rounds) {
      const modelId = round.modelId || 'unknown';
      const existing = map.get(modelId) || { inputTokens: 0, outputTokens: 0, totalTokens: 0, count: 0 };
      existing.inputTokens += round.inputTokens || 0;
      existing.outputTokens += round.outputTokens || 0;
      existing.totalTokens += round.totalTokens || 0;
      existing.count += 1;
      map.set(modelId, existing);
    }

    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rounds]);

  const totals = useMemo(() => {
    let input = 0, output = 0, total = 0;
    for (const [, stats] of modelStats) {
      input += stats.inputTokens;
      output += stats.outputTokens;
      total += stats.totalTokens;
    }
    return { input, output, total };
  }, [modelStats]);

  if (modelStats.length === 0) return null;

  const fmt = (n: number) => n.toLocaleString('en-US');

  return (
    <div className="turn-token-summary">
      <div className="turn-token-summary__header">{t('tokenUsage.title')}</div>
      <div className="turn-token-summary__table">
        {modelStats.map(([modelId, stats]) => (
          <div className="turn-token-summary__row" key={modelId}>
            <span className="turn-token-summary__model" title={modelId}>{modelId}</span>
            <span className="turn-token-summary__tokens">
              <span className="turn-token-summary__in">{t('tokenUsage.input')} {fmt(stats.inputTokens)}</span>
              <span className="turn-token-summary__out">{t('tokenUsage.output')} {fmt(stats.outputTokens)}</span>
            </span>
          </div>
        ))}
        {modelStats.length > 1 && (
          <div className="turn-token-summary__row turn-token-summary__row--total">
            <span className="turn-token-summary__model">{t('tokenUsage.total')}</span>
            <span className="turn-token-summary__tokens">
              <span className="turn-token-summary__in">{t('tokenUsage.input')} {fmt(totals.input)}</span>
              <span className="turn-token-summary__out">{t('tokenUsage.output')} {fmt(totals.output)}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
