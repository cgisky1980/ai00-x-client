/**
 * PostComposer — 发布动态 Modal
 *
 * Markdown 编辑器（fork Vditor ir 模式，≤5000 字，无图片/文件上传）+
 * 视频链接（白名单域名，客户端先行校验提示）+ 可见性三选（分段自绘，不用下拉）。
 * 发布走 store.createPost（成功后乐观插入流首）。
 */
import React, { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Input, Modal, toastError } from '@/component-library';
import { X } from 'lucide-react';
import { type CommunityMediaItem, type PostVisibility } from './communityApi';
import { useCommunityStore } from './communityStore';
import { CommunityMDEditor } from './CommunityMDEditor';

/** 客户端侧视频域名白名单（与后端同集；仅用于即时提示，最终以服务端校验为准） */
const VIDEO_HOSTS = ['bilibili.com', 'www.bilibili.com', 'youtu.be', 'www.youtube.com', 'v.qq.com'];

export const PostComposer: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { t } = useI18n();

  const [content, setContent] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoItem, setVideoItem] = useState<CommunityMediaItem | null>(null);
  const [visibility, setVisibility] = useState<PostVisibility>('public');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = !submitting && (content.trim().length > 0 || !!videoItem);

  const reset = () => {
    setContent('');
    setVideoUrl('');
    setVideoItem(null);
    setVisibility('public');
  };

  const onAddVideo = () => {
    const url = videoUrl.trim();
    if (!url) return;
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      toastError(t('community.videoInvalid', { defaultValue: '视频链接格式不正确' }));
      return;
    }
    if (!VIDEO_HOSTS.includes(host)) {
      toastError(t('community.videoNotAllowed', { defaultValue: '仅支持 B 站 / YouTube / 腾讯视频链接' }));
      return;
    }
    setVideoItem({ type: 'video', url, provider: host });
    setVideoUrl('');
  };

  const onSubmit = async () => {
    const media = videoItem ? [videoItem] : [];
    setSubmitting(true);
    const ok = await useCommunityStore.getState().createPost({
      content: content.trim(),
      media,
      visibility,
    });
    setSubmitting(false);
    if (ok) {
      reset();
      onClose();
    } else {
      toastError(useCommunityStore.getState().error ?? t('community.postFailed', { defaultValue: '发布失败' }));
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t('community.composeTitle', { defaultValue: '发布动态' })}
      size="medium"
    >
      <CommunityMDEditor value={content} onChange={setContent} disabled={submitting} />

      {/* 视频外链（唯一媒体形态） */}
      {videoItem ? (
        <div className="community-composer__media">
          <div className="community-composer__thumb community-composer__thumb--video">
            <span>{videoItem.provider}</span>
            <button
              type="button"
              className="community-composer__remove"
              aria-label={t('community.removeMedia', { defaultValue: '移除' })}
              onClick={() => setVideoItem(null)}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      ) : (
        <div className="community-composer__add">
          <div className="community-composer__video-add">
            <Input
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder={t('community.videoPlaceholder', { defaultValue: 'B 站 / YouTube / 腾讯视频链接' })}
              inputSize="small"
            />
            <Button variant="secondary" size="small" onClick={onAddVideo}>
              {t('community.videoAdd', { defaultValue: '添加视频' })}
            </Button>
          </div>
        </div>
      )}

      {/* 可见性三选（分段自绘） */}
      <div className="community-composer__visibility" role="radiogroup" aria-label={t('community.visibility', { defaultValue: '可见范围' })}>
        {(
          [
            ['public', t('community.visibilityPublic', { defaultValue: '公开' })],
            ['followers', t('community.visibilityFollowers', { defaultValue: '关注者' })],
            ['private', t('community.visibilityPrivate', { defaultValue: '仅自己' })],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={visibility === value}
            className={`community-composer__visibility-item ${visibility === value ? 'is-active' : ''}`}
            onClick={() => setVisibility(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="community-composer__actions">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel', { defaultValue: '取消' })}
        </Button>
        <Button variant="primary" isLoading={submitting} disabled={!canSubmit} onClick={() => void onSubmit()}>
          {t('community.publish', { defaultValue: '发布' })}
        </Button>
      </div>
    </Modal>
  );
};
