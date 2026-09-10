import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Trash2, Sparkles } from 'lucide-react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Button, Empty, ConfirmDialog } from '@/component-library';
import { notificationService } from '@/shared/notification-system';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { createLogger } from '@/shared/utils/logger';
import './RouterEvolutionPanel.scss';

const log = createLogger('RouterEvolutionPanel');

interface CaptureStats {
  total: number;
  labeled: number;
  unlabeled: number;
  limit: number;
  min_labeled_for_evolve: number;
  next_auto_evolve_at: number;
}

interface CaptureItem {
  idx: number;
  ts: number;
  text: string;
  probs: number[];
  prev_tier: number | null;
  label: number | null;
  source: string;
}

interface EvolveResult {
  status: 'ok' | 'rejected' | 'skipped';
  message: string;
  train_samples: number;
  eval_samples: number;
  epochs_run: number;
  baseline_acc: number;
  new_acc: number;
}

interface EvolutionProgress {
  stage: 'loading' | 'training' | 'gating' | 'done';
  detail: string;
}

const TIER_COUNT = 4;
const PAGE_SIZE = 30;

/**
 * Self-evolution panel for the smart router: shows runtime-captured routing
 * samples, lets the user label the correct tier per sample, and triggers the
 * Rust-side fine-tune + eval-gate + hot-reload pipeline (`evolve_router_head`).
 */
export const RouterEvolutionPanel: React.FC = () => {
  const { t } = useTranslation('settings/default-model');
  const [stats, setStats] = useState<CaptureStats | null>(null);
  const [items, setItems] = useState<CaptureItem[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [evolving, setEvolving] = useState(false);
  const [progress, setProgress] = useState<EvolutionProgress | null>(null);
  const [result, setResult] = useState<EvolveResult | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await api.invoke<CaptureStats>('router_capture_stats', {}));
    } catch (error) {
      log.error('Failed to load capture stats', error);
    }
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.invoke<CaptureItem[]>('router_capture_list', {
        offset: 0,
        limit: PAGE_SIZE,
      });
      setItems(res);
    } catch (error) {
      log.error('Failed to load capture list', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.invoke<CaptureItem[]>('router_capture_list', {
        offset: items.length,
        limit: PAGE_SIZE,
      });
      // Dedupe by absolute idx (list shifts after local deletes).
      setItems((prev) => {
        const seen = new Set(prev.map((it) => it.idx));
        return [...prev, ...res.filter((it) => !seen.has(it.idx))];
      });
    } catch (error) {
      log.error('Failed to load capture list', error);
    } finally {
      setLoading(false);
    }
  }, [items.length]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  // Evolution progress events are emitted from the Rust training thread.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<EvolutionProgress>('router://evolution', (e) => {
      setProgress(e.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const handleLabel = useCallback(
    async (idx: number, tier: number | null) => {
      try {
        await api.invoke('router_capture_label', { idx, label: tier });
        setItems((prev) =>
          prev.map((it) => (it.idx === idx ? { ...it, label: tier } : it))
        );
        void refreshStats();
      } catch (error) {
        log.error('Failed to label sample', error);
      }
    },
    [refreshStats]
  );

  const handleDelete = useCallback(
    async (idx: number) => {
      try {
        await api.invoke('router_capture_delete', { idx });
        setItems((prev) => prev.filter((it) => it.idx !== idx));
        void refreshStats();
      } catch (error) {
        log.error('Failed to delete sample', error);
      }
    },
    [refreshStats]
  );

  const handleClear = useCallback(async () => {
    setClearOpen(false);
    try {
      await api.invoke('router_capture_clear', {});
      setItems([]);
      void refreshStats();
    } catch (error) {
      log.error('Failed to clear samples', error);
    }
  }, [refreshStats]);

  const handleEvolve = useCallback(async () => {
    setEvolving(true);
    setResult(null);
    setProgress({ stage: 'loading', detail: '' });
    try {
      const res = await api.invoke<EvolveResult>('evolve_router_head', {});
      setResult(res);
    } catch (error) {
      log.error('Router evolution failed', error);
      notificationService.error(t('smartRouter.evolution.failed'));
    } finally {
      setEvolving(false);
      setProgress(null);
      void refreshStats();
    }
  }, [refreshStats, t]);

  const labeled = stats?.labeled ?? 0;
  const minLabeled = stats?.min_labeled_for_evolve ?? 0;
  const canEvolve = labeled >= minLabeled;
  const hasMore = stats ? items.length < stats.total : false;

  const renderRow = (item: CaptureItem) => {
    const probs = Array.isArray(item.probs) ? item.probs : [];
    let pred = 0;
    let maxProb = 0;
    probs.forEach((p, i) => {
      if (p > maxProb) {
        maxProb = p;
        pred = i;
      }
    });
    return (
      <div key={item.idx} className="router-evolution-panel__row">
        <div className="router-evolution-panel__row-text" title={item.text}>
          {item.text}
        </div>
        <div className="router-evolution-panel__row-meta">
          <span className="router-evolution-panel__pred">
            {t('smartRouter.evolution.predicted')} R{pred} · {(maxProb * 100).toFixed(0)}%
          </span>
          {item.source === 'preview' && (
            <span className="router-evolution-panel__tag">
              {t('smartRouter.evolution.srcPreview')}
            </span>
          )}
        </div>
        <div className="router-evolution-panel__row-actions">
          {Array.from({ length: TIER_COUNT }, (_, tier) => (
            <button
              key={tier}
              type="button"
              className={`router-evolution-panel__tier-btn ${
                item.label === tier ? 'router-evolution-panel__tier-btn--active' : ''
              }`}
              onClick={() =>
                void handleLabel(item.idx, item.label === tier ? null : tier)
              }
            >
              R{tier}
            </button>
          ))}
          <button
            type="button"
            className="router-evolution-panel__delete-btn"
            title={t('smartRouter.evolution.clearAll')}
            onClick={() => void handleDelete(item.idx)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="router-evolution-panel">
      <div className="router-evolution-panel__head">
        <div className="router-evolution-panel__stats">
          {stats
            ? t('smartRouter.evolution.stats', {
                total: stats.total,
                labeled: stats.labeled,
                unlabeled: stats.unlabeled,
                limit: stats.limit,
                next: stats.next_auto_evolve_at,
              })
            : '\u2026'}
        </div>
        <div className="router-evolution-panel__actions">
          <Button
            size="small"
            variant="ghost"
            disabled={evolving || !stats || stats.total === 0}
            onClick={() => setClearOpen(true)}
          >
            <Trash2 size={12} />
            {t('smartRouter.evolution.clearAll')}
          </Button>
          <Button
            size="small"
            variant="primary"
            isLoading={evolving}
            disabled={!canEvolve || evolving}
            onClick={() => void handleEvolve()}
          >
            <Sparkles size={12} />
            {t('smartRouter.evolution.evolve')}
          </Button>
        </div>
      </div>

      {stats && stats.total > 0 && !canEvolve && (
        <div className="router-evolution-panel__need">
          {t('smartRouter.evolution.needMore', {
            n: minLabeled - labeled,
            min: minLabeled,
          })}
        </div>
      )}

      {evolving && progress && (
        <div className="router-evolution-panel__progress">
          {t(`smartRouter.evolution.progress.${progress.stage}`, {
            defaultValue: progress.detail,
          })}
        </div>
      )}

      {result && (
        <div
          className={`router-evolution-panel__result router-evolution-panel__result--${result.status}`}
        >
          {t(`smartRouter.evolution.result.${result.status}`, {
            from: (result.baseline_acc * 100).toFixed(1),
            to: (result.new_acc * 100).toFixed(1),
            samples: result.train_samples,
            epochs: result.epochs_run,
            message: result.message,
          })}
        </div>
      )}

      {stats && stats.total > 0 && (
        <>
          <button
            type="button"
            className="router-evolution-panel__list-toggle"
            onClick={() => {
              const next = !listOpen;
              setListOpen(next);
              if (next && items.length === 0) void loadItems();
            }}
          >
            {listOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{t('smartRouter.evolution.listToggle')}</span>
          </button>
          {listOpen && (
            <div className="router-evolution-panel__list">
              {items.length === 0 && !loading ? (
                <Empty title={t('smartRouter.evolution.empty')} />
              ) : (
                items.map(renderRow)
              )}
              {hasMore && (
                <Button
                  size="small"
                  variant="ghost"
                  isLoading={loading}
                  onClick={() => void loadMore()}
                  className="router-evolution-panel__load-more"
                >
                  {t('smartRouter.evolution.loadMore')}
                </Button>
              )}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        isOpen={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={() => void handleClear()}
        title={t('smartRouter.evolution.clearTitle')}
        message={t('smartRouter.evolution.clearMessage', {
          total: stats?.total ?? 0,
        })}
        type="warning"
        confirmDanger
      />
    </div>
  );
};

export default RouterEvolutionPanel;
