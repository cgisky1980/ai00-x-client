/**
 * ModelManagerView — ACE-Step model management + download view.
 *
 * Shows the full model catalog with per-file download status and inline
 * download progress. Downloading a single DiT variant automatically pulls
 * the full required bundle (text encoder + DiT + VAE).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, CheckCircle2, Download,
  Loader2, RefreshCw, Zap,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { aceStepService } from '../services/AceStepService';
import { useAceStepStore } from '../store/acestepStore';
import type {
  AceStepCatalogEntry, AceStepDownloadProgress, AceStepGpuInfo,
  AceStepMirrorSpeed,
} from '../types';

import './ModelManagerView.scss';

const ROLE_ORDER = ['text_encoder', 'dit', 'vae'];
const ROLE_LABELS: Record<string, string> = {
  text_encoder: 'Text Encoder',
  dit: 'DiT',
  vae: 'VAE',
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
  const [gpuInfo, setGpuInfo] = useState<AceStepGpuInfo | null>(null);
  const [gpuLoading, setGpuLoading] = useState(false);
  const [progress, setProgress] = useState<Record<string, AceStepDownloadProgress>>({});
  const [mirrors, setMirrors] = useState<AceStepMirrorSpeed[]>([]);
  const [mirrorLoading, setMirrorLoading] = useState(false);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());

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
    refreshGpu();
  }, [refreshCatalog, refreshGpu]);

  // Poll download progress for all active downloads.
  useEffect(() => {
    if (downloading.size === 0) {
      setProgress({});
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

      // If some downloads finished, refresh catalog and prune the set.
      if (stillDownloading.length < downloading.size) {
        refreshCatalog();
        if (stillDownloading.length === 0) {
          setDownloading(new Set());
        } else {
          setDownloading(new Set(stillDownloading));
        }
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [downloading, refreshCatalog]);

  // ---- Handlers ----

  const handleDownload = useCallback(async (id: string) => {
    try {
      const entry = catalog.find((e) => e.id === id);
      // For DiT variants, auto-download the full required bundle
      // (text encoder + this DiT + VAE) instead of a single file.
      if (entry && entry.role === 'dit') {
        const family = entry.ditType === 'xl-base' ? 'xl-base' : 'base';
        const quant = entry.variant.includes('Q8') ? 'q8' : 'q5';
        const ids = await aceStepService.downloadPreset(`${family}-${quant}`);
        setDownloading(new Set(ids));
        return;
      }
      await aceStepService.downloadModel(id);
      setDownloading((prev) => new Set(prev).add(id));
    } catch (e) {
      console.error('Download failed', e);
    }
  }, [catalog]);

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

        {/* Model catalog */}
        <div className="ai00-x-mgr__advanced">
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
        </div>
      </div>
    </div>
  );
};

export default ModelManagerView;
