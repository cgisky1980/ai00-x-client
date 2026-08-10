/**
 * SongMetaEditDialog — 编辑歌曲元数据对话框
 *
 * 创作者可在本地修改 `.a00m` 归档中的元数据（title/artist/album/genre/cover）。
 * 后端 `update_song_meta` 会原地重写归档（只替换 song.json + manifest.json +
 * 封面文件，音频/歌词/创作上下文字节原样复制，无有损重编码）。加密归档会
 * 用相同密码重新加密，原始文件被原子替换。
 *
 * 弹窗结构：
 * - 密码输入（仅加密归档，用于解包+重新加密）
 * - 封面预览 + 选择新封面按钮
 * - title/artist/album/genre 输入框（打开时填充当前值）
 * - 提交/取消按钮
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Save, AlertCircle, Lock, Music, ImagePlus, X } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Modal, Button, Input } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n';
import { aceStepService } from '../services/AceStepService';
import type { SongEntry, SongMeta, SongMetaUpdates } from '../types';
import './SongMetaEditDialog.scss';

export interface SongMetaEditDialogProps {
  open: boolean;
  /** 目标归档（`.a00m` 文件） */
  entry: SongEntry;
  /** 已提取的封面路径（由调用方从缓存传入，避免重复提取） */
  initialCoverPath?: string | null;
  onClose: () => void;
  /** 编辑成功后的回调（调用方应刷新歌曲列表） */
  onSuccess?: () => void;
}

export const SongMetaEditDialog: React.FC<SongMetaEditDialogProps> = ({
  open: isOpen,
  entry,
  initialCoverPath,
  onClose,
  onSuccess,
}) => {
  const { t } = useI18n('acestep');

  const [meta, setMeta] = useState<SongMeta | null>(null);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [genre, setGenre] = useState('');
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const needsPassword = entry.isEncrypted;

  /** 读取归档元数据（加密归档需密码） */
  const loadMeta = useCallback(
    async (pw: string | null) => {
      setLoading(true);
      setLoadError(null);
      try {
        const m = await aceStepService.readSongMetaWithPassword(entry.path, pw);
        setMeta(m);
        setTitle(m.title || '');
        setArtist(m.artist || '');
        setGenre(m.genre || '');
      } catch {
        setLoadError(t('editDialog.unlockFailed'));
      } finally {
        setLoading(false);
      }
    },
    [entry.path, t],
  );

  // 每次打开对话框时读取归档元数据
  useEffect(() => {
    if (isOpen) {
      setMeta(null);
      setCoverPath(initialCoverPath ?? null);
      setPassword('');
      setError(null);
      setLoadError(null);

      if (entry.meta) {
        // 未加密归档：listSongs 已填充 meta
        setMeta(entry.meta);
        setTitle(entry.meta.title || '');
        setArtist(entry.meta.artist || '');
        setGenre(entry.meta.genre || '');
      } else if (entry.isEncrypted) {
        // 加密归档：尝试用固定密码（null）读取
        void loadMeta(null);
      }
    }
  }, [isOpen, entry, initialCoverPath, loadMeta]);

  /** 选择新封面 */
  const handlePickCover = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
      });
      if (typeof selected === 'string') {
        setCoverPath(selected);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 清除封面选择（恢复为初始封面） */
  const handleClearCover = () => {
    setCoverPath(initialCoverPath ?? null);
  };

  /** 加密归档：输入密码后手动解锁 */
  const handleUnlock = () => {
    if (!password.trim()) return;
    void loadMeta(password.trim());
  };

  /** 提交保存 */
  const handleSubmit = async () => {
    if (!meta || saving) return;
    if (needsPassword && !password.trim()) return;

    setSaving(true);
    setError(null);
    try {
      // 构建更新对象（只包含变更的字段）
      const updates: SongMetaUpdates = {};
      if (title !== (meta.title || '')) updates.title = title;
      if (artist !== (meta.artist || '')) updates.artist = artist;
      if (genre !== (meta.genre || '')) updates.genre = genre;
      // 封面：只有用户选择了新文件（与初始值不同）才更新
      if (coverPath && coverPath !== initialCoverPath) {
        updates.coverPath = coverPath;
      }

      await aceStepService.updateSongMeta(
        entry.path,
        needsPassword ? password : null,
        updates,
      );
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const submitDisabled = saving || loading || !meta || (needsPassword && !password.trim());

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('editDialog.title')}
      size="medium"
      closeOnOverlayClick={!saving}
      overlayClassName="music-popup-share-overlay"
    >
      <div className="song-edit-dialog__form">
        {/* 加密归档密码（仅加密归档显示） */}
        {needsPassword && (
          <div className="song-edit-dialog__field">
            <label className="song-edit-dialog__label">
              <Lock size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
              {t('editDialog.archivePassword')} *
            </label>
            {!meta && (
              <div className="song-edit-dialog__cover-row">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('editDialog.archivePasswordPlaceholder')}
                  disabled={saving || loading}
                />
                <Button
                  variant="secondary"
                  size="small"
                  onClick={handleUnlock}
                  disabled={saving || loading || !password.trim()}
                >
                  {loading ? t('editDialog.unlocking') : t('editDialog.unlockArchive')}
                </Button>
              </div>
            )}
            {loadError && (
              <div className="song-edit-dialog__error">
                <AlertCircle size={14} />
                <span>{loadError}</span>
              </div>
            )}
          </div>
        )}

        {/* 元数据表单（只有读取到 meta 后才显示） */}
        {meta && (
          <>
            {/* 封面 */}
            <div className="song-edit-dialog__field">
              <label className="song-edit-dialog__label">
                {t('editDialog.coverField')}
              </label>
              <div className="song-edit-dialog__cover-row">
                {coverPath ? (
                  <img
                    className="song-edit-dialog__cover-preview"
                    src={convertFileSrc(coverPath)}
                    alt={title}
                  />
                ) : (
                  <div className="song-edit-dialog__cover-placeholder">
                    <Music size={24} />
                  </div>
                )}
                <Button
                  variant="secondary"
                  size="small"
                  onClick={handlePickCover}
                  disabled={saving}
                >
                  <ImagePlus size={14} />
                  {t('editDialog.pickCover')}
                </Button>
                {coverPath && coverPath !== initialCoverPath && (
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={handleClearCover}
                    disabled={saving}
                  >
                    <X size={14} />
                  </Button>
                )}
              </div>
            </div>

            {/* 标题 */}
            <div className="song-edit-dialog__field">
              <label className="song-edit-dialog__label">
                {t('editDialog.titleField')}
              </label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={saving}
              />
            </div>

            {/* 艺术家 */}
            <div className="song-edit-dialog__field">
              <label className="song-edit-dialog__label">
                {t('editDialog.artistField')}
              </label>
              <Input
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
                disabled={saving}
              />
            </div>

            {/* 流派 */}
            <div className="song-edit-dialog__field">
              <label className="song-edit-dialog__label">
                {t('editDialog.genreField')}
              </label>
              <Input
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                disabled={saving}
              />
            </div>
          </>
        )}

        {/* 错误显示 */}
        {error && (
          <div className="song-edit-dialog__error">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="song-edit-dialog__actions">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('editDialog.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={submitDisabled}>
            <Save size={14} />
            {saving ? t('editDialog.saving') : t('editDialog.submit')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
