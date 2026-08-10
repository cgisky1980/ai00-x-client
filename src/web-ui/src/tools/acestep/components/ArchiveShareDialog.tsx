/**
 * ArchiveShareDialog — 作品库归档分享对话框
 *
 * 归档已包含完整元数据（title/artist/genre/cover），分享时无需填写。
 * 后端 `share_upload_archive` 自动用 master password 解密读取元数据并
 * 直接上传完整加密归档。只有 Ai00-X 播放器能解密播放。
 *
 * 弹窗包含：
 * - 只读信息摘要（显示归档中的 title/artist/genre/封面缩略图）
 * - 上传进度条（动画 indeterminate，上传中显示）
 * - 上传结果展示（成功后显示分享 ID/文件大小/分享链接/复制按钮）
 * - 错误显示 + 重试按钮
 */

import React, { useEffect, useState } from 'react';
import { Upload, AlertCircle, Music, CheckCircle, Copy, Link as LinkIcon } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Modal, Button } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n';
import { useShareStore } from '../store/shareStore';
import type { SongEntry, SongMeta } from '../types';
import './ShareUploadDialog.scss';

export interface ArchiveShareDialogProps {
  open: boolean;
  /** 目标归档（`.a00m` 文件） */
  entry: SongEntry;
  /** 已提取的封面路径（由调用方从缓存传入，避免重复提取） */
  initialCoverPath?: string | null;
  onClose: () => void;
  /** 上传成功后的回调（例如显示 toast） */
  onSuccess?: (shareId: string) => void;
}

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const ArchiveShareDialog: React.FC<ArchiveShareDialogProps> = ({
  open: isOpen,
  entry,
  initialCoverPath,
  onClose,
  onSuccess,
}) => {
  const { t } = useI18n('acestep');
  const uploadArchiveShare = useShareStore((s) => s.uploadArchiveShare);
  const uploading = useShareStore((s) => s.archiveUploading);
  const uploadResult = useShareStore((s) => s.archiveUploadResult);
  const error = useShareStore((s) => s.error);
  const clearError = useShareStore((s) => s.clearError);

  const [meta, setMeta] = useState<SongMeta | null>(null);
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 每次打开对话框时初始化
  useEffect(() => {
    if (isOpen) {
      setMeta(entry.meta ?? null);
      setCoverPath(initialCoverPath ?? null);
      setCopied(false);
      clearError();
    }
  }, [isOpen, entry, clearError, initialCoverPath]);

  const submitDisabled = uploading || !meta;
  const hasResult = !!uploadResult && !error;
  const hasError = !!error && !uploading;

  const handleSubmit = async () => {
    if (uploading || !meta) return;
    setCopied(false);
    try {
      const result = await uploadArchiveShare({
        archivePath: entry.path,
      });
      onSuccess?.(result.shareId);
    } catch {
      // 错误已存入 store，UI 显示
    }
  };

  const handleCopyLink = async () => {
    if (!uploadResult) return;
    const link = `${window.location.origin}/share/${uploadResult.shareId}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用时静默失败
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('share.dialog.title')}
      size="medium"
      closeOnOverlayClick={!uploading}
      overlayClassName="music-popup-share-overlay"
    >
      <div className="share-upload-dialog__form">
        {/* 只读信息摘要 */}
        {meta && (
          <div className="share-upload-dialog__summary">
            <div className="share-upload-dialog__summary-title">
              {t('share.dialog.summary')}
            </div>
            <div className="share-upload-dialog__summary-body">
              {coverPath ? (
                <img
                  className="share-upload-dialog__summary-cover"
                  src={convertFileSrc(coverPath)}
                  alt={meta.title}
                />
              ) : (
                <div className="share-upload-dialog__summary-cover-placeholder">
                  <Music size={24} />
                </div>
              )}
              <div className="share-upload-dialog__summary-items">
                <div className="share-upload-dialog__summary-item">
                  <span className="share-upload-dialog__summary-label">{t('share.dialog.titleField')}</span>
                  <span className="share-upload-dialog__summary-value">{meta.title || '—'}</span>
                </div>
                <div className="share-upload-dialog__summary-item">
                  <span className="share-upload-dialog__summary-label">{t('share.dialog.artistField')}</span>
                  <span className="share-upload-dialog__summary-value">{meta.artist || '—'}</span>
                </div>
                <div className="share-upload-dialog__summary-item">
                  <span className="share-upload-dialog__summary-label">{t('share.dialog.genreField')}</span>
                  <span className="share-upload-dialog__summary-value">{meta.genre || '—'}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 上传进度条（上传中显示） */}
        {uploading && (
          <div className="share-upload-dialog__progress">
            <div className="share-upload-dialog__progress-bar">
              <div className="share-upload-dialog__progress-bar-fill" />
            </div>
            <div className="share-upload-dialog__progress-text">
              {t('share.dialog.uploading')}
            </div>
          </div>
        )}

        {/* 上传成功结果 */}
        {hasResult && uploadResult && (
          <div className="share-upload-dialog__result">
            <div className="share-upload-dialog__result-icon">
              <CheckCircle size={32} />
            </div>
            <div className="share-upload-dialog__result-title">
              {t('share.dialog.success')}
            </div>
            <div className="share-upload-dialog__result-desc">
              {t('share.dialog.successDesc')}
            </div>
            <div className="share-upload-dialog__result-details">
              <div className="share-upload-dialog__result-row">
                <span className="share-upload-dialog__result-label">{t('share.dialog.shareId')}</span>
                <span className="share-upload-dialog__result-value">{uploadResult.shareId}</span>
              </div>
              <div className="share-upload-dialog__result-row">
                <span className="share-upload-dialog__result-label">{t('share.dialog.fileSize')}</span>
                <span className="share-upload-dialog__result-value">
                  {formatFileSize(uploadResult.fileSizeBytes)}
                </span>
              </div>
              <div className="share-upload-dialog__result-row">
                <span className="share-upload-dialog__result-label">{t('share.dialog.shareLink')}</span>
                <div className="share-upload-dialog__result-link-wrapper">
                  <LinkIcon size={12} />
                  <span className="share-upload-dialog__result-link">
                    {`${window.location.origin}/share/${uploadResult.shareId}`}
                  </span>
                </div>
              </div>
            </div>
            <Button
              variant="ghost"
              size="small"
              onClick={handleCopyLink}
              className="share-upload-dialog__copy-btn"
            >
              <Copy size={12} />
              {copied ? t('share.dialog.copied') : t('share.dialog.copyLink')}
            </Button>
          </div>
        )}

        {/* 错误显示 */}
        {hasError && (
          <div className="share-upload-dialog__error">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="share-upload-dialog__actions">
          {hasResult ? (
            // 上传成功后只显示「完成」按钮
            <Button variant="primary" onClick={onClose}>
              {t('share.dialog.done')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={uploading}>
                {t('share.dialog.cancel')}
              </Button>
              {hasError ? (
                <Button variant="primary" onClick={handleSubmit} disabled={submitDisabled}>
                  <Upload size={14} />
                  {t('share.dialog.retry')}
                </Button>
              ) : (
                <Button variant="primary" onClick={handleSubmit} disabled={submitDisabled}>
                  <Upload size={14} />
                  {uploading ? t('share.dialog.uploading') : t('share.dialog.submit')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};
