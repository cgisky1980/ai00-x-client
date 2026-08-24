/**
 * MusicModelSelector — DiT model picker for the AI00-Music chat.
 *
 * Sits next to the ChatModelSelector (LLM picker) in the input bar.
 * Shows the 4 base DiT variants (base Q5/Q8 + XL base Q5/Q8) with
 * download status and inline download progress. Clicking a ready
 * variant selects it as the active DiT for generation. Clicking a
 * missing variant downloads just that single DiT file.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Music,
  ChevronDown,
  Check,
  Download,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { Popover, PopoverTrigger, PopoverContent } from '@/component-library';
import { aceStepService } from '../services/AceStepService';
import { useAceStepStore } from '../store/acestepStore';
import type {
  AceStepCatalogEntry,
  AceStepDownloadProgress,
} from '../types';
import './MusicModelSelector.scss';

/** Short display name for a DiT catalog entry. */
function ditDisplayName(entry: AceStepCatalogEntry): string {
  if (entry.ditType === 'xl-base') {
    return entry.variant.includes('Q8') ? 'XL Base Q8' : 'XL Base Q5';
  }
  return entry.variant.includes('Q8') ? 'Base Q8' : 'Base Q5';
}

/** Format bytes as a compact size string. */
function formatSize(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / 1_000_000;
  return `${mb.toFixed(0)}MB`;
}

/** localStorage key for persisting the selected DiT filename. */
const DIT_STORAGE_KEY = 'acestep-selected-dit';

/** Read persisted DiT selection from localStorage. */
function loadPersistedDit(): string | null {
  try {
    return localStorage.getItem(DIT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist DiT selection to localStorage. */
function persistDit(filename: string | null) {
  try {
    if (filename) {
      localStorage.setItem(DIT_STORAGE_KEY, filename);
    } else {
      localStorage.removeItem(DIT_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

export const MusicModelSelector: React.FC = () => {
  const { t } = useI18n('acestep');
  const [catalog, setCatalog] = useState<AceStepCatalogEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<Record<string, AceStepDownloadProgress>>({});
  // Task ids of the active bundle download (text encoder + DiT + VAE).
  const [activeTasks, setActiveTasks] = useState<string[]>([]);

  const selectedDiTFilename = useAceStepStore((s) => s.selectedDiTFilename);
  const setSelectedDiTFilename = useAceStepStore((s) => s.setSelectedDiTFilename);

  // ---- Data fetching ----

  const refreshCatalog = useCallback(async () => {
    try {
      const entries = await aceStepService.listCatalog();
      const dits = entries.filter((e) => e.role === 'dit');
      setCatalog(dits);

      // Auto-select: restore persisted choice, or pick first downloaded.
      if (!selectedDiTFilename) {
        const persisted = loadPersistedDit();
        const valid = dits.find((e) => e.filename === persisted && e.exists);
        const fallback = dits.find((e) => e.exists);
        const pick = valid ?? fallback ?? null;
        if (pick) {
          setSelectedDiTFilename(pick.filename);
          persistDit(pick.filename);
        }
      }
    } catch {
      // ignore
    }
  }, [selectedDiTFilename, setSelectedDiTFilename]);

  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog]);

  // ---- Download progress polling (multi-task bundle) ----

  useEffect(() => {
    if (activeTasks.length === 0) {
      setProgress({});
      return;
    }

    const interval = setInterval(async () => {
      const updates: Record<string, AceStepDownloadProgress> = {};
      const still: string[] = [];
      for (const taskId of activeTasks) {
        try {
          const p = await aceStepService.getDownloadProgress(taskId);
          if (p) {
            updates[taskId] = p;
            if (p.status === 'Downloading' || p.status === 'Pending') {
              still.push(taskId);
            }
          }
        } catch {
          // ignore
        }
      }
      setProgress(updates);

      // If any task finished, refresh catalog and prune the active set.
      if (still.length < activeTasks.length) {
        refreshCatalog();
        setActiveTasks(still);
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [activeTasks, refreshCatalog]);

  // ---- Derived state ----

  /** Currently selected DiT catalog entry (by filename match). */
  const selectedEntry = useMemo(() => {
    if (!selectedDiTFilename) return null;
    return catalog.find((e) => e.filename === selectedDiTFilename) ?? null;
  }, [catalog, selectedDiTFilename]);

  /** Trigger label. */
  const selectedLabel = useMemo(() => {
    if (selectedEntry) return ditDisplayName(selectedEntry);
    // Check if any model is downloaded.
    const anyExists = catalog.some((e) => e.exists);
    return anyExists
      ? t('chatCreate.modelAuto', { defaultValue: 'Select model' })
      : t('chatCreate.modelDownload', { defaultValue: 'Download model' });
  }, [selectedEntry, catalog, t]);

  /** Overall progress across all active bundle tasks. */
  const overallPercent = useMemo(() => {
    const tasks = activeTasks
      .map((id) => progress[id])
      .filter((p): p is AceStepDownloadProgress => !!p && p.total > 0);
    if (tasks.length === 0) return null;
    const total = tasks.reduce((sum, p) => sum + p.total, 0);
    const done = tasks.reduce((sum, p) => sum + p.progress, 0);
    return Math.round((done / total) * 100);
  }, [activeTasks, progress]);

  // ---- Handlers ----

  const handleSelect = useCallback(
    (entry: AceStepCatalogEntry) => {
      if (!entry.exists) return;
      setSelectedDiTFilename(entry.filename);
      persistDit(entry.filename);
      setOpen(false);
    },
    [setSelectedDiTFilename],
  );

  /**
   * Map a DiT catalog entry to its preset id so that clicking download on a
   * single DiT variant auto-downloads the full required bundle (text encoder
   * + this DiT + VAE). Returns null for non-DiT entries.
   */
  const presetIdForDit = useCallback((entry: AceStepCatalogEntry): string | null => {
    if (entry.role !== 'dit') return null;
    const family = entry.ditType === 'xl-base' ? 'xl-base' : 'base';
    const quant = entry.variant.includes('Q8') ? 'q8' : 'q5';
    return `${family}-${quant}`;
  }, []);

  const handleDownload = useCallback(
    async (entry: AceStepCatalogEntry) => {
      if (activeTasks.length > 0) return; // Only one bundle download at a time.
      const presetId = presetIdForDit(entry);
      if (!presetId) return;
      try {
        const ids = await aceStepService.downloadPreset(presetId);
        setActiveTasks(ids);
      } catch {
        // ignore
      }
    },
    [activeTasks, presetIdForDit],
  );

  // ---- Render ----

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="music-model-selector">
        <PopoverTrigger asChild>
          <button
            className="music-model-selector__trigger"
            title={t('chatCreate.musicModelTitle', {
              defaultValue: 'Music model (DiT)',
            })}
          >
            <Music size={14} />
            <span className="music-model-selector__label">{selectedLabel}</span>
            {overallPercent !== null && (
              <span className="music-model-selector__progress-badge">
                <Loader2 size={10} className="spin" />
                {overallPercent}%
              </span>
            )}
            <ChevronDown size={14} />
          </button>
        </PopoverTrigger>

        <PopoverContent
          side="top"
          align="start"
          sideOffset={4}
          className="music-model-selector__dropdown"
        >
          {/* No models downloaded — show hint */}
          {!catalog.some((e) => e.exists) && (
            <div className="music-model-selector__empty-hint">
              {t('chatCreate.noModelHint', {
                defaultValue: 'No music model downloaded. Click the download button to get one.',
              })}
            </div>
          )}

          <div className="music-model-selector__section-title">
            {t('chatCreate.musicModels', { defaultValue: 'Music Models' })}
          </div>

          {catalog.map((entry) => {
            const isSelected = selectedDiTFilename === entry.filename;
            const isThisDownloading = activeTasks.includes(entry.id);
            const isAnyDownloading = activeTasks.length > 0;
            const entryProgress = isThisDownloading ? progress[entry.id] ?? null : null;

            return (
              <div
                key={entry.id}
                className={`music-model-selector__option-row ${
                  isSelected ? 'is-selected' : ''
                } ${!entry.exists ? 'is-missing' : ''}`}
              >
                <button
                  className="music-model-selector__option"
                  onClick={() => handleSelect(entry)}
                  disabled={!entry.exists || isAnyDownloading}
                >
                  <span className="music-model-selector__option-info">
                    <span className="music-model-selector__option-name">
                      {ditDisplayName(entry)}
                      <span
                        className={`music-model-selector__badge is-${entry.ditType}`}
                      >
                        {entry.ditType === 'xl-base' ? 'XL' : '2B'}
                      </span>
                    </span>
                    <span className="music-model-selector__option-meta">
                      {formatSize(entry.approxSizeBytes)}
                    </span>
                  </span>
                  {isSelected && (
                    <Check size={14} className="music-model-selector__check" />
                  )}
                </button>

                {/* Download button for missing models (only when not downloading this entry) */}
                {!entry.exists && !isThisDownloading && (
                  <button
                    className="music-model-selector__download-btn"
                    onClick={() => handleDownload(entry)}
                    disabled={isAnyDownloading}
                  >
                    {isAnyDownloading ? (
                      <Loader2 size={11} className="spin" />
                    ) : (
                      <Download size={11} />
                    )}
                  </button>
                )}

                {/* Inline progress bar — only on the entry being downloaded */}
                {isThisDownloading && entryProgress && (
                  <div className="music-model-selector__progress">
                    <div
                      className="music-model-selector__progress-fill"
                      style={{
                        width: `${
                          entryProgress.total > 0
                            ? (entryProgress.progress / entryProgress.total) * 100
                            : 0
                        }%`,
                      }}
                    />
                    <span className="music-model-selector__progress-text">
                      {entryProgress.total > 0
                        ? `${Math.round(
                            (entryProgress.progress / entryProgress.total) * 100,
                          )}%`
                        : '...'}
                    </span>
                  </div>
                )}

                {/* Spinner when this entry is downloading but progress not yet fetched */}
                {isThisDownloading && !entryProgress && (
                  <Loader2 size={11} className="spin music-model-selector__download-spinner" />
                )}

                {/* Error indicator */}
                {isThisDownloading && entryProgress?.status === 'Failed' && (
                  <span className="music-model-selector__error">
                    <AlertCircle size={11} />
                  </span>
                )}
              </div>
            );
          })}
        </PopoverContent>
      </div>
    </Popover>
  );
};
