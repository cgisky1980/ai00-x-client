/**
 * CoverCropDialog — 封面图裁剪对话框。
 *
 * 接收原始图片路径，用 `react-easy-crop` 提供 1:1 交互式裁剪 UI（拖拽 + 滚轮缩放）。
 * 确认时调用 `cropAndResizeToWebP` 裁剪+缩放到 512×512 + 转 WebP，
 * 再用 `saveBlobToTempFile` 写入临时文件，最后通过 `onConfirm(path)` 返回路径。
 *
 * 调用方（ArchiveShareDialog / PackageDialog）在用户选完文件后弹出此对话框，
 * 拿到 `webpPath` 后存入 `coverPath` 状态。
 *
 * 错误处理：
 *   - 图片加载失败（非图片文件/损坏）→ 显示 errorLoad 提示，禁用确认按钮
 *   - 处理失败（Canvas/WebP 编码错误）→ 显示 errorProcess 提示
 */

import React, { useCallback, useEffect, useState } from 'react';
import Cropper, { type Point, type Area } from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import { AlertCircle, Loader2, Check, X } from 'lucide-react';
import { Modal, Button } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  loadImageFromPath,
  cropAndResizeToWebP,
  saveBlobToTempFile,
  COVER_OUTPUT_SIZE,
  COVER_WEBP_QUALITY,
} from '../utils/coverImage';
import './CoverCropDialog.scss';

export interface CoverCropDialogProps {
  /** 是否显示对话框 */
  isOpen: boolean;
  /** 原始图片本地路径（用户刚选择的文件） */
  imagePath: string;
  /** 处理完成回调，返回临时 WebP 文件路径 */
  onConfirm: (webpPath: string) => void;
  /** 取消回调 */
  onCancel: () => void;
}

export const CoverCropDialog: React.FC<CoverCropDialogProps> = ({
  isOpen,
  imagePath,
  onConfirm,
  onCancel,
}) => {
  const { t } = useI18n('acestep');
  const [imageEl, setImageEl] = useState<ImageBitmap | null>(null);
  const [imageUrl, setImageUrl] = useState<string>('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);

  // 每次打开/切换 imagePath 时重新加载图片
  useEffect(() => {
    if (!isOpen || !imagePath) {
      setImageEl(null);
      setImageUrl('');
      setLoadError(null);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setCroppedAreaPixels(null);
      setProcessError(null);
      return;
    }
    let cancelled = false;
    setLoadError(null);
    setImageEl(null);
    console.log('[CoverCropDialog] loading image from:', imagePath);
    loadImageFromPath(imagePath)
      .then((img) => {
        if (cancelled) return;
        console.log('[CoverCropDialog] image loaded:', img.width, 'x', img.height);
        setImageEl(img);
        setImageUrl(convertFileSrc(imagePath));
      })
      .catch((e) => {
        if (cancelled) return;
        console.error('[CoverCropDialog] loadImageFromPath failed:', e);
        setLoadError(
          e instanceof Error
            ? `${e.name}: ${e.message}`
            : t('share.coverCrop.errorLoad', { defaultValue: 'Failed to load image' }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, imagePath, t]);

  const onCropComplete = useCallback((_: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  const handleConfirm = async () => {
    if (!imageEl || !croppedAreaPixels) return;
    setProcessing(true);
    setProcessError(null);
    try {
      console.log('[CoverCropDialog] imageEl:', {
        type: imageEl.constructor.name,
        width: imageEl.width,
        height: imageEl.height,
      });
      console.log('[CoverCropDialog] croppedAreaPixels:', croppedAreaPixels);
      const blob = await cropAndResizeToWebP(
        imageEl,
        croppedAreaPixels,
        COVER_OUTPUT_SIZE,
        COVER_WEBP_QUALITY,
      );
      console.log('[CoverCropDialog] blob created:', blob.size, 'bytes, type:', blob.type);
      const webpPath = await saveBlobToTempFile(blob);
      console.log('[CoverCropDialog] saved to:', webpPath);
      onConfirm(webpPath);
    } catch (e) {
      console.error('[CoverCropDialog] handleConfirm failed:', e);
      setProcessError(
        e instanceof Error
          ? `${e.name}: ${e.message}`
          : t('share.coverCrop.errorProcess', { defaultValue: 'Failed to process image' }),
      );
    } finally {
      setProcessing(false);
    }
  };

  const handleCancel = () => {
    if (processing) return; // 处理中不允许取消
    onCancel();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleCancel}
      title={t('share.coverCrop.title', { defaultValue: 'Adjust Cover' })}
      size="small"
      closeOnOverlayClick={!processing}
      showCloseButton={!processing}
    >
      <div className="cover-crop-dialog">
        {/* 裁剪区域 */}
        <div className="cover-crop-dialog__cropper">
          {loadError ? (
            <div className="cover-crop-dialog__error" role="alert">
              <AlertCircle size={20} />
              <span>{loadError}</span>
            </div>
          ) : imageUrl ? (
            <Cropper
              image={imageUrl}
              crop={crop}
              zoom={zoom}
              aspect={1}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
              showGrid
            />
          ) : (
            <div className="cover-crop-dialog__loading">
              <Loader2 size={20} className="is-spinning" />
              <span>{t('share.coverCrop.loading', { defaultValue: 'Loading...' })}</span>
            </div>
          )}
        </div>

        {/* 提示 */}
        <p className="cover-crop-dialog__hint">
          {t('share.coverCrop.hint', {
            defaultValue: 'Drag to adjust crop area, scroll to zoom',
          })}
        </p>

        {/* 处理错误提示 */}
        {processError && (
          <div className="cover-crop-dialog__error" role="alert">
            <AlertCircle size={14} />
            <span>{processError}</span>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="cover-crop-dialog__actions">
          <Button
            variant="ghost"
            onClick={handleCancel}
            disabled={processing}
          >
            <X size={14} />
            {t('share.coverCrop.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={processing || !imageEl || !croppedAreaPixels || !!loadError}
          >
            {processing ? (
              <>
                <Loader2 size={14} className="is-spinning" />
                {t('share.coverCrop.processing', { defaultValue: 'Processing...' })}
              </>
            ) : (
              <>
                <Check size={14} />
                {t('share.coverCrop.confirm', { defaultValue: 'Confirm' })}
              </>
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default CoverCropDialog;
