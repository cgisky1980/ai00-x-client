/**
 * PackageDialog — 打包发行弹窗。
 *
 * 布局：左上封面占位（点击选图→裁剪→回显），右侧歌曲名称 + 歌手
 * （歌手自动取当前登录账号，只读）。确认后打包 .a00m（生成时已自动完成
 * LRC 对齐与音质评分）并发布到分享网络（P2P 做种源）——发布是固有步骤。
 */

import React, { useEffect, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { api } from '@/infrastructure/api';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { Button, Input, Modal } from '@/component-library';
import { toastError, toastSuccess } from '@/component-library';
import { useCreateStore } from './createStore';
import { useShareStore } from '../store/shareStore';
import CoverCropDialog from '../components/CoverCropDialog';

interface Props {
  open: boolean;
  creationId: string;
  sampleId: string | null;
  onClose: () => void;
}

const PackageDialog: React.FC<Props> = ({ open, creationId, sampleId, onClose }) => {
  const { t } = useI18n('acestep');
  const creation = useCreateStore((s) => s.creations.find((c) => c.id === creationId));
  const saveSampleToLibrary = useCreateStore((s) => s.saveSampleToLibrary);
  const uploadArchiveShare = useShareStore((s) => s.uploadArchiveShare);

  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [rawCoverPath, setRawCoverPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle(creation?.title ?? '');
    setCoverPath(null);
    setRawCoverPath(null);
    setBusy(false);
    setStatusLine('');
    // 歌手自动抓取当前登录账号（只读展示）
    void api
      .invoke<{ username?: string } | null>('get_auth_info')
      .then((info) => setArtist(info?.username ?? ''))
      .catch(() => setArtist(''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sampleId]);

  const submit = async () => {
    if (!sampleId || !title.trim() || busy) return;
    setBusy(true);
    try {
      setStatusLine(t('create.packageStepPack'));
      const result = await saveSampleToLibrary(creationId, sampleId, {
        title: title.trim(),
        artist: artist || undefined,
        coverPath: coverPath ?? undefined,
      });
      // 打包发行：上传 .a00m 到分享网络（P2P 做种源）——流程固有步骤；
      // 包已入库，仅发布失败时明确告知、不回滚
      if (result?.outputPath) {
        setStatusLine(t('create.packageStepPublish'));
        try {
          const share = await uploadArchiveShare({ archivePath: result.outputPath });
          toastSuccess(t('create.packageShared', { url: share.shareUrl }));
        } catch (e) {
          toastError(
            t('create.packageShareFailed', {
              reason: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      } else {
        toastSuccess(t('create.packageSuccess'));
      }
      onClose();
    } catch {
      // store 已 toast 错误详情；弹窗保持打开可重试
    } finally {
      setBusy(false);
      setStatusLine('');
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={t('create.packageTitle')}>
      <div className="ai00-x-package">
        <div className="ai00-x-package__top">
          {/* 封面占位：点击选图→裁剪→回显 */}
          <button
            type="button"
            className={`ai00-x-package__cover-box${coverPath ? ' has-image' : ''}`}
            title={t('create.packageCoverPick')}
            onClick={() =>
              void (async () => {
                const { open: pickFile } = await import('@tauri-apps/plugin-dialog');
                const picked = await pickFile({
                  multiple: false,
                  filters: [{ name: 'Image', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
                });
                if (typeof picked === 'string') setRawCoverPath(picked);
              })()
            }
          >
            {coverPath ? (
              <img src={convertFileSrc(coverPath)} alt="" />
            ) : (
              <>
                <ImagePlus size={20} />
                <span>{t('create.packageCoverPick')}</span>
              </>
            )}
          </button>

          <div className="ai00-x-package__fields">
            <div className="ai00-x-package__field">
              <span>{t('create.packageFieldTitle')}</span>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="ai00-x-package__field">
              <span>{t('create.packageFieldArtist')}</span>
              <Input value={artist} readOnly disabled placeholder="—" />
            </div>
          </div>
        </div>

        <div className="ai00-x-package__actions">
          <Button size="small" variant="ghost" onClick={onClose}>
            {t('create.cancel')}
          </Button>
          <Button size="small" disabled={!title.trim() || busy} onClick={() => void submit()}>
            {busy ? statusLine || t('create.generating') : t('create.packageConfirm')}
          </Button>
        </div>
      </div>

      {rawCoverPath && (
        <CoverCropDialog
          isOpen
          imagePath={rawCoverPath}
          onConfirm={(webpPath) => {
            setCoverPath(webpPath);
            setRawCoverPath(null);
          }}
          onCancel={() => setRawCoverPath(null)}
        />
      )}
    </Modal>
  );
};

export default PackageDialog;
