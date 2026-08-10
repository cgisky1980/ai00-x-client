/**
 * SessionAudioList — scrollable audio preview list for the active session.
 *
 * Shows all generated audio outputs for the current session, newest first.
 * Each item shows label, duration, creation time, an inline AudioPlayer,
 * a "Package" button (bundles WAV→FLAC + LRC + creation context into a
 * `.a00m` archive; auto-generates LRC first if missing), a "View LRC"
 * toggle (for inspecting the embedded lyrics), a Copy button (LRC to
 * clipboard), and a delete button.
 */

import React, { useMemo, useState } from 'react';
import {
  Trash2,
  Music,
  Clock,
  Loader2,
  Copy,
  Check,
  Download,
  Package,
  PackageCheck,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { useAceStepStore } from '../store/acestepStore';
import { AudioPlayer } from './AudioPlayer';
import { PackageDialog } from './PackageDialog';
import { ScoreBadge } from './ScoreBadge';
import type { PackageDialogOptions } from '../types';
import './SessionAudioList.scss';

const EMPTY_ARRAY: never[] = [];

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Format byte count as a human-readable string (e.g. "12.3 MB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const SessionAudioList: React.FC = () => {
  const { t } = useI18n('acestep');
  const activeSession = useAceStepStore((s) => s.activeSession);
  const outputs = useAceStepStore((s) => s.activeSession?.outputs ?? EMPTY_ARRAY);
  const creationPlan = useAceStepStore((s) => s.activeSession?.creationPlan ?? null);
  const removeOutput = useAceStepStore((s) => s.removeOutput);
  const packageSong = useAceStepStore((s) => s.packageSong);
  const lrcGeneratingId = useAceStepStore((s) => s.lrcGeneratingId);
  const packagingId = useAceStepStore((s) => s.packagingId);
  const alignerDownload = useAceStepStore((s) => s.alignerDownload);
  const lrcError = useAceStepStore((s) => s.error);
  const clearError = useAceStepStore((s) => s.clearError);
  const lrcProgress = useAceStepStore((s) => s.lrcProgress);
  const [expandedLrcId, setExpandedLrcId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** Path of the most recent successful `.a00m` package, for inline feedback. */
  const [packagedPath, setPackagedPath] = useState<{ id: string; path: string; size: number } | null>(
    null,
  );
  /** Audio id currently being configured in the PackageDialog (null = closed). */
  const [packageDialogAudioId, setPackageDialogAudioId] = useState<string | null>(null);
  const packageDialogOpen = packageDialogAudioId !== null;

  // Download progress percentage for display.
  const dlPercent = alignerDownload && alignerDownload.total
    ? Math.round((alignerDownload.progress / alignerDownload.total) * 100)
    : null;
  const dlMiB = alignerDownload
    ? (alignerDownload.progress / (1024 * 1024)).toFixed(1)
    : null;
  const dlTotalMiB = alignerDownload?.total
    ? (alignerDownload.total / (1024 * 1024)).toFixed(0)
    : null;

  // Show newest first.
  const sorted = useMemo(
    () => [...outputs].sort((a, b) => b.createdAt - a.createdAt),
    [outputs],
  );

  if (sorted.length === 0) {
    return (
      <div className="session-audio session-audio--empty">
        <div className="session-audio__empty-icon">
          <Music size={24} />
        </div>
        <p>{t('chatCreate.audioEmpty', { defaultValue: 'No audio yet. Generate to hear your music.' })}</p>
      </div>
    );
  }

  /**
   * Open the PackageDialog to configure packaging options (title, artist,
   * album, genre, cover, output directory, filename). The dialog drives the
   * actual packaging via `handlePackageConfirm`.
   *
   * We refuse to package instrumental tracks without lyrics — the format
   * requires at least a creation plan or lyrics to be meaningful.
   */
  const handlePackage = (audioId: string) => {
    const hasLyrics = !!(creationPlan?.lyrics ?? '').trim();
    if (!hasLyrics) {
      alert(
        t('chatCreate.packageNoLyrics', {
          defaultValue:
            'No lyrics found in the creation plan. Add lyrics before packaging.',
        }),
      );
      return;
    }
    setPackagedPath(null);
    setPackageDialogAudioId(audioId);
  };

  /**
   * Called by PackageDialog when the user clicks "Start Packaging".
   *
   * Delegates to the store's `packageSong` action, which handles LRC
   * generation, internal trace info collection, and backend invocation.
   * On success, closes the dialog and shows inline feedback. On failure,
   * keeps the dialog open so the user can see the error and retry.
   */
  const handlePackageConfirm = async (options: PackageDialogOptions) => {
    if (!packageDialogAudioId) return;
    const result = await packageSong(packageDialogAudioId, options);
    if (result) {
      setPackagedPath({
        id: packageDialogAudioId,
        path: result.outputPath,
        size: result.fileSizeBytes,
      });
      setPackageDialogAudioId(null);
    }
    // On failure, keep the dialog open — store.error is already set.
  };

  const handleCopyLrc = async (audioId: string, lrc: string) => {
    try {
      await navigator.clipboard.writeText(lrc);
      setCopiedId(audioId);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // clipboard may be unavailable in some webviews
    }
  };

  return (
    <div className="session-audio">
      <div className="session-audio__header">
        <span className="session-audio__title">
          {t('chatCreate.audioTitle', { defaultValue: 'Generated Audio' })}
        </span>
        <span className="session-audio__count">{sorted.length}</span>
      </div>
      <div className="session-audio__list">
        {sorted.map((o) => {
          const isGeneratingLrc = lrcGeneratingId === o.id;
          const isPackaging = packagingId === o.id;
          const hasLrc = !!o.lrc;
          const isExpanded = expandedLrcId === o.id;
          // While packaging, the store may have triggered LRC generation
          // internally — surface that progress to the user via the same
          // Package button so they see what stage we're on. We treat the
          // button as busy whenever either flag is set for this output AND
          // a packaging flow is in progress (packagingId is non-null
          // somewhere, OR this specific output is actively packaging).
          const packageBusy = isPackaging || isGeneratingLrc;
          return (
            <div key={o.id} className="session-audio__item">
              <div className="session-audio__item-header">
                <span className="session-audio__item-label">{o.label}</span>
                <button
                  type="button"
                  className="session-audio__item-delete"
                  onClick={() => removeOutput(o.id)}
                  title={t('common.delete', { defaultValue: 'Delete' })}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="session-audio__item-meta">
                <span className="session-audio__item-duration">
                  <Clock size={10} style={{ marginRight: 3, verticalAlign: 'middle' }} />
                  {o.durationSeconds.toFixed(1)}s
                </span>
                <span className="session-audio__item-time">
                  {formatTime(o.createdAt)}
                </span>
                <ScoreBadge score={o.score} />
              </div>
              <div className="session-audio__item-player">
                <AudioPlayer filePath={o.outputPath} />
              </div>

              <div className="session-audio__item-actions">
                <button
                  type="button"
                  className="session-audio__item-lrc-btn"
                  disabled={packageBusy}
                  onClick={() => handlePackage(o.id)}
                  title={
                    alignerDownload
                      ? t('chatCreate.lrcDownloadingTitle', {
                          defaultValue:
                            'Downloading ForcedAligner model (~994 MB)...',
                        })
                      : t('chatCreate.packageButtonTitle', {
                          defaultValue:
                            'Bundle this song into a .a00m archive (WAV→FLAC + LRC + creation context). Auto-generates LRC first if missing.',
                        })
                    }
                >
                  {packageBusy && alignerDownload ? (
                    <Download size={12} />
                  ) : packageBusy ? (
                    <Loader2 size={12} className="session-audio__spin" />
                  ) : packagedPath?.id === o.id ? (
                    <PackageCheck size={12} />
                  ) : (
                    <Package size={12} />
                  )}
                  <span>
                    {packageBusy && alignerDownload
                      ? dlPercent !== null
                        ? t('chatCreate.lrcDownloadingPct', {
                            defaultValue: 'Downloading {{pct}}% ({{miB}}/{{totalMiB}} MiB)',
                            pct: dlPercent,
                            miB: dlMiB,
                            totalMiB: dlTotalMiB,
                          })
                        : t('chatCreate.lrcDownloading', {
                            defaultValue: 'Downloading {{miB}} MiB...',
                            miB: dlMiB,
                          })
                      : packageBusy
                        ? lrcProgress
                          ? `${lrcProgress.message || lrcProgress.stage} (${Math.round((lrcProgress.progress ?? 0) * 100)}%)`
                          : t('chatCreate.packaging', { defaultValue: 'Packaging…' })
                        : packagedPath?.id === o.id
                          ? t('chatCreate.packageDone', { defaultValue: 'Packaged' })
                          : t('chatCreate.package', { defaultValue: 'Package' })}
                  </span>
                </button>
                {hasLrc && (
                  <button
                    type="button"
                    className="session-audio__item-lrc-toggle"
                    onClick={() => setExpandedLrcId(isExpanded ? null : o.id)}
                  >
                    {isExpanded
                      ? t('chatCreate.lrcHide', { defaultValue: 'Hide LRC' })
                      : t('chatCreate.lrcShow', { defaultValue: 'View LRC' })}
                  </button>
                )}
              </div>

              {/* LRC error feedback */}
              {lrcError && !packageBusy && !hasLrc && (
                <div className="session-audio__item-error">
                  <span className="session-audio__item-error-text">{lrcError}</span>
                  <button
                    type="button"
                    className="session-audio__item-error-dismiss"
                    onClick={() => clearError()}
                  >
                    &times;
                  </button>
                </div>
              )}

              {/* Package success feedback */}
              {packagedPath?.id === o.id && !packageBusy && (
                <div className="session-audio__item-lrc-status">
                  {t('chatCreate.packageSuccess', {
                    defaultValue: 'Packaged: {{path}} ({{size}})',
                    path: packagedPath.path,
                    size: formatBytes(packagedPath.size),
                  })}
                </div>
              )}

              {/* LRC ready feedback (only when not just packaged) */}
              {hasLrc && !packageBusy && packagedPath?.id !== o.id && (
                <div className="session-audio__item-lrc-status">
                  {t('chatCreate.lrcDone', { defaultValue: 'LRC generated' })}
                </div>
              )}

              {hasLrc && isExpanded && (
                <div className="session-audio__item-lrc">
                  <div className="session-audio__item-lrc-header">
                    <span className="session-audio__item-lrc-path" title={o.lrcPath}>
                      {o.lrcPath}
                    </span>
                    <button
                      type="button"
                      className="session-audio__item-lrc-copy"
                      onClick={() => o.lrc && handleCopyLrc(o.id, o.lrc)}
                      title={t('common.copy', { defaultValue: 'Copy' })}
                    >
                      {copiedId === o.id ? <Check size={11} /> : <Copy size={11} />}
                    </button>
                  </div>
                  <pre className="session-audio__item-lrc-content">{o.lrc}</pre>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Package settings dialog (opened by the Package button) */}
      <PackageDialog
        isOpen={packageDialogOpen}
        onClose={() => setPackageDialogAudioId(null)}
        onConfirm={handlePackageConfirm}
        audioId={packageDialogAudioId}
        defaultTitle={
          activeSession?.title ||
          (packageDialogAudioId
            ? outputs.find((o) => o.id === packageDialogAudioId)?.label
            : '') ||
          'Untitled'
        }
        isPackaging={!!packagingId}
      />
    </div>
  );
};