/**
 * PostComposer — 发布动态 Modal
 *
 * Markdown 编辑器（fork Vditor wysiwyg，≤5000 字）+ 媒体（P1.1 编辑器整合）：
 * - 图片：编辑器工具栏/拖拽/粘贴上抛 → /media/upload 逐张上传，≤9 张九宫格预览
 *   （服务端重编码 + 480px 缩略图）；可移除，上传中禁止发布
 * - 视频：工具栏「插入视频」弹输入层（白名单外链，≤1）；正文里直接贴的视频裸链
 *   发布时自动抽取进 media 数组（正文保持干净文本）
 * - 可见性三选（分段自绘）。发布走 store.createPost（成功后乐观插入流首）。
 * - AI 起标题：未写标题且无首行 MD 标题的长文，发布前经 ai_complete_once 通用接口
 *   （当前选用主模型）单次生成标题；失败/超时按无标题发布，不打断流程。
 */
import React, { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Input, Modal, toastError } from '@/component-library';
import { aiApi } from '@/infrastructure/api/service-api/AIApi';
import { Film, X } from 'lucide-react';
import {
  communityApi,
  resolveMediaUrl,
  type CommunityMediaItem,
  type PostVisibility,
} from './communityApi';
import { useCommunityStore } from './communityStore';
import { CommunityMDEditor } from './CommunityMDEditor';
import { buildVideoItem, extractVideoLinks } from './media';
import { mdPreview } from './md';

/** 图片九宫格上限（与后端 MAX_MEDIA_ITEMS 一致） */
const MAX_IMAGES = 9;

/** AI 起标题阈值：压平正文 ≥ 此长度才值得起标题（短动态不打扰模型） */
const AI_TITLE_MIN_CHARS = 48;

/**
 * aiGenerateTitle — 单次 AI 起标题（ai_complete_once 通用接口：无会话、无事件、
 * 直接返回文本；模型默认 primary = 用户当前选用的主模型）。失败/超时返回 null。
 */
const aiGenerateTitle = async (bodyText: string): Promise<string | null> => {
  let raw: string;
  try {
    const res = await aiApi.completeOnce({
      userPrompt: [
        '为下面的社区帖子正文拟一个标题。',
        '要求：只输出标题本身，不要引号、句号或任何解释；不超过 20 字；使用正文的主要语言。',
        '',
        '正文：',
        bodyText,
      ].join('\n'),
      modelId: 'fast',
      timeoutSecs: 12,
    });
    raw = res.text;
  } catch {
    return null;
  }
  let s = raw.trim().split('\n')[0].trim();
  s = s.replace(/^(?:标题|题目|Title)\s*[:：]\s*/i, '');
  s = s
    .replace(/^["'“”「『《[(【]+/, '')
    .replace(/["'”」』》\])】。,，!！?？;；]+$/, '')
    .trim();
  if (s.length < 2 || s.length > 40) return null;
  return s;
};

/** 上传跟踪项 */
interface PendingImage {
  key: string;
  status: 'uploading' | 'done' | 'error';
  url?: string;
  thumb_url?: string;
}

/** 相对媒体 URL → 绝对（预览用），复用 MediaGrid 同款解析 */
function useMediaSrc(url: string | undefined): string {
  const [src, setSrc] = useState('');
  React.useEffect(() => {
    if (!url) {
      setSrc('');
      return;
    }
    let alive = true;
    void resolveMediaUrl(url)
      .then((s) => {
        if (alive) setSrc(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);
  return src;
}

const ComposerThumb: React.FC<{ item: PendingImage; onRemove: () => void }> = ({ item, onRemove }) => {
  const { t } = useI18n('community');
  const src = useMediaSrc(item.thumb_url ?? item.url);
  return (
    <div className={`community-composer__thumb ${item.status !== 'done' ? 'is-busy' : ''}`}>
      {item.status === 'done' && src ? (
        <img src={src} alt="" loading="lazy" draggable={false} />
      ) : (
        <span className="community-composer__thumb-state" aria-hidden>
          {item.status === 'uploading' ? '…' : '!'}
        </span>
      )}
      <button
        type="button"
        className="community-composer__remove"
        aria-label={t('removeMedia', { defaultValue: '移除' })}
        onClick={onRemove}
      >
        <X size={12} />
      </button>
    </div>
  );
};

export const PostComposer: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { t } = useI18n('community');

  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [coverPath, setCoverPath] = useState('');
  const [coverPreview, setCoverPreview] = useState('');
  const [coverBusy, setCoverBusy] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [videoItem, setVideoItem] = useState<CommunityMediaItem | null>(null);
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [visibility, setVisibility] = useState<PostVisibility>('public');
  const [submitting, setSubmitting] = useState(false);
  const [titling, setTitling] = useState(false);

  const uploading = images.some((i) => i.status === 'uploading');
  const hasMedia = videoItem !== null || images.some((i) => i.status === 'done');
  const canSubmit = !submitting && !uploading && (content.trim().length > 0 || hasMedia);

  const reset = () => {
    setContent('');
    setTitle('');
    setCoverPath('');
    setCoverPreview('');
    setImages([]);
    setVideoItem(null);
    setVideoUrl('');
    setVisibility('public');
  };

  /* ---- 图片上传（编辑器 onImagesPicked 上抛到这里） ---- */
  const addImages = async (files: File[]) => {
    const accepted = files.filter((f) => f.type.startsWith('image/'));
    if (accepted.length === 0) return;
    setImages((prev) => {
      const room = MAX_IMAGES - prev.filter((p) => p.status !== 'error').length;
      if (accepted.length > room) {
        toastError(t('tooManyImages', { defaultValue: `最多 ${MAX_IMAGES} 张图片` }));
      }
      const take = accepted.slice(0, Math.max(0, room));
      const entries = take.map((f, i) => ({
        key: `${Date.now()}-${f.name}-${i}`,
        status: 'uploading' as const,
      }));
      // 逐张上传（避免并发风暴；服务端串行重编码更稳）
      void (async () => {
        for (let i = 0; i < take.length; i++) {
          const key = entries[i].key;
          try {
            const r = await communityApi.uploadMedia(take[i]);
            setImages((prev) =>
              prev.map((p) =>
                p.key === key ? { ...p, status: 'done', url: r.url, thumb_url: r.thumb_url } : p,
              ),
            );
          } catch (e) {
            toastError(e instanceof Error ? e.message : String(e));
            setImages((prev) =>
              prev.map((p) => (p.key === key ? { ...p, status: 'error' } : p)),
            );
          }
        }
      })();
      return [...prev, ...entries];
    });
  };

  /* ---- 封面（P2B 博客模式：有标题时出现封面槽位；显式 cover 优先于首图） ---- */
  const pickCover = async (file: File | undefined) => {
    if (!file) return;
    setCoverBusy(true);
    try {
      const r = await communityApi.uploadMedia(file);
      setCoverPath(r.url);
      setCoverPreview(await resolveMediaUrl(r.thumb_url || r.url));
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setCoverBusy(false);
    }
  };

  /* ---- 插入视频（编辑器工具栏上抛到这里） ---- */
  const onAddVideo = () => {
    const item = buildVideoItem(videoUrl);
    if (!item) {
      toastError(t('videoNotAllowed', { defaultValue: '仅支持 B 站 / YouTube / 腾讯视频链接' }));
      return;
    }
    setVideoItem(item);
    setVideoUrl('');
    setVideoOpen(false);
  };

  const onSubmit = async () => {
    // 正文裸链视频抽取（用户直接把视频链接贴进正文时兜底）
    const { content: clean, videos } = extractVideoLinks(content);
    const urls = [...(videoItem ? [videoItem.url] : []), ...videos];
    if (urls.length > 1) {
      toastError(t('videoNotAllowed', { defaultValue: '仅支持 B 站 / YouTube / 腾讯视频链接' }));
      return;
    }
    const media: CommunityMediaItem[] = [];
    if (urls.length === 1) {
      const item = buildVideoItem(urls[0]);
      if (!item) {
        toastError(t('videoNotAllowed', { defaultValue: '仅支持 B 站 / YouTube / 腾讯视频链接' }));
        return;
      }
      media.push(item);
    }
    for (const img of images) {
      if (img.status === 'done' && img.url) {
        media.push({ type: 'image', url: img.url, thumb: img.thumb_url });
      }
    }
    if (clean.trim().length === 0 && media.length === 0) return;

    setSubmitting(true);
    // AI 起标题：无显式标题、正文也没写首行 MD 标题、且够长时，先让 AI 拟一个再发布
    let finalTitle = title.trim();
    if (!finalTitle) {
      const preview = mdPreview(clean);
      if (!preview.title && preview.body.length >= AI_TITLE_MIN_CHARS) {
        setTitling(true);
        finalTitle = (await aiGenerateTitle(preview.body.slice(0, 1500))) ?? '';
        setTitling(false);
      }
    }
    const ok = await useCommunityStore.getState().createPost({
      content: clean,
      media,
      visibility,
      title: finalTitle || undefined,
      cover_url: coverPath || undefined,
    });
    setSubmitting(false);
    if (ok) {
      reset();
      onClose();
    } else {
      toastError(useCommunityStore.getState().error ?? t('postFailed', { defaultValue: '发布失败' }));
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t('composeTitle', { defaultValue: '发布动态' })}
      size="medium"
    >
      {/* 博客模式：标题（可选）——博客卡与详情页衬线渲染 */}
      <input
        className="community-composer__title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={64}
        placeholder={t('titlePlaceholder', { defaultValue: '标题（可选，写个标题更像一篇博客）' })}
        aria-label={t('titleLabel', { defaultValue: '标题' })}
      />
      {titling && (
        <span className="community-composer__aititle" role="status">
          {t('aiTitling', { defaultValue: 'AI 正在为这篇长文起标题…' })}
        </span>
      )}
      <CommunityMDEditor
        value={content}
        onChange={setContent}
        disabled={submitting}
        onImagesPicked={(files) => void addImages(files)}
        onInsertVideo={() => setVideoOpen(true)}
      />

      {/* 封面槽位（有标题时出现；显式封面优先，否则取正文第一图） */}
      {title.trim().length > 0 && (
        <div className="community-composer__cover">
          {coverPreview ? (
            <img className="community-composer__cover-img" src={coverPreview} alt="" />
          ) : (
            <label className="community-composer__cover-pick">
              {coverBusy ? t('uploading', { defaultValue: '上传中…' }) : t('uploadCover', { defaultValue: '上传封面' })}
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => void pickCover(e.target.files?.[0])}
              />
            </label>
          )}
          {coverPath && (
            <button
              type="button"
              className="community-composer__cover-remove"
              aria-label={t('removeMedia', { defaultValue: '移除' })}
              onClick={() => {
                setCoverPath('');
                setCoverPreview('');
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {/* 图片九宫格预览（上传中/失败态可移除） */}
      {images.length > 0 && (
        <div className="community-composer__media">
          {images.map((img) => (
            <ComposerThumb
              key={img.key}
              item={img}
              onRemove={() => setImages((prev) => prev.filter((p) => p.key !== img.key))}
            />
          ))}
        </div>
      )}

      {/* 已插入视频（外链卡；正文裸链在发布时自动抽取，不在此展示） */}
      {videoItem && (
        <div className="community-composer__media">
          <div className="community-composer__thumb community-composer__thumb--video">
            <span>{videoItem.provider}</span>
            <button
              type="button"
              className="community-composer__remove"
              aria-label={t('removeMedia', { defaultValue: '移除' })}
              onClick={() => setVideoItem(null)}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* 插入视频输入层 */}
      <Modal
        isOpen={videoOpen}
        onClose={() => setVideoOpen(false)}
        title={t('videoAdd', { defaultValue: '添加视频' })}
        size="small"
      >
        <div className="community-composer__video-add">
          <Film size={16} aria-hidden />
          <Input
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder={t('videoPlaceholder', { defaultValue: 'B 站 / YouTube / 腾讯视频链接' })}
            inputSize="small"
            autoFocus
          />
        </div>
        <div className="community-composer__actions">
          <Button variant="ghost" onClick={() => setVideoOpen(false)}>
            {t('common:cancel', { defaultValue: '取消' })}
          </Button>
          <Button variant="primary" onClick={onAddVideo}>
            {t('videoAdd', { defaultValue: '添加视频' })}
          </Button>
        </div>
      </Modal>

      {/* 可见性三选（分段自绘） */}
      <div className="community-composer__visibility" role="radiogroup" aria-label={t('visibility', { defaultValue: '可见范围' })}>
        {(
          [
            ['public', t('visibilityPublic', { defaultValue: '公开' })],
            ['followers', t('visibilityFollowers', { defaultValue: '关注者' })],
            ['private', t('visibilityPrivate', { defaultValue: '仅自己' })],
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
          {t('common:cancel', { defaultValue: '取消' })}
        </Button>
        <Button variant="primary" isLoading={submitting} disabled={!canSubmit} onClick={() => void onSubmit()}>
          {t('publish', { defaultValue: '发布' })}
        </Button>
      </div>
    </Modal>
  );
};
