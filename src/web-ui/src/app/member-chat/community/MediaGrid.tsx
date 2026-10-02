/**
 * MediaGrid — 动态媒体展示（九宫格图片 + 外链视频嵌入卡 + 图片全屏预览）
 *
 * 图片：≤9 张九宫格（1 张大图 / 2-4 张两列 / 5+ 三列），object-fit cover；
 *       点击进 Lightbox 全屏预览（左右切换/ESC/计数，迁移 030）；
 * 视频：白名单域名（bilibili/youtube/qqvideo）URL → iframe embed 转换，
 *       转换失败回退为外链卡。媒体相对 URL 经 resolveMediaUrl 解析到服务器。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Film, X } from 'lucide-react';
import { resolveMediaUrl, type CommunityMediaItem } from './communityApi';

/** 白名单域名 → iframe embed URL（与后端 is_allowed_video_host 同集；null=不可嵌入） */
function videoEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'www.bilibili.com' || host === 'bilibili.com') {
      const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
      return m ? `https://player.bilibili.com/player.html?bvid=${m[1]}&autoplay=0` : null;
    }
    if (host === 'www.youtube.com' || host === 'youtube.com') {
      const v = u.searchParams.get('v');
      if (v) return `https://www.youtube.com/embed/${v}`;
      const m = u.pathname.match(/\/(?:shorts|embed)\/([0-9A-Za-z_-]+)/);
      return m ? `https://www.youtube.com/embed/${m[1]}` : null;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '');
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === 'v.qq.com') {
      const m = u.pathname.match(/\/([0-9A-Za-z]+)\.html$/);
      return m ? `https://v.qq.com/txp/iframe/player.html?vid=${m[1]}` : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 异步解析媒体 src（相对 → 绝对） */
function useMediaSrc(url: string): string {
  const [src, setSrc] = useState(url);
  useEffect(() => {
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

const MediaImage: React.FC<{
  item: CommunityMediaItem;
  className: string;
  /** 点击进全屏预览（迁移 030） */
  onOpen?: () => void;
}> = ({ item, className, onOpen }) => {
  // 服务端上传会生成 480px WebP 缩略图（thumb）；九宫格优先用缩略图，Lightbox 用原图
  const src = useMediaSrc(item.thumb || item.url);
  const Tag = onOpen ? 'button' : 'div';
  return (
    <Tag className={className} onClick={onOpen} type={onOpen ? 'button' : undefined}>
      <img src={src} alt="" loading="lazy" draggable={false} />
    </Tag>
  );
};

/** 全屏图片预览（迁移 030）：左右切换 + ESC/遮罩关闭 + 计数 */
const Lightbox: React.FC<{
  images: CommunityMediaItem[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}> = ({ images, index, onClose, onIndex }) => {
  const [src, setSrc] = useState('');
  const item = images[index];

  useEffect(() => {
    setSrc('');
    if (!item) return;
    let alive = true;
    void resolveMediaUrl(item.url)
      .then((u) => {
        if (alive) setSrc(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [item]);

  const prev = useCallback(
    () => onIndex((index - 1 + images.length) % images.length),
    [index, images.length, onIndex],
  );
  const next = useCallback(() => onIndex((index + 1) % images.length), [index, images.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && images.length > 1) prev();
      if (e.key === 'ArrowRight' && images.length > 1) next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, next, onClose, prev]);

  if (!item) return null;
  return (
    <div className="community-lightbox" onClick={onClose} role="dialog" aria-modal="true">
      {images.length > 1 && (
        <>
          <button
            type="button"
            className="community-lightbox__nav community-lightbox__nav--prev"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            aria-label="上一张"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            className="community-lightbox__nav community-lightbox__nav--next"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            aria-label="下一张"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}
      {src && <img className="community-lightbox__img" src={src} alt="" draggable={false} />}
      <div className="community-lightbox__meta">
        {index + 1} / {images.length}
      </div>
      <button
        type="button"
        className="community-lightbox__close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="关闭预览"
      >
        <X size={18} />
      </button>
    </div>
  );
};

export const MediaGrid: React.FC<{ media: CommunityMediaItem[] }> = ({ media }) => {
  const images = media.filter((m) => m.type === 'image').slice(0, 9);
  const videos = media.filter((m) => m.type === 'video').slice(0, 1);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  if (images.length === 0 && videos.length === 0) return null;

  // 九宫格列数：1 张单列大图；2-4 两列；5+ 三列
  const gridCls =
    images.length === 1
      ? 'community-media__grid--n1'
      : images.length <= 4
        ? 'community-media__grid--n2'
        : 'community-media__grid--n3';

  return (
    <div className="community-media">
      {images.length > 0 && (
        <div className={`community-media__grid ${gridCls}`}>
          {images.map((m, i) => (
            <MediaImage
              key={`${m.url}-${i}`}
              item={m}
              className="community-media__cell community-media__cell--clickable"
              onOpen={() => setLightboxIndex(i)}
            />
          ))}
        </div>
      )}
      {videos.map((m, i) => {
        const embed = videoEmbedUrl(m.url);
        return (
          <div key={`${m.url}-${i}`} className="community-media__video">
            {embed ? (
              <iframe
                className="community-media__video-frame"
                src={embed}
                title={m.title || 'video'}
                scrolling="no"
                frameBorder="0"
                allowFullScreen
                sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              />
            ) : (
              <a
                className="community-media__video-link"
                href={m.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Film size={16} aria-hidden />
                <span>{m.title || m.url}</span>
              </a>
            )}
          </div>
        );
      })}
      {lightboxIndex != null && (
        <Lightbox
          images={images}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndex={setLightboxIndex}
        />
      )}
    </div>
  );
};
