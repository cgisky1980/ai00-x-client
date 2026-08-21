import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { Button, Input } from '@/component-library';
import { notificationService } from '@/shared/notification-system';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { createLogger } from '@/shared/utils/logger';
import './RouterTestPanel.scss';

const log = createLogger('RouterTestPanel');

interface ClassificationResult {
  route: string;
  source: string;
  confidence: number;
  probabilities: number[];
  modelRef: string;
  safetyApplied: boolean;
  stickyApplied: boolean;
}

const TIER_INDEXES = [0, 1, 2, 3] as const;

/**
 * Stateless classification test entry for the smart router settings page.
 * Runs the full pipeline (rules + model + post-processing) via
 * `test_router_classification` without touching live session sticky state.
 */
export const RouterTestPanel: React.FC = () => {
  const { t } = useTranslation('settings/default-model');
  const [input, setInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ClassificationResult | null>(null);

  const runTest = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setTesting(true);
    try {
      const res = await api.invoke<ClassificationResult>(
        'test_router_classification',
        { request: { request: text } }
      );
      setResult(res);
    } catch (error) {
      log.error('Router classification test failed', error);
      notificationService.error(t('smartRouter.test.failed'));
    } finally {
      setTesting(false);
    }
  }, [input, t]);

  const routeTier = result?.route.toLowerCase() ?? '';

  return (
    <div className="router-test-panel">
      <div className="router-test-panel__row">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim() && !testing) {
              void runTest();
            }
          }}
          placeholder={t('smartRouter.test.placeholder')}
          className="router-test-panel__input"
        />
        <Button
          size="small"
          variant="primary"
          isLoading={testing}
          disabled={!input.trim() || testing}
          onClick={() => void runTest()}
        >
          <Play size={12} />
          {t('smartRouter.test.button')}
        </Button>
      </div>

      {result && (
        <div className="router-test-panel__result">
          <div className="router-test-panel__bars">
            {TIER_INDEXES.map((idx) => {
              const tierKey = `r${idx}`;
              const prob = result.probabilities[idx] ?? 0;
              const isWinner = routeTier === tierKey;
              return (
                <div key={tierKey} className="router-test-panel__bar-row">
                  <span
                    className={`router-test-panel__bar-label ${isWinner ? 'router-test-panel__bar-label--win' : ''}`}
                  >
                    {t(`smartRouter.tiers.${tierKey}.label`)}
                  </span>
                  <div className="router-test-panel__bar-track">
                    <div
                      className={`router-test-panel__bar-fill ${isWinner ? 'router-test-panel__bar-fill--win' : ''}`}
                      style={{ width: `${Math.round(prob * 100)}%` }}
                    />
                  </div>
                  <span className="router-test-panel__bar-value">
                    {(prob * 100).toFixed(1)}%
                  </span>
                </div>
              );
            })}
          </div>
          <div className="router-test-panel__verdict">
            {t('smartRouter.test.verdict', {
              tier: t(`smartRouter.tiers.${routeTier}.label`),
              model: result.modelRef,
              confidence: Math.round(result.confidence * 100),
            })}
            {result.safetyApplied && <span className="router-test-panel__tag">safety↑</span>}
            {result.stickyApplied && <span className="router-test-panel__tag">sticky↑</span>}
            {result.source === 'trivial_ack' && (
              <span className="router-test-panel__tag">{t('smartRouter.test.trivialAck')}</span>
            )}
            {result.source === 'fallback' && (
              <span className="router-test-panel__tag">{t('smartRouter.test.fallback')}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default RouterTestPanel;
