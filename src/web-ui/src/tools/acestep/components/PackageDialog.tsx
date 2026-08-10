/**
 * PackageDialog — settings modal for the `.a00m` packaging flow.
 *
 * Replaces the previous native save-dialog approach with a full form letting
 * the user edit author metadata (title/artist/album/genre), pick a cover
 * image, choose the output directory (default `<exe_dir>/data/songs/`), and
 * set the filename — all before invoking the backend packaging command.
 *
 * On confirm, calls `onConfirm(options: PackageDialogOptions)` with the
 * collected values. The parent decides when to close the dialog (typically
 * on success; on failure the dialog stays open so the user can retry).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon, FolderOpen, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Modal, Button, Input, Select } from '@/component-library';
import type { SelectOption } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n';
import { aceStepService } from '../services/AceStepService';
import type { PackageDialogOptions } from '../types';
import { CoverCropDialog } from './CoverCropDialog';
import './PackageDialog.scss';

export interface PackageDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (options: PackageDialogOptions) => void;
  /** Audio id being packaged (for tracking state). */
  audioId: string | null;
  /** Initial title suggestion (from session.title or audio.label). */
  defaultTitle: string;
  /** Whether packaging is in progress (disables confirm button, shows spinner). */
  isPackaging: boolean;
}

/** Strip Windows-illegal filename chars + control chars (0x00-0x1f). */
function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- control chars are illegal in Windows filenames
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60).trim();
}

/** Genre option values — the "other" sentinel triggers a free-text input. */
const GENRE_OTHER = '__other__';

/** localStorage key for caching the last-used artist name across sessions. */
const ARTIST_STORAGE_KEY = 'acestep:lastArtist';

export const PackageDialog: React.FC<PackageDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  defaultTitle,
  isPackaging,
}) => {
  const { t } = useI18n('acestep');

  // ---- Form state ----
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  /** Selected genre option value — either a fixed key or GENRE_OTHER. */
  const [genreChoice, setGenreChoice] = useState<string>('');
  /** Free-text genre shown only when genreChoice === GENRE_OTHER. */
  const [genreCustom, setGenreCustom] = useState('');
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [filename, setFilename] = useState('');
  /** Cover picker error message (e.g. when the user picks a non-image file). */
  const [coverError, setCoverError] = useState('');
  // 选完图片后弹出裁剪对话框所需的原始图片路径；为 null 时不显示裁剪框。
  const [cropDialogPath, setCropDialogPath] = useState<string | null>(null);

  // ---- Initialize form when dialog opens ----
  useEffect(() => {
    if (!isOpen) return;
    setTitle(defaultTitle || '');
    // Restore last-used artist name from localStorage (avoids re-typing every time)
    const lastArtist = localStorage.getItem(ARTIST_STORAGE_KEY) || '';
    setArtist(lastArtist);
    setGenreChoice('');
    setGenreCustom('');
    setCoverPath(null);
    setCoverError('');
    setCropDialogPath(null);
    // Pre-fill the filename with a sanitized title + timestamp suffix.
    const safeBase = sanitizeFilename(defaultTitle || 'song') || 'song';
    setFilename(`${safeBase}_${Date.now()}`);
    // outputDir is loaded asynchronously below.
  }, [isOpen, defaultTitle]);

  // ---- Load default songs directory on first open ----
  useEffect(() => {
    if (!isOpen || outputDir) return;
    let cancelled = false;
    aceStepService
      .getSongsDir()
      .then((dir) => {
        if (!cancelled) setOutputDir(dir);
      })
      .catch((e) => {
        // Fall back to empty string — user will have to pick manually.
        console.warn('[PackageDialog] Failed to load default songs dir:', e);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, outputDir]);

  // ---- Genre options (built once per render; cheap) ----
  const genreOptions: SelectOption[] = useMemo(
    () => [
      { label: t('packageDialog.genrePop', { defaultValue: 'Pop' }), value: 'pop' },
      { label: t('packageDialog.genreRock', { defaultValue: 'Rock' }), value: 'rock' },
      {
        label: t('packageDialog.genreElectronic', { defaultValue: 'Electronic' }),
        value: 'electronic',
      },
      {
        label: t('packageDialog.genreClassical', { defaultValue: 'Classical' }),
        value: 'classical',
      },
      { label: t('packageDialog.genreFolk', { defaultValue: 'Folk' }), value: 'folk' },
      { label: t('packageDialog.genreRap', { defaultValue: 'Rap' }), value: 'rap' },
      { label: t('packageDialog.genreRnB', { defaultValue: 'R&B' }), value: 'rnb' },
      { label: t('packageDialog.genreJazz', { defaultValue: 'Jazz' }), value: 'jazz' },
      { label: t('packageDialog.genreOther', { defaultValue: 'Other' }), value: GENRE_OTHER },
    ],
    [t],
  );

  /** Final genre string to send to the backend. */
  const resolvedGenre = useMemo(() => {
    if (genreChoice === GENRE_OTHER) return genreCustom.trim();
    if (genreChoice && genreChoice !== GENRE_OTHER) {
      // Use the localized label of the chosen fixed option.
      const opt = genreOptions.find((o) => o.value === genreChoice);
      return (opt?.label as string) ?? '';
    }
    return '';
  }, [genreChoice, genreCustom, genreOptions]);

  // ---- Cover picker ----
  const handlePickCover = async () => {
    setCoverError('');
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
      });
      if (typeof selected === 'string') {
        // 触发裁剪对话框：用户在 CoverCropDialog 中调整 1:1 裁剪区域，
        // 确认后由 handleCropConfirm 把生成的临时 WebP 路径写入 coverPath。
        setCropDialogPath(selected);
      }
    } catch (e) {
      setCoverError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleCropConfirm = (webpPath: string) => {
    setCoverPath(webpPath);
    setCropDialogPath(null);
    setCoverError('');
  };

  const handleClearCover = () => {
    setCoverPath(null);
    setCoverError('');
  };

  // ---- Directory picker ----
  const handlePickDir = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        defaultPath: outputDir || undefined,
      });
      if (typeof selected === 'string') {
        setOutputDir(selected);
      }
    } catch (e) {
      console.warn('[PackageDialog] Directory pick failed:', e);
    }
  };

  // ---- Confirm ----
  // Encryption is automatic — the Rust backend always encrypts with the
  // current version's fixed password from `passwords.rs`. No user-facing
  // password field is needed.
  const canConfirm =
    !isPackaging &&
    title.trim().length > 0 &&
    outputDir.trim().length > 0 &&
    filename.trim().length > 0;

  const handleConfirm = () => {
    if (!canConfirm) return;
    // Cache artist name for next time
    const trimmedArtist = artist.trim();
    if (trimmedArtist) {
      localStorage.setItem(ARTIST_STORAGE_KEY, trimmedArtist);
    }
    const options: PackageDialogOptions = {
      title: title.trim(),
      artist: trimmedArtist,
      album: '',
      genre: resolvedGenre,
      coverPath,
      outputDir: outputDir.trim(),
      filename: sanitizeFilename(filename.trim()) || 'song',
    };
    onConfirm(options);
  };

  // ---- Render ----
  const coverFilename = coverPath
    ? coverPath.replace(/[\\/]/g, '/').split('/').pop() ?? coverPath
    : '';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('packageDialog.title', { defaultValue: 'Package Song' })}
      size="medium"
      closeOnOverlayClick={false}
      showCloseButton={!isPackaging}
    >
      <div className="package-dialog">
        {/* Section: 基本信息 */}
        <div className="package-dialog__section">
          <span className="package-dialog__section-title">
            {t('packageDialog.sectionInfo', { defaultValue: 'Song Info' })}
          </span>
          <Input
            label={t('packageDialog.fieldTitle', { defaultValue: 'Title' })}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={defaultTitle || 'Untitled'}
            disabled={isPackaging}
          />
          <Input
            label={t('packageDialog.fieldArtist', { defaultValue: 'Artist' })}
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            disabled={isPackaging}
          />
          <Select
            label={t('packageDialog.fieldGenre', { defaultValue: 'Genre' })}
            options={genreOptions}
            value={genreChoice}
            onChange={(v) => setGenreChoice(String(v ?? ''))}
            placeholder="—"
            disabled={isPackaging}
            clearable
          />
          {genreChoice === GENRE_OTHER && (
            <Input
              label={t('packageDialog.genreOtherPlaceholder', {
                defaultValue: 'Enter custom genre',
              })}
              value={genreCustom}
              onChange={(e) => setGenreCustom(e.target.value)}
              disabled={isPackaging}
            />
          )}
        </div>

        {/* Section: 封面 */}
        <div className="package-dialog__section">
          <span className="package-dialog__section-title">
            {t('packageDialog.fieldCover', { defaultValue: 'Cover' })}
          </span>
          <div className="package-dialog__cover">
            <div className="package-dialog__cover-preview">
              {coverPath ? (
                <img
                  src={convertFileSrc(coverPath)}
                  alt={t('packageDialog.fieldCover', { defaultValue: 'Cover' })}
                />
              ) : (
                <ImageIcon size={32} className="package-dialog__cover-placeholder" />
              )}
            </div>
            <div className="package-dialog__cover-actions">
              {coverPath ? (
                <>
                  <span className="package-dialog__cover-name" title={coverPath}>
                    {coverFilename}
                  </span>
                  <div className="package-dialog__cover-buttons">
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={handlePickCover}
                      disabled={isPackaging}
                    >
                      {t('packageDialog.coverChange', { defaultValue: 'Change' })}
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={handleClearCover}
                      disabled={isPackaging}
                    >
                      <X size={12} />
                      {t('packageDialog.coverClear', { defaultValue: 'Clear' })}
                    </Button>
                  </div>
                </>
              ) : (
                <Button
                  size="small"
                  variant="secondary"
                  onClick={handlePickCover}
                  disabled={isPackaging}
                >
                  <ImageIcon size={14} />
                  {t('packageDialog.coverPick', { defaultValue: 'Choose Cover' })}
                </Button>
              )}
            </div>
          </div>
          <span className="package-dialog__hint">
            {t('packageDialog.coverHint', {
              defaultValue: 'JPG / PNG / WebP supported, square recommended',
            })}
          </span>
          {coverError && (
            <span className="package-dialog__error">{coverError}</span>
          )}
        </div>

        {/* Section: 输出位置 */}
        <div className="package-dialog__section">
          <span className="package-dialog__section-title">
            {t('packageDialog.sectionOutput', { defaultValue: 'Output' })}
          </span>
          <div className="package-dialog__dir-row">
            <Input
              value={outputDir}
              onChange={(e) => setOutputDir(e.target.value)}
              disabled={isPackaging}
              placeholder="<exe_dir>/data/songs/"
            />
            <Button
              size="small"
              variant="secondary"
              onClick={handlePickDir}
              disabled={isPackaging}
            >
              <FolderOpen size={14} />
              {t('packageDialog.browse', { defaultValue: 'Browse...' })}
            </Button>
          </div>
          <Input
            label={t('packageDialog.fieldFilename', { defaultValue: 'Filename' })}
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            disabled={isPackaging}
            suffix=".a00m"
          />
        </div>

        {/* Footer */}
        <div className="package-dialog__footer">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={isPackaging}
          >
            {t('packageDialog.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={!canConfirm}
            isLoading={isPackaging}
          >
            {t('packageDialog.confirm', { defaultValue: 'Start Packaging' })}
          </Button>
        </div>
      </div>

      {/* 封面裁剪对话框：用户选完图片后弹出，确认后写入 coverPath */}
      <CoverCropDialog
        isOpen={cropDialogPath !== null}
        imagePath={cropDialogPath ?? ''}
        onConfirm={handleCropConfirm}
        onCancel={() => setCropDialogPath(null)}
      />
    </Modal>
  );
};

