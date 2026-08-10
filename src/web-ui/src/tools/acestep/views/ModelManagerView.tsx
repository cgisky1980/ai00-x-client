/**
 * ModelManagerView — ACE-Step model management + download view.
 *
 * Preset-first UX: 3 preset bundles (Quick Test / Standard / Full Feature)
 * chosen by functionality × quantification. Auto-detects GPU VRAM and
 * highlights the recommended preset. An "Advanced" collapsible section
 * exposes the full catalog for users who want to pick variants manually.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Download,
  Loader2, RefreshCw, Sparkles, Zap,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { aceStepService } from '../services/AceStepService';
import { useAceStepStore } from '../store/acestepStore';
import type {
  AceStepCatalogEntry, AceStepDownloadProgress, AceStepGpuInfo,
  AceStepMirrorSpeed, AceStepPreset,
} from '../types';

import './ModelManagerView.scss';

const ROLE_ORDER = ['text_encoder', 'dit', 'vae'];
const ROLE_LABELS: Record<string, string> = {
  text_encoder: 'Text Encoder',
  dit: 'DiT',
  vae: 'VAE',
};

/** All task names in display order — used to render the task support grid. */
const ALL_TASKS = ['text2music', 'cover', 'repaint', 'lego', 'extract', 'complete'] as const;

/** Map task name → i18n key suffix. */
const TASK_I18N_KEY: Record<string, string> = {
  text2music: 'taskText2music',
  cover: 'taskCover',
  repaint: 'taskRepaint',
  lego: 'taskLego',
  extract: 'taskExtract',
  complete: 'taskComplete',
};

function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  const gb = bytes / 1_000_000_000;
  const mb = bytes / 1_000_000;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}

const ModelManagerView: React.FC = () => {
  const { t } = useI18n('acestep');
  const status = useAceStepStore((s) => s.status);

  const [catalog, setCatalog] = useState<AceStepCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [presets, setPresets] = useState<AceStepPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [gpuInfo, setGpuInfo] = useState<AceStepGpuInfo | null>(null);
  const [gpuLoading, setGpuLoading] = useState(false);
  const [progress, setProgress] = useState<Record<string, AceStepDownloadProgress>>({});
  const [mirrors, setMirrors] = useState<AceStepMirrorSpeed[]>([]);
  const [mirrorLoading, setMirrorLoading] = useState(false);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const synthLoaded = status?.synthLoaded ?? false;
  const lmLoaded = status?.lmLoaded ?? false;

  // ---- Refreshers ----

  const refreshCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const entries = await aceStepService.listCatalog();
      setCatalog(entries);
    } catch (e) {
      console.error('Failed to load ACE-Step catalog', e);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const refreshPresets = useCallback(async () => {
    setPresetsLoading(true);
    try {
      const list = await aceStepService.getPresets();
      setPresets(list);
    } catch (e) {
      console.error('Failed to load ACE-Step presets', e);
    } finally {
      setPresetsLoading(false);
    }
  }, []);

  const refreshGpu = useCallback(async () => {
    setGpuLoading(true);
    try {
      const info = await aceStepService.getGpuInfo();
      setGpuInfo(info);
    } catch (e) {
      console.error('Failed to detect GPU', e);
    } finally {
      setGpuLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshCatalog();
    refreshPresets();
    refreshGpu();
  }, [refreshCatalog, refreshPresets, refreshGpu]);

  // Poll download progress for all active downloads.
  useEffect(() => {
    if (downloading.size === 0) {
      setProgress({});
      setActivePresetId(null);
      return;
    }

    const interval = setInterval(async () => {
      const updates: Record<string, AceStepDownloadProgress> = {};
      const stillDownloading: string[] = [];

      for (const taskId of downloading) {
        try {
          const p = await aceStepService.getDownloadProgress(taskId);
          if (p) {
            updates[taskId] = p;
            if (p.status === 'Downloading' || p.status === 'Pending') {
              stillDownloading.push(taskId);
            }
          }
        } catch {
          // ignore
        }
      }

      setProgress(updates);

      // If some downloads finished, refresh catalog + presets and prune the set.
      if (stillDownloading.length < downloading.size) {
        refreshCatalog();
        refreshPresets();
        if (stillDownloading.length === 0) {
          setDownloading(new Set());
        } else {
          setDownloading(new Set(stillDownloading));
        }
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [downloading, refreshCatalog, refreshPresets]);

  // ---- Handlers ----

  const handleDownloadPreset = useCallback(async (presetId: string) => {
    try {
      const ids = await aceStepService.downloadPreset(presetId);
      setActivePresetId(presetId);
      setDownloading(new Set(ids));
    } catch (e) {
      console.error('Preset download failed', e);
    }
  }, []);

  const handleDownload = useCallback(async (id: string) => {
    try {
      await aceStepService.downloadModel(id);
      setDownloading((prev) => new Set(prev).add(id));
    } catch (e) {
      console.error('Download failed', e);
    }
  }, []);

  const handleDownloadAll = useCallback(async () => {
    try {
      const ids = await aceStepService.downloadAllRecommended();
      setDownloading(new Set(ids));
    } catch (e) {
      console.error('Download all failed', e);
    }
  }, []);

  const handleTestMirrors = useCallback(async () => {
    setMirrorLoading(true);
    try {
      const speeds = await aceStepService.testMirrors();
      setMirrors(speeds);
    } catch (e) {
      console.error('Mirror test failed', e);
    } finally {
      setMirrorLoading(false);
    }
  }, []);

  // ---- Derived state ----

  /** Recommended preset id based on detected VRAM.
   *
   * We only support the base model family (all support full task set).
   * Recommendation is based on VRAM: Q5 for budget, Q8 for standard,
   * XL Q5/Q8 for high-VRAM machines wanting better quality. */
  const recommendedPresetId = useMemo<string | null>(() => {
    if (!gpuInfo?.vramMb) return null;
    if (gpuInfo.vramMb < 6144) return 'base-q5';      // < 6 GB → base Q5
    if (gpuInfo.vramMb < 12288) return 'base-q8';     // 6-12 GB → base Q8
    if (gpuInfo.vramMb < 16384) return 'xl-base-q5';  // 12-16 GB → XL base Q5
    return 'xl-base-q8';                               // ≥ 16 GB → XL base Q8
  }, [gpuInfo]);

  /** Per-preset aggregate progress: {presetId → {done, total, percent}}. */
  const presetProgress = useMemo(() => {
    const result: Record<string, { done: number; total: number; percent: number }> = {};
    for (const preset of presets) {
      let done = 0;
      let totalBytes = 0;
      let downloadedBytes = 0;
      for (const modelId of preset.modelIds) {
        const catalogEntry = catalog.find((c) => c.id === modelId);
        if (!catalogEntry) continue;
        totalBytes += catalogEntry.approxSizeBytes;
        const prog = progress[modelId];
        if (catalogEntry.exists) {
          done += 1;
          downloadedBytes += catalogEntry.approxSizeBytes;
        } else if (prog && prog.total > 0) {
          downloadedBytes += (prog.progress / prog.total) * catalogEntry.approxSizeBytes;
          if (prog.status === 'Completed') done += 1;
        }
      }
      const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
      result[preset.id] = { done, total: preset.totalCount, percent };
    }
    return result;
  }, [presets, catalog, progress]);

  // Group catalog by role (for advanced section).
  const byRole = catalog.reduce<Record<string, AceStepCatalogEntry[]>>((acc, entry) => {
    if (!acc[entry.role]) acc[entry.role] = [];
    acc[entry.role].push(entry);
    return acc;
  }, {});

  const hasMissing = catalog.some((e) => !e.exists);
  const allDownloading = downloading.size > 0;

  // ---- Render ----

  return (
    <div className="ai00-x-acestep-view ai00-x-acestep-view--scroll ai00-x-mgr">
      <div className="ai00-x-acestep-view__header">
        <h2>{t('nav.modelManager', { defaultValue: 'Model Manager' })}</h2>
        <p className="ai00-x-acestep-view__hint">
          {t('modelManagerHint', { defaultValue: 'Load and manage AI00-Music models' })}
        </p>
      </div>

      <div className="ai00-x-acestep-view__content">
        {/* Pipeline status */}
        <div className="ai00-x-mgr__status-bar">
          <span className={`ai00-x-mgr__pipeline-dot ${synthLoaded && lmLoaded ? 'is-ready' : 'is-idle'}`} />
          <span>
            {synthLoaded && lmLoaded
              ? t('modelLoader.loaded', { defaultValue: 'Models loaded' })
              : t('mgr.pipelineNotLoaded', { defaultValue: 'Pipeline not loaded' })}
          </span>
          {synthLoaded && !lmLoaded && (
            <span className="ai00-x-mgr__partial">
              {t('mgr.synthOnly', { defaultValue: '(synth loaded, LM not loaded)' })}
            </span>
          )}
        </div>

        {/* GPU info bar */}
        <div className="ai00-x-mgr__gpu-bar">
          {gpuLoading ? (
            <Loader2 size={13} className="spin" />
          ) : gpuInfo?.gpuName ? (
            <span className="ai00-x-mgr__gpu-info">
              {t('preset.gpuDetected', {
                defaultValue: 'GPU: {{name}} ({{vram}}MB)',
                name: gpuInfo.gpuName,
                vram: gpuInfo.vramMb ?? 0,
              })}
            </span>
          ) : (
            <span className="ai00-x-mgr__gpu-info is-unknown">
              {t('preset.gpuNotDetected', { defaultValue: 'GPU not detected — manual selection' })}
            </span>
          )}
          <button
            type="button"
            className="ai00-x-mgr__gpu-refresh"
            onClick={refreshGpu}
            disabled={gpuLoading}
          >
            {gpuLoading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
            {t('preset.refreshGpu', { defaultValue: 'Refresh' })}
          </button>
        </div>

        {/* Preset cards */}
        <div className="ai00-x-mgr__presets">
          {presetsLoading && presets.length === 0 ? (
            <div className="ai00-x-mgr__presets-loading">
              <Loader2 size={16} className="spin" />
            </div>
          ) : (
            presets.map((preset) => {
              const isRecommended = preset.id === recommendedPresetId;
              const isActive = preset.id === activePresetId && allDownloading;
              const isReady = preset.downloadedCount === preset.totalCount;
              const prog = presetProgress[preset.id] ?? { done: 0, total: 0, percent: 0 };

              return (
                <div
                  key={preset.id}
                  className={`ai00-x-mgr__preset-card ${isRecommended ? 'is-recommended' : ''} ${isReady ? 'is-ready' : ''}`}
                >
                  {isRecommended && (
                    <span className="ai00-x-mgr__preset-recommend">
                      <Sparkles size={10} />
                      {t('preset.recommended', { defaultValue: 'Recommended for your GPU' })}
                    </span>
                  )}

                  <div className="ai00-x-mgr__preset-header">
                    <span className={`ai00-x-mgr__preset-badge is-${preset.ditType}`}>
                      {preset.ditType === 'xl-base'
                        ? t('preset.xlBaseBadge', { defaultValue: 'XL BASE' })
                        : t('preset.baseBadge', { defaultValue: 'BASE' })}
                    </span>
                    <span className="ai00-x-mgr__preset-name">
                      {preset.id === 'base-q5'
                        ? t('preset.baseQ5', { defaultValue: 'Base Q5' })
                        : preset.id === 'base-q8'
                          ? t('preset.baseQ8', { defaultValue: 'Base Q8' })
                          : preset.id === 'xl-base-q5'
                            ? t('preset.xlBaseQ5', { defaultValue: 'XL Base Q5' })
                            : t('preset.xlBaseQ8', { defaultValue: 'XL Base Q8' })}
                    </span>
                  </div>

                  <p className="ai00-x-mgr__preset-desc">
                    {preset.id === 'base-q5'
                      ? t('preset.baseQ5Desc', { defaultValue: '2B base, Q5_K_M, ~2.8GB, ≥4GB VRAM' })
                      : preset.id === 'base-q8'
                        ? t('preset.baseQ8Desc', { defaultValue: '2B base, Q8_0, ~3.6GB, ≥8GB VRAM' })
                        : preset.id === 'xl-base-q5'
                          ? t('preset.xlBaseQ5Desc', { defaultValue: '4B XL base, Q5_K_M, ~4.6GB, ≥12GB VRAM' })
                          : t('preset.xlBaseQ8Desc', { defaultValue: '4B XL base, Q8_0, ~6.4GB, ≥16GB VRAM' })}
                  </p>

                  <div className="ai00-x-mgr__preset-meta">
                    <span>{t('preset.totalSize', { defaultValue: '{{size}} total', size: formatSize(preset.totalSizeBytes) })}</span>
                    <span>{t('preset.recommendedVram', { defaultValue: '≥{{mb}}MB VRAM', mb: preset.recommendedVramMb })}</span>
                    <span>{t('preset.inferenceSteps', { defaultValue: '{{steps}} steps', steps: preset.inferenceSteps })}</span>
                  </div>

                  <div className="ai00-x-mgr__preset-tasks">
                    <span className="ai00-x-mgr__preset-tasks-label">
                      {t('preset.supportedTasks', { defaultValue: 'Supported tasks' })}
                    </span>
                    <div className="ai00-x-mgr__task-grid">
                      {ALL_TASKS.map((task) => {
                        const supported = preset.supportedTasks.includes(task);
                        return (
                          <span
                            key={task}
                            className={`ai00-x-mgr__task-chip ${supported ? 'is-supported' : 'is-unsupported'}`}
                          >
                            {supported ? <CheckCircle2 size={10} /> : <span className="ai00-x-mgr__task-x">×</span>}
                            {t(`preset.${TASK_I18N_KEY[task]}`, { defaultValue: task })}
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  {/* Progress bar when downloading */}
                  {isActive && (
                    <div className="ai00-x-mgr__preset-progress">
                      <div
                        className="ai00-x-mgr__preset-progress-fill"
                        style={{ width: `${prog.percent}%` }}
                      />
                      <span className="ai00-x-mgr__preset-progress-text">
                        {t('preset.downloading', {
                          defaultValue: 'Downloading {{done}}/{{total}}...',
                          done: prog.done,
                          total: prog.total,
                        })}
                      </span>
                    </div>
                  )}

                  <div className="ai00-x-mgr__preset-actions">
                    {isReady ? (
                      <span className="ai00-x-mgr__preset-ready">
                        <CheckCircle2 size={13} />
                        {t('preset.presetReady', { defaultValue: 'Ready' })}
                      </span>
                    ) : (
                      <>
                        <span className="ai00-x-mgr__preset-count">
                          {t('preset.presetProgress', {
                            defaultValue: '{{done}}/{{total}} files',
                            done: preset.downloadedCount,
                            total: preset.totalCount,
                          })}
                        </span>
                        <button
                          type="button"
                          className="ai00-x-mgr__preset-download-btn"
                          onClick={() => handleDownloadPreset(preset.id)}
                          disabled={allDownloading}
                        >
                          {isActive ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
                          {t('preset.downloadPreset', { defaultValue: 'Download All' })}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Advanced section (collapsible) */}
        <div className="ai00-x-mgr__advanced">
          <button
            type="button"
            className="ai00-x-mgr__advanced-toggle"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {t('preset.advanced', { defaultValue: 'Advanced (pick variants manually)' })}
          </button>

          {advancedOpen && (
            <>
              {/* Mirror speed test */}
              <div className="ai00-x-mgr__mirrors">
                <button
                  type="button"
                  className="ai00-x-mgr__mirror-btn"
                  onClick={handleTestMirrors}
                  disabled={mirrorLoading}
                >
                  {mirrorLoading ? <Loader2 size={13} className="spin" /> : <Zap size={13} />}
                  {t('mgr.testMirrors', { defaultValue: 'Test mirror speeds' })}
                </button>
                {mirrors.length > 0 && (
                  <div className="ai00-x-mgr__mirror-list">
                    {mirrors.map((m) => (
                      <span
                        key={m.mirror}
                        className={`ai00-x-mgr__mirror-item ${m.latencyMs === null ? 'is-offline' : 'is-online'}`}
                      >
                        {m.mirror.replace('https://', '')}
                        {m.latencyMs !== null ? ` (${m.latencyMs}ms)` : ' (offline)'}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Catalog table */}
              <div className="ai00-x-mgr__catalog">
                <div className="ai00-x-mgr__catalog-header">
                  <span className="ai00-x-mgr__catalog-title">
                    {t('mgr.catalog', { defaultValue: 'Model Catalog' })}
                  </span>
                  <div className="ai00-x-mgr__catalog-actions">
                    <button
                      type="button"
                      className="ai00-x-mgr__refresh-btn"
                      onClick={refreshCatalog}
                      disabled={catalogLoading}
                    >
                      {catalogLoading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                    </button>
                    {hasMissing && (
                      <button
                        type="button"
                        className="ai00-x-mgr__download-all-btn"
                        onClick={handleDownloadAll}
                        disabled={allDownloading}
                      >
                        <Download size={13} />
                        {t('mgr.downloadAll', { defaultValue: 'Download all recommended' })}
                      </button>
                    )}
                  </div>
                </div>

                {ROLE_ORDER.map((role) => {
                  const entries = byRole[role];
                  if (!entries || entries.length === 0) return null;
                  return (
                    <div key={role} className="ai00-x-mgr__role-group">
                      <div className="ai00-x-mgr__role-label">
                        {ROLE_LABELS[role] ?? role}
                      </div>
                      {entries.map((entry) => {
                        const prog = progress[entry.id];
                        const isDownloading = downloading.has(entry.id)
                          && prog
                          && (prog.status === 'Downloading' || prog.status === 'Pending');
                        const progressPercent = prog && prog.total > 0
                          ? Math.round((prog.progress / prog.total) * 100)
                          : 0;
                        const isFailed = prog?.status === 'Failed';

                        return (
                          <div
                            key={entry.id}
                            className={`ai00-x-mgr__catalog-row ${entry.exists ? 'is-exists' : 'is-missing'}`}
                          >
                            <span className="ai00-x-mgr__row-variant">
                              {entry.variant}
                              {entry.ditType !== 'common' && (
                                <span className={`ai00-x-mgr__row-dit-type is-${entry.ditType}`}>
                                  {entry.ditType.toUpperCase()}
                                </span>
                              )}
                              {entry.recommended && (
                                <span className="ai00-x-mgr__row-badge">
                                  {t('mgr.recommended', { defaultValue: 'recommended' })}
                                </span>
                              )}
                            </span>
                            <span className="ai00-x-mgr__row-size">
                              {formatSize(entry.approxSizeBytes)}
                            </span>
                            <span className="ai00-x-mgr__row-status">
                              {entry.exists ? (
                                <><CheckCircle2 size={12} /> {formatSize(entry.localSize)}</>
                              ) : isFailed ? (
                                <><AlertCircle size={12} /> {t('mgr.failed', { defaultValue: 'Failed' })}</>
                              ) : isDownloading ? (
                                <span className="ai00-x-mgr__row-progress">
                                  {progressPercent}%
                                </span>
                              ) : (
                                <span className="ai00-x-mgr__row-missing">
                                  {t('mgr.notDownloaded', { defaultValue: 'missing' })}
                                </span>
                              )}
                            </span>
                            {isDownloading && (
                              <div className="ai00-x-mgr__row-progress-bar">
                                <div
                                  className="ai00-x-mgr__row-progress-fill"
                                  style={{ width: `${progressPercent}%` }}
                                />
                              </div>
                            )}
                            {!entry.exists && !isDownloading && (
                              <button
                                type="button"
                                className="ai00-x-mgr__download-btn"
                                onClick={() => handleDownload(entry.id)}
                                disabled={allDownloading}
                              >
                                <Download size={11} />
                                {t('mgr.download', { defaultValue: 'Download' })}
                              </button>
                            )}
                            {isFailed && (
                              <button
                                type="button"
                                className="ai00-x-mgr__download-btn"
                                onClick={() => handleDownload(entry.id)}
                                disabled={allDownloading}
                              >
                                <RefreshCw size={11} />
                                {t('mgr.retry', { defaultValue: 'Retry' })}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ModelManagerView;
