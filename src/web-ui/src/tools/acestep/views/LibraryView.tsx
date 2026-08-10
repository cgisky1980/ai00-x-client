/**
 * LibraryView — 音乐库视图。
 *
 * 展示 songs 目录下的 `.a00m` 文件（音乐库），底部带预览播放条。
 * 打包在创作页进行（SessionAudioList 的 Package 按钮）；分享开关后续在
 * 播放器侧设计，本视图不再包含「本次会话」和「分享广场」。
 *
 * 布局：header（固定）/ content（滚动）/ 预览播放条（固定底部）。
 * 预览播放条是 `playerStore` 的纯 UI 镜像 —— 实际音频由常驻的
 * `PlayerEngine` 播放，主窗口灵动岛 `MusicActivity` 经 PlayerBridge 同步。
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Clock,
  HardDrive,
  Loader2,
  Lock,
  Music,
  Package,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { confirmDanger } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { usePlayerStore, type PlaylistItem } from '../store/playerStore';
import { useShareStore } from '../store/shareStore';
import { aceStepService } from '../services/AceStepService';
import { ArchiveShareDialog } from '../components/ArchiveShareDialog';
import { SongMetaEditDialog } from '../components/SongMetaEditDialog';
import { ScoreBadge } from '../components/ScoreBadge';
import { formatTimeDisplay } from '../utils/lrcParser';
import type { SongEntry } from '../types';
import './LibraryView.scss';

/** Format a Unix-ms timestamp as a localized date (e.g. `2026-07-18`). */
function formatDate(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Human-readable file size (KB / MB). */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Derive the cache directory for a .a00m file (mirrors playerStore.cacheDirFor). */
function cacheDirFor(songsDir: string, entryPath: string): string {
  const filename = entryPath.split(/[\\/]/).pop() ?? '';
  const stem = filename.replace(/\.a00m$/i, '');
  const safeStem = stem.replace(/[\\/]/g, '_');
  return `${songsDir}/.cache/${safeStem}`;
}

/**
 * Preview player bar — pinned to the bottom of the library view.
 *
 * Pure UI mirror of `playerStore`: play/pause, click-to-seek progress, and
 * close. Rendered only while a song is loaded (`currentEntry` non-null).
 */
const LibraryPreviewBar: React.FC = () => {
  const { t } = useI18n('acestep');
  const currentEntry = usePlayerStore((s) => s.currentEntry);
  const currentSong = usePlayerStore((s) => s.currentSong);
  const coverPath = usePlayerStore((s) => s.coverPath);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const unpackingPath = usePlayerStore((s) => s.unpackingPath);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const seek = usePlayerStore((s) => s.seek);
  const closePlayer = usePlayerStore((s) => s.closePlayer);

  if (!currentEntry) return null;

  const busy = unpackingPath !== null;
  const coverUrl = coverPath ? convertFileSrc(coverPath) : null;
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    seek(ratio * duration);
  };

  return (
    <div className="ai00-x-library__preview">
      <div className="ai00-x-library__preview-cover" aria-hidden>
        {coverUrl ? <img src={coverUrl} alt="" /> : <Music size={16} />}
      </div>
      <div className="ai00-x-library__preview-info">
        <span
          className="ai00-x-library__preview-title"
          title={currentSong?.title ?? currentEntry.filename}
        >
          {currentSong?.title ?? currentEntry.filename}
        </span>
        <span className="ai00-x-library__preview-artist" title={currentSong?.artist}>
          {currentSong?.artist ?? ''}
        </span>
      </div>
      <button
        type="button"
        className="ai00-x-library__preview-btn ai00-x-library__preview-btn--play"
        onClick={togglePlay}
        disabled={busy}
        title={
          isPlaying
            ? t('library.pause', { defaultValue: 'Pause' })
            : t('library.play', { defaultValue: 'Play' })
        }
        aria-label={
          isPlaying
            ? t('library.pause', { defaultValue: 'Pause' })
            : t('library.play', { defaultValue: 'Play' })
        }
      >
        {busy ? (
          <Loader2 size={14} className="ai00-x-library__preview-spin" />
        ) : isPlaying ? (
          <Pause size={14} />
        ) : (
          <Play size={14} />
        )}
      </button>
      <span className="ai00-x-library__preview-time">{formatTimeDisplay(currentTime)}</span>
      <div
        className="ai00-x-library__preview-progress"
        onClick={handleProgressClick}
        role="slider"
        aria-label={t('library.progress', { defaultValue: 'Progress' })}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
      >
        <div className="ai00-x-library__preview-track">
          <div className="ai00-x-library__preview-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <span className="ai00-x-library__preview-time">{formatTimeDisplay(duration)}</span>
      <button
        type="button"
        className="ai00-x-library__preview-btn"
        onClick={closePlayer}
        title={t('library.closePlayer', { defaultValue: 'Close' })}
        aria-label={t('library.closePlayer', { defaultValue: 'Close' })}
      >
        <X size={14} />
      </button>
    </div>
  );
};

const LibraryView: React.FC = () => {
  const { t } = useI18n('acestep');

  // Player store — archives launch playback through the shared engine.
  const setPlaylist = usePlayerStore((s) => s.setPlaylist);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const playingPath = usePlayerStore((s) => s.currentEntry?.path ?? null);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  // ---- Archive list state ----
  const [archives, setArchives] = useState<SongEntry[]>([]);
  const [archivesLoading, setArchivesLoading] = useState(false);
  const [archivesError, setArchivesError] = useState<string | null>(null);
  /** Map of `entry.path` → extracted cover absolute path (or null = no cover). */
  const [coverPaths, setCoverPaths] = useState<Record<string, string | null>>({});
  /** 归档分享对话框当前目标（null = 关闭） */
  const [shareDialogEntry, setShareDialogEntry] = useState<SongEntry | null>(null);
  /** 编辑元数据对话框当前目标（null = 关闭） */
  const [editDialogEntry, setEditDialogEntry] = useState<SongEntry | null>(null);
  /** 删除进行中的归档路径（禁用对应卡片按钮） */
  const [deletingPath, setDeletingPath] = useState<string | null>(null);

  // ---- 分享状态（作品库「已分享」标记） ----
  const archiveShareMap = useShareStore((s) => s.archiveShareMap);
  const unshareArchive = useShareStore((s) => s.unshareArchive);
  const removeArchiveMapping = useShareStore((s) => s.removeArchiveMapping);

  /**
   * Scan the songs directory for .a00m files and extract cover thumbnails
   * for unencrypted archives. Encrypted archives are listed but their cover
   * and metadata are withheld until the user enters a password.
   */
  const refreshArchives = useCallback(async () => {
    setArchivesLoading(true);
    setArchivesError(null);
    try {
      const [list, songsDir] = await Promise.all([
        aceStepService.listSongs(),
        aceStepService.getSongsDir(),
      ]);
      setArchives(list);

      // Eagerly extract covers for all archives in parallel.
      // Encrypted archives are auto-decrypted with the current version's
      // fixed password on the backend (password is not exposed to the UI).
      const coverEntries = await Promise.all(
        list.map(async (entry) => {
          try {
            const cacheDir = cacheDirFor(songsDir, entry.path);
            const coverPath = await aceStepService.extractCover(entry.path, cacheDir);
            return [entry.path, coverPath] as const;
          } catch {
            return [entry.path, null] as const;
          }
        }),
      );
      const coverMap: Record<string, string | null> = {};
      for (const [path, coverPath] of coverEntries) {
        coverMap[path] = coverPath;
      }
      setCoverPaths(coverMap);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setArchivesError(msg);
    } finally {
      setArchivesLoading(false);
    }
  }, []);

  // Scan once on mount, and re-scan when the workspace regains focus.
  useEffect(() => {
    void refreshArchives();
    const handler = () => void refreshArchives();
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [refreshArchives]);

  /**
   * 删除归档：确认后先吊销服务端分享（若有映射），再删除本地 `.a00m`
   * 文件及其解包缓存。正在播放该归档时先关闭播放器。
   */
  const handleDelete = useCallback(
    async (entry: SongEntry) => {
      const displayTitle = entry.meta?.title ?? entry.filename;
      const shared = Boolean(archiveShareMap[entry.path]);
      const ok = await confirmDanger(
        t('library.deleteConfirmTitle', { defaultValue: 'Delete song' }),
        shared
          ? t('library.deleteConfirmShared', {
              title: displayTitle,
              defaultValue: `Delete "{{title}}"? The local file will be removed and its share will be revoked.`,
            })
          : t('library.deleteConfirm', {
              title: displayTitle,
              defaultValue: `Delete "{{title}}"? The local file will be permanently removed.`,
            }),
        { confirmText: t('library.delete', { defaultValue: 'Delete' }) },
      );
      if (!ok) return;

      setDeletingPath(entry.path);
      setArchivesError(null);
      try {
        // 先吊销服务端分享并移除映射（失败不阻塞本地删除）
        await removeArchiveMapping(entry.path, true);
        await aceStepService.deleteSong(entry.path);
        // 正在播放该归档 → 关闭播放器
        if (usePlayerStore.getState().currentEntry?.path === entry.path) {
          usePlayerStore.getState().closePlayer();
        }
      } catch (e) {
        setArchivesError(e instanceof Error ? e.message : String(e));
      } finally {
        setDeletingPath(null);
        // 重新扫描磁盘，确保列表与实际文件一致
        void refreshArchives();
      }
    },
    [archiveShareMap, removeArchiveMapping, t, refreshArchives],
  );

  /**
   * 分享按钮：未分享 → 打开分享对话框；已分享 → 确认后取消分享。
   */
  const handleShareClick = useCallback(
    async (entry: SongEntry) => {
      if (archiveShareMap[entry.path]) {
        const displayTitle = entry.meta?.title ?? entry.filename;
        const ok = await confirmDanger(
          t('library.unshareConfirmTitle', { defaultValue: 'Unshare song' }),
          t('library.unshareConfirm', {
            title: displayTitle,
            defaultValue: `Stop sharing "{{title}}"? The share link will stop working.`,
          }),
          { confirmText: t('library.unshare', { defaultValue: 'Unshare' }) },
        );
        if (!ok) return;
        setArchivesError(null);
        try {
          await unshareArchive(entry.path);
        } catch (e) {
          setArchivesError(e instanceof Error ? e.message : String(e));
        }
      } else {
        setShareDialogEntry(entry);
      }
    },
    [archiveShareMap, unshareArchive, t],
  );

  return (
    <div className="ai00-x-acestep-view ai00-x-library">
      <div className="ai00-x-acestep-view__header ai00-x-library__header">
        <h2>{t('nav.library', { defaultValue: 'Library' })}</h2>
        <button
          type="button"
          className="ai00-x-library__refresh"
          onClick={() => void refreshArchives()}
          disabled={archivesLoading}
          title={t('library.refresh', { defaultValue: 'Refresh' })}
          aria-label={t('library.refresh', { defaultValue: 'Refresh' })}
        >
          <RefreshCw size={14} className={archivesLoading ? 'is-spinning' : undefined} />
        </button>
        <span className="ai00-x-library__count">
          {t('library.archivesHint', {
            count: archives.length,
            defaultValue: '{{count}} song(s)',
          })}
        </span>
      </div>

      <div className="ai00-x-acestep-view__content">
        {archivesError && (
          <div className="ai00-x-library__error" role="alert">
            {archivesError}
          </div>
        )}

        {archives.length === 0 && !archivesLoading && !archivesError ? (
          <div className="ai00-x-library__empty">
            <Package size={28} />
            <p>
              {t('library.archivesEmpty', {
                defaultValue:
                  'No packaged archives yet. Click the Package button on a generated song to create a .a00m file.',
              })}
            </p>
          </div>
        ) : (
          <div className="ai00-x-library__archive-grid">
            {archives.map((entry) => {
              const meta = entry.meta;
              const coverPath = coverPaths[entry.path];
              const coverUrl = coverPath ? convertFileSrc(coverPath) : null;
              const isPlayingThis = playingPath === entry.path;
              const sharedShareId = archiveShareMap[entry.path];
              const isShared = Boolean(sharedShareId);
              const isDeleting = deletingPath === entry.path;
              return (
                <div
                  key={entry.path}
                  className={`ai00-x-library__archive-card${
                    isPlayingThis ? ' is-playing' : ''
                  }`}
                >
                  <div className="ai00-x-library__archive-cover">
                    {coverUrl ? (
                      <img src={coverUrl} alt="" loading="lazy" />
                    ) : (
                      <div className="ai00-x-library__archive-cover-placeholder" aria-hidden>
                        {entry.isEncrypted ? <Lock size={22} /> : <Music size={22} />}
                      </div>
                    )}
                    {/* 已分享标记（左上角） */}
                    {isShared && (
                      <span
                        className="ai00-x-library__archive-shared"
                        title={t('library.sharedTooltip', {
                          defaultValue: 'Shared — click the share button to unshare',
                        })}
                      >
                        <Share2 size={10} />
                        {t('library.shared', { defaultValue: 'Shared' })}
                      </span>
                    )}
                    {/* 卡片操作按钮（右上角：编辑 / 分享 / 删除） */}
                    <div className="ai00-x-library__archive-actions">
                      <button
                        type="button"
                        className="ai00-x-library__archive-action"
                        onClick={() => setEditDialogEntry(entry)}
                        disabled={archivesLoading || isDeleting}
                        aria-label={t('library.edit', { defaultValue: 'Edit' })}
                        title={t('library.edit', { defaultValue: 'Edit' })}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className={`ai00-x-library__archive-action${
                          isShared ? ' is-shared' : ''
                        }`}
                        onClick={() => void handleShareClick(entry)}
                        disabled={archivesLoading || isDeleting}
                        aria-label={
                          isShared
                            ? t('library.unshare', { defaultValue: 'Unshare' })
                            : t('library.share', { defaultValue: 'Share' })
                        }
                        title={
                          isShared
                            ? t('library.unshare', { defaultValue: 'Unshare' })
                            : t('library.share', { defaultValue: 'Share' })
                        }
                      >
                        <Share2 size={13} />
                      </button>
                      <button
                        type="button"
                        className="ai00-x-library__archive-action ai00-x-library__archive-action--danger"
                        onClick={() => void handleDelete(entry)}
                        disabled={archivesLoading || isDeleting}
                        aria-label={t('library.delete', { defaultValue: 'Delete' })}
                        title={t('library.delete', { defaultValue: 'Delete' })}
                      >
                        {isDeleting ? (
                          <Loader2 size={13} className="is-spinning" />
                        ) : (
                          <Trash2 size={13} />
                        )}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="ai00-x-library__archive-play"
                      onClick={() => {
                        // Already the loaded song → toggle pause/resume instead
                        // of restarting the whole playlist.
                        if (isPlayingThis) {
                          togglePlay();
                          return;
                        }
                        const items: PlaylistItem[] = archives.map((e) => ({
                          kind: 'local' as const,
                          entry: e,
                        }));
                        const idx = archives.findIndex((e) => e.path === entry.path);
                        void setPlaylist(items, idx >= 0 ? idx : 0);
                      }}
                      disabled={archivesLoading}
                      aria-label={
                        isPlayingThis && isPlaying
                          ? t('library.pause', { defaultValue: 'Pause' })
                          : t('library.play', { defaultValue: 'Play' })
                      }
                      title={
                        isPlayingThis && isPlaying
                          ? t('library.pause', { defaultValue: 'Pause' })
                          : t('library.play', { defaultValue: 'Play' })
                      }
                    >
                      {isPlayingThis && isPlaying ? <Pause size={18} /> : <Play size={18} />}
                    </button>
                  </div>
                  <div className="ai00-x-library__archive-info">
                    <div
                      className="ai00-x-library__archive-title"
                      title={meta?.title ?? entry.filename}
                    >
                      {meta?.title ??
                        (entry.isEncrypted
                          ? t('library.encryptedPlaceholder', {
                              defaultValue: 'Encrypted archive',
                            })
                          : entry.filename)}
                    </div>
                    <div className="ai00-x-library__archive-artist" title={meta?.artist}>
                      {meta?.artist ?? ''}
                    </div>
                    <div className="ai00-x-library__archive-meta">
                      <div className="ai00-x-library__archive-meta-row">
                        {meta && meta.durationSeconds > 0 && (
                          <span className="ai00-x-library__archive-duration">
                            <Clock
                              size={10}
                              style={{ marginRight: 3, verticalAlign: 'middle' }}
                            />
                            {formatTimeDisplay(meta.durationSeconds)}
                          </span>
                        )}
                        <span className="ai00-x-library__archive-size">
                          <HardDrive
                            size={10}
                            style={{ marginRight: 3, verticalAlign: 'middle' }}
                          />
                          {formatFileSize(entry.fileSize)}
                        </span>
                        {meta?.score && <ScoreBadge score={meta.score} />}
                      </div>
                      <div className="ai00-x-library__archive-meta-row">
                        <span className="ai00-x-library__archive-date">
                          {formatDate(entry.modifiedAt)}
                        </span>
                        {entry.isEncrypted && (
                          <span
                            className="ai00-x-library__archive-encrypted"
                            title={t('library.encryptedTooltip', {
                              defaultValue: 'Encrypted — password required',
                            })}
                          >
                            <Lock size={10} />
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <LibraryPreviewBar />

      {/* 归档分享对话框（未分享卡片点击分享按钮时打开） */}
      {shareDialogEntry && (
        <ArchiveShareDialog
          open
          entry={shareDialogEntry}
          initialCoverPath={coverPaths[shareDialogEntry.path] ?? null}
          onClose={() => setShareDialogEntry(null)}
        />
      )}

      {/* 编辑元数据对话框（卡片点击编辑按钮时打开） */}
      {editDialogEntry && (
        <SongMetaEditDialog
          open
          entry={editDialogEntry}
          initialCoverPath={coverPaths[editDialogEntry.path] ?? null}
          onClose={() => setEditDialogEntry(null)}
          onSuccess={() => void refreshArchives()}
        />
      )}
    </div>
  );
};

export default LibraryView;
